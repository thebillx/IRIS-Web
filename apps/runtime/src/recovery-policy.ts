import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { RuntimeError } from "@iris/domain";
import {
  inspectPrivateRegularFile,
  privateDirectoryProblem,
} from "./private-fs.js";
import { readOwnerAccessSecret } from "./persistence.js";
import { observeProcessStart } from "./macos-safety.js";

export type RecoveryPolicyOperation = "MIGRATION_APPROVAL" | "SOURCE_MIGRATION" | "SUPERVISOR_BOOTSTRAP" | "ADMIN_TUNNEL_START";
export type RecoveryPolicyState = "ISSUED" | "REVOKED" | "EXPIRED";
export type RecoveryPolicyOperationState =
  "RESERVED" | "COMMITTED" | "FAILED" | "RECONCILIATION_REQUIRED";

const POLICY_FILE = "com.iris.supervisor.recovery-policy.json";
const HASH40 = /^[a-f0-9]{40}$/;
const HASH64 = /^[a-f0-9]{64}$/;
const MAX_OPERATIONS = 16;
const MAX_ENTRIES = 32;
const MAX_RETIRED_POLICIES = 8;
const MAX_ARCHIVE_RECORDS = 256;
const POLICY_OPERATIONS: readonly RecoveryPolicyOperation[] = ["MIGRATION_APPROVAL", "SOURCE_MIGRATION", "SUPERVISOR_BOOTSTRAP", "ADMIN_TUNNEL_START"];
const HOST_BOUND_OPERATIONS: readonly RecoveryPolicyOperation[] = ["SUPERVISOR_BOOTSTRAP", "ADMIN_TUNNEL_START"];
const requiresHostBinding = (operation: RecoveryPolicyOperation): boolean => HOST_BOUND_OPERATIONS.includes(operation);

interface RecoveryPolicyLockRecord {
  readonly schemaVersion: 1;
  readonly lockId: string;
  readonly pid: number;
  readonly processStartMarker: string;
}

export interface RecoveryPolicyBinding {
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly executableSha256?: string | undefined;
  readonly executableArguments: readonly string[];
  readonly runtimePreflightSha256: string;
  readonly runtimeLoaderSha256: string;
}

export interface RecoveryPolicyIssueInput {
  readonly dataRoot: string;
  readonly sourceBindings: readonly RecoveryPolicyBinding[];
  readonly protectedReferenceRoot?: string | undefined;
  readonly machineId?: string | undefined;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
  readonly allowedOperations: readonly RecoveryPolicyOperation[];
  readonly maxOperationCount: number;
  readonly expiresAt: string;
  /** Explicit owner-authorized rollover of the exact terminal predecessor. */
  readonly supersedesPolicyId?: string | undefined;
}

export interface RecoveryPolicyArchiveInput {
  readonly dataRoot: string;
  readonly policyId: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly sourceRoot: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
}

export interface RecoveryPolicyOperationInput {
  readonly dataRoot: string;
  readonly policyId: string;
  readonly operation: RecoveryPolicyOperation;
  readonly requestId: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
  readonly protectedReferenceRoot?: string | undefined;
  readonly machineId?: string | undefined;
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly executableSha256?: string | undefined;
  readonly executableArguments: readonly string[];
  readonly runtimePreflightSha256: string;
  readonly runtimeLoaderSha256: string;
}

export interface RecoveryPolicyPublicRecord {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly state: RecoveryPolicyState;
  readonly dataRoot: string;
  readonly sourceBindings: readonly RecoveryPolicyBinding[];
  readonly protectedReferenceRoot: string | null;
  readonly machineId?: string | null;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
  readonly allowedOperations: readonly RecoveryPolicyOperation[];
  readonly maxOperationCount: number;
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly operations: readonly RecoveryPolicyOperationJournal[];
  readonly audit: readonly RecoveryPolicyAudit[];
  readonly supersedesPolicyId?: string | null;
  readonly retiredPolicies?: readonly RecoveryPolicyHistoricalRecord[];
  readonly retiredPoliciesArchive?: RecoveryPolicyArchiveReference;
}

export interface RecoveryPolicyArchiveReference {
  readonly schemaVersion: 1;
  readonly archiveId: string;
  readonly filename: string;
  readonly sha256: string;
  readonly predecessorPolicyId: string;
  readonly policyIds: readonly string[];
  readonly createdAt: string;
}

interface RecoveryPolicyArchiveRecord {
  readonly schemaVersion: 1;
  readonly archiveId: string;
  readonly predecessorPolicyId: string;
  readonly beforePolicySha256: string;
  readonly createdAt: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly sourceRoot: string;
  readonly protectedMetadataSha256: string;
  readonly protectedPlistSha256: string;
  readonly records: readonly RecoveryPolicyHistoricalRecord[];
  readonly signature: string;
}

const ARCHIVED_POLICIES = Symbol("archivedPolicies");
type SignedRecoveryPolicyWithArchive = SignedRecoveryPolicy & {
  readonly [ARCHIVED_POLICIES]?: readonly RecoveryPolicyHistoricalRecord[];
};

export interface RecoveryPolicyHistoricalRecord extends RecoveryPolicyPublicRecord {
  readonly signature: string;
}

export interface RecoveryPolicyOperationJournal {
  readonly transactionId: string;
  readonly requestId: string;
  readonly operation: RecoveryPolicyOperation;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly executableSha256?: string | null;
  readonly executableArguments: readonly string[];
  readonly runtimePreflightSha256: string;
  readonly runtimeLoaderSha256: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
  readonly protectedReferenceRoot: string | null;
  readonly machineId?: string | null;
  readonly state: RecoveryPolicyOperationState;
  readonly createdAt: string;
  readonly finalizedAt?: string;
}

export interface RecoveryPolicyAudit {
  readonly event: "ISSUED" | "RESERVED" | "FINALIZED" | "REVOKED";
  readonly operation?: RecoveryPolicyOperation;
  readonly requestId?: string;
  readonly transactionId?: string;
  readonly state?: RecoveryPolicyOperationState;
  readonly at: string;
}

interface SignedRecoveryPolicy extends RecoveryPolicyPublicRecord {
  readonly signature: string;
}

export function recoveryPolicyPath(dataRoot: string): string {
  return path.join(dataRoot, "launchd", POLICY_FILE);
}

export async function reconcileRecoveryPolicyLock(
  dataRootInput: string,
  lockId: string,
  pid: number,
  processStartMarker: string,
): Promise<void> {
  if (!isUuid(lockId) || !Number.isSafeInteger(pid) || pid <= 1 || !/^\d+:\d{6}$/.test(processStartMarker))
    throw new RuntimeError("INVALID_REQUEST", "Recovery policy lock identity is invalid");
  const dataRoot = await canonicalDataRoot(dataRootInput);
  const lock = `${recoveryPolicyPath(dataRoot)}.lock`;
  const releaseAdvisory = await acquirePolicyAdvisoryLock(`${lock}.flock`);
  try {
    const inspected = await inspectPrivateRegularFile(lock, "Recovery policy lock");
    if (inspected.state !== "ok")
      throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy lock requires reconciliation");
    let record: RecoveryPolicyLockRecord;
    try {
      const parsed = JSON.parse(inspected.content) as Partial<RecoveryPolicyLockRecord>;
      if (parsed.schemaVersion !== 1 || parsed.lockId !== lockId || parsed.pid !== pid || parsed.processStartMarker !== processStartMarker)
        throw new Error("lock identity mismatch");
      record = parsed as RecoveryPolicyLockRecord;
    } catch (error) {
      throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy lock identity is invalid", { cause: error });
    }
    const observed = observeProcessStart(record.pid);
    if (observed.state === "indeterminate" || observed.state === "live" && observed.marker === record.processStartMarker)
      throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy lock owner is still live or indeterminate");
    await removePolicyLock(lock, inspected.content);
  } finally {
    await releaseAdvisory();
  }
}

