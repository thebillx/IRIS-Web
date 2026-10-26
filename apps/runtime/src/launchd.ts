import { execFile } from 'node:child_process';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, link, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RuntimeError } from '@iris/domain';
import { RUNTIME_DATA_ENV } from './data-root.js';
import { assertSupportedNodeVersion, canonicalNodeRuntime, node24Path } from './node-runtime.js';
import { inspectRegistrationRoot } from './project-path.js';
import { PROTECTED_REFERENCE_ROOT_ENV } from './permissions.js';
import { loadOrCreateOwnerAccessSecret, readOwnerAccessSecret } from './persistence.js';
import { readControlPlaneApiKey } from './credentials.js';
import { readConnectorRegistry } from './connector-registry.js';
import { readMachineId } from './machine-identity.js';
import { observeProcessExecutable, observeProcessOwnerUid, observeProcessStart, type ProcessStartObservation } from './macos-safety.js';
import { acknowledgeNoPidRecoveryObservation, assertRecoveryPolicyOperationCommitted, finalizeRecoveryPolicyOperation, finalizeVerifiedServiceTargetStop, issueRecoveryAuthorizationPolicy, readRecoveryAuthorizationPolicy, readRecoveryPolicyOperation, resolveInitialInstallOperation, resolveUnknownServiceTargetStopForMaintenance as recordUnknownStopMaintenanceResolution, reserveRecoveryPolicyOperation, validInitialInstallBinding, type InitialInstallBinding, type NoPidRecoveryDisposition, type RecoveryPolicyOperationInput, type RecoveryPolicyOperationJournal, type RecoveryPolicyPublicRecord } from './recovery-policy.js';

const execFileAsync = promisify(execFile);
interface ServiceTargetStopCompletionContext {
  readonly identity: string;
  readonly disabledBefore: DisabledState;
  readonly dependencies: LaunchdDependencies;
}

export interface ServiceTargetStopMaintenanceResolutionInput {
  readonly dataRoot: string;
  readonly recoveryPolicyId: string;
  readonly requestId: string;
  readonly transactionId: string;
}
const serviceTargetStopCompletions = new Map<string, ServiceTargetStopCompletionContext>();
const serviceTargetStopMaintenanceDependencies = new Map<string, LaunchdDependencies>();
export const LAUNCH_AGENT_LABEL = 'com.iris.supervisor' as const;
export type LaunchAgentDisabledState = 'EXPLICIT_ENABLED' | 'EXPLICIT_DISABLED' | 'NO_EXPLICIT_OVERRIDE' | 'UNKNOWN';
type DisabledState = LaunchAgentDisabledState;

export interface LaunchdPaths {
  readonly directory: string;
  readonly plist: string;
  readonly metadata: string;
  readonly registrationDirectory: string;
  readonly registeredPlist: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly sourceBindingMigration: string;
  readonly sourceBindingMigrationHistory: string;
  readonly sourceBindingApproval: string;
  readonly sourceBindingApprovalHistory: string;
  readonly sourceBindingApprovalRecovery: string;
  readonly operationLock: string;
  readonly recoveryAuthorizationPolicy: string;
}

export interface LaunchdStatus {
  readonly domain: string;
  readonly loaded: boolean;
  readonly disabled: boolean;
  readonly disabledState: LaunchAgentDisabledState;
  readonly registered: boolean;
  readonly paths: LaunchdPaths;
}

export interface LaunchdDependencies {
  readonly homeDirectory?: string;
  readonly uid?: number;
  readonly launchctl?: (argumentsList: readonly string[]) => Promise<{ readonly stdout: string }>;
  readonly syncDirectory?: (directory: string) => Promise<void>;
  readonly observeProcessStart?: (pid: number) => ProcessStartObservation;
  readonly observeProcessExecutable?: (pid: number) => string | null;
  readonly observeProcessOwnerUid?: (pid: number) => number | null;
}

export interface LaunchAgentBootstrapAuthorization {
  readonly recoveryPolicyId: string;
  readonly requestId: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
}

export interface LaunchAgentSourceApprovalInput {
  readonly dataRoot: string;
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly executableArguments: readonly string[];
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly requestId: string;
  readonly protectedReferenceRoot?: string;
  readonly recoveryPolicyId?: string;
}

export interface LaunchAgentSourceApprovalReconciliationInput {
  readonly dataRoot: string;
  readonly requestId: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
}

export interface LaunchAgentStopForMigrationInput {
  readonly dataRoot: string;
  readonly sourceRoot: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
}

export interface LaunchAgentStopReconciliationInput {
  readonly dataRoot: string;
  readonly sourceRoot: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
}

export interface LaunchAgentNoPidRecoveryInput {
  readonly dataRoot: string;
  readonly recoveryPolicyId: string;
  readonly requestId: string;
}

export interface LaunchAgentServiceTargetStopInput {
  readonly dataRoot: string;
  readonly recoveryPolicyId: string;
  readonly requestId: string;
}

export interface MalformedLegacyApprovalReconciliationInput {
  readonly dataRoot: string;
  readonly approvalId: string;
  readonly requestId: string;
  readonly approvalSha256: string;
  readonly recoveryRequestId: string;
}

export interface MalformedLegacyApprovalReconciliationRecord {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly recoveryRequestId: string;
  readonly approvalId: string;
  readonly requestId: string;
  readonly state: 'PREPARED' | 'APPLYING' | 'COMMITTED' | 'RECONCILIATION_REQUIRED' | 'FAILED';
  readonly label: typeof LAUNCH_AGENT_LABEL;
  readonly domain: string;
  readonly dataRoot: string;
  readonly approvalSha256: string;
  readonly originalApprovalRaw: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
  readonly finalizedApprovalSha256?: string;
}

export interface LaunchAgentSourceApprovalRecord extends LaunchAgentSourceApprovalInput {
  readonly schemaVersion: 1 | 2;
  readonly approvalId: string;
  readonly state: 'ISSUED' | 'CONSUMED' | 'RECONCILIATION_REQUIRED';
  readonly label: typeof LAUNCH_AGENT_LABEL;
  readonly domain: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
  readonly runtimePreflightSha256: string;
  readonly runtimeLoaderSha256: string;
  readonly issuedAt: string;
  readonly signature: string;
  readonly recoveryPolicyTransactionId?: string;
}

export interface LaunchAgentSourceMigrationInput {
  readonly dataRoot: string;
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly executableArguments: readonly string[];
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly approvalId: string;
  readonly requestId: string;
  readonly protectedReferenceRoot?: string;
  readonly recoveryPolicyId?: string;
}

export interface LaunchAgentSourceMigrationRecord {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly requestId: string;
  readonly state: 'PREPARED' | 'APPLYING' | 'COMMITTED' | 'RECONCILIATION_REQUIRED';
  readonly label: typeof LAUNCH_AGENT_LABEL;
  readonly domain: string;
  readonly dataRoot: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
  readonly legacyMetadataRaw: string;
  readonly disabledStateBeforeMigration?: DisabledState;
  readonly targetSourceRoot: string;
  readonly targetControlScript: string;
  readonly targetExecutable: string;
  readonly targetExecutableArguments: readonly string[];
  readonly runtimePreflightSha256: string;
  readonly runtimeLoaderSha256: string;
  readonly targetSourceSha: string;
  readonly targetSourceTree: string;
  readonly approvalId: string;
  readonly protectedReferenceRoot?: string;
  readonly failureCode?: string;
  readonly recoveryPolicyId?: string;
  readonly recoveryPolicyTransactionId?: string;
}

interface LegacyLaunchAgentMetadata {
  readonly schemaVersion: 1;
  readonly label: typeof LAUNCH_AGENT_LABEL;
  readonly executable: string;
  readonly controlScript: string;
  readonly executableArguments: readonly string[];
  readonly plist: string;
}

interface LegacyMigrationEvidence {
  readonly fromSchemaVersion: 1;
  readonly metadataSha256: string;
  readonly plistSha256: string;
  readonly executable: string;
  readonly controlScript: string;
  readonly executableArguments: readonly string[];
  readonly plist: string;
  readonly observedState: 'ABSENT';
  readonly disabledBeforeMigration: boolean;
  readonly disabledStateBeforeMigration?: DisabledState;
}

export interface InitialInstallProvenance extends RecoveryPolicyOperationInput {
  readonly transactionId: string;
  readonly initialInstall: InitialInstallBinding;
}

export interface InitialLaunchAgentPolicyInput {
  readonly dataRoot: string;
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly executableArguments: readonly string[];
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly tunnelExecutable: string;
  readonly expiresAt: string;
  readonly protectedReferenceRoot?: string;
  readonly supersedesPolicyId?: string;
}

interface LaunchAgentMetadata {
  readonly schemaVersion: 3;
  readonly label: typeof LAUNCH_AGENT_LABEL;
  readonly domain: string;
  readonly dataRoot: string;
  readonly sourceRoot: string;
  readonly executable: string;
  readonly controlScript: string;
  readonly executableArguments: readonly string[];
  readonly plist: string;
  readonly registeredPlist: string;
  readonly plistSha256: string;
  readonly state: 'PREPARED' | 'INSTALLING' | 'READY' | 'UNINSTALLING' | 'RECONCILIATION_REQUIRED';
  readonly disabledBeforeInstall: boolean;
  readonly disabledStateBeforeInstall?: DisabledState;
  readonly unresolvedReason: 'BOOTSTRAP_OUTCOME_UNKNOWN' | 'LIVE_IDENTITY_UNVERIFIED' | 'PUBLISHED_STATE_CHANGED' | 'DISABLED_STATE_UNKNOWN' | 'BOOTOUT_OUTCOME_UNKNOWN' | null;
  readonly processId?: number;
  readonly processStartMarker?: string;
  readonly legacyMigration?: LegacyMigrationEvidence;
  readonly initialInstall?: InitialInstallProvenance;
}

interface LaunchAgentMetadataRecord {
  readonly metadata: LaunchAgentMetadata | LegacyLaunchAgentMetadata;
  readonly raw: string;
}

type LaunchAgentObservation =
  | { readonly state: 'ABSENT' }
  | { readonly state: 'LOADED'; readonly stdout: string };

interface LiveLaunchAgentIdentity {
  readonly pid: number;
  readonly registeredPlist: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly dataRoot: string;
}

interface LiveProcessIdentity {
  readonly pid: number;
  readonly processStartMarker: string;
  readonly executable: string;
}

export function launchdPaths(dataRoot: string, homeDirectory = os.homedir()): LaunchdPaths {
  const directory = path.join(dataRoot, 'launchd');
  const registrationDirectory = path.join(homeDirectory, 'Library', 'LaunchAgents');
  return {
    directory,
    plist: path.join(directory, `${LAUNCH_AGENT_LABEL}.plist`),
    metadata: path.join(directory, `${LAUNCH_AGENT_LABEL}.plist.metadata.json`),
    registrationDirectory,
    registeredPlist: path.join(registrationDirectory, `${LAUNCH_AGENT_LABEL}.plist`),
    stdout: path.join(dataRoot, 'logs', 'supervisor.log'),
    stderr: path.join(dataRoot, 'logs', 'supervisor-error.log'),
    sourceBindingMigration: path.join(directory, `${LAUNCH_AGENT_LABEL}.source-binding-migration.json`),
    sourceBindingMigrationHistory: path.join(directory, `${LAUNCH_AGENT_LABEL}.source-binding-migration.history.json`),
    sourceBindingApproval: path.join(directory, `${LAUNCH_AGENT_LABEL}.source-binding-approval.json`),
    sourceBindingApprovalHistory: path.join(directory, `${LAUNCH_AGENT_LABEL}.source-binding-approval.history.json`),
    sourceBindingApprovalRecovery: path.join(directory, `${LAUNCH_AGENT_LABEL}.source-binding-approval-recovery.json`),
    operationLock: path.join(directory, `${LAUNCH_AGENT_LABEL}.operation.lock`),
    recoveryAuthorizationPolicy: path.join(directory, `${LAUNCH_AGENT_LABEL}.recovery-policy.json`),
  };
}

export function renderLaunchAgent(
  dataRoot: string,
  executable: string,
  controlScript: string,
  executableArguments: readonly string[] = [],
  protectedReferenceRoot?: string,
): string {
  const paths = launchdPaths(dataRoot);
  const argumentsList = [executable, ...executableArguments, controlScript, 'supervisor'];
  const configuredProtectedReferenceRoot = protectedReferenceRoot?.trim();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(LAUNCH_AGENT_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...argumentsList.map((argument) => `    <string>${xml(argument)}</string>`),
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xml(sourceRootForControlScript(controlScript))}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>${RUNTIME_DATA_ENV}</key><string>${xml(dataRoot)}</string>`,
    `    <key>PATH</key><string>${xml(node24Path(executable))}</string>`,
    ...(configuredProtectedReferenceRoot === undefined || configuredProtectedReferenceRoot.length === 0
      ? []
      : [`    <key>${PROTECTED_REFERENCE_ROOT_ENV}</key><string>${xml(configuredProtectedReferenceRoot)}</string>`]),
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    `  <key>StandardOutPath</key><string>${xml(paths.stdout)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(paths.stderr)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Issues a one-time, owner-secret-bound migration authorization without mutating launchd. */
export async function issueLaunchAgentSourceApproval(
  input: LaunchAgentSourceApprovalInput,
  dependencies: LaunchdDependencies = {},
): Promise<LaunchAgentSourceApprovalRecord> {
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, async () => {
    assertSupportedNodeVersion();
    validateMigrationInput(input);
    const preflight = await inspectMigrationBinding(input, dependencies);
    const secret = await readOwnerAccessSecret(canonicalDataRoot);
    if (secret === null) throw new RuntimeError('CONTROL_DENIED', 'Owner access approval is not initialized');
    const existing = await readSourceApprovalRecord(paths.sourceBindingApproval, uid);
    let supersededExistingApproval = existing?.state === 'RECONCILIATION_REQUIRED';
    if (existing !== null && existing.state === 'RECONCILIATION_REQUIRED') {
      if (!verifySourceApproval(existing, secret)) {
        throw new RuntimeError('CONTROL_DENIED', 'The existing migration approval cannot be authenticated for supersession');
      }
      await archiveSourceApproval(paths, existing, uid);
    } else if (existing !== null) {
      if (existing.schemaVersion === 2 && existing.state === 'ISSUED' && approvalMatches(existing, preflight, input) && verifySourceApproval(existing, secret)) return existing;
      const committedMigration = existing.schemaVersion === 2 && existing.state === 'CONSUMED' && verifySourceApproval(existing, secret)
        ? await readSourceMigrationRecord(paths.sourceBindingMigration, uid)
        : null;
      if (committedMigration?.state === 'COMMITTED'
        && committedMigration.approvalId === existing.approvalId
        && committedMigration.requestId === existing.requestId) {
        await archiveSourceApproval(paths, existing, uid);
        supersededExistingApproval = true;
      } else {
        throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'An existing migration approval requires reconciliation before retry');
      }
    }
    let policyTransactionId: string | undefined;
    if (input.recoveryPolicyId !== undefined) {
      const reservation = await reserveRecoveryPolicyOperation({
        dataRoot: canonicalDataRoot,
        policyId: input.recoveryPolicyId,
        operation: 'MIGRATION_APPROVAL',
        requestId: input.requestId,
        sourceSha: input.sourceSha,
        sourceTree: input.sourceTree,
        sourceRoot: preflight.sourceRoot,
        controlScript: preflight.controlScript,
        executable: preflight.executable,
        executableArguments: input.executableArguments,
        runtimePreflightSha256: preflight.runtimePreflightSha256,
        runtimeLoaderSha256: preflight.runtimeLoaderSha256,
        beforeMetadataSha256: preflight.beforeMetadataSha256,
        beforePlistSha256: preflight.beforePlistSha256,
        protectedReferenceRoot: preflight.protectedReferenceRoot,
      });
      policyTransactionId = reservation.transactionId;
    }
    const record: LaunchAgentSourceApprovalRecord = {
      ...input,
      dataRoot: canonicalDataRoot,
      sourceRoot: preflight.sourceRoot,
      controlScript: preflight.controlScript,
      executable: preflight.executable,
      executableArguments: [...input.executableArguments],
      ...(preflight.protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: preflight.protectedReferenceRoot }),
      ...(input.recoveryPolicyId === undefined ? {} : { recoveryPolicyId: input.recoveryPolicyId, recoveryPolicyTransactionId: policyTransactionId! }),
      schemaVersion: 2,
      approvalId: randomUUID(),
      state: 'ISSUED',
      label: LAUNCH_AGENT_LABEL,
      domain: preflight.domain,
      beforeMetadataSha256: preflight.beforeMetadataSha256,
      beforePlistSha256: preflight.beforePlistSha256,
      runtimePreflightSha256: preflight.runtimePreflightSha256,
      runtimeLoaderSha256: preflight.runtimeLoaderSha256,
      issuedAt: new Date().toISOString(),
      signature: '',
    };
    const signed = { ...record, signature: signSourceApproval(record, secret) };
    try {
      if (supersededExistingApproval && existing !== null) {
      await replaceOwnedFile(paths.sourceBindingApproval, approvalContent(existing), approvalContent(signed), 'IRIS source migration approval', uid);
      } else {
        await publishOwnedFile(paths.sourceBindingApproval, approvalContent(signed), 'IRIS source migration approval', uid);
      }
      if (policyTransactionId !== undefined) await finalizeRecoveryPolicyOperation({ dataRoot: canonicalDataRoot, policyId: input.recoveryPolicyId!, operation: 'MIGRATION_APPROVAL', requestId: input.requestId, transactionId: policyTransactionId, state: 'COMMITTED', sourceSha: input.sourceSha, sourceTree: input.sourceTree, sourceRoot: preflight.sourceRoot, controlScript: preflight.controlScript, executable: preflight.executable, executableArguments: input.executableArguments, runtimePreflightSha256: preflight.runtimePreflightSha256, runtimeLoaderSha256: preflight.runtimeLoaderSha256, beforeMetadataSha256: preflight.beforeMetadataSha256, beforePlistSha256: preflight.beforePlistSha256, protectedReferenceRoot: preflight.protectedReferenceRoot });
      return signed;
    } catch (error) {
      if (policyTransactionId !== undefined) await finalizeRecoveryPolicyOperation({ dataRoot: canonicalDataRoot, policyId: input.recoveryPolicyId!, operation: 'MIGRATION_APPROVAL', requestId: input.requestId, transactionId: policyTransactionId, state: 'RECONCILIATION_REQUIRED', sourceSha: input.sourceSha, sourceTree: input.sourceTree, sourceRoot: preflight.sourceRoot, controlScript: preflight.controlScript, executable: preflight.executable, executableArguments: input.executableArguments, runtimePreflightSha256: preflight.runtimePreflightSha256, runtimeLoaderSha256: preflight.runtimeLoaderSha256, beforeMetadataSha256: preflight.beforeMetadataSha256, beforePlistSha256: preflight.beforePlistSha256, protectedReferenceRoot: preflight.protectedReferenceRoot }).catch(() => undefined);
      throw error;
    }
  });
}

/** Revokes one authenticated stale approval without deleting its audit record. */
export async function reconcileLaunchAgentSourceApproval(
  input: LaunchAgentSourceApprovalReconciliationInput,
  dependencies: LaunchdDependencies = {},
): Promise<LaunchAgentSourceApprovalRecord> {
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, async () => {
    validateApprovalReconciliationInput(input);
    const approval = await readSourceApprovalRecord(paths.sourceBindingApproval, uid);
    if (approval === null) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'No migration approval exists to reconcile');
    if (approval.requestId !== input.requestId || approval.sourceSha !== input.sourceSha || approval.sourceTree !== input.sourceTree) {
      throw new RuntimeError('CONTROL_DENIED', 'The requested approval does not match the durable approval record');
    }
    const secret = await readOwnerAccessSecret(canonicalDataRoot);
    if (secret === null || !verifySourceApproval(approval, secret)) throw new RuntimeError('CONTROL_DENIED', 'The durable migration approval failed authentication');
    if (approval.state === 'RECONCILIATION_REQUIRED') return approval;
    if (approval.state !== 'ISSUED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `Migration approval is ${approval.state.toLowerCase()} and cannot be reconciled`);
    const metadata = await inspectOwnedFile(paths.metadata, 'IRIS LaunchAgent metadata', uid);
    const plist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
    if (metadata.state !== 'ok' || plist.state !== 'ok' || sha256(metadata.content) !== approval.beforeMetadataSha256 || sha256(plist.content) !== approval.beforePlistSha256) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Protected before-images changed; approval reconciliation is blocked');
    }
    const reconciled = approval.schemaVersion === 2
      ? { ...approval, state: 'RECONCILIATION_REQUIRED' as const, signature: '' }
      : { ...approval, state: 'RECONCILIATION_REQUIRED' as const };
    const signedReconciled = approval.schemaVersion === 2
      ? { ...reconciled, signature: signSourceApproval(reconciled, secret) }
      : reconciled;
    await replaceOwnedFile(paths.sourceBindingApproval, approvalContent(approval), approvalContent(signedReconciled), 'IRIS source migration approval', uid);
    return signedReconciled;
  });
}

