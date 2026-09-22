import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
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
import { proMcpToolDefinitions } from './mcp.js';
import { fullMcpToolDefinitionsV21 } from './mcp-v21.js';
import { loadOrCreateRuntimeId, readEndpoint, readRuntimeControl, removeEndpointIfInstance, removeRuntimeControlIfInstance } from './persistence.js';
import { privateDirectoryProblem } from './private-fs.js';
import { runtimeStatus, startRuntime, stopRuntime, type RuntimeObservedStatus } from './lifecycle.js';
import { assertSupportedNodeVersion, canonicalNodeRuntime, node24Environment } from './node-runtime.js';
import { callSupervisorAdminTool, listSupervisorAdminToolNames, type SupervisorAdminToolCallResult } from './supervisor-admin.js';
import { startSupervisorNativeControlServer, type AdminRecycleInput } from './supervisor-native-control.js';

const execFileAsync = promisify(execFile);
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
  readonly schemaVersion: 3;
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
  readonly pro: CatalogProfileStatus;
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
  );
}

export class Supervisor {
  private nativeControlActive = false;

  public constructor(
    public readonly dataRoot: string,
    private readonly sourceRoot: string,
    private readonly tunnelClientPath: string,
    private readonly webPort: number,
    private readonly adminPort: number,
    private readonly supervisorControlPort: number,
    private readonly adminTunnelHealthPort: number,
    private readonly protectedReferenceRoot?: string,
  ) {
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

  private async upUnlocked(expectedSourceIdentity?: ActivationSourceIdentity): Promise<SupervisorStackStatus> {
    const credentials = await inspectCredentialStatus(this.dataRoot);
    if (!credentials.controlPlaneApiKeyPresent) {
      throw new RuntimeError(credentials.legacy.detected ? 'MIGRATION_REQUIRED' : 'CREDENTIAL_MISSING', 'A persistent control-plane credential is required; run explicit credentials migration before iris up');
    }
    const registryResult = await this.ensureRegistry();
    await loadOrCreateTunnelServiceSecret(this.dataRoot);
    const runtimeId = await loadOrCreateRuntimeId(this.dataRoot);
    const boundRegistry = await bindConnectorRuntime(this.dataRoot, runtimeId);
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
        const upgraded = await runtimeRecordFromObserved(observed.endpoint!, state.workloadSourceRoot);
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
        const startedRuntime = await startRuntime({
          dataRoot: this.dataRoot,
          sourceRoot: state.workloadSourceRoot,
          ...(this.protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: this.protectedReferenceRoot }),
          ...(expectedSourceIdentity === undefined ? {} : { expectedSourceIdentity }),
        });
        if (startedRuntime.endpoint === null) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'IRIS runtime started without an endpoint descriptor');
        const replacement = await runtimeRecordFromObserved(startedRuntime.endpoint, state.workloadSourceRoot);
        if (state.runtime !== null && replacement.instanceId === state.runtime.instanceId) {
          throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Runtime replacement reused the previous instance identity');
        }
        state = { ...state, runtime: replacement };
        await this.writeState(state);
        started.push('runtime');
        runtimeReplaced = true;
      }

      const runtime = await runtimeStatus(this.dataRoot);
      if (runtime.state !== 'running' || runtime.endpoint === null) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'IRIS runtime did not become ready');
      if (state.runtime === null) {
        state = { ...state, runtime: await runtimeRecordFromObserved(runtime.endpoint, state.workloadSourceRoot) };
        await this.writeState(state);
      }
      if (expectedSourceIdentity !== undefined) {
        await assertActivationSourceIdentity(
          state.workloadSourceRoot,
          expectedSourceIdentity,
          'Candidate source identity changed after runtime launch before stack continuation',
        );
      }

      state = await this.ensureAdmin(state, started);
      const profiles = await this.writeManagedProfiles(boundRegistry, runtime.endpoint.apiUrl);
      if (this.nativeControlActive) {
        if (profiles.admin === null) throw new RuntimeError('PRECONDITION_FAILED', 'Persistent native supervisor control requires a dedicated ADMIN tunnel identity');
        state = await this.ensureAdminTunnel(state, boundRegistry, profiles.admin, started);
      }
      state = await this.ensureWeb(state, runtime.endpoint.apiUrl, started, expectedSourceIdentity);
      state = await this.ensureTunnel(state, 'full', boundRegistry, profiles.full, runtime.endpoint.instanceId, started, runtimeReplaced);
      state = await this.ensureTunnel(state, 'pro', boundRegistry, profiles.pro, runtime.endpoint.instanceId, started, runtimeReplaced);
      await this.writeState(state);
      const result = await this.statusFrom(state, boundRegistry, credentials);
      if (result.localRuntime.state === 'FAILED' || result.tunnel.state === 'FAILED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `IRIS stack did not reach local and tunnel readiness: ${JSON.stringify({ runtime: result.runtime, localRuntime: result.localRuntime, tunnel: result.tunnel, connectors: result.connectors })}`);
      return result;
    } catch (error) {
      await this.rollbackStarted(started).catch(() => undefined);
      throw error;
    }
  }

  public async down(): Promise<SupervisorStackStatus> {
    await this.prepareDirectories();
    return this.withOperationLock('down', () => this.downUnlocked());
  }

  private async downUnlocked(): Promise<SupervisorStackStatus> {
    const state = await this.readState();
    const observed = await runtimeStatus(this.dataRoot);
    if (state.runtime === null && observed.state !== 'stopped' && observed.state !== 'stale') {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'A runtime is active or ambiguous without supervisor ownership metadata');
    }
    await this.stopWeb(state.web);
    await this.stopTunnel(state.tunnels.pro);
    await this.stopTunnel(state.tunnels.full);
    await this.stopTunnel(state.adminTunnel);
    if (state.runtime !== null) {
      if (observed.state === 'running') {
        assertRuntimeOwnership(state.runtime, observed);
        await stopRuntime(this.dataRoot);
      } else {
        await this.retireRuntime(state.runtime, observed);
      }
    }
    await this.stopAdmin(state.admin);
    const cleared = emptyState(state.supervisorId, state.workloadSourceRoot);
    await this.writeState(cleared);
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
    await this.stopTunnel(state.tunnels.pro);
    state = { ...state, tunnels: { ...state.tunnels, pro: null } };
    await this.writeState(state);
    await this.stopTunnel(state.tunnels.full);
    state = { ...state, tunnels: { ...state.tunnels, full: null } };
    await this.writeState(state);
    await this.stopWeb(state.web);
    state = { ...state, web: null };
    await this.writeState(state);
    if (state.runtime !== null) {
      if (observed.state === 'running') {
        assertRuntimeOwnership(state.runtime, observed);
        await stopRuntime(this.dataRoot, CONTROLLED_ACTIVATION_SHUTDOWN_DEADLINE_MS);
      } else {
        await this.retireRuntime(state.runtime, observed);
      }
    } else if (observed.state === 'stale') {
      await this.retireStaleRuntimeMetadata(observed, state.workloadSourceRoot);
    }
    state = { ...state, workloadSourceRoot: sourceRoot, runtime: null, web: null, tunnels: { full: null, pro: null }, recovery: emptyRecovery() };
    await this.writeState(state);
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
    if (full === undefined || pro === undefined || full.runtimeId === null || pro.runtimeId === null) {
      throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', 'FULL and PRO runtime-bound connector identities are required before target catalog probing');
    }
    const baselineStatus = await this.catalogStatus();
    const baselineFullIdentity = baselineStatus.full.live;
    if (baselineFullIdentity === null
      || baselineFullIdentity.catalogHash !== full.catalogHash
      || baselineFullIdentity.toolCount !== full.expectedToolNames.length) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Current FULL runtime identity does not match the bound connector baseline before target probing');
    }

    const probeDataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-target-probe-'));
    let manifest: ConnectorCatalogManifest | null = null;
    let failure: unknown = null;
    try {
      await initializeConnectorRegistry(probeDataRoot, {
        fullTunnelId: full.tunnelId,
        proTunnelId: pro.tunnelId,
        fullHealthPort: full.healthPort,
        proHealthPort: pro.healthPort,
      });
      const probeRuntimeId = await loadOrCreateRuntimeId(probeDataRoot);
      await bindConnectorRuntime(probeDataRoot, probeRuntimeId);
      const serviceSecret = await loadOrCreateTunnelServiceSecret(probeDataRoot);
      const probeRegistry = await readConnectorRegistry(probeDataRoot);
      if (probeRegistry === null) {
        throw new RuntimeError('PRECONDITION_FAILED', 'Isolated target catalog probe registry was not initialized');
      }
      const probeFull = probeRegistry.connectors.find((connector) => connector.connectorId === 'iris-full');
      const probePro = probeRegistry.connectors.find((connector) => connector.connectorId === 'iris-pro');
      if (probeFull === undefined || probePro === undefined) {
        throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', 'Isolated target catalog probe is missing FULL or PRO connector identity');
      }

      const probe = await startRuntime({
        dataRoot: probeDataRoot,
        preferredPort: 0,
        sourceRoot,
        ...(this.protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: this.protectedReferenceRoot }),
        ...(expectedSourceIdentity === undefined ? {} : { expectedSourceIdentity }),
      });
      if (probe.endpoint === null) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Target catalog probe runtime started without endpoint metadata');
      const headersFor = (binding: ConnectorBinding, clientId: string): Record<string, string> => ({
        authorization: `Bearer ${serviceSecret}`,
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'x-iris-connector-profile': binding.mode,
        'x-iris-deployment-epoch': String(probeRegistry.deploymentEpoch),
        'x-iris-runtime-id': probeRuntimeId,
        'x-iris-client-id': clientId,
      });
      const [fullListed, proListed, fullIdentityResponse] = await Promise.all([
        postJson(`${probe.endpoint.apiUrl}${probeFull.mcpPath}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headersFor(probeFull, 'iris-supervisor-target-full')),
        postJson(`${probe.endpoint.apiUrl}${probePro.mcpPath}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headersFor(probePro, 'iris-supervisor-target-pro')),
        postJson(`${probe.endpoint.apiUrl}${probeFull.mcpPath}`, {
          jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'catalog_identity', arguments: {} },
        }, { ...headersFor(probeFull, 'iris-supervisor-target-catalog'), 'Mcp-Name': 'catalog_identity' }),
      ]);
      const fullNames = toolNames(fullListed);
      const proNames = toolNames(proListed);
      if (fullNames.length === 0 || proNames.length === 0) {
        throw new RuntimeError('MCP_CATALOG_STALE', 'Target workload catalog probe did not return complete FULL and PRO tool lists');
      }
      if (proNames.length !== pro.expectedToolNames.length || !proNames.every((name, index) => name === pro.expectedToolNames[index])) {
        throw new RuntimeError('PRECONDITION_FAILED', 'Target workload changes the PRO catalog; bounded Phase 5 activation permits a FULL catalog transition only');
      }
      const fullIdentity = catalogIdentityFromToolResponse(fullIdentityResponse);
      if (fullIdentity === null || fullIdentity.toolCount !== fullNames.length) {
        throw new RuntimeError('MCP_CATALOG_STALE', 'Target FULL catalog identity did not match its live tool list');
      }
      const targetProDefinitions = listedToolDefinitions(proListed);
      const baselineVersionProIdentity = catalogIdentityAtVersion('PRO', targetProDefinitions, baselineFullIdentity.catalogVersion);
      if (baselineVersionProIdentity.catalogHash !== pro.catalogHash) {
        throw new RuntimeError('PRECONDITION_FAILED', 'Target workload changes the bounded PRO catalog schema');
      }
      const proIdentity = catalogIdentityAtVersion('PRO', targetProDefinitions, fullIdentity.catalogVersion);
      if (proIdentity.toolCount !== proNames.length) {
        throw new RuntimeError('MCP_CATALOG_STALE', 'Target PRO catalog identity did not match its live tool list');
      }
      manifest = {
        full: { expectedToolNames: fullNames, catalogHash: fullIdentity.catalogHash },
        pro: { expectedToolNames: proNames, catalogHash: proIdentity.catalogHash },
      };
    } catch (error) {
      failure = error;
    }

    let cleanupSafeToRemove = true;
    try {
      const observed = await runtimeStatus(probeDataRoot);
      if (observed.state === 'running') await stopRuntime(probeDataRoot);
      const afterStop = await runtimeStatus(probeDataRoot);
      if (afterStop.state === 'running' || afterStop.state === 'indeterminate') {
        failure = new RuntimeError('AUTHORITY_INDETERMINATE', 'Isolated target catalog probe runtime could not be proven stopped during cleanup');
        cleanupSafeToRemove = false;
      }
    } catch (error) {
      failure = new RuntimeError('AUTHORITY_INDETERMINATE', 'Isolated target catalog probe cleanup could not verify runtime ownership', { cause: error });
      cleanupSafeToRemove = false;
    }
    if (cleanupSafeToRemove) {
      try {
        await rm(probeDataRoot, { recursive: true, force: true });
      } catch (error) {
        failure ??= new RuntimeError('PERSISTENCE_FAILURE', 'Isolated target catalog probe data could not be removed after shutdown', { cause: error });
      }
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

  private async adoptRuntimeUnlocked(): Promise<SupervisorStackStatus> {
    const observed = await runtimeStatus(this.dataRoot);
    if (observed.state !== 'running' || observed.endpoint === null) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Only a verified running IRIS runtime can be adopted');
    const state = await this.readState();
    if (!(await commandLooksLikeIris(observed.endpoint.pid, state.workloadSourceRoot))) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime process identity could not be verified against the persisted workload source binding');
    if (state.runtime !== null) return this.status();
    await this.writeState({ ...state, runtime: await runtimeRecordFromObserved(observed.endpoint, state.workloadSourceRoot) });
    return this.status();
  }

  public async runSupervisorDaemon(): Promise<void> {
    await this.prepareDirectories();
    const persisted = await this.readState();
    if (persisted.recovery.terminal) {
      throw new RuntimeError('RECOVERY_EXHAUSTED', 'Automatic supervisor recovery is suspended after the restart budget was exhausted');
    }
    const nativeControl = await startSupervisorNativeControlServer(this.dataRoot, this.supervisorControlPort, {
      supervisorStatus: () => this.supervisorNativeStatus(),
      adminStatus: () => this.adminNativeStatus(),
      adminRecycle: (input) => this.adminRecycle(input),
      adminToolCall: (name, args) => this.adminToolCall(name, args),
    });
    this.nativeControlActive = true;
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await this.up();
      const state = await this.readState();
      if (state.recovery.windowStartedAt !== null && recoveryWindowExpired(state.recovery)) {
        await this.writeState({ ...state, recovery: emptyRecovery() });
      }
      while (!stopping) {
        await delay(5_000);
        if (stopping) break;
        await this.automaticRecoveryTick();
      }
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      this.nativeControlActive = false;
      await nativeControl.close();
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
    const [state, registry, observed] = await Promise.all([
      this.readState(),
      readConnectorRegistry(this.dataRoot),
      runtimeStatus(this.dataRoot),
    ]);
    const adminResult = await callSupervisorAdminTool(this.dataRoot, this.adminPort, 'admin_status', {});
    const admin = requireSuccessfulAdminResult(adminResult, 'admin_status');
    const expectedAdminEnvironmentDigest = launchEnvironmentDigest(
      supervisorAdminChildEnvironment(this.dataRoot, this.adminPort, this.protectedReferenceRoot),
    );
    const adminChildEnvironmentDigest = state.admin?.environmentDigest ?? null;
    const adminChildWorkingDirectory = state.admin?.workingDirectory ?? null;
    const adminSourceCoherent = await adminProcessMatchesControlSource(state.admin, this.sourceRoot);
    return {
      supervisorControlOwner: 'OUTER_SUPERVISOR_DAEMON',
      supervisorProcessId: process.pid,
      supervisorProcessIdentity: currentProcessIdentity(),
      controlSourceRoot: this.sourceRoot,
      protectedReferenceRoot: this.protectedReferenceRoot ?? null,
      readiness: observed.state === 'running' && state.admin !== null && state.adminTunnel !== null && adminSourceCoherent ? 'READY' : 'DEGRADED',
      workloadRuntimeId: observed.endpoint?.runtimeId ?? null,
      workloadInstanceId: observed.endpoint?.instanceId ?? null,
      workloadCatalogId: typeof admin.fullCatalogId === 'string' ? admin.fullCatalogId : null,
      deploymentEpoch: registry?.deploymentEpoch ?? null,
      adminTunnelBindingId: registry?.admin?.tunnelId ?? null,
      adminChildIdentity: ownedProcessIdentity(state.admin),
      adminChildStartedAt: state.admin?.startedAt ?? null,
      adminChildWorkingDirectory,
      adminChildEnvironmentDigest,
      expectedAdminEnvironmentDigest,
      adminSourceCoherent,
      adminEnvironmentCoherent: adminChildEnvironmentDigest !== null && adminChildEnvironmentDigest === expectedAdminEnvironmentDigest,
      workloadTunnelIdentity: ownedProcessIdentity(state.tunnels.full),
      adminTunnelIdentity: ownedProcessIdentity(state.adminTunnel),
      workloadProfileDigest: state.tunnels.full?.profileDigest ?? null,
      adminProfileDigest: state.adminTunnel?.profileDigest ?? null,
    };
  }

  public async adminNativeStatus(): Promise<Record<string, unknown>> {
    const state = await this.readState();
    const [statusResult, toolNames] = await Promise.all([
      callSupervisorAdminTool(this.dataRoot, this.adminPort, 'admin_status', {}),
      listSupervisorAdminToolNames(this.dataRoot, this.adminPort),
    ]);
    const status = requireSuccessfulAdminResult(statusResult, 'admin_status');
    const expectedAdminEnvironmentDigest = launchEnvironmentDigest(
      supervisorAdminChildEnvironment(this.dataRoot, this.adminPort, this.protectedReferenceRoot),
    );
    const adminChildEnvironmentDigest = state.admin?.environmentDigest ?? null;
    const adminChildWorkingDirectory = state.admin?.workingDirectory ?? null;
    const adminSourceCoherent = await adminProcessMatchesControlSource(state.admin, this.sourceRoot);
    return {
      adminChildIdentity: ownedProcessIdentity(state.admin),
      adminChildStartedAt: state.admin?.startedAt ?? null,
      adminChildWorkingDirectory,
      adminChildEnvironmentDigest,
      expectedAdminEnvironmentDigest,
      protectedReferenceRoot: this.protectedReferenceRoot ?? null,
      adminSourceCoherent,
      adminEnvironmentCoherent: adminChildEnvironmentDigest !== null && adminChildEnvironmentDigest === expectedAdminEnvironmentDigest,
      readiness: adminSourceCoherent ? (status.readiness ?? 'DEGRADED') : 'DEGRADED',
      activationStatusAvailable: toolNames.includes('activation_status'),
      activationPrepareAvailable: toolNames.includes('activation_prepare'),
      activationApplyAvailable: toolNames.includes('activation_apply'),
      activationConfirmAvailable: toolNames.includes('activation_confirm'),
      activationRollbackAvailable: toolNames.includes('activation_rollback'),
    };
  }

  public async adminRecycle(input: AdminRecycleInput = {}): Promise<Record<string, unknown>> {
    await this.prepareDirectories();
    return this.withOperationLock('admin-recycle', () => this.adminRecycleUnlocked(input));
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

    await this.stopAdmin(state.admin);
    state = { ...state, admin: null };
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
    const fullBinding = registry.connectors.find((binding) => binding.mode === 'FULL')!;
    const proBinding = registry.connectors.find((binding) => binding.mode === 'PRO')!;
    const full = profiles.find((profile) => profile.profile === 'FULL') ?? catalogProfileStatus(fullBinding, expectedSource(fullBinding), null, [], false);
    const pro = profiles.find((profile) => profile.profile === 'PRO') ?? catalogProfileStatus(proBinding, expectedSource(proBinding), null, [], false);
    const state = catalogActivationState([full, pro]);
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
    const runtime = await runtimeStatus(this.dataRoot);
    const runtimeLayer = runtime.state === 'running' && state.runtime !== null
      ? ownershipLayer(state.runtime, runtime)
      : runtime.state === 'stopped' && state.runtime === null ? layer('FAILED', 'RUNTIME_NOT_RUNNING', 'IRIS runtime is stopped')
        : layer('FAILED', runtime.reason === 'STALE_AUTHORITY' ? 'RUNTIME_IDENTITY_MISMATCH' : 'SUPERVISOR_NOT_RUNNING', runtime.reason ?? 'IRIS runtime is not supervisor-owned');
    const webLayer = await this.probeWeb(state.web);
    const adminLayer = await this.probeAdmin(state.admin);
    const tunnelResults = await Promise.all([
      this.probeTunnel(state.tunnels.full, registry.connectors.find((connector) => connector.connectorId === 'iris-full') ?? null),
      this.probeTunnel(state.tunnels.pro, registry.connectors.find((connector) => connector.connectorId === 'iris-pro') ?? null),
    ]);
    const tunnelLayer = tunnelResults.every((result) => result.state === 'READY') ? layer('READY', 'READY', 'FULL and PRO workload tunnel clients are healthy') : combineLayers(tunnelResults, 'TUNNEL_NOT_RUNNING', 'One or more supervisor-owned workload tunnel clients is not ready');
    const isolatedAdminRequired = this.nativeControlActive || state.adminTunnel !== null;
    const adminTunnelLayer = isolatedAdminRequired
      ? await this.probeAdminTunnel(state.adminTunnel)
      : layer('READY', 'LEGACY_ADMIN_TRANSPORT', 'Isolated admin tunnel is required only for the persistent native supervisor daemon');
    const nativeControlLayer = isolatedAdminRequired
      ? await this.probeNativeControl()
      : layer('READY', 'LEGACY_ADMIN_TRANSPORT', 'Native supervisor control is required only for the persistent native supervisor daemon');
    const local = runtimeLayer.state === 'READY' ? await this.localReadiness() : { status: layer('FAILED', runtimeLayer.code, 'L1 requires a ready runtime'), connectors: [], catalogs: [] };
    const controlPlaneParts = [...tunnelResults, adminLayer, adminTunnelLayer, nativeControlLayer];
    const controlPlane = controlPlaneParts.every((result) => result.state === 'READY')
      ? layer('READY', 'READY', 'Workload tunnels, isolated admin tunnel, and persistent supervisor-admin endpoint are healthy')
      : combineLayers(controlPlaneParts, 'CONTROL_PLANE_UNREACHABLE', 'Control-plane readiness is not proven for workload and isolated admin transport');
    const connectorStatuses = registry.connectors.map((binding) => connectorStatus(binding, local.connectors.find((entry) => entry.connectorId === binding.connectorId), tunnelResults[binding.connectorId === 'iris-full' ? 0 : 1]));
    const e2e = layer('UNKNOWN', 'E2E_PROBE_UNAVAILABLE', 'No safe remote connector probe is configured; /readyz is not treated as end-to-end proof');
    const stateValue = runtimeLayer.state === 'FAILED' || local.status.state === 'FAILED' || tunnelLayer.state === 'FAILED' ? 'FAILED'
      : e2e.state === 'UNKNOWN' || webLayer.state !== 'READY' ? 'DEGRADED' : 'READY';
    return { state: stateValue, runtime: runtimeLayer, web: webLayer, tunnel: tunnelLayer, controlPlane, localRuntime: local.status, endToEnd: e2e, connectors: connectorStatuses, credentials, registryPresent: true, recovery: recoveryView((await this.readState()).recovery) };
  }

  private async retireRuntime(record: OwnedProcess, observed: RuntimeObservedStatus): Promise<void> {
    const inspected = await inspectProcess(record);
    if (inspected === 'ambiguous') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Recorded runtime process identity is not verified');
    if (inspected === 'running') {
      if (observed.state === 'running') {
        try {
          await stopRuntime(this.dataRoot);
        } catch {
          if (await inspectProcess(record) !== 'running') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime identity changed during graceful shutdown');
          await stopOwnedProcess(record, true);
        }
      } else {
        await stopOwnedProcess(record, true);
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
        await stopOwnedProcess(current);
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
    const record = await spawnManaged(
      'admin', executable, args, this.sourceRoot,
      supervisorAdminChildEnvironment(this.dataRoot, this.adminPort, this.protectedReferenceRoot),
      null, this.logDirectory(), 'supervisor-admin-main',
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
          || current.profileDigest !== profileDigest;
        if (!profileChanged) {
          try {
            await waitForTunnel(await resolveExecutable(this.tunnelClientPath), this.adminTunnelHealthPort, 750);
            return state;
          } catch {
            // Recycle only the verified admin tunnel when its own readiness fails.
          }
        }
        await stopOwnedProcess(current);
      }
    }
    const executable = await resolveExecutable(this.tunnelClientPath);
    const pidFile = path.join(this.supervisorDirectory(), 'admin.tunnel.pid');
    const record = await spawnManaged(
      'tunnel-admin', executable, ['run', '--embedded-mcp-stub', '--profile-file', profilePath, '--pid.file', pidFile],
      this.sourceRoot, {}, profilePath, this.logDirectory(), 'tunnel-client', binding.tunnelId,
      null, null, null, profileDigest,
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
      if (inspected === 'running' && await endpointResponds(`http://127.0.0.1:${this.webPort}/`)) return state;
      if (inspected === 'running') await stopOwnedProcess(state.web);
    }
    const executable = path.join(state.workloadSourceRoot, 'apps/web/node_modules/.bin/vite');
    if (!existsSync(executable)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Web executable is unavailable; run pnpm install before iris up');
    if (await endpointResponds(`http://127.0.0.1:${this.webPort}/`)) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `Web port ${this.webPort} is occupied by an unowned process`);
    const record = await spawnManaged('web', executable, ['--host', '127.0.0.1', '--port', String(this.webPort)], path.join(state.workloadSourceRoot, 'apps/web'), { IRIS_RUNTIME_URL: runtimeUrl }, null, this.logDirectory(), 'vite');
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
          || runtimeReplaced;
        if (!deploymentChanged) {
          try {
            await waitForTunnel(await resolveExecutable(this.tunnelClientPath), binding.healthPort, 750);
            return state;
          } catch {
            // A live process with failed readiness is still an owned process. Recycle it
            // only after the same positive process identity check used for shutdown.
          }
        }
        await stopOwnedProcess(current);
      }
      if (inspected === 'stopped') {
        // The stale record is safe to replace; no signal is sent to the old PID.
      }
    }
    const pidFile = path.join(this.supervisorDirectory(), `${profile}.tunnel.pid`);
    const executable = await resolveExecutable(this.tunnelClientPath);
    const record = await spawnManaged(`tunnel-${profile}`, executable, ['run', '--profile-file', profilePath, '--pid.file', pidFile], this.sourceRoot, {}, profilePath, this.logDirectory(), 'tunnel-client', binding.tunnelId, registry.deploymentEpoch, runtimeInstanceId, binding.runtimeId, profileDigest);
    const next = { ...state, tunnels: { ...state.tunnels, [profile]: record } };
    await this.writeState(next);
    started.push(profile);
    await waitForTunnel(executable, binding.healthPort, current === null ? 15_000 : 2_000);
    return next;
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
      await waitForTunnel(await resolveExecutable(this.tunnelClientPath), binding.healthPort, 2_000);
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

  private async probeAdminTunnel(record: OwnedProcess | null): Promise<LayerStatus> {
    if (record === null) return layer('FAILED', 'TUNNEL_NOT_RUNNING', 'Isolated admin tunnel is not supervisor-owned');
    const inspected = await inspectProcess(record);
    if (inspected === 'ambiguous') return layer('FAILED', 'PROCESS_OWNERSHIP_AMBIGUOUS', 'Isolated admin tunnel process identity is ambiguous');
    if (inspected === 'stopped') return layer('FAILED', 'TUNNEL_NOT_RUNNING', 'Isolated admin tunnel process is stopped');
    try {
      await waitForTunnel(await resolveExecutable(this.tunnelClientPath), this.adminTunnelHealthPort, 2_000);
      return layer('READY', 'READY', 'Isolated admin tunnel health and readiness are healthy');
    } catch (error) {
      return layer('FAILED', runtimeErrorCode(error), 'Isolated admin tunnel readiness failed');
    }
  }

  private async writeManagedProfiles(registry: ConnectorRegistryDocument, runtimeApiUrl: string): Promise<{ readonly full: string; readonly pro: string; readonly admin: string | null }> {
    const credentials = credentialPaths(this.dataRoot);
    const full = registry.connectors.find((connector) => connector.connectorId === 'iris-full');
    const pro = registry.connectors.find((connector) => connector.connectorId === 'iris-pro');
    if (full === undefined || pro === undefined) throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', 'FULL and PRO connector bindings are required');
    const fullPath = full.managedProfilePath;
    const proPath = pro.managedProfilePath;
    const adminPath = registry.admin?.managedProfilePath ?? null;
    await writePrivateText(fullPath, managedProfile(full, credentials.controlPlaneApiKey, credentials.tunnelServiceAuthorization, this.logDirectory(), registry.deploymentEpoch, runtimeApiUrl, null));
    await writePrivateText(proPath, managedProfile(pro, credentials.controlPlaneApiKey, credentials.tunnelServiceAuthorization, this.logDirectory(), registry.deploymentEpoch, runtimeApiUrl, null));
    if (registry.admin !== null && adminPath !== null) {
      await writePrivateText(adminPath, managedAdminProfile(registry.admin, credentials.controlPlaneApiKey, credentials.tunnelServiceAuthorization, this.logDirectory(), this.adminTunnelHealthPort, `http://127.0.0.1:${this.supervisorControlPort}/mcp`));
    }
    return { full: fullPath, pro: proPath, admin: adminPath };
  }

  private async rollbackStarted(started: readonly ('runtime' | 'web' | 'admin' | 'full' | 'pro' | 'admin-tunnel')[]): Promise<void> {
    let state = await this.readState();
    if (started.includes('pro')) {
      await this.stopTunnel(state.tunnels.pro);
      state = { ...state, tunnels: { ...state.tunnels, pro: null } };
    }
    if (started.includes('full')) {
      await this.stopTunnel(state.tunnels.full);
      state = { ...state, tunnels: { ...state.tunnels, full: null } };
    }
    if (started.includes('admin-tunnel')) {
      await this.stopTunnel(state.adminTunnel);
      state = { ...state, adminTunnel: null };
    }
    if (started.includes('web')) {
      await this.stopWeb(state.web);
      state = { ...state, web: null };
    }
    if (started.includes('runtime')) {
      await stopRuntime(this.dataRoot);
      state = { ...state, runtime: null };
    }
    if (started.includes('admin')) {
      await this.stopAdmin(state.admin);
      state = { ...state, admin: null };
    }
    await this.writeState(state);
  }

  private async stopTunnel(record: OwnedProcess | null): Promise<void> {
    if (record === null) return;
    await stopOwnedProcess(record);
  }

  private async stopAdmin(record: OwnedProcess | null): Promise<void> {
    if (record === null) return;
    await stopOwnedProcess(record);
  }

  private async stopWeb(record: OwnedProcess | null): Promise<void> {
    if (record === null) return;
    await stopOwnedProcess(record);
  }

  private async readState(): Promise<SupervisorStateDocument> {
    const filename = path.join(this.supervisorDirectory(), STATE_FILE);
    const content = await readFile(filename, 'utf8').catch(() => null);
    if (content === null) return emptyState(`${os.hostname()}-${process.pid}`, this.sourceRoot);
    try {
      const value = JSON.parse(content) as unknown;
      if (!isState(value)) throw new Error('invalid supervisor state');
      return {
        ...value,
        schemaVersion: 3,
        workloadSourceRoot: value.workloadSourceRoot ?? this.sourceRoot,
        admin: value.admin ?? null,
        adminTunnel: value.adminTunnel ?? null,
        recovery: { ...emptyRecovery(), ...(value.recovery ?? {}), windowStartedAt: value.recovery?.windowStartedAt ?? null },
      };
    } catch (error) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor state is invalid', { cause: error });
    }
  }

  private async writeState(state: SupervisorStateDocument): Promise<void> {
    const { writePrivateJsonAtomic } = await import('./credentials.js');
    await writePrivateJsonAtomic(path.join(this.supervisorDirectory(), STATE_FILE), { ...state, updatedAt: new Date().toISOString() });
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
    '    - channel: admin',
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
  const command = await commandForPid(record.pid);
  if (command === null) return false;
  const sourceEntrypoint = path.resolve(import.meta.dirname, 'supervisor-admin-main.ts');
  const builtEntrypoint = path.resolve(import.meta.dirname, 'supervisor-admin-main.js');
  const expectedEntrypoint = existsSync(sourceEntrypoint) ? sourceEntrypoint : builtEntrypoint;
  return commandIncludesPath(command, expectedEntrypoint);
}

