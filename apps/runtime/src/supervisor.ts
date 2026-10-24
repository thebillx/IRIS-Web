import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, openSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { createConnection } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { RuntimeError, type RuntimeFailureCode } from '@iris/domain';
import { assertActivationSourceIdentity, assertActivationWorkloadReady, type ActivationSourceIdentity } from './activation-source-identity.js';
import { bindAdminTunnelIdentity, bindConnectorRuntime, initializeConnectorRegistry, inspectConnectorRegistry, readConnectorRegistry, reconcileConnectorRegistry, replaceConnectorCatalogManifest, seedFromLegacyProfiles, type AdminConnectorBinding, type ConnectorBinding, type ConnectorCatalogManifest, type ConnectorRegistryDocument } from './connector-registry.js';
import { credentialPaths, inspectCredentialStatus, loadOrCreateTunnelServiceSecret, readTunnelServiceSecret, rotateTunnelServiceSecret, type CredentialStatus } from './credentials.js';
import { ensureRuntimeDataRoot, resolveRuntimeDataRoot, resolveSourceRoot } from './data-root.js';
import { catalogIdentity, catalogIdentityAtVersion, catalogToolNames, isSupportedCatalogVersion, type McpCatalogIdentity } from './mcp-catalog.js';
import { observeProcessStart } from './macos-safety.js';
import { MCP_PROTOCOL_VERSION, proMcpToolDefinitions } from './mcp.js';
import { fullMcpToolDefinitionsV21 } from './mcp-v21.js';
import { FoundationStateStore, loadOrCreateRuntimeId, readEndpoint, readRuntimeControl, removeEndpointIfInstance, removeRuntimeControlIfInstance } from './persistence.js';
import { privateDirectoryProblem } from './private-fs.js';
import { runtimeStatus, startRuntime, stopRuntime, type RuntimeObservedStatus } from './lifecycle.js';
import { KeepAwakeLeaseManager, KeepAwakePreferenceStore, MacOSCaffeinateProvider, type KeepAwakeLease, type KeepAwakeProvider } from './keep-awake.js';
import { readMachineId } from './machine-identity.js';
import { readVerifiedSourceIdentity } from './mission-delegation.js';
import { LifecycleGrantStore, type LifecycleGrantBinding, type LifecycleGrantTarget, type LifecycleOperation } from './lifecycle-grant.js';
import { assertSupportedNodeVersion, canonicalNodeRuntime, node24Environment } from './node-runtime.js';
import { callSupervisorAdminTool, listSupervisorAdminToolNames, type SupervisorAdminToolCallResult } from './supervisor-admin.js';
import { startSupervisorNativeControlServer, type AdminRecycleInput, type AdminTunnelRecycleInput, type LifecycleGrantCall, type SupervisorMutationStatusInput, type SupervisorWorkloadCallContext } from './supervisor-native-control.js';
import { assertRecoveryPolicyOperationCommitted, finalizeRecoveryPolicyOperation, readRecoveryAuthorizationPolicy, reserveRecoveryPolicyOperation, resolveFailedAdminTunnelStart, type RecoveryPolicyOperationInput } from './recovery-policy.js';
import { resolveReviewedRuntimeEntrypoints } from './launchd.js';
import { DurableMutationJournal, type MutationBinding } from './durable-mutation-journal.js';

import { confirmChildSpawn, DefiniteSpawnFailure } from './spawn-outcome.js';
import { readSupervisorStateFile, writeSupervisorStateFile, unresolvedStartup, validStartupOperations, type StartupOperation, type StartupState } from './supervisor-startup.js';

const execFileAsync = promisify(execFile);
const MACOS_SAFETY_HELPER = path.resolve(import.meta.dirname, '..', 'macos-safety-helper.py');
const SUPERVISOR_DIRECTORY = 'supervisor';
const STATE_FILE = 'state.json';
const PROFILE_DIRECTORY = 'tunnel-profiles';
const LOG_DIRECTORY = 'logs';
const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_WINDOW_MS = 60_000;
const RECOVERY_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const CONTROLLED_ACTIVATION_SHUTDOWN_DEADLINE_MS = 60_000;
const DEFAULT_WEB_PORT = 5_173;
const DEFAULT_ADMIN_PORT = 43_111;
const DEFAULT_SUPERVISOR_CONTROL_PORT = 43_112;
const DEFAULT_ADMIN_TUNNEL_HEALTH_PORT = 43_113;
const DEFAULT_TUNNEL_CLIENT = 'tunnel-client';
const OPERATION_LOCK_FILE = 'operation.lock';
const FORWARDED_READ_ONLY_TOOLS = new Set([
  'runtime_status', 'list_projects', 'project_info', 'git_status', 'search', 'file_read',
  'mission_list', 'session_get', 'mission_list_waiting_supervisor', 'mission_get', 'mission_events',
  'project_validation_discover', 'project_validation_job', 'catalog_identity',
]);
const FORWARDED_DURABLE_MUTATION_TOOLS = new Set(['project_validation_start']);

const FORWARDED_GROUPED_READ_ONLY_TOOLS = new Set(['workspace', 'fs', 'artifact', 'job', 'git']);

function isUnifiedConnectorRegistry(registry: ConnectorRegistryDocument): boolean {
  return registry.admin === null && registry.connectors.length === 1 && registry.connectors[0]?.label === 'IRIS';
}

function groupedWorkloadReadOnly(name: string, args: Record<string, unknown>): boolean {
  const operation = args.operation;
  if (typeof operation !== 'string') return false;
  if (name === 'workspace') return operation === 'list' || operation === 'get';
  if (name === 'fs') return operation === 'list' || operation === 'stat' || operation === 'read' || operation === 'hash' || operation === 'find';
  if (name === 'artifact') return operation === 'stat' || operation === 'open_ref';
  if (name === 'job') return operation === 'status' || operation === 'logs' || operation === 'result';
  if (name === 'git') return operation === 'status' || operation === 'head' || operation === 'diff' || operation === 'log'
    || operation === 'show' || operation === 'cat_file' || operation === 'merge_base' || operation === 'ancestry'
    || operation === 'refs' || operation === 'branch_list' || operation === 'worktree_list';
  return false;
}

function groupedWorkloadDurableMutation(name: string, args: Record<string, unknown>): boolean {
  if (typeof args.operation !== 'string') return false;
  if (name === 'workspace') return args.operation === 'create_scratch' || args.operation === 'revoke_scratch';
  if (name === 'fs') return ['write', 'edit', 'mkdir', 'delete'].includes(args.operation);
  if (name === 'artifact') return args.operation === 'register_existing' || args.operation === 'release';
  if (name === 'shell') return args.operation === 'run' || args.operation === 'start';
  if (name === 'job') return args.operation === 'cancel';
  if (name === 'git') return ['branch_create', 'worktree_add', 'worktree_remove', 'add', 'commit', 'fetch', 'push'].includes(args.operation);
  return false;
}

export type StackState = 'READY' | 'DEGRADED' | 'FAILED' | 'UNKNOWN';

export interface LayerStatus {
  readonly state: StackState;
  readonly code: string;
  readonly detail: string;
}

export interface ConnectorStatus extends LayerStatus {
  readonly connectorId: string;
  readonly label: string;
  readonly tunnelId: string;
  readonly profile: string;
  readonly expectedToolCount: number;
}

export interface SupervisorStackStatus {
  readonly state: StackState;
  readonly runtime: LayerStatus;
  readonly web: LayerStatus;
  readonly tunnel: LayerStatus;
  readonly controlPlane: LayerStatus;
  readonly localRuntime: LayerStatus;
  readonly endToEnd: LayerStatus;
  readonly connectors: readonly ConnectorStatus[];
  readonly credentials: CredentialStatus;
  readonly registryPresent: boolean;
  readonly recovery: RecoveryStatus;
}

export interface RecoveryStatus {
  readonly attempts: number;
  readonly terminal: boolean;
  readonly lastFailureCode: string | null;
  readonly nextAttemptAt: string | null;
  readonly windowStartedAt: string | null;
}

interface OwnedProcess {
  readonly component: 'runtime' | 'web' | 'admin' | 'tunnel-full' | 'tunnel-pro' | 'tunnel-admin' | 'supervisor';
  readonly pid: number;
  readonly startedAt: string;
  readonly executable: string;
  readonly profilePath: string | null;
  readonly tunnelId: string | null;
  readonly marker: string;
  readonly processStartTimeMs?: number | null;
  readonly processStartMarker?: string | null;
  readonly processExecutable?: string | null;
  readonly listenerPorts?: readonly number[];
  readonly runtimeId?: string | null;
  readonly instanceId?: string | null;
  readonly deploymentEpoch?: number | null;
  readonly profileDigest?: string | null;
  readonly workingDirectory?: string | null;
  readonly environmentDigest?: string | null;
}

interface RecoveryRecord {
  readonly attempts: number;
  readonly terminal: boolean;
  readonly lastFailureCode: string | null;
  readonly nextAttemptAt: string | null;
  readonly windowStartedAt: string | null;
}

interface SupervisorStateDocument {
  readonly schemaVersion: 1 | 2 | 3 | 4;
  readonly startupOperations: readonly StartupOperation[];
  readonly supervisorId: string;
  readonly updatedAt: string;
  readonly workloadSourceRoot: string;
  readonly runtime: OwnedProcess | null;
  readonly web: OwnedProcess | null;
  readonly admin: OwnedProcess | null;
  readonly adminTunnel: OwnedProcess | null;
  readonly tunnels: { readonly full: OwnedProcess | null; readonly pro: OwnedProcess | null };
  readonly recovery: RecoveryRecord;
}

export interface SupervisorOptions {
  readonly dataRoot?: string;
  readonly sourceRoot?: string;
  readonly tunnelClientPath?: string;
  readonly webPort?: number;
  readonly adminPort?: number;
  readonly supervisorControlPort?: number;
  readonly adminTunnelHealthPort?: number;
  readonly protectedReferenceRoot?: string;
  readonly keepAwakeProvider?: KeepAwakeProvider;
}

interface SupervisorOperationLock {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly startedAt: string;
  readonly operation: string;
  readonly processStartMarker?: string;
}

export interface LocalReadinessResult {
  readonly status: LayerStatus;
  readonly connectors: readonly ConnectorStatus[];
  readonly catalogs: readonly CatalogProfileStatus[];
}

export type CatalogActivationState = 'ACTIVE' | 'STALE_RUNTIME' | 'STALE_CONNECTOR' | 'MISMATCH' | 'UNKNOWN';

export interface CatalogProfileStatus {
  readonly profile: 'FULL' | 'PRO';
  readonly source: McpCatalogIdentity;
  readonly live: McpCatalogIdentity | null;
  readonly liveToolCount: number | null;
  readonly connectorCatalogHash: string;
  readonly connectorEpoch: number;
  readonly state: CatalogActivationState;
}

export interface SupervisorCatalogStatus {
  readonly state: CatalogActivationState;
  readonly sourceMode: 'STRICT_CONTROL_SOURCE' | 'BOUND_WORKLOAD_COMPATIBILITY';
  readonly full: CatalogProfileStatus;
  readonly pro: CatalogProfileStatus | null;
  readonly runtimeId: string | null;
  readonly instanceId: string | null;
  readonly deploymentEpoch: number;
  readonly recommendedAction: string;
}

export function supervisorAdminChildEnvironment(
  dataRoot: string,
  adminPort: number,
  protectedReferenceRoot?: string,
): Record<string, string> {
  const configuredProtectedReferenceRoot = protectedReferenceRoot?.trim();
  return {
    IRIS_RUNTIME_DATA_ROOT: dataRoot,
    IRIS_SUPERVISOR_ADMIN_PORT: String(adminPort),
    ...(configuredProtectedReferenceRoot === undefined || configuredProtectedReferenceRoot.length === 0
      ? {}
      : { IRIS_PROTECTED_REFERENCE_ROOT: configuredProtectedReferenceRoot }),
  };
}