/** Retires one authenticated malformed schema-1 approval without granting migration authority. */
export async function reconcileMalformedLegacyApproval(
  input: MalformedLegacyApprovalReconciliationInput,
  dependencies: LaunchdDependencies = {},
): Promise<MalformedLegacyApprovalReconciliationRecord> {
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, async () => {
    validateMalformedLegacyApprovalInput(input);
    const inspectedApproval = await inspectOwnedFile(paths.sourceBindingApproval, 'IRIS source migration approval', uid);
    if (inspectedApproval.state !== 'ok') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', inspectedApproval.state === 'invalid' ? inspectedApproval.reason : 'No migration approval exists to reconcile');
    const approval = parseSourceApproval(inspectedApproval.content);
    if (approval.schemaVersion !== 1 || approval.approvalId !== input.approvalId || approval.requestId !== input.requestId) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'The malformed approval is not an issued schema-1 record for this request');
    }
    const existing = await readMalformedApprovalRecoveryRecord(paths.sourceBindingApprovalRecovery, uid);
    const sync = dependencies.syncDirectory ?? syncDirectory;
    const approvalSha256 = sha256(inspectedApproval.content);
    if (!/^[a-f0-9]{41}$/.test(approval.sourceSha)) {
      throw new RuntimeError('INVALID_REQUEST', 'The approval is not the expected malformed 41-character legacy record');
    }
    const secret = await readOwnerAccessSecret(canonicalDataRoot);
    if (secret === null || !verifySourceApproval(approval, secret)) throw new RuntimeError('CONTROL_DENIED', 'The malformed migration approval failed authentication');
    const sameTransaction = existing !== null
      && existing.recoveryRequestId === input.recoveryRequestId
      && existing.approvalSha256 === input.approvalSha256
      && existing.approvalId === approval.approvalId;
    const replay = sameTransaction && existing.state === 'COMMITTED';
    const expectedOriginalRaw = existing?.originalApprovalRaw ?? inspectedApproval.content;
    const expectedOriginalSha256 = existing?.approvalSha256 ?? input.approvalSha256;
    if (sha256(expectedOriginalRaw) !== expectedOriginalSha256 || expectedOriginalSha256 !== input.approvalSha256) {
      throw new RuntimeError('CONTROL_DENIED', 'The malformed approval recovery digest is inconsistent');
    }
    const originalApproval = parseSourceApproval(expectedOriginalRaw);
    if (originalApproval.schemaVersion !== 1 || originalApproval.approvalId !== approval.approvalId || originalApproval.requestId !== approval.requestId || !verifySourceApproval(originalApproval, secret)) {
      throw new RuntimeError('CONTROL_DENIED', 'The historical malformed approval failed authentication');
    }
    const expectedReconciled = approvalContent({ ...originalApproval, state: 'RECONCILIATION_REQUIRED' });
    const currentIsOriginal = inspectedApproval.content === expectedOriginalRaw;
    const currentIsReconciled = inspectedApproval.content === expectedReconciled;
    if (!replay && !currentIsOriginal && !currentIsReconciled) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'The malformed approval bytes have an unknown state and require reconciliation');
    }
    if (!replay && currentIsOriginal && approvalSha256 !== input.approvalSha256) throw new RuntimeError('CONTROL_DENIED', 'The malformed approval bytes changed before reconciliation');
    if (currentIsReconciled && !verifySourceApproval(approval, secret)) throw new RuntimeError('CONTROL_DENIED', 'The reconciled approval failed authentication');
    const metadata = await inspectOwnedFile(paths.metadata, 'IRIS LaunchAgent metadata', uid);
    const plist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
    if (metadata.state !== 'ok' || plist.state !== 'ok' || sha256(metadata.content) !== approval.beforeMetadataSha256 || sha256(plist.content) !== approval.beforePlistSha256) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Protected before-images changed; malformed approval reconciliation is blocked');
    }
    const migration = await readSourceMigrationRecord(paths.sourceBindingMigration, uid);
    if (migration !== null) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'An existing source migration requires reconciliation before approval recovery');
    if (replay) {
      if (!currentIsReconciled || existing.finalizedApprovalSha256 !== approvalSha256) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'The malformed approval recovery readback is inconsistent');
      await sync(path.dirname(paths.sourceBindingApproval));
      const readback = await inspectOwnedFile(paths.sourceBindingApproval, 'IRIS source migration approval', uid);
      if (readback.state !== 'ok' || readback.content !== inspectedApproval.content) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'The malformed approval recovery readback is not durable');
      return existing;
    }
    if (existing !== null && (existing.state !== 'PREPARED' && existing.state !== 'APPLYING')) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'An existing malformed approval recovery requires reconciliation before retry');
    }
    if (existing !== null && (existing.recoveryRequestId !== input.recoveryRequestId || existing.approvalSha256 !== input.approvalSha256 || existing.approvalId !== approval.approvalId)) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'An existing malformed approval recovery belongs to a different request');
    }
    if (existing?.state === 'APPLYING' && currentIsReconciled) {
      const committed = { ...existing, state: 'COMMITTED' as const, finalizedApprovalSha256: approvalSha256 };
      if (!await persistMalformedApprovalRecovery(paths, existing, committed, uid, sync)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Malformed approval recovery commit durability is unknown');
      return committed;
    }
    if (!currentIsOriginal || approval.state !== 'ISSUED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `Malformed migration approval is ${approval.state.toLowerCase()} and cannot be reconciled`);
    const prepared: MalformedLegacyApprovalReconciliationRecord = existing ?? {
      schemaVersion: 1,
      transactionId: randomUUID(),
      recoveryRequestId: input.recoveryRequestId,
      approvalId: approval.approvalId,
      requestId: approval.requestId,
      state: 'PREPARED',
      label: LAUNCH_AGENT_LABEL,
      domain: approval.domain,
      dataRoot: canonicalDataRoot,
      approvalSha256,
      originalApprovalRaw: inspectedApproval.content,
      sourceSha: approval.sourceSha,
      sourceTree: approval.sourceTree,
      beforeMetadataSha256: approval.beforeMetadataSha256,
      beforePlistSha256: approval.beforePlistSha256,
    };
    if (existing === null) await publishOwnedFile(paths.sourceBindingApprovalRecovery, malformedApprovalRecoveryContent(prepared), 'IRIS malformed approval recovery', uid, sync);
    const applying = prepared.state === 'APPLYING' ? prepared : { ...prepared, state: 'APPLYING' as const };
    if (prepared.state !== 'APPLYING') await replaceOwnedFile(paths.sourceBindingApprovalRecovery, malformedApprovalRecoveryContent(prepared), malformedApprovalRecoveryContent(applying), 'IRIS malformed approval recovery', uid, sync);
    const reconciled = { ...originalApproval, state: 'RECONCILIATION_REQUIRED' as const };
    const reconciledContent = approvalContent(reconciled);
    try {
      await replaceOwnedFile(paths.sourceBindingApproval, inspectedApproval.content, reconciledContent, 'IRIS source migration approval', uid, sync);
    } catch (error) {
      const readback = await inspectOwnedFile(paths.sourceBindingApproval, 'IRIS source migration approval', uid);
      const recoveryState = readback.state === 'ok' && readback.content === inspectedApproval.content
        ? 'FAILED' as const
        : readback.state === 'ok' && readback.content === reconciledContent
          ? 'COMMITTED' as const
          : 'RECONCILIATION_REQUIRED' as const;
      try { await sync(path.dirname(paths.sourceBindingApproval)); } catch { throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Malformed approval retirement durability is unknown', { cause: error }); }
      const recovered = { ...applying, state: recoveryState, ...(recoveryState === 'COMMITTED' ? { finalizedApprovalSha256: sha256(reconciledContent) } : {}) };
      if (!await persistMalformedApprovalRecovery(paths, applying, recovered, uid, sync)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Malformed approval recovery durability is unknown', { cause: error });
      if (recoveryState === 'COMMITTED') return recovered;
      throw error;
    }
    const committed = { ...applying, state: 'COMMITTED' as const, finalizedApprovalSha256: sha256(reconciledContent) };
    if (!await persistMalformedApprovalRecovery(paths, applying, committed, uid, sync)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Malformed approval recovery commit durability is unknown');
    return committed;
  });
}

/**
 * Rebinds a stopped schema-1 LaunchAgent to a reviewed control source without
 * loading the service. Bootstrap remains an explicit, separate operation.
 */
export async function migrateLaunchAgentSource(
  input: LaunchAgentSourceMigrationInput,
  dependencies: LaunchdDependencies = {},
): Promise<LaunchAgentSourceMigrationRecord> {
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, () => migrateLaunchAgentSourceUnlocked(input, dependencies));
}

/** Unloads only the verified Supervisor while preserving the Schema-3 binding for source migration. */
export async function stopLaunchAgentForMigration(
  input: LaunchAgentStopForMigrationInput,
  dependencies: LaunchdDependencies = {},
): Promise<{ readonly state: 'STOPPED'; readonly processId?: number }> {
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, () => stopLaunchAgentForMigrationUnlocked({ ...input, dataRoot: canonicalDataRoot }, dependencies));
}

/** Stops only the Owner-authorized GUI service target; uncertainty is journaled and never retried. */
export async function stopLoadedLaunchAgentByServiceTarget(
  input: LaunchAgentServiceTargetStopInput,
  ownerConfirmation: string,
  dependencies: LaunchdDependencies = {},
): Promise<{ readonly state: 'STOPPED'; readonly transactionId: string }> {
  if (ownerConfirmation !== 'STOP IRIS SUPERVISOR SERVICE TARGET') throw new RuntimeError('CONTROL_DENIED', 'Explicit Owner service-target stop confirmation is required');
  const uid = launchdUid(dependencies);
  const domain = launchdDomain(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, async () => {
    const policy = await readRecoveryAuthorizationPolicy(canonicalDataRoot);
    if (policy === null || policy.policyId !== input.recoveryPolicyId || policy.state !== 'ISSUED' || Date.parse(policy.expiresAt) <= Date.now()
      || policy.allowedOperations.length !== 1 || policy.allowedOperations[0] !== 'SUPERVISOR_SERVICE_TARGET_STOP' || policy.maxOperationCount !== 1
      || policy.machineId === undefined || policy.machineId === null || policy.recordedSourceRoot === undefined || policy.recordedSourceSha === undefined || policy.recordedSourceTree === undefined
      || policy.serviceTarget === undefined || policy.serviceTarget.uid !== uid || policy.serviceTarget.domain !== domain || policy.serviceTarget.label !== LAUNCH_AGENT_LABEL
      || policy.sourceBindings.length !== 1 || policy.beforeMetadataSha256 === null || policy.beforePlistSha256 === null) {
      throw new RuntimeError('CONTROL_DENIED', 'Service-target stop policy is missing, expired, or not bound to this Owner and service');
    }
    const machineId = await readMachineId(canonicalDataRoot);
    if (machineId === null || machineId !== policy.machineId) throw new RuntimeError('CONTROL_DENIED', 'Service-target stop machine identity does not match');
    const binding = policy.sourceBindings[0]!;
    const operation: RecoveryPolicyOperationInput = {
      dataRoot: canonicalDataRoot,
      policyId: policy.policyId,
      operation: 'SUPERVISOR_SERVICE_TARGET_STOP',
      requestId: input.requestId,
      ...binding,
      beforeMetadataSha256: policy.beforeMetadataSha256,
      beforePlistSha256: policy.beforePlistSha256,
      recordedSourceRoot: policy.recordedSourceRoot,
      recordedSourceSha: policy.recordedSourceSha,
      recordedSourceTree: policy.recordedSourceTree,
      serviceTarget: policy.serviceTarget,
      machineId,
      ...(policy.protectedReferenceRoot === null ? {} : { protectedReferenceRoot: policy.protectedReferenceRoot }),
    };
    const prior = policy.operations.find((entry) => entry.operation === operation.operation && entry.requestId === operation.requestId);
    if (prior !== undefined) {
      const journal = await readRecoveryPolicyOperation({ ...operation, transactionId: prior.transactionId });
      if (journal.state !== 'COMMITTED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Service-target stop is already reserved, failed, or unresolved; it must not be replayed');
      if ((await observeLaunchAgentOnce(dependencies)).state !== 'ABSENT') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Committed service-target stop is not currently absent');
      return { state: 'STOPPED', transactionId: prior.transactionId };
    }

    const disabledBefore = await verifyServiceTargetStopPreflight(operation, policy, paths, uid, domain, dependencies);
    if (disabledBefore === 'UNKNOWN') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Service disabled state is unknown');
    const reservedOperation = { ...operation, serviceDisabledStateBefore: disabledBefore };
    const reservation = await reserveRecoveryPolicyOperation(reservedOperation);
    try {
      const disabledImmediatelyBefore = await verifyServiceTargetStopPreflight(operation, policy, paths, uid, domain, dependencies);
      if (disabledImmediatelyBefore !== disabledBefore) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Service disabled state changed before stop invocation');
      const currentPolicy = await readRecoveryAuthorizationPolicy(canonicalDataRoot);
      if (currentPolicy?.policyId !== policy.policyId || currentPolicy.state !== 'ISSUED' || Date.parse(currentPolicy.expiresAt) <= Date.now()) {
        throw new RuntimeError('CONTROL_DENIED', 'Service-target stop authorization expired before invocation');
      }
    } catch (error) {
      await finalizeRecoveryPolicyOperation({ ...reservedOperation, transactionId: reservation.transactionId, state: 'FAILED' });
      throw error;
    }

    // This durable marker is written before launchctl; a crash after it can never replay bootout.
    await finalizeRecoveryPolicyOperation({ ...reservedOperation, transactionId: reservation.transactionId, state: 'RECONCILIATION_REQUIRED' });
    const launchctl = dependencies.launchctl ?? systemLaunchctl;
    try {
      await launchctl(['bootout', '--wait', `${domain}/${LAUNCH_AGENT_LABEL}`]);
      const completionInput = { ...reservedOperation, transactionId: reservation.transactionId };
      serviceTargetStopCompletions.set(reservation.transactionId, {
        identity: serviceTargetStopIdentity(completionInput),
        disabledBefore,
        dependencies,
      });
      try { await finalizeVerifiedServiceTargetStop(completionInput); }
      finally { serviceTargetStopCompletions.delete(reservation.transactionId); }
      return { state: 'STOPPED', transactionId: reservation.transactionId };
    } catch (error) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Service-target stop outcome requires reconciliation; do not retry the stop', { cause: error });
    }
  });
}

/** Called by recovery-policy only; the private completion context exists only after bootout returns successfully. */
export async function verifyServiceTargetStopCompletion(
  input: RecoveryPolicyOperationInput & { readonly transactionId: string },
): Promise<void> {
  const context = serviceTargetStopCompletions.get(input.transactionId);
  if (input.operation !== 'SUPERVISOR_SERVICE_TARGET_STOP' || context === undefined || context.disabledBefore !== input.serviceDisabledStateBefore || context.identity !== serviceTargetStopIdentity(input)) {
    throw new RuntimeError('CONTROL_DENIED', 'No trusted service-target stop completion is active');
  }
  const uid = launchdUid(context.dependencies);
  const domain = launchdDomain(context.dependencies);
  if (input.machineId === undefined || input.serviceTarget?.uid !== uid || input.serviceTarget.domain !== domain || input.serviceTarget.label !== LAUNCH_AGENT_LABEL) {
    throw new RuntimeError('CONTROL_DENIED', 'Verified service-target stop identity changed');
  }
  const paths = launchdPaths(input.dataRoot, context.dependencies.homeDirectory ?? os.homedir());
  const launchctl = context.dependencies.launchctl ?? systemLaunchctl;
  const after = await observeLaunchAgentOnce(context.dependencies);
  const disabledAfter = await observeDisabledState(domain, launchctl);
  if (after.state !== 'ABSENT' || disabledAfter === 'UNKNOWN' || disabledAfter !== context.disabledBefore) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Service-target stop postconditions are not verified');
  }
  await verifyStoppedMetadataProcess(input, paths, uid, context.dependencies);
  const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  const registeredPlist = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if (privatePlist.state !== 'ok' || registeredPlist.state !== 'ok' || privatePlist.content !== registeredPlist.content
    || sha256(privatePlist.content) !== input.beforePlistSha256) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent plist changed during service-target stop');
  await removeOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if ((await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid)).state !== 'missing') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Registered LaunchAgent removal requires reconciliation');
  }
}

/** Owner-confirmed current-state resolution; it never replays or commits the historical bootout. */
export async function resolveUnknownLaunchAgentServiceTargetStopForMaintenance(
  input: ServiceTargetStopMaintenanceResolutionInput,
  ownerConfirmation: string,
  dependencies: LaunchdDependencies = {},
): Promise<{ readonly state: 'MAINTENANCE_READY'; readonly transactionId: string }> {
  if (ownerConfirmation !== 'RESOLVE IRIS SERVICE-TARGET STOP FOR MAINTENANCE') throw new RuntimeError('CONTROL_DENIED', 'Fresh Owner maintenance confirmation is required');
  const uid = launchdUid(dependencies);
  const domain = launchdDomain(dependencies);
  const dataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(dataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, async () => {
    const policy = await readRecoveryAuthorizationPolicy(dataRoot);
    if (policy === null || policy.policyId !== input.recoveryPolicyId || policy.serviceTarget?.uid !== uid || policy.serviceTarget.domain !== domain || policy.serviceTarget.label !== LAUNCH_AGENT_LABEL
      || policy.machineId === undefined || policy.machineId === null || await readMachineId(dataRoot) !== policy.machineId) throw new RuntimeError('CONTROL_DENIED', 'Maintenance resolution policy is not bound to this machine and service');
    const existing = policy.operations.find((entry) => entry.operation === 'SUPERVISOR_SERVICE_TARGET_STOP' && entry.requestId === input.requestId && entry.transactionId === input.transactionId);
    if (existing === undefined || existing.state !== 'RECONCILIATION_REQUIRED' || existing.serviceDisabledStateBefore === undefined || existing.serviceTargetMaintenanceResolution !== undefined) throw new RuntimeError('CONTROL_DENIED', 'Only an unacknowledged exact unresolved service-target stop can be maintenance-resolved');
    const operation = serviceTargetStopOperationFromJournal(dataRoot, policy.policyId, existing);
    await verifyServiceTargetStopMaintenanceState(operation, existing, paths, uid, domain, dependencies, false);
    const registered = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
    if (registered.state === 'ok') await removeOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
    else if (registered.state !== 'missing') throw new RuntimeError('CONTROL_DENIED', 'Registered LaunchAgent plist is invalid or inaccessible');
    serviceTargetStopMaintenanceDependencies.set(input.transactionId, dependencies);
    try { await recordUnknownStopMaintenanceResolution(operation, ownerConfirmation); }
    finally { serviceTargetStopMaintenanceDependencies.delete(input.transactionId); }
    const resolved = await readRecoveryAuthorizationPolicy(dataRoot);
    if (!resolved?.operations.some((entry) => entry.transactionId === input.transactionId && entry.state === 'RECONCILIATION_REQUIRED' && entry.serviceTargetMaintenanceResolution !== undefined)) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Maintenance resolution receipt was not durable');
    }
    return { state: 'MAINTENANCE_READY', transactionId: input.transactionId };
  });
}

/** Trusted read-only proof consumed by the signed policy journal; operation state remains unresolved. */
export async function verifyServiceTargetStopMaintenanceResolution(
  input: RecoveryPolicyOperationInput & { readonly transactionId: string },
  existing: RecoveryPolicyOperationJournal,
): Promise<Omit<NonNullable<RecoveryPolicyOperationJournal['serviceTargetMaintenanceResolution']>, 'observationSha256' | 'resolvedAt'>> {
  if (input.operation !== 'SUPERVISOR_SERVICE_TARGET_STOP' || existing.operation !== input.operation || existing.transactionId !== input.transactionId
    || existing.requestId !== input.requestId || existing.state !== 'RECONCILIATION_REQUIRED' || existing.serviceDisabledStateBefore === undefined
    || input.serviceDisabledStateBefore !== existing.serviceDisabledStateBefore) throw new RuntimeError('CONTROL_DENIED', 'Maintenance resolution is not bound to the unresolved stop record');
  const dependencies = serviceTargetStopMaintenanceDependencies.get(input.transactionId) ?? {};
  const uid = launchdUid(dependencies);
  const domain = launchdDomain(dependencies);
  const paths = launchdPaths(input.dataRoot, dependencies.homeDirectory ?? os.homedir());
  await verifyServiceTargetStopMaintenanceState(input, existing, paths, uid, domain, dependencies, true);
  return {
    serviceState: 'ABSENT',
    registeredPlistState: 'MISSING',
    processState: 'DEAD',
    metadataSha256: existing.beforeMetadataSha256!,
    privatePlistSha256: existing.beforePlistSha256!,
    disabledStateBefore: existing.serviceDisabledStateBefore,
    disabledStateAfter: existing.serviceDisabledStateBefore,
  };
}

/** Reconciles a verified-absent Supervisor without issuing another bootout. */
export async function reconcileStoppedLaunchAgent(
  input: LaunchAgentStopReconciliationInput,
  dependencies: LaunchdDependencies = {},
): Promise<{ readonly state: 'READY' }> {
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, () => reconcileStoppedLaunchAgentUnlocked({ ...input, dataRoot: canonicalDataRoot }, dependencies));
}

/** Records a narrowly authorized no-PID observation; it never disables or unloads launchd. */
export async function recordLoadedNoPidRecovery(
  input: LaunchAgentNoPidRecoveryInput,
  dependencies: LaunchdDependencies = {},
): Promise<{ readonly state: 'RECONCILIATION_REQUIRED'; readonly transactionId: string; readonly disposition: NoPidRecoveryDisposition }> {
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, () => recordLoadedNoPidRecoveryUnlocked({ ...input, dataRoot: canonicalDataRoot }, dependencies));
}

/** Closes only the evidence dead-end after Owner confirmation and a fresh read-only ABSENT observation. */
export async function acknowledgeLoadedNoPidRecovery(
  input: RecoveryPolicyOperationInput & { readonly transactionId: string },
  ownerConfirmation: string,
  dependencies: LaunchdDependencies = {},
): Promise<{ readonly state: 'ACKNOWLEDGED'; readonly transactionId: string; readonly serviceState: 'ABSENT' }> {
  if (input.operation !== 'SUPERVISOR_NO_PID_RECOVERY' || !['ACKNOWLEDGE IRIS NO-PID OBSERVATION', 'ACKNOWLEDGE EXPIRED IRIS NO-PID OBSERVATION'].includes(ownerConfirmation)) throw new RuntimeError('CONTROL_DENIED', 'Explicit Owner acknowledgement is required for no-PID evidence');
  const uid = launchdUid(dependencies);
  const domain = launchdDomain(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, async () => {
    await requireGuiDomain(domain, dependencies.launchctl ?? systemLaunchctl);
    const policy = await readRecoveryAuthorizationPolicy(canonicalDataRoot);
    const requiredConfirmation = policy?.state === 'EXPIRED' ? 'ACKNOWLEDGE EXPIRED IRIS NO-PID OBSERVATION' : 'ACKNOWLEDGE IRIS NO-PID OBSERVATION';
    if (policy?.policyId !== input.policyId || ownerConfirmation !== requiredConfirmation) throw new RuntimeError('CONTROL_DENIED', 'Fresh Owner authorization does not match the current no-PID policy state');
    const observed = await recordLoadedNoPidRecoveryUnlocked({ dataRoot: canonicalDataRoot, recoveryPolicyId: input.policyId, requestId: input.requestId }, dependencies, policy.state === 'EXPIRED');
    if (observed.transactionId !== input.transactionId) throw new RuntimeError('CONTROL_DENIED', 'No-PID recovery transaction identity changed');
    const journal = await readRecoveryPolicyOperation({ ...input, dataRoot: canonicalDataRoot });
    if (journal.state !== 'RECONCILIATION_REQUIRED' || journal.ownerAcknowledgement !== undefined) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'No-PID recovery evidence is not pending Owner acknowledgement');
    if ((await observeLaunchAgent(dependencies)).state !== 'ABSENT') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'A fresh launchd observation must verify ABSENT before resolving no-PID evidence');
    await acknowledgeNoPidRecoveryObservation({ ...input, dataRoot: canonicalDataRoot, ...(journal.recoveryDisposition === undefined ? {} : { recoveryDisposition: journal.recoveryDisposition }) }, { serviceState: 'ABSENT', domain, label: LAUNCH_AGENT_LABEL, ownerConfirmation });
    return { state: 'ACKNOWLEDGED', transactionId: input.transactionId, serviceState: 'ABSENT' };
  });
}