export async function issueRecoveryAuthorizationPolicy(input: RecoveryPolicyIssueInput): Promise<RecoveryPolicyPublicRecord> {
  return withPolicyLock(await canonicalDataRoot(input.dataRoot), () => issueRecoveryAuthorizationPolicyUnlocked(input));
}

async function issueRecoveryAuthorizationPolicyUnlocked(input: RecoveryPolicyIssueInput): Promise<RecoveryPolicyPublicRecord> {
  validateIssue(input);
  const dataRoot = await canonicalDataRoot(input.dataRoot);
  const secret = await ownerSecret(dataRoot);
  const filename = recoveryPolicyPath(dataRoot);
  const existing = await readSigned(filename, secret);
  const now = new Date().toISOString();
  if (existing !== null) {
    if (
      existing.state === "ISSUED" &&
      existing.expiresAt > now &&
      input.supersedesPolicyId === undefined &&
      sameIssue(existing, input, dataRoot)
    )
      return publicRecord(existing);
    if (
      input.supersedesPolicyId !== undefined &&
      allPolicyOperations(existing).some((entry) => entry.state === "RESERVED" || entry.state === "RECONCILIATION_REQUIRED")
    )
      throw new RuntimeError(
        "SUPERVISOR_NOT_RUNNING",
        "Recovery policy has unresolved operations",
      );
    if (existing.state === "ISSUED" && existing.expiresAt > now)
      throw new RuntimeError(
        "CONTROL_DENIED",
        "An active recovery authorization policy cannot be superseded and requires explicit reconciliation",
      );
    if (
      input.supersedesPolicyId === undefined ||
      input.supersedesPolicyId !== existing.policyId
    )
      throw new RuntimeError(
        "CONTROL_DENIED",
        "A recovery authorization policy already exists and requires explicit reconciliation",
      );
    if (existing.state !== "REVOKED" && existing.state !== "EXPIRED")
      throw new RuntimeError(
        "CONTROL_DENIED",
        "Only a revoked or expired recovery policy may be superseded",
      );
    if (allPolicyOperations(existing).some((entry) => entry.state === "RESERVED" || entry.state === "RECONCILIATION_REQUIRED"))
      throw new RuntimeError(
        "SUPERVISOR_NOT_RUNNING",
        "Recovery policy has unresolved operations",
      );
    if ((existing.retiredPolicies?.length ?? 0) >= MAX_RETIRED_POLICIES && existing.retiredPoliciesArchive === undefined)
      throw new RuntimeError(
        "PERSISTENCE_FAILURE",
        "Recovery policy retirement history is full",
      );
  } else if (input.supersedesPolicyId !== undefined) {
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy predecessor does not exist",
    );
  }
  const record: RecoveryPolicyPublicRecord = {
    schemaVersion: 1,
    policyId: randomUUID(),
    state: "ISSUED",
    dataRoot,
    sourceBindings: input.sourceBindings.map((binding) => ({ ...binding })),
    protectedReferenceRoot: input.protectedReferenceRoot ?? null,
    ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
    beforeMetadataSha256: input.beforeMetadataSha256,
    beforePlistSha256: input.beforePlistSha256,
    allowedOperations: [...new Set(input.allowedOperations)],
    maxOperationCount: input.maxOperationCount,
    expiresAt: input.expiresAt,
    issuedAt: now,
    operations: [],
    audit: [{ event: "ISSUED", at: now }],
    ...(input.supersedesPolicyId === undefined ? {} : { supersedesPolicyId: input.supersedesPolicyId }),
    ...(existing === null ? {} : existing.retiredPoliciesArchive !== undefined ? {
      retiredPolicies: [existing],
      retiredPoliciesArchive: existing.retiredPoliciesArchive,
    } : {
      retiredPolicies: [
        ...(existing.retiredPolicies ?? []),
        existing,
      ],
    }),
  };
  const signed = sign(record, secret);
  await writeSigned(filename, signed);
  return publicRecord(signed);
}

export async function readRecoveryAuthorizationPolicy(
  dataRoot: string,
): Promise<RecoveryPolicyPublicRecord | null> {
  const canonical = await canonicalDataRoot(dataRoot);
  const secret = await ownerSecret(canonical);
  const record = await readSigned(recoveryPolicyPath(canonical), secret);
  return record === null ? null : publicRecord(record);
}

/** Archives terminal policy history without requiring Supervisor bootstrap. */
export async function archiveRecoveryPolicyHistory(input: RecoveryPolicyArchiveInput): Promise<RecoveryPolicyPublicRecord> {
  return withPolicyLock(await canonicalDataRoot(input.dataRoot), () => archiveRecoveryPolicyHistoryUnlocked(input));
}