function launchEnvironmentDigest(environment: Record<string, string>): string {
  const entries = Object.entries(environment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export async function createSupervisor(options: SupervisorOptions = {}): Promise<Supervisor> {
  assertSupportedNodeVersion();
  const dataRoot = options.dataRoot === undefined
    ? await resolveRuntimeDataRoot()
    : await resolveRuntimeDataRoot({ ...process.env, IRIS_RUNTIME_DATA_ROOT: options.dataRoot });
  const sourceRoot = options.sourceRoot === undefined ? await resolveSourceRoot() : path.resolve(options.sourceRoot);
  const protectedReferenceRoot = options.protectedReferenceRoot ?? process.env.IRIS_PROTECTED_REFERENCE_ROOT?.trim();
  return new Supervisor(
    dataRoot,
    sourceRoot,
    options.tunnelClientPath ?? DEFAULT_TUNNEL_CLIENT,
    options.webPort ?? DEFAULT_WEB_PORT,
    options.adminPort ?? DEFAULT_ADMIN_PORT,
    options.supervisorControlPort ?? DEFAULT_SUPERVISOR_CONTROL_PORT,
    options.adminTunnelHealthPort ?? DEFAULT_ADMIN_TUNNEL_HEALTH_PORT,
    protectedReferenceRoot,
    options.keepAwakeProvider,
  );
}

export class Supervisor {
  private nativeControlActive = false;
  private readonly keepAwake: KeepAwakeLeaseManager;
  private readonly keepAwakePreference: KeepAwakePreferenceStore;
  private runtimeKeepAwakeLease: KeepAwakeLease | null = null;
  private ownerKeepAwakeLease: KeepAwakeLease | null = null;
  private readonly lifecycleGrants: LifecycleGrantStore;
  private readonly workloadMutationJournal: DurableMutationJournal;

  public constructor(
    public readonly dataRoot: string,
    private readonly sourceRoot: string,
    private readonly tunnelClientPath: string,
    private readonly webPort: number,
    private readonly adminPort: number,
    private readonly supervisorControlPort: number,
    private readonly adminTunnelHealthPort: number,
    private readonly protectedReferenceRoot?: string,
    keepAwakeProvider: KeepAwakeProvider = new MacOSCaffeinateProvider(),
  ) {
    this.lifecycleGrants = new LifecycleGrantStore(dataRoot);
    // Keep the Supervisor transport journal separate from the Runtime's
    // journal; both receive the same request id for one forwarded mutation.
    this.workloadMutationJournal = new DurableMutationJournal(path.join(dataRoot, 'supervisor'));
    this.keepAwake = new KeepAwakeLeaseManager(keepAwakeProvider);
    this.keepAwakePreference = new KeepAwakePreferenceStore(dataRoot);
    for (const [label, port] of [
      ['Supervisor admin', adminPort],
      ['Supervisor native control', supervisorControlPort],
      ['Supervisor admin tunnel health', adminTunnelHealthPort],
    ] as const) {
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
        throw new RuntimeError('INVALID_REQUEST', `${label} port must be a valid TCP port`);
      }
    }
    if (new Set([adminPort, supervisorControlPort, adminTunnelHealthPort]).size !== 3) {
      throw new RuntimeError('INVALID_REQUEST', 'Supervisor admin, native control, and admin tunnel health ports must be distinct');
    }
  }

  public async up(): Promise<SupervisorStackStatus> {
    await this.prepareDirectories();
    return this.withOperationLock('up', () => this.upUnlocked());
  }

  public async runSetupExclusive<T>(work: () => Promise<T>): Promise<T> {
    await this.prepareDirectories();
    const release = await acquireSetupOperationLock(path.join(this.supervisorDirectory(), OPERATION_LOCK_FILE), 'setup');
    try {
      return await work();
    } finally {
      await release();
    }
  }

  /** Start only the authenticated ADMIN transport for an already-running native Supervisor. */
  public async startControlOnlyAdminTunnel(input: {
    readonly recoveryPolicyId: string;
    readonly requestId: string;
    readonly sourceSha: string;
    readonly sourceTree: string;
    readonly beforeMetadataSha256: string;
    readonly beforePlistSha256: string;
  }): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('admin-tunnel-start-control-only', () => this.startControlOnlyAdminTunnelUnlocked(input));
  }

  /** Close one failed ADMIN tunnel reservation only after durable absence is reverified. */
  public async reconcileFailedControlOnlyAdminTunnel(input: RecoveryPolicyOperationInput & { readonly transactionId: string; readonly startupTransactionId: string }): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('admin-tunnel-start-reconcile-failed', async () => {
      if (input.operation !== 'ADMIN_TUNNEL_START') throw new RuntimeError('INVALID_REQUEST', 'Only an ADMIN_TUNNEL_START may be reconciled as failed');
      const state = await this.readState();
      if (state.adminTunnel !== null) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'ADMIN tunnel ownership is still present');
      const operation = state.startupOperations.find((candidate) => candidate.transactionId === input.startupTransactionId && candidate.component === 'tunnel-admin' && candidate.state === 'STOPPED' && candidate.sourceRoot === input.sourceRoot && candidate.dataRoot === this.dataRoot);
      if (operation === undefined || operation.ownedProcess === undefined) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'No stopped ADMIN tunnel startup evidence matches the failed policy operation');
      const ownedProcess = operation.ownedProcess as OwnedProcess;
      const inspected = await inspectProcess(ownedProcess);
      if (inspected !== 'stopped') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Failed ADMIN tunnel process identity is not definitively absent');
      for (const port of ownedProcess.listenerPorts ?? [this.adminTunnelHealthPort]) {
        if (!await listenerReleased(port)) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Failed ADMIN tunnel listener ownership is not definitively absent');
      }
      const record = await resolveFailedAdminTunnelStart(input);
      return { state: 'FAILED', transactionId: input.transactionId, policyState: record.state, workloadProcessesStarted: false };
    });
  }

  /** Finalize one already-running ADMIN tunnel whose startup journal stopped at ownership verification. */
  public async reconcileControlOnlyAdminTunnel(input: {
    readonly recoveryPolicyId: string;
    readonly requestId: string;
    readonly transactionId: string;
    readonly sourceSha: string;
    readonly sourceTree: string;
    readonly beforeMetadataSha256: string;
    readonly beforePlistSha256: string;
    readonly pid: number;
    readonly processStartMarker: string;
    readonly tunnelId: string;
    readonly profileDigest: string;
  }): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('admin-tunnel-start-reconcile-running', () => this.reconcileControlOnlyAdminTunnelUnlocked(input));
  }

  private async reconcileControlOnlyAdminTunnelUnlocked(input: {
    readonly recoveryPolicyId: string;
    readonly requestId: string;
    readonly transactionId: string;
    readonly sourceSha: string;
    readonly sourceTree: string;
    readonly beforeMetadataSha256: string;
    readonly beforePlistSha256: string;
    readonly pid: number;
    readonly processStartMarker: string;
    readonly tunnelId: string;
    readonly profileDigest: string;
  }): Promise<Record<string, unknown>> {
    const state = await this.readState();
    const candidates = state.startupOperations.filter((operation) => operation.transactionId === input.transactionId && operation.component === 'tunnel-admin' && operation.state === 'OWNERSHIP_VERIFIED');
    if (candidates.length !== 1) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Exactly one ownership-verified ADMIN tunnel startup record is required');
    const operation = candidates[0]!;
    const record = state.adminTunnel;
    if (record === null || record.pid !== input.pid || record.tunnelId !== input.tunnelId || record.profileDigest !== input.profileDigest || operation.pid !== input.pid || operation.processStartMarker !== input.processStartMarker || record.processStartMarker !== input.processStartMarker) {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'ADMIN tunnel identity changed before journal reconciliation');
    }
    if (operation.sourceRoot !== this.sourceRoot || operation.dataRoot !== this.dataRoot || record.workingDirectory !== this.sourceRoot
      || !sameExecutablePath(operation.executable, record.executable) || operation.profilePath !== record.profilePath
      || operation.processExecutable === null || operation.expectedProcessExecutable !== operation.processExecutable
      || operation.configurationDigest !== record.environmentDigest || await executableForPid(record.pid) !== operation.processExecutable
      || await inspectProcess(record) !== 'running') {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'ADMIN tunnel source or process identity is not verified');
    }
    if (!isOwnedProcess(operation.ownedProcess) || !sameOwnedProcessAuthority(operation.ownedProcess, record) || !await ownedProcessOwnsRecordedListeners(record, [this.adminTunnelHealthPort])) {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'ADMIN tunnel durable ownership or listener identity is not verified');
    }
    const unrelated = state.startupOperations.filter((candidate) => unresolvedStartup(candidate) && candidate.transactionId !== input.transactionId);
    if (unrelated.length > 0) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Unrelated unresolved startup operations prevent reconciliation');
    const policy = await readRecoveryAuthorizationPolicy(this.dataRoot);
    const journal = policy?.operations.find((entry) => entry.transactionId === input.transactionId && entry.requestId === input.requestId && entry.operation === 'ADMIN_TUNNEL_START');
    if (policy === null || journal === undefined || journal.state !== 'COMMITTED' || policy.policyId !== input.recoveryPolicyId || journal.sourceSha !== input.sourceSha || journal.sourceTree !== input.sourceTree || journal.sourceRoot !== operation.sourceRoot || journal.beforeMetadataSha256 !== input.beforeMetadataSha256 || journal.beforePlistSha256 !== input.beforePlistSha256) {
      throw new RuntimeError('CONTROL_DENIED', 'Committed ADMIN tunnel policy binding is unavailable');
    }
    await assertRecoveryPolicyOperationCommitted({
      ...journal,
      dataRoot: this.dataRoot,
      policyId: policy.policyId,
      operation: 'ADMIN_TUNNEL_START',
      requestId: journal.requestId,
      transactionId: journal.transactionId,
      protectedReferenceRoot: journal.protectedReferenceRoot ?? undefined,
      machineId: journal.machineId ?? undefined,
      executableSha256: journal.executableSha256 ?? undefined,
    });
    const next = { ...state, startupOperations: state.startupOperations.map((candidate) => candidate.id === operation.id ? { ...candidate, state: 'RUNNING' as const } : candidate) };
    await this.writeState(next, true);
    return { state: 'READY', transactionId: input.transactionId, adminTunnelPid: record.pid, adminTunnelIdentity: ownedProcessIdentity(record), tunnelId: record.tunnelId, workloadProcessesStarted: false };
  }

  private async startControlOnlyAdminTunnelUnlocked(input: {
    readonly recoveryPolicyId: string;
    readonly requestId: string;
    readonly sourceSha: string;
    readonly sourceTree: string;
    readonly beforeMetadataSha256: string;
    readonly beforePlistSha256: string;
  }): Promise<Record<string, unknown>> {
    let state = await this.readState();
    const nativeControl = await this.probeNativeControl();
    if (nativeControl.state !== 'READY') throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'Control-only ADMIN start requires the authenticated native Supervisor control endpoint');
    const records = [state.runtime, state.web, state.admin, state.tunnels.full, state.tunnels.pro];
    for (const record of records) {
      if (record === null) continue;
      const inspected = await inspectProcess(record);
      if (inspected === 'ambiguous') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Control-only ADMIN start found ambiguous workload ownership');
      if (inspected === 'running') throw new RuntimeError('PRECONDITION_FAILED', 'Control-only ADMIN start requires all workload processes to remain stopped');
    }
    const registry = await readConnectorRegistry(this.dataRoot);
    const binding = registry?.admin;
    if (registry === null || binding === null || binding === undefined) throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', 'Dedicated ADMIN connector binding is required for control-only transport');
    const profile = await readFile(binding.managedProfilePath, 'utf8').catch(() => null);
    const credentials = credentialPaths(this.dataRoot);
    const expectedProfile = managedAdminProfile(binding, credentials.controlPlaneApiKey, credentials.tunnelServiceAuthorization, this.logDirectory(), this.adminTunnelHealthPort, `http://127.0.0.1:${this.supervisorControlPort}/mcp`);
    if (profile !== expectedProfile) throw new RuntimeError('CONTROL_DENIED', 'Managed ADMIN profile is not the authenticated native-control profile');
    const sourceRoot = this.sourceRoot;
    const controlScript = path.join(sourceRoot, 'apps/runtime/src/control.ts');
    const [headResult, treeResult, statusResult] = await Promise.all([
      execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']),
      execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD^{tree}']),
      execFileAsync('git', ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=all']),
    ]);
    if (headResult.stdout.trim() !== input.sourceSha || treeResult.stdout.trim() !== input.sourceTree || statusResult.stdout.trim() !== '') {
      throw new RuntimeError('CONTROL_DENIED', 'Control-only ADMIN source identity is not the exact clean reviewed checkout');
    }
    const executable = canonicalNodeRuntime().path;
    const runtimeEntrypoints = await resolveReviewedRuntimeEntrypoints(path.join(sourceRoot, 'apps/runtime'));
    const executableArguments = ['--require', runtimeEntrypoints.preflight, '--import', pathToFileURL(runtimeEntrypoints.loader).href];
    const runtimePreflightSha256 = await fileSha256(runtimeEntrypoints.preflight);
    const runtimeLoaderSha256 = await fileSha256(runtimeEntrypoints.loader);
    const executableSha256 = await fileSha256(executable);
    const machineId = await readMachineId(this.dataRoot);
    if (machineId === null) throw new RuntimeError('CONTROL_DENIED', 'Control-only ADMIN start requires a protected machine identity');
    const metadataPath = path.join(this.dataRoot, 'launchd/com.iris.supervisor.plist.metadata.json');
    const plistPath = path.join(this.dataRoot, 'launchd/com.iris.supervisor.plist');
    const beforeMetadataSha256 = await fileSha256(metadataPath);
    const beforePlistSha256 = await fileSha256(plistPath);
    if (beforeMetadataSha256 !== input.beforeMetadataSha256 || beforePlistSha256 !== input.beforePlistSha256) throw new RuntimeError('CONTROL_DENIED', 'Protected LaunchAgent before-image changed');
    const policyInput = {
      dataRoot: this.dataRoot,
      policyId: input.recoveryPolicyId,
      operation: 'ADMIN_TUNNEL_START' as const,
      requestId: input.requestId,
      sourceSha: input.sourceSha,
      sourceTree: input.sourceTree,
      sourceRoot,
      controlScript,
      executable,
      executableSha256,
      executableArguments,
      runtimePreflightSha256,
      runtimeLoaderSha256,
      beforeMetadataSha256,
      beforePlistSha256,
      machineId,
    };
    const reservation = await reserveRecoveryPolicyOperation(policyInput);
    this.startupTransactionId = reservation.transactionId;
    this.startupRecords.clear();
    try {
      state = await this.migrateHistoricalOwnership();
      await this.writeState(state, true);
      state = await this.ensureAdminTunnel(state, registry, binding.managedProfilePath, []);
      state = await this.readState();
      const record = state.adminTunnel;
      if (record === null) throw new RuntimeError('TUNNEL_NOT_RUNNING', 'Control-only ADMIN tunnel did not publish ownership');
      const readiness = await this.probeAdminTunnel(state, record, true);
      if (readiness.status.state !== 'READY') throw new RuntimeError('TUNNEL_NOT_RUNNING', readiness.status.detail);
      await this.finishStartupTransaction();
      await finalizeRecoveryPolicyOperation({ ...policyInput, transactionId: reservation.transactionId, state: 'COMMITTED' });
      return { state: 'READY', transactionId: reservation.transactionId, adminTunnelPid: record.pid, adminTunnelIdentity: ownedProcessIdentity(record), tunnelId: record.tunnelId, target: `http://127.0.0.1:${this.supervisorControlPort}/mcp`, workloadProcessesStarted: false };
    } catch (error) {
      try { await this.rollbackStarted(); } catch { /* preserve durable startup evidence */ }
      await finalizeRecoveryPolicyOperation({ ...policyInput, transactionId: reservation.transactionId, state: 'RECONCILIATION_REQUIRED' }).catch(() => undefined);
      throw error;
    }
  }

  private async upUnlocked(expectedSourceIdentity?: ActivationSourceIdentity): Promise<SupervisorStackStatus> {
    await this.migrateHistoricalOwnership();
    await this.assertStartupReconciled();
    await this.keepAwakePreference.initialize();
    await this.ensureOwnerKeepAwake();
    this.startupTransactionId = randomUUID();
    this.startupRecords.clear();
    const credentials = await inspectCredentialStatus(this.dataRoot);
    if (!credentials.controlPlaneApiKeyPresent) {
      throw new RuntimeError(credentials.legacy.detected ? 'MIGRATION_REQUIRED' : 'CREDENTIAL_MISSING', 'A persistent control-plane credential is required; run explicit credentials migration before iris up');
    }
    const registryResult = await this.ensureRegistry();
    await loadOrCreateTunnelServiceSecret(this.dataRoot);
    const runtimeId = await loadOrCreateRuntimeId(this.dataRoot);
    const boundRegistry = await bindConnectorRuntime(this.dataRoot, runtimeId);
    const unified = isUnifiedConnectorRegistry(boundRegistry);
    const registryChanged = registryResult.changed || boundRegistry.deploymentEpoch !== registryResult.registry.deploymentEpoch;
    let state = await this.readState();
    const started: Array<'runtime' | 'web' | 'admin' | 'full' | 'pro' | 'admin-tunnel'> = [];
    try {
      const observed = await runtimeStatus(this.dataRoot);
      let runtimeReplaced = false;
      let runtimeCatalogStale = false;
      const workloadUsesControlPlaneSource = sameSourceRoot(state.workloadSourceRoot, this.sourceRoot);
      const runtimeNodeChanged = observed.state === 'running' && state.runtime !== null
        && !sameExecutablePath(state.runtime.executable, canonicalNodeRuntime().path);
      if (observed.state === 'running' && state.runtime !== null
        && !await this.runningOwnershipIsVerified(state, state.runtime, state.workloadSourceRoot)) {
        throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Running Runtime ownership conflicts with its durable source-bound journal');
      }
      if (observed.state === 'running' && !registryChanged && !runtimeNodeChanged) {
        if (state.runtime === null) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'A running IRIS runtime is not owned by this supervisor; use explicit runtime adoption or stop it through its existing owner');
        assertRuntimeOwnership(state.runtime, observed);
        await assertOwnedRuntimeProcess(state.runtime);
        const serviceSecret = await readTunnelServiceSecret(this.dataRoot);
        if (workloadUsesControlPlaneSource && serviceSecret !== null && observed.endpoint !== null) {
          const catalogProbe = await probeLocalRuntime(observed.endpoint.apiUrl, serviceSecret, boundRegistry, true);
          runtimeCatalogStale = catalogProbe.catalogs.some((catalog) => catalog.state === 'STALE_RUNTIME');
        }
      }
      if (observed.state === 'running' && !registryChanged && !runtimeNodeChanged && !runtimeCatalogStale) {
        if (state.runtime === null) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'A running IRIS runtime is not owned by this supervisor; use explicit runtime adoption or stop it through its existing owner');
        assertRuntimeOwnership(state.runtime, observed);
        await assertOwnedRuntimeProcess(state.runtime);
        const upgraded = { ...await runtimeRecordFromObserved(observed.endpoint!, state.workloadSourceRoot), processStartMarker: state.runtime.processStartMarker ?? null, processExecutable: state.runtime.processExecutable ?? null };
        if (!sameOwnedRuntime(state.runtime, upgraded)) {
          state = { ...state, runtime: upgraded };
          await this.writeState(state);
        }
      } else {
        if (observed.state === 'running' && state.runtime === null) {
          throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'A running IRIS runtime cannot be replaced without supervisor ownership metadata');
        }
        if (state.runtime !== null) {
          if (observed.state === 'running') assertRuntimeOwnership(state.runtime, observed);
          await this.retireRuntime(state.runtime, observed);
        } else if (observed.state === 'stale') {
          await this.retireStaleRuntimeMetadata(observed, state.workloadSourceRoot);
        }
        const runtimeOperation = await this.prepareStartup('runtime', canonicalNodeRuntime().path, state.workloadSourceRoot, null, {});
        const startedRuntime = await this.startRecordedRuntime(runtimeOperation, {
          onSpawn: (pid) => this.observeStartupPid(runtimeOperation, pid),
          dataRoot: this.dataRoot,
          sourceRoot: state.workloadSourceRoot,
          ...(this.protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: this.protectedReferenceRoot }),
          ...(expectedSourceIdentity === undefined ? {} : { expectedSourceIdentity }),
        });
        if (startedRuntime.endpoint === null) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'IRIS runtime started without an endpoint descriptor');
        const replacement = await this.verifyStartup(runtimeOperation, await runtimeRecordFromObserved(startedRuntime.endpoint, state.workloadSourceRoot));
        if (state.runtime !== null && replacement.instanceId === state.runtime.instanceId) {
          throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Runtime replacement reused the previous instance identity');
        }
        state = { ...state, runtime: replacement };
        await this.writeState(state);
        await this.ensureRuntimeKeepAwake();
        started.push('runtime');
        runtimeReplaced = true;
      }

      const runtime = await runtimeStatus(this.dataRoot);
      if (runtime.state !== 'running' || runtime.endpoint === null) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'IRIS runtime did not become ready');
      if (state.runtime === null) {
        state = { ...state, runtime: await runtimeRecordFromObserved(runtime.endpoint, state.workloadSourceRoot) };
        await this.writeState(state);
      }
      await this.ensureRuntimeKeepAwake();
      if (expectedSourceIdentity !== undefined) {
        await assertActivationSourceIdentity(
          state.workloadSourceRoot,
          expectedSourceIdentity,
          'Candidate source identity changed after runtime launch before stack continuation',
        );
      }

      state = await this.ensureAdmin(state, started);
      const profiles = await this.writeManagedProfiles(boundRegistry, runtime.endpoint.apiUrl);
      if (this.nativeControlActive && !unified) {
        if (profiles.admin === null) throw new RuntimeError('PRECONDITION_FAILED', 'Persistent native supervisor control requires a dedicated ADMIN tunnel identity');
        state = await this.ensureAdminTunnel(state, boundRegistry, profiles.admin, started);
      }
      state = await this.ensureWeb(state, runtime.endpoint.apiUrl, started, runtimeReplaced, expectedSourceIdentity);
      state = await this.ensureTunnel(state, 'full', boundRegistry, profiles.full, runtime.endpoint.instanceId, started, runtimeReplaced);
      if (!unified && profiles.pro !== null) {
        state = await this.ensureTunnel(state, 'pro', boundRegistry, profiles.pro, runtime.endpoint.instanceId, started, runtimeReplaced);
      }
      await this.writeState(state);
      const result = await this.statusFrom(state, boundRegistry, credentials);
      if (result.localRuntime.state === 'FAILED' || result.tunnel.state === 'FAILED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `IRIS stack did not reach local and tunnel readiness: ${JSON.stringify({ runtime: result.runtime, localRuntime: result.localRuntime, tunnel: result.tunnel, connectors: result.connectors })}`);
      await this.finishStartupTransaction();
      return result;
    } catch (error) {
      try { await this.rollbackStarted(); } catch {
        throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Startup failed and cleanup remains unresolved; inspect durable supervisor state');
      }
      throw new RuntimeError(runtimeErrorCode(error), 'Supervisor startup failed; verified child cleanup completed');
    }
  }

  public async down(): Promise<SupervisorStackStatus> {
    await this.prepareDirectories();
    return this.withOperationLock('down', () => this.downUnlocked());
  }

  private async downUnlocked(): Promise<SupervisorStackStatus> {
    await this.migrateHistoricalOwnership();
    let failed = false;
    try { await this.assertStartupReconciled(); } catch { failed = true; }
    const state = await this.readState();
    for (const record of [state.web, state.tunnels.pro, state.tunnels.full, state.adminTunnel, state.runtime, state.admin]) {
      if (record === null) continue;
      try {
        const inspected = await inspectProcess(record);
        if (inspected === 'running') await this.retireForRecycle(record);
        else if (inspected === 'ambiguous') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Child ownership remains ambiguous');
        else {
          const operations = state.startupOperations.filter((op) => op.pid === record.pid && op.component === record.component && op.state === 'RUNNING');
          if (operations.length > 0) await this.cleanupStartupOperations(operations);
          else if (record.component === 'runtime') await this.retireRuntime(record, await runtimeStatus(this.dataRoot));
        }
      } catch { failed = true; }
    }
    const observed = await runtimeStatus(this.dataRoot);
    if (observed.state === 'running' || observed.state === 'indeterminate') failed = true;
    if (failed) {
      const current = await this.readState();
      await this.writeState({ ...current, recovery: { ...current.recovery, terminal: true, lastFailureCode: 'PROCESS_OWNERSHIP_AMBIGUOUS', nextAttemptAt: null } });
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Failure-stop completed safe cleanup but unresolved ownership remains');
    }
    const after = await this.readState();
    await this.writeState({ ...emptyState(after.supervisorId, after.workloadSourceRoot), startupOperations: after.startupOperations.map((op) => ({ ...op, state: 'STOPPED' as const })) }, true);
    await this.releaseOwnerKeepAwake();
    return this.status();
  }

  public async restart(): Promise<SupervisorStackStatus> {
    await this.prepareDirectories();
    return this.withOperationLock('restart', async () => {
      await this.downUnlocked();
      return this.upUnlocked();
    });
  }

  public async workloadBinding(): Promise<{ readonly sourceRoot: string }> {
    const state = await this.readState();
    return { sourceRoot: state.workloadSourceRoot };
  }

  public async replaceWorkloadSourceRoot(sourceRoot: string, expectedSourceIdentity?: ActivationSourceIdentity): Promise<SupervisorStackStatus> {
    await this.prepareDirectories();
    const normalized = path.resolve(sourceRoot);
    if (!path.isAbsolute(sourceRoot) || normalized !== sourceRoot || sourceRoot.includes('\0')) {
      throw new RuntimeError('INVALID_REQUEST', 'Workload source binding must be one normalized absolute path');
    }
    let physical: string;
    try { physical = realpathSync(normalized); }
    catch (error) { throw new RuntimeError('PRECONDITION_FAILED', 'Workload source binding does not exist', { cause: error }); }
    if (physical !== normalized) throw new RuntimeError('PRECONDITION_FAILED', 'Workload source binding must not resolve through a filesystem alias');
    if (!existsSync(path.join(normalized, 'apps', 'runtime', 'package.json')) || !existsSync(path.join(normalized, 'apps', 'web', 'package.json'))) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Workload source binding is not a complete IRIS workspace');
    }
    return this.withOperationLock('replace-workload-source', () => this.replaceWorkloadSourceRootUnlocked(normalized, expectedSourceIdentity));
  }

  private async replaceWorkloadSourceRootUnlocked(sourceRoot: string, expectedSourceIdentity?: ActivationSourceIdentity): Promise<SupervisorStackStatus> {
    await this.migrateHistoricalOwnership();
    await this.assertStartupReconciled();
    this.startupTransactionId = randomUUID();
    let state = await this.readState();
    const admin = await this.probeAdmin(state.admin);
    if (admin.state !== 'READY') throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'Persistent supervisor-admin readiness is required before workload replacement');
    if (expectedSourceIdentity !== undefined) {
      await assertActivationSourceIdentity(sourceRoot, expectedSourceIdentity, 'Candidate source identity does not match the prepared activation before preflight');
    }
    await assertActivationWorkloadReady(sourceRoot);
    if (sameSourceRoot(state.workloadSourceRoot, sourceRoot) && expectedSourceIdentity === undefined) {
      const current = await this.status();
      if (current.runtime.state === 'READY' && current.tunnel.state === 'READY' && current.controlPlane.state === 'READY' && current.localRuntime.state === 'READY') return current;
      return this.upUnlocked();
    }

    const observed = await runtimeStatus(this.dataRoot);
    if (state.runtime === null && observed.state === 'running') {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'A running workload runtime cannot be replaced without supervisor ownership metadata');
    }
    const targetCatalog = sameSourceRoot(sourceRoot, this.sourceRoot)
      ? sourceCatalogManifest()
      : await this.probeTargetCatalogManifest(sourceRoot, expectedSourceIdentity);
    if (expectedSourceIdentity !== undefined) {
      await assertActivationSourceIdentity(sourceRoot, expectedSourceIdentity, 'Candidate source identity changed during preflight before cutover');
    }
    if (state.tunnels.pro !== null) await this.retireForRecycle(state.tunnels.pro);
    state = await this.readState();
    if (state.tunnels.full !== null) await this.retireForRecycle(state.tunnels.full);
    state = await this.readState();
    if (state.web !== null) await this.retireForRecycle(state.web);
    state = await this.readState();
    if (state.runtime !== null) {
      if (observed.state === 'running') {
        assertRuntimeOwnership(state.runtime, observed);
        await this.retireForRecycle(state.runtime, CONTROLLED_ACTIVATION_SHUTDOWN_DEADLINE_MS);
      } else {
        await this.retireRuntime(state.runtime, observed);
      }
    } else if (observed.state === 'stale') {
      await this.retireStaleRuntimeMetadata(observed, state.workloadSourceRoot);
    }
    state = { ...state, workloadSourceRoot: sourceRoot, runtime: null, web: null, tunnels: { full: null, pro: null }, recovery: emptyRecovery() };
    await this.writeState(state);
    if (expectedSourceIdentity !== undefined) {
      await assertActivationSourceIdentity(sourceRoot, expectedSourceIdentity, 'Candidate source identity changed during cutover before workload relaunch');
    }
    await replaceConnectorCatalogManifest(this.dataRoot, targetCatalog);
    return this.upUnlocked(expectedSourceIdentity);
  }

  private async probeTargetCatalogManifest(sourceRoot: string, expectedSourceIdentity?: ActivationSourceIdentity): Promise<ConnectorCatalogManifest> {
    const registry = await readConnectorRegistry(this.dataRoot);
    if (registry === null) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Connector registry is required before target catalog probing');
    }
    const full = registry.connectors.find((connector) => connector.connectorId === 'iris-full');
    const pro = registry.connectors.find((connector) => connector.connectorId === 'iris-pro');
    const unified = isUnifiedConnectorRegistry(registry);
    if (full === undefined || full.runtimeId === null || (!unified && (pro === undefined || pro.runtimeId === null))) {
      throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', 'A runtime-bound workload connector identity is required before target catalog probing');
    }
    const baselineStatus = await this.catalogStatus();
    const baselineFullIdentity = baselineStatus.full.live;
    if (baselineFullIdentity === null
      || baselineFullIdentity.catalogHash !== full.catalogHash
      || baselineFullIdentity.toolCount !== full.expectedToolNames.length) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Current FULL runtime identity does not match the bound connector baseline before target probing');
    }

    const probeId = randomUUID();
    const probeDirectory = path.join(this.supervisorDirectory(), 'probes');
    await mkdir(probeDirectory, { recursive: true, mode: 0o700 });
    const probeDataRoot = path.join(probeDirectory, probeId);
    await mkdir(probeDataRoot, { mode: 0o700 });
    const probeOperation = await this.prepareStartup('runtime-probe', canonicalNodeRuntime().path, sourceRoot, null, {}, probeDataRoot, probeId);
    let manifest: ConnectorCatalogManifest | null = null;
    let failure: unknown = null;
    try {
      await initializeConnectorRegistry(probeDataRoot, unified
        ? { unified: true, fullTunnelId: full.tunnelId, fullHealthPort: full.healthPort }
        : { fullTunnelId: full.tunnelId, proTunnelId: pro!.tunnelId, fullHealthPort: full.healthPort, proHealthPort: pro!.healthPort });
      const probeRuntimeId = await loadOrCreateRuntimeId(probeDataRoot);
      await bindConnectorRuntime(probeDataRoot, probeRuntimeId);
      const serviceSecret = await loadOrCreateTunnelServiceSecret(probeDataRoot);
      const probeRegistry = await readConnectorRegistry(probeDataRoot);
      if (probeRegistry === null) {
        throw new RuntimeError('PRECONDITION_FAILED', 'Isolated target catalog probe registry was not initialized');
      }
      const probeFull = probeRegistry.connectors.find((connector) => connector.connectorId === 'iris-full');
      const probePro = probeRegistry.connectors.find((connector) => connector.connectorId === 'iris-pro');
      if (probeFull === undefined || (!unified && probePro === undefined)) {
        throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', 'Isolated target catalog probe is missing its workload connector identity');
      }

      const probe = await this.startRecordedRuntime(probeOperation, {
        onSpawn: (pid) => this.observeStartupPid(probeOperation, pid),
        dataRoot: probeDataRoot,
        preferredPort: 0,
        sourceRoot,
        ...(this.protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: this.protectedReferenceRoot }),
        ...(expectedSourceIdentity === undefined ? {} : { expectedSourceIdentity }),
      });
      if (probe.endpoint === null) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Target catalog probe runtime started without endpoint metadata');
      await this.verifyStartup(probeOperation, await runtimeRecordFromObserved(probe.endpoint, sourceRoot));
      const headersFor = (binding: ConnectorBinding, clientId: string): Record<string, string> => ({
        authorization: `Bearer ${serviceSecret}`,
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'x-iris-connector-profile': binding.mode,
        'x-iris-deployment-epoch': String(probeRegistry.deploymentEpoch),
        'x-iris-runtime-id': probeRuntimeId,
        'x-iris-client-id': clientId,
      });
      const fullIdentityRequest = postJson(`${probe.endpoint.apiUrl}${probeFull.mcpPath}`, {
          jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'catalog_identity', arguments: {} },
        }, { ...headersFor(probeFull, 'iris-supervisor-target-catalog'), 'Mcp-Name': 'catalog_identity' });
      const fullListedRequest = postJson(`${probe.endpoint.apiUrl}${probeFull.mcpPath}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headersFor(probeFull, 'iris-supervisor-target-full'));
      const [fullListed, fullIdentityResponse] = await Promise.all([fullListedRequest, fullIdentityRequest]);
      const fullNames = toolNames(fullListed);
      if (fullNames.length === 0) {
        throw new RuntimeError('MCP_CATALOG_STALE', 'Target workload catalog probe did not return a complete workload tool list');
      }
      if (unified) {
        const fullIdentity = catalogIdentityFromToolResponse(fullIdentityResponse);
        if (fullIdentity === null || fullIdentity.toolCount !== fullNames.length) throw new RuntimeError('MCP_CATALOG_STALE', 'Target unified catalog identity did not match its live tool list');
        manifest = { full: { expectedToolNames: fullNames, catalogHash: fullIdentity.catalogHash }, pro: { expectedToolNames: sourceCatalogs().PRO.names, catalogHash: sourceCatalogs().PRO.identity.catalogHash } };
      } else {
        const proListed = await postJson(`${probe.endpoint.apiUrl}${probePro!.mcpPath}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headersFor(probePro!, 'iris-supervisor-target-pro'));
        const proNames = toolNames(proListed);
        if (proNames.length === 0) throw new RuntimeError('MCP_CATALOG_STALE', 'Target workload catalog probe did not return a complete PRO tool list');
        if (proNames.length !== pro!.expectedToolNames.length || !proNames.every((name, index) => name === pro!.expectedToolNames[index])) {
          throw new RuntimeError('PRECONDITION_FAILED', 'Target workload changes the PRO catalog; bounded Phase 5 activation permits a FULL catalog transition only');
        }
        const fullIdentity = catalogIdentityFromToolResponse(fullIdentityResponse);
        if (fullIdentity === null || fullIdentity.toolCount !== fullNames.length) {
          throw new RuntimeError('MCP_CATALOG_STALE', 'Target FULL catalog identity did not match its live tool list');
        }
        const targetProDefinitions = listedToolDefinitions(proListed);
        const baselineVersionProIdentity = catalogIdentityAtVersion('PRO', targetProDefinitions, baselineFullIdentity.catalogVersion);
        if (baselineVersionProIdentity.catalogHash !== pro!.catalogHash) throw new RuntimeError('PRECONDITION_FAILED', 'Target workload changes the bounded PRO catalog schema');
        const proIdentity = catalogIdentityAtVersion('PRO', targetProDefinitions, fullIdentity.catalogVersion);
        if (proIdentity.toolCount !== proNames.length) throw new RuntimeError('MCP_CATALOG_STALE', 'Target PRO catalog identity did not match its live tool list');
        manifest = { full: { expectedToolNames: fullNames, catalogHash: fullIdentity.catalogHash }, pro: { expectedToolNames: proNames, catalogHash: proIdentity.catalogHash } };
      }
    } catch (error) {
      failure = error;
    }

    try {
      const operation = (await this.readState()).startupOperations.find((op) => op.id === probeOperation);
      if (operation === undefined) throw new RuntimeError('PERSISTENCE_FAILURE', 'Probe operation disappeared');
      await this.cleanupStartupOperations([operation]);
    } catch {
      failure = new RuntimeError('AUTHORITY_INDETERMINATE', 'Target catalog probe cleanup remains unresolved; private probe evidence retained');
    }
    if (failure !== null) throw failure;
    if (manifest === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Target catalog probe completed without a manifest or failure');
    return manifest;
  }

  public async status(): Promise<SupervisorStackStatus> {
    const state = await this.readState();
    const registry = await readConnectorRegistry(this.dataRoot);
    const credentials = await inspectCredentialStatus(this.dataRoot);
    if (registry === null) return unavailableStatus(credentials, 'MIGRATION_REQUIRED', 'Connector registry is not initialized');
    return this.statusFrom(state, registry, credentials);
  }

  public async listProjects(): Promise<Record<string, unknown>> {
    const registry = await new FoundationStateStore(this.dataRoot).read();
    return { projects: registry.projects, defaultProjectId: registry.defaultProjectId };
  }

  public async projectInfo(projectId: string): Promise<Record<string, unknown>> {
    const registry = await new FoundationStateStore(this.dataRoot).read();
    const project = registry.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new RuntimeError('PROJECT_NOT_FOUND', 'Registered project was not found');
    return { ...project };
  }

  public async runtimeStatus(): Promise<RuntimeObservedStatus> {
    await this.prepareDirectories();
    return runtimeStatus(this.dataRoot);
  }

  public async keepAwakeStatus(): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    const preference = await this.keepAwakePreference.readOrDefault();
    const observed = await this.keepAwake.snapshot();
    return { preferenceEnabled: preference.enabled, preferenceUpdatedAt: preference.updatedAt, ...observed };
  }

  public async setKeepAwakePreference(enabled: boolean): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('keep-awake-preference', async () => {
      const preference = await this.keepAwakePreference.setEnabled(enabled);
      if (enabled) await this.ensureOwnerKeepAwake();
      else await this.releaseOwnerKeepAwake();
      const observed = await this.keepAwake.snapshot();
      return { preferenceEnabled: preference.enabled, preferenceUpdatedAt: preference.updatedAt, ...observed };
    });
  }

  public async runtimeOn(expectedLifecycleBinding?: LifecycleGrantBinding, lifecycleOperationId?: string): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('runtime-on', () => this.startupTransaction(async () => {
      let state = await this.readState();
      if (expectedLifecycleBinding !== undefined) await this.assertCurrentLifecycleBinding(expectedLifecycleBinding);
      const observed = await runtimeStatus(this.dataRoot);
      if (observed.state === 'indeterminate') throw new RuntimeError('AUTHORITY_INDETERMINATE', observed.reason ?? 'Runtime authority is indeterminate');
      if (observed.state === 'stale') throw new RuntimeError('AUTHORITY_INDETERMINATE', observed.reason ?? 'Stale Runtime authority requires reconciliation');
      if (observed.state === 'running' && observed.endpoint !== null) {
        if (state.runtime === null) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'A running Runtime is not supervisor-owned');
        assertRuntimeOwnership(state.runtime, observed);
        await assertOwnedRuntimeProcess(state.runtime);
        await this.ensureRuntimeKeepAwake();
        return { state: 'RUNNING', runtimeId: observed.endpoint.runtimeId, instanceId: observed.endpoint.instanceId, alreadyRunning: true, workloadOnly: true };
      }
      if (state.runtime !== null) {
        await this.retireRuntime(state.runtime, observed);
        state = await this.readState();
      }
      const operation = await this.prepareStartup('runtime', canonicalNodeRuntime().path, state.workloadSourceRoot, null, {}, this.dataRoot, lifecycleOperationId);
      const started = await this.startRecordedRuntime(operation, {
        onSpawn: (pid) => this.observeStartupPid(operation, pid),
        dataRoot: this.dataRoot,
        sourceRoot: state.workloadSourceRoot,
        ...(this.protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: this.protectedReferenceRoot }),
      });
      if (started.endpoint === null) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Runtime started without an endpoint descriptor');
      const verified = await this.verifyStartup(operation, await runtimeRecordFromObserved(started.endpoint, state.workloadSourceRoot));
      await this.writeState({ ...state, runtime: verified });
      await this.ensureRuntimeKeepAwake();
      return { state: 'RUNNING', runtimeId: verified.runtimeId, instanceId: verified.instanceId, workloadOnly: true };
    }));
  }

  public async runtimeOff(expectedLifecycleBinding?: LifecycleGrantBinding): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('runtime-off', async () => {
      await this.migrateHistoricalOwnership();
      await this.assertStartupReconciled();
      const state = await this.readState();
      if (expectedLifecycleBinding !== undefined) await this.assertCurrentLifecycleBinding(expectedLifecycleBinding);
      const observed = await runtimeStatus(this.dataRoot);
      if (observed.state === 'stopped' && state.runtime === null) return { state: 'STOPPED', alreadyStopped: true, workloadOnly: true };
      if (observed.state !== 'running' || observed.endpoint === null || state.runtime === null) {
        throw new RuntimeError('AUTHORITY_INDETERMINATE', observed.reason ?? 'Runtime authority is not verified');
      }
      assertRuntimeOwnership(state.runtime, observed);
      await assertOwnedRuntimeProcess(state.runtime);
      await this.retireRuntime(state.runtime, observed);
      const after = await runtimeStatus(this.dataRoot);
      if (after.state !== 'stopped') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime shutdown was not durably proven');
      const cleared = await this.readState();
      await this.writeState({
        ...cleared,
        runtime: null,
        startupOperations: cleared.startupOperations.map((operation) => operation.component === 'runtime' && operation.state === 'RUNNING' ? { ...operation, state: 'STOPPED' as const } : operation),
      }, true);
      return { state: 'STOPPED', workloadOnly: true };
    });
  }

  public async issueRuntimeLifecycleGrant(input: {
    readonly requestId: string;
    readonly allowedOperations: readonly LifecycleOperation[];
    readonly expiresAt: string;
    readonly maxOperationCount: number;
  }): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('runtime-lifecycle-grant-issue', async () => {
      const binding = await this.currentLifecycleGrantBinding();
      const grant = await this.lifecycleGrants.issue({ ...input, ...binding });
      return { grantId: grant.grantId, requestId: grant.requestId, machineId: grant.machineId, tunnelId: grant.tunnelId, sourceRoot: grant.sourceRoot, sourceSha: grant.sourceSha, sourceTree: grant.sourceTree, allowedOperations: grant.allowedOperations, expiresAt: grant.expiresAt, maxOperationCount: grant.maxOperationCount, state: 'ISSUED' };
    });
  }

  public async revokeRuntimeLifecycleGrant(grantId: string): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('runtime-lifecycle-grant-revoke', async () => {
      await this.lifecycleGrants.revoke(grantId);
      return { grantId, state: 'REVOKED' };
    });
  }

  public async reconcileRuntimeLifecycleGrant(grantId: string, operationId: string): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('runtime-lifecycle-grant-reconcile', async () => {
      const grant = await this.lifecycleGrants.get(grantId);
      const operation = grant.operations.find((entry) => entry.operationId === operationId);
      if (operation === undefined) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle operation was not found');
      if (operation.state !== 'RECONCILIATION_REQUIRED' && operation.state !== 'RESERVED') throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle operation is not awaiting reconciliation');
      await this.assertCurrentLifecycleBinding(grant);
      const state = await this.readState();
      if (state.startupOperations.some((entry) => entry.component === 'runtime' && unresolvedStartup(entry))) {
        throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime startup ownership remains unresolved');
      }
      const observed = await runtimeStatus(this.dataRoot);
      let terminal: 'COMMITTED' | 'FAILED';
      let correlatedTransactionId: string | null = null;
      if (operation.operation === 'runtime_on') {
        if (observed.state === 'running' && observed.endpoint !== null && state.runtime !== null) {
          assertRuntimeOwnership(state.runtime, observed);
          await assertOwnedRuntimeProcess(state.runtime);
          const startup = state.startupOperations.find((entry) => entry.id === operationId && entry.component === 'runtime' && entry.state === 'RUNNING' && entry.pid === observed.endpoint?.pid && entry.processStartMarker === state.runtime?.processStartMarker);
          if (startup === undefined) throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime process is not correlated to the lifecycle operation');
          correlatedTransactionId = startup.transactionId;
          terminal = 'COMMITTED';
        } else if (observed.state === 'stopped' && state.runtime === null) {
          const startup = state.startupOperations.find((entry) => entry.id === operationId && entry.component === 'runtime' && ['SPAWN_FAILED', 'STOPPED'].includes(entry.state));
          if (startup === undefined) throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Failed runtime start is not correlated to the lifecycle operation');
          correlatedTransactionId = startup.transactionId;
          terminal = 'FAILED';
        } else {
          throw new RuntimeError('AUTHORITY_INDETERMINATE', observed.reason ?? 'Runtime lifecycle outcome is not provable');
        }
      } else if (observed.state === 'stopped' && state.runtime === null) {
        if (operation.target === undefined) throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime stop target identity is unavailable');
        const startup = state.startupOperations.find((entry) => entry.component === 'runtime' && entry.state === 'STOPPED' && entry.pid === operation.target?.pid && entry.processStartMarker === operation.target?.processStartMarker);
        if (startup === undefined) throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime stop process identity is not correlated to the lifecycle operation');
        correlatedTransactionId = startup.transactionId;
        terminal = 'COMMITTED';
      } else if (observed.state === 'running' && observed.endpoint !== null && state.runtime !== null) {
        assertRuntimeOwnership(state.runtime, observed);
        await assertOwnedRuntimeProcess(state.runtime);
        if (operation.target === undefined || operation.target.pid !== observed.endpoint.pid || operation.target.processStartMarker !== state.runtime.processStartMarker) throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime process identity changed during lifecycle reconciliation');
        const startup = state.startupOperations.find((entry) => entry.component === 'runtime' && entry.state === 'RUNNING' && entry.pid === observed.endpoint?.pid && entry.processStartMarker === state.runtime?.processStartMarker);
        if (startup === undefined) throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime process is not correlated to the lifecycle operation');
        correlatedTransactionId = startup.transactionId;
        terminal = 'FAILED';
      } else {
        throw new RuntimeError('AUTHORITY_INDETERMINATE', observed.reason ?? 'Runtime lifecycle outcome is not provable');
      }
      const evidence = { operation: operation.operation, observedState: observed.state, runtimeId: observed.endpoint?.runtimeId ?? null, instanceId: observed.endpoint?.instanceId ?? null, pid: observed.endpoint?.pid ?? null, transactionId: correlatedTransactionId };
      await this.lifecycleGrants.reconcile(grantId, operationId, terminal, evidence, true);
      return { grantId, operationId, state: terminal, observedState: observed.state };
    });
  }

  private async currentLifecycleGrantBinding(): Promise<LifecycleGrantBinding> {
    const state = await this.readState();
    const tunnel = state.adminTunnel;
    if (tunnel === null || tunnel.tunnelId === null || await inspectProcess(tunnel) !== 'running') throw new RuntimeError('CONTROL_DENIED', 'A verified ADMIN tunnel is required for lifecycle grant issuance');
    const tunnelWorkingDirectory = tunnel.workingDirectory;
    if (typeof tunnelWorkingDirectory !== 'string' || !sameSourceRoot(tunnelWorkingDirectory, this.sourceRoot)) throw new RuntimeError('AUTHORITY_CHANGED', 'ADMIN tunnel working directory is not bound to the Supervisor source');
    const registry = await readConnectorRegistry(this.dataRoot);
    if (registry?.admin?.tunnelId !== tunnel.tunnelId) throw new RuntimeError('AUTHORITY_CHANGED', 'Current ADMIN tunnel is not bound to the registered ADMIN connector');
    const machineId = await readMachineId(this.dataRoot);
    if (machineId === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Machine identity is unavailable');
    if (registry.admin !== null && registry.admin.machineId !== null && registry.admin.machineId !== machineId) throw new RuntimeError('AUTHORITY_CHANGED', 'Current ADMIN connector is bound to a different machine');
    const tunnelProbe = await this.probeAdminTunnel(state, tunnel);
    if (!tunnelProbe.ownershipVerified || !tunnelProbe.listenerOwnershipVerified) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'ADMIN tunnel process or listener ownership is not verified');
    let source;
    try { source = await readVerifiedSourceIdentity(this.sourceRoot); } catch (error) { throw new RuntimeError('PERSISTENCE_FAILURE', 'Current Supervisor source identity could not be verified', { cause: error }); }
    let canonicalSourceRoot: string;
    try { canonicalSourceRoot = realpathSync(this.sourceRoot); } catch (error) { throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor source root could not be canonicalized', { cause: error }); }
    let workloadSource;
    let canonicalWorkloadSourceRoot: string;
    try {
      canonicalWorkloadSourceRoot = realpathSync(state.workloadSourceRoot);
      workloadSource = await readVerifiedSourceIdentity(canonicalWorkloadSourceRoot);
    } catch (error) { throw new RuntimeError('PERSISTENCE_FAILURE', 'Current workload source identity could not be verified', { cause: error }); }
    return { machineId, tunnelId: tunnel.tunnelId, sourceRoot: canonicalSourceRoot, sourceSha: source.sha, sourceTree: source.tree, workloadSourceRoot: canonicalWorkloadSourceRoot, workloadSourceSha: workloadSource.sha, workloadSourceTree: workloadSource.tree };
  }

  private async executeRuntimeWithGrant(input: LifecycleGrantCall, operation: LifecycleOperation): Promise<Record<string, unknown>> {
    const binding = await this.currentLifecycleGrantBinding();
    if (input.tunnelId !== binding.tunnelId) throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle grant tunnel identity does not match the current ADMIN tunnel');
    const grant = await this.withOperationLock('runtime-lifecycle-grant-reserve', async () => {
      const target = operation === 'runtime_off' ? await this.lifecycleGrantRuntimeTarget() : undefined;
      return this.lifecycleGrants.reserve(binding, operation, { ...input, ...(target === undefined ? {} : { target }) });
    });
    try {
      const result = operation === 'runtime_on' ? await this.runtimeOn(binding, input.operationId) : await this.runtimeOff(binding);
      await this.withOperationLock('runtime-lifecycle-grant-commit', () => this.lifecycleGrants.complete(grant.grantId, input.operationId, 'COMMITTED', result));
      return { ...result, lifecycleGrantId: grant.grantId, lifecycleOperationId: input.operationId };
    } catch (error) {
      await this.withOperationLock('runtime-lifecycle-grant-unknown', () => this.lifecycleGrants.complete(grant.grantId, input.operationId, 'RECONCILIATION_REQUIRED'));
      throw error;
    }
  }

  public async runtimeOnAuthorized(input: LifecycleGrantCall): Promise<Record<string, unknown>> {
    return this.executeRuntimeWithGrant(input, 'runtime_on');
  }

  public async runtimeOffAuthorized(input: LifecycleGrantCall): Promise<Record<string, unknown>> {
    return this.executeRuntimeWithGrant(input, 'runtime_off');
  }

  private async assertCurrentLifecycleBinding(expected: LifecycleGrantBinding): Promise<void> {
    const current = await this.currentLifecycleGrantBinding();
    if (current.machineId !== expected.machineId || current.tunnelId !== expected.tunnelId || current.sourceRoot !== expected.sourceRoot || current.sourceSha !== expected.sourceSha || current.sourceTree !== expected.sourceTree || current.workloadSourceRoot !== expected.workloadSourceRoot || current.workloadSourceSha !== expected.workloadSourceSha || current.workloadSourceTree !== expected.workloadSourceTree) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle grant binding changed before runtime mutation');
    }
  }

  private async lifecycleGrantRuntimeTarget(): Promise<LifecycleGrantTarget | undefined> {
    const state = await this.readState();
    const runtime = state.runtime;
    if (runtime === null) return undefined;
    if (typeof runtime.processStartMarker !== 'string' || await inspectProcess(runtime) !== 'running') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime stop target identity is not live and verified');
    return { pid: runtime.pid, processStartMarker: runtime.processStartMarker!, ...(runtime.runtimeId === undefined ? {} : { runtimeId: runtime.runtimeId }), ...(runtime.instanceId === undefined ? {} : { instanceId: runtime.instanceId }) };
  }

  private async workloadMutationStatus(input: SupervisorMutationStatusInput): Promise<SupervisorAdminToolCallResult> {
    const { name, args, context } = input;
    if (args.reconcile === true) return this.reconcileWorkloadMutation(input);
    if (context.clientId === undefined) throw new RuntimeError('CONTROL_DENIED', 'Mutation evidence requires a bounded client identity');
    const durableMutation = FORWARDED_DURABLE_MUTATION_TOOLS.has(name) || groupedWorkloadDurableMutation(name, args);
    if (!durableMutation) throw new RuntimeError('CONTROL_DENIED', 'Mutation evidence is available only for durable workload mutations');
    const requestId = typeof args.requestId === 'string' && args.requestId.length > 0 && args.requestId.length <= 200 ? args.requestId : undefined;
    if (requestId === undefined) throw new RuntimeError('INVALID_REQUEST', 'Mutation evidence requires the original durable requestId');
    if (name !== 'session_open' && context.sessionId === undefined) throw new RuntimeError('INVALID_REQUEST', 'Mutation evidence requires the original session identity');
    const state = await this.readState();
    const runtime = state.runtime;
    if (runtime === null || typeof runtime.runtimeId !== 'string' || typeof runtime.instanceId !== 'string') {
      throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Current workload Runtime identity is unavailable for mutation evidence');
    }
    const registry = await readConnectorRegistry(this.dataRoot);
    if (registry === null || !Number.isSafeInteger(registry.deploymentEpoch) || registry.deploymentEpoch <= 0) {
      throw new RuntimeError('CONNECTOR_MANIFEST_STALE', 'Current workload deployment identity is unavailable for mutation evidence');
    }
    const binding: MutationBinding = {
      operation: name,
      clientId: context.clientId,
      sessionId: context.sessionId ?? null,
      projectId: typeof args.projectId === 'string' ? args.projectId : null,
      workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : null,
      runtimeId: runtime.runtimeId,
      instanceId: runtime.instanceId,
      deploymentEpoch: registry.deploymentEpoch,
    };
    // Revalidate the live runtime session before releasing cached mutation evidence.
    // A durable record is not an authorization grant after its session is revoked.
    if (context.sessionId !== undefined) {
      const sessionCheck = await this.forwardWorkloadTool('session_get', { sessionId: context.sessionId }, context);
      if (sessionCheck.isError) throw new RuntimeError('CONTROL_DENIED', 'Mutation evidence session is no longer authorized');
    }
    const projectId = typeof args.projectId === 'string' ? args.projectId : undefined;
    const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId : undefined;
    if (projectId !== undefined) {
      const projectCheck = workspaceId === undefined
        ? await this.forwardWorkloadTool('project_info', { projectId }, context)
        : await this.forwardWorkloadTool('workspace', { operation: 'get', projectId, workspaceId }, context);
      if (projectCheck.isError) throw new RuntimeError('CONTROL_DENIED', 'Mutation evidence project/workspace is no longer authorized');
    }
    const logicalFingerprint = mutationLogicalFingerprint(name, args, context);
    const record = await this.workloadMutationJournal.inspectByLogicalIdentity(requestId, logicalFingerprint, binding);
    if (record === null) {
      const existingLogical = await this.workloadMutationJournal.findByLogicalIdentity(logicalFingerprint, binding);
      if (existingLogical !== null && existingLogical.requestId !== requestId) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Mutation logical identity is already bound to another durable request');
      }
      return { structuredContent: { requestId, operation: name, state: 'NOT_FOUND', logicalFingerprint }, isError: false };
    }
    return {
      structuredContent: {
        requestId,
        operation: name,
        logicalFingerprint,
        executionFingerprint: record.fingerprint,
        state: record.state,
        errorCode: record.errorCode,
        updatedAt: record.updatedAt,
        binding: record.binding,
        ...(record.state === 'COMMITTED' ? { evidence: record.result } : {}),
        ...(record.state === 'RECONCILIATION_REQUIRED' ? { reconciliationRequired: true } : {}),
      },
      isError: false,
    };
  }

  private async reconcileWorkloadMutation(input: SupervisorMutationStatusInput): Promise<SupervisorAdminToolCallResult> {
    const { name, args, context } = input;
    if (context.clientId === undefined) throw new RuntimeError('CONTROL_DENIED', 'Mutation reconciliation requires a bounded client identity');
    if (!FORWARDED_DURABLE_MUTATION_TOOLS.has(name) && !groupedWorkloadDurableMutation(name, args)) throw new RuntimeError('CONTROL_DENIED', 'Mutation reconciliation is available only for durable workload mutations');
    const requestId = typeof args.requestId === 'string' && args.requestId.length > 0 && args.requestId.length <= 200 ? args.requestId : undefined;
    if (requestId === undefined) throw new RuntimeError('INVALID_REQUEST', 'Mutation reconciliation requires the original durable requestId');
    if (name !== 'session_open' && context.sessionId === undefined) throw new RuntimeError('INVALID_REQUEST', 'Mutation reconciliation requires the original session identity');
    const state = await this.readState();
    const runtime = state.runtime;
    if (runtime === null || typeof runtime.runtimeId !== 'string' || typeof runtime.instanceId !== 'string') throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Current workload Runtime identity is unavailable for mutation reconciliation');
    const registry = await readConnectorRegistry(this.dataRoot);
    const endpoint = await readEndpoint(this.dataRoot).catch(() => null);
    const serviceSecret = await readTunnelServiceSecret(this.dataRoot);
    if (registry === null || endpoint === null || serviceSecret === null || endpoint.runtimeId !== runtime.runtimeId || endpoint.instanceId !== runtime.instanceId
      || !Number.isSafeInteger(registry.deploymentEpoch) || registry.deploymentEpoch <= 0) {
      throw new RuntimeError('CONNECTOR_MANIFEST_STALE', 'Current workload identity is unavailable for mutation reconciliation');
    }
    const currentBinding: MutationBinding = {
      operation: name, clientId: context.clientId, sessionId: context.sessionId ?? null,
      projectId: typeof args.projectId === 'string' ? args.projectId : null,
      workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : null,
      runtimeId: endpoint.runtimeId, instanceId: endpoint.instanceId, deploymentEpoch: registry.deploymentEpoch,
    };
    const logicalFingerprint = mutationLogicalFingerprint(name, args, context);
    const record = await this.workloadMutationJournal.findByLogicalIdentity(logicalFingerprint, currentBinding);
    if (record === null) throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Mutation reconciliation evidence is unavailable');
    if (record.requestId !== requestId) throw new RuntimeError('AUTHORITY_CHANGED', 'Mutation logical identity is bound to a different durable request');
    if (record.state !== 'RECONCILIATION_REQUIRED') return {
      structuredContent: { requestId, operation: name, state: record.state, evidence: record.result, errorCode: record.errorCode, binding: record.binding },
      isError: false,
    };
    const originalBinding = record.binding;
    if (originalBinding === undefined || record.logicalFingerprint !== logicalFingerprint) throw new RuntimeError('AUTHORITY_CHANGED', 'Mutation reconciliation record lacks its authenticated binding');
    const response = await postJson(`${endpoint.apiUrl}/mcp`, {
      jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'mutation_status', arguments: {
        requestId: record.requestId, fingerprint: record.fingerprint, operation: name,
        clientId: originalBinding.clientId, sessionId: originalBinding.sessionId, projectId: originalBinding.projectId,
        workspaceId: originalBinding.workspaceId, runtimeId: originalBinding.runtimeId, instanceId: originalBinding.instanceId,
        deploymentEpoch: originalBinding.deploymentEpoch,
      } },
    }, {
      authorization: `Bearer ${serviceSecret}`, 'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Name': 'mutation_status', 'x-iris-connector-profile': 'FULL', 'x-iris-deployment-epoch': String(registry.deploymentEpoch),
      'x-iris-runtime-id': endpoint.runtimeId, 'x-iris-client-id': context.clientId,
      ...(context.sessionId === undefined ? {} : { 'x-iris-session-id': context.sessionId }),
    });
    if (!isRecord(response) || !isRecord(response.result) || response.result.isError === true || !isRecord(response.result.structuredContent)) {
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime mutation evidence is unavailable; do not retry the mutation');
    }
    const evidence = response.result.structuredContent;
    if (evidence.requestId !== record.requestId || evidence.fingerprint !== record.fingerprint || evidence.state === 'NOT_FOUND') {
      throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime mutation evidence identity does not match the Supervisor record');
    }
    if (evidence.state === 'RECONCILIATION_REQUIRED' || evidence.state === 'PREPARED' || evidence.state === 'APPLYING') {
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime mutation outcome remains unresolved; do not retry');
    }
    if (evidence.state !== 'COMMITTED' && evidence.state !== 'FAILED') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime mutation outcome is not terminal');
    const settled = await this.workloadMutationJournal.reconcile(
      record.requestId, record.fingerprint, originalBinding, evidence.state,
      evidence.state === 'COMMITTED' ? evidence.evidence : null,
      evidence.state === 'FAILED' && typeof evidence.errorCode === 'string' ? evidence.errorCode : null,
    );
    return { structuredContent: { requestId: settled.requestId, operation: name, state: settled.state, evidence: settled.result, errorCode: settled.errorCode, binding: settled.binding }, isError: false };
  }

  private async forwardWorkloadTool(name: string, args: Record<string, unknown>, context: SupervisorWorkloadCallContext = {}): Promise<SupervisorAdminToolCallResult> {
    if (context.clientId === undefined) {
      throw new RuntimeError('CONTROL_DENIED', 'Unified workload calls require a bounded client identity');
    }
    const groupedReadOnly = FORWARDED_GROUPED_READ_ONLY_TOOLS.has(name) && groupedWorkloadReadOnly(name, args);
    const durableMutation = FORWARDED_DURABLE_MUTATION_TOOLS.has(name) || groupedWorkloadDurableMutation(name, args);
    const mutation = !FORWARDED_READ_ONLY_TOOLS.has(name) && !groupedReadOnly;
    if (mutation && !durableMutation) {
      throw new RuntimeError('CONTROL_DENIED', 'Unified workload mutation has no durable idempotency contract');
    }
    const requestId = mutation
      ? (typeof args.requestId === 'string' && args.requestId.length > 0 && args.requestId.length <= 200 ? args.requestId : undefined)
      : undefined;
    if (mutation && requestId === undefined) {
      throw new RuntimeError('INVALID_REQUEST', 'Unified workload mutation requires its durable requestId');
    }
    if (mutation && name !== 'session_open' && context.sessionId === undefined) {
      throw new RuntimeError('INVALID_REQUEST', 'Unified workload mutations require a bounded session identity');
    }
    const state = await this.readState();
    if (state.runtime === null || await inspectProcess(state.runtime) !== 'running') {
      throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Workload Runtime is not supervisor-owned and ready');
    }
    const endpoint = await readEndpoint(this.dataRoot).catch(() => null);
    if (endpoint === null || endpoint.runtimeId !== state.runtime.runtimeId || endpoint.instanceId !== state.runtime.instanceId) {
      throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Workload Runtime endpoint identity is stale or ambiguous');
    }
    const registry = await readConnectorRegistry(this.dataRoot);
    const connectorBinding = registry?.connectors.find((candidate) => candidate.mode === 'FULL');
    const serviceSecret = await readTunnelServiceSecret(this.dataRoot);
    if (registry === null || connectorBinding === undefined || serviceSecret === null || connectorBinding.runtimeId !== endpoint.runtimeId || connectorBinding.deploymentEpoch !== registry.deploymentEpoch) {
      throw new RuntimeError('CONNECTOR_MANIFEST_STALE', 'Unified workload binding is not current and authenticated');
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${serviceSecret}`,
      'content-type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Name': name,
      'x-iris-connector-profile': 'FULL',
      'x-iris-deployment-epoch': String(registry.deploymentEpoch),
      'x-iris-runtime-id': endpoint.runtimeId,
      'x-iris-client-id': context.clientId,
    };
    if (context.sessionId !== undefined) headers['x-iris-session-id'] = context.sessionId;
    if (requestId !== undefined) headers['x-iris-request-id'] = requestId;
    const call = async (): Promise<SupervisorAdminToolCallResult> => {
      const response = await postJson(`${endpoint.apiUrl}/mcp`, {
        jsonrpc: '2.0', id: requestId ?? randomUUID(), method: 'tools/call', params: { name, arguments: args },
      }, headers);
      if (!isRecord(response) || !isRecord(response.result)) {
        throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Authenticated workload MCP outcome is unknown; reconcile its durable request or job state before retrying');
      }
      const result = response.result;
      return { structuredContent: result.structuredContent ?? null, isError: result.isError === true };
    };
    if (!mutation || requestId === undefined) return call();
    const mutationBinding: MutationBinding = {
      operation: name,
      clientId: context.clientId,
      sessionId: context.sessionId ?? null,
      projectId: typeof args.projectId === 'string' ? args.projectId : null,
      workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : null,
      runtimeId: endpoint.runtimeId,
      instanceId: endpoint.instanceId,
      deploymentEpoch: registry.deploymentEpoch,
    };
    const fingerprint = createHash('sha256').update(stableJson({ name, args, ...mutationBinding })).digest('hex');
    const logicalFingerprint = mutationLogicalFingerprint(name, args, context);
    const existing = await this.workloadMutationJournal.inspect(requestId, fingerprint, mutationBinding);
    if (existing?.state === 'RECONCILIATION_REQUIRED') {
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Mutation request has an unresolved outcome; verify its downstream durable result before retrying');
    }
    return this.workloadMutationJournal.execute(requestId, fingerprint, call, mutationBinding, logicalFingerprint);
  }

  public async doctor(): Promise<Record<string, unknown>> {
    const status = await this.status();
    const failedLayer = status.localRuntime.state !== 'READY'
      ? 'L1_LOCAL_RUNTIME'
      : status.tunnel.state !== 'READY' || status.controlPlane.state !== 'READY'
        ? 'L2_TUNNEL'
        : status.endToEnd.state !== 'READY' ? 'L3_END_TO_END' : null;
    const code = failedLayer === 'L1_LOCAL_RUNTIME' ? status.localRuntime.code
      : failedLayer === 'L2_TUNNEL' ? (status.tunnel.state !== 'READY' ? status.tunnel.code : status.controlPlane.code)
        : failedLayer === 'L3_END_TO_END' ? status.endToEnd.code : 'NONE';
    return {
      IRIS_STACK: status.state,
      FAILED_LAYER: failedLayer,
      CODE: code,
      L1_LOCAL_RUNTIME: status.localRuntime.state,
      L2_TUNNEL: status.tunnel.state,
      L3_END_TO_END: status.endToEnd.state,
      ACTION: actionForCode(code),
      credentials: status.credentials,
      recovery: status.recovery,
      connectors: status.connectors,
    };
  }

  public async connectors(): Promise<ConnectorRegistryDocument> {
    const registry = await readConnectorRegistry(this.dataRoot);
    if (registry === null) throw new RuntimeError('MIGRATION_REQUIRED', 'Connector registry is not initialized');
    return registry;
  }

  public async bindAdminTunnel(tunnelId: string): Promise<ConnectorRegistryDocument> {
    await this.prepareDirectories();
    return this.withOperationLock('bind-admin-tunnel', () => bindAdminTunnelIdentity(this.dataRoot, tunnelId));
  }

  public async logs(): Promise<string> {
    const filenames = [path.join(this.logDirectory(), 'supervisor.log'), path.join(this.logDirectory(), 'iris-full-tunnel.log'), path.join(this.logDirectory(), 'iris-pro-tunnel.log'), path.join(this.logDirectory(), 'iris-admin-tunnel.log')];
    const chunks: string[] = [];
    for (const filename of filenames) {
      const content = await readFile(filename, 'utf8').catch(() => '');
      if (content.length > 0) chunks.push(`--- ${path.basename(filename)} ---\n${redactLogs(tail(content, 80))}`);
    }
    return chunks.join('\n');
  }

  public async migrateCredentials(profilePath?: string): Promise<CredentialStatus> {
    if (profilePath === undefined) throw new RuntimeError('MIGRATION_REQUIRED', 'Explicit source profile is required for credential migration');
    const { migrateLegacyProfileCredential } = await import('./credentials.js');
    return migrateLegacyProfileCredential(this.dataRoot, profilePath);
  }

  public async rotateTunnelCredential(): Promise<CredentialStatus> {
    await rotateTunnelServiceSecret(this.dataRoot);
    return inspectCredentialStatus(this.dataRoot);
  }

  public async adoptRuntime(): Promise<SupervisorStackStatus> {
    await this.prepareDirectories();
    return this.withOperationLock('adopt-runtime', () => this.adoptRuntimeUnlocked());
  }

  public async runtimeReconcile(): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('runtime-reconcile', () => this.runtimeReconcileUnlocked());
  }

  private async runtimeReconcileUnlocked(): Promise<Record<string, unknown>> {
    let state = await this.migrateHistoricalOwnership();
    if (state.runtime !== null) throw new RuntimeError('PRECONDITION_FAILED', 'Runtime reconciliation requires missing supervisor runtime ownership metadata');
    const runtime = await runtimeStatus(this.dataRoot);
    if (runtime.state !== 'running' || runtime.endpoint === null) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Only a verified running IRIS runtime can be reconciled');
    if (!(await commandLooksLikeIris(runtime.endpoint.pid, state.workloadSourceRoot))) {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime process identity could not be verified against the persisted workload source binding');
    }
    const adoptedRuntime = await runtimeRecordFromObserved(runtime.endpoint, state.workloadSourceRoot);
    const registry = await readConnectorRegistry(this.dataRoot);
    if (registry === null || registry.deploymentEpoch <= 0) throw new RuntimeError('PRECONDITION_FAILED', 'A valid connector registry is required for runtime reconciliation');
    const serviceSecret = await readTunnelServiceSecret(this.dataRoot);
    if (serviceSecret === null) throw new RuntimeError('CREDENTIAL_MISSING', 'Tunnel service credential is required for runtime reconciliation');
    const full = await this.proveReconciledTunnel(state.tunnels.full, registry, 'full', runtime.endpoint, serviceSecret);
    const pro = await this.proveReconciledTunnel(state.tunnels.pro, registry, 'pro', runtime.endpoint, serviceSecret);
    const before = {
      fullIdentity: ownedProcessIdentity(state.tunnels.full),
      proIdentity: ownedProcessIdentity(state.tunnels.pro),
      adminIdentity: ownedProcessIdentity(state.admin),
      webIdentity: ownedProcessIdentity(state.web),
      workloadSourceRoot: state.workloadSourceRoot,
      deploymentEpoch: registry.deploymentEpoch,
    };
    const currentRuntime = await runtimeStatus(this.dataRoot);
    if (currentRuntime.state !== 'running' || currentRuntime.endpoint === null || !sameEndpoint(currentRuntime.endpoint, runtime.endpoint)) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime identity changed before reconciliation could be persisted');
    }
    if (await inspectProcess(full.record) !== 'running' || await inspectProcess(pro.record) !== 'running') {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'A workload tunnel identity changed before reconciliation could be persisted');
    }
    state = {
      ...state,
      runtime: adoptedRuntime,
      tunnels: {
        full: { ...full.record, instanceId: runtime.endpoint.instanceId },
        pro: { ...pro.record, instanceId: runtime.endpoint.instanceId },
      },
    };
    state = await this.persistVerifiedOwnership(
      state,
      [state.runtime, state.tunnels.full, state.tunnels.pro].filter((record): record is OwnedProcess => record !== null),
      true,
    );
    const [persisted, afterRuntime, afterRegistry] = await Promise.all([
      this.readState(),
      runtimeStatus(this.dataRoot),
      readConnectorRegistry(this.dataRoot),
    ]);
    const anchorsPreserved = afterRuntime.state === 'running' && afterRuntime.endpoint !== null
      && sameEndpoint(afterRuntime.endpoint, runtime.endpoint)
      && afterRegistry !== null && afterRegistry.deploymentEpoch === before.deploymentEpoch
      && persisted.workloadSourceRoot === before.workloadSourceRoot
      && ownedProcessIdentity(persisted.tunnels.full) === before.fullIdentity
      && ownedProcessIdentity(persisted.tunnels.pro) === before.proIdentity
      && ownedProcessIdentity(persisted.admin) === before.adminIdentity
      && ownedProcessIdentity(persisted.web) === before.webIdentity
      && persisted.runtime !== null && sameOwnedRuntime(persisted.runtime, adoptedRuntime)
      && persisted.tunnels.full?.instanceId === runtime.endpoint.instanceId
      && persisted.tunnels.pro?.instanceId === runtime.endpoint.instanceId;
    if (!anchorsPreserved) throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime reconciliation changed a protected process or workload anchor');
    await waitForTunnel(full.record.executable, full.binding.healthPort, 2_000);
    await waitForTunnel(pro.record.executable, pro.binding.healthPort, 2_000);
    return {
      runtimePid: runtime.endpoint.pid,
      runtimeId: runtime.endpoint.runtimeId,
      instanceId: runtime.endpoint.instanceId,
      fullTunnelId: full.binding.tunnelId,
      proTunnelId: pro.binding.tunnelId,
      fullTunnelPid: full.record.pid,
      proTunnelPid: pro.record.pid,
      deploymentEpoch: registry.deploymentEpoch,
      readiness: 'READY',
      workloadAnchorsPreserved: true,
    };
  }

  private async adoptRuntimeUnlocked(): Promise<SupervisorStackStatus> {
    const state = await this.migrateHistoricalOwnership();
    await this.keepAwakePreference.initialize();
    const observed = await runtimeStatus(this.dataRoot);
    if (observed.state !== 'running' || observed.endpoint === null) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Only a verified running IRIS runtime can be adopted');
    if (!(await commandLooksLikeIris(observed.endpoint.pid, state.workloadSourceRoot))) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime process identity could not be verified against the persisted workload source binding');
    if (state.runtime !== null) {
      await this.ensureOwnerKeepAwake();
      return this.status();
    }
    const adopted = await runtimeRecordFromObserved(observed.endpoint, state.workloadSourceRoot);
    await this.persistVerifiedOwnership({ ...state, runtime: adopted }, [adopted]);
    await this.ensureOwnerKeepAwake();
    await this.ensureRuntimeKeepAwake();
    return this.status();
  }

  public async runSupervisorDaemon(): Promise<void> {
    await this.prepareDirectories();
    await this.keepAwakePreference.initialize();
    const persisted = await this.readState();
    if (persisted.recovery.terminal || persisted.startupOperations.some(unresolvedStartup)) {
      // SuccessfulExit:false KeepAlive must not loop on a durable owner-decision gate.
      console.error('Supervisor recovery suspended; durable failure requires owner reconciliation');
      return;
    }
    await this.ensureOwnerKeepAwake();
    let nativeControl: Awaited<ReturnType<typeof startSupervisorNativeControlServer>> | undefined;
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      nativeControl = await startSupervisorNativeControlServer(this.dataRoot, this.supervisorControlPort, {
      supervisorStatus: () => this.supervisorNativeStatus(),
      supervisorDoctor: () => this.doctor(),
      listProjects: () => this.listProjects(),
      projectInfo: (projectId) => this.projectInfo(projectId),
      workloadToolDefinitions: () => fullMcpToolDefinitionsV21(),
      runtimeStatus: () => this.runtimeStatus(),
      runtimeOn: () => this.runtimeOn(),
      runtimeOff: () => this.runtimeOff(),
      runtimeOnAuthorized: (input) => this.runtimeOnAuthorized(input),
      runtimeOffAuthorized: (input) => this.runtimeOffAuthorized(input),
      workloadToolCall: (name, args, context) => this.forwardWorkloadTool(name, args, context),
      workloadMutationStatus: (input) => this.workloadMutationStatus(input),
      adminStatus: () => this.adminNativeStatus(),
      runtimeReconcile: () => this.runtimeReconcile(),
      adminRecycle: (input) => this.adminRecycle(input),
      adminTunnelRecycle: (input) => this.adminTunnelRecycle(input),
      adminToolCall: (name, args) => this.adminToolCall(name, args),
    });
      this.nativeControlActive = true;
      while (!stopping) {
        await this.ensureOwnerKeepAwake();
        await delay(5_000);
      }
    } catch (error) {
      if (isAddressInUse(error)) {
        const owner = await inspectSupervisorNativeOwner(this.dataRoot, this.supervisorControlPort, this.sourceRoot);
        if (owner === 'verified') {
          console.error('Authenticated identity-bound Supervisor control is already running');
          return;
        }
        // A listener that cannot prove the expected data-root credential, process
        // start identity, executable, and source argv is not ours. Exit
        // deliberately so SuccessfulExit:false does not create a relaunch loop,
        // and do not poison shared workload state with authority we do not hold.
        console.error('Supervisor control ownership is ambiguous; owner reconciliation required');
        return;
      }
      if (persisted.schemaVersion !== 4) {
        // Native-control startup has not established authority to migrate a
        // historical document. Historical ownership is migrated only by the
        // governed lifecycle paths that verify and journal every live child.
        console.error('Supervisor startup failed before historical ownership could be verified; state preserved');
        return;
      }
      const failure = await this.readState();
      await this.writeState({ ...failure, recovery: { ...failure.recovery, terminal: true, lastFailureCode: runtimeErrorCode(error), nextAttemptAt: null } });
      console.error('Supervisor startup or recovery failed; durable failure requires owner reconciliation');
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      this.nativeControlActive = false;
      await nativeControl?.close();
      await this.releaseOwnerKeepAwake().catch(() => undefined);
    }
  }

  private async automaticRecoveryTick(): Promise<void> {
    try {
      await this.withOperationLock('automatic-recovery', () => this.monitorOnceUnlocked());
    } catch (error) {
      if (runtimeErrorCode(error) === 'SUPERVISOR_BUSY') return;
      throw error;
    }
  }

  public async supervisorNativeStatus(): Promise<Record<string, unknown>> {
    const [state, registryInspection, machineId] = await Promise.all([
      this.readState(),
      inspectConnectorRegistry(this.dataRoot).catch(() => null),
      readMachineId(this.dataRoot).catch(() => null),
    ]);
    const runtimeProbe = await this.probeOwnedRuntime(state, state.runtime);
    const observed = runtimeProbe.observed;
    const registry = registryInspection?.registry ?? null;
    const unified = registry !== null && isUnifiedConnectorRegistry(registry);
    const expectedAdminEnvironmentDigest = launchEnvironmentDigest(
      supervisorAdminChildEnvironment(this.dataRoot, this.adminPort, this.protectedReferenceRoot),
    );
    const adminChildEnvironmentDigest = state.admin?.environmentDigest ?? null;
    const adminChildWorkingDirectory = state.admin?.workingDirectory ?? null;
    const adminOwnershipVerified = await this.runningOwnershipIsVerified(state, state.admin, this.sourceRoot);
    const adminSourceCoherent = adminOwnershipVerified
      && await adminProcessMatchesControlSource(state.admin, this.sourceRoot);
    const adminListenerBefore = adminOwnershipVerified && adminSourceCoherent
      ? await ownedAdminOwnsListener(state.admin, this.adminPort, this.sourceRoot, true)
      : false;
    const adminResult = adminListenerBefore
      ? await callSupervisorAdminTool(this.dataRoot, this.adminPort, 'admin_status', {}).catch(() => null)
      : null;
    const adminListenerOwnershipVerified = adminResult !== null
      && await ownedAdminOwnsListener(state.admin, this.adminPort, this.sourceRoot);
    const admin = adminResult !== null && !adminResult.isError && isRecord(adminResult.structuredContent)
      ? adminResult.structuredContent
      : null;
    const runtimeIdentityCoherent = state.runtime !== null && observed.state === 'running' && observed.endpoint !== null
      ? runtimeOwnershipMatches(state.runtime, observed)
      : false;
    const [fullTunnelOwnershipVerified, proTunnelOwnershipVerified, adminTunnelProbe] = await Promise.all([
      this.runningOwnershipIsVerified(state, state.tunnels.full, this.sourceRoot),
      this.runningOwnershipIsVerified(state, state.tunnels.pro, this.sourceRoot),
      this.probeAdminTunnel(state, state.adminTunnel),
    ]);
    const runtimeOwnershipVerified = runtimeProbe.ownershipVerified;
    const runtimeListenerOwnershipVerified = runtimeProbe.listenerOwnershipVerified;
    const adminTunnelOwnershipVerified = adminTunnelProbe.ownershipVerified;
    const adminTunnelListenerOwnershipVerified = adminTunnelProbe.listenerOwnershipVerified;
    const adminTunnelStatus = adminTunnelProbe.status;
    const keepAwakePreference = await this.keepAwakePreference.readOrDefault();
    const keepAwakeObserved = await this.keepAwake.snapshot();
    const [confirmedState, confirmedRegistryInspection] = await Promise.all([
      this.readState().catch(() => null),
      inspectConnectorRegistry(this.dataRoot).catch(() => null),
    ]);
    const authoritySnapshotCoherent = confirmedState !== null
      && JSON.stringify(confirmedState) === JSON.stringify(state)
      && JSON.stringify(confirmedRegistryInspection) === JSON.stringify(registryInspection);
    const adminEnvironmentCoherent = adminChildEnvironmentDigest !== null
      && adminChildEnvironmentDigest === expectedAdminEnvironmentDigest;
    const activeBindingIdentity = admin !== null && isRecord(admin.activeBindingIdentity) ? admin.activeBindingIdentity : null;
    const adminIdentityCoherent = activeBindingIdentity !== null
      && activeBindingIdentity.machineId === machineId
      && activeBindingIdentity.runtimeId === observed.endpoint?.runtimeId;
    const adminAuthenticated = admin !== null
      && admin.readiness === 'READY'
      && admin.adminEndpointOwner === 'PERSISTENT_SUPERVISOR_OR_CONTROL_PLANE'
      && admin.adminProcessId === state.admin?.pid
      && admin.supervisorId === state.supervisorId
      && admin.runtimeId === observed.endpoint?.runtimeId
      && admin.instanceId === observed.endpoint?.instanceId
      && admin.deploymentEpoch === registry?.deploymentEpoch;
    const fullBinding = registry?.connectors.find((binding) => binding.mode === 'FULL') ?? null;
    const proBinding = registry?.connectors.find((binding) => binding.mode === 'PRO') ?? null;
    const machineBindingCoherent = machineId !== null && registry !== null
      && registry.connectors.every((binding) => binding.machineId === machineId)
      && (unified || (registry.admin !== null && registry.admin.machineId === machineId));
    const connectorBindingCoherent = machineId !== null && observed.endpoint !== null
      && fullBinding !== null && (unified || proBinding !== null)
      && registry?.connectors.every((binding) => binding.machineId === machineId
        && binding.runtimeId === observed.endpoint?.runtimeId
        && binding.deploymentEpoch === registry.deploymentEpoch
        && binding.leaseGeneration > 0) === true
      && state.tunnels.full?.tunnelId === fullBinding.tunnelId
      && state.tunnels.full.profilePath === fullBinding.managedProfilePath
      && state.tunnels.full.runtimeId === observed.endpoint.runtimeId
      && state.tunnels.full.instanceId === observed.endpoint.instanceId
      && state.tunnels.full.deploymentEpoch === registry.deploymentEpoch
      && (unified || (state.tunnels.pro?.tunnelId === proBinding?.tunnelId
        && state.tunnels.pro?.profilePath === proBinding?.managedProfilePath
        && state.tunnels.pro?.runtimeId === observed.endpoint.runtimeId
        && state.tunnels.pro?.instanceId === observed.endpoint.instanceId
        && state.tunnels.pro?.deploymentEpoch === registry.deploymentEpoch));
    const adminTunnelBindingCoherent = registry?.admin !== null && registry?.admin !== undefined
      && machineId !== null
      && registry.admin.machineId === machineId
      && registry.admin.leaseGeneration > 0
      && state.adminTunnel?.tunnelId === registry.admin.tunnelId
      && state.adminTunnel.profilePath === registry.admin.managedProfilePath;
    const registryStale = sameSourceRoot(state.workloadSourceRoot, this.sourceRoot)
      && (registryInspection?.changed === true || (registryInspection?.staleConnectorIds.length ?? 0) > 0);
    const readinessFailures: ReadonlyArray<readonly [boolean, string]> = [
      [!authoritySnapshotCoherent, 'AUTHORITY_CHANGED'],
      [state.schemaVersion !== 4, 'STATE_SCHEMA_UNSUPPORTED'],
      [state.startupOperations.some(unresolvedStartup), 'STARTUP_RECONCILIATION_REQUIRED'],
      [state.recovery.terminal, 'RECOVERY_REQUIRED'],
      [machineId === null, 'MACHINE_IDENTITY_UNVERIFIED'],
      [registryInspection === null, 'CONNECTOR_REGISTRY_UNAVAILABLE'],
      [registryStale, 'CONNECTOR_REGISTRY_STALE'],
      [!machineBindingCoherent, 'MACHINE_IDENTITY_MISMATCH'],
      [!runtimeIdentityCoherent, 'RUNTIME_IDENTITY_MISMATCH'],
      [!runtimeOwnershipVerified, 'RUNTIME_OWNERSHIP_UNVERIFIED'],
      [!runtimeListenerOwnershipVerified, 'RUNTIME_LISTENER_OWNERSHIP_UNVERIFIED'],
      [!connectorBindingCoherent, 'CONNECTOR_BINDING_MISMATCH'],
      [!fullTunnelOwnershipVerified || (!unified && !proTunnelOwnershipVerified), 'WORKLOAD_TUNNEL_OWNERSHIP_UNVERIFIED'],
      [!adminOwnershipVerified, 'ADMIN_OWNERSHIP_UNVERIFIED'],
      [!adminSourceCoherent, 'ADMIN_SOURCE_MISMATCH'],
      [!adminListenerOwnershipVerified, 'ADMIN_LISTENER_OWNERSHIP_UNVERIFIED'],
      [!adminEnvironmentCoherent, 'ADMIN_ENVIRONMENT_MISMATCH'],
      [!adminAuthenticated, 'ADMIN_READINESS_UNVERIFIED'],
      [!adminIdentityCoherent, 'ADMIN_IDENTITY_MISMATCH'],
      [!unified && !adminTunnelOwnershipVerified, 'ADMIN_TUNNEL_OWNERSHIP_UNVERIFIED'],
      [!unified && !adminTunnelListenerOwnershipVerified, 'ADMIN_TUNNEL_LISTENER_OWNERSHIP_UNVERIFIED'],
      [!unified && !adminTunnelBindingCoherent, 'ADMIN_TUNNEL_BINDING_MISMATCH'],
      [!unified && adminTunnelStatus.state !== 'READY', 'ADMIN_TUNNEL_NOT_READY'],
    ];
    const readinessCode = readinessFailures.find(([failed]) => failed)?.[1] ?? 'READY';
    return {
      supervisorControlOwner: 'OUTER_SUPERVISOR_DAEMON',
      supervisorProcessId: process.pid,
      supervisorProcessIdentity: currentProcessIdentity(),
      controlSourceRoot: this.sourceRoot,
      controlDataRoot: this.dataRoot,
      protectedReferenceRoot: this.protectedReferenceRoot ?? null,
      readiness: readinessCode === 'READY' ? 'READY' : 'DEGRADED',
      readinessCode,
      machineId,
      workloadRuntimeId: observed.endpoint?.runtimeId ?? null,
      workloadInstanceId: observed.endpoint?.instanceId ?? null,
      workloadCatalogId: typeof admin?.fullCatalogId === 'string' ? admin.fullCatalogId : null,
      deploymentEpoch: registry?.deploymentEpoch ?? null,
      adminTunnelBindingId: registry?.admin?.tunnelId ?? null,
      adminChildIdentity: ownedProcessIdentity(state.admin),
      adminChildStartedAt: state.admin?.startedAt ?? null,
      adminChildWorkingDirectory,
      adminChildEnvironmentDigest,
      expectedAdminEnvironmentDigest,
      adminSourceCoherent,
      adminEnvironmentCoherent,
      adminIdentityCoherent,
      adminAuthenticated,
      adminListenerOwnershipVerified,
      authoritySnapshotCoherent,
      runtimeOwnershipVerified,
      runtimeListenerOwnershipVerified,
      adminOwnershipVerified,
      fullTunnelOwnershipVerified,
      proTunnelOwnershipVerified: unified ? true : proTunnelOwnershipVerified,
      adminTunnelOwnershipVerified,
      adminTunnelListenerOwnershipVerified,
      machineBindingCoherent,
      connectorBindingCoherent,
      adminTunnelBindingCoherent: unified ? true : adminTunnelBindingCoherent,
      keepAwakePreferenceEnabled: keepAwakePreference.enabled,
      keepAwakePreferenceUpdatedAt: keepAwakePreference.updatedAt,
      keepAwakeRequested: keepAwakeObserved.requested,
      keepAwakeLeaseCount: keepAwakeObserved.leaseCount,
      keepAwakeObserved: keepAwakeObserved.observed,
      keepAwakeProviderId: keepAwakeObserved.providerId,
      workloadTunnelIdentity: ownedProcessIdentity(state.tunnels.full),
      adminTunnelIdentity: ownedProcessIdentity(state.adminTunnel),
      workloadProfileDigest: state.tunnels.full?.profileDigest ?? null,
      adminProfileDigest: state.adminTunnel?.profileDigest ?? null,
    };
  }

  private async runningOwnershipIsVerified(
    state: SupervisorStateDocument,
    record: OwnedProcess | null,
    expectedSourceRoot: string,
  ): Promise<boolean> {
    return this.ownershipIsVerified(state, record, expectedSourceRoot, ['RUNNING']);
  }

  private async ownershipIsVerified(
    state: SupervisorStateDocument,
    record: OwnedProcess | null,
    expectedSourceRoot: string,
    allowedStates: readonly StartupState[],
  ): Promise<boolean> {
    if (state.schemaVersion !== 4 || record === null || await inspectProcess(record) !== 'running') return false;
    const journals = state.startupOperations.filter((operation) => allowedStates.includes(operation.state)
      && (operation.state !== 'OWNERSHIP_VERIFIED' || operation.transactionId === this.startupTransactionId)
      && startupOperationOwns(operation, record));
    if (journals.length !== 1) return false;
    const journal = journals[0]!;
    try {
      if (!sameSourceRoot(journal.sourceRoot, expectedSourceRoot)
        || !sameSourceRoot(journal.dataRoot, this.dataRoot)) return false;
      await this.assertStartupBinding(journal);
      return true;
    } catch {
      return false;
    }
  }

  private async probeOwnedRuntime(
    state: SupervisorStateDocument,
    record: OwnedProcess | null,
    allowVerifiedStartup = false,
  ): Promise<{ readonly observed: RuntimeObservedStatus; readonly ownershipVerified: boolean; readonly listenerOwnershipVerified: boolean }> {
    const unavailable = (endpoint: RuntimeObservedStatus['endpoint'] = null): RuntimeObservedStatus => ({
      state: 'indeterminate', endpoint, health: null, reason: 'RUNTIME_LISTENER_OWNERSHIP_UNVERIFIED',
    });
    if (record === null) {
      const observed = await runtimeStatus(this.dataRoot);
      return {
        observed: observed.state === 'stopped' ? observed : unavailable(observed.endpoint),
        ownershipVerified: false,
        listenerOwnershipVerified: false,
      };
    }
    const ownershipVerified = await this.ownershipIsVerified(
      state,
      record,
      state.workloadSourceRoot,
      allowVerifiedStartup ? ['RUNNING', 'OWNERSHIP_VERIFIED'] : ['RUNNING'],
    );
    if (!ownershipVerified) return { observed: unavailable(), ownershipVerified, listenerOwnershipVerified: false };
    const endpointBefore = await readEndpoint(this.dataRoot).catch(() => null);
    const runtimePort = endpointBefore === null ? null : localRuntimePort(endpointBefore.apiUrl);
    if (endpointBefore === null || runtimePort === null || !matchesRecordedRuntime(record, endpointBefore)
      || !await ownedProcessOwnsRecordedListeners(record, [runtimePort])) {
      return { observed: unavailable(endpointBefore), ownershipVerified, listenerOwnershipVerified: false };
    }
    const observed = await runtimeStatus(this.dataRoot);
    const endpointAfter = await readEndpoint(this.dataRoot).catch(() => null);
    const listenerOwnershipVerified = observed.endpoint !== null && endpointAfter !== null
      && sameEndpoint(endpointBefore, observed.endpoint) && sameEndpoint(endpointBefore, endpointAfter)
      && await ownedProcessOwnsRecordedListeners(record, [runtimePort]);
    return {
      observed: listenerOwnershipVerified ? observed : unavailable(endpointAfter ?? observed.endpoint),
      ownershipVerified,
      listenerOwnershipVerified,
    };
  }

  public async adminNativeStatus(): Promise<Record<string, unknown>> {
    const [initialState, initialRegistry] = await Promise.all([
      this.readState(),
      inspectConnectorRegistry(this.dataRoot).catch(() => null),
    ]);
    const supervisorStatus = await this.supervisorNativeStatus();
    const [probeState, probeRegistry] = await Promise.all([
      this.readState().catch(() => null),
      inspectConnectorRegistry(this.dataRoot).catch(() => null),
    ]);
    const initialAuthorityCoherent = probeState !== null
      && JSON.stringify(probeState) === JSON.stringify(initialState)
      && JSON.stringify(probeRegistry) === JSON.stringify(initialRegistry)
      && supervisorStatus.authoritySnapshotCoherent === true;
    const supervisorContractReady = supervisorStatus.readiness === 'READY'
      && supervisorStatus.adminEnvironmentCoherent === true
      && supervisorStatus.adminIdentityCoherent === true;
    const adminBefore = initialAuthorityCoherent && supervisorContractReady
      && supervisorStatus.adminOwnershipVerified === true
      && supervisorStatus.adminSourceCoherent === true
      && supervisorStatus.adminListenerOwnershipVerified === true
      && supervisorStatus.adminAuthenticated === true
      && await this.runningOwnershipIsVerified(initialState, initialState.admin, this.sourceRoot)
      && await ownedAdminOwnsListener(initialState.admin, this.adminPort, this.sourceRoot, true);
    const toolNames = adminBefore
      ? await listSupervisorAdminToolNames(this.dataRoot, this.adminPort).catch(() => null)
      : null;
    const [confirmedState, confirmedRegistry] = await Promise.all([
      this.readState().catch(() => null),
      inspectConnectorRegistry(this.dataRoot).catch(() => null),
    ]);
    const authoritySnapshotCoherent = toolNames !== null && confirmedState !== null
      && JSON.stringify(confirmedState) === JSON.stringify(initialState)
      && JSON.stringify(confirmedRegistry) === JSON.stringify(initialRegistry)
      && await this.runningOwnershipIsVerified(initialState, initialState.admin, this.sourceRoot)
      && await ownedAdminOwnsListener(initialState.admin, this.adminPort, this.sourceRoot);
    const readinessCode = !initialAuthorityCoherent ? 'AUTHORITY_CHANGED'
      : !supervisorContractReady
        ? typeof supervisorStatus.readinessCode === 'string' ? supervisorStatus.readinessCode : 'SUPERVISOR_AUTHORITY_UNVERIFIED'
        : authoritySnapshotCoherent ? 'READY' : 'ADMIN_AUTHORITY_UNVERIFIED';
    const ready = readinessCode === 'READY';
    return {
      adminChildIdentity: supervisorStatus.adminChildIdentity ?? null,
      adminChildStartedAt: supervisorStatus.adminChildStartedAt ?? null,
      adminChildWorkingDirectory: supervisorStatus.adminChildWorkingDirectory ?? null,
      adminChildEnvironmentDigest: supervisorStatus.adminChildEnvironmentDigest ?? null,
      expectedAdminEnvironmentDigest: supervisorStatus.expectedAdminEnvironmentDigest ?? null,
      protectedReferenceRoot: supervisorStatus.protectedReferenceRoot ?? null,
      adminSourceCoherent: supervisorStatus.adminSourceCoherent === true,
      adminEnvironmentCoherent: supervisorStatus.adminEnvironmentCoherent === true,
      adminListenerOwnershipVerified: supervisorStatus.adminListenerOwnershipVerified === true && authoritySnapshotCoherent,
      adminOwnershipVerified: supervisorStatus.adminOwnershipVerified === true && authoritySnapshotCoherent,
      authoritySnapshotCoherent,
      readiness: ready ? 'READY' : 'DEGRADED',
      readinessCode,
      activationStatusAvailable: ready && toolNames?.includes('activation_status') === true,
      activationPrepareAvailable: ready && toolNames?.includes('activation_prepare') === true,
      activationApplyAvailable: ready && toolNames?.includes('activation_apply') === true,
      activationConfirmAvailable: ready && toolNames?.includes('activation_confirm') === true,
      activationRollbackAvailable: ready && toolNames?.includes('activation_rollback') === true,
    };
  }

  public async adminRecycle(input: AdminRecycleInput = {}): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('admin-recycle', () => this.startupTransaction(() => this.adminRecycleUnlocked(input)));
  }

  public async adminTunnelRecycle(input: AdminTunnelRecycleInput): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('admin-tunnel-recycle', () => this.startupTransaction(() => this.adminTunnelRecycleUnlocked(input)));
  }

  private async adminTunnelRecycleUnlocked(input: AdminTunnelRecycleInput): Promise<Record<string, unknown>> {
    let state = await this.readState();
    const current = state.adminTunnel;
    if (current === null || current.component !== 'tunnel-admin') {
      throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor ADMIN tunnel is not owned');
    }
    if (await inspectProcess(current) !== 'running') {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Supervisor ADMIN tunnel identity is not live and verified');
    }
    const beforeIdentity = ownedProcessIdentity(current);
    if (beforeIdentity === null || input.expectedAdminTunnelIdentity !== beforeIdentity) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Supervisor ADMIN tunnel identity changed before recycle');
    }
    if (input.expectedAdminProfileDigest !== current.profileDigest) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Supervisor ADMIN tunnel profile digest changed before recycle');
    }
    const registry = await readConnectorRegistry(this.dataRoot);
    if (registry === null || registry.admin === null) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Supervisor ADMIN tunnel binding is unavailable');
    }
    const binding = registry.admin;
    if (current.tunnelId !== binding.tunnelId || input.expectedAdminTunnelId !== binding.tunnelId) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Supervisor ADMIN tunnel binding changed before recycle');
    }
    if (current.profilePath !== binding.managedProfilePath) {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Supervisor ADMIN tunnel profile path is not the managed ADMIN profile');
    }
    const target = `http://127.0.0.1:${this.supervisorControlPort}/mcp`;
    const credentials = credentialPaths(this.dataRoot);
    const expectedProfile = managedAdminProfile(binding, credentials.controlPlaneApiKey, credentials.tunnelServiceAuthorization, this.logDirectory(), this.adminTunnelHealthPort, target);
    const actualProfile = await readFile(binding.managedProfilePath, 'utf8').catch(() => null);
    if (actualProfile !== expectedProfile) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Managed ADMIN profile is not the corrected native-control profile');
    }
    const correctedProfileDigest = await fileSha256(binding.managedProfilePath);
    const [beforeRuntime, beforeAdminResult] = await Promise.all([
      runtimeStatus(this.dataRoot),
      callSupervisorAdminTool(this.dataRoot, this.adminPort, 'activation_status', {}),
    ]);
    if (beforeRuntime.state !== 'running' || beforeRuntime.endpoint === null) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Workload runtime must remain ready during ADMIN tunnel recycle');
    }
    const beforeActivation = requireSuccessfulAdminResult(beforeAdminResult, 'activation_status');
    const anchors = {
      runtimeId: beforeRuntime.endpoint.runtimeId,
      instanceId: beforeRuntime.endpoint.instanceId,
      deploymentEpoch: registry.deploymentEpoch,
      workloadSourceRoot: state.workloadSourceRoot,
      adminIdentity: ownedProcessIdentity(state.admin),
      fullTunnelIdentity: ownedProcessIdentity(state.tunnels.full),
      proTunnelIdentity: ownedProcessIdentity(state.tunnels.pro),
      webIdentity: ownedProcessIdentity(state.web),
      activeTransactionId: beforeActivation.activeTransactionId ?? null,
    };

    await this.retireForRecycle(current);
    state = { ...await this.readState(), adminTunnel: null };
    await this.writeState(state);
    state = await this.ensureAdminTunnel(state, registry, binding.managedProfilePath, []);
    const replacement = state.adminTunnel;
    if (replacement === null || replacement.pid === current.pid || replacement.tunnelId !== binding.tunnelId || replacement.profileDigest !== correctedProfileDigest) {
      throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Replacement ADMIN tunnel did not retain its corrected managed profile and binding');
    }
    await waitForTunnel(replacement.executable, this.adminTunnelHealthPort, 2_000);
    if (!await supervisorNativeEndpointResponds(this.dataRoot, this.supervisorControlPort)) {
      throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'Corrected ADMIN profile target did not reach native supervisor control');
    }

    const [persisted, afterRegistry, afterRuntime, afterAdminResult] = await Promise.all([
      this.readState(),
      readConnectorRegistry(this.dataRoot),
      runtimeStatus(this.dataRoot),
      callSupervisorAdminTool(this.dataRoot, this.adminPort, 'activation_status', {}),
    ]);
    const afterActivation = requireSuccessfulAdminResult(afterAdminResult, 'activation_status');
    const workloadAnchorsPreserved = afterRuntime.state === 'running' && afterRuntime.endpoint !== null
      && afterRuntime.endpoint.runtimeId === anchors.runtimeId
      && afterRuntime.endpoint.instanceId === anchors.instanceId
      && afterRegistry !== null && afterRegistry.deploymentEpoch === anchors.deploymentEpoch
      && persisted.workloadSourceRoot === anchors.workloadSourceRoot
      && ownedProcessIdentity(persisted.admin) === anchors.adminIdentity
      && ownedProcessIdentity(persisted.tunnels.full) === anchors.fullTunnelIdentity
      && ownedProcessIdentity(persisted.tunnels.pro) === anchors.proTunnelIdentity
      && ownedProcessIdentity(persisted.web) === anchors.webIdentity
      && (afterActivation.activeTransactionId ?? null) === anchors.activeTransactionId;
    if (!workloadAnchorsPreserved) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'ADMIN tunnel recycle changed a protected workload or activation anchor');
    }
    return {
      oldAdminTunnelPid: current.pid,
      newAdminTunnelPid: replacement.pid,
      adminTunnelId: binding.tunnelId,
      adminProfileDigest: correctedProfileDigest,
      target,
      readiness: 'READY',
      workloadAnchorsPreserved: true,
    };
  }

  private async adminRecycleUnlocked(input: AdminRecycleInput): Promise<Record<string, unknown>> {
    let state = await this.readState();
    if (state.admin === null) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor admin child is not owned');
    if (await inspectProcess(state.admin) !== 'running') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Supervisor admin child identity is not live and verified');
    const beforeAdminIdentity = ownedProcessIdentity(state.admin);
    if (input.expectedAdminIdentity !== undefined && input.expectedAdminIdentity !== beforeAdminIdentity) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Supervisor admin identity changed before recycle');
    }
    const beforeAdminProfileDigest = state.adminTunnel?.profileDigest ?? null;
    if (input.expectedAdminProfileDigest !== undefined && input.expectedAdminProfileDigest !== beforeAdminProfileDigest) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Supervisor admin profile digest changed before recycle');
    }
    const [beforeRuntime, beforeRegistry, beforeAdminResult] = await Promise.all([
      runtimeStatus(this.dataRoot),
      readConnectorRegistry(this.dataRoot),
      callSupervisorAdminTool(this.dataRoot, this.adminPort, 'admin_status', {}),
    ]);
    if (beforeRuntime.state !== 'running' || beforeRuntime.endpoint === null || beforeRegistry === null) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Workload runtime and connector registry must be ready before admin recycle');
    }
    const beforeAdmin = requireSuccessfulAdminResult(beforeAdminResult, 'admin_status');
    const beforeWorkloadTunnelIdentity = ownedProcessIdentity(state.tunnels.full);
    const beforeWebIdentity = ownedProcessIdentity(state.web);

    await this.retireForRecycle(state.admin);
    state = { ...await this.readState(), admin: null };
    await this.writeState(state);
    state = await this.ensureAdmin(state, []);
    if (state.admin === null) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor admin child did not restart');

    const [afterRuntime, afterRegistry, afterAdminResult] = await Promise.all([
      runtimeStatus(this.dataRoot),
      readConnectorRegistry(this.dataRoot),
      callSupervisorAdminTool(this.dataRoot, this.adminPort, 'admin_status', {}),
    ]);
    const afterAdmin = requireSuccessfulAdminResult(afterAdminResult, 'admin_status');
    const persisted = await this.readState();
    const afterAdminIdentity = ownedProcessIdentity(persisted.admin);
    const anchorsUnchanged = afterRuntime.state === 'running' && afterRuntime.endpoint !== null && afterRegistry !== null
      && afterRuntime.endpoint.runtimeId === beforeRuntime.endpoint.runtimeId
      && afterRuntime.endpoint.instanceId === beforeRuntime.endpoint.instanceId
      && afterRegistry.deploymentEpoch === beforeRegistry.deploymentEpoch
      && (afterAdmin.fullCatalogId ?? null) === (beforeAdmin.fullCatalogId ?? null)
      && ownedProcessIdentity(persisted.tunnels.full) === beforeWorkloadTunnelIdentity
      && ownedProcessIdentity(persisted.web) === beforeWebIdentity;
    if (!anchorsUnchanged) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'Workload identity changed during bounded admin-only recycle');
    }
    if (afterAdminIdentity === null || afterAdminIdentity === beforeAdminIdentity) {
      throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Admin recycle did not produce a new child identity');
    }
    const adminSourceCoherent = await adminProcessMatchesControlSource(persisted.admin, this.sourceRoot);
    if (!adminSourceCoherent) {
      throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Recycled admin child is not bound to the current control source');
    }
    const expectedAdminEnvironmentDigest = launchEnvironmentDigest(
      supervisorAdminChildEnvironment(this.dataRoot, this.adminPort, this.protectedReferenceRoot),
    );
    const adminEnvironmentCoherent = persisted.admin?.environmentDigest !== undefined
      && persisted.admin.environmentDigest !== null
      && persisted.admin.environmentDigest === expectedAdminEnvironmentDigest;
    if (!adminEnvironmentCoherent) {
      throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Recycled admin child environment does not match the current control-plane authority');
    }
    return {
      beforeAdminIdentity,
      afterAdminIdentity,
      adminIdentityChanged: true,
      adminSourceCoherent: true,
      adminEnvironmentCoherent: true,
      adminProfileDigest: persisted.adminTunnel?.profileDigest ?? null,
      adminRouteReady: afterAdmin.readiness === 'READY',
      workloadRuntimeIdUnchanged: true,
      workloadInstanceIdUnchanged: true,
      workloadCatalogIdUnchanged: true,
      workloadDeploymentEpochUnchanged: true,
      workloadTunnelUnchanged: true,
      webUnchanged: true,
    };
  }

  public async adminToolCall(name: string, args: Record<string, unknown>): Promise<SupervisorAdminToolCallResult> {
    if (!['activation_status', 'activation_prepare', 'activation_apply', 'activation_confirm', 'activation_rollback'].includes(name)) {
      throw new RuntimeError('INVALID_REQUEST', 'Only the bounded activation lifecycle is available through native supervisor control');
    }
    if (name === 'activation_prepare' || name === 'activation_apply' || name === 'activation_confirm') {
      const state = await this.readState();
      const expectedAdminEnvironmentDigest = launchEnvironmentDigest(
        supervisorAdminChildEnvironment(this.dataRoot, this.adminPort, this.protectedReferenceRoot),
      );
      const adminSourceCoherent = await adminProcessMatchesControlSource(state.admin, this.sourceRoot);
      const adminEnvironmentCoherent = state.admin?.environmentDigest !== undefined
        && state.admin.environmentDigest !== null
        && state.admin.environmentDigest === expectedAdminEnvironmentDigest;
      if (!adminSourceCoherent || !adminEnvironmentCoherent) {
        throw new RuntimeError(
          'PRECONDITION_FAILED',
          'Activation mutation requires an admin child bound to the current control source; recycle the admin child first',
        );
      }
    }
    return callSupervisorAdminTool(this.dataRoot, this.adminPort, name, args);
  }

  public async localReadiness(): Promise<LocalReadinessResult> {
    const registry = await readConnectorRegistry(this.dataRoot);
    const credentials = await readTunnelServiceSecret(this.dataRoot);
    const observed = await runtimeStatus(this.dataRoot);
    if (registry === null || credentials === null || observed.state !== 'running' || observed.endpoint === null) {
      return { status: layer('FAILED', registry === null ? 'MIGRATION_REQUIRED' : credentials === null ? 'CREDENTIAL_MISSING' : 'RUNTIME_NOT_RUNNING', 'Local runtime prerequisites are not ready'), connectors: [], catalogs: [] };
    }
    const state = await this.readState();
    return probeLocalRuntime(observed.endpoint.apiUrl, credentials, registry, sameSourceRoot(state.workloadSourceRoot, this.sourceRoot));
  }

  public async catalogStatus(): Promise<SupervisorCatalogStatus> {
    const inspection = await inspectConnectorRegistry(this.dataRoot);
    if (inspection === null) throw new RuntimeError('MIGRATION_REQUIRED', 'IRIS connector registry is not initialized');
    const registry = inspection.registry;
    const observed = await runtimeStatus(this.dataRoot);
    const credentials = await readTunnelServiceSecret(this.dataRoot);
    const sources = sourceCatalogs();
    const supervisorState = await this.readState();
    const strictCatalog = sameSourceRoot(supervisorState.workloadSourceRoot, this.sourceRoot);
    const expectedSource = (binding: ConnectorBinding): { readonly identity: McpCatalogIdentity; readonly names: readonly string[] } => strictCatalog
      ? sources[binding.mode === 'FULL' ? 'FULL' : 'PRO']
      : {
          identity: {
            profile: binding.mode === 'FULL' ? 'FULL' : 'PRO',
            catalogVersion: '2.3.0',
            catalogHash: binding.catalogHash,
            toolCount: binding.expectedToolNames.length,
          },
          names: binding.expectedToolNames,
        };
    const live = observed.state === 'running' && observed.endpoint !== null && credentials !== null
      ? await probeLocalRuntime(observed.endpoint.apiUrl, credentials, registry, strictCatalog)
      : null;
    const profiles = live?.catalogs.map((profile) => {
      const binding = registry.connectors.find((candidate) => (candidate.mode === 'FULL' ? 'FULL' : 'PRO') === profile.profile);
      return strictCatalog && binding !== undefined && inspection.staleConnectorIds.includes(binding.connectorId) && profile.state === 'ACTIVE'
        ? { ...profile, state: 'STALE_CONNECTOR' as const }
        : profile;
    }) ?? registry.connectors.map((binding) => catalogProfileStatus(binding, expectedSource(binding), null, [], false));
    const unified = isUnifiedConnectorRegistry(registry);
    const fullBinding = registry.connectors.find((binding) => binding.mode === 'FULL');
    if (fullBinding === undefined) throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', 'A workload connector binding is required');
    const proBinding = registry.connectors.find((binding) => binding.mode === 'PRO');
    const full = profiles.find((profile) => profile.profile === 'FULL') ?? catalogProfileStatus(fullBinding, expectedSource(fullBinding), null, [], false);
    const pro = unified ? null : profiles.find((profile) => profile.profile === 'PRO') ?? catalogProfileStatus(proBinding!, expectedSource(proBinding!), null, [], false);
    const state = catalogActivationState(pro === null ? [full] : [full, pro]);
    return {
      state,
      sourceMode: strictCatalog ? 'STRICT_CONTROL_SOURCE' : 'BOUND_WORKLOAD_COMPATIBILITY',
      full,
      pro,
      runtimeId: observed.endpoint?.runtimeId ?? null,
      instanceId: observed.endpoint?.instanceId ?? null,
      deploymentEpoch: registry.deploymentEpoch,
      recommendedAction: !strictCatalog && state !== 'ACTIVE'
        ? 'USE_CONTROLLED_ACTIVATION_BEFORE_CATALOG_RELOAD'
        : catalogAction(state),
    };
  }

  public async catalogReload(): Promise<SupervisorStackStatus> {
    const before = await this.catalogStatus();
    if (before.sourceMode !== 'STRICT_CONTROL_SOURCE') {
      throw new RuntimeError(
        'PRECONDITION_FAILED',
        'Catalog reload cannot replace a workload bound to another source root; use controlled activation first',
      );
    }
    if (before.state !== 'ACTIVE') await this.restart();
    const after = await this.catalogStatus();
    if (after.state !== 'ACTIVE') {
      throw new RuntimeError('MCP_CATALOG_STALE', `IRIS catalog activation did not complete: ${JSON.stringify({ state: after.state, full: after.full, pro: after.pro })}`);
    }
    return this.status();
  }

  private async monitorOnceUnlocked(): Promise<void> {
    const current = await this.status();
    const controlledTransition = current.localRuntime.state === 'DEGRADED'
      && current.localRuntime.code === 'CATALOG_IDENTITY_UNVERIFIED';
    if (current.runtime.state === 'READY'
      && current.tunnel.state === 'READY'
      && current.controlPlane.state === 'READY'
      && (current.localRuntime.state === 'READY' || controlledTransition)) {
      const state = await this.readState();
      if (state.recovery.windowStartedAt !== null && recoveryWindowExpired(state.recovery)) {
        await this.writeState({ ...state, recovery: emptyRecovery() });
      } else if (state.recovery.nextAttemptAt !== null) {
        await this.writeState({ ...state, recovery: { ...state.recovery, nextAttemptAt: null } });
      }
      return;
    }
    const state = await this.readState();
    if (state.recovery.terminal) return;
    if (state.recovery.nextAttemptAt !== null && Date.parse(state.recovery.nextAttemptAt) > Date.now()) return;
    const windowStartedAt = state.recovery.windowStartedAt === null || recoveryWindowExpired(state.recovery)
      ? new Date().toISOString()
      : state.recovery.windowStartedAt;
    const attemptsInWindow = windowStartedAt === state.recovery.windowStartedAt ? state.recovery.attempts : 0;
    if (attemptsInWindow >= MAX_RECOVERY_ATTEMPTS) {
      await this.writeState({ ...state, recovery: { ...state.recovery, attempts: attemptsInWindow, windowStartedAt, terminal: true, lastFailureCode: 'RECOVERY_REQUIRED', nextAttemptAt: null } });
      return;
    }
    const attempts = attemptsInWindow + 1;
    const nextAttemptAt = new Date(Date.now() + (RECOVERY_BACKOFF_MS[attempts - 1] ?? RECOVERY_BACKOFF_MS.at(-1)!)).toISOString();
    await this.writeState({ ...state, recovery: { attempts, terminal: false, lastFailureCode: failureCode(current), nextAttemptAt, windowStartedAt } });
    await delay(Math.max(0, Date.parse(nextAttemptAt) - Date.now()));
    try {
      await this.upUnlocked();
      const recovered = await this.readState();
      await this.writeState({ ...recovered, recovery: emptyRecovery() });
    } catch (error) {
      const failed = await this.readState();
      await this.writeState({ ...failed, recovery: { attempts, terminal: attempts >= MAX_RECOVERY_ATTEMPTS, lastFailureCode: attempts >= MAX_RECOVERY_ATTEMPTS ? 'RECOVERY_REQUIRED' : runtimeErrorCode(error), nextAttemptAt: null, windowStartedAt } });
    }
  }

  private async statusFrom(state: SupervisorStateDocument, registry: ConnectorRegistryDocument, credentials: CredentialStatus): Promise<SupervisorStackStatus> {
    if (state.startupOperations.some(unresolvedStartup)) return { ...unavailableStatus(credentials, 'PROCESS_OWNERSHIP_AMBIGUOUS', 'Startup ownership or cleanup requires reconciliation'), recovery: recoveryView(state.recovery), registryPresent: true };
    const durableState = await this.readState();
    const runtime = (await this.probeOwnedRuntime(durableState, durableState.runtime, true)).observed;
    const runtimeLayer = runtime.state === 'running' && state.runtime !== null
      ? ownershipLayer(state.runtime, runtime)
      : runtime.state === 'stopped' && state.runtime === null ? layer('FAILED', 'RUNTIME_NOT_RUNNING', 'IRIS runtime is stopped')
        : layer('FAILED', runtime.reason === 'STALE_AUTHORITY' ? 'RUNTIME_IDENTITY_MISMATCH' : 'SUPERVISOR_NOT_RUNNING', runtime.reason ?? 'IRIS runtime is not supervisor-owned');
    const webLayer = await this.probeWeb(state.web);
    const adminLayer = await this.probeAdmin(state.admin);
    const unified = isUnifiedConnectorRegistry(registry);
    const fullTunnel = await this.probeTunnel(state.tunnels.full, registry.connectors.find((connector) => connector.connectorId === 'iris-full') ?? null);
    const proTunnel = unified ? layer('READY', 'UNIFIED_CONNECTOR', 'ONE IRIS uses one public connector') : await this.probeTunnel(state.tunnels.pro, registry.connectors.find((connector) => connector.connectorId === 'iris-pro') ?? null);
    const tunnelResults = [fullTunnel, proTunnel] as const;
    const tunnelLayer = unified
      ? fullTunnel
      : tunnelResults.every((result) => result.state === 'READY') ? layer('READY', 'READY', 'FULL and PRO workload tunnel clients are healthy') : combineLayers(tunnelResults, 'TUNNEL_NOT_RUNNING', 'One or more supervisor-owned workload tunnel clients is not ready');
    const isolatedAdminRequired = (this.nativeControlActive || state.adminTunnel !== null) && !unified;
    const adminTunnelLayer = isolatedAdminRequired
      ? (await this.probeAdminTunnel(durableState, durableState.adminTunnel, true)).status
      : layer('READY', 'LEGACY_ADMIN_TRANSPORT', 'Isolated admin tunnel is required only for the persistent native supervisor daemon');
    const nativeControlLayer = isolatedAdminRequired
      ? await this.probeNativeControl()
      : layer('READY', 'LEGACY_ADMIN_TRANSPORT', 'Native supervisor control is required only for the persistent native supervisor daemon');
    const local = runtimeLayer.state === 'READY' ? await this.localReadiness() : { status: layer('FAILED', runtimeLayer.code, 'L1 requires a ready runtime'), connectors: [], catalogs: [] };
    const controlPlaneParts = [...tunnelResults, adminLayer, adminTunnelLayer, nativeControlLayer];
    const controlPlane = controlPlaneParts.every((result) => result.state === 'READY')
      ? layer('READY', 'READY', 'Workload tunnels, isolated admin tunnel, and persistent supervisor-admin endpoint are healthy')
      : combineLayers(controlPlaneParts, 'CONTROL_PLANE_UNREACHABLE', 'Control-plane readiness is not proven for workload and isolated admin transport');
    const connectorStatuses = registry.connectors.map((binding) => connectorStatus(binding, local.connectors.find((entry) => entry.connectorId === binding.connectorId), binding.connectorId === 'iris-full' ? fullTunnel : proTunnel));
    const e2e = layer('UNKNOWN', 'E2E_PROBE_UNAVAILABLE', 'No safe remote connector probe is configured; /readyz is not treated as end-to-end proof');
    const stateValue = runtimeLayer.state === 'FAILED' || local.status.state === 'FAILED' || tunnelLayer.state === 'FAILED' ? 'FAILED'
      : e2e.state === 'UNKNOWN' || webLayer.state !== 'READY' ? 'DEGRADED' : 'READY';
    return { state: stateValue, runtime: runtimeLayer, web: webLayer, tunnel: tunnelLayer, controlPlane, localRuntime: local.status, endToEnd: e2e, connectors: connectorStatuses, credentials, registryPresent: true, recovery: recoveryView((await this.readState()).recovery) };
  }

  private async retireRuntime(record: OwnedProcess, observed: RuntimeObservedStatus, shutdownDeadlineMs = 10_000): Promise<void> {
    const inspected = await inspectProcess(record);
    if (inspected === 'ambiguous') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Recorded runtime process identity is not verified');
    if (inspected === 'running') {
      if (observed.state === 'running') {
        try {
          await stopRuntime(this.dataRoot, shutdownDeadlineMs);
        } catch {
          if (await inspectProcess(record) !== 'running') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime identity changed during graceful shutdown');
          await stopOwnedProcess(record);
        }
      } else {
        await stopOwnedProcess(record);
      }
    }

    const endpoint = await readEndpoint(this.dataRoot);
    if (endpoint !== null) {
      if (!matchesRecordedRuntime(record, endpoint)) {
        if (observed.endpoint !== null && !sameEndpoint(endpoint, observed.endpoint)) {
          throw new RuntimeError('AUTHORITY_CHANGED', 'A different runtime endpoint appeared during stale-runtime cleanup');
        }
      } else {
        await removeEndpointIfInstance(this.dataRoot, endpoint.instanceId);
      }
    }
    const control = await readRuntimeControl(this.dataRoot);
    if (control !== null) {
      if (record.runtimeId !== undefined && record.runtimeId !== null && control.runtimeId !== record.runtimeId) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'A different runtime control record appeared during stale-runtime cleanup');
      }
      if (record.instanceId !== undefined && record.instanceId !== null && control.instanceId !== record.instanceId) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'A different runtime instance appeared during stale-runtime cleanup');
      }
      await removeRuntimeControlIfInstance(this.dataRoot, control.instanceId);
    }
    await this.releaseRuntimeKeepAwake();
  }

  private async ensureRuntimeKeepAwake(): Promise<void> {
    if (this.runtimeKeepAwakeLease !== null) return;
    try {
      this.runtimeKeepAwakeLease = await this.keepAwake.request('runtime');
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'CAPABILITY_DENIED') return;
      throw error;
    }
  }

  private async ensureOwnerKeepAwake(): Promise<void> {
    const preference = await this.keepAwakePreference.read();
    if (!preference.enabled) {
      await this.releaseOwnerKeepAwake();
      return;
    }
    if (this.ownerKeepAwakeLease !== null) {
      const observed = await this.keepAwake.snapshot();
      if (observed.observed === 'ACTIVE') return;
      await this.releaseOwnerKeepAwake();
    }
    try {
      this.ownerKeepAwakeLease = await this.keepAwake.request('owner-preference');
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'CAPABILITY_DENIED') return;
      throw error;
    }
  }

  private async releaseRuntimeKeepAwake(): Promise<void> {
    const lease = this.runtimeKeepAwakeLease;
    this.runtimeKeepAwakeLease = null;
    if (lease !== null) await lease.release();
  }

  private async releaseOwnerKeepAwake(): Promise<void> {
    const lease = this.ownerKeepAwakeLease;
    this.ownerKeepAwakeLease = null;
    if (lease !== null) await lease.release();
  }

  private async retireStaleRuntimeMetadata(observed: RuntimeObservedStatus, workloadSourceRoot: string): Promise<void> {
    if (observed.state !== 'stale') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime metadata is not proven stale');
    if (observed.endpoint !== null) {
      await this.retireRuntime(await runtimeRecordFromObserved(observed.endpoint, workloadSourceRoot), observed);
      return;
    }
    const control = await readRuntimeControl(this.dataRoot);
    if (control !== null) await removeRuntimeControlIfInstance(this.dataRoot, control.instanceId);
  }

  private async withOperationLock<T>(operation: string, work: () => Promise<T>): Promise<T> {
    const release = await acquireOperationLock(path.join(this.supervisorDirectory(), OPERATION_LOCK_FILE), operation);
    try {
      return await work();
    } finally {
      await release();
    }
  }

  private async ensureRegistry(): Promise<{ readonly registry: ConnectorRegistryDocument; readonly changed: boolean }> {
    let existing = await readConnectorRegistry(this.dataRoot);
    if (existing === null) {
      await seedFromLegacyProfiles(this.dataRoot);
      existing = await readConnectorRegistry(this.dataRoot);
    }
    if (existing === null) throw new RuntimeError('MIGRATION_REQUIRED', 'IRIS connector registry is not initialized');
    const state = await this.readState();
    if (!sameSourceRoot(state.workloadSourceRoot, this.sourceRoot)) {
      return { registry: existing, changed: false };
    }
    const reconciled = await reconcileConnectorRegistry(this.dataRoot);
    if (reconciled === null) throw new RuntimeError('MIGRATION_REQUIRED', 'IRIS connector registry is not initialized');
    return { registry: reconciled.registry, changed: reconciled.changed };
  }

  private async prepareDirectories(): Promise<void> {
    await ensureRuntimeDataRoot(this.dataRoot);
    for (const directory of [this.supervisorDirectory(), this.profileDirectory(), this.logDirectory()]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const problem = await privateDirectoryProblem(directory, `IRIS supervisor directory ${directory}`);
      if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
    }
  }

  private async ensureAdmin(
    state: SupervisorStateDocument,
    started: Array<'runtime' | 'web' | 'admin' | 'full' | 'pro' | 'admin-tunnel'>,
  ): Promise<SupervisorStateDocument> {
    const current = state.admin;
    if (current !== null) {
      const inspected = await inspectProcess(current);
      if (inspected === 'ambiguous') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Supervisor admin process identity changed');
      if (inspected === 'running') {
        if (await adminEndpointResponds(this.dataRoot, this.adminPort)) return state;
        await this.retireForRecycle(current);
      }
    }
    if (await endpointResponds(`http://127.0.0.1:${this.adminPort}/healthz`)) {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `Supervisor admin port ${this.adminPort} is occupied by an unowned process`);
    }
    const sourceEntrypoint = path.resolve(import.meta.dirname, 'supervisor-admin-main.ts');
    const builtEntrypoint = path.resolve(import.meta.dirname, 'supervisor-admin-main.js');
    const sourceMode = existsSync(sourceEntrypoint);
    const executable = canonicalNodeRuntime().path;
    const args = sourceMode
      ? [
        '--require', path.resolve(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'preflight.cjs'),
        '--import', pathToFileURL(path.resolve(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
        sourceEntrypoint,
      ]
      : [builtEntrypoint];
    const record = await this.spawnManaged(
      'admin', executable, args, this.sourceRoot,
      supervisorAdminChildEnvironment(this.dataRoot, this.adminPort, this.protectedReferenceRoot),
      null, this.logDirectory(), 'supervisor-admin-main', null, null, null, null, null, [this.adminPort],
    );
    const next = { ...state, admin: record };
    await this.writeState(next);
    started.push('admin');
    await waitForAdminEndpoint(this.dataRoot, this.adminPort, 10_000);
    return next;
  }

  private async ensureAdminTunnel(
    state: SupervisorStateDocument,
    registry: ConnectorRegistryDocument,
    profilePath: string,
    started: Array<'runtime' | 'web' | 'admin' | 'full' | 'pro' | 'admin-tunnel'>,
  ): Promise<SupervisorStateDocument> {
    const binding = registry.admin;
    if (binding === null) throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', 'Dedicated ADMIN connector binding is required for the admin tunnel transport');
    const profileDigest = await fileSha256(profilePath);
    const current = state.adminTunnel;
    if (current !== null) {
      const inspected = await inspectProcess(current);
      if (inspected === 'ambiguous') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Admin tunnel process identity or profile changed');
      if (inspected === 'running') {
        const profileChanged = current.profilePath !== profilePath
          || current.tunnelId !== binding.tunnelId
          || current.profileDigest !== profileDigest
          || current.workingDirectory !== this.sourceRoot;
        if (!profileChanged) {
          try {
            await waitForTunnel(current.executable, this.adminTunnelHealthPort, 750);
            return state;
          } catch {
            // Recycle only the verified admin tunnel when its own readiness fails.
          }
        }
        await this.retireForRecycle(current);
      }
    }
    const executable = await resolveExecutable(this.tunnelClientPath);
    const pidFile = path.join(this.supervisorDirectory(), 'admin.tunnel.pid');
    const record = await this.spawnManaged(
      'tunnel-admin', executable, ['run', '--profile-file', profilePath, '--pid.file', pidFile],
      this.sourceRoot, {}, profilePath, this.logDirectory(), 'tunnel-client', binding.tunnelId,
      null, null, null, profileDigest, [this.adminTunnelHealthPort],
    );
    const next = { ...state, adminTunnel: record };
    await this.writeState(next);
    started.push('admin-tunnel');
    await waitForTunnel(executable, this.adminTunnelHealthPort, current === null ? 15_000 : 2_000);
    return next;
  }

  private async ensureWeb(
    state: SupervisorStateDocument,
    runtimeUrl: string,
    started: Array<'runtime' | 'web' | 'admin' | 'full' | 'pro' | 'admin-tunnel'>,
    runtimeReplaced: boolean,
    expectedSourceIdentity?: ActivationSourceIdentity,
  ): Promise<SupervisorStateDocument> {
    if (expectedSourceIdentity !== undefined) {
      await assertActivationSourceIdentity(
        state.workloadSourceRoot,
        expectedSourceIdentity,
        'Candidate source identity changed before web startup',
      );
    }
    if (state.web !== null) {
      const inspected = await inspectProcess(state.web);
      if (inspected === 'ambiguous') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Web process identity changed');
      if (inspected === 'running' && !runtimeReplaced && await endpointResponds(`http://127.0.0.1:${this.webPort}/`)) return state;
      if (inspected === 'running') await this.retireForRecycle(state.web);
    }
    const executable = path.join(state.workloadSourceRoot, 'apps/web/node_modules/.bin/vite');
    if (!existsSync(executable)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Web executable is unavailable; run pnpm install before iris up');
    if (await endpointResponds(`http://127.0.0.1:${this.webPort}/`)) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `Web port ${this.webPort} is occupied by an unowned process`);
    const record = await this.spawnManaged('web', executable, ['--host', '127.0.0.1', '--port', String(this.webPort)], path.join(state.workloadSourceRoot, 'apps/web'), { IRIS_RUNTIME_URL: runtimeUrl }, null, this.logDirectory(), 'vite', null, null, null, null, null, [this.webPort]);
    const next = { ...state, web: record };
    await this.writeState(next);
    started.push('web');
    await waitForEndpoint(`http://127.0.0.1:${this.webPort}/`, 10_000, 'Web did not become ready');
    return next;
  }

  private async ensureTunnel(
    state: SupervisorStateDocument,
    profile: 'full' | 'pro',
    registry: ConnectorRegistryDocument,
    profilePath: string,
    runtimeInstanceId: string,
    started: Array<'runtime' | 'web' | 'admin' | 'full' | 'pro' | 'admin-tunnel'>,
    runtimeReplaced: boolean,
  ): Promise<SupervisorStateDocument> {
    const current = state.tunnels[profile];
    const binding = registry.connectors.find((connector) => connector.connectorId === (profile === 'full' ? 'iris-full' : 'iris-pro'));
    if (binding === undefined) throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', `Missing ${profile} connector binding`);
    const profileDigest = await fileSha256(profilePath);
    if (current !== null) {
      const inspected = await inspectProcess(current);
      if (inspected === 'ambiguous') {
        throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `${profile} tunnel process identity or profile changed`);
      }
      if (inspected === 'running') {
        const deploymentChanged = current.profilePath !== profilePath
          || current.tunnelId !== binding.tunnelId
          || current.deploymentEpoch !== registry.deploymentEpoch
          || current.runtimeId !== binding.runtimeId
          || current.instanceId !== runtimeInstanceId
          || current.profileDigest !== profileDigest
          || current.workingDirectory !== this.sourceRoot
          || runtimeReplaced;
        if (!deploymentChanged) {
          try {
            await waitForTunnel(current.executable, binding.healthPort, 750);
            return state;
          } catch {
            // A live process with failed readiness is still an owned process. Recycle it
            // only after the same positive process identity check used for shutdown.
          }
        }
        await this.retireForRecycle(current);
      }
      if (inspected === 'stopped') {
        // The stale record is safe to replace; no signal is sent to the old PID.
      }
    }
    const pidFile = path.join(this.supervisorDirectory(), `${profile}.tunnel.pid`);
    const executable = await resolveExecutable(this.tunnelClientPath);
    const record = await this.spawnManaged(`tunnel-${profile}`, executable, ['run', '--profile-file', profilePath, '--pid.file', pidFile], this.sourceRoot, {}, profilePath, this.logDirectory(), 'tunnel-client', binding.tunnelId, registry.deploymentEpoch, runtimeInstanceId, binding.runtimeId, profileDigest, [binding.healthPort]);
    const next = { ...state, tunnels: { ...state.tunnels, [profile]: record } };
    await this.writeState(next);
    started.push(profile);
    await waitForTunnel(executable, binding.healthPort, current === null ? 15_000 : 2_000);
    return next;
  }

  private async proveReconciledTunnel(
    record: OwnedProcess | null,
    registry: ConnectorRegistryDocument,
    profile: 'full' | 'pro',
    endpoint: NonNullable<RuntimeObservedStatus['endpoint']>,
    serviceSecret: string,
  ): Promise<{ readonly record: OwnedProcess; readonly binding: ConnectorBinding }> {
    const binding = registry.connectors.find((connector) => connector.connectorId === (profile === 'full' ? 'iris-full' : 'iris-pro'));
    const expectedComponent = profile === 'full' ? 'tunnel-full' : 'tunnel-pro';
    if (record === null || binding === undefined || record.component !== expectedComponent) {
      throw new RuntimeError('PRECONDITION_FAILED', `${profile} tunnel ownership metadata is unavailable`);
    }
    if (await inspectProcess(record) !== 'running') {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `${profile} tunnel process identity is not live and verified`);
    }
    if (record.tunnelId !== binding.tunnelId || record.runtimeId !== endpoint.runtimeId
      || record.deploymentEpoch !== registry.deploymentEpoch || record.profilePath !== binding.managedProfilePath
      || binding.runtimeId !== endpoint.runtimeId || binding.deploymentEpoch !== registry.deploymentEpoch) {
      throw new RuntimeError('PRECONDITION_FAILED', `${profile} tunnel binding metadata does not match the active runtime binding`);
    }
    const expectedProfile = managedProfile(binding, credentialPaths(this.dataRoot).controlPlaneApiKey, credentialPaths(this.dataRoot).tunnelServiceAuthorization,
      this.logDirectory(), registry.deploymentEpoch, endpoint.apiUrl, null);
    const actualProfile = await readFile(binding.managedProfilePath, 'utf8').catch(() => null);
    if (actualProfile !== expectedProfile || await fileSha256(binding.managedProfilePath) !== record.profileDigest) {
      throw new RuntimeError('PRECONDITION_FAILED', `${profile} tunnel profile is not the verified active runtime profile`);
    }
    await waitForTunnel(record.executable, binding.healthPort, 2_000);
    const headers = {
      authorization: `Bearer ${serviceSecret}`,
      'content-type': 'application/json',
      'x-iris-connector-profile': binding.mode,
      'x-iris-deployment-epoch': String(registry.deploymentEpoch),
      'x-iris-runtime-id': binding.runtimeId ?? '',
      'x-iris-client-id': binding.mode === 'FULL' ? 'iris-supervisor-full' : 'iris-supervisor-pro',
      'MCP-Protocol-Version': '2026-07-28',
    };
    const api = `${endpoint.apiUrl}${binding.mcpPath}`;
    const discovered = await postJson(api, { jsonrpc: '2.0', id: 1, method: 'server/discover' }, headers);
    if (!isExpectedDiscovery(discovered, binding.mode)) {
      throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', `${profile} tunnel route did not reach the authenticated active runtime`);
    }
    const listed = await postJson(api, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers);
    const names = toolNames(listed);
    if (names.length !== binding.expectedToolNames.length || !names.every((name, index) => name === binding.expectedToolNames[index])) {
      throw new RuntimeError('MCP_CATALOG_STALE', `${profile} tunnel route did not preserve the bound live catalog`);
    }
    if (binding.mode === 'FULL') {
      const identityResponse = await postJson(api, {
        jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'catalog_identity', arguments: {} },
      }, { ...headers, 'Mcp-Name': 'catalog_identity' });
      const identity = runtimeIdentityFromFullCatalogToolResponse(identityResponse);
      if (identity === null || identity.runtimeId !== endpoint.runtimeId || identity.instanceId !== endpoint.instanceId
        || identity.deploymentEpoch !== registry.deploymentEpoch || identity.catalogHash !== binding.catalogHash) {
        throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'FULL tunnel route did not identify the active runtime instance and binding');
      }
    }
    return { record, binding };
  }

  private async probeWeb(record: OwnedProcess | null): Promise<LayerStatus> {
    if (record === null) return layer('FAILED', 'SUPERVISOR_NOT_RUNNING', 'Web is not supervisor-owned');
    const inspected = await inspectProcess(record);
    if (inspected === 'ambiguous') return layer('FAILED', 'PROCESS_OWNERSHIP_AMBIGUOUS', 'Web process identity is ambiguous');
    if (inspected === 'stopped') return layer('FAILED', 'TUNNEL_NOT_RUNNING', 'Web process is stopped');
    return await endpointResponds(`http://127.0.0.1:${this.webPort}/`) ? layer('READY', 'READY', 'Local web UI is responding') : layer('FAILED', 'CONTROL_PLANE_UNREACHABLE', 'Local web UI is not responding');
  }

  private async probeAdmin(record: OwnedProcess | null): Promise<LayerStatus> {
    if (record === null) return layer('FAILED', 'SUPERVISOR_NOT_RUNNING', 'Supervisor admin is not supervisor-owned');
    const inspected = await inspectProcess(record);
    if (inspected === 'ambiguous') return layer('FAILED', 'PROCESS_OWNERSHIP_AMBIGUOUS', 'Supervisor admin process identity is ambiguous');
    if (inspected === 'stopped') return layer('FAILED', 'SUPERVISOR_NOT_RUNNING', 'Supervisor admin process is stopped');
    return await adminEndpointResponds(this.dataRoot, this.adminPort)
      ? layer('READY', 'READY', 'Persistent supervisor-admin endpoint is authenticated and responding')
      : layer('FAILED', 'CONTROL_PLANE_UNREACHABLE', 'Persistent supervisor-admin endpoint is not authenticated and ready');
  }

  private async probeTunnel(record: OwnedProcess | null, binding: ConnectorBinding | null): Promise<LayerStatus> {
    if (record === null || binding === null) return layer('FAILED', 'TUNNEL_NOT_RUNNING', 'Tunnel is not supervisor-owned');
    const inspected = await inspectProcess(record);
    if (inspected === 'ambiguous') return layer('FAILED', 'PROCESS_OWNERSHIP_AMBIGUOUS', 'Tunnel process identity is ambiguous');
    if (inspected === 'stopped') return layer('FAILED', 'TUNNEL_NOT_RUNNING', 'Tunnel process is stopped');
    try {
      await waitForTunnel(record.executable, binding.healthPort, 2_000);
      return layer('READY', 'READY', `${binding.label} tunnel health and readiness are healthy`);
    } catch (error) {
      return layer('FAILED', runtimeErrorCode(error), `${binding.label} tunnel readiness failed`);
    }
  }

  private async probeNativeControl(): Promise<LayerStatus> {
    return await supervisorNativeEndpointResponds(this.dataRoot, this.supervisorControlPort)
      ? layer('READY', 'READY', 'Authenticated outer supervisor native control endpoint is responding')
      : layer('FAILED', 'CONTROL_PLANE_UNREACHABLE', 'Outer supervisor native control endpoint is not authenticated and ready');
  }

  private async probeAdminTunnel(
    state: SupervisorStateDocument,
    record: OwnedProcess | null,
    allowVerifiedStartup = false,
  ): Promise<{ readonly status: LayerStatus; readonly ownershipVerified: boolean; readonly listenerOwnershipVerified: boolean }> {
    if (record === null) return {
      status: layer('FAILED', 'TUNNEL_NOT_RUNNING', 'Isolated admin tunnel is not supervisor-owned'),
      ownershipVerified: false,
      listenerOwnershipVerified: false,
    };
    const ownershipVerified = await this.ownershipIsVerified(
      state,
      record,
      this.sourceRoot,
      allowVerifiedStartup ? ['RUNNING', 'OWNERSHIP_VERIFIED'] : ['RUNNING'],
    );
    if (!ownershipVerified) return {
      status: layer('FAILED', 'PROCESS_OWNERSHIP_AMBIGUOUS', 'Isolated admin tunnel durable ownership is unverified'),
      ownershipVerified: false,
      listenerOwnershipVerified: false,
    };
    if (!await ownedProcessOwnsRecordedListeners(record, [this.adminTunnelHealthPort])) return {
      status: layer('FAILED', 'ADMIN_TUNNEL_LISTENER_OWNERSHIP_UNVERIFIED', 'Isolated admin tunnel listener ownership is unverified'),
      ownershipVerified: true,
      listenerOwnershipVerified: false,
    };
    try {
      await waitForTunnel(record.executable, this.adminTunnelHealthPort, 2_000);
      const listenerOwnershipVerified = await ownedProcessOwnsRecordedListeners(record, [this.adminTunnelHealthPort]);
      return listenerOwnershipVerified
        ? { status: layer('READY', 'READY', 'Isolated admin tunnel health and readiness are healthy'), ownershipVerified: true, listenerOwnershipVerified: true }
        : { status: layer('FAILED', 'ADMIN_TUNNEL_LISTENER_OWNERSHIP_UNVERIFIED', 'Isolated admin tunnel listener ownership changed during readiness'), ownershipVerified: true, listenerOwnershipVerified: false };
    } catch (error) {
      return {
        status: layer('FAILED', runtimeErrorCode(error), 'Isolated admin tunnel readiness failed'),
        ownershipVerified: true,
        listenerOwnershipVerified: await ownedProcessOwnsRecordedListeners(record, [this.adminTunnelHealthPort]),
      };
    }
  }

  private async writeManagedProfiles(registry: ConnectorRegistryDocument, runtimeApiUrl: string): Promise<{ readonly full: string; readonly pro: string | null; readonly admin: string | null }> {
    const credentials = credentialPaths(this.dataRoot);
    const full = registry.connectors.find((connector) => connector.connectorId === 'iris-full');
    const pro = registry.connectors.find((connector) => connector.connectorId === 'iris-pro');
    if (full === undefined) throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', 'A workload connector binding is required');
    const fullPath = full.managedProfilePath;
    const proPath = pro?.managedProfilePath ?? null;
    const adminPath = registry.admin?.managedProfilePath ?? null;
    await writePrivateText(fullPath, managedProfile(full, credentials.controlPlaneApiKey, credentials.tunnelServiceAuthorization, this.logDirectory(), registry.deploymentEpoch, runtimeApiUrl, null));
    if (pro !== undefined && proPath !== null) {
      await writePrivateText(proPath, managedProfile(pro, credentials.controlPlaneApiKey, credentials.tunnelServiceAuthorization, this.logDirectory(), registry.deploymentEpoch, runtimeApiUrl, null));
    }
    if (registry.admin !== null && adminPath !== null) {
      await writePrivateText(adminPath, managedAdminProfile(registry.admin, credentials.controlPlaneApiKey, credentials.tunnelServiceAuthorization, this.logDirectory(), this.adminTunnelHealthPort, `http://127.0.0.1:${this.supervisorControlPort}/mcp`));
    }
    return { full: fullPath, pro: proPath, admin: adminPath };
  }

  private async rollbackStarted(): Promise<void> {
    const operations = (await this.readState()).startupOperations.filter((op) => op.transactionId === this.startupTransactionId);
    await this.cleanupStartupOperations(operations);
  }

  private async cleanupStartupOperations(operations: readonly StartupOperation[]): Promise<void> {
    let failed = false;
    for (const operation of [...operations].reverse()) {
      if (operation.state === 'STOPPED' || operation.state === 'SPAWN_FAILED') continue;
      try { await this.cleanupStartupOperation(operation); }
      catch (error) {
        failed = true;
        try {
          await this.updateStartup(operation.id, runtimeErrorCode(error) === 'PROCESS_OWNERSHIP_AMBIGUOUS' ? 'RECONCILIATION_REQUIRED' : 'CLEANUP_FAILED', { failureCode: runtimeErrorCode(error) });
        } catch { /* Preserve the last durable intent and continue other independently safe cleanup. */ }
      }
    }
    if (failed) {
      const state = await this.readState();
      await this.writeState({ ...state, recovery: { ...state.recovery, terminal: true, lastFailureCode: 'PROCESS_OWNERSHIP_AMBIGUOUS', nextAttemptAt: null } });
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Cleanup remains unresolved; owner reconciliation required');
    }
  }

  private async assertStartupBinding(operation: StartupOperation): Promise<void> {
    const state = await this.readState();
    const owner = observeProcessStart(operation.supervisorPid);
    if (owner.state === 'indeterminate' || owner.state === 'live' && owner.marker === operation.supervisorStartMarker && operation.supervisorPid !== process.pid) {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Original supervisor ownership is still live or indeterminate');
    }
    if (realpathSync(operation.sourceRoot) !== operation.sourceRoot || realpathSync(operation.dataRoot) !== operation.dataRoot) {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Startup physical binding changed');
    }
    if (operation.component === 'runtime-probe') {
      const relative = path.relative(realpathSync(this.supervisorDirectory()), operation.dataRoot);
      if (relative !== path.join('probes', operation.id) || await privateDirectoryProblem(operation.dataRoot, 'Probe root') !== null) {
        throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Probe ownership root is not bound to this supervisor');
      }
    } else if (operation.dataRoot !== realpathSync(this.dataRoot)
      || ![this.sourceRoot, path.join(this.sourceRoot, 'apps/web'), state.workloadSourceRoot, path.join(state.workloadSourceRoot, 'apps/web')]
        .some((root) => sameSourceRoot(root, operation.sourceRoot))) {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Startup source or data root does not match supervisor authority');
    }
  }

  private async cleanupStartupOperation(operation: StartupOperation, runtimeShutdownDeadlineMs = 10_000): Promise<void> {
    await this.assertStartupBinding(operation);
    // PREPARED is durably ordered before SPAWNING and therefore before OS creation.
    if (operation.state === 'PREPARED' && operation.pid === null) {
      await this.updateStartup(operation.id, 'STOPPED');
      return;
    }
    if (operation.pid === null) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Spawn outcome has no durable child identity');
    const identity = observeProcessStart(operation.pid);
    const originalGone = identity.state === 'dead' || identity.state === 'live' && operation.processStartMarker !== null && identity.marker !== operation.processStartMarker;
    const state = await this.readState();
    const component = operation.component === 'runtime-probe' ? 'runtime' : operation.component;
    const published = component === 'tunnel-full' ? state.tunnels.full : component === 'tunnel-pro' ? state.tunnels.pro
      : component === 'tunnel-admin' ? state.adminTunnel : component === 'runtime' ? state.runtime : component === 'web' ? state.web : state.admin;
    const record = this.startupRecords.get(operation.id) ?? (isOwnedProcess(operation.ownedProcess) ? operation.ownedProcess : published);
    const recordMatches = record !== null && record !== undefined && record.component === component && record.pid === operation.pid
      && record.processStartMarker === operation.processStartMarker && record.processExecutable === operation.processExecutable
      && sameExecutablePath(record.executable, operation.executable) && record.profilePath === operation.profilePath;
    if (!originalGone && (!recordMatches || identity.state !== 'live' || operation.processStartMarker === null
      || identity.marker !== operation.processStartMarker || operation.processExecutable === null
      || await executableForPid(operation.pid) !== operation.processExecutable || await inspectProcess(record!) !== 'running')) {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Cleanup requires exact verified child ownership');
    }
    await this.updateStartup(operation.id, 'CLEANUP_PENDING');
    if (!originalGone) {
      if (component === 'runtime') {
        const observed = await runtimeStatus(operation.dataRoot);
        assertRuntimeOwnership(record!, observed);
        if (await inspectProcess(record!) !== 'running') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime process identity changed before instance-bound stop');
        await stopRuntime(operation.dataRoot, runtimeShutdownDeadlineMs);
      } else await stopOwnedProcess(record!);
    }
    if (component === 'runtime') {
      if (recordMatches) {
        for (const port of record!.listenerPorts ?? []) if (!await listenerReleased(port)) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime listener release is unverified');
        if (originalGone) {
          const endpoint = await readEndpoint(operation.dataRoot);
          if (endpoint !== null) {
            if (!matchesRecordedRuntime(record!, endpoint)) throw new RuntimeError('AUTHORITY_CHANGED', 'Different runtime endpoint prevents cleanup');
            await removeEndpointIfInstance(operation.dataRoot, endpoint.instanceId);
          }
          const control = await readRuntimeControl(operation.dataRoot);
          if (control !== null) {
            if (control.instanceId !== record!.instanceId || control.runtimeId !== record!.runtimeId) throw new RuntimeError('AUTHORITY_CHANGED', 'Different runtime control prevents cleanup');
            await removeRuntimeControlIfInstance(operation.dataRoot, control.instanceId);
          }
        }
      } else if ((await runtimeStatus(operation.dataRoot)).state !== 'stopped') {
        throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Exited runtime has unverified authority or listener state');
      }
    }
    if (operation.component !== 'runtime-probe' && record != null) {
      if (record.listenerPorts === undefined) {
        throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Spawn-time listener ownership is unavailable');
      }
      for (const port of record.listenerPorts) {
        if (!await listenerReleased(port)) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Child exited but listener release is unverified');
      }
      const next = await this.readState();
      const current = component === 'tunnel-full' ? next.tunnels.full : component === 'tunnel-pro' ? next.tunnels.pro
        : component === 'tunnel-admin' ? next.adminTunnel : component === 'runtime' ? next.runtime : component === 'web' ? next.web : next.admin;
      if (current !== null && record != null && current.pid === record.pid && current.startedAt === record.startedAt
        && current.executable === record.executable && (current.processStartMarker == null || current.processStartMarker === operation.processStartMarker)) {
        await this.writeState(component === 'tunnel-full' ? { ...next, tunnels: { ...next.tunnels, full: null } }
          : component === 'tunnel-pro' ? { ...next, tunnels: { ...next.tunnels, pro: null } }
            : component === 'tunnel-admin' ? { ...next, adminTunnel: null } : { ...next, [component]: null });
      }
    }
    await this.updateStartup(operation.id, 'STOPPED');
    this.startupRecords.delete(operation.id);
    // Retain the probe root until separate evidence cleanup; never erase uncertain authority.
  }

  private startupTransactionId: string = randomUUID();
  private readonly startupRecords = new Map<string, OwnedProcess>();

  public async reconcileStartup(): Promise<void> {
    await this.prepareDirectories();
    await this.withOperationLock('startup-reconcile', async () => {
      await this.assertStartupReconciled();
      const state = await this.readState();
      await this.writeState({ ...state, recovery: { ...state.recovery, attempts: 0, terminal: false, nextAttemptAt: null } });
    });
  }

  private async assertStartupReconciled(): Promise<void> {
    const state = await this.readState();
    const operations = state.startupOperations.filter(unresolvedStartup);
    for (const op of state.startupOperations.filter((entry) => entry.state === 'RUNNING')) {
      const identity = op.pid === null ? { state: 'indeterminate' as const } : observeProcessStart(op.pid);
      if (identity.state !== 'live' || identity.marker !== op.processStartMarker || await executableForPid(op.pid!) !== op.processExecutable) operations.push(op);
    }
    await this.cleanupStartupOperations(operations);
  }

  private async migrateHistoricalOwnership(): Promise<SupervisorStateDocument> {
    const state = await this.readState();
    if (state.schemaVersion === 4) return state;
    const missing = ownedProcesses(state).filter((record) => !state.startupOperations.some((operation) => operation.state === 'RUNNING' && startupOperationOwns(operation, record)));
    let migrated: SupervisorStateDocument = { ...state, schemaVersion: 4 };
    const running: OwnedProcess[] = [];
    for (const record of missing) {
      const inspected = await inspectProcess(record);
      if (inspected === 'ambiguous') {
        throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Historical ownership cannot be migrated without exact process identity');
      }
      if (inspected === 'stopped') migrated = replaceOwnedProcess(migrated, record.component, null);
      else running.push(record);
    }
    if (running.length === 0) {
      await this.writeState(migrated, true);
      return this.readState();
    }
    return this.persistVerifiedOwnership(migrated, running, false, state.schemaVersion);
  }

  private async persistVerifiedOwnership(
    state: SupervisorStateDocument,
    records: readonly OwnedProcess[],
    replaceExisting = false,
    historicalSchemaVersion?: 1 | 2 | 3,
  ): Promise<SupervisorStateDocument> {
    const supervisor = observeProcessStart(process.pid);
    if (supervisor.state !== 'live') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Supervisor identity is unavailable for ownership journaling');
    const transactionId = randomUUID();
    let operations = [...state.startupOperations];
    let next: SupervisorStateDocument = { ...state, schemaVersion: 4 };
    for (const record of records) {
      const verified = await this.verifyExistingOwnership(record, next, historicalSchemaVersion);
      const existing = operations.filter((operation) => operation.component === verified.component && operation.state === 'RUNNING');
      const unresolved = operations.filter((operation) => operation.component === verified.component && unresolvedStartup(operation));
      if (unresolved.length > 0 || existing.length > 1) {
        throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Conflicting durable ownership prevents journaling');
      }
      if (existing.length === 1 && !replaceExisting) {
        if (startupOperationOwns(existing[0]!, verified)) {
          next = replaceOwnedProcess(next, verified.component, verified);
          continue;
        }
        if (!startupOperationOwnsIdentity(existing[0]!, verified)
          || !isOwnedProcess(existing[0]!.ownedProcess) || existing[0]!.ownedProcess.listenerPorts !== undefined) {
          throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Published ownership conflicts with its durable journal');
        }
        operations = operations.map((operation) => operation.id === existing[0]!.id ? { ...operation, state: 'STOPPED' as const } : operation);
      }
      if (existing.length === 1) {
        if (!startupOperationOwnsIdentity(existing[0]!, verified)) {
          throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Ownership rebinding conflicts with durable process identity');
        }
        if (operations.some((operation) => operation.id === existing[0]!.id && operation.state === 'RUNNING')) {
          operations = operations.map((operation) => operation.id === existing[0]!.id ? { ...operation, state: 'STOPPED' as const } : operation);
        }
      }
      if (operations.length >= 38) throw new RuntimeError('PERSISTENCE_FAILURE', 'Startup operation capacity exhausted');
      const sourceRoot = ownershipSourceRoot(verified, next, this.sourceRoot);
      const expectedProcessExecutable = await expectedChildExecutable(verified.component, verified.executable);
      const configurationDigest = verified.environmentDigest ?? verified.profileDigest ?? ownershipDigest(verified, sourceRoot, this.dataRoot);
      operations.push({
        version: 1,
        id: randomUUID(),
        transactionId,
        component: verified.component,
        state: 'RUNNING',
        supervisorPid: process.pid,
        supervisorStartMarker: supervisor.marker,
        sourceRoot,
        dataRoot: realpathSync(this.dataRoot),
        executable: realpathSync(verified.executable),
        profilePath: verified.profilePath,
        configurationDigest,
        pid: verified.pid,
        processStartMarker: verified.processStartMarker!,
        processExecutable: verified.processExecutable!,
        expectedProcessExecutable,
        failureCode: null,
        ownedProcess: verified,
        ...(historicalSchemaVersion === undefined || record.listenerPorts !== undefined ? {} : {
          historicalOwnership: {
            version: 1 as const,
            sourceSchemaVersion: historicalSchemaVersion,
            method: 'RUNTIME_AUTHORITY_ENDPOINT' as const,
            historicalRecordDigest: createHash('sha256').update(JSON.stringify({ sourceSchemaVersion: historicalSchemaVersion, record })).digest('hex'),
            listenerPorts: verified.listenerPorts!,
          },
        }),
      });
      next = replaceOwnedProcess(next, verified.component, verified);
    }
    next = { ...next, startupOperations: operations };
    await this.writeState(next, true);
    return this.readState();
  }

  private async verifyExistingOwnership(
    record: OwnedProcess,
    state: SupervisorStateDocument,
    historicalSchemaVersion?: 1 | 2 | 3,
  ): Promise<OwnedProcess> {
    const identity = observeProcessStart(record.pid);
    const processExecutable = await executableForPid(record.pid);
    const expectedProcessExecutable = await expectedChildExecutable(record.component, record.executable);
    const processStartTimeMs = await processStartTime(record.pid);
    if (identity.state !== 'live' || processExecutable === null || !sameExecutablePath(processExecutable, expectedProcessExecutable)
      || processStartTimeMs === null || record.processStartMarker != null && record.processStartMarker !== identity.marker
      || record.processExecutable != null && !sameExecutablePath(record.processExecutable, processExecutable)
      || record.processStartTimeMs != null && record.processStartTimeMs !== processStartTimeMs) {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Existing process identity cannot be journaled safely');
    }
    const sourceRoot = ownershipSourceRoot(record, state, this.sourceRoot);
    let listenerPorts = record.listenerPorts;
    let observed: RuntimeObservedStatus | null = null;
    if (record.component === 'runtime') {
      observed = await runtimeStatus(this.dataRoot);
      assertRuntimeOwnership(record, observed);
      if (observed.state !== 'running' || !await commandLooksLikeIris(record.pid, sourceRoot)) {
        throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime source and authority cannot be verified');
      }
    }
    if (listenerPorts === undefined && historicalSchemaVersion !== undefined && record.component === 'runtime'
      && record.runtimeId != null && record.instanceId != null && observed?.endpoint != null) {
      const port = localRuntimePort(observed.endpoint.apiUrl);
      if (port !== null && await processOwnsLoopbackListener(record.pid, port)) listenerPorts = [port];
    }
    if (listenerPorts === undefined) {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Persisted spawn-time listener ownership is unavailable');
    }
    const verified: OwnedProcess = { ...record, processStartMarker: identity.marker, processExecutable, processStartTimeMs, listenerPorts };
    if (await inspectProcess(verified) !== 'running') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Existing process ownership is not live and exact');
    return verified;
  }

  private async startupTransaction<T>(work: () => Promise<T>): Promise<T> {
    await this.migrateHistoricalOwnership();
    await this.assertStartupReconciled();
    this.startupTransactionId = randomUUID();
    this.startupRecords.clear();
    try {
      const result = await work();
      await this.finishStartupTransaction();
      return result;
    } catch (error) {
      try { await this.rollbackStarted(); }
      catch { throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Lifecycle transaction failed and cleanup remains unresolved'); }
      throw new RuntimeError(runtimeErrorCode(error), 'Lifecycle transaction failed; verified rollback completed');
    }
  }

  private async retireForRecycle(record: OwnedProcess, runtimeShutdownDeadlineMs = 10_000): Promise<void> {
    const supervisor = observeProcessStart(process.pid);
    const child = observeProcessStart(record.pid);
    if (supervisor.state !== 'live' || child.state !== 'live' || await inspectProcess(record) !== 'running') {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Recycle requires exact old child ownership');
    }
    const executable = await executableForPid(record.pid);
    if (executable === null) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Old child executable is unavailable');
    const state = await this.readState();
    // Published metadata can be stale; only a unique durable ownership proof authorizes retirement.
    const matches = state.startupOperations.filter((op) => op.state === 'RUNNING' && op.component === record.component
      && op.pid === record.pid && op.processStartMarker === child.marker && op.processExecutable === executable);
    const prior = matches.length === 1 ? matches[0] : undefined;
    const owned = prior?.ownedProcess;
    const workloadUnbound = record.component === 'admin' || record.component === 'web' || record.component === 'tunnel-admin';
    if (prior === undefined || !isOwnedProcess(owned)
      || prior.expectedProcessExecutable !== executable || prior.transactionId.length === 0
      || owned.component !== record.component || owned.pid !== record.pid
      || owned.processStartMarker !== child.marker || owned.processExecutable !== executable
      || !sameExecutablePath(owned.executable, prior.executable) || owned.profilePath !== prior.profilePath
      || !sameExecutablePath(owned.executable, record.executable) || owned.profilePath !== record.profilePath
      || owned.marker !== record.marker || owned.startedAt !== record.startedAt
      || owned.processStartTimeMs !== record.processStartTimeMs
      || workloadUnbound && (owned.runtimeId != null || owned.instanceId != null || owned.deploymentEpoch != null)
      || (owned.component === 'runtime' ? !sameSourceRoot(owned.marker, prior.sourceRoot)
        : owned.workingDirectory == null || !sameSourceRoot(owned.workingDirectory, prior.sourceRoot))
      || await inspectProcess(owned) !== 'running') {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Recycle requires unique durable child ownership');
    }
    await this.assertStartupBinding(prior);
    const verified = owned;
    const operation: StartupOperation = {
      ...prior, id: randomUUID(), transactionId: this.startupTransactionId,
      state: 'CLEANUP_PENDING', supervisorPid: process.pid, supervisorStartMarker: supervisor.marker,
      failureCode: null, ownedProcess: verified,
    };
    const retained = state.startupOperations.filter((op) => unresolvedStartup(op) || op.state === 'RUNNING').concat(state.startupOperations.filter((op) => !unresolvedStartup(op) && op.state !== 'RUNNING').slice(-26));
    if (retained.length >= 38) throw new RuntimeError('PERSISTENCE_FAILURE', 'Startup history capacity exhausted');
    await this.writeState({ ...state, startupOperations: [...retained, operation] }, true);
    this.startupRecords.set(operation.id, verified);
    await this.cleanupStartupOperation(operation, runtimeShutdownDeadlineMs);
    const after = await this.readState();
    await this.writeState({ ...after, startupOperations: after.startupOperations.map((op) => op.pid === record.pid && op.processStartMarker === child.marker ? { ...op, state: 'STOPPED' as const } : op) }, true);
  }

  private async startRecordedRuntime(id: string, options: Parameters<typeof startRuntime>[0]): Promise<RuntimeObservedStatus> {
    try { return await startRuntime(options); }
    catch (error) {
      await this.updateStartup(id, error instanceof DefiniteSpawnFailure ? 'SPAWN_FAILED' : 'RECONCILIATION_REQUIRED', { failureCode: runtimeErrorCode(error) });
      throw error;
    }
  }

  private async updateStartup(id: string, phase: StartupState, observation: Partial<StartupOperation> = {}): Promise<void> {
    const state = await this.readState();
    if (!state.startupOperations.some((op) => op.id === id)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Startup intent disappeared');
    await this.writeState({ ...state, startupOperations: state.startupOperations.map((op) => op.id === id ? { ...op, ...observation, state: phase } : op) }, true);
  }

  private async prepareStartup(component: string, executable: string, sourceRoot: string, profilePath: string | null, environment: Record<string, string>, targetDataRoot = this.dataRoot, operationId: string = randomUUID()): Promise<string> {
    const supervisor = observeProcessStart(process.pid);
    if (supervisor.state !== 'live') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Supervisor start identity is unavailable');
    const state = await this.readState();
    if (state.startupOperations.some((op) => op.component === component && unresolvedStartup(op))) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Unresolved startup prevents duplicate spawning');
    const prior = state.startupOperations.filter((op) => op.component === component && op.state === 'RUNNING');
    for (const op of prior) {
      const observation = op.pid === null ? { state: 'indeterminate' as const } : observeProcessStart(op.pid);
      if (observation.state !== 'dead') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Previous component startup record is not conclusively stopped');
    }
    const reconciled = { ...state, startupOperations: state.startupOperations.map((op) => prior.includes(op) ? { ...op, state: 'STOPPED' as const } : op) };
    const retained = reconciled.startupOperations.filter((op) => unresolvedStartup(op) || op.state === 'RUNNING').concat(reconciled.startupOperations.filter((op) => !unresolvedStartup(op) && op.state !== 'RUNNING').slice(-26));
    if (retained.length >= 38) throw new RuntimeError('PERSISTENCE_FAILURE', 'Startup operation capacity exhausted');
    const expectedProcessExecutable = await expectedChildExecutable(component, executable);
    const operation: StartupOperation = {
      version: 1, id: operationId, transactionId: this.startupTransactionId, component, state: 'PREPARED',
      supervisorPid: process.pid, supervisorStartMarker: supervisor.marker,
      sourceRoot: realpathSync(sourceRoot), dataRoot: realpathSync(targetDataRoot), executable: realpathSync(executable),
      profilePath, configurationDigest: launchEnvironmentDigest(environment), pid: null, processStartMarker: null, processExecutable: null, expectedProcessExecutable, failureCode: null, ownedProcess: null,
    };
    await this.writeState({ ...state, startupOperations: [...retained, operation] }, true);
    await this.updateStartup(operation.id, 'SPAWNING');
    return operation.id;
  }

  private async observeStartupPid(id: string, pid: number): Promise<void> {
    const operation = (await this.readState()).startupOperations.find((op) => op.id === id);
    const birth = observeProcessStart(pid);
    if (operation === undefined || birth.state !== 'live' || operation.expectedProcessExecutable === undefined) {
      await this.updateStartup(id, 'OWNERSHIP_UNVERIFIED', { pid, failureCode: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Child identity observation failed');
    }
    await this.updateStartup(id, 'SPAWNING', { pid, processStartMarker: birth.marker });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const executable = await executableForPid(pid);
      const identity = observeProcessStart(pid);
      if (identity.state !== 'live' || identity.marker !== birth.marker) break;
      if (executable === operation.expectedProcessExecutable) {
        await this.updateStartup(id, 'SPAWNING', { processExecutable: executable });
        return;
      }
      await delay(25);
    }
    await this.updateStartup(id, 'OWNERSHIP_UNVERIFIED', { failureCode: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Expected child executable was not established within the identity deadline');
  }

  private async verifyStartup(id: string, record: OwnedProcess): Promise<OwnedProcess> {
    const operation = (await this.readState()).startupOperations.find((op) => op.id === id);
    const identity = observeProcessStart(record.pid);
    const executable = await executableForPid(record.pid);
    if (identity.state !== 'live' || operation?.pid !== record.pid || operation.processStartMarker !== identity.marker || operation.processExecutable !== executable || operation.expectedProcessExecutable !== executable || executable === null || await inspectProcess(record) !== 'running') {
      await this.updateStartup(id, 'OWNERSHIP_UNVERIFIED', { failureCode: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Spawned child ownership could not be verified');
    }
    const verified = { ...record, processStartMarker: identity.marker, processExecutable: executable };
    this.startupRecords.set(id, verified);
    await this.updateStartup(id, 'OWNERSHIP_VERIFIED', { pid: record.pid, processStartMarker: identity.marker, ownedProcess: verified });
    return verified;
  }

  private async spawnManaged(...args: Parameters<typeof spawnManaged>): Promise<OwnedProcess> {
    const id = await this.prepareStartup(args[0], args[1], args[3], args[5], args[4]);
    try {
      const record = await spawnManaged(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8], args[9], args[10], args[11], args[12], args[13], (pid) => this.observeStartupPid(id, pid));
      return await this.verifyStartup(id, record);
    } catch (error) {
      await this.updateStartup(id, error instanceof DefiniteSpawnFailure ? 'SPAWN_FAILED' : 'RECONCILIATION_REQUIRED', { failureCode: runtimeErrorCode(error) });
      throw error;
    }
  }

  private async finishStartupTransaction(): Promise<void> {
    const state = await this.readState();
    if (state.startupOperations.some((op) => op.transactionId === this.startupTransactionId && unresolvedStartup(op) && op.state !== 'OWNERSHIP_VERIFIED')) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Transaction cannot finish with unresolved startup');
    await this.writeState({ ...state, startupOperations: state.startupOperations.map((op) => op.transactionId === this.startupTransactionId && op.state === 'OWNERSHIP_VERIFIED' ? { ...op, state: 'RUNNING' as const } : op) }, true);
  }

  private async readState(): Promise<SupervisorStateDocument> {
    const filename = path.join(this.supervisorDirectory(), STATE_FILE);
    const content = await readSupervisorStateFile(filename);
    if (content === null) return emptyState(`${os.hostname()}-${process.pid}`, this.sourceRoot);
    try {
      const value = JSON.parse(content) as unknown;
      if (!isState(value)) throw new Error('invalid supervisor state');
      return {
        ...value,
        schemaVersion: value.schemaVersion,
        startupOperations: value.startupOperations ?? [],
        workloadSourceRoot: value.workloadSourceRoot ?? this.sourceRoot,
        admin: value.admin ?? null,
        adminTunnel: value.adminTunnel ?? null,
        recovery: { ...emptyRecovery(), ...(value.recovery ?? {}), windowStartedAt: value.recovery?.windowStartedAt ?? null },
      };
    } catch (error) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor state is invalid', { cause: error });
    }
  }

  private async writeState(state: SupervisorStateDocument, replaceOperations = false): Promise<void> {
    const current = replaceOperations ? state : await this.readState();
    await writeSupervisorStateFile(path.join(this.supervisorDirectory(), STATE_FILE), {
      ...state, schemaVersion: 4, startupOperations: current.startupOperations, updatedAt: new Date().toISOString(),
    });
  }


  private supervisorDirectory(): string { return path.join(this.dataRoot, SUPERVISOR_DIRECTORY); }
  private profileDirectory(): string { return path.join(this.dataRoot, PROFILE_DIRECTORY); }
  private logDirectory(): string { return path.join(this.dataRoot, LOG_DIRECTORY); }
}

function managedProfile(
  binding: ConnectorBinding,
  controlPlaneKey: string,
  tunnelServiceAuthorization: string,
  logDirectory: string,
  epoch: number,
  runtimeApiUrl: string,
  adminMcpUrl: string | null,
): string {
  const controlRef = `file:${controlPlaneKey}`;
  const serviceRef = `file:${tunnelServiceAuthorization}`;
  const headers = [
    `    Authorization: ${yamlString(serviceRef)}`,
    `    x-iris-client-id: ${yamlString(binding.mode === 'FULL' ? 'chatgpt' : 'chatgpt-pro')}`,
    `    x-iris-connector-profile: ${yamlString(binding.mode)}`,
    `    x-iris-deployment-epoch: ${yamlString(String(epoch))}`,
    `    x-iris-runtime-id: ${yamlString(binding.runtimeId ?? '')}`,
  ].join('\n');
  return [
    'config_version: 1',
    'control_plane:',
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: ${yamlString(binding.tunnelId)}`,
    `  api_key: ${yamlString(controlRef)}`,
    'health:',
    `  listen_addr: ${yamlString(`127.0.0.1:${binding.healthPort}`)}`,
    'admin_ui:',
    '  open_browser: false',
    'log:',
    '  level: info',
    '  format: json',
    `  file: ${yamlString(path.join(logDirectory, binding.mode === 'FULL' ? 'iris-full-tunnel.log' : 'iris-pro-tunnel.log'))}`,
    'mcp:',
    '  server_urls:',
    '    - channel: main',
    `      url: ${yamlString(new URL(binding.mcpPath, `${runtimeApiUrl}/`).toString())}`,
    ...(adminMcpUrl === null ? [] : ['    - channel: admin', `      url: ${yamlString(adminMcpUrl)}`]),
    '  extra_headers:',
    headers,
    '  discovery_extra_headers:',
    headers,
    '',
  ].join('\n');
}

function managedAdminProfile(
  binding: AdminConnectorBinding,
  controlPlaneKey: string,
  tunnelServiceAuthorization: string,
  logDirectory: string,
  healthPort: number,
  supervisorMcpUrl: string,
): string {
  const controlRef = `file:${controlPlaneKey}`;
  const serviceRef = `file:${tunnelServiceAuthorization}`;
  const headers = [
    `    Authorization: ${yamlString(serviceRef)}`,
    `    x-iris-client-id: ${yamlString('chatgpt-admin')}`,
    `    x-iris-connector-profile: ${yamlString('ADMIN')}`,
  ].join('\n');
  return [
    'config_version: 1',
    'control_plane:',
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: ${yamlString(binding.tunnelId)}`,
    `  api_key: ${yamlString(controlRef)}`,
    'health:',
    `  listen_addr: ${yamlString(`127.0.0.1:${healthPort}`)}`,
    'admin_ui:',
    '  open_browser: false',
    'log:',
    '  level: info',
    '  format: json',
    `  file: ${yamlString(path.join(logDirectory, 'iris-admin-tunnel.log'))}`,
    'mcp:',
    '  server_urls:',
    '    - channel: main',
    `      url: ${yamlString(supervisorMcpUrl)}`,
    '  extra_headers:',
    headers,
    '  discovery_extra_headers:',
    headers,
    '',
  ].join('\n');
}

async function probeLocalRuntime(apiUrl: string, serviceSecret: string, registry: ConnectorRegistryDocument, strictCatalog = true): Promise<LocalReadinessResult> {
  const connectors: ConnectorStatus[] = [];
  const catalogs: CatalogProfileStatus[] = [];
  const sources = sourceCatalogs();
  for (const binding of registry.connectors) {
    const source: { readonly identity: McpCatalogIdentity; readonly names: readonly string[] } = strictCatalog
      ? sources[binding.mode === 'FULL' ? 'FULL' : 'PRO']
      : {
          identity: {
            profile: binding.mode === 'FULL' ? 'FULL' : 'PRO',
            catalogVersion: '2.3.0',
            catalogHash: binding.catalogHash,
            toolCount: binding.expectedToolNames.length,
          },
          names: binding.expectedToolNames,
        };
    const headers = {
      authorization: `Bearer ${serviceSecret}`,
      'content-type': 'application/json',
      'x-iris-connector-profile': binding.mode,
      'x-iris-deployment-epoch': String(registry.deploymentEpoch),
      'x-iris-runtime-id': binding.runtimeId ?? '',
      'x-iris-client-id': binding.mode === 'FULL' ? 'iris-supervisor-full' : 'iris-supervisor-pro',
    };
    const discovered = await postJson(`${apiUrl}${binding.mcpPath}`, { jsonrpc: '2.0', id: 1, method: 'server/discover' }, headers);
    if (!isExpectedDiscovery(discovered, binding.mode)) {
      catalogs.push(catalogProfileStatus(binding, source, null, [], false));
      connectors.push(connectorStatus(binding, undefined, layer('FAILED', discovered === null ? 'LOCAL_MCP_AUTH_FAILED' : 'RUNTIME_IDENTITY_MISMATCH', 'Authenticated MCP discovery did not match the expected protocol')));
      continue;
    }
    const listed = await postJson(`${apiUrl}${binding.mcpPath}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...headers, 'MCP-Protocol-Version': '2026-07-28' });
    const names = toolNames(listed);
    const fullIdentityResponse = binding.mode === 'FULL' && listed !== null
      ? await postJson(`${apiUrl}${binding.mcpPath}`, {
        jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'catalog_identity', arguments: {} },
      }, { ...headers, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Name': 'catalog_identity' })
      : null;
    // PRO intentionally has no catalog_identity tool. In cross-source mode,
    // deriving its identity with this control-plane source would fabricate the
    // apparent catalog version/hash instead of observing the workload runtime.
    const liveIdentity = binding.mode === 'FULL'
      ? catalogIdentityFromToolResponse(fullIdentityResponse)
      : listed === null || !strictCatalog ? null : catalogIdentity(binding.mode, listedToolDefinitions(listed));
    const catalog = binding.mode === 'PRO' && !strictCatalog
      ? catalogProfileStatusWithoutAuthoritativeIdentity(binding, source, names, listed !== null)
      : catalogProfileStatus(binding, source, liveIdentity, names, listed !== null);
    catalogs.push(catalog);
    const compatibilityUnknown = binding.mode === 'PRO'
      && !strictCatalog
      && listed !== null
      && catalog.state === 'UNKNOWN';
    const code = catalog.state === 'ACTIVE' ? 'READY'
      : compatibilityUnknown ? 'CATALOG_IDENTITY_UNVERIFIED'
        : catalog.state === 'STALE_CONNECTOR' ? 'CONNECTOR_MANIFEST_STALE'
          : catalog.state === 'UNKNOWN' ? (listed === null ? 'LOCAL_MCP_AUTH_FAILED' : 'MCP_CATALOG_STALE')
            : 'MCP_CATALOG_STALE';
    connectors.push(connectorStatus(binding, undefined, catalog.state === 'ACTIVE'
      ? layer('READY', 'READY', `${binding.label} authenticated discovery and current catalog match`)
      : compatibilityUnknown
        ? layer('UNKNOWN', code, `${binding.label} authenticated tool list matches the bound workload catalog, but PRO catalog identity is not authoritative across source roots`)
        : layer('FAILED', code, `${binding.label} catalog is ${catalog.state}`)));
  }
  const failedConnector = connectors.find((connector) => connector.state === 'FAILED');
  const unknownConnector = connectors.find((connector) => connector.state === 'UNKNOWN');
  const status = failedConnector !== undefined
    ? layer('FAILED',
      catalogs.some((catalog) => catalog.state === 'STALE_RUNTIME' || catalog.state === 'MISMATCH') ? 'MCP_CATALOG_STALE'
        : catalogs.some((catalog) => catalog.state === 'STALE_CONNECTOR') ? 'CONNECTOR_MANIFEST_STALE'
          : failedConnector.code === 'LOCAL_MCP_AUTH_FAILED' ? 'LOCAL_MCP_AUTH_FAILED' : 'RUNTIME_IDENTITY_MISMATCH',
      'One or more authenticated local MCP profiles failed catalog readiness')
    : unknownConnector !== undefined
      ? layer('DEGRADED', 'CATALOG_IDENTITY_UNVERIFIED', 'Authenticated local MCP transport is healthy but one compatibility-mode catalog identity is not authoritative')
      : layer('READY', 'READY', 'Authenticated local MCP discovery and current catalogs are healthy');
  return { status, connectors, catalogs };
}

function sourceCatalogManifest(): ConnectorCatalogManifest {
  const sources = sourceCatalogs();
  return {
    full: { expectedToolNames: sources.FULL.names, catalogHash: sources.FULL.identity.catalogHash },
    pro: { expectedToolNames: sources.PRO.names, catalogHash: sources.PRO.identity.catalogHash },
  };
}

function sourceCatalogs(): Record<'FULL' | 'PRO', { readonly identity: McpCatalogIdentity; readonly names: readonly string[] }> {
  return {
    FULL: { identity: catalogIdentity('FULL', fullMcpToolDefinitionsV21()), names: catalogToolNames('FULL') },
    PRO: { identity: catalogIdentity('PRO', proMcpToolDefinitions()), names: catalogToolNames('PRO') },
  };
}

export function catalogProfileStatus(
  binding: ConnectorBinding,
  source: { readonly identity: McpCatalogIdentity; readonly names: readonly string[] },
  live: McpCatalogIdentity | null,
  liveNames: readonly string[],
  listAvailable: boolean,
): CatalogProfileStatus {
  const namesMatch = listAvailable && liveNames.length === source.names.length && liveNames.every((name, index) => name === source.names[index]);
  const runtimeMismatch = listAvailable && !namesMatch || live !== null && (live.catalogHash !== source.identity.catalogHash || live.toolCount !== source.identity.toolCount);
  const connectorMatches = binding.catalogHash === source.identity.catalogHash
    && binding.expectedToolNames.length === source.names.length
    && binding.expectedToolNames.every((name, index) => name === source.names[index]);
  const state: CatalogActivationState = runtimeMismatch ? 'STALE_RUNTIME'
    : !listAvailable || live === null ? (listAvailable && namesMatch ? 'MISMATCH' : 'UNKNOWN')
      : !connectorMatches ? 'STALE_CONNECTOR' : 'ACTIVE';
  return {
    profile: binding.mode === 'FULL' ? 'FULL' : 'PRO',
    source: source.identity,
    live,
    liveToolCount: live?.toolCount ?? (listAvailable ? liveNames.length : null),
    connectorCatalogHash: binding.catalogHash,
    connectorEpoch: binding.deploymentEpoch,
    state,
  };
}

export function catalogProfileStatusWithoutAuthoritativeIdentity(
  binding: ConnectorBinding,
  source: { readonly identity: McpCatalogIdentity; readonly names: readonly string[] },
  liveNames: readonly string[],
  listAvailable: boolean,
): CatalogProfileStatus {
  const namesMatch = listAvailable
    && liveNames.length === source.names.length
    && liveNames.every((name, index) => name === source.names[index]);
  return {
    profile: binding.mode === 'FULL' ? 'FULL' : 'PRO',
    source: source.identity,
    live: null,
    liveToolCount: listAvailable ? liveNames.length : null,
    connectorCatalogHash: binding.catalogHash,
    connectorEpoch: binding.deploymentEpoch,
    state: !listAvailable ? 'UNKNOWN' : namesMatch ? 'UNKNOWN' : 'STALE_RUNTIME',
  };
}

function catalogActivationState(profiles: readonly CatalogProfileStatus[]): CatalogActivationState {
  if (profiles.some((profile) => profile.state === 'STALE_RUNTIME')) return 'STALE_RUNTIME';
  if (profiles.some((profile) => profile.state === 'STALE_CONNECTOR')) return 'STALE_CONNECTOR';
  if (profiles.some((profile) => profile.state === 'MISMATCH')) return 'MISMATCH';
  if (profiles.every((profile) => profile.state === 'ACTIVE')) return 'ACTIVE';
  return 'UNKNOWN';
}

function catalogAction(state: CatalogActivationState): string {
  if (state === 'ACTIVE') return 'NONE';
  if (state === 'STALE_CONNECTOR') return 'RECONNECT_IRIS_CONNECTOR_OR_OPEN_A_NEW_CHAT';
  if (state === 'STALE_RUNTIME' || state === 'MISMATCH') return 'iris catalog reload';
  return 'iris catalog status and inspect controlled runtime readiness';
}

function catalogIdentityFromToolResponse(value: unknown): McpCatalogIdentity | null {
  if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.result.structuredContent)) return null;
  const identity = value.result.structuredContent;
  if ((identity.profile !== 'FULL' && identity.profile !== 'PRO')
    || !isSupportedCatalogVersion(identity.catalogVersion)
    || !/^sha256:[0-9a-f]{64}$/.test(typeof identity.catalogHash === 'string' ? identity.catalogHash : '')
    || !Number.isSafeInteger(identity.toolCount)
    || Number(identity.toolCount) < 0) return null;
  return {
    profile: identity.profile,
    catalogVersion: identity.catalogVersion,
    catalogHash: identity.catalogHash as string,
    toolCount: Number(identity.toolCount),
  };
}

function runtimeIdentityFromFullCatalogToolResponse(value: unknown): {
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly deploymentEpoch: number;
  readonly catalogHash: string;
} | null {
  if (!isRecord(value) || !isRecord(value.result)) return null;
  const identity = isRecord(value.result.structuredContent) ? value.result.structuredContent : value.result;
  if (typeof identity.runtimeId !== 'string' || typeof identity.instanceId !== 'string'
    || !Number.isSafeInteger(identity.deploymentEpoch) || typeof identity.catalogHash !== 'string') return null;
  return {
    runtimeId: identity.runtimeId,
    instanceId: identity.instanceId,
    deploymentEpoch: Number(identity.deploymentEpoch),
    catalogHash: identity.catalogHash,
  };
}

function listedToolDefinitions(value: unknown): readonly unknown[] {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.tools)) return [];
  return value.result.tools;
}

function connectorStatus(binding: ConnectorBinding, local: ConnectorStatus | undefined, tunnel: LayerStatus): ConnectorStatus {
  const chosen = local === undefined
    ? tunnel
    : tunnel.state !== 'READY'
      ? layer('FAILED', tunnel.code, `${binding.label} tunnel is not ready`)
      : local;
  return { ...chosen, connectorId: binding.connectorId, label: binding.label, tunnelId: binding.tunnelId, profile: binding.mcpProfile, expectedToolCount: binding.expectedToolNames.length };
}

function isExpectedDiscovery(value: unknown, profile: ConnectorBinding['mode']): boolean {
  if (!isRecord(value) || !isRecord(value.result)) return false;
  const result = value.result;
  if (profile === 'FULL') {
    const legacy = result.protocolVersion === '2026-07-28'
      && isRecord(result.serverInfo)
      && result.serverInfo.name === 'iris-local-runtime'
      && result.serverInfo.version === '0.0.0';
    const negotiated = result.resultType === 'complete'
      && Array.isArray(result.supportedVersions)
      && result.supportedVersions.length === 1
      && result.supportedVersions[0] === '2026-07-28'
      && isRecord(result._meta)
      && isRecord(result._meta['io.modelcontextprotocol/serverInfo'])
      && result._meta['io.modelcontextprotocol/serverInfo'].name === 'IRIS'
      && result._meta['io.modelcontextprotocol/serverInfo'].version === '0.0.0';
    return (legacy || negotiated) && isRecord(result.capabilities) && isRecord(result.capabilities.tools);
  }
  return result.resultType === 'complete' && Array.isArray(result.supportedVersions) && result.supportedVersions.length === 1
    && result.supportedVersions[0] === '2026-07-28' && isRecord(result.capabilities) && isRecord(result.capabilities.tools);
}

function toolNames(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.tools)) return [];
  return value.result.tools.flatMap((tool) => isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : []);
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown | null> {
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 1_048_576) return null;
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

async function adminProcessMatchesControlSource(record: OwnedProcess | null, controlSourceRoot: string): Promise<boolean> {
  if (record === null || record.workingDirectory === undefined || record.workingDirectory === null) return false;
  if (!sameSourceRoot(record.workingDirectory, controlSourceRoot)) return false;
  if (await inspectProcess(record) !== 'running') return false;
  const sourceEntrypoint = path.resolve(import.meta.dirname, 'supervisor-admin-main.ts');
  const builtEntrypoint = path.resolve(import.meta.dirname, 'supervisor-admin-main.js');
  const execution = await processExecutionForPid(record.pid);
  return execution !== null && execution.unsafeEnvironmentVariables.length === 0
    && processArgumentsRunEntrypoint(execution.arguments, sourceEntrypoint, builtEntrypoint);
}

async function ownedAdminOwnsListener(
  record: OwnedProcess | null, port: number, controlSourceRoot: string, sourceAlreadyVerified = false,
): Promise<boolean> {
  if (record === null || !sourceAlreadyVerified && !await adminProcessMatchesControlSource(record, controlSourceRoot)) return false;
  const identity = observeProcessStart(record.pid);
  if (identity.state !== 'live' || record.processStartMarker !== identity.marker
    || await loopbackListenerOwner(port) !== record.pid) return false;
  const executable = await executableForPid(record.pid);
  if (executable === null || record.processExecutable === undefined || record.processExecutable === null
    || !sameExecutablePath(executable, record.processExecutable)) return false;
  const sourceEntrypoint = path.resolve(import.meta.dirname, 'supervisor-admin-main.ts');
  const builtEntrypoint = path.resolve(import.meta.dirname, 'supervisor-admin-main.js');
  const execution = await processExecutionForPid(record.pid);
  return execution !== null && execution.unsafeEnvironmentVariables.length === 0
    && processArgumentsRunEntrypoint(execution.arguments, sourceEntrypoint, builtEntrypoint);
}

async function spawnManaged(
  component: OwnedProcess['component'], executable: string, args: readonly string[], cwd: string,
  extraEnvironment: Record<string, string>, profilePath: string | null, logDirectory: string, marker: string,
  tunnelId: string | null = null, deploymentEpoch: number | null = null, instanceId: string | null = null, runtimeId: string | null = null,
  profileDigest: string | null = null,
  listenerPorts: readonly number[] = [],
  onSpawn?: (pid: number) => Promise<void>,
): Promise<OwnedProcess> {
  const logFilename = path.join(logDirectory, component === 'web' ? 'supervisor.log' : `${component}.log`);
  const output = openSync(logFilename, 'a', 0o600);
  const environment = node24Environment({ HOME: process.env.HOME ?? os.homedir(), TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: process.env.LANG ?? 'en_US.UTF-8' }, extraEnvironment);
  const workingDirectory = path.resolve(cwd);
  const environmentDigest = launchEnvironmentDigest(extraEnvironment);
  const child = spawn(executable, [...args], { cwd: workingDirectory, env: environment, detached: true, stdio: ['ignore', output, output] });
  closeSync(output);
  child.on('error', () => undefined);
  child.unref();
  const pid = await confirmChildSpawn(child);
  await onSpawn?.(pid);
  const processStartTimeMs = await waitForProcessStartTime(pid, 2_000);
  if (processStartTimeMs === null) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `${component} process start identity could not be verified`);
  return {
    component, pid, startedAt: new Date().toISOString(), executable: path.resolve(executable), profilePath, tunnelId, marker,
    processStartTimeMs, deploymentEpoch, instanceId, runtimeId, profileDigest, workingDirectory, environmentDigest, listenerPorts,
  };
}

async function stopOwnedProcess(record: OwnedProcess): Promise<void> {
  const inspected = await inspectProcess(record);
  if (inspected === 'ambiguous') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `${record.component} process is not the recorded process`);
  if (inspected === 'stopped') return;
  if (record.pid === process.pid) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Supervisor cannot stop itself through a child-process record');
  process.kill(record.pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await inspectProcess(record) === 'stopped') return;
    await delay(50);
  }
  throw new RuntimeError('TUNNEL_NOT_RUNNING', `${record.component} did not stop before the deadline`);
}

async function inspectProcess(record: OwnedProcess): Promise<'running' | 'stopped' | 'ambiguous'> {
  if (record.pid <= 0) return 'ambiguous';
  if (record.processStartMarker != null) {
    const identity = observeProcessStart(record.pid);
    if (identity.state === 'dead') return 'stopped';
    if (identity.state !== 'live' || identity.marker !== record.processStartMarker) return 'ambiguous';
  }
  if (record.processExecutable != null && await executableForPid(record.pid) !== record.processExecutable) return 'ambiguous';
  // The persistent supervisor-admin child legitimately inspects its own recorded
  // identity while activation replaces only the workload runtime. Keep every
  // other self-PID case fail-closed; stopOwnedProcess still refuses to signal self.
  if (record.pid === process.pid && record.component !== 'admin') return 'ambiguous';
  try { process.kill(record.pid, 0); } catch (error) { return isMissingProcess(error) ? 'stopped' : 'ambiguous'; }
  const command = await commandForPid(record.pid);
  if (command === null) return 'ambiguous';
  const markerMatches = record.component === 'runtime'
    ? commandIncludesPath(command, record.marker) && commandIncludesPath(command, record.executable)
    : record.component === 'tunnel-full' || record.component === 'tunnel-pro' || record.component === 'tunnel-admin'
      ? commandIncludesPath(command, record.executable)
    : commandIncludesMarker(command, record.marker);
  if (!markerMatches) return 'ambiguous';
  if (record.profilePath !== null && !commandIncludesPath(command, record.profilePath)) return 'ambiguous';
  const startedAt = await processStartTime(record.pid);
  if (startedAt === null) return 'ambiguous';
  if (record.processStartTimeMs !== undefined && record.processStartTimeMs !== null) {
    if (startedAt !== record.processStartTimeMs) return 'ambiguous';
  } else {
    const recordedAt = Date.parse(record.startedAt);
    if (!Number.isFinite(recordedAt) || Math.abs(startedAt - recordedAt) > 30_000) return 'ambiguous';
  }
  return 'running';
}

async function commandLooksLikeIris(pid: number, sourceRoot: string): Promise<boolean> {
  const command = await commandForPid(pid);
  return command !== null && commandIncludesPath(command, sourceRoot) && command.includes('main.ts');
}

function commandIncludesPath(command: string, target: string): boolean {
  const candidates = new Set([path.resolve(target)]);
  try { candidates.add(realpathSync(target)); } catch { /* the path may be a future metadata path */ }
  const tokens = command.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ''));
  for (const token of tokens) {
    if (!path.isAbsolute(token)) continue;
    const normalizedToken = path.resolve(token);
    if (candidates.has(normalizedToken)) return true;
    try { if (candidates.has(realpathSync(normalizedToken))) return true; } catch { /* Missing argv paths establish no identity. */ }
  }
  for (const candidate of candidates) {
    let offset = command.indexOf(candidate);
    while (offset >= 0) {
      const before = offset === 0 ? '' : command[offset - 1]!;
      const afterOffset = offset + candidate.length;
      const after = afterOffset >= command.length ? '' : command[afterOffset]!;
      const beforeOk = before.length === 0 || /[\s'"]/.test(before);
      const afterOk = after.length === 0 || /[\s'"/]/.test(after);
      if (beforeOk && afterOk) return true;
      offset = command.indexOf(candidate, offset + 1);
    }
  }
  return false;
}

function commandIncludesMarker(command: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s/'"])${escaped}(?=$|[\\s/.'"])`).test(command);
}

async function commandForPid(pid: number): Promise<string | null> {
  try { const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1_000 }); return result.stdout.trim(); }
  catch (error) { return isMissingProcess(error) ? '' : null; }
}

async function processStartTime(pid: number): Promise<number | null> {
  try {
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1_000 });
    const value = Date.parse(result.stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function waitForProcessStartTime(pid: number, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startedAt = await processStartTime(pid);
    if (startedAt !== null) return startedAt;
    await delay(25);
  }
  return null;
}

async function resolveExecutable(candidate: string): Promise<string> {
  if (path.isAbsolute(candidate)) {
    if (!existsSync(candidate)) throw new RuntimeError('TUNNEL_NOT_RUNNING', 'Configured tunnel-client executable does not exist');
    return candidate;
  }
  try { const result = await execFileAsync('which', [candidate], { encoding: 'utf8', timeout: 1_000 }); const resolved = result.stdout.trim(); if (resolved.length > 0) return resolved; }
  catch { /* handled below */ }
  throw new RuntimeError('TUNNEL_NOT_RUNNING', 'tunnel-client executable is unavailable');
}

async function waitForTunnel(executable: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCode: RuntimeFailureCode = 'TUNNEL_NOT_RUNNING';
  while (Date.now() < deadline) {
    try {
      const result = await execFileAsync(executable, ['health', '--json', '--port', String(port)], { encoding: 'utf8', timeout: 2_000 });
      const parsed = JSON.parse(result.stdout) as unknown;
      if (isRecord(parsed) && parsed.result === 'ok' && isRecord(parsed.healthz) && parsed.healthz.ok === true && isRecord(parsed.readyz) && parsed.readyz.ok === true) return;
      lastCode = 'CONTROL_PLANE_UNREACHABLE';
    } catch (error) { lastCode = error instanceof RuntimeError ? error.code : 'TUNNEL_NOT_RUNNING'; }
    await delay(100);
  }
  throw new RuntimeError(lastCode, 'Tunnel health and readiness were not proven before the deadline');
}

async function fileSha256(filename: string): Promise<string> {
  return createHash('sha256').update(await readFile(filename)).digest('hex');
}

async function supervisorNativeEndpointResponds(dataRoot: string, port: number): Promise<boolean> {
  const secret = await readTunnelServiceSecret(dataRoot);
  if (secret === null) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(500),
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const value = await response.json() as unknown;
    return isRecord(value) && value.ok === true && value.owner === 'OUTER_SUPERVISOR_DAEMON';
  } catch {
    return false;
  }
}

interface SupervisorNativeOwnerIdentityEvidence {
  readonly listenerPid: number;
  readonly processStartMarker: string;
  readonly canonicalExecutable: string;
  readonly arguments: readonly string[];
  readonly unsafeEnvironmentVariables: readonly string[];
}

async function inspectSupervisorNativeOwner(
  dataRoot: string,
  port: number,
  sourceRoot: string,
): Promise<'verified' | 'ambiguous'> {
  try {
    const listenerPid = await loopbackListenerOwner(port);
    if (listenerPid === null) return 'ambiguous';
    const identity = observeProcessStart(listenerPid);
    if (identity.state !== 'live') return 'ambiguous';
    const executable = await executableForPid(listenerPid);
    if (executable === null || !sameExecutablePath(executable, canonicalNodeRuntime().path)) return 'ambiguous';
    const sourceEntrypoint = path.resolve(sourceRoot, 'apps/runtime/src/control.ts');
    const builtEntrypoint = path.resolve(sourceRoot, 'apps/runtime/dist/control.js');
    const execution = await processExecutionForPid(listenerPid);
    if (execution === null || execution.unsafeEnvironmentVariables.length > 0
      || !processArgumentsRunEntrypoint(execution.arguments, sourceEntrypoint, builtEntrypoint, 'supervisor')) return 'ambiguous';
    const secret = await readTunnelServiceSecret(dataRoot);
    if (secret === null) return 'ambiguous';
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(500),
      cache: 'no-store',
    });
    if (!response.ok) return 'ambiguous';
    const value = await response.json() as unknown;
    if (!isRecord(value) || value.ok !== true || value.owner !== 'OUTER_SUPERVISOR_DAEMON'
      || value.pid !== listenerPid) return 'ambiguous';
    const observedRuntime = await runtimeStatus(dataRoot);
    const expectedRuntimeId = observedRuntime.endpoint?.runtimeId ?? null;
    const expectedInstanceId = observedRuntime.endpoint?.instanceId ?? null;
    const status = await readNativeSupervisorStatus(secret, port);
    if (status === null || status.supervisorProcessId !== listenerPid
      || typeof status.controlSourceRoot !== 'string'
      || !sameSourceRoot(status.controlSourceRoot, sourceRoot)
      || typeof status.controlDataRoot !== 'string'
      || !sameSourceRoot(status.controlDataRoot, dataRoot)
      || status.workloadRuntimeId !== expectedRuntimeId
      || status.workloadInstanceId !== expectedInstanceId) return 'ambiguous';
    const confirmedIdentity = observeProcessStart(listenerPid);
    const confirmedListenerPid = await loopbackListenerOwner(port);
    const confirmedExecutable = await executableForPid(listenerPid);
    const confirmedExecution = await processExecutionForPid(listenerPid);
    return confirmedIdentity.state === 'live' && confirmedListenerPid !== null
      && confirmedExecutable !== null && confirmedExecution !== null
      && sameExecutablePath(confirmedExecutable, canonicalNodeRuntime().path)
      && confirmedExecution.unsafeEnvironmentVariables.length === 0
      && processArgumentsRunEntrypoint(confirmedExecution.arguments, sourceEntrypoint, builtEntrypoint, 'supervisor')
      && supervisorNativeOwnerIdentityIsStable(
        {
          listenerPid,
          processStartMarker: identity.marker,
          canonicalExecutable: realpathSync(executable),
          arguments: execution.arguments,
          unsafeEnvironmentVariables: execution.unsafeEnvironmentVariables,
        },
        {
          listenerPid: confirmedListenerPid,
          processStartMarker: confirmedIdentity.marker,
          canonicalExecutable: realpathSync(confirmedExecutable),
          arguments: confirmedExecution.arguments,
          unsafeEnvironmentVariables: confirmedExecution.unsafeEnvironmentVariables,
        },
      )
      ? 'verified' : 'ambiguous';
  } catch {
    return 'ambiguous';
  }
}