async function recordLoadedNoPidRecoveryUnlocked(
  input: LaunchAgentNoPidRecoveryInput,
  dependencies: LaunchdDependencies,
  allowExpiredForExistingEvidence = false,
): Promise<{ readonly state: 'RECONCILIATION_REQUIRED'; readonly transactionId: string; readonly disposition: NoPidRecoveryDisposition }> {
  const uid = launchdUid(dependencies);
  const domain = launchdDomain(dependencies);
  await requireGuiDomain(domain, dependencies.launchctl ?? systemLaunchctl);
  const paths = launchdPaths(input.dataRoot, dependencies.homeDirectory ?? os.homedir());
  const policy = await readRecoveryAuthorizationPolicy(input.dataRoot);
  if (policy === null || policy.policyId !== input.recoveryPolicyId || policy.state !== 'ISSUED' && !(allowExpiredForExistingEvidence && policy.state === 'EXPIRED')
    || policy.allowedOperations.length !== 1 || policy.allowedOperations[0] !== 'SUPERVISOR_NO_PID_RECOVERY'
    || policy.maxOperationCount !== 1 || policy.machineId === undefined || policy.machineId === null || policy.recordedSourceRoot === undefined
    || policy.sourceBindings.length !== 1 || policy.beforeMetadataSha256 === null || policy.beforePlistSha256 === null) {
    throw new RuntimeError('CONTROL_DENIED', 'Loaded/no-PID recovery policy is missing or not narrowly bound');
  }
  const binding = policy.sourceBindings[0]!;
  const machineId = await readMachineId(input.dataRoot);
  if (machineId === null || machineId !== policy.machineId || domain !== `gui/${uid}`) {
    throw new RuntimeError('CONTROL_DENIED', 'Loaded/no-PID recovery machine or Owner identity does not match');
  }
  if (policy.recordedSourceRoot !== path.normalize(policy.recordedSourceRoot)) {
    throw new RuntimeError('CONTROL_DENIED', 'Recorded historical source path is not canonical');
  }
  const metadataRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  if (metadataRecord === null || metadataRecord.metadata.schemaVersion !== 3 || metadataRecord.metadata.state !== 'READY') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Loaded/no-PID recovery requires ready Schema-3 ownership metadata');
  }
  const metadata = metadataRecord.metadata;
  if (sha256(metadataRecord.raw) !== policy.beforeMetadataSha256 || metadata.sourceRoot !== policy.recordedSourceRoot
    || metadata.domain !== domain || metadata.label !== LAUNCH_AGENT_LABEL || metadata.dataRoot !== input.dataRoot
    || metadata.plist !== paths.plist || metadata.registeredPlist !== paths.registeredPlist) {
    throw new RuntimeError('CONTROL_DENIED', 'Loaded/no-PID recovery metadata binding does not match');
  }
  await requireMissingPhysicalPath(policy.recordedSourceRoot);
  const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  const registeredPlist = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if (privatePlist.state !== 'ok' || registeredPlist.state !== 'ok'
    || privatePlist.content !== registeredPlist.content
    || sha256(privatePlist.content) !== policy.beforePlistSha256
    || metadata.plistSha256 !== policy.beforePlistSha256) {
    throw new RuntimeError('CONTROL_DENIED', 'Loaded/no-PID recovery requires matching private and registered plist before-images');
  }
  const canonicalSourceRoot = await requireCanonicalDirectory(binding.sourceRoot, 'IRIS recovery target source root', uid, false);
  const canonicalControlScript = await requireCanonicalFile(binding.controlScript, 'IRIS recovery target control script', uid);
  if (canonicalSourceRoot !== binding.sourceRoot || sourceRootForControlScript(canonicalControlScript) !== canonicalSourceRoot) {
    throw new RuntimeError('CONTROL_DENIED', 'Loaded/no-PID recovery target source identity does not match');
  }
  const executable = await realpath(binding.executable);
  if (executable !== binding.executable || executable !== await realpath(canonicalNodeRuntime().path) || binding.executableSha256 !== await hashCanonicalFile(executable, 'IRIS recovery target executable', uid)) {
    throw new RuntimeError('CONTROL_DENIED', 'Loaded/no-PID recovery executable identity does not match');
  }
  const runtimeEntrypoints = await requireTargetRuntimeEntries(binding.executableArguments, uid);
  if (runtimeEntrypoints.runtimePreflightSha256 !== binding.runtimePreflightSha256 || runtimeEntrypoints.runtimeLoaderSha256 !== binding.runtimeLoaderSha256) {
    throw new RuntimeError('CONTROL_DENIED', 'Loaded/no-PID recovery runtime entrypoint identity does not match');
  }
  await requireSourceGitIdentity(canonicalSourceRoot, binding.sourceSha, binding.sourceTree);
  const operation: RecoveryPolicyOperationInput = {
    dataRoot: input.dataRoot,
    policyId: policy.policyId,
    operation: 'SUPERVISOR_NO_PID_RECOVERY',
    requestId: input.requestId,
    sourceSha: binding.sourceSha,
    sourceTree: binding.sourceTree,
    sourceRoot: binding.sourceRoot,
    recordedSourceRoot: policy.recordedSourceRoot,
    controlScript: binding.controlScript,
    executable: binding.executable,
    executableSha256: binding.executableSha256,
    executableArguments: binding.executableArguments,
    runtimePreflightSha256: binding.runtimePreflightSha256,
    runtimeLoaderSha256: binding.runtimeLoaderSha256,
    beforeMetadataSha256: policy.beforeMetadataSha256,
    beforePlistSha256: policy.beforePlistSha256,
    machineId,
  };
  const existing = policy.operations.find((entry) => entry.requestId === input.requestId && entry.operation === operation.operation);
  if (existing !== undefined) {
    const verified = await readRecoveryPolicyOperation({ ...operation, transactionId: existing.transactionId });
    if (verified.state === 'RECONCILIATION_REQUIRED' && verified.recoveryDisposition !== undefined) {
      return { state: 'RECONCILIATION_REQUIRED', transactionId: verified.transactionId, disposition: verified.recoveryDisposition };
    }
    if (verified.state !== 'RESERVED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Loaded/no-PID recovery request is already terminal');
  }
  if (policy.state === 'EXPIRED') throw new RuntimeError('CONTROL_DENIED', 'Expired recovery authority cannot create a no-PID operation');
  const disposition = await classifyNoPidRecoveryObservation(metadata, dependencies);
  const reservation = await reserveRecoveryPolicyOperation(operation);
  await finalizeRecoveryPolicyOperation({ ...operation, transactionId: reservation.transactionId, state: 'RECONCILIATION_REQUIRED', recoveryDisposition: disposition });
  return { state: 'RECONCILIATION_REQUIRED', transactionId: reservation.transactionId, disposition };
}

async function classifyNoPidRecoveryObservation(metadata: LaunchAgentMetadata, dependencies: LaunchdDependencies): Promise<NoPidRecoveryDisposition> {
  let observation: LaunchAgentObservation;
  try { observation = await observeLaunchAgent(dependencies); }
  catch { return 'OBSERVATION_UNKNOWN'; }
  if (observation.state === 'ABSENT') return 'ABSENT';
  const lines = observation.stdout.split(/\r?\n/);
  if (!lines.some((line) => line.trim() === `${metadata.domain}/${metadata.label} = {`)) return 'IDENTITY_CONFLICT';
  const registeredPlist = launchctlScalar(lines, 'path');
  const executable = launchctlScalar(lines, 'program');
  const workingDirectory = launchctlScalar(lines, 'working directory');
  const dataRoot = launchctlMapping(lines, 'environment', RUNTIME_DATA_ENV);
  const argumentsList = launchctlList(lines, 'arguments');
  const expectedArguments = [metadata.executable, ...metadata.executableArguments, metadata.controlScript, 'supervisor'];
  if (registeredPlist === null || executable === null || workingDirectory === null || dataRoot === null || argumentsList === null) return 'OBSERVATION_UNKNOWN';
  if (registeredPlist !== metadata.registeredPlist || executable !== metadata.executable || workingDirectory !== metadata.sourceRoot
    || dataRoot !== metadata.dataRoot || argumentsList.length !== expectedArguments.length
    || argumentsList.some((argument, index) => argument !== expectedArguments[index])) return 'IDENTITY_CONFLICT';
  const pidLines = lines.map((line) => line.trim()).filter((line) => /^pid\b/.test(line));
  if (pidLines.length === 0) return 'LOADED_NO_VERIFIED_PID';
  if (pidLines.length !== 1 || !/^pid = [1-9]\d*$/.test(pidLines[0]!)) return 'OBSERVATION_UNKNOWN';
  const pid = Number(pidLines[0]!.slice('pid = '.length));
  const start = (dependencies.observeProcessStart ?? observeProcessStart)(pid);
  if (start.state !== 'live') return 'OBSERVATION_UNKNOWN';
  const actualExecutable = (dependencies.observeProcessExecutable ?? observeProcessExecutable)(pid);
  const ownerUid = (dependencies.observeProcessOwnerUid ?? observeProcessOwnerUid)(pid);
  return actualExecutable === metadata.executable
    && ownerUid === Number(metadata.domain.slice('gui/'.length))
    && metadata.processId === pid
    && metadata.processStartMarker === start.marker
    ? 'LOADED_WITH_VERIFIED_LIVE_PROCESS'
    : 'IDENTITY_CONFLICT';
}

async function requireMissingPhysicalPath(filename: string): Promise<void> {
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) throw new RuntimeError('CONTROL_DENIED', 'Recorded historical source path is not canonical');
  const parsed = path.parse(filename);
  let current = parsed.root;
  for (const segment of filename.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stats;
    try { stats = await lstat(current); }
    catch (error) {
      if (isNotFound(error)) return;
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Recorded historical source path cannot be safely inspected', { cause: error });
    }
    if (stats.isSymbolicLink()) throw new RuntimeError('CONTROL_DENIED', 'Recorded historical source path contains a symlink');
    if (!stats.isDirectory()) throw new RuntimeError('CONTROL_DENIED', 'Recorded historical source path has a non-directory parent');
  }
  throw new RuntimeError('CONTROL_DENIED', 'Historical source path is not missing; recovery record is not applicable');
}

async function verifyServiceTargetStopPreflight(
  operation: RecoveryPolicyOperationInput,
  policy: RecoveryPolicyPublicRecord,
  paths: LaunchdPaths,
  uid: number,
  domain: string,
  dependencies: LaunchdDependencies,
): Promise<DisabledState> {
  const binding = policy.sourceBindings[0]!;
  const sourceRoot = await requireCanonicalDirectory(binding.sourceRoot, 'Authorized control source root', uid, false);
  const executingSourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const controlScript = await requireCanonicalFile(binding.controlScript, 'Authorized control script', uid);
  if (sourceRoot !== executingSourceRoot || sourceRootForControlScript(controlScript) !== sourceRoot) throw new RuntimeError('CONTROL_DENIED', 'Service-target stop must run from its exact authorized source release');
  await requireSourceGitIdentity(sourceRoot, binding.sourceSha, binding.sourceTree);
  const executable = await realpath(binding.executable).catch((error) => { throw new RuntimeError('CONTROL_DENIED', 'Authorized Node executable cannot be resolved', { cause: error }); });
  if (executable !== await realpath(canonicalNodeRuntime().path) || binding.executableSha256 === undefined || await hashCanonicalFile(executable, 'Authorized Node executable', uid) !== binding.executableSha256) throw new RuntimeError('CONTROL_DENIED', 'Authorized Node executable identity changed');
  const runtime = await resolveReviewedRuntimeEntrypoints(path.join(sourceRoot, 'apps', 'runtime'));
  const expectedArguments = ['--require', runtime.preflight, '--import', pathToFileURL(runtime.loader).href];
  const runtimeDigests = await requireTargetRuntimeEntries(binding.executableArguments, uid);
  if (JSON.stringify(binding.executableArguments) !== JSON.stringify(expectedArguments)
    || runtimeDigests.runtimePreflightSha256 !== binding.runtimePreflightSha256 || runtimeDigests.runtimeLoaderSha256 !== binding.runtimeLoaderSha256) throw new RuntimeError('CONTROL_DENIED', 'Authorized Runtime entrypoint identity changed');
  const machineId = await readMachineId(operation.dataRoot);
  if (machineId === null || machineId !== operation.machineId || policy.serviceTarget?.uid !== uid || policy.serviceTarget.domain !== domain || policy.serviceTarget.label !== LAUNCH_AGENT_LABEL) throw new RuntimeError('CONTROL_DENIED', 'Authorized machine or service target changed');

  await requireMissingPhysicalPath(operation.recordedSourceRoot!);
  const migration = await readSourceMigrationRecord(paths.sourceBindingMigration, uid);
  if (migration === null || migration.state !== 'COMMITTED' || migration.dataRoot !== operation.dataRoot || migration.domain !== domain || migration.label !== LAUNCH_AGENT_LABEL
    || migration.targetSourceRoot !== operation.recordedSourceRoot || migration.targetSourceSha !== operation.recordedSourceSha || migration.targetSourceTree !== operation.recordedSourceTree) throw new RuntimeError('CONTROL_DENIED', 'Historical source identity is not backed by the committed migration record');

  const metadataRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  const metadata = metadataRecord?.metadata;
  if (metadataRecord === null || metadata === undefined || metadata.schemaVersion !== 3 || metadata.state !== 'READY'
    || metadata.dataRoot !== operation.dataRoot || metadata.domain !== domain || metadata.label !== LAUNCH_AGENT_LABEL
    || metadata.sourceRoot !== operation.recordedSourceRoot || metadata.plist !== paths.plist || metadata.registeredPlist !== paths.registeredPlist
    || sha256(metadataRecord.raw) !== operation.beforeMetadataSha256) throw new RuntimeError('CONTROL_DENIED', 'LaunchAgent metadata before-image or service identity changed');
  const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  const registeredPlist = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if (privatePlist.state !== 'ok' || registeredPlist.state !== 'ok' || privatePlist.content !== registeredPlist.content
    || sha256(privatePlist.content) !== operation.beforePlistSha256 || metadata.plistSha256 !== operation.beforePlistSha256) throw new RuntimeError('CONTROL_DENIED', 'Private and registered LaunchAgent before-images changed');

  await requireGuiDomain(domain, dependencies.launchctl ?? systemLaunchctl);
  const observed = await observeLaunchAgentOnce(dependencies);
  if (observed.state !== 'LOADED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Service-target stop requires a currently loaded exact service target');
  requireLoadedNoPidLaunchAgentIdentity(observed.stdout, metadata);
  if ((metadata.processId === undefined) !== (metadata.processStartMarker === undefined)) throw new RuntimeError('CONTROL_DENIED', 'Stored Supervisor process identity is incomplete');
  if (metadata.processId !== undefined) {
    const process = (dependencies.observeProcessStart ?? observeProcessStart)(metadata.processId);
    if (process.state !== 'dead') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Stored Supervisor PID is live or ambiguous; use the verified live-process stop path');
  }
  const disabled = await observeDisabledState(domain, dependencies.launchctl ?? systemLaunchctl);
  if (disabled === 'UNKNOWN') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor disabled state is unknown');
  return disabled;
}

async function verifyStoppedMetadataProcess(
  operation: RecoveryPolicyOperationInput,
  paths: LaunchdPaths,
  uid: number,
  dependencies: LaunchdDependencies,
): Promise<void> {
  const metadataRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  if (metadataRecord === null || metadataRecord.metadata.schemaVersion !== 3 || sha256(metadataRecord.raw) !== operation.beforeMetadataSha256) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent metadata changed during service-target stop');
  const metadata = metadataRecord.metadata;
  if (metadata.processId !== undefined && metadata.processStartMarker !== undefined) {
    const process = (dependencies.observeProcessStart ?? observeProcessStart)(metadata.processId);
    if (process.state !== 'dead') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Original Supervisor process identity is not proven dead after service-target stop');
  }
}

function serviceTargetStopIdentity(input: RecoveryPolicyOperationInput & { readonly transactionId: string }): string {
  return JSON.stringify([
    input.dataRoot, input.policyId, input.operation, input.requestId, input.transactionId,
    input.sourceSha, input.sourceTree, input.sourceRoot, input.controlScript, input.executable,
    input.executableSha256 ?? null, input.executableArguments, input.runtimePreflightSha256, input.runtimeLoaderSha256,
    input.beforeMetadataSha256, input.beforePlistSha256, input.recordedSourceRoot ?? null,
    input.recordedSourceSha ?? null, input.recordedSourceTree ?? null,
    input.serviceTarget?.uid ?? null, input.serviceTarget?.domain ?? null, input.serviceTarget?.label ?? null,
    input.machineId ?? null, input.protectedReferenceRoot ?? null,
    input.serviceDisabledStateBefore ?? null,
  ]);
}

function serviceTargetStopOperationFromJournal(dataRoot: string, policyId: string, entry: RecoveryPolicyOperationJournal): RecoveryPolicyOperationInput & { readonly transactionId: string } {
  return {
    dataRoot, policyId, operation: entry.operation, requestId: entry.requestId, transactionId: entry.transactionId,
    sourceSha: entry.sourceSha, sourceTree: entry.sourceTree, sourceRoot: entry.sourceRoot, controlScript: entry.controlScript,
    executable: entry.executable, ...(entry.executableSha256 == null ? {} : { executableSha256: entry.executableSha256 }),
    executableArguments: entry.executableArguments, runtimePreflightSha256: entry.runtimePreflightSha256,
    runtimeLoaderSha256: entry.runtimeLoaderSha256, beforeMetadataSha256: entry.beforeMetadataSha256,
    beforePlistSha256: entry.beforePlistSha256,
    ...(entry.recordedSourceRoot === undefined ? {} : { recordedSourceRoot: entry.recordedSourceRoot }),
    ...(entry.recordedSourceSha === undefined ? {} : { recordedSourceSha: entry.recordedSourceSha }),
    ...(entry.recordedSourceTree === undefined ? {} : { recordedSourceTree: entry.recordedSourceTree }),
    ...(entry.serviceTarget === undefined ? {} : { serviceTarget: entry.serviceTarget }),
    ...(entry.serviceDisabledStateBefore === undefined ? {} : { serviceDisabledStateBefore: entry.serviceDisabledStateBefore }),
    machineId: entry.machineId ?? undefined, protectedReferenceRoot: entry.protectedReferenceRoot ?? undefined,
  };
}

async function verifyServiceTargetStopMaintenanceState(
  input: RecoveryPolicyOperationInput & { readonly transactionId: string },
  existing: RecoveryPolicyOperationJournal,
  paths: LaunchdPaths,
  uid: number,
  domain: string,
  dependencies: LaunchdDependencies,
  requireRegistrationMissing: boolean,
): Promise<void> {
  if (input.operation !== 'SUPERVISOR_SERVICE_TARGET_STOP' || existing.state !== 'RECONCILIATION_REQUIRED'
    || existing.transactionId !== input.transactionId || existing.requestId !== input.requestId
    || existing.serviceDisabledStateBefore === undefined || input.machineId !== await readMachineId(input.dataRoot)
    || input.serviceTarget?.uid !== uid || input.serviceTarget.domain !== domain || input.serviceTarget.label !== LAUNCH_AGENT_LABEL
    || existing.recordedSourceRoot === undefined) throw new RuntimeError('CONTROL_DENIED', 'Maintenance resolution identity is incomplete or changed');

  await requireMissingPhysicalPath(existing.recordedSourceRoot);
  const sourceRoot = await requireCanonicalDirectory(input.sourceRoot, 'IRIS maintenance target source', uid, false);
  const controlScript = await requireCanonicalFile(input.controlScript, 'IRIS maintenance target control script', uid);
  if (sourceRoot !== input.sourceRoot || sourceRootForControlScript(controlScript) !== sourceRoot
    || await realpath(input.executable) !== await realpath(canonicalNodeRuntime().path)
    || await hashCanonicalFile(input.executable, 'IRIS maintenance target executable', uid) !== input.executableSha256) throw new RuntimeError('CONTROL_DENIED', 'Maintenance target source or executable identity changed');
  await requireSourceGitIdentity(sourceRoot, input.sourceSha, input.sourceTree);
  const entries = await requireTargetRuntimeEntries(input.executableArguments, uid);
  if (entries.runtimePreflightSha256 !== input.runtimePreflightSha256 || entries.runtimeLoaderSha256 !== input.runtimeLoaderSha256) throw new RuntimeError('CONTROL_DENIED', 'Maintenance target runtime entrypoints changed');

  const metadataRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  const metadata = metadataRecord?.metadata;
  if (metadataRecord === null || metadata === undefined || metadata.schemaVersion !== 3 || metadata.state !== 'READY'
    || metadata.dataRoot !== input.dataRoot || metadata.domain !== domain || metadata.label !== LAUNCH_AGENT_LABEL
    || metadata.sourceRoot !== existing.recordedSourceRoot || metadata.plist !== paths.plist || metadata.registeredPlist !== paths.registeredPlist
    || sha256(metadataRecord.raw) !== existing.beforeMetadataSha256
    || metadata.processId === undefined || metadata.processStartMarker === undefined) throw new RuntimeError('CONTROL_DENIED', 'Maintenance metadata before-image or process identity is incomplete');
  const process = (dependencies.observeProcessStart ?? observeProcessStart)(metadata.processId);
  if (process.state !== 'dead') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Recorded Supervisor process is live or indeterminate');
  const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  const registeredPlist = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if (privatePlist.state !== 'ok' || sha256(privatePlist.content) !== existing.beforePlistSha256 || metadata.plistSha256 !== existing.beforePlistSha256
    || registeredPlist.state === 'invalid' || registeredPlist.state === 'ok' && (registeredPlist.content !== privatePlist.content || sha256(registeredPlist.content) !== existing.beforePlistSha256)
    || requireRegistrationMissing && registeredPlist.state !== 'missing') throw new RuntimeError('CONTROL_DENIED', 'Maintenance plist before-image changed or registration is not in the required state');

  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);
  const service = await observeLaunchAgentOnce(dependencies);
  const disabled = await observeDisabledState(domain, launchctl);
  if (service.state !== 'ABSENT' || disabled !== existing.serviceDisabledStateBefore) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Current LaunchAgent state is not safe for maintenance continuation');
}

function requireLoadedNoPidLaunchAgentIdentity(stdout: string, metadata: LaunchAgentMetadata): void {
  const lines = stdout.split(/\r?\n/);
  if (!lines.some((line) => line.trim() === `${metadata.domain}/${metadata.label} = {`)
    || lines.filter((line) => /^\s*pid\s*=/.test(line)).length !== 0) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent is not the exact loaded/no-PID target');
  const registeredPlist = launchctlScalar(lines, 'path');
  const executable = launchctlScalar(lines, 'program');
  const workingDirectory = launchctlScalar(lines, 'working directory');
  const dataRoot = launchctlMapping(lines, 'environment', RUNTIME_DATA_ENV);
  const argumentsList = launchctlList(lines, 'arguments');
  const expectedArguments = [metadata.executable, ...metadata.executableArguments, metadata.controlScript, 'supervisor'];
  if (registeredPlist !== metadata.registeredPlist || executable !== metadata.executable || workingDirectory !== metadata.sourceRoot || dataRoot !== metadata.dataRoot
    || argumentsList === null || argumentsList.length !== expectedArguments.length || argumentsList.some((argument, index) => argument !== expectedArguments[index])) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Loaded service definition conflicts with recorded LaunchAgent identity');
}

async function observeLaunchAgentOnce(dependencies: LaunchdDependencies): Promise<LaunchAgentObservation> {
  const domain = launchdDomain(dependencies);
  try {
    const { stdout } = await (dependencies.launchctl ?? systemLaunchctl)(['print', `${domain}/${LAUNCH_AGENT_LABEL}`]);
    return { state: 'LOADED', stdout };
  } catch (error) {
    if (launchAgentAbsent(error, domain)) return { state: 'ABSENT' };
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent state is unknown', { cause: error });
  }
}

