import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { open, realpath, rename, rm } from "node:fs/promises";
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
}

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
    if ((existing.retiredPolicies?.length ?? 0) >= MAX_RETIRED_POLICIES)
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
    ...(existing === null ? {} : {
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
    && (record.retiredPolicies === undefined || (depth < MAX_RETIRED_POLICIES && Array.isArray(record.retiredPolicies) && record.retiredPolicies.length <= MAX_RETIRED_POLICIES && record.retiredPolicies.every((entry) => isSignedPolicy(entry, depth + 1))));
}

function allPolicyOperations(record: RecoveryPolicyPublicRecord): readonly RecoveryPolicyOperationJournal[] {
  return [
    ...record.operations,
    ...(record.retiredPolicies ?? []).flatMap((retired) => allPolicyOperations(retired)),
  ];
}

function retiredPolicyOperations(record: RecoveryPolicyPublicRecord): readonly RecoveryPolicyOperationJournal[] {
  return (record.retiredPolicies ?? []).flatMap((retired) => allPolicyOperations(retired));
}

function verifyRetiredPolicySignatures(record: SignedRecoveryPolicy, secret: string): void {
  for (const retired of record.retiredPolicies ?? []) {
    const actual = Buffer.from(retired.signature, "hex");
    const signedPayload = retired.state === "EXPIRED" ? { ...retired, state: "ISSUED" as const } : retired;
    const expected = Buffer.from(signPayload(signedPayload, secret), "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new RuntimeError("CONTROL_DENIED", "Recovery policy retirement history authentication failed");
    verifyRetiredPolicySignatures(retired, secret);
  }
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