function supervisorNativeOwnerIdentityIsStable(
  initial: SupervisorNativeOwnerIdentityEvidence,
  confirmed: SupervisorNativeOwnerIdentityEvidence,
): boolean {
  return initial.listenerPid === confirmed.listenerPid
    && initial.processStartMarker === confirmed.processStartMarker
    && initial.canonicalExecutable === confirmed.canonicalExecutable
    && sameStringVector(initial.arguments, confirmed.arguments)
    && sameStringVector(initial.unsafeEnvironmentVariables, confirmed.unsafeEnvironmentVariables)
    && initial.unsafeEnvironmentVariables.length === 0
    && confirmed.unsafeEnvironmentVariables.length === 0;
}

/** @internal Pure deterministic identity comparison; performs no I/O and cannot access credentials. */
export function supervisorNativeOwnerIdentityIsStableForTest(
  initial: SupervisorNativeOwnerIdentityEvidence,
  confirmed: SupervisorNativeOwnerIdentityEvidence,
): boolean {
  return supervisorNativeOwnerIdentityIsStable(initial, confirmed);
}

async function readNativeSupervisorStatus(secret: string, port: number): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        'Mcp-Name': 'supervisor_status',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'supervisor_status', arguments: {} } }),
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const value = await response.json() as unknown;
    return isRecord(value) && isRecord(value.result) && value.result.isError !== true && isRecord(value.result.structuredContent)
      ? value.result.structuredContent : null;
  } catch {
    return null;
  }
}