async function reconcileStoppedLaunchAgentUnlocked(
  input: LaunchAgentStopReconciliationInput,
  dependencies: LaunchdDependencies,
): Promise<{ readonly state: 'READY' }> {
  const uid = launchdUid(dependencies);
  const domain = launchdDomain(dependencies);
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);
  const paths = launchdPaths(input.dataRoot, dependencies.homeDirectory ?? os.homedir());
  const metadataRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  if (metadataRecord === null || metadataRecord.metadata.schemaVersion !== 3 || metadataRecord.metadata.state !== 'RECONCILIATION_REQUIRED' || metadataRecord.metadata.unresolvedReason !== 'BOOTOUT_OUTCOME_UNKNOWN') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor stop reconciliation requires a BOOTOUT_OUTCOME_UNKNOWN Schema-3 record');
  }
  const metadata = metadataRecord.metadata;
  const canonicalSourceRoot = await requireCanonicalDirectory(input.sourceRoot, 'IRIS current control source root', uid, false);
  if (metadata.sourceRoot !== canonicalSourceRoot || sha256(metadataRecord.raw) !== input.beforeMetadataSha256) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor stop reconciliation metadata identity does not match the authorized before-image');
  }
  const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  if (privatePlist.state !== 'ok' || sha256(privatePlist.content) !== input.beforePlistSha256 || metadata.plistSha256 !== sha256(privatePlist.content)) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor stop reconciliation plist identity does not match the authorized before-image');
  }
  const registeredPlist = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if (registeredPlist.state === 'invalid' || registeredPlist.state === 'ok' && registeredPlist.content !== privatePlist.content) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Registered LaunchAgent plist conflicts with the private binding');
  }
  const observation = await observeLaunchAgent(dependencies);
  if (observation.state !== 'ABSENT') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor is still loaded; stop reconciliation will not issue bootout');
  }
  if (metadata.processId === undefined || metadata.processStartMarker === undefined) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Unresolved Supervisor stop has no durable process identity');
  }
  const processObservation = (dependencies.observeProcessStart ?? observeProcessStart)(metadata.processId);
  if (processObservation.state === 'indeterminate' || processObservation.state === 'live' && processObservation.marker === metadata.processStartMarker) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Original Supervisor process identity remains ambiguous');
  }
  await writeLaunchAgentMetadata(paths.metadata, { ...metadata, state: 'READY', unresolvedReason: null }, uid);
  if (registeredPlist.state === 'ok') await removeOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  return { state: 'READY' };
}

async function stopLaunchAgentForMigrationUnlocked(
  input: LaunchAgentStopForMigrationInput,
  dependencies: LaunchdDependencies,
): Promise<{ readonly state: 'STOPPED'; readonly processId?: number }> {
  const uid = launchdUid(dependencies);
  const domain = launchdDomain(dependencies);
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);
  const paths = launchdPaths(input.dataRoot, dependencies.homeDirectory ?? os.homedir());
  const metadataRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  const pendingStop = metadataRecord?.metadata.schemaVersion === 3
    && metadataRecord.metadata.state === 'RECONCILIATION_REQUIRED'
    && metadataRecord.metadata.unresolvedReason === 'BOOTOUT_OUTCOME_UNKNOWN';
  if (metadataRecord === null || metadataRecord.metadata.schemaVersion !== 3 || metadataRecord.metadata.state !== 'READY' && !pendingStop) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor source stop requires Schema-3 metadata');
  }
  const metadata = metadataRecord.metadata;
  const canonicalSourceRoot = await requireCanonicalDirectory(input.sourceRoot, 'IRIS current control source root', uid, false);
  if (metadata.sourceRoot !== canonicalSourceRoot || !pendingStop && sha256(metadataRecord.raw) !== input.beforeMetadataSha256) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor source stop metadata identity does not match the authorized before-image');
  }
  const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  if (privatePlist.state !== 'ok' || sha256(privatePlist.content) !== input.beforePlistSha256 || metadata.plistSha256 !== sha256(privatePlist.content)) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor source stop plist identity does not match the authorized before-image');
  }
  const registeredPlist = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if (registeredPlist.state === 'invalid' || registeredPlist.state === 'ok' && registeredPlist.content !== privatePlist.content) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Registered LaunchAgent plist conflicts with the private binding');
  }
  const observation = await observeLaunchAgent(dependencies);
  if (observation.state === 'ABSENT') {
    if (pendingStop) {
      if (metadata.processId === undefined || metadata.processStartMarker === undefined) {
        throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Unresolved Supervisor stop has no durable process identity');
      }
      const processObservation = (dependencies.observeProcessStart ?? observeProcessStart)(metadata.processId);
      if (processObservation.state === 'indeterminate' || processObservation.state === 'live' && processObservation.marker === metadata.processStartMarker) {
        throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Unresolved Supervisor stop still has ambiguous process ownership');
      }
      await writeLaunchAgentMetadata(paths.metadata, { ...metadata, state: 'READY', unresolvedReason: null }, uid);
    }
    if (registeredPlist.state === 'ok') await removeOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
    return { state: 'STOPPED' };
  }
  requireLiveLaunchAgentIdentity(observation.stdout, metadata);
  const liveProcess = await requireLiveProcessIdentity(observation.stdout, metadata, dependencies);
  if (metadata.processId !== undefined && metadata.processId !== liveProcess.pid) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor process identity changed before source stop');
  }
  let bootoutError: unknown;
  try { await launchctl(['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]); } catch (error) { bootoutError = error; }
  let afterBootout: LaunchAgentObservation;
  try { afterBootout = await observeLaunchAgentAfterBootout(dependencies); }
  catch (error) {
    await recordUnresolved(paths.metadata, metadata, 'BOOTOUT_OUTCOME_UNKNOWN', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor source stop outcome requires reconciliation', { cause: error });
  }
  if (afterBootout.state !== 'ABSENT') {
    await recordUnresolved(paths.metadata, metadata, 'BOOTOUT_OUTCOME_UNKNOWN', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Could not safely unload the verified Supervisor', { cause: bootoutError });
  }
  if (registeredPlist.state === 'ok') await removeOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  return { state: 'STOPPED', processId: liveProcess.pid };
}

async function observeLaunchAgentAfterBootout(dependencies: LaunchdDependencies): Promise<LaunchAgentObservation> {
  let observation: LaunchAgentObservation = await observeLaunchAgent(dependencies);
  for (let attempt = 0; attempt < 10 && observation.state !== 'ABSENT'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    observation = await observeLaunchAgent(dependencies);
  }
  return observation;
}

async function migrateLaunchAgentSourceUnlocked(
  input: LaunchAgentSourceMigrationInput,
  dependencies: LaunchdDependencies,
): Promise<LaunchAgentSourceMigrationRecord> {
  assertSupportedNodeVersion();
  validateMigrationInput(input);
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const canonicalSourceRoot = await requireCanonicalDirectory(input.sourceRoot, 'IRIS control source root', uid, false);
  const canonicalControlScript = await requireCanonicalFile(input.controlScript, 'IRIS control script', uid);
  if (sourceRootForControlScript(canonicalControlScript) !== canonicalSourceRoot) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Control script is outside the requested source root');
  }
  const executable = await realpath(input.executable).catch((error) => {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Reviewed control executable cannot be resolved', { cause: error });
  });
  const expectedExecutable = await realpath(canonicalNodeRuntime().path);
  if (executable !== expectedExecutable) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Reviewed control executable is not the supported Node runtime');
  }
  const runtimeEntrypoints = await requireTargetRuntimeEntries(input.executableArguments, uid);
  await requireSourceGitIdentity(canonicalSourceRoot, input.sourceSha, input.sourceTree);
  const canonicalProtectedReferenceRoot = input.protectedReferenceRoot === undefined
    ? undefined
    : await requireCanonicalDirectory(input.protectedReferenceRoot, 'IRIS protected reference root', uid, false);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  const domain = launchdDomain(dependencies);
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);
  const observation = await observeLaunchAgent(dependencies);
  if (observation.state !== 'ABSENT') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'A loaded LaunchAgent must be stopped before source migration');
  }
  const migrationPath = paths.sourceBindingMigration;
  const existingMigrationInspection = await inspectOwnedFile(migrationPath, 'IRIS source migration record', uid);
  const existingMigration = await readSourceMigrationRecord(migrationPath, uid);
  let supersededMigration: LaunchAgentSourceMigrationRecord | undefined;
  if (existingMigration !== null) {
    if (existingMigration.state === 'COMMITTED'
      && existingMigration.requestId === input.requestId
      && existingMigration.dataRoot === canonicalDataRoot
      && existingMigration.targetSourceRoot === canonicalSourceRoot
      && existingMigration.targetControlScript === canonicalControlScript
      && existingMigration.targetExecutable === executable
      && existingMigration.targetExecutableArguments.length === input.executableArguments.length
      && existingMigration.targetExecutableArguments.every((argument, index) => argument === input.executableArguments[index])
      && existingMigration.runtimePreflightSha256 === runtimeEntrypoints.runtimePreflightSha256
      && existingMigration.runtimeLoaderSha256 === runtimeEntrypoints.runtimeLoaderSha256
      && existingMigration.targetSourceSha === input.sourceSha
      && existingMigration.targetSourceTree === input.sourceTree
      && (existingMigration.protectedReferenceRoot ?? null) === (canonicalProtectedReferenceRoot ?? null)
      && existingMigration.approvalId === input.approvalId
      && (input.recoveryPolicyId === undefined || existingMigration.recoveryPolicyId === input.recoveryPolicyId)) {
      await verifyCommittedMigration(paths, existingMigration, uid);
      return existingMigration;
    }
    if (existingMigration.state !== 'COMMITTED') {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'An existing source migration requires reconciliation before retry');
    }
    supersededMigration = existingMigration;
  }

  const currentRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  if (currentRecord === null) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Source migration requires durable LaunchAgent metadata');
  const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  if (privatePlist.state !== 'ok') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Legacy private LaunchAgent plist is unavailable');
  const registeredPlist = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if (registeredPlist.state !== 'missing') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'A registered LaunchAgent conflicts with source migration');
  const sourceBefore = currentRecord.metadata.schemaVersion === 1
    ? { raw: currentRecord.raw, plist: renderLaunchAgent(canonicalDataRoot, currentRecord.metadata.executable, currentRecord.metadata.controlScript, currentRecord.metadata.executableArguments) }
    : { raw: currentRecord.raw, plist: privatePlist.content };
  if (currentRecord.metadata.schemaVersion === 1) {
    if (supersededMigration !== undefined) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'A committed source migration cannot supersede an unresolved schema-1 binding');
    }
    if (currentRecord.metadata.plist !== paths.plist || privatePlist.content !== sourceBefore.plist) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Legacy LaunchAgent binding does not match its durable metadata');
    }
  } else {
    if (currentRecord.metadata.plist !== paths.plist || currentRecord.metadata.registeredPlist !== paths.registeredPlist || currentRecord.metadata.plistSha256 !== sha256(privatePlist.content) || currentRecord.metadata.state === 'RECONCILIATION_REQUIRED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Schema-3 source binding before-images changed');
    if (currentRecord.metadata.initialInstall !== undefined) await verifyInitialInstallProvenance(currentRecord.metadata, paths, uid);
    else if (supersededMigration === undefined
      || supersededMigration.targetSourceRoot !== currentRecord.metadata.sourceRoot
      || supersededMigration.targetControlScript !== currentRecord.metadata.controlScript
      || supersededMigration.targetExecutable !== currentRecord.metadata.executable
      || supersededMigration.targetExecutableArguments.length !== currentRecord.metadata.executableArguments.length
      || supersededMigration.targetExecutableArguments.some((argument, index) => argument !== currentRecord.metadata.executableArguments[index])
      || supersededMigration.dataRoot !== canonicalDataRoot
      || currentRecord.metadata.plist !== paths.plist
      || currentRecord.metadata.registeredPlist !== paths.registeredPlist
      || currentRecord.metadata.plistSha256 !== sha256(privatePlist.content)) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Schema-3 source binding is not an exact committed migration target');
    }
  }
  const approval = await readSourceApprovalRecord(paths.sourceBindingApproval, uid);
  const secret = await readOwnerAccessSecret(canonicalDataRoot);
  if (secret === null) throw new RuntimeError('CONTROL_DENIED', 'Owner access approval is not initialized');
  if (approval === null || approval.schemaVersion !== 2 || approval.state !== 'ISSUED' || approval.approvalId !== input.approvalId
    || !approvalMatches(approval, {
      sourceRoot: canonicalSourceRoot,
      controlScript: canonicalControlScript,
      executable,
      ...(canonicalProtectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: canonicalProtectedReferenceRoot }),
      domain,
      beforeMetadataSha256: sha256(sourceBefore.raw),
      beforePlistSha256: sha256(sourceBefore.plist),
      runtimePreflightSha256: runtimeEntrypoints.runtimePreflightSha256,
      runtimeLoaderSha256: runtimeEntrypoints.runtimeLoaderSha256,
    }, input)
    || (approval.recoveryPolicyId ?? null) !== (input.recoveryPolicyId ?? null)
    || (input.recoveryPolicyId !== undefined && approval.recoveryPolicyTransactionId === undefined)
    || !verifySourceApproval(approval, secret)) {
    throw new RuntimeError('CONTROL_DENIED', 'Migration approval is missing, stale, conflicting or invalid');
  }
  if (input.recoveryPolicyId !== undefined) {
    await assertRecoveryPolicyOperationCommitted({ dataRoot: canonicalDataRoot, policyId: input.recoveryPolicyId, operation: 'MIGRATION_APPROVAL', requestId: input.requestId, transactionId: approval.recoveryPolicyTransactionId!, sourceSha: input.sourceSha, sourceTree: input.sourceTree, sourceRoot: canonicalSourceRoot, controlScript: canonicalControlScript, executable, executableArguments: input.executableArguments, runtimePreflightSha256: runtimeEntrypoints.runtimePreflightSha256, runtimeLoaderSha256: runtimeEntrypoints.runtimeLoaderSha256, beforeMetadataSha256: sha256(sourceBefore.raw), beforePlistSha256: sha256(sourceBefore.plist), protectedReferenceRoot: canonicalProtectedReferenceRoot });
  }
  const disabledStateBeforeMigration = await observeDisabledState(domain, launchctl);
  if (disabledStateBeforeMigration === 'UNKNOWN') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `The disabled state of ${LAUNCH_AGENT_LABEL} in ${domain} is unknown`);
  }
  const publishedEntrypoints = await requireTargetRuntimeEntries(input.executableArguments, uid);
  if (publishedEntrypoints.runtimePreflightSha256 !== runtimeEntrypoints.runtimePreflightSha256
    || publishedEntrypoints.runtimeLoaderSha256 !== runtimeEntrypoints.runtimeLoaderSha256
    || publishedEntrypoints.runtimePreflightSha256 !== approval.runtimePreflightSha256
    || publishedEntrypoints.runtimeLoaderSha256 !== approval.runtimeLoaderSha256) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Reviewed runtime entrypoints changed after owner approval');
  }
  const targetPlist = renderLaunchAgent(
    canonicalDataRoot,
    executable,
    canonicalControlScript,
    input.executableArguments,
    canonicalProtectedReferenceRoot,
  );
  const targetMetadata: LaunchAgentMetadata = {
    schemaVersion: 3,
    label: LAUNCH_AGENT_LABEL,
    domain,
    dataRoot: canonicalDataRoot,
    sourceRoot: canonicalSourceRoot,
    executable,
    controlScript: canonicalControlScript,
    executableArguments: [...input.executableArguments],
    plist: paths.plist,
    registeredPlist: paths.registeredPlist,
    plistSha256: sha256(targetPlist),
    state: 'PREPARED',
    disabledBeforeInstall: disabledStateBeforeMigration === 'EXPLICIT_DISABLED',
    disabledStateBeforeInstall: disabledStateBeforeMigration,
    unresolvedReason: null,
    ...(currentRecord.metadata.schemaVersion === 3 && currentRecord.metadata.initialInstall !== undefined ? { initialInstall: currentRecord.metadata.initialInstall } : {}),
    ...(currentRecord.metadata.schemaVersion === 3
      ? currentRecord.metadata.legacyMigration === undefined ? {} : { legacyMigration: currentRecord.metadata.legacyMigration }
      : { legacyMigration: {
        fromSchemaVersion: 1,
        metadataSha256: sha256(currentRecord.raw),
        plistSha256: sha256(sourceBefore.plist),
        executable: currentRecord.metadata.executable,
        controlScript: currentRecord.metadata.controlScript,
        executableArguments: [...currentRecord.metadata.executableArguments],
        plist: currentRecord.metadata.plist,
        observedState: 'ABSENT' as const,
        disabledBeforeMigration: disabledStateBeforeMigration === 'EXPLICIT_DISABLED',
        disabledStateBeforeMigration,
      } }),
  };
  const transactionId = randomUUID();
  const baseRecord: LaunchAgentSourceMigrationRecord = {
    schemaVersion: 1,
    transactionId,
    requestId: input.requestId,
    state: 'PREPARED',
    label: LAUNCH_AGENT_LABEL,
    domain,
    dataRoot: canonicalDataRoot,
    beforeMetadataSha256: sha256(sourceBefore.raw),
    beforePlistSha256: sha256(sourceBefore.plist),
    legacyMetadataRaw: sourceBefore.raw,
    targetSourceRoot: canonicalSourceRoot,
    targetControlScript: canonicalControlScript,
    targetExecutable: executable,
    targetExecutableArguments: [...input.executableArguments],
    runtimePreflightSha256: publishedEntrypoints.runtimePreflightSha256,
    runtimeLoaderSha256: publishedEntrypoints.runtimeLoaderSha256,
    targetSourceSha: input.sourceSha,
    targetSourceTree: input.sourceTree,
    approvalId: input.approvalId,
    disabledStateBeforeMigration,
    ...(canonicalProtectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: canonicalProtectedReferenceRoot }),
  };
  const beforePublication = await observeLaunchAgent(dependencies);
  if (beforePublication.state !== 'ABSENT') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'A same-label LaunchAgent appeared during source migration preflight');
  }
  let policyTransactionId: string | undefined;
  if (input.recoveryPolicyId !== undefined) {
    const reservation = await reserveRecoveryPolicyOperation({
      dataRoot: canonicalDataRoot,
      policyId: input.recoveryPolicyId,
      operation: 'SOURCE_MIGRATION',
      requestId: input.requestId,
      sourceSha: input.sourceSha,
      sourceTree: input.sourceTree,
      sourceRoot: canonicalSourceRoot,
      controlScript: canonicalControlScript,
      executable,
      executableArguments: input.executableArguments,
      runtimePreflightSha256: runtimeEntrypoints.runtimePreflightSha256,
      runtimeLoaderSha256: runtimeEntrypoints.runtimeLoaderSha256,
      beforeMetadataSha256: sha256(sourceBefore.raw),
      beforePlistSha256: sha256(sourceBefore.plist),
      protectedReferenceRoot: canonicalProtectedReferenceRoot,
    });
    policyTransactionId = reservation.transactionId;
  }
  const journaledBaseRecord: LaunchAgentSourceMigrationRecord = policyTransactionId === undefined ? baseRecord : { ...baseRecord, recoveryPolicyId: input.recoveryPolicyId!, recoveryPolicyTransactionId: policyTransactionId };
  const applying = { ...journaledBaseRecord, state: 'APPLYING' as const };
  let plistChanged = false;
  let metadataChanged = false;
  let rollbackEvidenceUnknown = false;
  let committed: LaunchAgentSourceMigrationRecord | undefined;
  try {
    if (supersededMigration !== undefined) {
      if (existingMigrationInspection.state !== 'ok') throw new RuntimeError('PERSISTENCE_FAILURE', 'Superseded source migration record is not readable');
      await archiveSourceMigration(paths, existingMigrationInspection.content, uid);
      await replaceOwnedFile(migrationPath, existingMigrationInspection.content, migrationContent(journaledBaseRecord), 'IRIS source migration record', uid);
    } else {
      await publishOwnedFile(migrationPath, migrationContent(journaledBaseRecord), 'IRIS source migration record', uid);
    }
    await replaceOwnedFile(migrationPath, migrationContent(journaledBaseRecord), migrationContent(applying), 'IRIS source migration record', uid);
    try {
      await replaceOwnedFile(paths.plist, sourceBefore.plist, targetPlist, 'IRIS private LaunchAgent', uid);
      plistChanged = true;
    } catch (error) {
      const state = await exactOwnedContent(paths.plist, targetPlist, uid);
      if (state === true) plistChanged = true;
      else if (state === null) rollbackEvidenceUnknown = true;
      throw error;
    }
    try {
      await replaceOwnedFile(paths.metadata, sourceBefore.raw, metadataContent(targetMetadata), 'IRIS LaunchAgent metadata', uid);
      metadataChanged = true;
    } catch (error) {
      const state = await exactOwnedContent(paths.metadata, metadataContent(targetMetadata), uid);
      if (state === true) metadataChanged = true;
      else if (state === null) rollbackEvidenceUnknown = true;
      throw error;
    }
    committed = { ...applying, state: 'COMMITTED' as const };
    await replaceOwnedFile(migrationPath, migrationContent(applying), migrationContent(committed), 'IRIS source migration record', uid);
    const consumedApproval = { ...approval, state: 'CONSUMED' as const, signature: '' };
    const signedConsumedApproval = { ...consumedApproval, signature: signSourceApproval(consumedApproval, secret) };
    await replaceOwnedFile(paths.sourceBindingApproval, approvalContent(approval), approvalContent(signedConsumedApproval), 'IRIS source migration approval', uid);
    if (policyTransactionId !== undefined) await finalizeRecoveryPolicyOperation({ dataRoot: canonicalDataRoot, policyId: input.recoveryPolicyId!, operation: 'SOURCE_MIGRATION', requestId: input.requestId, transactionId: policyTransactionId, state: 'COMMITTED', sourceSha: input.sourceSha, sourceTree: input.sourceTree, sourceRoot: canonicalSourceRoot, controlScript: canonicalControlScript, executable, executableArguments: input.executableArguments, runtimePreflightSha256: runtimeEntrypoints.runtimePreflightSha256, runtimeLoaderSha256: runtimeEntrypoints.runtimeLoaderSha256, beforeMetadataSha256: sha256(sourceBefore.raw), beforePlistSha256: sha256(sourceBefore.plist), protectedReferenceRoot: canonicalProtectedReferenceRoot });
    return committed;
  } catch (error) {
    if (policyTransactionId !== undefined) await finalizeRecoveryPolicyOperation({ dataRoot: canonicalDataRoot, policyId: input.recoveryPolicyId!, operation: 'SOURCE_MIGRATION', requestId: input.requestId, transactionId: policyTransactionId, state: 'RECONCILIATION_REQUIRED', sourceSha: input.sourceSha, sourceTree: input.sourceTree, sourceRoot: canonicalSourceRoot, controlScript: canonicalControlScript, executable, executableArguments: input.executableArguments, runtimePreflightSha256: runtimeEntrypoints.runtimePreflightSha256, runtimeLoaderSha256: runtimeEntrypoints.runtimeLoaderSha256, beforeMetadataSha256: sha256(sourceBefore.raw), beforePlistSha256: sha256(sourceBefore.plist), protectedReferenceRoot: canonicalProtectedReferenceRoot }).catch(() => undefined);
    if (committed !== undefined) {
      const unresolved = { ...committed, state: 'RECONCILIATION_REQUIRED' as const, failureCode: 'APPROVAL_CONSUMPTION_UNKNOWN' };
      await replaceOwnedFile(migrationPath, migrationContent(committed), migrationContent(unresolved), 'IRIS source migration record', uid).catch(() => undefined);
      const unresolvedApproval = { ...approval, state: 'RECONCILIATION_REQUIRED' as const, signature: '' };
      const signedUnresolvedApproval = { ...unresolvedApproval, signature: signSourceApproval(unresolvedApproval, secret) };
      await replaceOwnedFile(paths.sourceBindingApproval, approvalContent(approval), approvalContent(signedUnresolvedApproval), 'IRIS source migration approval', uid).catch(() => undefined);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Source migration committed but approval consumption requires reconciliation', { cause: error });
    }
    let rollbackFailed = false;
    if (metadataChanged) {
      try { await replaceOwnedFile(paths.metadata, metadataContent(targetMetadata), sourceBefore.raw, 'IRIS LaunchAgent metadata', uid); }
      catch { rollbackFailed = true; }
    }
    if (plistChanged) {
      try { await replaceOwnedFile(paths.plist, targetPlist, sourceBefore.plist, 'IRIS private LaunchAgent', uid); }
      catch { rollbackFailed = true; }
    }
    const unresolved = {
      ...applying,
      state: 'RECONCILIATION_REQUIRED' as const,
      failureCode: rollbackFailed || rollbackEvidenceUnknown ? 'ROLLBACK_OUTCOME_UNKNOWN' : 'MIGRATION_FAILED',
    };
    await replaceOwnedFile(migrationPath, migrationContent(applying), migrationContent(unresolved), 'IRIS source migration record', uid).catch(() => undefined);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', rollbackFailed
      ? 'Source migration rollback requires reconciliation'
      : 'Source migration failed and was rolled back', { cause: error });
  }
}

