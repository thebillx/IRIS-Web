import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError, type RuntimeFailureCode } from '@iris/domain';
import { bindConnectorRuntime, readConnectorRegistry, reconcileConnectorRegistry, seedFromLegacyProfiles, type ConnectorBinding, type ConnectorRegistryDocument } from './connector-registry.js';
import { credentialPaths, inspectCredentialStatus, loadOrCreateTunnelServiceSecret, readTunnelServiceSecret, rotateTunnelServiceSecret, type CredentialStatus } from './credentials.js';
import { ensureRuntimeDataRoot, resolveRuntimeDataRoot, resolveSourceRoot } from './data-root.js';
import { observeProcessStart } from './macos-safety.js';
import { loadOrCreateRuntimeId, readEndpoint, readRuntimeControl, removeEndpointIfInstance, removeRuntimeControlIfInstance } from './persistence.js';
import { privateDirectoryProblem } from './private-fs.js';
import { runtimeStatus, startRuntime, stopRuntime, type RuntimeObservedStatus } from './lifecycle.js';
import { assertSupportedNodeVersion, canonicalNodeRuntime, node24Environment } from './node-runtime.js';

const execFileAsync = promisify(execFile);
const SUPERVISOR_DIRECTORY = 'supervisor';
const STATE_FILE = 'state.json';
const PROFILE_DIRECTORY = 'tunnel-profiles';
const LOG_DIRECTORY = 'logs';
const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_WINDOW_MS = 60_000;
const RECOVERY_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const DEFAULT_WEB_PORT = 5_173;
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
  readonly component: 'runtime' | 'web' | 'tunnel-full' | 'tunnel-pro' | 'supervisor';
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
}

interface RecoveryRecord {
  readonly attempts: number;
  readonly terminal: boolean;
  readonly lastFailureCode: string | null;
  readonly nextAttemptAt: string | null;
  readonly windowStartedAt: string | null;
}

interface SupervisorStateDocument {
  readonly schemaVersion: 2;
  readonly supervisorId: string;
  readonly updatedAt: string;
  readonly runtime: OwnedProcess | null;
  readonly web: OwnedProcess | null;
  readonly tunnels: { readonly full: OwnedProcess | null; readonly pro: OwnedProcess | null };
  readonly recovery: RecoveryRecord;
}

export interface SupervisorOptions {
  readonly dataRoot?: string;
  readonly sourceRoot?: string;
  readonly tunnelClientPath?: string;
  readonly webPort?: number;
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
}

export async function createSupervisor(options: SupervisorOptions = {}): Promise<Supervisor> {
  assertSupportedNodeVersion();
  const dataRoot = options.dataRoot === undefined
    ? await resolveRuntimeDataRoot()
    : await resolveRuntimeDataRoot({ ...process.env, IRIS_RUNTIME_DATA_ROOT: options.dataRoot });
  const sourceRoot = options.sourceRoot === undefined ? await resolveSourceRoot() : path.resolve(options.sourceRoot);
  return new Supervisor(dataRoot, sourceRoot, options.tunnelClientPath ?? DEFAULT_TUNNEL_CLIENT, options.webPort ?? DEFAULT_WEB_PORT);
}

export class Supervisor {
  public constructor(
    public readonly dataRoot: string,
    private readonly sourceRoot: string,
    private readonly tunnelClientPath: string,
    private readonly webPort: number,
  ) {}

  public async up(): Promise<SupervisorStackStatus> {
    await this.prepareDirectories();
    return this.withOperationLock('up', () => this.upUnlocked());
  }

