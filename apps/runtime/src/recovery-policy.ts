import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { RuntimeError } from "@iris/domain";
import { verifyServiceTargetStopCompletion, verifyServiceTargetStopMaintenanceResolution } from "./launchd.js";
import {
  inspectPrivateRegularFile,
  privateDirectoryProblem,
} from "./private-fs.js";
import { readOwnerAccessSecret } from "./persistence.js";
import { observeProcessStart } from "./macos-safety.js";

export type RecoveryPolicyOperation = "MIGRATION_APPROVAL" | "SOURCE_MIGRATION" | "SUPERVISOR_BOOTSTRAP" | "ADMIN_TUNNEL_START" | "SUPERVISOR_NO_PID_RECOVERY" | "SUPERVISOR_SERVICE_TARGET_STOP" | "RUNTIME_SOURCE_FALLBACK";
export type RecoveryPolicyState = "ISSUED" | "REVOKED" | "EXPIRED";
export type RecoveryPolicyOperationState =
  "RESERVED" | "COMMITTED" | "FAILED" | "RECONCILIATION_REQUIRED";
export type NoPidRecoveryDisposition = "ABSENT" | "LOADED_NO_VERIFIED_PID" | "LOADED_WITH_VERIFIED_LIVE_PROCESS" | "IDENTITY_CONFLICT" | "OBSERVATION_UNKNOWN";

const POLICY_FILE = "com.iris.supervisor.recovery-policy.json";
const HASH40 = /^[a-f0-9]{40}$/;
const HASH64 = /^[a-f0-9]{64}$/;
const MAX_OPERATIONS = 16;
const MAX_ENTRIES = 32;
const MAX_RETIRED_POLICIES = 8;
const POLICY_OPERATIONS: readonly RecoveryPolicyOperation[] = ["MIGRATION_APPROVAL", "SOURCE_MIGRATION", "SUPERVISOR_BOOTSTRAP", "ADMIN_TUNNEL_START", "SUPERVISOR_NO_PID_RECOVERY", "SUPERVISOR_SERVICE_TARGET_STOP", "RUNTIME_SOURCE_FALLBACK"];
const HOST_BOUND_OPERATIONS: readonly RecoveryPolicyOperation[] = ["SUPERVISOR_BOOTSTRAP", "ADMIN_TUNNEL_START", "SUPERVISOR_NO_PID_RECOVERY", "SUPERVISOR_SERVICE_TARGET_STOP", "RUNTIME_SOURCE_FALLBACK"];
const requiresHostBinding = (operation: RecoveryPolicyOperation): boolean => HOST_BOUND_OPERATIONS.includes(operation);

export interface RecoveryPolicyServiceTarget {
  readonly uid: number;
  readonly domain: string;
  readonly label: "com.iris.supervisor";
}

interface RecoveryPolicyLockRecord {
  readonly schemaVersion: 1;
  readonly lockId: string;
  readonly pid: number;
  readonly processStartMarker: string;
}

