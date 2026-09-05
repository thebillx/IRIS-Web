import { randomBytes, randomUUID } from 'node:crypto';
import { IRIS_PLATFORM, IRIS_VERSION, RuntimeError, type DoctorReport, type RuntimeHealth, type RuntimeIdentity } from '@iris/domain';
import { acquireRuntimeAuthority, probeRuntimeAuthority } from './authority.js';
import { ensureRuntimeDataRoot, resolveRuntimeDataRoot, resolveSourceRoot, RUNTIME_DATA_ENV, runtimeDataRootWritable } from './data-root.js';
import { PermissionAuditStore } from './audit.js';
import { createAgentExecutorFromEnvironment } from './agent-executor.js';
import { CapabilityService } from './capability-service.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore, loadOrCreateOwnerAccessSecret, loadOrCreateRuntimeId, removeEndpointIfInstance, removeRuntimeControlIfInstance, writeEndpoint, writeRuntimeControl } from './persistence.js';
import { startRuntimeServer, type RuntimeServerHandle } from './server.js';
import { RuntimeState } from './state.js';

export const DEFAULT_RUNTIME_PORT = 43_110;

export interface DaemonOptions {
  readonly dataRoot?: string;
  readonly preferredPort?: number;
}

export interface DaemonHandle {
  readonly identity: RuntimeIdentity;
  readonly dataRoot: string;
  readonly state: RuntimeState;
  readonly capabilities: CapabilityService;
  readonly apiUrl: string;
  readonly mcpUrl: string;
  health(): RuntimeHealth;
  doctor(): Promise<DoctorReport>;
  close(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  if (process.platform !== 'darwin') throw new Error('IRIS V0 local runtime is implemented for macOS only');
  const dataRoot = options.dataRoot === undefined
    ? await resolveRuntimeDataRoot()
    : await resolveRuntimeDataRoot({ ...process.env, [RUNTIME_DATA_ENV]: options.dataRoot });
  await ensureRuntimeDataRoot(dataRoot);

  const runtimeId = await loadOrCreateRuntimeId(dataRoot);
  const ownerAccessSecret = await loadOrCreateOwnerAccessSecret(dataRoot);
  const identity: RuntimeIdentity = {
    runtimeId,
    instanceId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    platform: IRIS_PLATFORM,
    version: IRIS_VERSION,
  };
  const authority = await acquireRuntimeAuthority(dataRoot, identity);
  let server: RuntimeServerHandle | undefined;
  let shuttingDown = false;
  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      shuttingDown = true;
      if (server !== undefined) await server.close();
      await removeEndpointIfInstance(dataRoot, identity.instanceId);
      await removeRuntimeControlIfInstance(dataRoot, identity.instanceId);
      await authority.release();
    })();
    return closePromise;
  };

  try {
    const store = new FoundationStateStore(dataRoot);
    const state = new RuntimeState(store, createAgentExecutorFromEnvironment(process.env));
    const permissionSettings = new PermissionSettingsStore(dataRoot);
    await permissionSettings.initialize();
    const sourceRoot = await resolveSourceRoot();
    const permissionPolicy = new PermissionPolicyEngine(state, permissionSettings, sourceRoot, dataRoot);
    const permissionAudit = new PermissionAuditStore(dataRoot);
    const controlSecret = randomBytes(32).toString('base64url');

    const health = (): RuntimeHealth => ({
      status: shuttingDown ? 'stopping' : 'ready',
      version: IRIS_VERSION,
      platform: IRIS_PLATFORM,
      runtimeId: identity.runtimeId,
      instanceId: identity.instanceId,
      pid: identity.pid,
      uptimeMs: Math.max(0, Date.now() - Date.parse(identity.startedAt)),
      authority: 'owned',
      connectedClients: state.listClients().filter((client) => client.connected).length,
      connectedSessions: state.listSessions().length,
      agentExecutorType: state.executorDescriptor().type,
      productionModelConnected: state.executorDescriptor().productionModelConnected,
      apiUrl: server?.apiUrl ?? '',
      mcpUrl: server?.mcpUrl ?? '',
    });

    const capabilities = new CapabilityService(state, permissionPolicy, permissionAudit, health);

    const doctor = async (): Promise<DoctorReport> => {
      const probe = await probeRuntimeAuthority(dataRoot);
      const authorityHealthy = probe.state === 'live' && sameIdentity(probe.identity, identity);
      const dataRootHealthy = await runtimeDataRootWritable(dataRoot);
      let registryHealthy = true;
      try { await store.read(); } catch { registryHealthy = false; }
      const apiHealthy = server !== undefined && isLoopbackUrl(server.apiUrl);
      const checks = [
        { code: 'RUNTIME_AUTHORITY', status: authorityHealthy ? 'pass' as const : 'fail' as const, message: authorityHealthy ? 'Authoritative daemon identity is current' : 'Runtime authority is not owned by this daemon' },
        { code: 'RUNTIME_DATA_ROOT', status: dataRootHealthy ? 'pass' as const : 'fail' as const, message: dataRootHealthy ? 'Runtime data root is private, readable, and writable' : 'Runtime data root is not secure and writable' },
        { code: 'API_LOOPBACK', status: apiHealthy ? 'pass' as const : 'fail' as const, message: apiHealthy ? 'API is bound to IPv4 loopback' : 'API is not bound to IPv4 loopback' },
        { code: 'PROJECT_REGISTRY', status: registryHealthy ? 'pass' as const : 'fail' as const, message: registryHealthy ? 'Project registry is readable' : 'Project registry is unreadable' },
        { code: 'DUPLICATE_AUTHORITY', status: authorityHealthy ? 'pass' as const : 'fail' as const, message: authorityHealthy ? 'No competing authority is observable' : 'Authority identity is ambiguous' },
      ];
      return { status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail', checks };
    };

    await store.read();
    server = await startRuntimeServer(
      {
        identity,
        state,
        capabilities,
        health,
        doctor,
        isShuttingDown: () => shuttingDown,
        controlSecret,
        ownerAccessSecret,
        requestShutdown: () => {
          void close().catch((error: unknown) => {
            process.stderr.write(`IRIS controlled shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
          });
        },
      },
      options.preferredPort ?? readPreferredPort(),
    );
    await writeRuntimeControl(dataRoot, { schemaVersion: 1, runtimeId, instanceId: identity.instanceId, secret: controlSecret });
    await writeEndpoint(dataRoot, {
      schemaVersion: 1,
      runtimeId,
      instanceId: identity.instanceId,
      pid: identity.pid,
      apiUrl: server.apiUrl,
      mcpUrl: server.mcpUrl,
      startedAt: identity.startedAt,
    });

    return {
      identity,
      dataRoot,
      state,
      capabilities,
      apiUrl: server.apiUrl,
      mcpUrl: server.mcpUrl,
      health,
      doctor,
      close,
    };
  } catch (error) {
    shuttingDown = true;
    if (server !== undefined) await server.close().catch(() => undefined);
    await removeEndpointIfInstance(dataRoot, identity.instanceId).catch(() => undefined);
    await removeRuntimeControlIfInstance(dataRoot, identity.instanceId).catch(() => undefined);
    await authority.release().catch(() => undefined);
    throw error;
  }
}

function readPreferredPort(): number {
  const raw = process.env.IRIS_RUNTIME_PORT?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_RUNTIME_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RuntimeError('PORT_UNAVAILABLE', 'IRIS_RUNTIME_PORT must be an integer from 0 through 65535');
  }
  return port;
}

function sameIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.runtimeId === right.runtimeId
    && left.instanceId === right.instanceId
    && left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.platform === right.platform
    && left.version === right.version;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}