async function exactOwnedContent(filename: string, expected: string, uid: number): Promise<boolean | null> {
  try {
    const inspected = await inspectOwnedFile(filename, 'IRIS migration target', uid);
    if (inspected.state === 'ok') return inspected.content === expected;
    if (inspected.state === 'missing') return false;
    return null;
  } catch {
    return null;
  }
}

async function verifyCommittedMigration(paths: LaunchdPaths, record: LaunchAgentSourceMigrationRecord, uid: number): Promise<void> {
  const runtimeEntrypoints = await requireTargetRuntimeEntries(record.targetExecutableArguments, uid);
  if (runtimeEntrypoints.runtimePreflightSha256 !== record.runtimePreflightSha256
    || runtimeEntrypoints.runtimeLoaderSha256 !== record.runtimeLoaderSha256) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Committed source migration runtime entrypoints changed');
  }
  const targetPlist = renderLaunchAgent(record.dataRoot, record.targetExecutable, record.targetControlScript, record.targetExecutableArguments, record.protectedReferenceRoot);
  const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  if (privatePlist.state !== 'ok' || privatePlist.content !== targetPlist) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Committed source migration target plist no longer matches');
  const registeredPlist = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if (registeredPlist.state === 'invalid' || registeredPlist.state === 'ok' && registeredPlist.content !== targetPlist) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Committed source migration has an unexpected registered LaunchAgent');
  }
  const metadata = await readLaunchAgentMetadata(paths.metadata, uid);
  if (metadata?.metadata.schemaVersion !== 3 || metadata.metadata.state !== 'PREPARED' && metadata.metadata.state !== 'READY') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Committed source migration metadata is not in the expected prepared state');
  requireMetadataBinding(metadata.metadata, {
    schemaVersion: 3,
    label: LAUNCH_AGENT_LABEL,
    domain: record.domain,
    dataRoot: record.dataRoot,
    sourceRoot: record.targetSourceRoot,
    executable: record.targetExecutable,
    controlScript: record.targetControlScript,
    plist: paths.plist,
    registeredPlist: paths.registeredPlist,
    plistSha256: sha256(targetPlist),
    executableArguments: record.targetExecutableArguments,
  });
}

export async function issueInitialLaunchAgentPolicy(
  input: InitialLaunchAgentPolicyInput,
  ownerAuthorization: string,
  dependencies: LaunchdDependencies = {},
): Promise<RecoveryPolicyPublicRecord> {
  const uid = launchdUid(dependencies);
  const dataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(dataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, async () => {
    const owner = await readControlPlaneApiKey(dataRoot);
    const supplied = Buffer.from(ownerAuthorization);
    const expected = Buffer.from(`Bearer ${owner ?? ''}`);
    if (owner === null || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new RuntimeError('CONTROL_DENIED', 'Initial installation requires the existing local Owner credential');
    assertSupportedNodeVersion();
    const sourceRoot = await requireCanonicalDirectory(input.sourceRoot, 'IRIS source root', uid, false);
    const controlScript = await requireCanonicalFile(input.controlScript, 'IRIS control script', uid);
    if (sourceRootForControlScript(controlScript) !== sourceRoot) throw new RuntimeError('CONTROL_DENIED', 'Control script is outside the authorized source');
    const executable = await realpath(input.executable);
    if (executable !== await realpath(canonicalNodeRuntime().path)) throw new RuntimeError('CONTROL_DENIED', 'Initial installation requires the supported Node executable');
    await requireSourceGitIdentity(sourceRoot, input.sourceSha, input.sourceTree);
    const entries = await requireTargetRuntimeEntries(input.executableArguments, uid);
    const machineId = await readMachineId(dataRoot);
    if (machineId === null) throw new RuntimeError('CONTROL_DENIED', 'Initial installation requires an explicitly initialized machine identity');
    const initialInstall = await inspectInitialInstallBinding(dataRoot, input.tunnelExecutable, dependencies);
    const protectedReferenceRoot = input.protectedReferenceRoot === undefined ? undefined : await requireCanonicalDirectory(input.protectedReferenceRoot, 'IRIS protected reference root', uid, false);
    const executableSha256 = await hashCanonicalFile(executable, 'Reviewed control executable', uid);
    // Only authenticated initial enrollment initializes the existing signing credential.
    await loadOrCreateOwnerAccessSecret(dataRoot);
    return issueRecoveryAuthorizationPolicy({
      dataRoot, machineId, initialInstall, beforeMetadataSha256: null, beforePlistSha256: null,
      sourceBindings: [{ sourceRoot, controlScript, executable, executableSha256, executableArguments: input.executableArguments, sourceSha: input.sourceSha, sourceTree: input.sourceTree, ...entries }],
      allowedOperations: ['SUPERVISOR_BOOTSTRAP'], maxOperationCount: 1, expiresAt: input.expiresAt,
      ...(protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot }),
      ...(input.supersedesPolicyId === undefined ? {} : { supersedesPolicyId: input.supersedesPolicyId }),
    });
  });
}

async function inspectInitialInstallBinding(dataRoot: string, tunnelExecutableInput: string, dependencies: LaunchdDependencies): Promise<InitialInstallBinding> {
  const uid = launchdUid(dependencies);
  const paths = launchdPaths(dataRoot, dependencies.homeDirectory ?? os.homedir());
  const domain = launchdDomain(dependencies);
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);
  if ((await observeLaunchAgent(dependencies)).state !== 'ABSENT') throw new RuntimeError('CONTROL_DENIED', 'Initial installation requires an absent exact LaunchAgent service');
  if (await observeDisabledState(domain, launchctl) === 'UNKNOWN') throw new RuntimeError('CONTROL_DENIED', 'Initial installation disabled state is unknown');
  for (const filename of [paths.metadata, paths.plist, paths.registeredPlist]) {
    if ((await inspectOwnedFile(filename, 'Initial installation before-image', uid)).state !== 'missing') throw new RuntimeError('CONTROL_DENIED', 'Initial installation requires absent metadata and private/registered plists');
  }
  const migration = await readSourceMigrationRecord(paths.sourceBindingMigration, uid);
  if (migration !== null && migration.state !== 'COMMITTED') throw new RuntimeError('CONTROL_DENIED', 'Incomplete source migration requires reconciliation before initial installation');
  const registry = await readConnectorRegistry(dataRoot);
  const machineId = await readMachineId(dataRoot);
  const connector = registry?.connectors[0];
  if (registry === null || registry.admin !== null || registry.connectors.length !== 1 || connector?.connectorId !== 'iris-full' || connector.label !== 'IRIS' || machineId === null || connector.machineId !== machineId) throw new RuntimeError('CONTROL_DENIED', 'Initial installation requires one machine-bound ONE connector');
  const tunnelExecutable = await requireCanonicalFile(tunnelExecutableInput, 'Reviewed tunnel executable', uid);
  return { kind: 'ABSENT', uid, domain, label: LAUNCH_AGENT_LABEL, registeredPlist: paths.registeredPlist, connectorId: 'iris-full', tunnelId: connector.tunnelId, managedProfilePath: connector.managedProfilePath, tunnelExecutable, tunnelExecutableSha256: await hashCanonicalFile(tunnelExecutable, 'Reviewed tunnel executable', uid), startup: 'CONTROL_ONLY' };
}

export type InitialLaunchAgentEnrollmentState =
  | { readonly state: 'ABSENT' }
  | { readonly state: 'PENDING' }
  | { readonly state: 'COMMITTED'; readonly enrollment: InitialInstallProvenance; readonly sourceBinding: { readonly sourceRoot: string; readonly controlScript: string; readonly executable: string; readonly executableArguments: readonly string[] } };

export async function readInitialLaunchAgentEnrollmentState(dataRoot: string, dependencies: LaunchdDependencies = {}): Promise<InitialLaunchAgentEnrollmentState> {
  const uid = launchdUid(dependencies);
  const canonical = await requireCanonicalDirectory(dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonical, dependencies.homeDirectory ?? os.homedir());
  const record = await readLaunchAgentMetadata(paths.metadata, uid);
  if (record === null || record.metadata.schemaVersion !== 3 || record.metadata.initialInstall === undefined) return { state: 'ABSENT' };
  const operation = await readRecoveryPolicyOperation(record.metadata.initialInstall);
  if (operation.state === 'FAILED') throw new RuntimeError('CONTROL_DENIED', 'Initial installation was proven failed');
  if (record.metadata.state !== 'READY' || operation.state !== 'COMMITTED') return { state: 'PENDING' };
  await verifyInitialInstallProvenance(record.metadata, paths, uid);
  const { sourceRoot, controlScript, executable, executableArguments } = record.metadata;
  return { state: 'COMMITTED', enrollment: record.metadata.initialInstall, sourceBinding: { sourceRoot, controlScript, executable, executableArguments } };
}

export async function readInitialLaunchAgentEnrollment(dataRoot: string, dependencies: LaunchdDependencies = {}): Promise<InitialInstallProvenance | null> {
  const result = await readInitialLaunchAgentEnrollmentState(dataRoot, dependencies);
  return result.state === 'COMMITTED' ? result.enrollment : null;
}

async function verifyInitialInstallProvenance(metadata: LaunchAgentMetadata, paths: LaunchdPaths, uid: number): Promise<void> {
  const proof = metadata.initialInstall;
  if (proof === undefined || !validInitialInstallProvenance(proof) || proof.dataRoot !== metadata.dataRoot || proof.initialInstall.uid !== uid || proof.initialInstall.domain !== metadata.domain || proof.initialInstall.registeredPlist !== paths.registeredPlist) throw new RuntimeError('CONTROL_DENIED', 'Initial installation provenance does not match the current source binding');
  await assertRecoveryPolicyOperationCommitted(proof);
  const sameSource = proof.sourceRoot === metadata.sourceRoot && proof.controlScript === metadata.controlScript && proof.executable === metadata.executable && JSON.stringify(proof.executableArguments) === JSON.stringify(metadata.executableArguments);
  if (metadata.executable !== proof.executable || await hashCanonicalFile(metadata.executable, 'Reviewed control executable', uid) !== proof.executableSha256) throw new RuntimeError('CONTROL_DENIED', 'Initial installation executable changed');
  if (sameSource) {
    await requireSourceGitIdentity(proof.sourceRoot, proof.sourceSha, proof.sourceTree);
    const entries = await requireTargetRuntimeEntries(proof.executableArguments, uid);
    if (entries.runtimePreflightSha256 !== proof.runtimePreflightSha256 || entries.runtimeLoaderSha256 !== proof.runtimeLoaderSha256) throw new RuntimeError('CONTROL_DENIED', 'Initial installation entrypoints changed');
    const plist = renderLaunchAgent(metadata.dataRoot, proof.executable, proof.controlScript, proof.executableArguments, proof.protectedReferenceRoot);
    requireMetadataBinding(metadata, { schemaVersion: 3, label: LAUNCH_AGENT_LABEL, domain: proof.initialInstall.domain, dataRoot: metadata.dataRoot, sourceRoot: proof.sourceRoot, executable: proof.executable, controlScript: proof.controlScript, executableArguments: proof.executableArguments, plist: paths.plist, registeredPlist: paths.registeredPlist, plistSha256: sha256(plist) });
    await requirePublishedContent(paths.plist, plist, 'IRIS private LaunchAgent', uid);
    const registered = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
    if (registered.state === 'invalid' || registered.state === 'ok' && registered.content !== plist) throw new RuntimeError('CONTROL_DENIED', 'Initial installation registered plist changed');
  }
  else {
    const migration = await readSourceMigrationRecord(paths.sourceBindingMigration, uid);
    if (migration === null || migration.state !== 'COMMITTED') throw new RuntimeError('CONTROL_DENIED', 'Initial installation source changed without committed migration');
    const approval = await readSourceApprovalRecord(paths.sourceBindingApproval, uid);
    const secret = await readOwnerAccessSecret(metadata.dataRoot);
    if (approval === null || secret === null || approval.state !== 'CONSUMED' || approval.approvalId !== migration.approvalId || approval.requestId !== migration.requestId || !verifySourceApproval(approval, secret)
      || !approvalMatches(approval, { sourceRoot: migration.targetSourceRoot, controlScript: migration.targetControlScript, executable: migration.targetExecutable, domain: migration.domain, beforeMetadataSha256: migration.beforeMetadataSha256, beforePlistSha256: migration.beforePlistSha256, runtimePreflightSha256: migration.runtimePreflightSha256, runtimeLoaderSha256: migration.runtimeLoaderSha256, ...(migration.protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: migration.protectedReferenceRoot }) }, { ...approval, dataRoot: metadata.dataRoot, requestId: migration.requestId, sourceSha: migration.targetSourceSha, sourceTree: migration.targetSourceTree, executableArguments: migration.targetExecutableArguments })) throw new RuntimeError('CONTROL_DENIED', 'Initial installation source migration is not authenticated');
    await verifyCommittedMigration(paths, migration, uid);
    await requireSourceGitIdentity(metadata.sourceRoot, migration.targetSourceSha, migration.targetSourceTree);
  }
  if (await readMachineId(metadata.dataRoot) !== proof.machineId) throw new RuntimeError('CONTROL_DENIED', 'Initial installation machine changed');
  await verifyInitialTransport(metadata.dataRoot, proof.initialInstall, uid);
}

