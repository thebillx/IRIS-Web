import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogToolNames } from './mcp-catalog.js';
import { fullMcpToolDefinitionsV21 } from './mcp-v21.js';
import { proMcpToolDefinitions } from './mcp.js';
import { FoundationStateStore, loadOrCreateRuntimeId } from './persistence.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { RuntimeState } from './state.js';
import {
  bindConnectorRuntime,
  connectorRegistryPath,
  initializeConnectorRegistry,
  inspectConnectorRegistry,
} from './connector-registry.js';
import { loadOrCreateMachineId, machineIdentityPath } from './machine-identity.js';
import { assessConnectorRegistryIdentity, assertTunnelBindingClaim } from './identity-coherence.js';
import { startDaemon } from './daemon.js';

const roots: string[] = [];
const FULL_TUNNEL_ID = `tunnel_${'a'.repeat(32)}`;
const PRO_TUNNEL_ID = `tunnel_${'b'.repeat(32)}`;

const LEGACY_FULL_TOOL_NAMES = [
  'runtime_status', 'list_projects', 'project_info', 'git_status', 'search', 'mission_list',
  'session_open', 'session_get', 'session_close', 'workspace_select', 'mission_list_waiting_supervisor',
  'mission_get', 'mission_events', 'mission_directive', 'mission_orchestrator_handoff', 'mission_create',
  'mission_state_set', 'mission_task_create', 'mission_task_state_set', 'mission_action_prepare',
  'mission_supervisor_gate_set', 'project_test_run', 'project_validation_run', 'project_validation_discover',
  'project_validation_start', 'project_validation_job', 'git_local', 'remote_publish', 'file_read', 'file_write',
  'file_edit', 'file_delete', 'directory_create', 'directory_delete', 'mission_start', 'mission_checkpoint',
  'mission_resume', 'mission_rebind', 'mission_cancel', 'mission_complete', 'mission_evidence', 'catalog_identity',
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('IRIS vNext Phase 1 identity and fencing', () => {
  it('persists a private machineId independently from runtime identity', async () => {
    const dataRoot = await temp('iris-machine-id-');
    const first = await loadOrCreateMachineId(dataRoot);
    const second = await loadOrCreateMachineId(dataRoot);
    const runtimeId = await loadOrCreateRuntimeId(dataRoot);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(runtimeId);
    expect(JSON.parse(await readFile(machineIdentityPath(dataRoot), 'utf8'))).toEqual({ schemaVersion: 1, machineId: first });
  });

  it('AC-IRIS-002 preserves machineId/runtimeId and changes instanceId across a controlled local restart with coherent binding', async () => {
    const dataRoot = await temp('iris-phase1-restart-');
    const first = await startDaemon({ dataRoot, preferredPort: 0 });
    const firstHealth = first.health();
    const firstMachineId = firstHealth.machineId;
    expect(firstHealth.identityState).toBe('UNBOUND');
    await first.close();

    const second = await startDaemon({ dataRoot, preferredPort: 0 });
    try {
      expect(second.health().machineId).toBe(firstMachineId);
      expect(second.identity.runtimeId).toBe(first.identity.runtimeId);
      expect(second.identity.instanceId).not.toBe(first.identity.instanceId);
      expect(second.health().identityState).toBe('UNBOUND');
    } finally {
      await second.close();
    }
  });

  it('AC-IRIS-003 fences a synthetic two-machine collision without evicting the existing owner', async () => {
    const dataRoot = await temp('iris-tunnel-collision-');
    const machineA = await loadOrCreateMachineId(dataRoot);
    await initializeConnectorRegistry(dataRoot, { fullTunnelId: FULL_TUNNEL_ID, proTunnelId: PRO_TUNNEL_ID });
    const bound = await bindConnectorRuntime(dataRoot, 'runtime-a', machineA);
    const beforeGeneration = bound.connectors[0]!.leaseGeneration;

    await expect(bindConnectorRuntime(dataRoot, 'runtime-a', '11111111-1111-4111-8111-111111111111'))
      .rejects.toMatchObject({ code: 'TUNNEL_OWNERSHIP_CONFLICT' });

    const after = (await inspectConnectorRegistry(dataRoot))!.registry;
    expect(after.connectors).toHaveLength(2);
    expect(after.connectors.every((connector) => connector.machineId === machineA)).toBe(true);
    expect(after.connectors[0]!.leaseGeneration).toBe(beforeGeneration);
  });

  it('AC-IRIS-004 / AC-IRIS-008 fail closed on split runtime/catalog and catalog hash/generation mismatch', async () => {
    const dataRoot = await temp('iris-split-identity-');
    const machineId = await loadOrCreateMachineId(dataRoot);
    await initializeConnectorRegistry(dataRoot, { fullTunnelId: FULL_TUNNEL_ID, proTunnelId: PRO_TUNNEL_ID });
    const registry = await bindConnectorRuntime(dataRoot, 'runtime-a', machineId);
    const connector = registry.connectors[0]!;
    const connectorProfile = connector.mode === 'FULL' ? 'FULL' as const : 'PRO' as const;

    expectClaimError(() => assertTunnelBindingClaim(connector, {
      machineId,
      runtimeId: 'runtime-b',
      instanceId: 'instance-b',
      tunnelId: connector.tunnelId,
      deploymentEpoch: connector.deploymentEpoch,
      catalogHash: connector.catalogHash,
      connectorProfile,
      leaseGeneration: connector.leaseGeneration,
    }), 'SPLIT_IDENTITY');

    expectClaimError(() => assertTunnelBindingClaim(connector, {
      machineId,
      runtimeId: connector.runtimeId!,
      instanceId: 'instance-a',
      tunnelId: connector.tunnelId,
      deploymentEpoch: connector.deploymentEpoch,
      catalogHash: 'sha256:deadbeef',
      connectorProfile,
      leaseGeneration: connector.leaseGeneration,
    }), 'SPLIT_IDENTITY');

    expectClaimError(() => assertTunnelBindingClaim(connector, {
      machineId,
      runtimeId: connector.runtimeId!,
      instanceId: 'instance-a',
      tunnelId: connector.tunnelId,
      deploymentEpoch: connector.deploymentEpoch,
      catalogHash: connector.catalogHash,
      connectorProfile,
      leaseGeneration: connector.leaseGeneration - 1,
    }), 'TUNNEL_OWNERSHIP_CONFLICT');

    expect(assessConnectorRegistryIdentity(registry, { machineId, runtimeId: 'runtime-b' }, []).state).toBe('SPLIT');
  });

  it('AC-IRIS-006 preserves every legacy FULL tool, adds Phase 2/3/4 grouped tools, and keeps PRO at the exact read-only five', () => {
    const fullNames = catalogToolNames('FULL');
    expect(fullNames).toHaveLength(48);
    for (const legacyName of LEGACY_FULL_TOOL_NAMES) expect(fullNames).toContain(legacyName);
    expect(fullNames.filter((name) => !LEGACY_FULL_TOOL_NAMES.includes(name as (typeof LEGACY_FULL_TOOL_NAMES)[number]))).toEqual(['workspace', 'fs', 'artifact', 'shell', 'job', 'git']);
    expect(fullMcpToolDefinitionsV21().map((definition) => definition.name)).toEqual(fullNames);
    expect(catalogToolNames('PRO')).toEqual(['list_projects', 'project_info', 'git_status', 'file_read', 'search']);
    expect(proMcpToolDefinitions().map((definition) => definition.name)).toEqual(catalogToolNames('PRO'));
  });

  it('marks daemon health failed instead of reporting READY when persisted connector identity is split', async () => {
    const dataRoot = await temp('iris-phase1-split-daemon-');
    const machineId = await loadOrCreateMachineId(dataRoot);
    const runtimeId = await loadOrCreateRuntimeId(dataRoot);
    await initializeConnectorRegistry(dataRoot, { fullTunnelId: FULL_TUNNEL_ID, proTunnelId: PRO_TUNNEL_ID });
    const registry = await bindConnectorRuntime(dataRoot, runtimeId, machineId);
    await writeFile(connectorRegistryPath(dataRoot), JSON.stringify({
      ...registry,
      connectors: registry.connectors.map((connector) => ({
        ...connector,
        runtimeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      })),
    }, null, 2), { mode: 0o600 });

    const daemon = await startDaemon({ dataRoot, preferredPort: 0 });
    try {
      expect(daemon.health()).toMatchObject({ status: 'failed', identityState: 'SPLIT', identityCode: 'SPLIT_IDENTITY' });
    } finally {
      await daemon.close();
    }
  });

  it('keeps Phase 1 permission behavior fail-closed under a resource registry-enabled CapabilityService', async () => {
    const dataRoot = await temp('iris-phase1-permission-registry-');
    const sourceRoot = await realpath(await temp('iris-phase1-permission-source-'));
    const projectRoot = path.join(sourceRoot, 'project-a');
    await mkdir(projectRoot);
    const store = new FoundationStateStore(dataRoot);
    const state = new RuntimeState(store);
    const project = await state.registerProject('Phase1 Permission Project', projectRoot);
    const session = state.createSession('phase1-client', 'phase1-agent', 'security');
    await state.setSessionCurrentProject(session.id, session.clientId, project.id);
    const settings = new PermissionSettingsStore(dataRoot);
    await settings.initialize();
    const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot);
    const audit = new PermissionAuditStore(dataRoot);
    const resources = new VNextResourceRegistry(state, dataRoot);
    const service = new CapabilityService(state, policy, audit, () => ({
      status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
      uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1,
      agentExecutorType: 'local-development-executor', productionModelConnected: false,
      apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
    }), undefined, resources);
    const target = path.join(projectRoot, 'phase1.txt');
    const denied = await service.execute({
      capabilityId: 'file.write', clientId: session.clientId, sessionId: session.id, projectId: project.id,
      targetPath: target, content: 'blocked', expectedEffects: ['WRITE'],
    });
    expect(denied).toMatchObject({ status: 'denied', reason: expect.stringContaining('EFFECT_MISMATCH') });
  });
});

function expectClaimError(operation: () => void, code: 'SPLIT_IDENTITY' | 'TUNNEL_OWNERSHIP_CONFLICT'): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