export interface RuntimeSourceFallbackCandidate {
  readonly role: "primary" | "fallback";
  readonly sourceRoot: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly entrypoint: string;
  readonly entrypointGitBlob: string;
}
export interface RuntimeSourceFallbackEnvelope {
  readonly schemaVersion: 1;
  readonly candidates: readonly [RuntimeSourceFallbackCandidate, RuntimeSourceFallbackCandidate];
  readonly dataRoot: string;
  readonly receiptPath: string;
  readonly startupTimeoutMs: number;
  readonly readinessTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly overallTimeoutMs: number;
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

export interface InitialInstallBinding {
  readonly kind: "ABSENT";
  readonly uid: number;
  readonly domain: string;
  readonly label: "com.iris.supervisor";
  readonly registeredPlist: string;
  readonly connectorId: "iris-full";
  readonly tunnelId: string;
  readonly managedProfilePath: string;
  readonly tunnelExecutable: string;
  readonly tunnelExecutableSha256: string;
  readonly startup: "CONTROL_ONLY";
}

export interface RecoveryPolicyIssueInput {
  readonly dataRoot: string;
  readonly sourceBindings: readonly RecoveryPolicyBinding[];
  readonly protectedReferenceRoot?: string | undefined;
  readonly machineId?: string | undefined;
  readonly sourceFallback?: RuntimeSourceFallbackEnvelope;
  readonly beforeMetadataSha256: string | null;
  readonly initialInstall?: InitialInstallBinding;
  readonly beforePlistSha256: string | null;
  /** Historical source path identity for the narrowly scoped loaded/no-PID recovery record. */
  readonly recordedSourceRoot?: string;
  readonly recordedSourceSha?: string;
  readonly recordedSourceTree?: string;
  readonly serviceTarget?: RecoveryPolicyServiceTarget;
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
  readonly beforeMetadataSha256: string | null;
  readonly initialInstall?: InitialInstallBinding;
  readonly beforePlistSha256: string | null;
  readonly recordedSourceRoot?: string;
  readonly recordedSourceSha?: string;
  readonly recordedSourceTree?: string;
  readonly serviceTarget?: RecoveryPolicyServiceTarget;
  readonly serviceDisabledStateBefore?: "EXPLICIT_ENABLED" | "EXPLICIT_DISABLED" | "NO_EXPLICIT_OVERRIDE";
  readonly recoveryDisposition?: NoPidRecoveryDisposition;
  readonly protectedReferenceRoot?: string | undefined;
  readonly machineId?: string | undefined;
  readonly sourceFallback?: RuntimeSourceFallbackEnvelope;
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
  readonly sourceFallback?: RuntimeSourceFallbackEnvelope;
  readonly beforeMetadataSha256: string | null;
  readonly initialInstall?: InitialInstallBinding;
  readonly beforePlistSha256: string | null;
  readonly recordedSourceRoot?: string;
  readonly recordedSourceSha?: string;
  readonly recordedSourceTree?: string;
  readonly serviceTarget?: RecoveryPolicyServiceTarget;
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
  readonly beforeMetadataSha256: string | null;
  readonly initialInstall?: InitialInstallBinding;
  readonly beforePlistSha256: string | null;
  readonly recordedSourceRoot?: string;
  readonly recordedSourceSha?: string;
  readonly recordedSourceTree?: string;
  readonly serviceTarget?: RecoveryPolicyServiceTarget;
  readonly serviceDisabledStateBefore?: "EXPLICIT_ENABLED" | "EXPLICIT_DISABLED" | "NO_EXPLICIT_OVERRIDE";
  readonly serviceTargetMaintenanceResolution?: {
    readonly observationSha256: string;
    readonly serviceState: "ABSENT";
    readonly registeredPlistState: "MISSING";
    readonly processState: "DEAD";
    readonly metadataSha256: string;
    readonly privatePlistSha256: string;
    readonly disabledStateBefore: "EXPLICIT_ENABLED" | "EXPLICIT_DISABLED" | "NO_EXPLICIT_OVERRIDE";
    readonly disabledStateAfter: "EXPLICIT_ENABLED" | "EXPLICIT_DISABLED" | "NO_EXPLICIT_OVERRIDE";
    readonly resolvedAt: string;
  };
  readonly recoveryDisposition?: NoPidRecoveryDisposition;
  readonly protectedReferenceRoot: string | null;
  readonly machineId?: string | null;
  readonly state: RecoveryPolicyOperationState;
  readonly createdAt: string;
  readonly finalizedAt?: string;
  readonly sourceFallback?: RuntimeSourceFallbackEnvelope;
  readonly ownerAcknowledgement?: {
    readonly observationSha256: string;
    readonly serviceState: "ABSENT";
    readonly domain: string;
    readonly label: "com.iris.supervisor";
    readonly acknowledgedAt: string;
  };
}

export interface RecoveryPolicyAudit {
  readonly event: "ISSUED" | "RESERVED" | "FINALIZED" | "NO_PID_OBSERVATION_ACKNOWLEDGED" | "SERVICE_TARGET_STOP_MAINTENANCE_RESOLVED" | "REVOKED";
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
  validateRuntimeSourceFallbackEnvelope(input.allowedOperations, input.sourceFallback, dataRootForValidation(input.dataRoot));
  const dataRoot = await canonicalDataRoot(input.dataRoot);
  if (input.sourceFallback !== undefined) await validateRuntimeSourceFallbackPathComponents(input.sourceFallback, dataRoot);
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
      allPolicyOperations(existing).some(isUnresolvedPolicyOperation)
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
    if (allPolicyOperations(existing).some(isUnresolvedPolicyOperation))
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
    ...(input.recordedSourceRoot === undefined ? {} : { recordedSourceRoot: input.recordedSourceRoot }),
    ...(input.recordedSourceSha === undefined ? {} : { recordedSourceSha: input.recordedSourceSha }),
    ...(input.recordedSourceTree === undefined ? {} : { recordedSourceTree: input.recordedSourceTree }),
    ...(input.serviceTarget === undefined ? {} : { serviceTarget: input.serviceTarget }),
    ...(input.initialInstall === undefined ? {} : { initialInstall: input.initialInstall }),
    allowedOperations: [...new Set(input.allowedOperations)],
    maxOperationCount: input.maxOperationCount,
    expiresAt: input.expiresAt,
    issuedAt: now,
    operations: [],
    audit: [{ event: "ISSUED", at: now }],
    ...(input.supersedesPolicyId === undefined ? {} : { supersedesPolicyId: input.supersedesPolicyId }),
    ...(input.sourceFallback === undefined ? {} : { sourceFallback: input.sourceFallback }),
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
  if (input.operation === "SUPERVISOR_SERVICE_TARGET_STOP" && input.serviceDisabledStateBefore === undefined)
    throw new RuntimeError("INVALID_REQUEST", "Service-target stop requires a durable disabled-state baseline");
  const dataRoot = await canonicalDataRoot(input.dataRoot);
  if (input.sourceFallback !== undefined) await validateRuntimeSourceFallbackPathComponents(input.sourceFallback, dataRoot);
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
    current.beforePlistSha256 !== input.beforePlistSha256 ||
    current.recordedSourceRoot !== input.recordedSourceRoot ||
    current.recordedSourceSha !== input.recordedSourceSha ||
    current.recordedSourceTree !== input.recordedSourceTree ||
    JSON.stringify(current.serviceTarget ?? null) !== JSON.stringify(input.serviceTarget ?? null) ||
    !sameInitialInstall(current.initialInstall, input.initialInstall)
  )
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy before-image does not match",
    );
  if (input.operation === "RUNTIME_SOURCE_FALLBACK" && !sameRuntimeSourceFallbackEnvelope(current.sourceFallback, input.sourceFallback))
    throw new RuntimeError("CONTROL_DENIED", "Recovery policy fallback envelope does not match issued authority");
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
      existing.recordedSourceRoot !== input.recordedSourceRoot ||
      existing.recordedSourceSha !== input.recordedSourceSha ||
      existing.recordedSourceTree !== input.recordedSourceTree ||
      JSON.stringify(existing.serviceTarget ?? null) !== JSON.stringify(input.serviceTarget ?? null) ||
      existing.serviceDisabledStateBefore !== input.serviceDisabledStateBefore ||
      !sameInitialInstall(existing.initialInstall, input.initialInstall) ||
      existing.protectedReferenceRoot !== (input.protectedReferenceRoot ?? null) ||
      (existing.machineId ?? null) !== (input.machineId ?? null) ||
      JSON.stringify(existing.sourceFallback ?? null) !== JSON.stringify(input.sourceFallback ?? null)
    )
      throw new RuntimeError(
        "CONTROL_DENIED",
        "Recovery request identity conflicts with the policy journal",
      );
    if (existing.operation === "SUPERVISOR_SERVICE_TARGET_STOP" && existing.state === "RESERVED")
      throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Service-target stop outcome is unresolved; it must not be replayed");
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
    allPolicyOperations(current).some(isUnresolvedPolicyOperation)
  )
    throw new RuntimeError(
      "SUPERVISOR_NOT_RUNNING",
      "Recovery policy has an unresolved operation",
    );
  const count = current.operations.filter((entry) => entry.operation === "SUPERVISOR_SERVICE_TARGET_STOP" || entry.operation === "RUNTIME_SOURCE_FALLBACK"
    ? true
    : entry.state === "COMMITTED" || isResolvedNoPidObservation(entry)).length;
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
    ...(input.recordedSourceRoot === undefined ? {} : { recordedSourceRoot: input.recordedSourceRoot }),
    ...(input.recordedSourceSha === undefined ? {} : { recordedSourceSha: input.recordedSourceSha }),
    ...(input.recordedSourceTree === undefined ? {} : { recordedSourceTree: input.recordedSourceTree }),
    ...(input.serviceTarget === undefined ? {} : { serviceTarget: input.serviceTarget }),
    ...(input.serviceDisabledStateBefore === undefined ? {} : { serviceDisabledStateBefore: input.serviceDisabledStateBefore }),
    ...(input.initialInstall === undefined ? {} : { initialInstall: input.initialInstall }),
    protectedReferenceRoot: input.protectedReferenceRoot ?? null,
    ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
    ...(input.sourceFallback === undefined ? {} : { sourceFallback: input.sourceFallback }),
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
  if (input.operation === "SUPERVISOR_SERVICE_TARGET_STOP" && input.state === "COMMITTED")
    throw new RuntimeError("CONTROL_DENIED", "Service-target stop completion requires the verified lifecycle path");
  return withPolicyLock(await canonicalDataRoot(input.dataRoot), () => finalizeRecoveryPolicyOperationUnlocked(input));
}