async function spawnManaged(
  component: OwnedProcess['component'], executable: string, args: readonly string[], cwd: string,
  extraEnvironment: Record<string, string>, profilePath: string | null, logDirectory: string, marker: string,
  tunnelId: string | null = null, deploymentEpoch: number | null = null, instanceId: string | null = null, runtimeId: string | null = null,
  profileDigest: string | null = null,
): Promise<OwnedProcess> {
  const logFilename = path.join(logDirectory, component === 'web' ? 'supervisor.log' : `${component}.log`);
  const output = openSync(logFilename, 'a', 0o600);
  const environment = node24Environment({ HOME: process.env.HOME ?? os.homedir(), TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: process.env.LANG ?? 'en_US.UTF-8' }, extraEnvironment);
  const workingDirectory = path.resolve(cwd);
  const environmentDigest = launchEnvironmentDigest(extraEnvironment);
  const child = spawn(executable, [...args], { cwd: workingDirectory, env: environment, detached: true, stdio: ['ignore', output, output] });
  closeSync(output);
  const pid = child.pid;
  child.on('error', () => undefined);
  if (pid === undefined || pid <= 0) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `Could not start ${component}`);
  child.unref();
  const processStartTimeMs = await waitForProcessStartTime(pid, 2_000);
  if (processStartTimeMs === null) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `${component} process start identity could not be verified`);
  return {
    component, pid, startedAt: new Date().toISOString(), executable: path.resolve(executable), profilePath, tunnelId, marker,
    processStartTimeMs, deploymentEpoch, instanceId, runtimeId, profileDigest, workingDirectory, environmentDigest,
  };
}