async function archiveRecoveryPolicyHistoryUnlocked(input: RecoveryPolicyArchiveInput): Promise<RecoveryPolicyPublicRecord> {
  if (!isUuid(input.policyId) || !HASH40.test(input.sourceSha) || !HASH40.test(input.sourceTree) || !HASH64.test(input.beforeMetadataSha256) || !HASH64.test(input.beforePlistSha256) || input.sourceRoot.length === 0) {
    throw new RuntimeError("INVALID_REQUEST", "Recovery policy archive identity is invalid");
  }
  const dataRoot = await canonicalDataRoot(input.dataRoot);
  const secret = await ownerSecret(dataRoot);
  const filename = recoveryPolicyPath(dataRoot);
  const current = await requirePolicy(filename, secret);
  if (current.policyId !== input.policyId) throw new RuntimeError("CONTROL_DENIED", "Recovery policy identity does not match");
  if (current.state !== "REVOKED" && current.state !== "EXPIRED") throw new RuntimeError("CONTROL_DENIED", "Only a terminal recovery policy may be archived");
  const canonicalSourceRoot = await realpath(input.sourceRoot).catch(() => { throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy source root is unavailable"); });
  if (canonicalSourceRoot !== input.sourceRoot) throw new RuntimeError("PERSISTENCE_FAILURE", "Recovery policy source root is not canonical");
  const sourceIdentity = await gitIdentity(canonicalSourceRoot);
  if (sourceIdentity.sourceSha !== input.sourceSha || sourceIdentity.sourceTree !== input.sourceTree || sourceIdentity.dirty) throw new RuntimeError("CONTROL_DENIED", "Recovery policy source identity is not the exact clean checkout");
  const metadataContent = await readPrivateContent(path.join(dataRoot, "launchd", "com.iris.supervisor.plist.metadata.json"), "IRIS LaunchAgent metadata");
  const plistContent = await readPrivateContent(path.join(dataRoot, "launchd", "com.iris.supervisor.plist"), "IRIS private LaunchAgent");
  if (sha256(metadataContent) !== input.beforeMetadataSha256 || sha256(plistContent) !== input.beforePlistSha256) throw new RuntimeError("CONTROL_DENIED", "Protected LaunchAgent before-image does not match");
  let metadata: unknown;
  try { metadata = JSON.parse(metadataContent); } catch (error) { throw new RuntimeError("PERSISTENCE_FAILURE", "IRIS LaunchAgent metadata is invalid JSON", { cause: error }); }
  if (typeof metadata !== "object" || metadata === null || (metadata as { sourceRoot?: unknown }).sourceRoot !== canonicalSourceRoot || (metadata as { schemaVersion?: unknown }).schemaVersion !== 3) throw new RuntimeError("CONTROL_DENIED", "Protected LaunchAgent source binding does not match");
  if (allPolicyOperations(current).some((entry) => entry.state === "RESERVED" || entry.state === "RECONCILIATION_REQUIRED")) throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy has unresolved operations");
  if (current.retiredPoliciesArchive !== undefined) {
    await readPolicyArchive(dataRoot, current.retiredPoliciesArchive, secret);
    if ((current.retiredPolicies?.length ?? 0) === 0) return publicRecord(current);
  }
  const archiveRecords = uniquePolicies([...(current as SignedRecoveryPolicyWithArchive)[ARCHIVED_POLICIES] ?? [], current, ...(current.retiredPolicies ?? [])]);
  const beforePolicySha256 = sha256(await readPrivateContent(filename, "Recovery authorization policy"));
  const existingArchive = await findMatchingArchive(dataRoot, current.policyId, beforePolicySha256, secret);
  const archive = existingArchive ?? await createPolicyArchive(dataRoot, current, archiveRecords, beforePolicySha256, secret, input);
  const next: RecoveryPolicyPublicRecord = {
    ...current,
    retiredPolicies: [],
    retiredPoliciesArchive: archive.reference,
  };
  await writeSigned(filename, sign(next, secret));
  const readback = await requirePolicy(filename, secret);
  if (readback.retiredPoliciesArchive?.sha256 !== archive.reference.sha256) throw new RuntimeError("PERSISTENCE_FAILURE", "Recovery policy archive publication did not read back");
  return publicRecord(readback);
}

export async function reserveRecoveryPolicyOperation(input: RecoveryPolicyOperationInput): Promise<{ readonly transactionId: string; readonly state: "RESERVED" }> {
  return withPolicyLock(await canonicalDataRoot(input.dataRoot), () => reserveRecoveryPolicyOperationUnlocked(input));
}

async function reserveRecoveryPolicyOperationUnlocked(input: RecoveryPolicyOperationInput): Promise<{ readonly transactionId: string; readonly state: "RESERVED" }> {
  validateOperation(input);
  const dataRoot = await canonicalDataRoot(input.dataRoot);
  const secret = await ownerSecret(dataRoot);
  const filename = recoveryPolicyPath(dataRoot);
  const current = await requirePolicy(filename, secret);
  if (current.policyId !== input.policyId)
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy identity does not match",
    );
  const now = new Date();
  if (
    current.state !== "ISSUED" ||
    new Date(current.expiresAt).getTime() <= now.getTime()
  )
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery authorization policy is expired or revoked",
    );
  if (
    current.dataRoot !== dataRoot ||
    current.protectedReferenceRoot !== (input.protectedReferenceRoot ?? null)
  )
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy protected binding does not match",
    );
  if (!current.allowedOperations.includes(input.operation))
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy does not authorize this operation",
    );
  if (
    requiresHostBinding(input.operation) &&
    (current.machineId === undefined || current.machineId === null || current.machineId !== input.machineId)
  )
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy machine identity does not match",
    );
  if (
    !current.sourceBindings.some(
      (binding) =>
        binding.sourceSha === input.sourceSha &&
        binding.sourceTree === input.sourceTree &&
        binding.sourceRoot === input.sourceRoot &&
        binding.controlScript === input.controlScript &&
        binding.executable === input.executable &&
        (!requiresHostBinding(input.operation) || binding.executableSha256 === input.executableSha256) &&
        JSON.stringify(binding.executableArguments) === JSON.stringify(input.executableArguments) &&
        binding.runtimePreflightSha256 === input.runtimePreflightSha256 &&
        binding.runtimeLoaderSha256 === input.runtimeLoaderSha256,
    )
  )
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy source binding does not match",
    );
  if (
    current.beforeMetadataSha256 !== input.beforeMetadataSha256 ||
    current.beforePlistSha256 !== input.beforePlistSha256
  )
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy before-image does not match",
    );
  const existing = current.operations.find(
    (entry) =>
      entry.requestId === input.requestId && entry.operation === input.operation,
  );
  if (existing !== undefined) {
    if (
      existing.operation !== input.operation ||
      existing.sourceSha !== input.sourceSha ||
      existing.sourceTree !== input.sourceTree ||
      existing.sourceRoot !== input.sourceRoot ||
      existing.controlScript !== input.controlScript ||
      existing.executable !== input.executable ||
      (existing.executableSha256 ?? null) !== (input.executableSha256 ?? null) ||
      JSON.stringify(existing.executableArguments) !== JSON.stringify(input.executableArguments) ||
      existing.runtimePreflightSha256 !== input.runtimePreflightSha256 ||
      existing.runtimeLoaderSha256 !== input.runtimeLoaderSha256 ||
      existing.beforeMetadataSha256 !== input.beforeMetadataSha256 ||
      existing.beforePlistSha256 !== input.beforePlistSha256 ||
      existing.protectedReferenceRoot !== (input.protectedReferenceRoot ?? null) ||
      (existing.machineId ?? null) !== (input.machineId ?? null)
    )
      throw new RuntimeError(
        "CONTROL_DENIED",
        "Recovery request identity conflicts with the policy journal",
      );
    if (existing.state !== "RESERVED")
      throw new RuntimeError(
        "SUPERVISOR_NOT_RUNNING",
        "Recovery request already reached a terminal state",
      );
    return { transactionId: existing.transactionId, state: "RESERVED" };
  }
  if (retiredPolicyOperations(current).some((entry) => entry.requestId === input.requestId))
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery request identity is already present in retired policy history",
    );
  if (
    allPolicyOperations(current).some(
      (entry) =>
        entry.state === "RECONCILIATION_REQUIRED" || entry.state === "RESERVED",
    )
  )
    throw new RuntimeError(
      "SUPERVISOR_NOT_RUNNING",
      "Recovery policy has an unresolved operation",
    );
  const count = current.operations.filter(
    (entry) => entry.state === "COMMITTED",
  ).length;
  if (count >= current.maxOperationCount)
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy operation limit has been reached",
    );
  if (current.operations.length >= MAX_ENTRIES)
    throw new RuntimeError(
      "PERSISTENCE_FAILURE",
      "Recovery policy journal is full",
    );
  const transactionId = randomUUID();
  const reserved: RecoveryPolicyOperationJournal = {
    transactionId,
    requestId: input.requestId,
    operation: input.operation,
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    sourceRoot: input.sourceRoot,
    controlScript: input.controlScript,
    executable: input.executable,
    ...(input.executableSha256 === undefined ? {} : { executableSha256: input.executableSha256 }),
    executableArguments: [...input.executableArguments],
    runtimePreflightSha256: input.runtimePreflightSha256,
    runtimeLoaderSha256: input.runtimeLoaderSha256,
    beforeMetadataSha256: input.beforeMetadataSha256,
    beforePlistSha256: input.beforePlistSha256,
    protectedReferenceRoot: input.protectedReferenceRoot ?? null,
    ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
    state: "RESERVED",
    createdAt: now.toISOString(),
  };
  const next: RecoveryPolicyPublicRecord = {
    ...current,
    operations: [...current.operations, reserved],
    audit: [
      ...current.audit,
      {
        event: "RESERVED",
        operation: input.operation,
        requestId: input.requestId,
        transactionId,
        at: now.toISOString(),
      },
    ],
  };
  await writeSigned(filename, sign(next, secret));
  return { transactionId, state: "RESERVED" };
}