/** Completes the stop journal only after the trusted LaunchAgent lifecycle verifier succeeds. */
export async function finalizeVerifiedServiceTargetStop(
  input: RecoveryPolicyOperationInput & { readonly transactionId: string },
): Promise<RecoveryPolicyPublicRecord> {
  if (input.operation !== "SUPERVISOR_SERVICE_TARGET_STOP")
    throw new RuntimeError("INVALID_REQUEST", "Only a service-target stop can use verified stop completion");
  const dataRoot = await canonicalDataRoot(input.dataRoot);
  return withPolicyLock(dataRoot, async () => {
    const existing = await readRecoveryPolicyOperation({ ...input, dataRoot });
    if (existing.state !== "RECONCILIATION_REQUIRED")
      throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Service-target stop is not awaiting verified completion");
    await verifyServiceTargetStopCompletion({ ...input, dataRoot });
    return finalizeRecoveryPolicyOperationUnlocked({ ...input, dataRoot, state: "COMMITTED" }, false, true);
  });
}

/** Records present-state maintenance readiness; the historical stop stays unresolved. */
export async function resolveUnknownServiceTargetStopForMaintenance(
  input: RecoveryPolicyOperationInput & { readonly transactionId: string },
  ownerConfirmation: string,
): Promise<RecoveryPolicyPublicRecord> {
  if (input.operation !== "SUPERVISOR_SERVICE_TARGET_STOP" || ownerConfirmation !== "RESOLVE IRIS SERVICE-TARGET STOP FOR MAINTENANCE")
    throw new RuntimeError("CONTROL_DENIED", "Fresh Owner maintenance confirmation is required");
  const dataRoot = await canonicalDataRoot(input.dataRoot);
  return withPolicyLock(dataRoot, async () => {
    const secret = await ownerSecret(dataRoot);
    const filename = recoveryPolicyPath(dataRoot);
    const current = await requirePolicy(filename, secret);
    const existing = await readRecoveryPolicyOperation({ ...input, dataRoot });
    if (existing.state !== "RECONCILIATION_REQUIRED" || existing.serviceDisabledStateBefore === undefined || existing.serviceTargetMaintenanceResolution !== undefined)
      throw new RuntimeError("CONTROL_DENIED", "Only an unresolved stop with a durable disabled-state baseline can be maintenance-resolved");
    const evidence = await verifyServiceTargetStopMaintenanceResolution({ ...input, dataRoot }, existing);
    const resolvedAt = new Date().toISOString();
    const signedEvidence = { ...evidence, resolvedAt };
    const observationSha256 = createHash("sha256").update(JSON.stringify({ operation: existing, evidence: signedEvidence })).digest("hex");
    const operations = current.operations.map((entry) => entry.transactionId === input.transactionId && entry.operation === input.operation
      ? { ...entry, serviceTargetMaintenanceResolution: { ...signedEvidence, observationSha256 } }
      : entry);
    if (!operations.some((entry) => entry.transactionId === input.transactionId && entry.operation === input.operation))
      throw new RuntimeError("CONTROL_DENIED", "Unknown stop transaction is not in the current policy");
    const next = { ...current, operations, audit: [...current.audit, { event: "SERVICE_TARGET_STOP_MAINTENANCE_RESOLVED" as const, operation: input.operation, requestId: input.requestId, transactionId: input.transactionId, state: "RECONCILIATION_REQUIRED" as const, at: resolvedAt }] };
    await writeSigned(filename, sign(next, secret));
    return next;
  });
}

export async function reconcileRecoveryPolicyOperation(input: RecoveryPolicyOperationInput & { readonly transactionId: string }): Promise<RecoveryPolicyPublicRecord> {
  return finalizeRecoveryPolicyOperation({ ...input, ...(input.operation === "SUPERVISOR_NO_PID_RECOVERY" ? { recoveryDisposition: input.recoveryDisposition ?? "OBSERVATION_UNKNOWN" } : {}), state: "RECONCILIATION_REQUIRED" });
}

/** Terminally records a verified failed ADMIN tunnel start without implying success. */
export async function resolveFailedAdminTunnelStart(input: RecoveryPolicyOperationInput & { readonly transactionId: string }): Promise<RecoveryPolicyPublicRecord> {
  if (input.operation !== "ADMIN_TUNNEL_START")
    throw new RuntimeError("INVALID_REQUEST", "Only an ADMIN_TUNNEL_START may be resolved as failed");
  return finalizeRecoveryPolicyOperation({ ...input, state: "FAILED" });
}