async function adminEndpointResponds(dataRoot: string, port: number): Promise<boolean> {
  const secret = await readTunnelServiceSecret(dataRoot);
  if (secret === null) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(500),
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const value = await response.json() as unknown;
    return isRecord(value) && value.ok === true && value.owner === 'PERSISTENT_SUPERVISOR_OR_CONTROL_PLANE';
  } catch {
    return false;
  }
}

async function waitForAdminEndpoint(dataRoot: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await adminEndpointResponds(dataRoot, port)) return;
    await delay(50);
  }
  throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Supervisor admin endpoint did not become authenticated and ready');
}

async function endpointResponds(url: string): Promise<boolean> {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(400) }); return response.status > 0; } catch { return false; }
}

async function waitForEndpoint(url: string, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await endpointResponds(url)) return; await delay(50); }
  throw new RuntimeError('SUPERVISOR_NOT_RUNNING', message);
}

async function runtimeRecordFromObserved(endpoint: NonNullable<RuntimeObservedStatus['endpoint']>, sourceRoot: string): Promise<OwnedProcess> {
  const executable = await executableForPid(endpoint.pid);
  if (executable === null) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime executable identity could not be verified');
  return {
    component: 'runtime',
    pid: endpoint.pid,
    startedAt: endpoint.startedAt,
    executable,
    profilePath: null,
    tunnelId: null,
    marker: sourceRoot,
    processStartTimeMs: await processStartTime(endpoint.pid),
    runtimeId: endpoint.runtimeId,
    instanceId: endpoint.instanceId,
    listenerPorts: [Number(new URL(endpoint.apiUrl).port)],
  };
}

