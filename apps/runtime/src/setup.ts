import { inspectCredentialStatus, loadOrCreateTunnelServiceSecret } from './credentials.js';
import { initializeConnectorRegistry, readConnectorRegistry, seedFromLegacyProfiles } from './connector-registry.js';
import type { Supervisor } from './supervisor.js';

export interface GuidedSetupOptions {
  /** Fresh installs may bind one public ONE IRIS tunnel; legacy bindings remain supported. */
  readonly unifiedTunnelId?: string;
  readonly fullTunnelId?: string;
  readonly proTunnelId?: string;
  readonly adminTunnelId?: string;
  readonly start: boolean;
  readonly json: boolean;
}

export async function guidedSetup(supervisor: Supervisor, dataRoot: string, options: GuidedSetupOptions): Promise<Record<string, unknown>> {
  if (process.platform !== 'darwin') throw new Error('IRIS setup is supported on macOS only');
  const credentials = await inspectCredentialStatus(dataRoot);
  const safeCredentials = {
    controlPlaneApiKeyPresent: credentials.controlPlaneApiKeyPresent,
    tunnelServicePresent: credentials.tunnelServicePresent,
    tunnelServiceGeneration: credentials.tunnelServiceGeneration,
    legacyMigrationRequired: credentials.legacy.migrationRequired,
  };
  if (!credentials.controlPlaneApiKeyPresent) {
    return {
      status: 'NEEDS_CREDENTIALS',
      credentials: safeCredentials,
      next: ['node scripts/iris.mjs credentials migrate <existing-profile-path>', 'node scripts/iris.mjs setup --one-tunnel-id <id>'],
      message: 'Provide the existing control-plane credential through the explicit migration command; no registry or runtime state was created.',
    };
  }

  const prepared = await supervisor.runSetupExclusive(() => prepareSetup(dataRoot, options));
  // A fresh ONE IRIS registry is publishable before Runtime activation; the
  // legacy status path requires FULL/PRO bindings and must not be used here.
  const status = options.start ? await supervisor.up() : await supervisor.status();
  return {
    status: options.start ? (status!.state === 'READY' ? 'READY' : 'NEEDS_ATTENTION') : 'READY_TO_START',
    repeated: prepared.repeated,
    machineId: prepared.registry.connectors[0]?.machineId ?? prepared.registry.admin?.machineId ?? null,
    connectors: prepared.registry.connectors.map(({ connectorId, tunnelId }) => ({ connectorId, tunnelId })),
    adminTunnelId: prepared.registry.admin?.tunnelId ?? null,
    credentials: {
      controlPlaneApiKeyPresent: prepared.credentials.controlPlaneApiKeyPresent,
      tunnelServicePresent: prepared.credentials.tunnelServicePresent,
      tunnelServiceGeneration: prepared.credentials.tunnelServiceGeneration,
      legacyMigrationRequired: prepared.credentials.legacy.migrationRequired,
    },
    local: status === null ? { stack: 'DEGRADED' } : { stack: status.state, runtime: status.runtime, tunnel: status.tunnel, controlPlane: status.controlPlane },
    next: options.start ? ['node scripts/iris.mjs doctor', 'node scripts/iris.mjs launchd install'] : ['node scripts/iris.mjs up', 'node scripts/iris.mjs doctor', 'node scripts/iris.mjs launchd install'],
    message: 'Remote tunnel provisioning and ChatGPT connector selection remain owner-verifiable steps; this command does not claim either occurred.',
  };
}