export async function reconcileInitialLaunchAgentInstall(dataRoot: string, authorization: LaunchAgentBootstrapAuthorization, ownerAuthorization: string, dependencies: LaunchdDependencies = {}): Promise<{ readonly state: 'COMMITTED' | 'FAILED' }> {
  const uid = launchdUid(dependencies);
  const canonical = await requireCanonicalDirectory(dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonical, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, async () => {
    const owner = await readControlPlaneApiKey(canonical);
    const expected = Buffer.from(`Bearer ${owner ?? ''}`);
    const supplied = Buffer.from(ownerAuthorization);
    if (owner === null || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new RuntimeError('CONTROL_DENIED', 'Initial installation reconciliation requires the local Owner credential');
    const record = await readLaunchAgentMetadata(paths.metadata, uid);
    const metadata = record?.metadata.schemaVersion === 3 ? record.metadata : null;
    let proof = metadata?.initialInstall;
    if (metadata === null) {
      const policy = await readRecoveryAuthorizationPolicy(canonical);
      const entry = policy?.policyId === authorization.recoveryPolicyId ? policy.operations.find((candidate) => candidate.requestId === authorization.requestId && candidate.operation === 'SUPERVISOR_BOOTSTRAP') : undefined;
      if (entry?.initialInstall !== undefined && typeof entry.machineId === 'string' && typeof entry.executableSha256 === 'string') proof = { ...entry, dataRoot: canonical, policyId: authorization.recoveryPolicyId, initialInstall: entry.initialInstall, machineId: entry.machineId, executableSha256: entry.executableSha256, protectedReferenceRoot: entry.protectedReferenceRoot ?? undefined };
    }
    if (proof === undefined || proof.policyId !== authorization.recoveryPolicyId || proof.requestId !== authorization.requestId || proof.sourceSha !== authorization.sourceSha || proof.sourceTree !== authorization.sourceTree) throw new RuntimeError('CONTROL_DENIED', 'Initial installation reconciliation identity does not match');
    const operation = await readRecoveryPolicyOperation(proof);
    if (!['RESERVED', 'RECONCILIATION_REQUIRED', 'COMMITTED', 'FAILED'].includes(operation.state)) throw new RuntimeError('CONTROL_DENIED', 'Initial installation outcome is already terminal');
    await requireSourceGitIdentity(proof.sourceRoot, proof.sourceSha, proof.sourceTree);
    if (await readMachineId(canonical) !== proof.machineId) throw new RuntimeError('CONTROL_DENIED', 'Initial installation machine changed');
    await verifyInitialTransport(canonical, proof.initialInstall, uid);
    if (await hashCanonicalFile(proof.executable, 'Reviewed control executable', uid) !== proof.executableSha256) throw new RuntimeError('CONTROL_DENIED', 'Initial installation executable changed');
    const entries = await requireTargetRuntimeEntries(proof.executableArguments, uid);
    if (entries.runtimePreflightSha256 !== proof.runtimePreflightSha256 || entries.runtimeLoaderSha256 !== proof.runtimeLoaderSha256) throw new RuntimeError('CONTROL_DENIED', 'Initial installation entrypoints changed');
    if (metadata === null) {
      if (operation.state === 'COMMITTED') throw new RuntimeError('CONTROL_DENIED', 'Committed initial installation metadata is missing');
      await inspectInitialInstallBinding(canonical, proof.initialInstall.tunnelExecutable, dependencies).then((observed) => {
        if (JSON.stringify(observed) !== JSON.stringify(proof!.initialInstall)) throw new RuntimeError('CONTROL_DENIED', 'Initial installation absence binding changed');
      });
      if (operation.state !== 'FAILED') await resolveInitialInstallOperation({ ...proof, state: 'FAILED' });
      return { state: 'FAILED' };
    }
    const plist = renderLaunchAgent(canonical, proof.executable, proof.controlScript, proof.executableArguments, proof.protectedReferenceRoot);
    requireMetadataBinding(metadata, { schemaVersion: 3, label: LAUNCH_AGENT_LABEL, domain: proof.initialInstall.domain, dataRoot: canonical, sourceRoot: proof.sourceRoot, executable: proof.executable, controlScript: proof.controlScript, executableArguments: proof.executableArguments, plist: paths.plist, registeredPlist: paths.registeredPlist, plistSha256: sha256(plist) });
    const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
    if (privatePlist.state === 'invalid' || privatePlist.state === 'ok' && privatePlist.content !== plist) throw new RuntimeError('CONTROL_DENIED', 'Initial installation private plist changed');
    const observation = await observeLaunchAgent(dependencies);
    const launchctl = dependencies.launchctl ?? systemLaunchctl;
    if (observation.state === 'LOADED') {
      if (operation.state === 'FAILED') throw new RuntimeError('CONTROL_DENIED', 'A failed installation cannot be reconciled as committed');
      if (privatePlist.state !== 'ok') throw new RuntimeError('CONTROL_DENIED', 'Initial installation private plist is unavailable');
      await requirePublishedContent(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);
      requireLiveLaunchAgentIdentity(observation.stdout, metadata);
      const live = await requireLiveProcessIdentity(observation.stdout, metadata, dependencies);
      const disabled = await observeDisabledState(metadata.domain, launchctl);
      if (disabled === 'UNKNOWN' || disabled === 'EXPLICIT_DISABLED') throw new RuntimeError('CONTROL_DENIED', 'Initial installation persistence is not proven');
      const stable = await observeLaunchAgent(dependencies);
      if (stable.state !== 'LOADED') throw new RuntimeError('CONTROL_DENIED', 'Initial installation process exited during reconciliation');
      requireLiveLaunchAgentIdentity(stable.stdout, metadata);
      const stableProcess = await requireLiveProcessIdentity(stable.stdout, metadata, dependencies);
      if (stableProcess.pid !== live.pid || stableProcess.processStartMarker !== live.processStartMarker) throw new RuntimeError('CONTROL_DENIED', 'Initial installation process changed during reconciliation');
      await writeLaunchAgentMetadata(paths.metadata, { ...metadata, state: 'READY', unresolvedReason: null, processId: live.pid, processStartMarker: live.processStartMarker }, uid);
      await resolveInitialInstallOperation({ ...proof, state: 'COMMITTED' });
      return { state: 'COMMITTED' };
    }
    if (operation.state === 'COMMITTED') throw new RuntimeError('CONTROL_DENIED', 'A committed installation cannot be reconciled as failed');
    const registered = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
    if (registered.state === 'invalid' || registered.state === 'ok' && registered.content !== plist) throw new RuntimeError('CONTROL_DENIED', 'Initial installation registration changed');
    await restoreDisabledState(storedDisabledState(metadata), metadata.domain, `${metadata.domain}/${metadata.label}`, launchctl);
    // Keep the signed outcome and original proof until exact owned artifacts are removed.
    if (registered.state === 'ok') await removeOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
    await removeOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
    if (operation.state !== 'FAILED') await resolveInitialInstallOperation({ ...proof, state: 'FAILED' });
    await removeOwnedFile(paths.metadata, 'IRIS LaunchAgent metadata', uid);
    return { state: 'FAILED' };
  });
}

export async function installLaunchAgent(
  dataRoot: string,
  requestedExecutable: string,
  controlScript: string,
  executableArguments: readonly string[] = [],
  protectedReferenceRoot?: string,
  dependencies: LaunchdDependencies = {},
  bootstrapAuthorization?: LaunchAgentBootstrapAuthorization,
): Promise<LaunchdPaths> {
  if (bootstrapAuthorization === undefined) throw new RuntimeError('CONTROL_DENIED', 'Supervisor bootstrap requires an explicit recovery policy authorization');
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  return withLaunchAgentLock(paths, uid, () => installLaunchAgentUnlocked(canonicalDataRoot, requestedExecutable, controlScript, executableArguments, protectedReferenceRoot, dependencies, bootstrapAuthorization));
}

async function installLaunchAgentUnlocked(
  dataRoot: string,
  requestedExecutable: string,
  controlScript: string,
  executableArguments: readonly string[] = [],
  protectedReferenceRoot?: string,
  dependencies: LaunchdDependencies = {},
  bootstrapAuthorization?: LaunchAgentBootstrapAuthorization,
): Promise<LaunchdPaths> {
  if (bootstrapAuthorization === undefined) throw new RuntimeError('CONTROL_DENIED', 'Supervisor bootstrap requires an explicit recovery policy authorization');
  assertSupportedNodeVersion();
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(dataRoot, 'IRIS data root', uid, true);
  const canonicalControlScript = await requireCanonicalFile(controlScript, 'IRIS control script', uid);
  const sourceRoot = await requireCanonicalDirectory(sourceRootForControlScript(canonicalControlScript), 'IRIS source root', uid, false);
  const executable = await realpath(canonicalNodeRuntime().path);
  await access(canonicalControlScript).catch(() => { throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Build IRIS before installing its LaunchAgent'); });
  const runtimeEntrypoints = await requireTargetRuntimeEntries(executableArguments, uid);
  const executableSha256 = await hashCanonicalFile(executable, 'Reviewed control executable', uid);
  await requireSourceGitIdentity(sourceRoot, bootstrapAuthorization.sourceSha, bootstrapAuthorization.sourceTree);
  const machineId = await readMachineId(canonicalDataRoot);
  if (machineId === null) throw new RuntimeError('CONTROL_DENIED', 'Supervisor bootstrap requires an existing protected machine identity');

  let canonicalProtectedReferenceRoot: string | undefined;
  if (protectedReferenceRoot !== undefined && protectedReferenceRoot.trim().length > 0) {
    const inspection = await inspectRegistrationRoot(protectedReferenceRoot.trim());
    if (!inspection.valid || inspection.target === null) {
      throw new RuntimeError('INVALID_PROJECT_PATH', `${PROTECTED_REFERENCE_ROOT_ENV} must identify an existing canonical non-root directory`);
    }
    canonicalProtectedReferenceRoot = inspection.target;
  }

  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  const domain = launchdDomain(dependencies);
  const serviceTarget = `${domain}/${LAUNCH_AGENT_LABEL}`;
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);

  const existingRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  const existingMetadata = existingRecord?.metadata.schemaVersion === 3 ? existingRecord.metadata : null;
  const policy = await readRecoveryAuthorizationPolicy(canonicalDataRoot);
  const initialInstall = policy?.policyId === bootstrapAuthorization.recoveryPolicyId ? policy.initialInstall : undefined;
  const initial = existingRecord === null && initialInstall !== undefined;
  const plist = renderLaunchAgent(canonicalDataRoot, executable, canonicalControlScript, executableArguments, canonicalProtectedReferenceRoot);
  let beforeMetadataSha256: string | null;
  let beforePlistSha256: string | null;
  if (initial) {
    const observedBinding = await inspectInitialInstallBinding(canonicalDataRoot, initialInstall.tunnelExecutable, dependencies);
    if (JSON.stringify(observedBinding) !== JSON.stringify(initialInstall)) throw new RuntimeError('CONTROL_DENIED', 'Initial installation binding changed after authorization');
    beforeMetadataSha256 = null;
    beforePlistSha256 = null;
  } else {
    if (existingMetadata === null) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor bootstrap requires a committed source migration or explicit absent-state installation authority');
    if (['UNINSTALLING', 'INSTALLING', 'RECONCILIATION_REQUIRED'].includes(existingMetadata.state)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'An interrupted LaunchAgent operation requires reconciliation');
    if (existingMetadata.initialInstall !== undefined) {
      await verifyInitialInstallProvenance(existingMetadata, paths, uid);
      const migration = await readSourceMigrationRecord(paths.sourceBindingMigration, uid);
      const expectedSource = migration?.state === 'COMMITTED' && migration.targetSourceRoot === existingMetadata.sourceRoot ? { sha: migration.targetSourceSha, tree: migration.targetSourceTree } : { sha: existingMetadata.initialInstall.sourceSha, tree: existingMetadata.initialInstall.sourceTree };
      if (expectedSource.sha !== bootstrapAuthorization.sourceSha || expectedSource.tree !== bootstrapAuthorization.sourceTree) throw new RuntimeError('CONTROL_DENIED', 'Bootstrap source identity does not match initial installation');
    } else {
      const committedMigration = await readSourceMigrationRecord(paths.sourceBindingMigration, uid);
      if (committedMigration === null || committedMigration.state !== 'COMMITTED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor bootstrap requires a committed source migration');
      if (committedMigration.domain !== domain || committedMigration.dataRoot !== canonicalDataRoot || committedMigration.targetSourceRoot !== sourceRoot || committedMigration.targetControlScript !== canonicalControlScript || committedMigration.targetExecutable !== executable || JSON.stringify(committedMigration.targetExecutableArguments) !== JSON.stringify(executableArguments) || (committedMigration.protectedReferenceRoot ?? null) !== (canonicalProtectedReferenceRoot ?? null)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Committed source migration does not authorize the requested LaunchAgent binding');
      if (committedMigration.targetSourceSha !== bootstrapAuthorization.sourceSha || committedMigration.targetSourceTree !== bootstrapAuthorization.sourceTree) throw new RuntimeError('CONTROL_DENIED', 'Supervisor bootstrap source identity does not match the committed migration');
      await verifyCommittedMigration(paths, committedMigration, uid);
    }
    const existingPlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
    if (existingPlist.state !== 'ok') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor bootstrap requires an exact protected LaunchAgent before-image');
    beforeMetadataSha256 = sha256(existingRecord!.raw);
    beforePlistSha256 = sha256(existingPlist.content);
  }
  const observationBefore = await observeLaunchAgent(dependencies);
  const bootstrapPolicyInput = {
    dataRoot: canonicalDataRoot,
    policyId: bootstrapAuthorization.recoveryPolicyId,
    operation: 'SUPERVISOR_BOOTSTRAP' as const,
    requestId: bootstrapAuthorization.requestId,
    sourceSha: bootstrapAuthorization.sourceSha,
    sourceTree: bootstrapAuthorization.sourceTree,
    beforeMetadataSha256,
    beforePlistSha256,
    ...(initial ? { initialInstall: initialInstall! } : {}),
    protectedReferenceRoot: canonicalProtectedReferenceRoot,
    machineId,
    sourceRoot,
    controlScript: canonicalControlScript,
    executable,
    executableSha256,
    executableArguments,
    runtimePreflightSha256: runtimeEntrypoints.runtimePreflightSha256,
    runtimeLoaderSha256: runtimeEntrypoints.runtimeLoaderSha256,
  };
  const repeatedInitial = existingMetadata?.initialInstall;
  if (existingMetadata !== null && repeatedInitial !== undefined && repeatedInitial.policyId === bootstrapAuthorization.recoveryPolicyId && repeatedInitial.requestId === bootstrapAuthorization.requestId) {
    if (observationBefore.state !== 'LOADED') throw new RuntimeError('CONTROL_DENIED', 'Reinstalling a committed bootstrap requires fresh authorization');
    await requirePublishedContent(paths.plist, plist, 'IRIS private LaunchAgent', uid);
    await requirePublishedContent(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);
    requireLiveLaunchAgentIdentity(observationBefore.stdout, existingMetadata);
    await requireLiveProcessIdentity(observationBefore.stdout, existingMetadata, dependencies);
    const disabledState = await observeDisabledState(domain, launchctl);
    if (disabledState === 'UNKNOWN' || disabledState === 'EXPLICIT_DISABLED') throw new RuntimeError('CONTROL_DENIED', 'Re-enabling a committed Supervisor bootstrap requires fresh authorization');
    return paths;
  }
  const bootstrapReservation = await reserveRecoveryPolicyOperation(bootstrapPolicyInput);
  const finalizeBootstrap = async (state: 'COMMITTED' | 'RECONCILIATION_REQUIRED'): Promise<void> => {
    if (bootstrapReservation === null) return;
    await finalizeRecoveryPolicyOperation({ ...bootstrapPolicyInput, transactionId: bootstrapReservation.transactionId, state });
  };
  const reverifyBootstrapTarget = async (): Promise<void> => {
    await requireSourceGitIdentity(sourceRoot, bootstrapAuthorization.sourceSha, bootstrapAuthorization.sourceTree);
    const currentExecutableSha256 = await hashCanonicalFile(executable, 'Reviewed control executable', uid);
    if (currentExecutableSha256 !== executableSha256) throw new RuntimeError('CONTROL_DENIED', 'Reviewed control executable changed after authorization');
    const currentEntrypoints = await requireTargetRuntimeEntries(executableArguments, uid);
    if (currentEntrypoints.runtimePreflightSha256 !== runtimeEntrypoints.runtimePreflightSha256 || currentEntrypoints.runtimeLoaderSha256 !== runtimeEntrypoints.runtimeLoaderSha256) {
      throw new RuntimeError('CONTROL_DENIED', 'Reviewed runtime entrypoints changed after authorization');
    }
    if (initialInstall !== undefined) await verifyInitialTransport(canonicalDataRoot, initialInstall, uid);
    const currentMachineId = await readMachineId(canonicalDataRoot);
    if (currentMachineId !== machineId) throw new RuntimeError('CONTROL_DENIED', 'Protected machine identity changed after authorization');
  };
  const rollbackBootstrapAndReconcile = async (
    metadata: LaunchAgentMetadata,
    reason: NonNullable<LaunchAgentMetadata['unresolvedReason']>,
    cause: unknown,
    verifiedProcess?: LiveProcessIdentity,
  ): Promise<never> => {
    let rollbackError: unknown;
    try {
      await rollbackFailedInstall(paths, metadata, plist, reason, uid, dependencies, cause, verifiedProcess);
    } catch (error) {
      rollbackError = error;
    }
    let journalError: unknown;
    try {
      await finalizeBootstrap('RECONCILIATION_REQUIRED');
    } catch (error) {
      journalError = error;
    }
    if (rollbackError !== undefined && journalError !== undefined) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor bootstrap rollback and durable reconciliation both require reconciliation', {
        cause: new AggregateError([rollbackError, journalError], 'Supervisor bootstrap rollback and journal finalization failed'),
      });
    }
    if (rollbackError !== undefined) throw rollbackError;
    if (journalError !== undefined) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor bootstrap rollback completed but durable reconciliation failed', { cause: journalError });
    }
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor bootstrap failed and requires reconciliation', { cause });
  };
  const desiredBinding: Omit<LaunchAgentMetadata, 'state' | 'disabledBeforeInstall' | 'unresolvedReason'> = {
    schemaVersion: 3,
    label: LAUNCH_AGENT_LABEL,
    domain,
    dataRoot: canonicalDataRoot,
    sourceRoot,
    executable,
    controlScript: canonicalControlScript,
    executableArguments: [...executableArguments],
    plist: paths.plist,
    registeredPlist: paths.registeredPlist,
    plistSha256: sha256(plist),
  };
  if (existingMetadata?.legacyMigration !== undefined) {
    await completeLegacyPlistTransition(paths.plist, plist, existingMetadata.legacyMigration.plistSha256, uid);
  }

  if (observationBefore.state === 'LOADED') {
    if (existingMetadata === null) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'A loaded LaunchAgent has no durable ownership metadata');
    }
    requireMetadataBinding(existingMetadata, desiredBinding);
    await requirePublishedContent(paths.plist, plist, 'IRIS private LaunchAgent', uid);
    await requirePublishedContent(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);
    requireLiveLaunchAgentIdentity(observationBefore.stdout, existingMetadata);
    const liveProcess = await requireLiveProcessIdentity(observationBefore.stdout, existingMetadata, dependencies);
    try {
      const disabledState = await observeDisabledState(domain, launchctl);
      if (disabledState === 'UNKNOWN') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'The disabled state of the loaded LaunchAgent is unknown');
      if (disabledState === 'EXPLICIT_DISABLED' && bootstrapReservation === null) {
        throw new RuntimeError('CONTROL_DENIED', 'Re-enabling a committed Supervisor bootstrap requires a fresh authorization');
      }
      if (bootstrapReservation !== null) await ensureEnabledState(domain, serviceTarget, launchctl);
      await reverifyBootstrapTarget();
      const stableObservation = await observeLaunchAgent(dependencies);
      if (stableObservation.state !== 'LOADED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor process exited during bootstrap verification');
      requireLiveLaunchAgentIdentity(stableObservation.stdout, existingMetadata);
      const stableProcess = await requireLiveProcessIdentity(stableObservation.stdout, existingMetadata, dependencies);
      if (!sameLiveProcessIdentity(liveProcess, stableProcess)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor process identity changed during bootstrap verification');
      await writeLaunchAgentMetadata(paths.metadata, { ...existingMetadata, state: 'READY', unresolvedReason: null, processId: stableProcess.pid, processStartMarker: stableProcess.processStartMarker }, uid);
    } catch (error) {
      await finalizeBootstrap('RECONCILIATION_REQUIRED');
      await recordUnresolved(paths.metadata, existingMetadata, 'DISABLED_STATE_UNKNOWN', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Loaded LaunchAgent persistence could not be verified', { cause: error });
    }
    try {
      await finalizeBootstrap('COMMITTED');
    } catch (error) {
      await recordUnresolved(paths.metadata, existingMetadata, 'PUBLISHED_STATE_CHANGED', uid).catch(() => undefined);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Loaded LaunchAgent bootstrap authorization could not be finalized', { cause: error });
    }
    return paths;
  }

  if (existingMetadata !== null) requireMetadataBinding(existingMetadata, desiredBinding);

  await ensureOwnedDirectory(paths.directory, 'IRIS launchd directory', uid, true);
  await ensureOwnedDirectory(path.dirname(paths.stdout), 'IRIS log directory', uid, true);
  await ensureOwnedDirectory(paths.registrationDirectory, 'User LaunchAgents directory', uid, false);
  await requireCompatibleContent(paths.plist, plist, 'IRIS private LaunchAgent', uid);
  await requireCompatibleContent(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);

  const disabledStateBeforeInstall = existingMetadata?.disabledStateBeforeInstall ?? await observeDisabledState(domain, launchctl);
  if (disabledStateBeforeInstall === 'UNKNOWN') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `The disabled state of ${LAUNCH_AGENT_LABEL} in ${domain} is unknown`);
  }
  const preparedMetadata: LaunchAgentMetadata = {
    ...desiredBinding,
    state: 'PREPARED',
    disabledBeforeInstall: disabledStateBeforeInstall === 'EXPLICIT_DISABLED',
    disabledStateBeforeInstall,
    unresolvedReason: null,
    ...(existingMetadata?.legacyMigration === undefined ? {} : { legacyMigration: existingMetadata.legacyMigration }),
    ...(initial ? { initialInstall: { ...bootstrapPolicyInput, initialInstall: initialInstall!, transactionId: bootstrapReservation.transactionId } } : existingMetadata?.initialInstall === undefined ? {} : { initialInstall: existingMetadata.initialInstall }),
  };
  if (initial) await publishOwnedFile(paths.metadata, metadataContent(preparedMetadata), 'IRIS LaunchAgent metadata', uid);
  await publishOwnedFile(paths.plist, plist, 'IRIS private LaunchAgent', uid);
  if (!initial) await writeLaunchAgentMetadata(paths.metadata, preparedMetadata, uid);
  await publishOwnedFile(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);
  await requirePublishedContent(paths.plist, plist, 'IRIS private LaunchAgent', uid);
  await requirePublishedContent(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);
  const installingMetadata = { ...preparedMetadata, state: 'INSTALLING' as const };
  await writeLaunchAgentMetadata(paths.metadata, installingMetadata, uid);

  try {
    await ensureEnabledState(domain, serviceTarget, launchctl);
    await requirePublishedContent(paths.plist, plist, 'IRIS private LaunchAgent', uid);
    await requirePublishedContent(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);
    await reverifyBootstrapTarget();
  } catch (error) {
    await rollbackBootstrapAndReconcile(installingMetadata, 'DISABLED_STATE_UNKNOWN', error);
  }

  let bootstrapError: unknown;
  let verifiedProcess: LiveProcessIdentity | undefined;
  try { await launchctl(['bootstrap', domain, paths.registeredPlist]); } catch (error) { bootstrapError = error; }
  let observationAfter: LaunchAgentObservation;
  try { observationAfter = await observeLaunchAgent(dependencies); }
  catch (error) {
    await finalizeBootstrap('RECONCILIATION_REQUIRED');
    await recordUnresolved(paths.metadata, installingMetadata, 'BOOTSTRAP_OUTCOME_UNKNOWN', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent bootstrap outcome requires reconciliation', { cause: error });
  }
  if (observationAfter.state === 'ABSENT') {
    return rollbackBootstrapAndReconcile(installingMetadata, 'BOOTSTRAP_OUTCOME_UNKNOWN', bootstrapError);
  }
  try { requireLiveLaunchAgentIdentity(observationAfter.stdout, installingMetadata); }
  catch (error) {
    await finalizeBootstrap('RECONCILIATION_REQUIRED');
    await recordUnresolved(paths.metadata, installingMetadata, 'LIVE_IDENTITY_UNVERIFIED', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Loaded LaunchAgent identity is not the requested installation', { cause: error });
  }
  try {
    const liveProcess = await requireLiveProcessIdentity(observationAfter.stdout, installingMetadata, dependencies);
    verifiedProcess = liveProcess;
    await requirePublishedContent(paths.plist, plist, 'IRIS private LaunchAgent', uid);
    await requirePublishedContent(paths.registeredPlist, plist, 'IRIS registered LaunchAgent', uid);
    const installedDisabledState = await observeDisabledState(domain, launchctl);
    if (installedDisabledState === 'UNKNOWN' || installedDisabledState === 'EXPLICIT_DISABLED') {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'The installed LaunchAgent is disabled or its state is unknown');
    }
    await reverifyBootstrapTarget();
    await writeLaunchAgentMetadata(paths.metadata, { ...installingMetadata, state: 'READY', unresolvedReason: null, processId: liveProcess.pid, processStartMarker: liveProcess.processStartMarker }, uid);
  } catch (error) {
    await rollbackBootstrapAndReconcile(installingMetadata, 'PUBLISHED_STATE_CHANGED', error, verifiedProcess);
  }
  try {
    await reverifyBootstrapTarget();
    const finalObservation = await observeLaunchAgent(dependencies);
    if (finalObservation.state !== 'LOADED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor process exited before bootstrap commit');
    requireLiveLaunchAgentIdentity(finalObservation.stdout, installingMetadata);
    const finalProcess = await requireLiveProcessIdentity(finalObservation.stdout, installingMetadata, dependencies);
    if (verifiedProcess === undefined || !sameLiveProcessIdentity(verifiedProcess, finalProcess)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor process identity changed before bootstrap commit');
    await finalizeBootstrap('COMMITTED');
  } catch (error) {
    await rollbackBootstrapAndReconcile(installingMetadata, 'PUBLISHED_STATE_CHANGED', error, verifiedProcess);
  }
  return paths;
}

export async function uninstallLaunchAgent(dataRoot: string, dependencies: LaunchdDependencies = {}): Promise<void> {
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  await withLaunchAgentLock(paths, uid, () => uninstallLaunchAgentUnlocked(canonicalDataRoot, dependencies));
}

async function uninstallLaunchAgentUnlocked(dataRoot: string, dependencies: LaunchdDependencies = {}): Promise<void> {
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(dataRoot, 'IRIS data root', uid, true);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  const domain = launchdDomain(dependencies);
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);
  const metadataRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  if (metadataRecord?.metadata.schemaVersion === 1) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Legacy LaunchAgent metadata requires an authorized install migration before uninstall');
  }
  const metadata = metadataRecord?.metadata ?? null;
  const observation = await observeLaunchAgent(dependencies);
  if (metadata === null) {
    const registered = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
    const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
    if (observation.state === 'LOADED' || registered.state !== 'missing' || privatePlist.state !== 'missing') {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent ownership metadata is unavailable; refusing unverified removal');
    }
    return;
  }
  if (metadata.dataRoot !== canonicalDataRoot || metadata.domain !== domain || metadata.plist !== paths.plist || metadata.registeredPlist !== paths.registeredPlist) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent ownership metadata conflicts with the requested installation');
  }
  const registered = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  for (const inspected of [registered, privatePlist]) {
    if (inspected.state === 'invalid') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', inspected.reason);
    if (inspected.state === 'ok' && sha256(inspected.content) !== metadata.plistSha256) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent content no longer matches its durable ownership metadata');
    }
  }
  if (observation.state === 'LOADED') requireLiveLaunchAgentIdentity(observation.stdout, metadata);
  await writeLaunchAgentMetadata(paths.metadata, { ...metadata, state: 'UNINSTALLING', unresolvedReason: null }, uid);
  if (observation.state === 'LOADED') {
    let bootoutError: unknown;
    try { await launchctl(['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]); } catch (error) { bootoutError = error; }
    let afterBootout: LaunchAgentObservation;
    try { afterBootout = await observeLaunchAgent(dependencies); }
    catch (error) {
      await recordUnresolved(paths.metadata, metadata, 'BOOTOUT_OUTCOME_UNKNOWN', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent unload outcome requires reconciliation', { cause: error });
    }
    if (afterBootout.state === 'LOADED') {
      await recordUnresolved(paths.metadata, metadata, 'BOOTOUT_OUTCOME_UNKNOWN', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Could not safely unload the IRIS LaunchAgent', { cause: bootoutError });
    }
  }
  try { await restoreDisabledState(storedDisabledState(metadata), domain, `${domain}/${LAUNCH_AGENT_LABEL}`, launchctl); }
  catch (error) {
    await recordUnresolved(paths.metadata, metadata, 'DISABLED_STATE_UNKNOWN', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent disabled-state restoration requires reconciliation', { cause: error });
  }
  await removeOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  await removeOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  await removeOwnedFile(paths.metadata, 'IRIS LaunchAgent metadata', uid);
}

async function withLaunchAgentLock<T>(paths: LaunchdPaths, uid: number, operation: () => Promise<T>): Promise<T> {
  await ensureOwnedDirectory(paths.directory, 'IRIS launchd directory', uid, true);
  const lockContent = `${JSON.stringify({ schemaVersion: 1, label: LAUNCH_AGENT_LABEL, pid: process.pid, requestId: randomUUID() })}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(paths.operationLock, 'wx', 0o600);
    await handle.writeFile(lockContent, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isAlreadyExists(error)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Another LaunchAgent lifecycle operation is active or requires reconciliation');
    throw new RuntimeError('PERSISTENCE_FAILURE', 'LaunchAgent lifecycle lock could not be established', { cause: error });
  }
  let succeeded = false;
  let result!: T;
  let operationError: unknown;
  try {
    result = await operation();
    succeeded = true;
  } catch (error) {
    operationError = error;
  }
  let lockError: unknown;
  try {
    const inspected = await inspectOwnedFile(paths.operationLock, 'IRIS LaunchAgent lifecycle lock', uid);
    if (inspected.state !== 'ok' || inspected.content !== lockContent) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent lifecycle lock ownership is unresolved');
    }
    await rm(paths.operationLock);
    await syncDirectory(path.dirname(paths.operationLock));
  } catch (error) {
    lockError = error;
  }
  if (lockError !== undefined) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent lifecycle lock cleanup requires reconciliation', {
      cause: operationError ?? lockError,
    });
  }
  if (!succeeded) throw operationError;
  return result;
}

export async function launchAgentStatus(dataRoot: string, dependencies: LaunchdDependencies = {}): Promise<LaunchdStatus> {
  const paths = launchdPaths(dataRoot, dependencies.homeDirectory ?? os.homedir());
  const domain = launchdDomain(dependencies);
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);
  const metadataRecord = await readLaunchAgentMetadata(paths.metadata, launchdUid(dependencies));
  if (metadataRecord?.metadata.schemaVersion === 1) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Legacy LaunchAgent metadata requires an authorized install migration');
  }
  const metadata = metadataRecord?.metadata ?? null;
  const registered = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', launchdUid(dependencies));
  if (registered.state === 'invalid') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', registered.reason);
  if (registered.state === 'ok' && (metadata === null || metadata.registeredPlist !== paths.registeredPlist || sha256(registered.content) !== metadata.plistSha256)) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Registered LaunchAgent does not match durable ownership metadata');
  }
  const observation = await observeLaunchAgent(dependencies);
  if (observation.state === 'LOADED') {
    if (metadata === null) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Loaded LaunchAgent has no durable ownership metadata');
    requireLiveLaunchAgentIdentity(observation.stdout, metadata);
  }
  const disabledState = await observeDisabledState(domain, launchctl);
  if (disabledState === 'UNKNOWN') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `The disabled state of ${LAUNCH_AGENT_LABEL} in ${domain} is unknown`);
  return { domain, loaded: observation.state === 'LOADED', disabled: disabledState === 'EXPLICIT_DISABLED', disabledState, registered: registered.state === 'ok', paths };
}

export async function launchAgentLoaded(dependencies: LaunchdDependencies = {}): Promise<boolean> {
  return (await observeLaunchAgent(dependencies)).state === 'LOADED';
}

async function observeLaunchAgent(dependencies: LaunchdDependencies): Promise<LaunchAgentObservation> {
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  const attempts = dependencies.launchctl === undefined ? 50 : 1;
  let lastUnknown: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { stdout } = await launchctl(['print', `${launchdDomain(dependencies)}/${LAUNCH_AGENT_LABEL}`]);
      return { state: 'LOADED', stdout };
    } catch (error) {
      if (launchAgentAbsent(error, launchdDomain(dependencies))) return { state: 'ABSENT' };
      lastUnknown = error;
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent state remained unknown after reconciliation', { cause: lastUnknown });
}

async function rollbackFailedInstall(
  paths: LaunchdPaths,
  metadata: LaunchAgentMetadata,
  plist: string,
  reason: NonNullable<LaunchAgentMetadata['unresolvedReason']>,
  uid: number,
  dependencies: LaunchdDependencies,
  cause: unknown,
  verifiedProcess?: LiveProcessIdentity,
): Promise<never> {
  const domain = metadata.domain;
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  let observation: LaunchAgentObservation;
  try { observation = await observeLaunchAgent(dependencies); }
  catch (error) {
    await recordUnresolved(paths.metadata, metadata, reason, uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent install outcome requires reconciliation', { cause: error });
  }
  if (observation.state === 'LOADED') {
    try {
      requireLiveLaunchAgentIdentity(observation.stdout, metadata);
      const currentProcess = await requireLiveProcessIdentity(observation.stdout, metadata, dependencies);
      if (verifiedProcess !== undefined && !sameLiveProcessIdentity(verifiedProcess, currentProcess)) {
        throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Refusing to unload a LaunchAgent whose process identity changed');
      }
    }
    catch (error) {
      await recordUnresolved(paths.metadata, metadata, 'LIVE_IDENTITY_UNVERIFIED', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Refusing to unload a LaunchAgent whose live identity is unverified', { cause: error });
    }
    let bootoutError: unknown;
    try { await launchctl(['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]); } catch (error) { bootoutError = error; }
    let afterBootout: LaunchAgentObservation;
    try { afterBootout = await observeLaunchAgent(dependencies); }
    catch (error) {
      await recordUnresolved(paths.metadata, metadata, 'BOOTOUT_OUTCOME_UNKNOWN', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent rollback outcome requires reconciliation', { cause: error });
    }
    if (afterBootout.state === 'LOADED') {
      await recordUnresolved(paths.metadata, metadata, 'BOOTOUT_OUTCOME_UNKNOWN', uid);
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent rollback could not verify process exit', { cause: bootoutError });
    }
  }
  try { await restoreDisabledState(storedDisabledState(metadata), domain, `${domain}/${LAUNCH_AGENT_LABEL}`, launchctl); }
  catch (error) {
    await recordUnresolved(paths.metadata, metadata, 'DISABLED_STATE_UNKNOWN', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent disabled-state rollback requires reconciliation', { cause: error });
  }
  const registered = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if (registered.state === 'invalid' || registered.state === 'ok' && registered.content !== plist) {
    await recordUnresolved(paths.metadata, metadata, 'PUBLISHED_STATE_CHANGED', uid);
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent registration changed during rollback');
  }
  if (registered.state === 'ok') await removeOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  await writeLaunchAgentMetadata(paths.metadata, { ...metadata, state: 'PREPARED', unresolvedReason: null }, uid);
  throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Could not install the IRIS LaunchAgent', { cause });
}

async function completeLegacyPlistTransition(filename: string, desired: string, legacySha256: string, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(filename, 'IRIS private LaunchAgent', uid);
  if (inspected.state !== 'ok') {
    throw new RuntimeError('PERSISTENCE_FAILURE', inspected.state === 'invalid' ? inspected.reason : 'IRIS private LaunchAgent is missing during legacy migration');
  }
  if (inspected.content === desired) return;
  if (sha256(inspected.content) !== legacySha256) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Legacy LaunchAgent changed during metadata migration');
  }
  await replaceOwnedFile(filename, inspected.content, desired, 'IRIS private LaunchAgent', uid);
}

function requireLiveLaunchAgentIdentity(stdout: string, metadata: LaunchAgentMetadata): void {
  if (!stdout.split(/\r?\n/).some((line) => line.trim() === `${metadata.domain}/${metadata.label} = {`)) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Live LaunchAgent label is not the recorded service');
  }
  const live = parseLiveLaunchAgentIdentity(stdout);
  const expectedArguments = [metadata.executable, ...metadata.executableArguments, metadata.controlScript, 'supervisor'];
  if (live.registeredPlist !== metadata.registeredPlist
    || live.executable !== metadata.executable
    || live.workingDirectory !== metadata.sourceRoot
    || live.dataRoot !== metadata.dataRoot
    || live.arguments.length !== expectedArguments.length
    || live.arguments.some((argument, index) => argument !== expectedArguments[index])) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Live LaunchAgent identity conflicts with durable ownership metadata');
  }
}

async function requireLiveProcessIdentity(stdout: string, metadata: LaunchAgentMetadata, dependencies: LaunchdDependencies): Promise<LiveProcessIdentity> {
  const live = parseLiveLaunchAgentIdentity(stdout);
  const startObservation = (dependencies.observeProcessStart ?? observeProcessStart)(live.pid);
  if (startObservation.state !== 'live') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor process start identity could not be verified');
  }
  const executable = (dependencies.observeProcessExecutable ?? observeProcessExecutable)(live.pid);
  if (executable !== metadata.executable) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor process executable identity conflicts with durable ownership metadata');
  }
  return { pid: live.pid, processStartMarker: startObservation.marker, executable };
}

function sameLiveProcessIdentity(left: LiveProcessIdentity, right: LiveProcessIdentity): boolean {
  return left.pid === right.pid && left.processStartMarker === right.processStartMarker && left.executable === right.executable;
}

function parseLiveLaunchAgentIdentity(stdout: string): LiveLaunchAgentIdentity {
  const lines = stdout.split(/\r?\n/);
  const pidText = launchctlScalar(lines, 'pid');
  const registeredPlist = launchctlScalar(lines, 'path');
  const executable = launchctlScalar(lines, 'program');
  const workingDirectory = launchctlScalar(lines, 'working directory');
  const dataRoot = launchctlMapping(lines, 'environment', RUNTIME_DATA_ENV);
  const argumentsList = launchctlList(lines, 'arguments');
  if (pidText === null || !/^\d+$/.test(pidText) || Number(pidText) <= 0 || registeredPlist === null || executable === null || workingDirectory === null || dataRoot === null || argumentsList === null) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Live LaunchAgent identity output is incomplete');
  }
  return { pid: Number(pidText), registeredPlist, executable, arguments: argumentsList, workingDirectory, dataRoot };
}

function launchctlScalar(lines: readonly string[], key: string): string | null {
  const prefix = `${key} = `;
  const matches = lines.map((line) => line.trim()).filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) return null;
  return decodeLaunchctlValue(matches[0]!.slice(prefix.length));
}

function launchctlList(lines: readonly string[], key: string): readonly string[] | null {
  const block = launchctlBlock(lines, `${key} = {`);
  if (block === null || block.length === 0) return null;
  const values = block.map(decodeLaunchctlValue);
  return values.every((value): value is string => value !== null) ? values : null;
}

function launchctlMapping(lines: readonly string[], blockName: string, key: string): string | null {
  const block = launchctlBlock(lines, `${blockName} = {`);
  if (block === null) return null;
  const prefix = `${key} => `;
  const matches = block.filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) return null;
  return decodeLaunchctlValue(matches[0]!.slice(prefix.length));
}

function launchctlBlock(lines: readonly string[], header: string): readonly string[] | null {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const value = lines[index]!.trim();
    if (value === '}') return values;
    if (value.length === 0 || value.includes('\0')) return null;
    values.push(value);
  }
  return null;
}

function decodeLaunchctlValue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('\0')) return null;
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    const decoded = JSON.parse(trimmed) as unknown;
    return typeof decoded === 'string' && !decoded.includes('\0') ? decoded : null;
  } catch { return null; }
}

async function ensureEnabledState(
  domain: string,
  serviceTarget: string,
  launchctl: NonNullable<LaunchdDependencies['launchctl']>,
): Promise<void> {
  const current = await observeDisabledState(domain, launchctl);
  if (current === 'EXPLICIT_ENABLED' || current === 'NO_EXPLICIT_OVERRIDE') return;
  if (current === 'UNKNOWN') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `The disabled state of ${LAUNCH_AGENT_LABEL} in ${domain} is unknown`);
  let commandError: unknown;
  try { await launchctl(['enable', serviceTarget]); } catch (error) { commandError = error; }
  const restored = await observeDisabledState(domain, launchctl);
  if (restored !== 'EXPLICIT_ENABLED' && restored !== 'NO_EXPLICIT_OVERRIDE') {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `Could not enable the IRIS LaunchAgent`, { cause: commandError });
  }
}

async function restoreDisabledState(
  expected: DisabledState,
  domain: string,
  serviceTarget: string,
  launchctl: NonNullable<LaunchdDependencies['launchctl']>,
): Promise<void> {
  if (expected === 'UNKNOWN') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'The original LaunchAgent disabled state is unknown');
  const current = await observeDisabledState(domain, launchctl);
  if (current === expected) return;
  if (current === 'UNKNOWN') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `The disabled state of ${LAUNCH_AGENT_LABEL} in ${domain} is unknown`);
  let commandError: unknown;
  try { await launchctl([expected === 'EXPLICIT_DISABLED' ? 'disable' : 'enable', serviceTarget]); } catch (error) { commandError = error; }
  if (await observeDisabledState(domain, launchctl) !== expected) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Could not restore the IRIS LaunchAgent disabled state', { cause: commandError });
  }
}

function storedDisabledState(metadata: LaunchAgentMetadata): DisabledState {
  return metadata.disabledStateBeforeInstall ?? (metadata.disabledBeforeInstall ? 'EXPLICIT_DISABLED' : 'EXPLICIT_ENABLED');
}

async function recordUnresolved(
  filename: string,
  metadata: LaunchAgentMetadata,
  unresolvedReason: NonNullable<LaunchAgentMetadata['unresolvedReason']>,
  uid: number,
): Promise<void> {
  await writeLaunchAgentMetadata(filename, { ...metadata, state: 'RECONCILIATION_REQUIRED', unresolvedReason }, uid);
}

function launchAgentAbsent(error: unknown, domain: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as { readonly code?: unknown; readonly stdout?: unknown; readonly stderr?: unknown; readonly message?: unknown; readonly killed?: unknown; readonly signal?: unknown };
  if (failure.code !== 113 || failure.stdout !== '' || failure.killed === true || failure.signal !== undefined && failure.signal !== null) return false;
  const expected = `Could not find service "${LAUNCH_AGENT_LABEL}" in domain for user gui: ${domain.slice('gui/'.length)}`;
  if (typeof failure.stderr !== 'string' || ![expected, `Bad request.\n${expected}`].includes(failure.stderr.trim())) return false;
  const diagnostics = [failure.stderr, failure.message].filter((value): value is string => typeof value === 'string').join('\n');
  return !/permission denied|operation not permitted|not authorized|authorization/i.test(diagnostics);
}

async function requireGuiDomain(domain: string, launchctl: NonNullable<LaunchdDependencies['launchctl']>): Promise<void> {
  try { await launchctl(['print', domain]); }
  catch (error) { throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `The ${domain} launchd domain is unavailable`, { cause: error }); }
}

async function observeDisabledState(domain: string, launchctl: NonNullable<LaunchdDependencies['launchctl']>): Promise<DisabledState> {
  let stdout: string;
  try { ({ stdout } = await launchctl(['print-disabled', domain])); }
  catch (error) { throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `Could not inspect disabled services in ${domain}`, { cause: error }); }
  return parseLaunchAgentDisabled(stdout);
}

function parseLaunchAgentDisabled(stdout: string): DisabledState {
  if (stdout.length > 1_048_576 || stdout.includes('\0')) return 'UNKNOWN';
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines[0] !== 'disabled services = {' || lines.at(-1) !== '}' || lines.length < 2) return 'UNKNOWN';
  const matches: DisabledState[] = [];
  for (const line of lines.slice(1, -1)) {
    const entry = /^("(?:[^"\\]|\\.)+")\s*=>\s*(enabled|disabled|true|false)$/.exec(line);
    if (entry === null) return 'UNKNOWN';
    let label: unknown;
    try { label = JSON.parse(entry[1]!); } catch { return 'UNKNOWN'; }
    if (label === LAUNCH_AGENT_LABEL) matches.push(entry[2] === 'disabled' || entry[2] === 'true' ? 'EXPLICIT_DISABLED' : 'EXPLICIT_ENABLED');
  }
  if (matches.length > 1) return 'UNKNOWN';
  return matches[0] ?? 'NO_EXPLICIT_OVERRIDE';
}

async function systemLaunchctl(argumentsList: readonly string[]): Promise<{ readonly stdout: string }> {
  try {
    const timeout = argumentsList[0] === 'bootout' && argumentsList[1] === '--wait' ? 60_000 : 5_000;
    const result = await execFileAsync('/bin/launchctl', [...argumentsList], { encoding: 'utf8', timeout });
    return { stdout: String(result.stdout) };
  } catch (error) {
    if (launchctlOutcomeUnknown(error)) throw new LaunchctlOutcomeUnknown('launchctl outcome is unknown', { cause: error });
    throw error;
  }
}

async function ensureOwnedDirectory(directory: string, label: string, uid: number, privateDirectory: boolean): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory).catch((error) => { throw new RuntimeError('PERSISTENCE_FAILURE', `${label} metadata is unavailable`, { cause: error }); });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is not a physical directory`);
  if (metadata.uid !== uid) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is not owned by the current user`);
  if ((metadata.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} permissions permit unsafe access`);
  if (await realpath(directory) !== path.resolve(directory)) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} changed through a filesystem alias`);
}

async function requireCanonicalDirectory(directory: string, label: string, uid: number, privateDirectory: boolean): Promise<string> {
  const absolute = path.resolve(directory);
  const physical = await realpath(absolute).catch((error) => { throw new RuntimeError('PERSISTENCE_FAILURE', `${label} cannot be resolved`, { cause: error }); });
  if (physical !== absolute) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} changed through a filesystem alias`);
  const metadata = await lstat(physical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) {
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} ownership or permissions are unsafe`);
  }
  return physical;
}

async function requireCanonicalFile(filename: string, label: string, uid: number): Promise<string> {
  const absolute = path.resolve(filename);
  const physical = await realpath(absolute).catch((error) => { throw new RuntimeError('PERSISTENCE_FAILURE', `${label} cannot be resolved`, { cause: error }); });
  const metadata = await lstat(physical);
  if (physical !== absolute || !metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o022) !== 0) {
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is not a canonical owner-controlled physical file`);
  }
  return physical;
}

async function hashCanonicalFile(filename: string, label: string, uid: number): Promise<string> {
  const physical = await requireCanonicalFile(filename, label, uid);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(physical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o022) !== 0) {
      throw new RuntimeError('PERSISTENCE_FAILURE', `${label} ownership or permissions are unsafe`);
    }
    return createHash('sha256').update(await handle.readFile()).digest('hex');
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} cannot be hashed`, { cause: error });
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

/** Resolve the pnpm tsx link to owner-controlled files inside the reviewed source. */
export async function resolveReviewedRuntimeEntrypoints(runtimeDirectory: string): Promise<{
  readonly preflight: string;
  readonly loader: string;
}> {
  const uid = launchdUid({});
  const sourceRoot = path.resolve(runtimeDirectory, '../..');
  const nodeModulesRoot = await requireCanonicalDirectory(path.join(sourceRoot, 'node_modules'), 'Reviewed source dependencies', uid, false);
  const packageRoot = await realpath(path.join(runtimeDirectory, 'node_modules', 'tsx')).catch((error) => {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Reviewed runtime dependency cannot be resolved', { cause: error });
  });
  const relative = path.relative(nodeModulesRoot, packageRoot);
  if (relative.length === 0 || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.basename(packageRoot) !== 'tsx') {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Reviewed runtime dependency is outside the reviewed source');
  }
  let current = nodeModulesRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    await requireCanonicalDirectory(current, 'Reviewed runtime dependency directory', uid, false);
  }
  await requireCanonicalDirectory(path.join(packageRoot, 'dist'), 'Reviewed runtime dependency directory', uid, false);
  const preflight = await requireCanonicalFile(path.join(packageRoot, 'dist', 'preflight.cjs'), 'Reviewed runtime entrypoint', uid);
  const loader = await requireCanonicalFile(path.join(packageRoot, 'dist', 'loader.mjs'), 'Reviewed runtime entrypoint', uid);
  return { preflight, loader };
}

type OwnedFileInspection = { readonly state: 'missing' } | { readonly state: 'invalid'; readonly reason: string } | { readonly state: 'ok'; readonly content: string };

async function inspectOwnedFile(filename: string, label: string, uid: number): Promise<OwnedFileInspection> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { return isNotFound(error) ? { state: 'missing' } : { state: 'invalid', reason: `${label} is not a physical file` }; }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) return { state: 'invalid', reason: `${label} ownership or permissions are unsafe` };
    return { state: 'ok', content: await handle.readFile('utf8') };
  } catch { return { state: 'invalid', reason: `${label} is unreadable` }; }
  finally { await handle.close().catch(() => undefined); }
}

async function publishOwnedFile(filename: string, content: string, label: string, uid: number, syncDirectoryFn = syncDirectory): Promise<void> {
  const existing = await inspectOwnedFile(filename, label, uid);
  if (existing.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', existing.reason);
  if (existing.state === 'ok') {
    if (existing.content === content) return;
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} conflicts with the requested installation`);
  }
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, filename);
    await syncDirectoryFn(path.dirname(filename));
  } catch (error) {
    if (!isAlreadyExists(error)) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} publication failed`, { cause: error });
    const concurrent = await inspectOwnedFile(filename, label, uid);
    if (concurrent.state !== 'ok' || concurrent.content !== content) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} publication conflicted with another writer`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function requireCompatibleContent(filename: string, content: string, label: string, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(filename, label, uid);
  if (inspected.state === 'missing') return;
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  if (inspected.content !== content) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} conflicts with the requested installation`);
}

async function writeLaunchAgentMetadata(filename: string, metadata: LaunchAgentMetadata, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(filename, 'IRIS LaunchAgent metadata', uid);
  if (inspected.state !== 'ok') {
    throw new RuntimeError('PERSISTENCE_FAILURE', inspected.state === 'invalid' ? inspected.reason : 'IRIS LaunchAgent metadata is missing');
  }
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(metadataContent(metadata), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } catch (error) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'IRIS LaunchAgent metadata update failed', { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function replaceOwnedFile(filename: string, expected: string, content: string, label: string, uid: number, syncDirectoryFn = syncDirectory): Promise<void> {
  const inspected = await inspectOwnedFile(filename, label, uid);
  if (inspected.state !== 'ok' || inspected.content !== expected) {
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} changed before its authorized replacement`);
  }
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    const beforeRename = await inspectOwnedFile(filename, label, uid);
    if (beforeRename.state !== 'ok' || beforeRename.content !== expected) {
      throw new RuntimeError('PERSISTENCE_FAILURE', `${label} changed during its authorized replacement`);
    }
    await rename(temporary, filename);
    await syncDirectoryFn(path.dirname(filename));
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} replacement failed`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function archiveSourceApproval(paths: LaunchdPaths, record: LaunchAgentSourceApprovalRecord, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(paths.sourceBindingApprovalHistory, 'IRIS source migration approval history', uid);
  let entries: readonly unknown[] = [];
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  if (inspected.state === 'ok') {
    try {
      const parsed: unknown = JSON.parse(inspected.content);
      if (!Array.isArray(parsed) || parsed.length > 64) throw new Error('invalid approval history');
      entries = parsed;
    } catch (error) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'IRIS source migration approval history is invalid', { cause: error });
    }
  }
  const duplicate = entries.find((entry) => typeof entry === 'object' && entry !== null
    && 'record' in entry && typeof entry.record === 'object' && entry.record !== null
    && 'approvalId' in entry.record && entry.record.approvalId === record.approvalId);
  if (duplicate !== undefined) {
    if (typeof duplicate !== 'object' || duplicate === null || !('record' in duplicate)
      || JSON.stringify(duplicate.record) !== JSON.stringify(record)) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'IRIS source migration approval history conflicts with the superseded approval');
    }
    return;
  }
  const content = `${JSON.stringify([...entries, { archivedAt: new Date().toISOString(), record }], null, 2)}\n`;
  if (inspected.state === 'missing') await publishOwnedFile(paths.sourceBindingApprovalHistory, content, 'IRIS source migration approval history', uid);
  else await replaceOwnedFile(paths.sourceBindingApprovalHistory, inspected.content, content, 'IRIS source migration approval history', uid);
}

async function archiveSourceMigration(paths: LaunchdPaths, raw: string, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(paths.sourceBindingMigrationHistory, 'IRIS source migration history', uid);
  let entries: readonly unknown[] = [];
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  if (inspected.state === 'ok') {
    try {
      const parsed: unknown = JSON.parse(inspected.content);
      if (!Array.isArray(parsed) || parsed.length > 32) throw new Error('invalid migration history');
      entries = parsed;
    } catch (error) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'IRIS source migration history is invalid', { cause: error });
    }
  }
  const digest = sha256(raw);
  if (entries.some((entry) => typeof entry === 'object' && entry !== null && 'rawSha256' in entry && entry.rawSha256 === digest)) return;
  const content = `${JSON.stringify([...entries, { archivedAt: new Date().toISOString(), rawSha256: digest, raw }], null, 2)}\n`;
  if (inspected.state === 'missing') await publishOwnedFile(paths.sourceBindingMigrationHistory, content, 'IRIS source migration history', uid);
  else await replaceOwnedFile(paths.sourceBindingMigrationHistory, inspected.content, content, 'IRIS source migration history', uid);
}

function metadataContent(metadata: LaunchAgentMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function migrationContent(record: LaunchAgentSourceMigrationRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function malformedApprovalRecoveryContent(record: MalformedLegacyApprovalReconciliationRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

async function persistMalformedApprovalRecovery(
  paths: LaunchdPaths,
  expected: MalformedLegacyApprovalReconciliationRecord,
  next: MalformedLegacyApprovalReconciliationRecord,
  uid: number,
  syncDirectoryFn: (directory: string) => Promise<void>,
): Promise<boolean> {
  const content = malformedApprovalRecoveryContent(next);
  try { await replaceOwnedFile(paths.sourceBindingApprovalRecovery, malformedApprovalRecoveryContent(expected), content, 'IRIS malformed approval recovery', uid, syncDirectoryFn); }
  catch { /* readback below distinguishes a durable rename from an unknown outcome */ }
  try {
    await syncDirectoryFn(path.dirname(paths.sourceBindingApprovalRecovery));
    const readback = await inspectOwnedFile(paths.sourceBindingApprovalRecovery, 'IRIS malformed approval recovery', uid);
    return readback.state === 'ok' && readback.content === content;
  } catch { return false; }
}

async function readSourceMigrationRecord(filename: string, uid: number): Promise<LaunchAgentSourceMigrationRecord | null> {
  const inspected = await inspectOwnedFile(filename, 'IRIS source migration record', uid);
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', inspected.reason);
  try {
    const value = JSON.parse(inspected.content) as Partial<LaunchAgentSourceMigrationRecord>;
    if (value.schemaVersion !== 1 || value.label !== LAUNCH_AGENT_LABEL
      || !['PREPARED', 'APPLYING', 'COMMITTED', 'RECONCILIATION_REQUIRED'].includes(String(value.state))
      || typeof value.transactionId !== 'string' || typeof value.requestId !== 'string'
      || typeof value.targetSourceSha !== 'string' || typeof value.targetSourceTree !== 'string'
      || !/^[a-f0-9]{64}$/.test(String(value.runtimePreflightSha256))
      || !/^[a-f0-9]{64}$/.test(String(value.runtimeLoaderSha256))
      || (value.disabledStateBeforeMigration !== undefined && !['EXPLICIT_ENABLED', 'EXPLICIT_DISABLED', 'NO_EXPLICIT_OVERRIDE', 'UNKNOWN'].includes(String(value.disabledStateBeforeMigration)))) throw new Error('invalid source migration record');
    return value as LaunchAgentSourceMigrationRecord;
  } catch (error) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'IRIS source migration record is invalid', { cause: error });
  }
}

type MigrationBindingPreflight = {
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly protectedReferenceRoot?: string;
  readonly domain: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
  readonly runtimePreflightSha256: string;
  readonly runtimeLoaderSha256: string;
};

async function inspectMigrationBinding(
  input: LaunchAgentSourceApprovalInput,
  dependencies: LaunchdDependencies,
): Promise<MigrationBindingPreflight> {
  const uid = launchdUid(dependencies);
  const canonicalDataRoot = await requireCanonicalDirectory(input.dataRoot, 'IRIS data root', uid, true);
  const canonicalSourceRoot = await requireCanonicalDirectory(input.sourceRoot, 'IRIS control source root', uid, false);
  const canonicalControlScript = await requireCanonicalFile(input.controlScript, 'IRIS control script', uid);
  if (sourceRootForControlScript(canonicalControlScript) !== canonicalSourceRoot) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Control script is outside the requested source root');
  const executable = await realpath(input.executable).catch((error) => { throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Reviewed control executable cannot be resolved', { cause: error }); });
  if (executable !== await realpath(canonicalNodeRuntime().path)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Reviewed control executable is not the supported Node runtime');
  const runtimeEntrypoints = await requireTargetRuntimeEntries(input.executableArguments, uid);
  await requireSourceGitIdentity(canonicalSourceRoot, input.sourceSha, input.sourceTree);
  const canonicalProtectedReferenceRoot = input.protectedReferenceRoot === undefined
    ? undefined
    : await requireCanonicalDirectory(input.protectedReferenceRoot, 'IRIS protected reference root', uid, false);
  const paths = launchdPaths(canonicalDataRoot, dependencies.homeDirectory ?? os.homedir());
  const domain = launchdDomain(dependencies);
  const launchctl = dependencies.launchctl ?? systemLaunchctl;
  await requireGuiDomain(domain, launchctl);
  if ((await observeLaunchAgent(dependencies)).state !== 'ABSENT') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'A loaded LaunchAgent must be stopped before source migration');
  const legacyRecord = await readLaunchAgentMetadata(paths.metadata, uid);
  if (legacyRecord === null) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Source migration requires durable LaunchAgent metadata');
  const privatePlist = await inspectOwnedFile(paths.plist, 'IRIS private LaunchAgent', uid);
  if (privatePlist.state !== 'ok') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Legacy private LaunchAgent plist is unavailable');
  const registeredPlist = await inspectOwnedFile(paths.registeredPlist, 'IRIS registered LaunchAgent', uid);
  if (registeredPlist.state !== 'missing') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'A registered LaunchAgent conflicts with source migration');
  const legacy = legacyRecord.metadata;
  const legacyPlist = legacy.schemaVersion === 1
    ? renderLaunchAgent(canonicalDataRoot, legacy.executable, legacy.controlScript, legacy.executableArguments)
    : privatePlist.content;
  if (legacy.schemaVersion === 1) {
    if (legacy.plist !== paths.plist || privatePlist.content !== legacyPlist) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Legacy LaunchAgent binding does not match its durable metadata');
  } else {
    if (legacy.dataRoot !== canonicalDataRoot || legacy.domain !== domain || legacy.plist !== paths.plist || legacy.registeredPlist !== paths.registeredPlist
      || legacy.state === 'RECONCILIATION_REQUIRED' || legacy.plistSha256 !== sha256(privatePlist.content)) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Schema-3 LaunchAgent binding is not an exact stopped source before-image');
    }
    const migration = await readSourceMigrationRecord(paths.sourceBindingMigration, uid);
    if (legacy.initialInstall !== undefined) await verifyInitialInstallProvenance(legacy, paths, uid);
    else if (migration === null || migration.state !== 'COMMITTED'
      || migration.targetSourceRoot !== legacy.sourceRoot
      || migration.targetControlScript !== legacy.controlScript
      || migration.targetExecutable !== legacy.executable
      || migration.targetExecutableArguments.length !== legacy.executableArguments.length
      || migration.targetExecutableArguments.some((argument, index) => argument !== legacy.executableArguments[index])) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Schema-3 source binding has no matching committed migration');
    }
  }
  return {
    sourceRoot: canonicalSourceRoot,
    controlScript: canonicalControlScript,
    executable,
    ...(canonicalProtectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: canonicalProtectedReferenceRoot }),
    domain,
    beforeMetadataSha256: sha256(legacyRecord.raw),
    beforePlistSha256: sha256(legacyPlist),
    runtimePreflightSha256: runtimeEntrypoints.runtimePreflightSha256,
    runtimeLoaderSha256: runtimeEntrypoints.runtimeLoaderSha256,
  };
}

function approvalMatches(
  approval: LaunchAgentSourceApprovalRecord,
  preflight: MigrationBindingPreflight,
  input: LaunchAgentSourceApprovalInput,
): boolean {
  return approval.dataRoot === input.dataRoot
    && approval.sourceRoot === preflight.sourceRoot
    && approval.controlScript === preflight.controlScript
    && approval.executable === preflight.executable
    && approval.executableArguments.length === input.executableArguments.length
    && approval.executableArguments.every((argument, index) => argument === input.executableArguments[index])
    && approval.runtimePreflightSha256 === preflight.runtimePreflightSha256
    && approval.runtimeLoaderSha256 === preflight.runtimeLoaderSha256
    && approval.sourceSha === input.sourceSha
    && approval.sourceTree === input.sourceTree
    && approval.requestId === input.requestId
    && (approval.protectedReferenceRoot ?? null) === (preflight.protectedReferenceRoot ?? null)
    && approval.domain === preflight.domain
    && approval.beforeMetadataSha256 === preflight.beforeMetadataSha256
    && approval.beforePlistSha256 === preflight.beforePlistSha256
    && (input.recoveryPolicyId === undefined || approval.recoveryPolicyId === input.recoveryPolicyId);
}

function sourceApprovalPayload(record: LaunchAgentSourceApprovalRecord): string {
  const payload = {
    schemaVersion: record.schemaVersion,
    approvalId: record.approvalId,
    dataRoot: record.dataRoot,
    sourceRoot: record.sourceRoot,
    controlScript: record.controlScript,
    executable: record.executable,
    executableArguments: record.executableArguments,
    sourceSha: record.sourceSha,
    sourceTree: record.sourceTree,
    requestId: record.requestId,
    protectedReferenceRoot: record.protectedReferenceRoot ?? null,
    label: record.label,
    domain: record.domain,
    beforeMetadataSha256: record.beforeMetadataSha256,
    beforePlistSha256: record.beforePlistSha256,
    runtimePreflightSha256: record.runtimePreflightSha256,
    runtimeLoaderSha256: record.runtimeLoaderSha256,
    ...(record.recoveryPolicyId === undefined ? {} : { recoveryPolicyId: record.recoveryPolicyId, recoveryPolicyTransactionId: record.recoveryPolicyTransactionId }),
    ...(record.schemaVersion >= 2 ? { state: record.state, issuedAt: record.issuedAt } : {}),
  };
  return JSON.stringify(payload);
}

function signSourceApproval(record: LaunchAgentSourceApprovalRecord, secret: string): string {
  return createHmac('sha256', secret).update(sourceApprovalPayload(record)).digest('hex');
}

function verifySourceApproval(record: LaunchAgentSourceApprovalRecord, secret: string): boolean {
  const expected = signSourceApproval(record, secret);
  const actual = Buffer.from(record.signature, 'utf8');
  const candidate = Buffer.from(expected, 'utf8');
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

function approvalContent(record: LaunchAgentSourceApprovalRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

async function readSourceApprovalRecord(filename: string, uid: number): Promise<LaunchAgentSourceApprovalRecord | null> {
  const inspected = await inspectOwnedFile(filename, 'IRIS source migration approval', uid);
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', inspected.reason);
  return parseSourceApproval(inspected.content);
}

function parseSourceApproval(content: string): LaunchAgentSourceApprovalRecord {
  try {
    const value = JSON.parse(content) as Partial<LaunchAgentSourceApprovalRecord>;
    if (![1, 2].includes(Number(value.schemaVersion)) || value.label !== LAUNCH_AGENT_LABEL || typeof value.approvalId !== 'string'
      || !['ISSUED', 'CONSUMED', 'RECONCILIATION_REQUIRED'].includes(String(value.state))
      || typeof value.signature !== 'string' || typeof value.requestId !== 'string'
      || !/^[a-f0-9]{64}$/.test(String(value.runtimePreflightSha256))
      || !/^[a-f0-9]{64}$/.test(String(value.runtimeLoaderSha256))
      || (value.schemaVersion === 2 && typeof value.issuedAt !== 'string')) throw new Error('invalid source approval record');
    return value as LaunchAgentSourceApprovalRecord;
  } catch (error) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'IRIS source migration approval is invalid', { cause: error });
  }
}

async function readMalformedApprovalRecoveryRecord(filename: string, uid: number): Promise<MalformedLegacyApprovalReconciliationRecord | null> {
  const inspected = await inspectOwnedFile(filename, 'IRIS malformed approval recovery', uid);
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', inspected.reason);
  try {
    const value = JSON.parse(inspected.content) as Partial<MalformedLegacyApprovalReconciliationRecord>;
    if (value.schemaVersion !== 1 || value.label !== LAUNCH_AGENT_LABEL || typeof value.transactionId !== 'string'
      || typeof value.recoveryRequestId !== 'string' || typeof value.approvalId !== 'string' || typeof value.requestId !== 'string'
      || !['PREPARED', 'APPLYING', 'COMMITTED', 'RECONCILIATION_REQUIRED', 'FAILED'].includes(String(value.state))
      || !/^[a-f0-9]{64}$/.test(String(value.approvalSha256)) || typeof value.originalApprovalRaw !== 'string') throw new Error('invalid malformed approval recovery record');
    return value as MalformedLegacyApprovalReconciliationRecord;
  } catch (error) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'IRIS malformed approval recovery is invalid', { cause: error });
  }
}

function validateMigrationInput(input: LaunchAgentSourceMigrationInput | LaunchAgentSourceApprovalInput): void {
  for (const [name, value] of [['sourceSha', input.sourceSha], ['sourceTree', input.sourceTree]] as const) {
    if (!/^[a-f0-9]{40}$/.test(value)) throw new RuntimeError('INVALID_REQUEST', `${name} must be a lowercase hexadecimal object identifier`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.requestId)) {
    throw new RuntimeError('INVALID_REQUEST', 'requestId must be a UUID');
  }
  if ('approvalId' in input && !/^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.approvalId)) {
    throw new RuntimeError('INVALID_REQUEST', 'approvalId must be a UUID');
  }
  if (input.executableArguments.some((argument) => argument.includes('\0'))) {
    throw new RuntimeError('INVALID_REQUEST', 'executable arguments cannot contain NUL bytes');
  }
}

function validateApprovalReconciliationInput(input: LaunchAgentSourceApprovalReconciliationInput): void {
  if (!/^[a-f0-9]{40}$/.test(input.sourceSha) || !/^[a-f0-9]{40}$/.test(input.sourceTree)) {
    throw new RuntimeError('INVALID_REQUEST', 'sourceSha and sourceTree must be lowercase hexadecimal object identifiers');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.requestId)) {
    throw new RuntimeError('INVALID_REQUEST', 'requestId must be a UUID');
  }
}

function validateMalformedLegacyApprovalInput(input: MalformedLegacyApprovalReconciliationInput): void {
  for (const [name, value] of [['approvalId', input.approvalId], ['requestId', input.requestId], ['recoveryRequestId', input.recoveryRequestId]] as const) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new RuntimeError('INVALID_REQUEST', `${name} must be a UUID`);
  }
  if (!/^[a-f0-9]{64}$/.test(input.approvalSha256)) throw new RuntimeError('INVALID_REQUEST', 'approvalSha256 must be a lowercase SHA-256 digest');
}

async function requireSourceGitIdentity(sourceRoot: string, expectedSha: string, expectedTree: string): Promise<void> {
  try {
    const [head, tree, status] = await Promise.all([
      execFileAsync('/usr/bin/git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5_000 }),
      execFileAsync('/usr/bin/git', ['-C', sourceRoot, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8', timeout: 5_000 }),
      execFileAsync('/usr/bin/git', ['-C', sourceRoot, 'status', '--porcelain=v1', '--untracked-files=no'], { encoding: 'utf8', timeout: 5_000 }),
    ]);
    if (head.stdout.trim() !== expectedSha || tree.stdout.trim() !== expectedTree || status.stdout.trim().length !== 0) {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Reviewed control source identity is not exact and clean');
    }
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Reviewed control source Git identity could not be verified', { cause: error });
  }
}

async function requireTargetRuntimeEntries(argumentsList: readonly string[], uid: number): Promise<{
  readonly runtimePreflightSha256: string;
  readonly runtimeLoaderSha256: string;
}> {
  let runtimePreflightSha256: string | undefined;
  let runtimeLoaderSha256: string | undefined;
  for (const argument of argumentsList) {
    const candidate = argument.startsWith('file://')
      ? fileURLToPath(argument)
      : path.isAbsolute(argument) ? argument : null;
    if (candidate === null) continue;
    const physical = await requireCanonicalFile(candidate, 'Reviewed runtime entrypoint', uid);
    const digest = await hashCanonicalFile(physical, 'Reviewed runtime entrypoint', uid);
    if (path.basename(physical) === 'preflight.cjs') runtimePreflightSha256 = digest;
    if (path.basename(physical) === 'loader.mjs') runtimeLoaderSha256 = digest;
  }
  if (runtimePreflightSha256 === undefined || runtimeLoaderSha256 === undefined) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Reviewed runtime entrypoints are incomplete');
  }
  return { runtimePreflightSha256, runtimeLoaderSha256 };
}

function requireMetadataBinding(actual: LaunchAgentMetadata, expected: Omit<LaunchAgentMetadata, 'state' | 'disabledBeforeInstall' | 'unresolvedReason'>): void {
  if (actual.schemaVersion !== expected.schemaVersion
    || actual.label !== expected.label
    || actual.domain !== expected.domain
    || actual.dataRoot !== expected.dataRoot
    || actual.sourceRoot !== expected.sourceRoot
    || actual.executable !== expected.executable
    || actual.controlScript !== expected.controlScript
    || actual.plist !== expected.plist
    || actual.registeredPlist !== expected.registeredPlist
    || actual.plistSha256 !== expected.plistSha256
    || actual.executableArguments.length !== expected.executableArguments.length
    || actual.executableArguments.some((argument, index) => argument !== expected.executableArguments[index])) {
    throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'LaunchAgent ownership metadata conflicts with the requested installation');
  }
}

async function requirePublishedContent(filename: string, content: string, label: string, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(filename, label, uid);
  if (inspected.state !== 'ok' || inspected.content !== content) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} changed after publication`);
}