/** Acknowledges evidence only; the caller must first verify launchd currently reports ABSENT. */
export async function acknowledgeNoPidRecoveryObservation(
  input: RecoveryPolicyOperationInput & { readonly transactionId: string },
  evidence: { readonly serviceState: "ABSENT"; readonly domain: string; readonly label: "com.iris.supervisor"; readonly ownerConfirmation: string },
): Promise<void> {
  if (input.operation !== "SUPERVISOR_NO_PID_RECOVERY" || !/^gui\/\d+$/.test(evidence.domain))
    throw new RuntimeError("CONTROL_DENIED", "Only an exact no-PID observation can be acknowledged");
  await withPolicyLock(await canonicalDataRoot(input.dataRoot), async () => {
    validateOperation(input);
    if (!isUuid(input.transactionId)) throw new RuntimeError("INVALID_REQUEST", "Recovery transaction ID is invalid");
    const dataRoot = await canonicalDataRoot(input.dataRoot);
    const secret = await ownerSecret(dataRoot);
    const filename = recoveryPolicyPath(dataRoot);
    const current = await requirePolicy(filename, secret);
    const ownerConfirmation = current.state === "EXPIRED"
      ? "ACKNOWLEDGE EXPIRED IRIS NO-PID OBSERVATION"
      : "ACKNOWLEDGE IRIS NO-PID OBSERVATION";
    if (current.policyId !== input.policyId || (current.state !== "ISSUED" && current.state !== "EXPIRED") || current.state === "ISSUED" && current.expiresAt <= new Date().toISOString() || evidence.ownerConfirmation !== ownerConfirmation)
      throw new RuntimeError("CONTROL_DENIED", "No-PID recovery authorization is stale or expired");
    const index = current.operations.findIndex((entry) => entry.transactionId === input.transactionId && entry.requestId === input.requestId && entry.operation === input.operation);
    const existing = current.operations[index];
    if (existing === undefined || existing.state !== "RECONCILIATION_REQUIRED" || !["ABSENT", "LOADED_NO_VERIFIED_PID"].includes(existing.recoveryDisposition ?? "") || existing.ownerAcknowledgement !== undefined
      || existing.sourceSha !== input.sourceSha || existing.sourceTree !== input.sourceTree || existing.sourceRoot !== input.sourceRoot || existing.controlScript !== input.controlScript || existing.executable !== input.executable
      || (existing.executableSha256 ?? null) !== (input.executableSha256 ?? null) || JSON.stringify(existing.executableArguments) !== JSON.stringify(input.executableArguments)
      || existing.runtimePreflightSha256 !== input.runtimePreflightSha256 || existing.runtimeLoaderSha256 !== input.runtimeLoaderSha256
      || existing.beforeMetadataSha256 !== input.beforeMetadataSha256 || existing.beforePlistSha256 !== input.beforePlistSha256 || existing.recoveryDisposition !== input.recoveryDisposition
      || existing.recordedSourceRoot !== input.recordedSourceRoot || existing.protectedReferenceRoot !== (input.protectedReferenceRoot ?? null)
      || (existing.machineId ?? null) !== (input.machineId ?? null))
      throw new RuntimeError("CONTROL_DENIED", "No-PID observation identity or before-image changed");
    const now = new Date().toISOString();
    const operations = current.operations.slice();
    operations[index] = { ...existing, ownerAcknowledgement: { observationSha256: createHash("sha256").update(JSON.stringify(existing)).digest("hex"), serviceState: evidence.serviceState, domain: evidence.domain, label: evidence.label, acknowledgedAt: now } };
    // Expiration is derived from expiresAt; preserve the original signed payload form for retirement verification.
    const next = { ...current, ...(current.state === "EXPIRED" ? { state: "ISSUED" as const } : {}), operations, audit: [...current.audit, { event: "NO_PID_OBSERVATION_ACKNOWLEDGED" as const, operation: input.operation, requestId: input.requestId, transactionId: input.transactionId, state: existing.state, at: now }] };
    await writeSigned(filename, sign(next, secret));
  });
}

export async function assertRecoveryPolicyOperationCommitted(input: RecoveryPolicyOperationInput & { readonly transactionId: string }): Promise<void> {
  if ((await readRecoveryPolicyOperation(input)).state !== "COMMITTED") throw new RuntimeError("CONTROL_DENIED", "Recovery policy operation is not durably committed");
}

export async function resolveInitialInstallOperation(input: RecoveryPolicyOperationInput & { readonly transactionId: string; readonly state: "COMMITTED" | "FAILED" }): Promise<RecoveryPolicyPublicRecord> {
  if (input.operation !== "SUPERVISOR_BOOTSTRAP" || input.initialInstall === undefined) throw new RuntimeError("INVALID_REQUEST", "Initial reconciliation requires absent-state bootstrap authority");
  return withPolicyLock(await canonicalDataRoot(input.dataRoot), () => finalizeRecoveryPolicyOperationUnlocked(input, true));
}

export async function readRecoveryPolicyOperation(input: RecoveryPolicyOperationInput & { readonly transactionId: string }): Promise<RecoveryPolicyOperationJournal> {
  validateOperation(input);
  if (!isUuid(input.transactionId)) throw new RuntimeError("INVALID_REQUEST", "Recovery transaction ID is invalid");
  const dataRoot = await canonicalDataRoot(input.dataRoot);
  const enrolled = await requirePolicy(recoveryPolicyPath(dataRoot), await ownerSecret(dataRoot));
  const current = findPolicy(enrolled, input.policyId);
  if (current === undefined)
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery policy identity does not match",
    );
  const entry = current.operations.find((candidate) => candidate.transactionId === input.transactionId && candidate.requestId === input.requestId && candidate.operation === input.operation);
  if (entry === undefined || entry.sourceSha !== input.sourceSha || entry.sourceTree !== input.sourceTree || entry.sourceRoot !== input.sourceRoot || entry.controlScript !== input.controlScript || entry.executable !== input.executable || (entry.executableSha256 ?? null) !== (input.executableSha256 ?? null) || JSON.stringify(entry.executableArguments) !== JSON.stringify(input.executableArguments) || entry.runtimePreflightSha256 !== input.runtimePreflightSha256 || entry.runtimeLoaderSha256 !== input.runtimeLoaderSha256 || entry.beforeMetadataSha256 !== input.beforeMetadataSha256 || entry.beforePlistSha256 !== input.beforePlistSha256 || entry.recordedSourceRoot !== input.recordedSourceRoot || entry.recordedSourceSha !== input.recordedSourceSha || entry.recordedSourceTree !== input.recordedSourceTree || JSON.stringify(entry.serviceTarget ?? null) !== JSON.stringify(input.serviceTarget ?? null) || input.serviceDisabledStateBefore !== undefined && entry.serviceDisabledStateBefore !== input.serviceDisabledStateBefore || !sameInitialInstall(entry.initialInstall, input.initialInstall) || !sameRuntimeSourceFallbackEnvelope(entry.sourceFallback, input.sourceFallback) || entry.protectedReferenceRoot !== (input.protectedReferenceRoot ?? null) || (entry.machineId ?? null) !== (input.machineId ?? null)) throw new RuntimeError("CONTROL_DENIED", "Recovery policy operation binding is not authenticated");
  return entry;
}