async function expectedChildExecutable(component: string, executable: string): Promise<string> {
  if (['runtime', 'runtime-probe', 'admin', 'web'].includes(component)) return realpathSync(canonicalNodeRuntime().path);
  const physical = realpathSync(executable);
  const handle = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new RuntimeError('PRECONDITION_FAILED', 'Launcher must be a regular executable file');
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]?.trim();
    if (firstLine === '#!/usr/bin/env node') return realpathSync(canonicalNodeRuntime().path);
    if (firstLine?.startsWith('#!')) throw new RuntimeError('PRECONDITION_FAILED', 'Unrecognized tunnel launcher interpreter; explicit executable contract required');
    return physical;
  } finally { await handle.close(); }
}

async function executableForPid(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/python3', [path.resolve(import.meta.dirname, '..', 'macos-safety-helper.py'), 'process-executable', String(pid)], { encoding: 'utf8', timeout: 1_000, maxBuffer: 4096 });
    const executable = stdout.trim();
    if (!path.isAbsolute(executable) || /[\r\n\0]/.test(executable)) return null;
    return realpathSync(executable);
  } catch { return null; }
}

function requireSuccessfulAdminResult(result: SupervisorAdminToolCallResult, name: string): Record<string, unknown> {
  if (result.isError || !isRecord(result.structuredContent)) {
    throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', `Supervisor admin tool ${name} did not return a successful structured result`);
  }
  return result.structuredContent;
}