async function removeOwnedFile(filename: string, label: string, uid: number): Promise<void> {
  const inspected = await inspectOwnedFile(filename, label, uid);
  if (inspected.state === 'missing') return;
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  await rm(filename);
  await syncDirectory(path.dirname(filename));
}

async function readLaunchAgentMetadata(filename: string, uid: number): Promise<LaunchAgentMetadataRecord | null> {
  const inspected = await inspectOwnedFile(filename, 'IRIS LaunchAgent metadata', uid);
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', inspected.reason);
  try {
    const value = JSON.parse(inspected.content) as unknown;
    if (!validLaunchAgentMetadata(value) && !validLegacyLaunchAgentMetadata(value)) throw new Error('invalid metadata');
    return { metadata: value, raw: inspected.content };
  } catch (error) { throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'IRIS LaunchAgent metadata is invalid', { cause: error }); }
}

function validLegacyLaunchAgentMetadata(value: unknown): value is LegacyLaunchAgentMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const metadata = value as LegacyLaunchAgentMetadata;
  return Object.keys(value).sort().join(',') === 'controlScript,executable,executableArguments,label,plist,schemaVersion'
    && metadata.schemaVersion === 1
    && metadata.label === LAUNCH_AGENT_LABEL
    && [metadata.executable, metadata.controlScript, metadata.plist].every((item) => typeof item === 'string' && path.isAbsolute(item) && !item.includes('\0'))
    && Array.isArray(metadata.executableArguments)
    && metadata.executableArguments.every((item) => typeof item === 'string' && !item.includes('\0'));
}

