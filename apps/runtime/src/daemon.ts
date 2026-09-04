import { randomBytes, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  IRIS_PLATFORM,
  IRIS_VERSION,
  RuntimeError,
  type DoctorReport,
  type RuntimeHealth,
  type RuntimeIdentity,
} from '@iris/domain';
import { acquireRuntimeAuthority, probeRuntimeAuthority } from './authority.js';
import {
  ensureRuntimeDataRoot,
  resolveRuntimeDataRoot,
  RUNTIME_DATA_ENV,
  runtimeDataRootWritable,
} from './data-root.js';
import {
  FoundationStateStore,
  loadOrCreateRuntimeId,
  removeEndpointIfInstance,
  writeEndpoint,
} from './persistence.js';
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
  const identity: RuntimeIdentity = {
    runtimeId,
    instanceId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    platform: IRIS_PLATFORM,
    version: IRIS_VERSION,
  };
  const authority = await acquireRuntimeAuthority(dataRoot, identity);
  const store = new FoundationStateStore(dataRoot);
  const state = new RuntimeState(store);
  const controlToken = randomBytes(32).toString('base64url');
  let shuttingDown = false;
  let server: RuntimeServerHandle | undefined;
  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      shuttingDown = true;
      if (server !== undefined) await server.close();
      await removeEndpointIfInstance(dataRoot, identity.instanceId);
      await authority.release();
    })();
    return closePromise;
  };

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
    apiUrl: server?.apiUrl ?? '',
    mcpUrl: server?.mcpUrl ?? '',
  });

  const doctor = async (): Promise<DoctorReport> => {
    const probe = await probeRuntimeAuthority(dataRoot);
    const authorityHealthy = probe.state === 'live'
      && probe.identity.instanceId === identity.instanceId
      && probe.identity.runtimeId === identity.runtimeId;
    const dataRootHealthy = await runtimeDataRootWritable(dataRoot);
    let registryHealthy = true;
    try {
      await store.read();
    } catch {
      registryHealthy = false;
    }
    const apiHealthy = server?.apiUrl.startsWith('http://127.0.0.1:') === true;
    const checks = [
      {
        code: 'RUNTIME_AUTHORITY',
        status: authorityHealthy ? 'pass' as const : 'fail' as const,
        message: authorityHealthy ? 'Authoritative daemon identity is current' : 'Runtime authority is not owned by this daemon',
      },
      {
        code: 'RUNTIME_DATA_ROOT',
        status: dataRootHealthy ? 'pass' as const : 'fail' as const,
        message: dataRootHealthy ? 'Runtime data root is readable and writable' : 'Runtime data root is not writable',
      },
      {
        code: 'API_LOOPBACK',
        status: apiHealthy ? 'pass' as const : 'fail' as const,
        message: apiHealthy ? 'API is bound to IPv4 loopback' : 'API is not bound to IPv4 loopback',
      },
      {
        code: 'PROJECT_REGISTRY',
        status: registryHealthy ? 'pass' as const : 'fail' as const,
        message: registryHealthy ? 'Project registry is readable' : 'Project registry is unreadable',
      },
      {
        code: 'DUPLICATE_AUTHORITY',
        status: authorityHealthy ? 'pass' as const : 'fail' as const,
        message: authorityHealthy ? 'No competing authority is observable' : 'Authority identity is ambiguous',
      },
    ];
    return { status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail', checks };
  };

  try {
    server = await startRuntimeServer({
      identity,
      state,
      health,
      doctor,
      isShuttingDown: () => shuttingDown,
      controlToken,
      requestShutdown: () => {
        void close().catch((error: unknown) => {
          process.stderr.write(`IRIS controlled shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exitCode = 1;
        });
      },
    }, options.preferredPort ?? readPreferredPort());
    await writeEndpoint(dataRoot, {
      schemaVersion: 1,
      runtimeId,
      instanceId: identity.instanceId,
      pid: identity.pid,
      apiUrl: server.apiUrl,
      mcpUrl: server.mcpUrl,
      startedAt: identity.startedAt,
      controlToken,
    });
  } catch (error) {
    if (server !== undefined) await server.close().catch(() => undefined);
    await removeEndpointIfInstance(dataRoot, identity.instanceId).catch(() => undefined);
    await authority.release().catch(() => undefined);
    throw error;
  }

  return {
    identity,
    dataRoot,
    state,
    apiUrl: server.apiUrl,
    mcpUrl: server.mcpUrl,
    health,
    doctor,
    close,
  };
}

export async function runtimeFoundationReadable(dataRoot: string): Promise<boolean> {
  try {
    await access(path.join(dataRoot, 'runtime-id.json'));
    return true;
  } catch {
    return false;
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