export async function finalizeRecoveryPolicyOperation(input: RecoveryPolicyOperationInput & { readonly transactionId: string; readonly state: Exclude<RecoveryPolicyOperationState, "RESERVED"> }): Promise<RecoveryPolicyPublicRecord> {
  return withPolicyLock(await canonicalDataRoot(input.dataRoot), () => finalizeRecoveryPolicyOperationUnlocked(input));
}

export async function reconcileRecoveryPolicyOperation(input: RecoveryPolicyOperationInput & { readonly transactionId: string }): Promise<RecoveryPolicyPublicRecord> {
  return finalizeRecoveryPolicyOperation({ ...input, state: "RECONCILIATION_REQUIRED" });
}

/** Terminally records a verified failed ADMIN tunnel start without implying success. */
export async function resolveFailedAdminTunnelStart(input: RecoveryPolicyOperationInput & { readonly transactionId: string }): Promise<RecoveryPolicyPublicRecord> {
  if (input.operation !== "ADMIN_TUNNEL_START")
    throw new RuntimeError("INVALID_REQUEST", "Only an ADMIN_TUNNEL_START may be resolved as failed");
  return finalizeRecoveryPolicyOperation({ ...input, state: "FAILED" });
}

export async function assertRecoveryPolicyOperationCommitted(input: RecoveryPolicyOperationInput & { readonly transactionId: string }): Promise<void> {
  validateOperation(input);
  if (!isUuid(input.transactionId)) throw new RuntimeError("INVALID_REQUEST", "Recovery transaction ID is invalid");
  const dataRoot = await canonicalDataRoot(input.dataRoot);
  const current = await requirePolicy(recoveryPolicyPath(dataRoot), await ownerSecret(dataRoot));
  if (current.policyId !== input.policyId)
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy identity does not match",
    );
  const entry = current.operations.find((candidate) => candidate.transactionId === input.transactionId && candidate.requestId === input.requestId && candidate.operation === input.operation);
  if (entry === undefined || entry.state !== "COMMITTED" || entry.sourceSha !== input.sourceSha || entry.sourceTree !== input.sourceTree || entry.sourceRoot !== input.sourceRoot || entry.controlScript !== input.controlScript || entry.executable !== input.executable || (entry.executableSha256 ?? null) !== (input.executableSha256 ?? null) || JSON.stringify(entry.executableArguments) !== JSON.stringify(input.executableArguments) || entry.runtimePreflightSha256 !== input.runtimePreflightSha256 || entry.runtimeLoaderSha256 !== input.runtimeLoaderSha256 || entry.beforeMetadataSha256 !== input.beforeMetadataSha256 || entry.beforePlistSha256 !== input.beforePlistSha256 || entry.protectedReferenceRoot !== (input.protectedReferenceRoot ?? null) || (entry.machineId ?? null) !== (input.machineId ?? null)) throw new RuntimeError("CONTROL_DENIED", "Recovery policy operation is not durably committed");
}

async function finalizeRecoveryPolicyOperationUnlocked(input: RecoveryPolicyOperationInput & { readonly transactionId: string; readonly state: Exclude<RecoveryPolicyOperationState, "RESERVED"> }): Promise<RecoveryPolicyPublicRecord> {
  validateOperation(input);
  if (!isUuid(input.transactionId))
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Recovery transaction ID is invalid",
    );
  const dataRoot = await canonicalDataRoot(input.dataRoot);
  const secret = await ownerSecret(dataRoot);
  const filename = recoveryPolicyPath(dataRoot);
  const current = await requirePolicy(filename, secret);
  if (current.policyId !== input.policyId)
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy identity does not match",
    );
  const index = current.operations.findIndex(
    (entry) =>
      entry.transactionId === input.transactionId &&
      entry.requestId === input.requestId &&
      entry.operation === input.operation,
  );
  if (index < 0)
    throw new RuntimeError(
      "SUPERVISOR_NOT_RUNNING",
      "Recovery transaction is not present in the policy journal",
    );
  const existing = current.operations[index]!;
  if (
    existing.sourceSha !== input.sourceSha ||
    existing.sourceTree !== input.sourceTree ||
    existing.sourceRoot !== input.sourceRoot ||
    existing.controlScript !== input.controlScript ||
    existing.executable !== input.executable ||
    (existing.executableSha256 ?? null) !== (input.executableSha256 ?? null) ||
    JSON.stringify(existing.executableArguments) !== JSON.stringify(input.executableArguments) ||
    existing.runtimePreflightSha256 !== input.runtimePreflightSha256 ||
    existing.runtimeLoaderSha256 !== input.runtimeLoaderSha256 ||
    existing.beforeMetadataSha256 !== input.beforeMetadataSha256 ||
    existing.beforePlistSha256 !== input.beforePlistSha256 ||
    existing.protectedReferenceRoot !== (input.protectedReferenceRoot ?? null) ||
    (existing.machineId ?? null) !== (input.machineId ?? null)
  )
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery transaction source binding changed",
    );
  if (input.state === "FAILED" && (existing.state !== "RECONCILIATION_REQUIRED" || existing.operation !== "ADMIN_TUNNEL_START"))
    throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Only a reconciliation-required ADMIN tunnel start may be resolved as failed");
  const resolvingFailedAdminTunnel = input.state === "FAILED" && existing.state === "RECONCILIATION_REQUIRED" && existing.operation === "ADMIN_TUNNEL_START";
  if (existing.state !== "RESERVED" && !resolvingFailedAdminTunnel) {
    if (existing.state === input.state) return current;
    throw new RuntimeError(
      "SUPERVISOR_NOT_RUNNING",
      "Recovery transaction has already been finalized",
    );
  }
  const finalizedAt = new Date().toISOString();
  const operations = current.operations.slice();
  operations[index] = { ...existing, state: input.state, finalizedAt };
  const next: RecoveryPolicyPublicRecord = {
    ...current,
    operations,
    audit: [
      ...current.audit,
      {
        event: "FINALIZED",
        operation: input.operation,
        requestId: input.requestId,
        transactionId: input.transactionId,
        state: input.state,
        at: finalizedAt,
      },
    ],
  };
  await writeSigned(filename, sign(next, secret));
  return next;
}

export async function revokeRecoveryAuthorizationPolicy(dataRootInput: string): Promise<RecoveryPolicyPublicRecord> {
  return withPolicyLock(await canonicalDataRoot(dataRootInput), () => revokeRecoveryAuthorizationPolicyUnlocked(dataRootInput));
}