async function finalizeRecoveryPolicyOperationUnlocked(input: RecoveryPolicyOperationInput & { readonly transactionId: string; readonly state: Exclude<RecoveryPolicyOperationState, "RESERVED"> }, initialReconciliation = false, verifiedServiceTargetStop = false): Promise<RecoveryPolicyPublicRecord> {
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
    existing.recordedSourceRoot !== input.recordedSourceRoot ||
    existing.recordedSourceSha !== input.recordedSourceSha ||
    existing.recordedSourceTree !== input.recordedSourceTree ||
    JSON.stringify(existing.serviceTarget ?? null) !== JSON.stringify(input.serviceTarget ?? null) ||
    !sameInitialInstall(existing.initialInstall, input.initialInstall) ||
    !sameRuntimeSourceFallbackEnvelope(existing.sourceFallback, input.sourceFallback) ||
    existing.protectedReferenceRoot !== (input.protectedReferenceRoot ?? null) ||
    (existing.machineId ?? null) !== (input.machineId ?? null)
  )
    throw new RuntimeError(
      "CONTROL_DENIED",
      "Recovery transaction source binding changed",
    );
  if (input.state === "FAILED" && !initialReconciliation && !((existing.state === "RECONCILIATION_REQUIRED" && existing.operation === "ADMIN_TUNNEL_START") || (existing.state === "RESERVED" && existing.operation === "SUPERVISOR_SERVICE_TARGET_STOP") || (existing.state === "RESERVED" && existing.operation === "RUNTIME_SOURCE_FALLBACK")))
    throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Only a reconciliation-required ADMIN tunnel start or reserved fallback may be resolved as failed");
  if (input.operation === "SUPERVISOR_NO_PID_RECOVERY" && input.state !== "RECONCILIATION_REQUIRED")
    throw new RuntimeError("SUPERVISOR_NOT_RUNNING", "Loaded/no-PID recovery evidence cannot authorize a service transition");
  if (input.operation === "SUPERVISOR_NO_PID_RECOVERY" && input.state === "RECONCILIATION_REQUIRED" && input.recoveryDisposition === undefined)
    throw new RuntimeError("INVALID_REQUEST", "Loaded/no-PID recovery reconciliation requires a recorded disposition");
  const resolvingFailedAdminTunnel = input.state === "FAILED" && existing.state === "RECONCILIATION_REQUIRED" && existing.operation === "ADMIN_TUNNEL_START";
  const committingVerifiedServiceTargetStop = verifiedServiceTargetStop && input.state === "COMMITTED" && existing.state === "RECONCILIATION_REQUIRED" && existing.operation === "SUPERVISOR_SERVICE_TARGET_STOP";
  if (existing.state !== "RESERVED" && !resolvingFailedAdminTunnel && !committingVerifiedServiceTargetStop && !(initialReconciliation && existing.state === "RECONCILIATION_REQUIRED")) {
    if (existing.state === input.state) return current;
    throw new RuntimeError(
      "SUPERVISOR_NOT_RUNNING",
      "Recovery transaction has already been finalized",
    );
  }
  const finalizedAt = new Date().toISOString();
  const operations = current.operations.slice();
  operations[index] = { ...existing, ...(input.recoveryDisposition === undefined ? {} : { recoveryDisposition: input.recoveryDisposition }), state: input.state, finalizedAt };
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
    allPolicyOperations(current).some(isUnresolvedPolicyOperation)
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
  } satisfies RecoveryPolicyLockRecord)}
`;
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
    "if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:",
    "    raise RuntimeError('unsafe advisory lock anchor')",
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
    await handle.writeFile(`${JSON.stringify(record, null, 2)}
`, "utf8");
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
    if (readback.state !== "ok" || readback.content !== `${JSON.stringify(record, null, 2)}