async function stopOwnedProcess(record: OwnedProcess, forceAfterDeadline = false): Promise<void> {
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
  if (forceAfterDeadline) {
    if (await inspectProcess(record) !== 'running') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `${record.component} process identity changed during bounded termination`);
    process.kill(record.pid, 'SIGKILL');
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline) {
      if (await inspectProcess(record) === 'stopped') return;
      await delay(25);
    }
  }
  throw new RuntimeError('TUNNEL_NOT_RUNNING', `${record.component} did not stop before the deadline`);
}

async function inspectProcess(record: OwnedProcess): Promise<'running' | 'stopped' | 'ambiguous'> {
  if (record.pid <= 0) return 'ambiguous';
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
    } catch (error) { lastCode = runtimeErrorCode(error); }
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
  };
}

async function executableForPid(pid: number): Promise<string | null> {
  const command = await commandForPid(pid);
  const first = command?.split(/\s+/)[0];
  return first !== undefined && path.isAbsolute(first) ? path.resolve(first) : null;
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
  return { schemaVersion: 3, supervisorId, updatedAt: new Date().toISOString(), workloadSourceRoot, runtime: null, web: null, admin: null, adminTunnel: null, tunnels: { full: null, pro: null }, recovery: emptyRecovery() };
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

function isMissingProcess(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'; }

function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'; }

function isState(value: unknown): value is SupervisorStateDocument {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) || typeof value.supervisorId !== 'string'
    || !(value.workloadSourceRoot === undefined || typeof value.workloadSourceRoot === 'string' && path.isAbsolute(value.workloadSourceRoot) && !value.workloadSourceRoot.includes('\0') && path.resolve(value.workloadSourceRoot) === value.workloadSourceRoot)
    || !isRecord(value.tunnels)) return false;
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
    && (value.processStartTimeMs === undefined || value.processStartTimeMs === null || isNonNegativeSafeInteger(value.processStartTimeMs))
    && (value.runtimeId === undefined || value.runtimeId === null || typeof value.runtimeId === 'string')
    && (value.instanceId === undefined || value.instanceId === null || typeof value.instanceId === 'string')
    && (value.deploymentEpoch === undefined || value.deploymentEpoch === null || isPositiveSafeInteger(value.deploymentEpoch))
    && (value.profileDigest === undefined || value.profileDigest === null || (typeof value.profileDigest === 'string' && /^[0-9a-f]{64}$/.test(value.profileDigest)))
    && (value.workingDirectory === undefined || value.workingDirectory === null || (typeof value.workingDirectory === 'string' && path.isAbsolute(value.workingDirectory)))
    && (value.environmentDigest === undefined || value.environmentDigest === null || (typeof value.environmentDigest === 'string' && /^[0-9a-f]{64}$/.test(value.environmentDigest)));
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

async function readOperationLockContent(filename: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const content = await readFile(filename, 'utf8').catch(() => null);
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