function ownedProcessIdentity(record: OwnedProcess | null): string | null {
  if (record === null) return null;
  const start = record.processStartTimeMs ?? Date.parse(record.startedAt);
  return `${record.component}:${record.pid}:${Number.isFinite(start) ? start : record.startedAt}`;
}

function currentProcessIdentity(): string {
  const observed = observeProcessStart(process.pid);
  return observed.state === 'live' ? `supervisor:${process.pid}:${observed.marker}` : `supervisor:${process.pid}:indeterminate`;
}

function emptyState(supervisorId: string, workloadSourceRoot: string): SupervisorStateDocument {
  return { schemaVersion: 4, startupOperations: [], supervisorId, updatedAt: new Date().toISOString(), workloadSourceRoot, runtime: null, web: null, admin: null, adminTunnel: null, tunnels: { full: null, pro: null }, recovery: emptyRecovery() };
}

function emptyRecovery(): RecoveryRecord { return { attempts: 0, terminal: false, lastFailureCode: null, nextAttemptAt: null, windowStartedAt: null }; }

function layer(state: StackState, code: string, detail: string): LayerStatus { return { state, code, detail }; }

function combineLayers(values: readonly LayerStatus[], fallbackCode: string, detail: string): LayerStatus {
  const failed = values.find((value) => value.state === 'FAILED');
  return layer(failed?.state === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED', failed?.code ?? fallbackCode, detail);
}

function ownershipLayer(record: OwnedProcess, observed: RuntimeObservedStatus): LayerStatus {
  if (observed.endpoint === null || observed.endpoint.pid !== record.pid || observed.endpoint.startedAt !== record.startedAt) return layer('FAILED', 'RUNTIME_IDENTITY_MISMATCH', 'Runtime endpoint does not match the supervisor-owned process');
  return layer('READY', 'READY', 'Supervisor-owned IRIS runtime is healthy');
}

function unavailableStatus(credentials: CredentialStatus, code: string, detail: string): SupervisorStackStatus {
  const failed = layer('FAILED', code, detail);
  return { state: 'FAILED', runtime: failed, web: failed, tunnel: failed, controlPlane: failed, localRuntime: failed, endToEnd: layer('UNKNOWN', 'E2E_PROBE_UNAVAILABLE', 'L3 is unavailable'), connectors: [], credentials, registryPresent: false, recovery: recoveryView(emptyRecovery()) };
}

function recoveryView(record: RecoveryRecord): RecoveryStatus { return { attempts: record.attempts, terminal: record.terminal, lastFailureCode: record.lastFailureCode, nextAttemptAt: record.nextAttemptAt, windowStartedAt: record.windowStartedAt }; }

function failureCode(status: SupervisorStackStatus): string { return status.localRuntime.code !== 'READY' ? status.localRuntime.code : status.tunnel.code !== 'READY' ? status.tunnel.code : status.controlPlane.code !== 'READY' ? status.controlPlane.code : status.runtime.code; }

function actionForCode(code: string): string {
  if (code === 'MIGRATION_REQUIRED' || code === 'CREDENTIAL_MISSING') return 'MIGRATE_PERSISTENT_CREDENTIALS';
  if (code === 'CREDENTIAL_INVALID') return 'REPAIR_PRIVATE_CREDENTIAL_FILE';
  if (code === 'PROCESS_OWNERSHIP_AMBIGUOUS') return 'STOP_OR_ADOPT_ONLY_AFTER_IDENTITY_VERIFICATION';
  if (code === 'MCP_CATALOG_STALE') return 'iris catalog reload';
  if (code === 'CONNECTOR_BINDING_MISMATCH' || code === 'CONNECTOR_MANIFEST_STALE') return 'REGENERATE_MANAGED_PROFILES';
  if (code === 'LOCAL_MCP_AUTH_FAILED') return 'CHECK_TUNNEL_SERVICE_CREDENTIAL_AND_RUNTIME_RESTART';
  if (code === 'E2E_PROBE_UNAVAILABLE') return 'CONFIGURE_A_SAFE_REMOTE_PROBE_OR_VALIDATE_FROM_CHATGPT';
  return 'RUN_IRIS_STATUS_AND_INSPECT_CONTROLLED_LOGS';
}

function runtimeErrorCode(error: unknown): RuntimeFailureCode { return error instanceof RuntimeError ? error.code : 'SUPERVISOR_NOT_RUNNING'; }

function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

function isMissingProcess(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'; }

function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'; }

function isState(value: unknown): value is SupervisorStateDocument {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4) || typeof value.supervisorId !== 'string'
    || !(value.workloadSourceRoot === undefined || typeof value.workloadSourceRoot === 'string' && path.isAbsolute(value.workloadSourceRoot) && !value.workloadSourceRoot.includes('\0') && path.resolve(value.workloadSourceRoot) === value.workloadSourceRoot)
    || !isRecord(value.tunnels)) return false;
  if (value.schemaVersion === 4 && (!validStartupOperations(value.startupOperations) || value.startupOperations.some((op) => op.ownedProcess != null && !isOwnedProcess(op.ownedProcess)))) return false;
  if (value.schemaVersion !== 4 && value.startupOperations !== undefined) return false;
  if (value.recovery !== undefined && !isRecord(value.recovery)) return false;
  return (value.runtime === null || isOwnedProcess(value.runtime)) && (value.web === null || isOwnedProcess(value.web))
    && (value.admin === undefined || value.admin === null || isOwnedProcess(value.admin))
    && (value.adminTunnel === undefined || value.adminTunnel === null || isOwnedProcess(value.adminTunnel))
    && (value.tunnels.full === null || isOwnedProcess(value.tunnels.full)) && (value.tunnels.pro === null || isOwnedProcess(value.tunnels.pro))
    && (value.recovery === undefined || (isNonNegativeSafeInteger(value.recovery.attempts) && typeof value.recovery.terminal === 'boolean'
      && (value.recovery.lastFailureCode === null || typeof value.recovery.lastFailureCode === 'string')
      && (value.recovery.nextAttemptAt === null || typeof value.recovery.nextAttemptAt === 'string')
      && (value.recovery.windowStartedAt === undefined || value.recovery.windowStartedAt === null || typeof value.recovery.windowStartedAt === 'string')));
}