`) throw new RuntimeError("PERSISTENCE_FAILURE", "Recovery policy readback did not match the committed record");
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
      return historical.state === "ISSUED" && historical.expiresAt <= new Date().toISOString()
        ? { ...historical, state: "EXPIRED" }
        : historical;
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
    existing.recordedSourceRoot === input.recordedSourceRoot &&
    existing.recordedSourceSha === input.recordedSourceSha &&
    existing.recordedSourceTree === input.recordedSourceTree &&
    JSON.stringify(existing.serviceTarget ?? null) === JSON.stringify(input.serviceTarget ?? null) &&
    sameInitialInstall(existing.initialInstall, input.initialInstall) &&
    existing.maxOperationCount === input.maxOperationCount &&
    existing.expiresAt === input.expiresAt &&
    JSON.stringify(existing.sourceBindings) ===
      JSON.stringify(input.sourceBindings) &&
    JSON.stringify(existing.allowedOperations) ===
      JSON.stringify([...new Set(input.allowedOperations)]) &&
    sameRuntimeSourceFallbackEnvelope(existing.sourceFallback, input.sourceFallback)
  );
}

function validateIssue(input: RecoveryPolicyIssueInput): void {
  if (input.allowedOperations.includes("SUPERVISOR_NO_PID_RECOVERY") && !isCanonicalRecordedSourceRoot(input.recordedSourceRoot))
    throw new RuntimeError("INVALID_REQUEST", "Loaded/no-PID recovery policy requires an exact recorded source path");
  const serviceTargetStop = input.allowedOperations.includes("SUPERVISOR_SERVICE_TARGET_STOP");
  if (serviceTargetStop && (input.allowedOperations.length !== 1 || input.maxOperationCount !== 1
    || input.sourceBindings.length !== 1
    || typeof input.recordedSourceRoot !== "string" || !isCanonicalRecordedSourceRoot(input.recordedSourceRoot)
    || input.recordedSourceSha === undefined || !HASH40.test(input.recordedSourceSha)
    || input.recordedSourceTree === undefined || !HASH40.test(input.recordedSourceTree)
    || !isRecoveryPolicyServiceTarget(input.serviceTarget)))
    throw new RuntimeError("INVALID_REQUEST", "Service-target stop requires one exact, machine-bound authorization");
  if (!serviceTargetStop && (input.recordedSourceSha !== undefined || input.recordedSourceTree !== undefined || input.serviceTarget !== undefined))
    throw new RuntimeError("INVALID_REQUEST", "Service-target identity is only valid for its dedicated recovery operation");
  if (input.initialInstall !== undefined && (input.allowedOperations.length !== 1 || input.allowedOperations[0] !== "SUPERVISOR_BOOTSTRAP" || input.maxOperationCount !== 1))
    throw new RuntimeError("INVALID_REQUEST", "Initial installation authorizes one Supervisor bootstrap only");
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
    !validBeforeImage(input)
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
  if (input.allowedOperations.includes("RUNTIME_SOURCE_FALLBACK") && (input.allowedOperations.length !== 1 || input.maxOperationCount !== 1))
    throw new RuntimeError("INVALID_REQUEST", "Runtime source fallback authorizes one operation only");
  if (input.allowedOperations.includes("RUNTIME_SOURCE_FALLBACK") && (input.machineId === undefined || input.sourceFallback === undefined))
    throw new RuntimeError("INVALID_REQUEST", "Runtime source fallback requires machine binding and envelope");
  if (input.allowedOperations.includes("SUPERVISOR_NO_PID_RECOVERY") && (input.allowedOperations.length !== 1 || input.maxOperationCount !== 1))
    throw new RuntimeError("INVALID_REQUEST", "Loaded/no-PID recovery authorizes one operation only");
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
  validateRuntimeSourceFallbackEnvelope([input.operation], input.sourceFallback, dataRootForValidation(input.dataRoot));
  if (input.operation === "RUNTIME_SOURCE_FALLBACK" && input.sourceFallback === undefined)
    throw new RuntimeError("INVALID_REQUEST", "Runtime source fallback requires its complete envelope");
  if (input.operation === "RUNTIME_SOURCE_FALLBACK" && input.sourceFallback !== undefined && !validateRuntimeSourceFallbackEnvelopeValue(input.sourceFallback))
    throw new RuntimeError("INVALID_REQUEST", "Runtime source fallback envelope is invalid");
  if (input.operation === "SUPERVISOR_NO_PID_RECOVERY" && !isCanonicalRecordedSourceRoot(input.recordedSourceRoot))
    throw new RuntimeError("INVALID_REQUEST", "Loaded/no-PID recovery operation requires an exact recorded source path");
  if (input.recoveryDisposition !== undefined && (input.operation !== "SUPERVISOR_NO_PID_RECOVERY" || !["ABSENT", "LOADED_NO_VERIFIED_PID", "LOADED_WITH_VERIFIED_LIVE_PROCESS", "IDENTITY_CONFLICT", "OBSERVATION_UNKNOWN"].includes(input.recoveryDisposition)))
    throw new RuntimeError("INVALID_REQUEST", "Loaded/no-PID recovery disposition is invalid");
  const serviceTargetStop = input.operation === "SUPERVISOR_SERVICE_TARGET_STOP";
  if (serviceTargetStop && (typeof input.recordedSourceRoot !== "string" || !isCanonicalRecordedSourceRoot(input.recordedSourceRoot)
    || input.recordedSourceSha === undefined || !HASH40.test(input.recordedSourceSha)
    || input.recordedSourceTree === undefined || !HASH40.test(input.recordedSourceTree)
    || !isRecoveryPolicyServiceTarget(input.serviceTarget)))
    throw new RuntimeError("INVALID_REQUEST", "Service-target stop operation identity is invalid");
  if (!serviceTargetStop && (input.recordedSourceSha !== undefined || input.recordedSourceTree !== undefined || input.serviceTarget !== undefined))
    throw new RuntimeError("INVALID_REQUEST", "Service-target identity is only valid for its dedicated recovery operation");
  if (input.initialInstall !== undefined && input.operation !== "SUPERVISOR_BOOTSTRAP")
    throw new RuntimeError("INVALID_REQUEST", "Absent installation authority cannot authorize migration or tunnel recovery");
  if (input.serviceDisabledStateBefore !== undefined && (input.operation !== "SUPERVISOR_SERVICE_TARGET_STOP" || !["EXPLICIT_ENABLED", "EXPLICIT_DISABLED", "NO_EXPLICIT_OVERRIDE"].includes(input.serviceDisabledStateBefore)))
    throw new RuntimeError("INVALID_REQUEST", "Service-target disabled-state baseline is invalid");
  if (
    !isUuid(input.policyId) ||
    !isUuid(input.requestId) ||
    !HASH40.test(input.sourceSha) ||
    !HASH40.test(input.sourceTree) ||
    !validBeforeImage(input) ||
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

function dataRootForValidation(value: string): string { return path.resolve(value); }
function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}
function validateRuntimeSourceFallbackEnvelope(
  operations: readonly RecoveryPolicyOperation[],
  envelope: RuntimeSourceFallbackEnvelope | undefined,
  dataRoot: string,
): void {
  if (operations.includes("RUNTIME_SOURCE_FALLBACK") !== (envelope !== undefined)) throw new RuntimeError("INVALID_REQUEST", "RUNTIME_SOURCE_FALLBACK requires exactly one complete envelope");
  if (envelope === undefined) return;
  if (!validateRuntimeSourceFallbackEnvelopeValue(envelope)) throw new RuntimeError("INVALID_REQUEST", "Runtime source fallback envelope is invalid");
  if (envelope.dataRoot !== dataRoot) throw new RuntimeError("INVALID_REQUEST", "Runtime source fallback data root binding is invalid");
}
function validateRuntimeSourceFallbackEnvelopeValue(envelope: unknown): envelope is RuntimeSourceFallbackEnvelope {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return false;
  const value = envelope as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const allowed = ["candidates","dataRoot","overallTimeoutMs","readinessTimeoutMs","receiptPath","schemaVersion","startupTimeoutMs","cleanupTimeoutMs"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(allowed) || value.schemaVersion !== 1 || !Array.isArray(value.candidates) || value.candidates.length !== 2) return false;
  if (value.dataRoot !== path.normalize(String(value.dataRoot)) || !path.isAbsolute(String(value.dataRoot))) return false;
  const dataRoot = String(value.dataRoot); const receipt = String(value.receiptPath);
  if (!path.isAbsolute(receipt) || path.normalize(receipt) !== receipt || !pathWithin(dataRoot, receipt) || receipt === dataRoot) return false;
  const timeouts = [value.startupTimeoutMs, value.readinessTimeoutMs, value.cleanupTimeoutMs, value.overallTimeoutMs];
  if (timeouts.some((timeout) => !Number.isSafeInteger(timeout) || Number(timeout) <= 0 || Number(timeout) > 600_000)) return false;
  if (Number(value.overallTimeoutMs) < Number(value.startupTimeoutMs) + Number(value.readinessTimeoutMs) + Number(value.cleanupTimeoutMs)) return false;
  const [a,b] = value.candidates as unknown[];
  if (!isRuntimeSourceFallbackCandidate(a) || !isRuntimeSourceFallbackCandidate(b) || a.role !== "primary" || b.role !== "fallback") return false;
  const immutable = (candidate: RuntimeSourceFallbackCandidate) => [candidate.sourceRoot,candidate.sourceSha,candidate.sourceTree,candidate.entrypoint,candidate.entrypointGitBlob].join("\u0000");
  return immutable(a) !== immutable(b);
}
function isRuntimeSourceFallbackCandidate(value: unknown): value is RuntimeSourceFallbackCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const allowed = ["entrypoint","entrypointGitBlob","role","sourceRoot","sourceSha","sourceTree"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(allowed)) return false;
  if (candidate.role !== "primary" && candidate.role !== "fallback") return false;
  if (typeof candidate.sourceRoot !== "string" || !path.isAbsolute(candidate.sourceRoot) || path.normalize(candidate.sourceRoot) !== candidate.sourceRoot) return false;
  if (typeof candidate.entrypoint !== "string" || candidate.entrypoint.length === 0 || path.isAbsolute(candidate.entrypoint) || path.relative(".", candidate.entrypoint).startsWith("..")) return false;
  return HASH40.test(String(candidate.sourceSha)) && HASH40.test(String(candidate.sourceTree)) && HASH40.test(String(candidate.entrypointGitBlob));
}

function sameRuntimeSourceFallbackEnvelope(left: RuntimeSourceFallbackEnvelope | undefined, right: RuntimeSourceFallbackEnvelope | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

async function validateRuntimeSourceFallbackPathComponents(
  envelope: RuntimeSourceFallbackEnvelope,
  dataRoot: string,
): Promise<void> {
  const root = path.resolve(dataRoot);
  const receipt = path.resolve(envelope.receiptPath);
  if (!pathWithin(root, receipt) || receipt === root)
    throw new RuntimeError("INVALID_REQUEST", "Runtime source fallback receipt path is outside the data root");
  const relative = path.relative(root, receipt);
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink())
        throw new RuntimeError("INVALID_REQUEST", "Runtime source fallback receipt path crosses a symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
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
    && validBeforeImage(record)
    && (record.recordedSourceRoot === undefined || isCanonicalRecordedSourceRoot(record.recordedSourceRoot))
    && (record.recordedSourceSha === undefined || HASH40.test(record.recordedSourceSha))
    && (record.recordedSourceTree === undefined || HASH40.test(record.recordedSourceTree))
    && (record.serviceTarget === undefined || isRecoveryPolicyServiceTarget(record.serviceTarget))
    && (record.sourceFallback === undefined || validateRuntimeSourceFallbackEnvelopeValue(record.sourceFallback))
    && Array.isArray(record.allowedOperations)
    && (record.allowedOperations.includes("RUNTIME_SOURCE_FALLBACK") === (record.sourceFallback !== undefined))
    && (record.initialInstall === undefined || record.allowedOperations?.length === 1 && record.allowedOperations[0] === "SUPERVISOR_BOOTSTRAP" && record.maxOperationCount === 1)
    && typeof record.maxOperationCount === "number"
    && Array.isArray(record.allowedOperations)
    && record.allowedOperations.length > 0
    && record.allowedOperations.every((operation) => POLICY_OPERATIONS.includes(operation as RecoveryPolicyOperation))
    && (!record.allowedOperations.includes("SUPERVISOR_NO_PID_RECOVERY") || isCanonicalRecordedSourceRoot(record.recordedSourceRoot))
    && (!record.allowedOperations.includes("SUPERVISOR_SERVICE_TARGET_STOP") || record.allowedOperations.length === 1 && record.maxOperationCount === 1 && isCanonicalRecordedSourceRoot(record.recordedSourceRoot) && HASH40.test(record.recordedSourceSha ?? "") && HASH40.test(record.recordedSourceTree ?? "") && isRecoveryPolicyServiceTarget(record.serviceTarget))
    && (record.allowedOperations.includes("SUPERVISOR_SERVICE_TARGET_STOP") || record.recordedSourceSha === undefined && record.recordedSourceTree === undefined && record.serviceTarget === undefined)
    && (!record.allowedOperations.some(requiresHostBinding) || (record.machineId !== undefined && record.machineId !== null))
    && (!record.allowedOperations.some(requiresHostBinding) || record.sourceBindings.every((binding) => binding.executableSha256 !== undefined))
    && Array.isArray(record.operations)
    && record.operations.length <= MAX_ENTRIES
    && record.operations.every((entry) => {
      const journal = entry as RecoveryPolicyOperationJournal;
      return typeof entry === "object" && entry !== null && isUuid(journal.transactionId) && isUuid(journal.requestId) && POLICY_OPERATIONS.includes(journal.operation) && HASH40.test(journal.sourceSha) && HASH40.test(journal.sourceTree) && typeof journal.sourceRoot === "string" && typeof journal.controlScript === "string" && typeof journal.executable === "string" && Array.isArray(journal.executableArguments) && HASH64.test(journal.runtimePreflightSha256) && HASH64.test(journal.runtimeLoaderSha256) && validBeforeImage(journal) && (journal.recordedSourceRoot === undefined || isCanonicalRecordedSourceRoot(journal.recordedSourceRoot)) && (journal.operation !== "SUPERVISOR_NO_PID_RECOVERY" || journal.recordedSourceRoot !== undefined) && (journal.recoveryDisposition === undefined || journal.operation === "SUPERVISOR_NO_PID_RECOVERY" && isNoPidRecoveryDisposition(journal.recoveryDisposition)) && (journal.state !== "RECONCILIATION_REQUIRED" || journal.operation !== "SUPERVISOR_NO_PID_RECOVERY" || journal.recoveryDisposition !== undefined) && (journal.initialInstall === undefined || journal.operation === "SUPERVISOR_BOOTSTRAP") && (typeof journal.protectedReferenceRoot === "string" || journal.protectedReferenceRoot === null) && (journal.machineId === undefined || journal.machineId === null || isUuid(journal.machineId)) && (!requiresHostBinding(journal.operation) || journal.machineId !== undefined && journal.machineId !== null) && (journal.state === "RESERVED" || journal.state === "COMMITTED" || journal.state === "FAILED" || journal.state === "RECONCILIATION_REQUIRED") && (journal.operation === "RUNTIME_SOURCE_FALLBACK" ? validateRuntimeSourceFallbackEnvelopeValue(journal.sourceFallback) && journal.sourceFallback !== undefined : journal.sourceFallback === undefined) && (journal.operation !== "RUNTIME_SOURCE_FALLBACK" || sameRuntimeSourceFallbackEnvelope(journal.sourceFallback, record.sourceFallback));
    })
    && record.operations.every((entry) => entry.ownerAcknowledgement === undefined || isResolvedNoPidObservation(entry))
    && record.operations.every((entry) => entry.serviceDisabledStateBefore === undefined || entry.operation === "SUPERVISOR_SERVICE_TARGET_STOP" && ["EXPLICIT_ENABLED", "EXPLICIT_DISABLED", "NO_EXPLICIT_OVERRIDE"].includes(entry.serviceDisabledStateBefore))
    && record.operations.every((entry) => entry.serviceTargetMaintenanceResolution === undefined || isResolvedServiceTargetStopMaintenance(entry))
    && record.operations.every((entry) => entry.serviceTargetMaintenanceResolution === undefined || entry.operation === "SUPERVISOR_SERVICE_TARGET_STOP")
    && record.operations.every((entry) => entry.operation !== "SUPERVISOR_SERVICE_TARGET_STOP" || isCanonicalRecordedSourceRoot(entry.recordedSourceRoot) && HASH40.test(entry.recordedSourceSha ?? "") && HASH40.test(entry.recordedSourceTree ?? "") && isRecoveryPolicyServiceTarget(entry.serviceTarget))
    && record.operations.every((entry) => entry.operation === "SUPERVISOR_SERVICE_TARGET_STOP" || entry.recordedSourceSha === undefined && entry.recordedSourceTree === undefined && entry.serviceTarget === undefined)
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

function isUnresolvedPolicyOperation(entry: RecoveryPolicyOperationJournal): boolean {
  return entry.state === "RESERVED" || entry.state === "RECONCILIATION_REQUIRED" && !isResolvedNoPidObservation(entry) && !isResolvedServiceTargetStopMaintenance(entry);
}

function isResolvedServiceTargetStopMaintenance(entry: RecoveryPolicyOperationJournal): boolean {
  const resolution = entry.serviceTargetMaintenanceResolution;
  if (entry.operation !== "SUPERVISOR_SERVICE_TARGET_STOP" || entry.state !== "RECONCILIATION_REQUIRED" || resolution === undefined
    || entry.serviceDisabledStateBefore === undefined || resolution.serviceState !== "ABSENT" || resolution.registeredPlistState !== "MISSING"
    || resolution.processState !== "DEAD" || resolution.metadataSha256 !== entry.beforeMetadataSha256
    || resolution.privatePlistSha256 !== entry.beforePlistSha256 || resolution.disabledStateBefore !== entry.serviceDisabledStateBefore
    || resolution.disabledStateAfter !== entry.serviceDisabledStateBefore || !HASH64.test(resolution.observationSha256)
    || !Number.isFinite(Date.parse(resolution.resolvedAt))) return false;
  const evidence = { serviceState: resolution.serviceState, registeredPlistState: resolution.registeredPlistState, processState: resolution.processState,
    metadataSha256: resolution.metadataSha256, privatePlistSha256: resolution.privatePlistSha256,
    disabledStateBefore: resolution.disabledStateBefore, disabledStateAfter: resolution.disabledStateAfter, resolvedAt: resolution.resolvedAt };
  const original = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "serviceTargetMaintenanceResolution"));
  return resolution.observationSha256 === createHash("sha256").update(JSON.stringify({ operation: original, evidence })).digest("hex");
}

function isResolvedNoPidObservation(entry: RecoveryPolicyOperationJournal): boolean {
  const acknowledgement = entry.ownerAcknowledgement;
  if (entry.operation !== "SUPERVISOR_NO_PID_RECOVERY" || acknowledgement === undefined) return false;
  const observation = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "ownerAcknowledgement"));
  return acknowledgement.serviceState === "ABSENT"
    && acknowledgement.label === "com.iris.supervisor"
    && /^gui\/\d+$/.test(acknowledgement.domain)
    && Number.isFinite(Date.parse(acknowledgement.acknowledgedAt))
    && HASH64.test(acknowledgement.observationSha256)
    && acknowledgement.observationSha256 === createHash("sha256").update(JSON.stringify(observation)).digest("hex");
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

function isCanonicalRecordedSourceRoot(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
}

function isRecoveryPolicyServiceTarget(value: unknown): value is RecoveryPolicyServiceTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as RecoveryPolicyServiceTarget;
  return Number.isSafeInteger(target.uid) && target.uid >= 0
    && target.domain === `gui/${target.uid}`
    && target.label === "com.iris.supervisor";
}

function isNoPidRecoveryDisposition(value: unknown): value is NoPidRecoveryDisposition {
  return value === "ABSENT" || value === "LOADED_NO_VERIFIED_PID" || value === "LOADED_WITH_VERIFIED_LIVE_PROCESS" || value === "IDENTITY_CONFLICT" || value === "OBSERVATION_UNKNOWN";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
}

function findPolicy(record: RecoveryPolicyPublicRecord, policyId: string): RecoveryPolicyPublicRecord | undefined {
  if (record.policyId === policyId) return record;
  for (const retired of record.retiredPolicies ?? []) {
    const found = findPolicy(retired, policyId);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function validInitialInstallBinding(value: unknown): value is InitialInstallBinding {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as InitialInstallBinding;
  return binding.kind === "ABSENT" && Number.isSafeInteger(binding.uid) && binding.uid >= 0
    && binding.domain === `gui/${binding.uid}` && binding.label === "com.iris.supervisor"
    && binding.connectorId === "iris-full" && /^tunnel_[a-f0-9]{32}$/.test(binding.tunnelId)
    && [binding.registeredPlist, binding.managedProfilePath, binding.tunnelExecutable].every((item) => typeof item === "string" && path.isAbsolute(item) && !item.includes("\0"))
    && HASH64.test(binding.tunnelExecutableSha256) && binding.startup === "CONTROL_ONLY";
}

function validBeforeImage(value: { readonly beforeMetadataSha256?: string | null; readonly beforePlistSha256?: string | null; readonly initialInstall?: InitialInstallBinding }): boolean {
  return value.initialInstall === undefined
    ? typeof value.beforeMetadataSha256 === "string" && HASH64.test(value.beforeMetadataSha256) && typeof value.beforePlistSha256 === "string" && HASH64.test(value.beforePlistSha256)
    : validInitialInstallBinding(value.initialInstall) && value.beforeMetadataSha256 === null && value.beforePlistSha256 === null;
}

function sameInitialInstall(left: InitialInstallBinding | undefined, right: InitialInstallBinding | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return Object.keys(left).length === Object.keys(right).length && (Object.keys(left) as (keyof InitialInstallBinding)[]).every((key) => left[key] === right[key]);
}