async function revokeRecoveryAuthorizationPolicyUnlocked(dataRootInput: string): Promise<RecoveryPolicyPublicRecord> {
  const dataRoot = await canonicalDataRoot(dataRootInput);
  const secret = await ownerSecret(dataRoot);
  const filename = recoveryPolicyPath(dataRoot);
  const current = await requirePolicy(filename, secret);
  if (
    allPolicyOperations(current).some(
      (entry) =>
        entry.state === "RESERVED" || entry.state === "RECONCILIATION_REQUIRED",
    )
  )
    throw new RuntimeError(
      "SUPERVISOR_NOT_RUNNING",
      "Recovery policy has unresolved operations",
    );
  if (current.state === "REVOKED") return current;
  const now = new Date().toISOString();
  const next: RecoveryPolicyPublicRecord = {
    ...current,
    state: "REVOKED",
    audit: [...current.audit, { event: "REVOKED", at: now }],
  };
  await writeSigned(filename, sign(next, secret));
  return next;
}

async function withPolicyLock<T>(dataRoot: string, operation: () => Promise<T>): Promise<T> {
  const lock = `${recoveryPolicyPath(dataRoot)}.lock`;
  const releaseAdvisory = await acquirePolicyAdvisoryLock(`${lock}.flock`);
  const processStart = observeProcessStart(process.pid);
  if (processStart.state !== "live") {
    await releaseAdvisory();
    throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy lock owner identity is unavailable");
  }
  const lockContent = `${JSON.stringify({
    schemaVersion: 1,
    lockId: randomUUID(),
    pid: process.pid,
    processStartMarker: processStart.marker,
  } satisfies RecoveryPolicyLockRecord)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let lockOwned = false;
  let result!: T;
  let operationError: unknown;
  try {
    handle = await open(lock, "wx", 0o600);
    await handle.writeFile(lockContent, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    lockOwned = true;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await releaseAdvisory().catch(() => undefined);
    throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy operation is already active", { cause: error });
  }
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  if (lockOwned) {
    try { await removePolicyLock(lock, lockContent); }
    catch (error) { cleanupError = error; }
  }
  try { await releaseAdvisory(); }
  catch (error) { cleanupError ??= error; }
  if (cleanupError !== undefined)
    throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy lock cleanup requires reconciliation", { cause: cleanupError });
  if (operationError !== undefined) throw operationError;
  return result;
}

async function acquirePolicyAdvisoryLock(filename: string): Promise<() => Promise<void>> {
  const script = [
    "import errno, fcntl, os, select, stat, sys",
    "if not hasattr(os, 'O_NOFOLLOW'): raise RuntimeError('O_NOFOLLOW is unavailable')",
    "flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW",
    "fd = os.open(sys.argv[1], flags, 0o600)",
    "metadata = os.fstat(fd)",
    "if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:\n    raise RuntimeError('unsafe advisory lock anchor')",
    "parent = int(sys.argv[2])",
    "while True:",
    "    if os.getppid() != parent: sys.exit(75)",
    "    try:",
    "        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "        break",
    "    except BlockingIOError as error:",
    "        if error.errno != errno.EWOULDBLOCK: raise",
    "        ready, _, _ = select.select([sys.stdin], [], [], 0.25)",
    "        if ready and sys.stdin.readline() == '': sys.exit(75)",
    "sys.stdout.write('READY\\n'); sys.stdout.flush()",
    "while os.getppid() == parent:",
    "    ready, _, _ = select.select([sys.stdin], [], [], 0.25)",
    "    if ready and sys.stdin.readline() == '': break",
  ].join("\n");
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-c", script, filename, String(process.pid)], { stdio: ["pipe", "pipe", "ignore"] });
  let output = "";
  let timeout: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer | string) => {
        output += String(chunk);
        if (output.includes("READY\n")) resolve();
      };
      child.stdout?.on("data", onData);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`advisory lock helper exited with ${code ?? "unknown"}`)));
      timeout = setTimeout(() => reject(new Error("advisory lock acquisition timed out")), 2_000);
    });
  } catch (error) {
    clearTimeout(timeout);
    child.kill("SIGTERM");
    throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy operation is already active", { cause: error });
  }
  clearTimeout(timeout);
  const release = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (child.exitCode !== 0 || child.signalCode !== null)
        throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy advisory lock release requires reconciliation");
      return;
    }
    const exit = once(child, "exit").then(([code, signal]) => {
      if (code !== 0 || signal !== null)
        throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy advisory lock release requires reconciliation");
    });
    const bounded = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy advisory lock release requires reconciliation")), 2_000).unref();
    });
    try {
      child.stdin?.end();
      await Promise.race([exit, bounded]);
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  };
  return release;
}

async function removePolicyLock(filename: string, expectedContent: string): Promise<void> {
  const inspected = await inspectPrivateRegularFile(filename, "Recovery policy lock");
  if (inspected.state !== "ok" || inspected.content !== expectedContent)
    throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy lock cleanup requires reconciliation");
  await rm(filename);
  const directoryHandle = await open(path.dirname(filename), "r");
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  const readback = await inspectPrivateRegularFile(filename, "Recovery policy lock");
  if (readback.state !== "missing") throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy lock cleanup requires reconciliation");
}

async function canonicalDataRoot(input: string): Promise<string> {
  const canonical = await realpath(input).catch(() => {
    throw new RuntimeError(
      "PERSISTENCE_FAILURE",
      "Recovery policy data root is unavailable",
    );
  });
  const problem = await privateDirectoryProblem(canonical, "IRIS data root");
  if (problem !== null) throw new RuntimeError("PERSISTENCE_FAILURE", problem);
  return canonical;
}

async function ownerSecret(dataRoot: string): Promise<string> {
  const secret = await readOwnerAccessSecret(dataRoot);
  if (secret === null)
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Owner access approval is not initialized",
    );
  return secret;
}

async function readPrivateContent(filename: string, label: string): Promise<string> {
  const inspected = await inspectPrivateRegularFile(filename, label);
  if (inspected.state !== "ok") throw new RuntimeError("PERSISTENCE_FAILURE", inspected.state === "invalid" ? inspected.reason : `${label} is missing`);
  return inspected.content;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function gitIdentity(sourceRoot: string): Promise<{ readonly sourceSha: string; readonly sourceTree: string; readonly dirty: boolean }> {
  const run = (args: readonly string[]) => new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error("git identity unavailable")));
  });
  try {
    const [sourceSha, sourceTree, status] = await Promise.all([
      run(["-C", sourceRoot, "rev-parse", "HEAD"]),
      run(["-C", sourceRoot, "rev-parse", "HEAD^{tree}"]),
      run(["-C", sourceRoot, "status", "--porcelain", "--untracked-files=all"]),
    ]);
    return { sourceSha, sourceTree, dirty: status.length > 0 };
  } catch (error) {
    throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Recovery policy source identity is unavailable", { cause: error });
  }
}

function uniquePolicies(records: readonly RecoveryPolicyHistoricalRecord[]): RecoveryPolicyHistoricalRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => !seen.has(record.policyId) && (seen.add(record.policyId), true));
}

function archiveFilename(archiveId: string): string {
  return `com.iris.supervisor.recovery-policy.archive.${archiveId}.json`;
}

function archivePayload(record: Omit<RecoveryPolicyArchiveRecord, "signature">): string {
  return JSON.stringify(record);
}

function signArchive(record: Omit<RecoveryPolicyArchiveRecord, "signature">, secret: string): RecoveryPolicyArchiveRecord {
  return { ...record, signature: createHmac("sha256", secret).update(archivePayload(record)).digest("hex") };
}

function archiveReference(record: RecoveryPolicyArchiveRecord, content: string): RecoveryPolicyArchiveReference {
  return {
    schemaVersion: 1,
    archiveId: record.archiveId,
    filename: archiveFilename(record.archiveId),
    sha256: sha256(content),
    predecessorPolicyId: record.predecessorPolicyId,
    policyIds: record.records.map((entry) => entry.policyId),
    createdAt: record.createdAt,
  };
}

async function writeArchive(filename: string, record: RecoveryPolicyArchiveRecord): Promise<string> {
  const content = `${JSON.stringify(record, null, 2)}\n`;
  const directory = path.dirname(filename);
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    const readback = await readPrivateContent(filename, "Recovery policy archive");
    if (readback !== content) throw new RuntimeError("PERSISTENCE_FAILURE", "Recovery policy archive readback did not match");
    return content;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new RuntimeError("PERSISTENCE_FAILURE", "Recovery policy archive publication failed", { cause: error });
  }
}

async function createPolicyArchive(dataRoot: string, predecessor: SignedRecoveryPolicy, records: readonly RecoveryPolicyHistoricalRecord[], beforePolicySha256: string, secret: string, input: RecoveryPolicyArchiveInput): Promise<{ readonly record: RecoveryPolicyArchiveRecord; readonly reference: RecoveryPolicyArchiveReference }> {
  const archiveId = randomUUID();
  const record = signArchive({ schemaVersion: 1, archiveId, predecessorPolicyId: predecessor.policyId, beforePolicySha256, createdAt: new Date().toISOString(), sourceSha: input.sourceSha, sourceTree: input.sourceTree, sourceRoot: input.sourceRoot, protectedMetadataSha256: input.beforeMetadataSha256, protectedPlistSha256: input.beforePlistSha256, records }, secret);
  const content = await writeArchive(path.join(dataRoot, "launchd", archiveFilename(archiveId)), record);
  return { record, reference: archiveReference(record, content) };
}

async function findMatchingArchive(dataRoot: string, predecessorPolicyId: string, beforePolicySha256: string, secret: string): Promise<{ readonly record: RecoveryPolicyArchiveRecord; readonly reference: RecoveryPolicyArchiveReference } | null> {
  const directory = path.join(dataRoot, "launchd");
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names.filter((candidate) => candidate.startsWith("com.iris.supervisor.recovery-policy.archive.") && candidate.endsWith(".json"))) {
    const content = await readPrivateContent(path.join(directory, name), "Recovery policy archive").catch(() => null);
    if (content === null) continue;
    try {
      const parsed = JSON.parse(content) as RecoveryPolicyArchiveRecord;
      if (parsed.schemaVersion === 1 && parsed.predecessorPolicyId === predecessorPolicyId && parsed.beforePolicySha256 === beforePolicySha256) {
        const archive = await readPolicyArchive(dataRoot, archiveReference(parsed, content), secret);
        return { record: archive.record, reference: archive.reference };
      }
    } catch { /* malformed candidates are ignored; the authoritative policy reference still fails closed */ }
  }
  return null;
}

async function readPolicyArchive(dataRoot: string, reference: RecoveryPolicyArchiveReference, secret: string): Promise<{ readonly record: RecoveryPolicyArchiveRecord; readonly reference: RecoveryPolicyArchiveReference }> {
  if (reference.schemaVersion !== 1 || !isUuid(reference.archiveId) || reference.filename !== archiveFilename(reference.archiveId) || !HASH64.test(reference.sha256)) throw new RuntimeError("PERSISTENCE_FAILURE", "Recovery policy archive reference is malformed");
  const content = await readPrivateContent(path.join(dataRoot, "launchd", reference.filename), "Recovery policy archive");
  if (sha256(content) !== reference.sha256) throw new RuntimeError("CONTROL_DENIED", "Recovery policy archive integrity failed");
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch (error) { throw new RuntimeError("PERSISTENCE_FAILURE", "Recovery policy archive is invalid JSON", { cause: error }); }
  if (typeof parsed !== "object" || parsed === null) throw new RuntimeError("PERSISTENCE_FAILURE", "Recovery policy archive is malformed");
  const archive = parsed as RecoveryPolicyArchiveRecord;
  if (archive.schemaVersion !== 1 || archive.archiveId !== reference.archiveId || archive.predecessorPolicyId !== reference.predecessorPolicyId || !HASH64.test(archive.beforePolicySha256) || !HASH40.test(archive.sourceSha) || !HASH40.test(archive.sourceTree) || archive.sourceRoot.length === 0 || !HASH64.test(archive.protectedMetadataSha256) || !HASH64.test(archive.protectedPlistSha256) || !Array.isArray(archive.records) || archive.records.length === 0 || archive.records[0]?.policyId !== reference.predecessorPolicyId || archive.records.length > MAX_ARCHIVE_RECORDS || archive.records.some((record) => !isSignedPolicy(record))) throw new RuntimeError("PERSISTENCE_FAILURE", "Recovery policy archive is malformed");
  const unsigned = { schemaVersion: archive.schemaVersion, archiveId: archive.archiveId, predecessorPolicyId: archive.predecessorPolicyId, beforePolicySha256: archive.beforePolicySha256, createdAt: archive.createdAt, sourceSha: archive.sourceSha, sourceTree: archive.sourceTree, sourceRoot: archive.sourceRoot, protectedMetadataSha256: archive.protectedMetadataSha256, protectedPlistSha256: archive.protectedPlistSha256, records: archive.records };
  const expected = createHmac("sha256", secret).update(archivePayload(unsigned)).digest("hex");
  const actual = Buffer.from(archive.signature, "hex");
  const candidate = Buffer.from(expected, "hex");
  if (actual.length !== candidate.length || !timingSafeEqual(actual, candidate)) throw new RuntimeError("CONTROL_DENIED", "Recovery policy archive authentication failed");
  for (const record of archive.records) verifyPolicySignature(record, secret);
  if (JSON.stringify(reference.policyIds) !== JSON.stringify(archive.records.map((record) => record.policyId))) throw new RuntimeError("CONTROL_DENIED", "Recovery policy archive reference does not match its records");
  return { record: archive, reference };
}

async function readSigned(
  filename: string,
  secret: string,
): Promise<SignedRecoveryPolicy | null> {
  const inspected = await inspectPrivateRegularFile(
    filename,
    "Recovery authorization policy",
  );
  if (inspected.state === "missing") return null;
  if (inspected.state === "invalid")
    throw new RuntimeError("PERSISTENCE_FAILURE", inspected.reason);
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspected.content);
  } catch (error) {
    throw new RuntimeError(
      "PERSISTENCE_FAILURE",
      "Recovery authorization policy is invalid JSON",
      { cause: error },
    );
  }
  if (!isSignedPolicy(parsed))
    throw new RuntimeError(
      "PERSISTENCE_FAILURE",
      "Recovery authorization policy is malformed",
    );
  const actualSignature = Buffer.from(parsed.signature, "hex");
  const expectedSignature = Buffer.from(signPayload(parsed, secret), "hex");
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  )
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery authorization policy authentication failed",
    );
  verifyRetiredPolicySignatures(parsed, secret);
  if (parsed.retiredPoliciesArchive !== undefined) {
    const archive = await readPolicyArchive(path.dirname(path.dirname(filename)), parsed.retiredPoliciesArchive, secret);
    Object.defineProperty(parsed, ARCHIVED_POLICIES, { value: archive.record.records, enumerable: false });
  }
  if (parsed.expiresAt <= new Date().toISOString() && parsed.state === "ISSUED")
    return { ...parsed, state: "EXPIRED" };
  return parsed;
}

async function requirePolicy(
  filename: string,
  secret: string,
): Promise<SignedRecoveryPolicy> {
  const record = await readSigned(filename, secret);
  if (record === null)
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery authorization policy is not enrolled",
    );
  return record;
}

async function writeSigned(
  filename: string,
  record: SignedRecoveryPolicy,
): Promise<void> {
  const directory = path.dirname(filename);
  const problem = await privateDirectoryProblem(
    directory,
    "IRIS launchd directory",
  );
  if (problem !== null) throw new RuntimeError("PERSISTENCE_FAILURE", problem);
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    const readback = await inspectPrivateRegularFile(filename, "Recovery authorization policy");
    if (readback.state !== "ok" || readback.content !== `${JSON.stringify(record, null, 2)}\n`) throw new RuntimeError("PERSISTENCE_FAILURE", "Recovery policy readback did not match the committed record");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new RuntimeError(
      "PERSISTENCE_FAILURE",
      "Recovery policy publication failed",
      { cause: error },
    );
  }
}

function sign(
  record: RecoveryPolicyPublicRecord,
  secret: string,
): SignedRecoveryPolicy {
  return { ...record, signature: signPayload(record, secret) };
}

function signPayload(
  record: Omit<SignedRecoveryPolicy, "signature"> | SignedRecoveryPolicy,
  secret: string,
): string {
  const payload = { ...record } as Record<string, unknown>;
  delete payload.signature;
  return createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
}

function publicRecord(
  record: SignedRecoveryPolicy,
): RecoveryPolicyPublicRecord {
  const publicValue = { ...record } as Record<string, unknown>;
  delete publicValue.signature;
  if (Array.isArray(record.retiredPolicies)) {
    publicValue.retiredPolicies = record.retiredPolicies.map((retired) => {
      const historical = publicRecord(retired);
      return historical;
    });
  }
  return publicValue as unknown as RecoveryPolicyPublicRecord;
}

function sameIssue(
  existing: SignedRecoveryPolicy,
  input: RecoveryPolicyIssueInput,
  dataRoot: string,
): boolean {
  return (
    existing.dataRoot === dataRoot &&
    existing.protectedReferenceRoot ===
      (input.protectedReferenceRoot ?? null) &&
    (existing.machineId ?? null) === (input.machineId ?? null) &&
    existing.beforeMetadataSha256 === input.beforeMetadataSha256 &&
    existing.beforePlistSha256 === input.beforePlistSha256 &&
    existing.maxOperationCount === input.maxOperationCount &&
    existing.expiresAt === input.expiresAt &&
    JSON.stringify(existing.sourceBindings) ===
      JSON.stringify(input.sourceBindings) &&
    JSON.stringify(existing.allowedOperations) ===
      JSON.stringify([...new Set(input.allowedOperations)])
  );
}

function validateIssue(input: RecoveryPolicyIssueInput): void {
  if (
    !Array.isArray(input.sourceBindings) ||
    input.sourceBindings.length === 0 ||
    input.sourceBindings.length > MAX_ENTRIES
  )
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Recovery policy source bindings are invalid",
    );
  for (const binding of input.sourceBindings) {
    if (!HASH40.test(binding.sourceSha) || !HASH40.test(binding.sourceTree) || !HASH64.test(binding.runtimePreflightSha256) || !HASH64.test(binding.runtimeLoaderSha256) || binding.sourceRoot.length === 0 || binding.controlScript.length === 0 || binding.executable.length === 0 || !Array.isArray(binding.executableArguments))
      throw new RuntimeError(
        "INVALID_REQUEST",
        "Recovery policy source identity is invalid",
      );
  }
  if (
    !HASH64.test(input.beforeMetadataSha256) ||
    !HASH64.test(input.beforePlistSha256)
  )
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Recovery policy before-image is invalid",
    );
  if (
    !Number.isInteger(input.maxOperationCount) ||
    input.maxOperationCount < 1 ||
    input.maxOperationCount > MAX_OPERATIONS
  )
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Recovery policy operation limit is invalid",
    );
  if (
    !Array.isArray(input.allowedOperations) ||
    input.allowedOperations.length === 0 ||
    new Set(input.allowedOperations).size !== input.allowedOperations.length ||
    input.allowedOperations.some((operation) => !POLICY_OPERATIONS.includes(operation))
  )
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Recovery policy operations are invalid",
    );
  if (input.machineId !== undefined && !isUuid(input.machineId))
    throw new RuntimeError("INVALID_REQUEST", "Recovery policy machine identity is invalid");
  if (input.supersedesPolicyId !== undefined && !isUuid(input.supersedesPolicyId))
    throw new RuntimeError("INVALID_REQUEST", "Recovery policy predecessor identity is invalid");
  if (input.allowedOperations.some(requiresHostBinding) && input.machineId === undefined)
    throw new RuntimeError("INVALID_REQUEST", "Protected control policy requires a machine identity");
  if (input.allowedOperations.some(requiresHostBinding) && input.sourceBindings.some((binding) => binding.executableSha256 === undefined || !HASH64.test(binding.executableSha256)))
    throw new RuntimeError("INVALID_REQUEST", "Protected control policy requires executable digests");
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now())
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Recovery policy expiration is invalid",
    );
}

function validateOperation(input: RecoveryPolicyOperationInput): void {
  if (
    !isUuid(input.policyId) ||
    !isUuid(input.requestId) ||
    !HASH40.test(input.sourceSha) ||
    !HASH40.test(input.sourceTree) ||
    !HASH64.test(input.beforeMetadataSha256) ||
    !HASH64.test(input.beforePlistSha256) ||
    !HASH64.test(input.runtimePreflightSha256) ||
    !HASH64.test(input.runtimeLoaderSha256) ||
    input.sourceRoot.length === 0 || input.controlScript.length === 0 || input.executable.length === 0 || !Array.isArray(input.executableArguments)
  )
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Recovery policy operation identity is invalid",
    );
  if (input.machineId !== undefined && !isUuid(input.machineId))
    throw new RuntimeError("INVALID_REQUEST", "Recovery policy operation machine identity is invalid");
  if (requiresHostBinding(input.operation) && input.machineId === undefined)
    throw new RuntimeError("INVALID_REQUEST", "Supervisor bootstrap operation requires a machine identity");
  if (requiresHostBinding(input.operation) && (input.executableSha256 === undefined || !HASH64.test(input.executableSha256)))
    throw new RuntimeError("INVALID_REQUEST", "Supervisor bootstrap operation requires an executable digest");
}

function isSignedPolicy(value: unknown, depth = 0): value is SignedRecoveryPolicy {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<SignedRecoveryPolicy>;
  return record.schemaVersion === 1
    && isUuid(record.policyId)
    && (record.state === "ISSUED" || record.state === "REVOKED" || record.state === "EXPIRED")
    && typeof record.dataRoot === "string"
    && Array.isArray(record.sourceBindings)
    && record.sourceBindings.length > 0
    && record.sourceBindings.length <= MAX_ENTRIES
    && record.sourceBindings.every((binding) => isRecoveryPolicyBinding(binding))
    && (typeof record.protectedReferenceRoot === "string" || record.protectedReferenceRoot === null)
    && (record.machineId === undefined || record.machineId === null || isUuid(record.machineId))
    && HASH64.test(record.beforeMetadataSha256 ?? "")
    && HASH64.test(record.beforePlistSha256 ?? "")
    && typeof record.maxOperationCount === "number"
    && Array.isArray(record.allowedOperations)
    && record.allowedOperations.length > 0
    && record.allowedOperations.every((operation) => POLICY_OPERATIONS.includes(operation as RecoveryPolicyOperation))
    && (!record.allowedOperations.some(requiresHostBinding) || (record.machineId !== undefined && record.machineId !== null))
    && (!record.allowedOperations.some(requiresHostBinding) || record.sourceBindings.every((binding) => binding.executableSha256 !== undefined))
    && Array.isArray(record.operations)
    && record.operations.length <= MAX_ENTRIES
    && record.operations.every((entry) => typeof entry === "object" && entry !== null && isUuid((entry as RecoveryPolicyOperationJournal).transactionId) && isUuid((entry as RecoveryPolicyOperationJournal).requestId) && POLICY_OPERATIONS.includes((entry as RecoveryPolicyOperationJournal).operation) && HASH40.test((entry as RecoveryPolicyOperationJournal).sourceSha) && HASH40.test((entry as RecoveryPolicyOperationJournal).sourceTree) && typeof (entry as RecoveryPolicyOperationJournal).sourceRoot === "string" && typeof (entry as RecoveryPolicyOperationJournal).controlScript === "string" && typeof (entry as RecoveryPolicyOperationJournal).executable === "string" && Array.isArray((entry as RecoveryPolicyOperationJournal).executableArguments) && HASH64.test((entry as RecoveryPolicyOperationJournal).runtimePreflightSha256) && HASH64.test((entry as RecoveryPolicyOperationJournal).runtimeLoaderSha256) && HASH64.test((entry as RecoveryPolicyOperationJournal).beforeMetadataSha256) && HASH64.test((entry as RecoveryPolicyOperationJournal).beforePlistSha256) && (typeof (entry as RecoveryPolicyOperationJournal).protectedReferenceRoot === "string" || (entry as RecoveryPolicyOperationJournal).protectedReferenceRoot === null) && ((entry as RecoveryPolicyOperationJournal).machineId === undefined || (entry as RecoveryPolicyOperationJournal).machineId === null || isUuid((entry as RecoveryPolicyOperationJournal).machineId)) && (!requiresHostBinding((entry as RecoveryPolicyOperationJournal).operation) || (entry as RecoveryPolicyOperationJournal).machineId !== undefined && (entry as RecoveryPolicyOperationJournal).machineId !== null) && ((entry as RecoveryPolicyOperationJournal).state === "RESERVED" || (entry as RecoveryPolicyOperationJournal).state === "COMMITTED" || (entry as RecoveryPolicyOperationJournal).state === "FAILED" || (entry as RecoveryPolicyOperationJournal).state === "RECONCILIATION_REQUIRED"))
    && Array.isArray(record.audit)
    && typeof record.expiresAt === "string"
    && typeof record.issuedAt === "string"
    && typeof record.signature === "string"
    && /^[a-f0-9]{64}$/.test(record.signature)
    && (record.supersedesPolicyId === undefined || record.supersedesPolicyId === null || isUuid(record.supersedesPolicyId))
    && (record.retiredPoliciesArchive === undefined || isRecoveryPolicyArchiveReference(record.retiredPoliciesArchive))
    && (record.retiredPolicies === undefined || (depth < MAX_RETIRED_POLICIES && Array.isArray(record.retiredPolicies) && record.retiredPolicies.length <= MAX_RETIRED_POLICIES && record.retiredPolicies.every((entry) => isSignedPolicy(entry, depth + 1))));
}

function isRecoveryPolicyArchiveReference(value: unknown): value is RecoveryPolicyArchiveReference {
  if (typeof value !== "object" || value === null) return false;
  const reference = value as RecoveryPolicyArchiveReference;
  return reference.schemaVersion === 1
    && isUuid(reference.archiveId)
    && reference.filename === archiveFilename(reference.archiveId)
    && HASH64.test(reference.sha256)
    && isUuid(reference.predecessorPolicyId)
    && Array.isArray(reference.policyIds)
    && reference.policyIds.length > 0
    && reference.policyIds.every(isUuid)
    && typeof reference.createdAt === "string";
}

function allPolicyOperations(record: RecoveryPolicyPublicRecord): readonly RecoveryPolicyOperationJournal[] {
  const archived = (record as SignedRecoveryPolicyWithArchive)[ARCHIVED_POLICIES] ?? [];
  const entries = [
    ...record.operations,
    ...(record.retiredPolicies ?? []).flatMap((retired) => allPolicyOperations(retired)),
    ...archived.flatMap((retired) => retired.policyId === record.policyId ? [] : allPolicyOperations(retired)),
  ];
  const seen = new Set<string>();
  return entries.filter((entry) => !seen.has(entry.transactionId) && (seen.add(entry.transactionId), true));
}

function retiredPolicyOperations(record: RecoveryPolicyPublicRecord): readonly RecoveryPolicyOperationJournal[] {
  return [
    ...(record.retiredPolicies ?? []).flatMap((retired) => allPolicyOperations(retired)),
    ...((record as SignedRecoveryPolicyWithArchive)[ARCHIVED_POLICIES] ?? []).flatMap((retired) => retired.policyId === record.policyId ? [] : allPolicyOperations(retired)),
  ];
}

function verifyRetiredPolicySignatures(record: SignedRecoveryPolicy, secret: string): void {
  for (const retired of record.retiredPolicies ?? []) {
    verifyPolicySignature(retired, secret);
    verifyRetiredPolicySignatures(retired, secret);
  }
}

function verifyPolicySignature(record: SignedRecoveryPolicy, secret: string): void {
  const actual = Buffer.from(record.signature, "hex");
  const signedPayload = record.state === "EXPIRED" ? { ...record, state: "ISSUED" as const } : record;
  const expected = Buffer.from(signPayload(signedPayload, secret), "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new RuntimeError("CONTROL_DENIED", "Recovery policy historical signature authentication failed");
}

function isRecoveryPolicyBinding(value: unknown): value is RecoveryPolicyBinding {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as RecoveryPolicyBinding;
  return HASH40.test(binding.sourceSha)
    && HASH40.test(binding.sourceTree)
    && typeof binding.sourceRoot === "string"
    && binding.sourceRoot.length > 0
    && typeof binding.controlScript === "string"
    && binding.controlScript.length > 0
    && typeof binding.executable === "string"
    && binding.executable.length > 0
    && (binding.executableSha256 === undefined || HASH64.test(binding.executableSha256))
    && Array.isArray(binding.executableArguments)
    && binding.executableArguments.every((argument) => typeof argument === "string" && !argument.includes("\0"))
    && HASH64.test(binding.runtimePreflightSha256)
    && HASH64.test(binding.runtimeLoaderSha256);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
}