function isOwnedProcess(value: unknown): value is OwnedProcess {
  return isRecord(value) && (value.component === 'runtime' || value.component === 'web' || value.component === 'admin' || value.component === 'tunnel-full' || value.component === 'tunnel-pro' || value.component === 'tunnel-admin' || value.component === 'supervisor')
    && isPositiveSafeInteger(value.pid) && typeof value.startedAt === 'string' && typeof value.executable === 'string'
    && (value.profilePath === null || typeof value.profilePath === 'string') && (value.tunnelId === null || typeof value.tunnelId === 'string') && typeof value.marker === 'string'
    && (value.listenerPorts === undefined || Array.isArray(value.listenerPorts) && value.listenerPorts.length <= 7 && value.listenerPorts.every((port) => isPositiveSafeInteger(port) && port <= 65535))
    && (value.processExecutable === undefined || value.processExecutable === null || typeof value.processExecutable === 'string' && path.isAbsolute(value.processExecutable))
    && (value.processStartMarker === undefined || value.processStartMarker === null || typeof value.processStartMarker === 'string' && /^\d+:\d+$/.test(value.processStartMarker))
    && (value.processStartTimeMs === undefined || value.processStartTimeMs === null || isNonNegativeSafeInteger(value.processStartTimeMs))
    && (value.runtimeId === undefined || value.runtimeId === null || typeof value.runtimeId === 'string')
    && (value.instanceId === undefined || value.instanceId === null || typeof value.instanceId === 'string')
    && (value.deploymentEpoch === undefined || value.deploymentEpoch === null || isPositiveSafeInteger(value.deploymentEpoch))
    && (value.profileDigest === undefined || value.profileDigest === null || (typeof value.profileDigest === 'string' && /^[0-9a-f]{64}$/.test(value.profileDigest)))
    && (value.workingDirectory === undefined || value.workingDirectory === null || (typeof value.workingDirectory === 'string' && path.isAbsolute(value.workingDirectory)))
    && (value.environmentDigest === undefined || value.environmentDigest === null || (typeof value.environmentDigest === 'string' && /^[0-9a-f]{64}$/.test(value.environmentDigest)));
}