async function prepareSetup(dataRoot: string, options: GuidedSetupOptions): Promise<{
  readonly registry: NonNullable<Awaited<ReturnType<typeof readConnectorRegistry>>>;
  readonly repeated: boolean;
  readonly credentials: Awaited<ReturnType<typeof inspectCredentialStatus>>;
}> {
  let registry = await readConnectorRegistry(dataRoot);
  let repeated = registry !== null;
  if (registry === null) {
    const { unifiedTunnelId, fullTunnelId, proTunnelId, adminTunnelId } = options;
    registry = unifiedTunnelId !== undefined
      ? await initializeConnectorRegistry(dataRoot, { unified: true, fullTunnelId: unifiedTunnelId })
      : fullTunnelId === undefined && proTunnelId === undefined && adminTunnelId === undefined
      ? await seedFromLegacyProfiles(dataRoot)
      : await initializeConnectorRegistry(dataRoot, {
        fullTunnelId: requiredTunnelId(fullTunnelId),
        proTunnelId: requiredTunnelId(proTunnelId),
        ...(adminTunnelId === undefined ? {} : { adminTunnelId }),
      });
    repeated = false;
  } else {
    assertRequestedBindings(registry, options);
  }

  await loadOrCreateTunnelServiceSecret(dataRoot);
  return { registry, repeated, credentials: await inspectCredentialStatus(dataRoot) };
}

function requiredTunnelId(value: string | undefined): string {
  if (value === undefined) throw new Error(`Usage: iris setup --one-tunnel-id <id> | --full-tunnel-id <id> --pro-tunnel-id <id> [--admin-tunnel-id <id>] [--start] [--json]`);
  return value;
}

function assertRequestedBindings(registry: Awaited<ReturnType<typeof readConnectorRegistry>>, options: GuidedSetupOptions): void {
  if (registry === null) throw new Error('IRIS connector registry is not initialized');
  const unified = registry.connectors.length === 1 && registry.connectors[0]?.label === 'IRIS';
  if (options.unifiedTunnelId !== undefined) {
    if (!unified || registry.connectors[0]?.tunnelId !== options.unifiedTunnelId || registry.admin !== null) {
      throw new Error('Existing connector bindings do not match the requested setup identity');
    }
    return;
  }
  const full = registry.connectors.find((connector) => connector.connectorId === 'iris-full');
  const pro = registry.connectors.find((connector) => connector.connectorId === 'iris-pro');
  if ((options.fullTunnelId !== undefined && full?.tunnelId !== options.fullTunnelId)
    || (options.proTunnelId !== undefined && pro?.tunnelId !== options.proTunnelId)
    || (options.adminTunnelId !== undefined && registry.admin?.tunnelId !== options.adminTunnelId)) {
    throw new Error('Existing connector bindings do not match the requested setup identity');
  }
}

export function formatSetupOutput(result: Record<string, unknown>): string {
  const credentials = result.credentials as { controlPlaneApiKeyPresent?: boolean; tunnelServicePresent?: boolean } | undefined;
  const connectors = Array.isArray(result.connectors) ? result.connectors : [];
  const next = Array.isArray(result.next) ? result.next.filter((value): value is string => typeof value === 'string') : [];
  const local = result.local as { stack?: string } | undefined;
  const localRuntime = result.status === 'READY' ? 'Online' : result.status === 'NEEDS_ATTENTION' ? 'Needs Attention' : result.status === 'READY_TO_START' ? 'Offline (run iris up)' : 'Action Required';
  const credentialStatus = credentials?.controlPlaneApiKeyPresent && credentials.tunnelServicePresent ? 'Ready' : 'Action Required';
  const nextAction = next.length === 0 ? 'Inspect the setup result and ask the owner for the next authorized action.' : next.join(' → ');
  return [
    `IRIS_SETUP=${String(result.status ?? 'NEEDS_ATTENTION')}`,
    'Prerequisites  Ready (macOS, Node.js 24)',
    `Credentials    ${credentialStatus}`,
    `Bindings       ${connectors.length} workload connector(s)${result.adminTunnelId === null ? '' : ' + ADMIN'}`,
    `Local Runtime  ${localRuntime}${local?.stack === undefined ? '' : ` [${local.stack}]`}`,
    'ChatGPT        Not Verified',
    `Next Action    ${nextAction}`,
    typeof result.message === 'string' ? `Details        ${result.message}` : '',
    '',
  ].filter((line) => line.length > 0).join('\n');
}