function validLaunchAgentMetadata(value: unknown): value is LaunchAgentMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const metadata = value as LaunchAgentMetadata;
  return metadata.schemaVersion === 3 && metadata.label === LAUNCH_AGENT_LABEL
    && typeof metadata.domain === 'string' && /^gui\/\d+$/.test(metadata.domain)
    && [metadata.dataRoot, metadata.sourceRoot, metadata.executable, metadata.controlScript, metadata.plist, metadata.registeredPlist].every((item) => typeof item === 'string' && path.isAbsolute(item))
    && Array.isArray(metadata.executableArguments) && metadata.executableArguments.every((item) => typeof item === 'string' && !item.includes('\0'))
    && typeof metadata.plistSha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.plistSha256)
    && ['PREPARED', 'INSTALLING', 'READY', 'UNINSTALLING', 'RECONCILIATION_REQUIRED'].includes(metadata.state)
    && typeof metadata.disabledBeforeInstall === 'boolean'
    && (metadata.disabledStateBeforeInstall === undefined || ['EXPLICIT_ENABLED', 'EXPLICIT_DISABLED', 'NO_EXPLICIT_OVERRIDE', 'UNKNOWN'].includes(metadata.disabledStateBeforeInstall))
    && (metadata.unresolvedReason === null || ['BOOTSTRAP_OUTCOME_UNKNOWN', 'LIVE_IDENTITY_UNVERIFIED', 'PUBLISHED_STATE_CHANGED', 'DISABLED_STATE_UNKNOWN', 'BOOTOUT_OUTCOME_UNKNOWN'].includes(metadata.unresolvedReason))
    && (metadata.legacyMigration === undefined || validLegacyMigrationEvidence(metadata.legacyMigration))
    && (metadata.initialInstall === undefined || validInitialInstallProvenance(metadata.initialInstall));
}

function validLegacyMigrationEvidence(value: unknown): value is LegacyMigrationEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const migration = value as LegacyMigrationEvidence;
  return migration.fromSchemaVersion === 1
    && /^[a-f0-9]{64}$/.test(migration.metadataSha256)
    && /^[a-f0-9]{64}$/.test(migration.plistSha256)
    && [migration.executable, migration.controlScript, migration.plist].every((item) => typeof item === 'string' && path.isAbsolute(item) && !item.includes('\0'))
    && Array.isArray(migration.executableArguments)
    && migration.executableArguments.every((item) => typeof item === 'string' && !item.includes('\0'))
    && migration.observedState === 'ABSENT'
    && typeof migration.disabledBeforeMigration === 'boolean'
    && (migration.disabledStateBeforeMigration === undefined || ['EXPLICIT_ENABLED', 'EXPLICIT_DISABLED', 'NO_EXPLICIT_OVERRIDE', 'UNKNOWN'].includes(migration.disabledStateBeforeMigration));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function sourceRootForControlScript(controlScript: string): string {
  return path.resolve(path.dirname(controlScript), '../../..');
}

function launchdDomain(dependencies: LaunchdDependencies): string {
  return `gui/${launchdUid(dependencies)}`;
}

function launchdUid(dependencies: LaunchdDependencies): number {
  const uid = dependencies.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'User LaunchAgents require a macOS user identity');
  return uid;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

class LaunchctlOutcomeUnknown extends Error {}

function launchctlOutcomeUnknown(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as NodeJS.ErrnoException & { readonly killed?: boolean; readonly signal?: string | null };
  return failure.killed === true || failure.signal !== undefined && failure.signal !== null || failure.code === 'ETIMEDOUT';
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function validInitialInstallProvenance(value: unknown): value is InitialInstallProvenance {
  if (typeof value !== 'object' || value === null) return false;
  const proof = value as InitialInstallProvenance;
  return proof.operation === 'SUPERVISOR_BOOTSTRAP' && validInitialInstallBinding(proof.initialInstall)
    && [proof.policyId, proof.requestId, proof.transactionId, proof.machineId].every((item) => typeof item === 'string' && /^[a-f0-9-]{36}$/.test(item))
    && [proof.sourceSha, proof.sourceTree].every((item) => typeof item === 'string' && /^[a-f0-9]{40}$/.test(item))
    && [proof.executableSha256, proof.runtimePreflightSha256, proof.runtimeLoaderSha256].every((item) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))
    && [proof.dataRoot, proof.sourceRoot, proof.controlScript, proof.executable].every((item) => typeof item === 'string' && path.isAbsolute(item) && !item.includes('\0'))
    && Array.isArray(proof.executableArguments) && proof.executableArguments.every((item) => typeof item === 'string' && !item.includes('\0'))
    && proof.beforeMetadataSha256 === null && proof.beforePlistSha256 === null;
}

async function verifyInitialTransport(dataRoot: string, binding: InitialInstallBinding, uid: number): Promise<void> {
  const registry = await readConnectorRegistry(dataRoot);
  const machineId = await readMachineId(dataRoot);
  const connector = registry?.connectors[0];
  if (registry === null || registry.admin !== null || registry.connectors.length !== 1 || connector?.connectorId !== binding.connectorId || connector.label !== 'IRIS' || connector.tunnelId !== binding.tunnelId || connector.managedProfilePath !== binding.managedProfilePath || machineId === null || connector.machineId !== machineId) throw new RuntimeError('CONTROL_DENIED', 'Enrolled ONE transport binding changed');
  if (await hashCanonicalFile(binding.tunnelExecutable, 'Reviewed tunnel executable', uid) !== binding.tunnelExecutableSha256) throw new RuntimeError('CONTROL_DENIED', 'Enrolled tunnel executable changed');
}