function ownedProcesses(state: SupervisorStateDocument): OwnedProcess[] {
  return [state.runtime, state.web, state.admin, state.adminTunnel, state.tunnels.full, state.tunnels.pro]
    .filter((record): record is OwnedProcess => record !== null);
}

function replaceOwnedProcess(
  state: SupervisorStateDocument,
  component: OwnedProcess['component'],
  record: OwnedProcess | null,
): SupervisorStateDocument {
  if (component === 'tunnel-full') return { ...state, tunnels: { ...state.tunnels, full: record } };
  if (component === 'tunnel-pro') return { ...state, tunnels: { ...state.tunnels, pro: record } };
  if (component === 'tunnel-admin') return { ...state, adminTunnel: record };
  if (component === 'runtime' || component === 'web' || component === 'admin') return { ...state, [component]: record };
  throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Supervisor self-ownership cannot be migrated as a child');
}

function ownershipSourceRoot(record: OwnedProcess, state: SupervisorStateDocument, controlSourceRoot: string): string {
  const sourceRoot = record.component === 'runtime' ? state.workloadSourceRoot
    : record.component === 'web' ? path.join(state.workloadSourceRoot, 'apps/web') : controlSourceRoot;
  let physical: string;
  try { physical = realpathSync(sourceRoot); }
  catch { throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Owned process source root is unavailable'); }
  if (record.component === 'runtime') {
    if (!sameSourceRoot(record.marker, physical)) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime source binding conflicts with persisted ownership');
  } else if (record.workingDirectory == null || !sameSourceRoot(record.workingDirectory, physical)) {
    throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Child working directory conflicts with persisted source ownership');
  }
  return physical;
}

function startupOperationOwns(operation: StartupOperation, record: OwnedProcess): boolean {
  return startupOperationOwnsIdentity(operation, record)
    && isOwnedProcess(operation.ownedProcess) && sameOwnedProcessAuthority(operation.ownedProcess, record);
}

function sameOwnedProcessAuthority(left: OwnedProcess, right: OwnedProcess): boolean {
  return left.component === right.component
    && left.pid === right.pid
    && left.startedAt === right.startedAt
    && sameExecutablePath(left.executable, right.executable)
    && left.profilePath === right.profilePath
    && left.tunnelId === right.tunnelId
    && left.marker === right.marker
    && left.processStartTimeMs === right.processStartTimeMs
    && left.processStartMarker === right.processStartMarker
    && left.processExecutable === right.processExecutable
    && sameListenerPorts(left.listenerPorts, right.listenerPorts)
    && left.runtimeId === right.runtimeId
    && left.instanceId === right.instanceId
    && left.deploymentEpoch === right.deploymentEpoch
    && left.profileDigest === right.profileDigest
    && left.workingDirectory === right.workingDirectory
    && left.environmentDigest === right.environmentDigest;
}

function startupOperationOwnsIdentity(operation: StartupOperation, record: OwnedProcess): boolean {
  const owned = operation.ownedProcess;
  return operation.component === record.component && operation.pid === record.pid
    && operation.processStartMarker === record.processStartMarker
    && operation.processExecutable === record.processExecutable
    && isOwnedProcess(owned) && owned.component === record.component && owned.pid === record.pid
    && owned.processStartMarker === record.processStartMarker && owned.processExecutable === record.processExecutable
    && sameExecutablePath(owned.executable, record.executable) && owned.profilePath === record.profilePath;
}

function sameListenerPorts(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
  return left !== undefined && right !== undefined && left.length === right.length && left.every((port, index) => port === right[index]);
}

function ownershipDigest(record: OwnedProcess, sourceRoot: string, dataRoot: string): string {
  return createHash('sha256').update(JSON.stringify({
    component: record.component,
    pid: record.pid,
    processStartMarker: record.processStartMarker,
    processExecutable: record.processExecutable,
    sourceRoot,
    dataRoot: realpathSync(dataRoot),
    profilePath: record.profilePath,
    listenerPorts: record.listenerPorts,
  })).digest('hex');
}

function isPositiveSafeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function isNonNegativeSafeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function yamlString(value: string): string { return JSON.stringify(value); }

async function writePrivateText(filename: string, content: string): Promise<void> {
  const { writePrivateTextAtomic } = await import('./credentials.js');
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writePrivateTextAtomic(filename, content);
}

function tail(value: string, lines: number): string { return value.split('\n').slice(-lines).join('\n'); }

function redactLogs(value: string): string {
  return value
    .replace(/(["']?(?:authorization|api[_-]?key|token|secret)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^,\s}]+)/gi, '$1<REDACTED>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <REDACTED>');
}

function assertRuntimeOwnership(record: OwnedProcess, observed: RuntimeObservedStatus): void {
  if (observed.endpoint === null || observed.endpoint.pid !== record.pid || observed.endpoint.startedAt !== record.startedAt
    || (record.runtimeId !== undefined && record.runtimeId !== null && observed.endpoint.runtimeId !== record.runtimeId)
    || (record.instanceId !== undefined && record.instanceId !== null && observed.endpoint.instanceId !== record.instanceId)) {
    throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime endpoint does not match supervisor ownership metadata');
  }
}

function runtimeOwnershipMatches(record: OwnedProcess, observed: RuntimeObservedStatus): boolean {
  try {
    assertRuntimeOwnership(record, observed);
    return true;
  } catch {
    return false;
  }
}

function localRuntimePort(apiUrl: string): number | null {
  try {
    const endpoint = new URL(apiUrl);
    const port = Number(endpoint.port);
    return endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1'
      && Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch { return null; }
}

async function processOwnsLoopbackListener(pid: number, port: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], {
      encoding: 'utf8', timeout: 1_000, maxBuffer: 16_384,
    });
    const fields = stdout.split('\n');
    return fields.includes(`p${pid}`) && fields.includes(`n127.0.0.1:${port}`);
  } catch { return false; }
}

async function ownedProcessOwnsRecordedListeners(record: OwnedProcess, expectedPorts: readonly number[]): Promise<boolean> {
  if (!sameListenerPorts(record.listenerPorts, expectedPorts) || await inspectProcess(record) !== 'running') return false;
  for (const port of expectedPorts) if (await loopbackListenerOwner(port) !== record.pid) return false;
  if (await inspectProcess(record) !== 'running') return false;
  for (const port of expectedPorts) if (await loopbackListenerOwner(port) !== record.pid) return false;
  return true;
}

async function loopbackListenerOwner(port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], {
      encoding: 'utf8', timeout: 1_000, maxBuffer: 16_384,
    });
    const owners = new Set<number>();
    let pid: number | null = null;
    for (const field of stdout.split('\n')) {
      if (/^p\d+$/.test(field)) pid = Number(field.slice(1));
      else if (field === `n127.0.0.1:${port}` && pid !== null) owners.add(pid);
    }
    return owners.size === 1 ? [...owners][0]! : null;
  } catch {
    return null;
  }
}

interface ProcessExecutionInspection {
  readonly arguments: readonly string[];
  readonly unsafeEnvironmentVariables: readonly string[];
}

async function processExecutionForPid(pid: number): Promise<ProcessExecutionInspection | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/python3', ['-I', '-S', MACOS_SAFETY_HELPER, 'process-arguments', String(pid)], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin' },
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.arguments) || !Array.isArray(parsed.unsafeEnvironmentVariables)
      || Object.keys(parsed).length !== 2
      || parsed.arguments.length === 0 || parsed.arguments.length > 256
      || !parsed.arguments.every((argument) => typeof argument === 'string' && argument.length > 0 && argument.length <= 16_384)
      || parsed.unsafeEnvironmentVariables.length > 32
      || !parsed.unsafeEnvironmentVariables.every((name) => typeof name === 'string'
        && (name === 'NODE_OPTIONS' || name === 'NODE_PATH' || name.startsWith('DYLD_') || name.startsWith('TSX_')))) return null;
    return parsed as unknown as ProcessExecutionInspection;
  } catch {
    return null;
  }
}

function processArgumentsRunEntrypoint(
  argumentsList: readonly string[], sourceEntrypoint: string, builtEntrypoint: string, trailingArgument?: string,
): boolean {
  if (argumentsList.length < 2 || !sameExecutablePath(argumentsList[0]!, canonicalNodeRuntime().path)) return false;
  const sourceLoader = path.resolve(path.dirname(sourceEntrypoint), '..', 'node_modules', 'tsx', 'dist');
  const sourceArguments = [
    argumentsList[0]!, '--require', path.join(sourceLoader, 'preflight.cjs'),
    '--import', pathToFileURL(path.join(sourceLoader, 'loader.mjs')).href,
    sourceEntrypoint, ...(trailingArgument === undefined ? [] : [trailingArgument]),
  ];
  const builtArguments = [argumentsList[0]!, builtEntrypoint, ...(trailingArgument === undefined ? [] : [trailingArgument])];
  return sameArgumentVector(argumentsList, sourceArguments) || sameArgumentVector(argumentsList, builtArguments);
}

function sameArgumentVector(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((argument, index) => {
    const expectedArgument = expected[index]!;
    return path.isAbsolute(expectedArgument) ? path.isAbsolute(argument) && sameExecutablePath(argument, expectedArgument) : argument === expectedArgument;
  });
}

function sameStringVector(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameOwnedRuntime(left: OwnedProcess, right: OwnedProcess): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt
    && left.runtimeId === right.runtimeId && left.instanceId === right.instanceId;
}

function sameExecutablePath(left: string, right: string): boolean {
  const normalized = (value: string): string => {
    try { return realpathSync(value); } catch { return path.resolve(value); }
  };
  return normalized(left) === normalized(right);
}

function sameSourceRoot(left: string, right: string): boolean {
  return sameExecutablePath(left, right);
}

function matchesRecordedRuntime(record: OwnedProcess, endpoint: NonNullable<RuntimeObservedStatus['endpoint']>): boolean {
  return endpoint.pid === record.pid
    && endpoint.startedAt === record.startedAt
    && (record.runtimeId === undefined || record.runtimeId === null || endpoint.runtimeId === record.runtimeId)
    && (record.instanceId === undefined || record.instanceId === null || endpoint.instanceId === record.instanceId);
}

function sameEndpoint(left: NonNullable<RuntimeObservedStatus['endpoint']>, right: NonNullable<RuntimeObservedStatus['endpoint']>): boolean {
  return left.runtimeId === right.runtimeId && left.instanceId === right.instanceId && left.pid === right.pid
    && left.startedAt === right.startedAt && left.apiUrl === right.apiUrl && left.mcpUrl === right.mcpUrl;
}

async function acquireOperationLock(filename: string, operation: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const processStart = observeProcessStart(process.pid);
    if (processStart.state !== 'live') {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor process start identity could not be measured safely');
    }
    try {
      const handle = await open(filename, 'wx', 0o600);
      let initialized = false;
      try {
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString(), operation, processStartMarker: processStart.marker } satisfies SupervisorOperationLock)}\n`, 'utf8');
        await handle.sync();
        initialized = true;
      } finally {
        try {
          if (!initialized) await rm(filename, { force: true });
        } finally {
          await handle.close();
        }
      }
      return async () => { await rm(filename, { force: true }); };
    } catch (error) {
      if (!isAlreadyExists(error)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor operation lock could not be created', { cause: error });
      const content = await readOperationLockContent(filename);
      if (content === null) continue;
      let lock: SupervisorOperationLock;
      try {
        const parsed = JSON.parse(content) as unknown;
        if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isPositiveSafeInteger(parsed.pid) || typeof parsed.startedAt !== 'string' || typeof parsed.operation !== 'string'
          || (parsed.processStartMarker !== undefined && (typeof parsed.processStartMarker !== 'string' || !/^\d+:\d{6}$/.test(parsed.processStartMarker)))) throw new Error('invalid lock');
        lock = parsed as unknown as SupervisorOperationLock;
      } catch (parseError) {
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor operation lock is invalid; refusing to start another runtime', { cause: parseError });
      }
      const lockProcess = observeProcessStart(lock.pid);
      if (lock.pid === process.pid || lockProcess.state === 'indeterminate') {
        throw new RuntimeError('SUPERVISOR_BUSY', `Supervisor operation ${lock.operation} is already running`);
      }
      if (lockProcess.state === 'live' && (lock.processStartMarker === undefined || lock.processStartMarker === lockProcess.marker)) {
        throw new RuntimeError('SUPERVISOR_BUSY', `Supervisor operation ${lock.operation} is already running`);
      }
      try { await rm(filename); } catch (removeError) {
        if (!isNotFound(removeError)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Stale supervisor operation lock could not be retired', { cause: removeError });
      }
    }
  }
  throw new RuntimeError('SUPERVISOR_BUSY', 'Supervisor operation lock changed while stale recovery was in progress');
}

async function acquireSetupOperationLock(filename: string, operation: string): Promise<() => Promise<void>> {
  const processStart = observeProcessStart(process.pid);
  if (processStart.state !== 'live') throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor process start identity could not be measured safely');
  const lockToken = randomUUID();
  try {
    const handle = await open(filename, 'wx', 0o600);
    let initialized = false;
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString(), operation, processStartMarker: processStart.marker, lockToken })}\n`, 'utf8');
      await handle.sync();
      initialized = true;
    } finally {
      try { if (!initialized) await rm(filename, { force: true }); } finally { await handle.close(); }
    }
  } catch (error) {
    if (isAlreadyExists(error)) throw new RuntimeError('SUPERVISOR_BUSY', `Supervisor operation ${operation} requires explicit stale-lock reconciliation`);
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor setup operation lock could not be created', { cause: error });
  }
  return async () => {
    const current = await readFile(filename, 'utf8').catch(() => null);
    if (current !== null && current.includes(`"lockToken":"${lockToken}"`)) await rm(filename, { force: true });
  };
}

async function readOperationLockContent(filename: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const content = await readSupervisorStateFile(filename);
    if (content === null || content.length > 0) return content;
    if (attempt < 2) await delay(10);
  }
  return '';
}

async function assertOwnedRuntimeProcess(record: OwnedProcess): Promise<void> {
  if (await inspectProcess(record) !== 'running') {
    throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime process identity is not verified against supervisor ownership metadata');
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function recoveryWindowExpired(record: RecoveryRecord): boolean {
  const startedAt = Date.parse(record.windowStartedAt ?? '');
  return !Number.isFinite(startedAt) || Date.now() - startedAt >= RECOVERY_WINDOW_MS;
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function mutationLogicalFingerprint(name: string, args: Record<string, unknown>, context: SupervisorWorkloadCallContext): string {
  const logicalArgs = { ...args };
  delete logicalArgs.requestId;
  return createHash('sha256').update(stableJson({
    name,
    args: logicalArgs,
    clientId: context.clientId,
    sessionId: context.sessionId ?? null,
    projectId: typeof args.projectId === 'string' ? args.projectId : null,
    workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : null,
  })).digest('hex');
}

async function listenerReleased(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
  });
}