  private async upUnlocked(): Promise<SupervisorStackStatus> {
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
    const started: Array<'runtime' | 'web' | 'full' | 'pro'> = [];
    try {
      const observed = await runtimeStatus(this.dataRoot);
      let runtimeReplaced = false;
      const runtimeNodeChanged = observed.state === 'running' && state.runtime !== null
        && !sameExecutablePath(state.runtime.executable, canonicalNodeRuntime().path);
      if (observed.state === 'running' && !registryChanged && !runtimeNodeChanged) {
        if (state.runtime === null) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'A running IRIS runtime is not owned by this supervisor; use explicit runtime adoption or stop it through its existing owner');
        assertRuntimeOwnership(state.runtime, observed);
        await assertOwnedRuntimeProcess(state.runtime);
        const upgraded = await runtimeRecordFromObserved(observed.endpoint!, this.sourceRoot);
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
          await this.retireStaleRuntimeMetadata(observed);
        }
        const startedRuntime = await startRuntime({ dataRoot: this.dataRoot });
        if (startedRuntime.endpoint === null) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'IRIS runtime started without an endpoint descriptor');
        const replacement = await runtimeRecordFromObserved(startedRuntime.endpoint, this.sourceRoot);
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
        state = { ...state, runtime: await runtimeRecordFromObserved(runtime.endpoint, this.sourceRoot) };
        await this.writeState(state);
      }

      const profiles = await this.writeManagedProfiles(boundRegistry, runtime.endpoint.apiUrl);
      state = await this.ensureWeb(state, runtime.endpoint.apiUrl, started);
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
    if (state.runtime !== null) {
      if (observed.state === 'running') {
        assertRuntimeOwnership(state.runtime, observed);
        await stopRuntime(this.dataRoot);
      } else {
        await this.retireRuntime(state.runtime, observed);
      }
    }
    const cleared = emptyState(state.supervisorId);
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
      : failedLayer === 'L2_TUNNEL' ? status.tunnel.code
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

  public async logs(): Promise<string> {
    const filenames = [path.join(this.logDirectory(), 'supervisor.log'), path.join(this.logDirectory(), 'iris-full-tunnel.log'), path.join(this.logDirectory(), 'iris-pro-tunnel.log')];
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
    if (!(await commandLooksLikeIris(observed.endpoint.pid, this.sourceRoot))) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Runtime process identity could not be verified against this checkout');
    const state = await this.readState();
    if (state.runtime !== null) return this.status();
    await this.writeState({ ...state, runtime: await runtimeRecordFromObserved(observed.endpoint, this.sourceRoot) });
    return this.status();
  }

  public async runSupervisorDaemon(): Promise<void> {
    await this.prepareDirectories();
    const persisted = await this.readState();
    if (persisted.recovery.terminal) {
      throw new RuntimeError('RECOVERY_EXHAUSTED', 'Automatic supervisor recovery is suspended after the restart budget was exhausted');
    }
    await this.up();
    const state = await this.readState();
    if (state.recovery.windowStartedAt !== null && recoveryWindowExpired(state.recovery)) {
      await this.writeState({ ...state, recovery: emptyRecovery() });
    }
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      while (!stopping) {
        await delay(5_000);
        if (stopping) break;
        await this.withOperationLock('automatic-recovery', () => this.monitorOnceUnlocked());
      }
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await this.down();
    }
  }

  public async localReadiness(): Promise<LocalReadinessResult> {
    const registry = await readConnectorRegistry(this.dataRoot);
    const credentials = await readTunnelServiceSecret(this.dataRoot);
    const observed = await runtimeStatus(this.dataRoot);
    if (registry === null || credentials === null || observed.state !== 'running' || observed.endpoint === null) {
      return { status: layer('FAILED', registry === null ? 'MIGRATION_REQUIRED' : credentials === null ? 'CREDENTIAL_MISSING' : 'LOCAL_MCP_AUTH_FAILED', 'Local runtime prerequisites are not ready'), connectors: [] };
    }
    return probeLocalRuntime(observed.endpoint.apiUrl, credentials, registry);
  }

  private async monitorOnceUnlocked(): Promise<void> {
    const current = await this.status();
    if (current.runtime.state === 'READY' && current.tunnel.state === 'READY' && current.localRuntime.state === 'READY') {
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
    const tunnelResults = await Promise.all([
      this.probeTunnel(state.tunnels.full, registry.connectors.find((connector) => connector.connectorId === 'iris-full') ?? null),
      this.probeTunnel(state.tunnels.pro, registry.connectors.find((connector) => connector.connectorId === 'iris-pro') ?? null),
    ]);
    const tunnelLayer = tunnelResults.every((result) => result.state === 'READY') ? layer('READY', 'READY', 'FULL and PRO tunnel clients are healthy') : combineLayers(tunnelResults, 'TUNNEL_NOT_RUNNING', 'One or more supervisor-owned tunnel clients is not ready');
    const local = runtimeLayer.state === 'READY' ? await this.localReadiness() : { status: layer('FAILED', 'LOCAL_MCP_AUTH_FAILED', 'L1 requires a ready runtime'), connectors: [] };
    const controlPlane = tunnelResults.every((result) => result.state === 'READY') ? layer('READY', 'READY', 'Control-plane clients are running with healthy local readiness') : combineLayers(tunnelResults, 'CONTROL_PLANE_UNREACHABLE', 'Control-plane readiness is not proven for every connector');
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

  private async retireStaleRuntimeMetadata(observed: RuntimeObservedStatus): Promise<void> {
    if (observed.state !== 'stale') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime metadata is not proven stale');
    if (observed.endpoint !== null) {
      await this.retireRuntime(await runtimeRecordFromObserved(observed.endpoint, this.sourceRoot), observed);
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
    const existing = await readConnectorRegistry(this.dataRoot);
    if (existing === null) await seedFromLegacyProfiles(this.dataRoot);
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

  private async ensureWeb(state: SupervisorStateDocument, runtimeUrl: string, started: Array<'runtime' | 'web' | 'full' | 'pro'>): Promise<SupervisorStateDocument> {
    if (state.web !== null) {
      const inspected = await inspectProcess(state.web);
      if (inspected === 'ambiguous') throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Web process identity changed');
      if (inspected === 'running' && await endpointResponds(`http://127.0.0.1:${this.webPort}/`)) return state;
      if (inspected === 'running') await stopOwnedProcess(state.web);
    }
    const executable = path.join(this.sourceRoot, 'apps/web/node_modules/.bin/vite');
    if (!existsSync(executable)) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'Web executable is unavailable; run pnpm install before iris up');
    if (await endpointResponds(`http://127.0.0.1:${this.webPort}/`)) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `Web port ${this.webPort} is occupied by an unowned process`);
    const record = await spawnManaged('web', executable, ['--host', '127.0.0.1', '--port', String(this.webPort)], path.join(this.sourceRoot, 'apps/web'), { IRIS_RUNTIME_URL: runtimeUrl }, null, this.logDirectory(), 'vite');
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
    started: Array<'runtime' | 'web' | 'full' | 'pro'>,
    runtimeReplaced: boolean,
  ): Promise<SupervisorStateDocument> {
    const current = state.tunnels[profile];
    const binding = registry.connectors.find((connector) => connector.connectorId === (profile === 'full' ? 'iris-full' : 'iris-pro'));
    if (binding === undefined) throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', `Missing ${profile} connector binding`);
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
    const record = await spawnManaged(`tunnel-${profile}`, executable, ['run', '--profile-file', profilePath, '--pid.file', pidFile], this.sourceRoot, {}, profilePath, this.logDirectory(), 'tunnel-client', binding.tunnelId, registry.deploymentEpoch, runtimeInstanceId, binding.runtimeId);
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

  private async writeManagedProfiles(registry: ConnectorRegistryDocument, runtimeApiUrl: string): Promise<{ readonly full: string; readonly pro: string }> {
    const credentials = credentialPaths(this.dataRoot);
    const full = registry.connectors.find((connector) => connector.connectorId === 'iris-full');
    const pro = registry.connectors.find((connector) => connector.connectorId === 'iris-pro');
    if (full === undefined || pro === undefined) throw new RuntimeError('CONNECTOR_BINDING_MISMATCH', 'FULL and PRO connector bindings are required');
    const fullPath = full.managedProfilePath;
    const proPath = pro.managedProfilePath;
    await writePrivateText(fullPath, managedProfile(full, credentials.controlPlaneApiKey, credentials.tunnelServiceAuthorization, this.logDirectory(), registry.deploymentEpoch, runtimeApiUrl));
    await writePrivateText(proPath, managedProfile(pro, credentials.controlPlaneApiKey, credentials.tunnelServiceAuthorization, this.logDirectory(), registry.deploymentEpoch, runtimeApiUrl));
    return { full: fullPath, pro: proPath };
  }

  private async rollbackStarted(started: readonly ('runtime' | 'web' | 'full' | 'pro')[]): Promise<void> {
    let state = await this.readState();
    if (started.includes('pro')) {
      await this.stopTunnel(state.tunnels.pro);
      state = { ...state, tunnels: { ...state.tunnels, pro: null } };
    }
    if (started.includes('full')) {
      await this.stopTunnel(state.tunnels.full);
      state = { ...state, tunnels: { ...state.tunnels, full: null } };
    }
    if (started.includes('web')) {
      await this.stopWeb(state.web);
      state = { ...state, web: null };
    }
    if (started.includes('runtime')) {
      await stopRuntime(this.dataRoot);
      state = { ...state, runtime: null };
    }
    await this.writeState(state);
  }

  private async stopTunnel(record: OwnedProcess | null): Promise<void> {
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
    if (content === null) return emptyState(`${os.hostname()}-${process.pid}`);
    try {
      const value = JSON.parse(content) as unknown;
      if (!isState(value)) throw new Error('invalid supervisor state');
      return {
        ...value,
        schemaVersion: 2,
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

function managedProfile(binding: ConnectorBinding, controlPlaneKey: string, tunnelServiceAuthorization: string, logDirectory: string, epoch: number, runtimeApiUrl: string): string {
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
    '  extra_headers:',
    headers,
    '  discovery_extra_headers:',
    headers,
    '',
  ].join('\n');
}

async function probeLocalRuntime(apiUrl: string, serviceSecret: string, registry: ConnectorRegistryDocument): Promise<LocalReadinessResult> {
  const connectors: ConnectorStatus[] = [];
  for (const binding of registry.connectors) {
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
      connectors.push(connectorStatus(binding, undefined, layer('FAILED', discovered === null ? 'LOCAL_MCP_AUTH_FAILED' : 'RUNTIME_IDENTITY_MISMATCH', 'Authenticated MCP discovery did not match the expected protocol')));
      continue;
    }
    const listed = await postJson(`${apiUrl}${binding.mcpPath}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...headers, 'MCP-Protocol-Version': '2026-07-28' });
    const names = toolNames(listed);
    const expected = [...binding.expectedToolNames];
    const matches = names.length === expected.length && names.every((name, index) => name === expected[index]);
    connectors.push(connectorStatus(binding, undefined, matches ? layer('READY', 'READY', `${binding.label} authenticated discovery and tool profile match`) : layer('FAILED', 'CONNECTOR_BINDING_MISMATCH', `${binding.label} tool profile does not match the registry`)));
  }
  const status = connectors.every((connector) => connector.state === 'READY') ? layer('READY', 'READY', 'Authenticated local MCP discovery and tool profiles are healthy') : layer('FAILED', connectors.some((connector) => connector.code === 'LOCAL_MCP_AUTH_FAILED') ? 'LOCAL_MCP_AUTH_FAILED' : 'CONNECTOR_BINDING_MISMATCH', 'One or more authenticated local MCP profiles failed readiness');
  return { status, connectors };
}

function connectorStatus(binding: ConnectorBinding, local: ConnectorStatus | undefined, tunnel: LayerStatus): ConnectorStatus {
    const chosen = local === undefined ? tunnel : local.state === 'READY' && tunnel.state === 'READY' ? local : layer('FAILED', local.code !== 'READY' ? local.code : tunnel.code, `${binding.label} is not ready`);
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

async function spawnManaged(
  component: OwnedProcess['component'], executable: string, args: readonly string[], cwd: string,
  extraEnvironment: Record<string, string>, profilePath: string | null, logDirectory: string, marker: string,
  tunnelId: string | null = null, deploymentEpoch: number | null = null, instanceId: string | null = null, runtimeId: string | null = null,
): Promise<OwnedProcess> {
  const logFilename = path.join(logDirectory, component === 'web' ? 'supervisor.log' : `${component}.log`);
  const output = openSync(logFilename, 'a', 0o600);
  const environment = node24Environment({ HOME: process.env.HOME ?? os.homedir(), TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: process.env.LANG ?? 'en_US.UTF-8' }, extraEnvironment);
  const child = spawn(executable, [...args], { cwd, env: environment, detached: true, stdio: ['ignore', output, output] });
  closeSync(output);
  const pid = child.pid;
  child.on('error', () => undefined);
  if (pid === undefined || pid <= 0) throw new RuntimeError('SUPERVISOR_NOT_RUNNING', `Could not start ${component}`);
  child.unref();
  const processStartTimeMs = await waitForProcessStartTime(pid, 2_000);
  if (processStartTimeMs === null) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `${component} process start identity could not be verified`);
  return { component, pid, startedAt: new Date().toISOString(), executable: path.resolve(executable), profilePath, tunnelId, marker, processStartTimeMs, deploymentEpoch, instanceId, runtimeId };
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
  if (record.pid <= 0 || record.pid === process.pid) return 'ambiguous';
  try { process.kill(record.pid, 0); } catch (error) { return isMissingProcess(error) ? 'stopped' : 'ambiguous'; }
  const command = await commandForPid(record.pid);
  if (command === null) return 'ambiguous';
  const markerMatches = record.component === 'runtime'
    ? commandIncludesPath(command, record.marker) && commandIncludesPath(command, record.executable)
    : record.component === 'tunnel-full' || record.component === 'tunnel-pro'
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

function emptyState(supervisorId: string): SupervisorStateDocument {
  return { schemaVersion: 2, supervisorId, updatedAt: new Date().toISOString(), runtime: null, web: null, tunnels: { full: null, pro: null }, recovery: emptyRecovery() };
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

function failureCode(status: SupervisorStackStatus): string { return status.localRuntime.code !== 'READY' ? status.localRuntime.code : status.tunnel.code !== 'READY' ? status.tunnel.code : status.runtime.code; }

function actionForCode(code: string): string {
  if (code === 'MIGRATION_REQUIRED' || code === 'CREDENTIAL_MISSING') return 'MIGRATE_PERSISTENT_CREDENTIALS';
  if (code === 'CREDENTIAL_INVALID') return 'REPAIR_PRIVATE_CREDENTIAL_FILE';
  if (code === 'PROCESS_OWNERSHIP_AMBIGUOUS') return 'STOP_OR_ADOPT_ONLY_AFTER_IDENTITY_VERIFICATION';
  if (code === 'CONNECTOR_BINDING_MISMATCH' || code === 'CONNECTOR_MANIFEST_STALE') return 'REGENERATE_MANAGED_PROFILES';
  if (code === 'LOCAL_MCP_AUTH_FAILED') return 'CHECK_TUNNEL_SERVICE_CREDENTIAL_AND_RUNTIME_RESTART';
  if (code === 'E2E_PROBE_UNAVAILABLE') return 'CONFIGURE_A_SAFE_REMOTE_PROBE_OR_VALIDATE_FROM_CHATGPT';
  return 'RUN_IRIS_STATUS_AND_INSPECT_CONTROLLED_LOGS';
}

function runtimeErrorCode(error: unknown): RuntimeFailureCode { return error instanceof RuntimeError ? error.code : 'SUPERVISOR_NOT_RUNNING'; }

function isMissingProcess(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'; }

function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'; }

function isState(value: unknown): value is SupervisorStateDocument {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || typeof value.supervisorId !== 'string' || !isRecord(value.tunnels)) return false;
  if (value.recovery !== undefined && !isRecord(value.recovery)) return false;
  return (value.runtime === null || isOwnedProcess(value.runtime)) && (value.web === null || isOwnedProcess(value.web))
    && (value.tunnels.full === null || isOwnedProcess(value.tunnels.full)) && (value.tunnels.pro === null || isOwnedProcess(value.tunnels.pro))
    && (value.recovery === undefined || (isNonNegativeSafeInteger(value.recovery.attempts) && typeof value.recovery.terminal === 'boolean'
      && (value.recovery.lastFailureCode === null || typeof value.recovery.lastFailureCode === 'string')
      && (value.recovery.nextAttemptAt === null || typeof value.recovery.nextAttemptAt === 'string')
      && (value.recovery.windowStartedAt === undefined || value.recovery.windowStartedAt === null || typeof value.recovery.windowStartedAt === 'string')));
}

function isOwnedProcess(value: unknown): value is OwnedProcess {
  return isRecord(value) && (value.component === 'runtime' || value.component === 'web' || value.component === 'tunnel-full' || value.component === 'tunnel-pro' || value.component === 'supervisor')
    && isPositiveSafeInteger(value.pid) && typeof value.startedAt === 'string' && typeof value.executable === 'string'
    && (value.profilePath === null || typeof value.profilePath === 'string') && (value.tunnelId === null || typeof value.tunnelId === 'string') && typeof value.marker === 'string'
    && (value.processStartTimeMs === undefined || value.processStartTimeMs === null || isNonNegativeSafeInteger(value.processStartTimeMs))
    && (value.runtimeId === undefined || value.runtimeId === null || typeof value.runtimeId === 'string')
    && (value.instanceId === undefined || value.instanceId === null || typeof value.instanceId === 'string')
    && (value.deploymentEpoch === undefined || value.deploymentEpoch === null || isPositiveSafeInteger(value.deploymentEpoch));
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
    try {
      const handle = await open(filename, 'wx', 0o600);
      try {
        const processStart = observeProcessStart(process.pid);
        if (processStart.state !== 'live') throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor process start identity could not be measured safely');
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString(), operation, processStartMarker: processStart.marker } satisfies SupervisorOperationLock)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => { await rm(filename, { force: true }); };
    } catch (error) {
      if (!isAlreadyExists(error)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor operation lock could not be created', { cause: error });
      const content = await readFile(filename, 'utf8').catch(() => null);
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
