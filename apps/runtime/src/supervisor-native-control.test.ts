import { loadOrCreateOwnerAccessSecret } from './persistence.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeError } from '@iris/domain';
import { catalogToolNames } from './mcp-catalog.js';
import { loadOrCreateTunnelServiceSecret, persistControlPlaneApiKey } from './credentials.js';
import { MCP_PROTOCOL_VERSION, TUNNEL_CLIENT_MCP_PROTOCOL_VERSION } from './mcp.js';
import {
  startSupervisorNativeControlServer,
  type AdminRecycleInput,
  type AdminTunnelRecycleInput,
  type SupervisorNativeOperations,
} from './supervisor-native-control.js';
import { adminToolDefinitions, type SupervisorAdminToolCallResult } from './supervisor-admin.js';
import { fullMcpToolDefinitionsV21 } from './mcp-v21.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('outer supervisor native control', () => {
  it('implements the authenticated tunnel-client initialize handshake without widening native tools', async () => {
    const harness = await startHarness();
    const initialize = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: TUNNEL_CLIENT_MCP_PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: 'tunnel-client', version: '0.0.12' },
      },
    };
    try {
      const accepted = await postRpc(harness, initialize);
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toMatchObject({ result: {
        protocolVersion: TUNNEL_CLIENT_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'IRIS Native Supervisor Control', version: '0.0.0' },
      } });

      const initialized = await postRpc(harness, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, {
        'MCP-Protocol-Version': TUNNEL_CLIENT_MCP_PROTOCOL_VERSION,
      });
      expect(initialized.status).toBe(202);

      const listed = await rpc(harness, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, {
        'MCP-Protocol-Version': TUNNEL_CLIENT_MCP_PROTOCOL_VERSION,
        'Mcp-Method': 'tools/list',
      });
      expect(toolNames(listed)).toEqual([
        'supervisor_status', 'supervisor_doctor', 'runtime_status', 'runtime_on', 'runtime_off', 'runtime_restart', 'runtime_restart_status', 'keep_awake_status', 'keep_awake_set', 'workload_mutation_status', 'list_projects', 'project_info', 'admin_status', 'runtime_reconcile', 'admin_recycle', 'admin_tunnel_recycle',
        'activation_status', 'activation_prepare', 'activation_apply', 'activation_confirm', 'activation_rollback',
      ]);
      expect(catalogToolNames('FULL')).not.toContain('admin_tunnel_recycle');
      expect(catalogToolNames('PRO')).not.toContain('admin_tunnel_recycle');
      expect(adminToolDefinitions().map((tool) => tool.name)).not.toContain('admin_tunnel_recycle');

      const unsupported = await postRpc(harness, {
        ...initialize,
        id: 3,
        params: { ...initialize.params, protocolVersion: '2099-01-01' },
      });
      expect(unsupported.status).toBe(400);
      await expect(unsupported.json()).resolves.toMatchObject({ error: { code: -32602 } });

      const malformed = await postRpc(harness, {
        jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: TUNNEL_CLIENT_MCP_PROTOCOL_VERSION },
      });
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toMatchObject({ error: { code: -32602 } });

      const mismatchedMethod = await postRpc(harness, initialize, { 'Mcp-Method': 'tools/list' });
      expect(mismatchedMethod.status).toBe(400);
      await expect(mismatchedMethod.json()).resolves.toMatchObject({ error: { code: -32600 } });

      const unauthenticated = await postRpc(harness, initialize, {}, false);
      expect(unauthenticated.status).toBe(401);
    } finally {
      await harness.server.close();
    }
  });

  it('requires authentication and exposes only bounded supervisor/admin plus activation lifecycle operations', async () => {
    const harness = await startHarness();
    try {
      expect((await fetch(harness.server.healthUrl)).status).toBe(401);
      const health = await fetch(harness.server.healthUrl, { headers: { authorization: `Bearer ${harness.secret}` } });
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({ ok: true, owner: 'OUTER_SUPERVISOR_DAEMON' });
      const protectedResourceMetadata = await fetch(`${harness.server.mcpUrl.replace('/mcp', '')}/.well-known/oauth-protected-resource/mcp`);
      const authorizationMetadata = await fetch(`${harness.server.mcpUrl.replace('/mcp', '')}/.well-known/oauth-authorization-server`);
      expect(protectedResourceMetadata.status).toBe(404);
      expect(authorizationMetadata.status).toBe(404);
      await expect(protectedResourceMetadata.text()).resolves.toBe('');
      await expect(authorizationMetadata.text()).resolves.toBe('');

      const listed = await rpc(harness, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(toolNames(listed)).toEqual([
        'supervisor_status',
        'supervisor_doctor',
        'runtime_status',
        'runtime_on',
        'runtime_off', 'runtime_restart', 'runtime_restart_status',
        'keep_awake_status',
        'keep_awake_set',
        'workload_mutation_status',
        'list_projects',
        'project_info',
        'admin_status',
        'runtime_reconcile',
        'admin_recycle',
        'admin_tunnel_recycle',
        'activation_status',
        'activation_prepare',
        'activation_apply',
        'activation_confirm',
        'activation_rollback',
      ]);
      for (const name of ['supervisor_status', 'supervisor_doctor', 'runtime_on', 'runtime_off', 'runtime_restart', 'runtime_restart_status', 'admin_status', 'runtime_reconcile', 'admin_recycle', 'admin_tunnel_recycle']) {
        expect(catalogToolNames('FULL')).not.toContain(name);
        expect(catalogToolNames('PRO')).not.toContain(name);
      }
      for (const name of ['supervisor_status', 'supervisor_doctor', 'runtime_reconcile', 'admin_recycle', 'admin_tunnel_recycle']) {
        expect(adminToolDefinitions().map((tool) => tool.name)).not.toContain(name);
      }
      expect(adminToolDefinitions().map((tool) => tool.name)).toContain('admin_status');
      expect(structured(await rpcTool(harness, 'supervisor_status', {}))).toMatchObject({ supervisor: 'outer', workloadRuntimeId: 'runtime-a' });
      expect(structured(await rpcTool(harness, 'runtime_status', {}))).toMatchObject({ state: 'stopped', workloadOnly: true });
      expect(toolError(await rpcTool(harness, 'runtime_on', {}))).toMatchObject({ code: 'CONTROL_DENIED' });
      const ownerHeaders = { authorization: `Bearer ${harness.ownerSecret}` };
      expect(structured(await rpcTool(harness, 'runtime_on', {}, ownerHeaders))).toMatchObject({ state: 'RUNNING', workloadOnly: true });
      expect(structured(await rpcTool(harness, 'runtime_off', {}, ownerHeaders))).toMatchObject({ state: 'STOPPED', workloadOnly: true });
      const restartId = randomUUID();
      const uiOwnerHeaders = { authorization: `Bearer ${harness.ownerAccessSecret}` };
      expect(toolError(await rpcTool(harness, 'runtime_restart', { requestId: restartId }))).toMatchObject({ code: 'INVALID_REQUEST' });
      expect(toolError(await rpcTool(harness, 'runtime_restart', { requestId: 'invalid' }, uiOwnerHeaders))).toMatchObject({ code: 'INVALID_REQUEST' });
      expect(structured(await rpcTool(harness, 'runtime_restart', { requestId: restartId }, uiOwnerHeaders))).toMatchObject({ requestId: restartId, state: 'RUNNING', workloadOnly: true });
      expect(toolError(await rpcTool(harness, 'runtime_restart_status', { requestId: restartId }))).toMatchObject({ code: 'CONTROL_DENIED' });
      expect(structured(await rpcTool(harness, 'runtime_restart_status', { requestId: restartId, reconcile: true }, uiOwnerHeaders))).toMatchObject({ state: 'FAILED', workloadOnly: true });
      expect(structured(await rpcTool(harness, 'keep_awake_status', {}))).toMatchObject({ preferenceEnabled: true, observed: 'ACTIVE' });
      expect(toolError(await rpcTool(harness, 'keep_awake_set', { enabled: false }))).toMatchObject({ code: 'CONTROL_DENIED' });
      expect(toolError(await rpcTool(harness, 'keep_awake_set', { enabled: 'false' }, ownerHeaders))).toMatchObject({ code: 'INVALID_REQUEST' });
      expect(structured(await rpcTool(harness, 'keep_awake_set', { enabled: false }, ownerHeaders))).toMatchObject({ preferenceEnabled: false, observed: 'INACTIVE' });
      expect(structured(await rpcTool(harness, 'list_projects', {}))).toMatchObject({ defaultProjectId: null, projects: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Project', rootPath: '/tmp/project-a' }] });
      expect(structured(await rpcTool(harness, 'project_info', { projectId: '11111111-1111-4111-8111-111111111111' }))).toEqual({ id: '11111111-1111-4111-8111-111111111111', name: 'Project', rootPath: '/tmp/project-a' });
      expect(toolError(await rpcTool(harness, 'project_info', { projectId: '../escape' }))).toMatchObject({ code: 'INVALID_REQUEST' });
      expect(structured(await rpcTool(harness, 'admin_status', {}))).toMatchObject({ adminIdentity: 'admin-a' });
      expect(structured(await rpcTool(harness, 'runtime_reconcile', {}))).toMatchObject({ readiness: 'READY', workloadAnchorsPreserved: true });
      expect(structured(await rpcTool(harness, 'activation_status', {}))).toMatchObject({ proxied: 'activation_status' });
    } finally {
      await harness.server.close();
    }
  });

  it('rejects arbitrary operation and arbitrary PID/process/service/path authority', async () => {
    const harness = await startHarness();
    try {
      const unknown = await rpc(harness, {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'exec', arguments: {} },
      });
      expect(isRecord(unknown.error) ? unknown.error.code : null).toBe(-32601);

      for (const [key, value] of Object.entries({
        pid: 1234,
        executable: '/bin/kill',
        argv: ['anything'],
        service: 'arbitrary-service',
        process: 'launchd',
        path: '/tmp/escape',
        target: 'arbitrary-target',
        sourceRoot: '/tmp/escape',
      })) {
        const response = await rpcTool(harness, 'admin_recycle', { [key]: value });
        expect(toolError(response)).toMatchObject({ code: 'INVALID_REQUEST' });
        const adminTunnelResponse = await rpcTool(harness, 'admin_tunnel_recycle', { [key]: value });
        expect(toolError(adminTunnelResponse)).toMatchObject({ code: 'INVALID_REQUEST' });
      }
      expect(harness.recycleInputs).toEqual([]);
    } finally {
      await harness.server.close();
    }
  });

  it('combines the authenticated control and workload catalogs on one MCP connection', async () => {
    const harness = await startHarness(true);
    try {
      const names = toolNames(await rpc(harness, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
      expect(names).toContain('supervisor_status');
      expect(names).toContain('supervisor_doctor');
      expect(names).toContain('runtime_status');
      expect(names).toContain('file_read');
      expect(new Set(names).size).toBe(names.length);
      expect(structured(await rpcTool(harness, 'file_read', { projectId: '11111111-1111-4111-8111-111111111111', targetPath: 'README.md' }))).toEqual({ runtime: 'off', code: 'RUNTIME_NOT_RUNNING' });
      expect(harness.workloadCalls).toEqual(['file_read']);
      harness.workloadAvailable = false;
      expect(toolError(await rpcTool(harness, 'file_read', { projectId: '11111111-1111-4111-8111-111111111111', targetPath: 'README.md' }))).toMatchObject({ code: 'RUNTIME_NOT_RUNNING' });
    } finally {
      await harness.server.close();
    }
  });

  it('forwards grouped workload reads and exposes durable shell start on the same native connection', async () => {
    const harness = await startHarness(true);
    try {
      for (const [name, arguments_] of [
        ['workspace', { operation: 'list', projectId: '11111111-1111-4111-8111-111111111111' }],
        ['fs', { operation: 'list', projectId: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace-1' }],
        ['artifact', { operation: 'stat', projectId: '11111111-1111-4111-8111-111111111111', artifactId: 'artifact-1' }],
        ['job', { operation: 'status', projectId: '11111111-1111-4111-8111-111111111111', jobId: 'job-1' }],
        ['git', { operation: 'status', projectId: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace-1' }],
        ['shell', { operation: 'start', projectId: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace-1', requestId: randomUUID() }],
      ] as const) {
        expect(await rpcTool(harness, name, arguments_)).toMatchObject({ result: { isError: false } });
      }
      expect(harness.workloadCalls).toEqual(['workspace', 'fs', 'artifact', 'job', 'git', 'shell']);
    } finally {
      await harness.server.close();
    }
  });

  it('requires authenticated client/session context for downstream mutation evidence', async () => {
    const harness = await startHarness(true);
    try {
      expect(structured(await rpcTool(harness, 'workload_mutation_status', {
        operation: 'fs',
        arguments: { operation: 'write', requestId: 'mutation-1', projectId: 'project-a', workspaceId: 'workspace-a' },
      }, { 'x-iris-client-id': 'conversation-a', 'x-iris-session-id': 'session-a' }))).toMatchObject({
        accepted: true, operation: 'fs', requestId: 'mutation-1', clientId: 'conversation-a', sessionId: 'session-a',
      });
      expect(toolError(await rpcTool(harness, 'workload_mutation_status', {
        operation: 'fs', arguments: { operation: 'write', requestId: 'mutation-1' },
      }))).toMatchObject({ code: 'CONTROL_DENIED' });
    } finally {
      await harness.server.close();
    }
  });

  it('propagates bounded client and session identity to workload calls', async () => {
    const harness = await startHarness(true);
    try {
      await rpcTool(harness, 'file_read', { projectId: '11111111-1111-4111-8111-111111111111', targetPath: 'README.md' });
      await rpc(harness, {
        jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'file_read', arguments: { projectId: '11111111-1111-4111-8111-111111111111', targetPath: 'README.md' } },
      }, { 'Mcp-Name': 'file_read', 'x-iris-client-id': 'conversation-b', 'x-iris-session-id': 'session-b' });
      expect(harness.workloadContexts).toMatchObject([
        {},
        { clientId: 'conversation-b', sessionId: 'session-b', requestId: expect.any(String) },
      ]);
      const invalid = await rpc(harness, {
        jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'file_read', arguments: { projectId: '11111111-1111-4111-8111-111111111111', targetPath: 'README.md' } },
      }, { 'Mcp-Name': 'file_read', 'x-iris-client-id': 'x'.repeat(201) });
      expect(toolError(invalid)).toMatchObject({ code: 'INVALID_REQUEST' });
    } finally {
      await harness.server.close();
    }
  });

  it('keeps the outer native endpoint reachable across admin recycle and workload replacement simulation', async () => {
    const harness = await startHarness();
    try {
      expect((await fetch(harness.server.healthUrl, { headers: { authorization: `Bearer ${harness.secret}` } })).status).toBe(200);
      const recycled = structured(await rpcTool(harness, 'admin_recycle', {
        expectedAdminIdentity: 'admin-a',
        expectedAdminProfileDigest: 'a'.repeat(64),
      }));
      expect(recycled).toMatchObject({ beforeAdminIdentity: 'admin-a', afterAdminIdentity: 'admin-b' });
      expect(harness.recycleInputs).toEqual([{ expectedAdminIdentity: 'admin-a', expectedAdminProfileDigest: 'a'.repeat(64) }]);
      expect((await fetch(harness.server.healthUrl, { headers: { authorization: `Bearer ${harness.secret}` } })).status).toBe(200);

      harness.workloadRuntimeId = 'runtime-b';
      expect(structured(await rpcTool(harness, 'supervisor_status', {}))).toMatchObject({ workloadRuntimeId: 'runtime-b' });
      expect((await fetch(harness.server.healthUrl, { headers: { authorization: `Bearer ${harness.secret}` } })).status).toBe(200);
    } finally {
      await harness.server.close();
    }
  });

  it('supports an authenticated MCP reconnect after the native transport is replaced', async () => {
    const harness = await startHarness();
    let replacement: Awaited<ReturnType<typeof startSupervisorNativeControlServer>> | null = null;
    try {
      expect(toolNames(await rpc(harness, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))).toContain('project_info');
      const port = harness.server.port;
      replacement = await harness.restart();
      expect(replacement.port).toBe(port);
      expect((await fetch(replacement.healthUrl, { headers: { authorization: `Bearer ${harness.secret}` } })).status).toBe(200);
      const reconnected = { ...harness, server: replacement };
      expect(structured(await rpcTool(reconnected, 'project_info', { projectId: '11111111-1111-4111-8111-111111111111' }))).toMatchObject({ id: '11111111-1111-4111-8111-111111111111' });
    } finally {
      await (replacement ?? harness.server).close();
    }
  });

  it('requires a bounded lifecycle grant for tunnel runtime controls while preserving owner control', async () => {
    const harness = await startHarness();
    const calls: string[] = [];
    // The harness starts with no authorized callback; install a dedicated server for this contract proof.
    await harness.server.close();
    const server = await startSupervisorNativeControlServer(harness.dataRoot, await freePort(), {
      supervisorStatus: async () => ({}),
      runtimeStatus: async () => ({ state: 'stopped' }),
      runtimeOn: async () => ({ state: 'RUNNING' }),
      runtimeOff: async () => ({ state: 'STOPPED' }),
      runtimeOnAuthorized: async (input) => { calls.push(`on:${input.operationId}`); return { state: 'RUNNING', authorized: true }; },
      runtimeOffAuthorized: async (input) => { calls.push(`off:${input.operationId}`); return { state: 'STOPPED', authorized: true }; },
      listProjects: async () => ({ projects: [] }),
      projectInfo: async () => ({}),
      adminStatus: async () => ({}),
      runtimeReconcile: async () => ({}),
      adminRecycle: async () => ({}),
      adminTunnelRecycle: async () => ({}),
      adminToolCall: async (): Promise<SupervisorAdminToolCallResult> => ({ structuredContent: {}, isError: false }),
    });
    try {
      expect(toolError(await rpcTool({ ...harness, server }, 'runtime_on', {}))).toMatchObject({ code: 'CONTROL_DENIED' });
      const grantArgs = {
        grantId: '11111111-1111-4111-8111-111111111111',
        requestId: '22222222-2222-4222-8222-222222222222',
        operationId: '33333333-3333-4333-8333-333333333333',
        tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      };
      expect(structured(await rpcTool({ ...harness, server }, 'runtime_on', grantArgs))).toMatchObject({ state: 'RUNNING', authorized: true });
      expect(calls).toEqual(['on:33333333-3333-4333-8333-333333333333']);
      expect(structured(await rpcTool({ ...harness, server }, 'runtime_on', {}, { authorization: `Bearer ${harness.ownerSecret}` }))).toMatchObject({ state: 'RUNNING' });
    } finally {
      await server.close();
    }
  });
});

async function startHarness(withWorkload = false) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-native-supervisor-control-'));
  roots.push(dataRoot);
  const secret = await loadOrCreateTunnelServiceSecret(dataRoot);
  const ownerAccessSecret = await loadOrCreateOwnerAccessSecret(dataRoot);
  await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
  const recycleInputs: AdminRecycleInput[] = [];
  const workloadCalls: string[] = [];
  const workloadContexts: Array<{ clientId?: string; sessionId?: string }> = [];
  const harness = { workloadRuntimeId: 'runtime-a', workloadAvailable: true };
  const operations: SupervisorNativeOperations = {
    supervisorStatus: async () => ({ supervisor: 'outer', workloadRuntimeId: harness.workloadRuntimeId }),
    supervisorDoctor: async () => ({ IRIS_STACK: 'DEGRADED', FAILED_LAYER: null }),
    runtimeStatus: async () => ({ state: 'stopped', workloadOnly: true }),
    runtimeOn: async () => ({ state: 'RUNNING', workloadOnly: true }),
    runtimeOff: async () => ({ state: 'STOPPED', workloadOnly: true }),
    runtimeRestart: async (requestId) => ({ requestId, state: 'RUNNING', workloadOnly: true }),
    runtimeRestartAuthorized: async (input) => ({ requestId: input.operationId, state: 'RUNNING', workloadOnly: true }),
    runtimeRestartStatus: async (requestId, reconcile) => ({ requestId, state: reconcile ? 'FAILED' : 'RECONCILIATION_REQUIRED', workloadOnly: true }),
    keepAwakeStatus: async () => ({ preferenceEnabled: true, requested: true, observed: 'ACTIVE' }),
    setKeepAwakePreference: async (enabled) => ({ preferenceEnabled: enabled, requested: enabled, observed: enabled ? 'ACTIVE' : 'INACTIVE' }),
    listProjects: async () => ({ defaultProjectId: null, projects: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Project', rootPath: '/tmp/project-a' }] }),
    projectInfo: async (projectId) => {
      if (projectId !== '11111111-1111-4111-8111-111111111111') throw new Error('Registered project was not found');
      return { id: projectId, name: 'Project', rootPath: '/tmp/project-a' };
    },
    adminStatus: async () => ({ adminIdentity: recycleInputs.length === 0 ? 'admin-a' : 'admin-b' }),
    runtimeReconcile: async () => ({ readiness: 'READY', workloadAnchorsPreserved: true }),
    adminRecycle: async (input) => {
      recycleInputs.push(input);
      return { beforeAdminIdentity: 'admin-a', afterAdminIdentity: 'admin-b', workloadRuntimeIdUnchanged: true };
    },
    adminTunnelRecycle: async (input: AdminTunnelRecycleInput) => ({ ...input, readiness: 'READY' }),
    adminToolCall: async (name): Promise<SupervisorAdminToolCallResult> => ({ structuredContent: { proxied: name }, isError: false }),
    ...(withWorkload ? {
      workloadToolDefinitions: () => fullMcpToolDefinitionsV21(),
      workloadToolCall: async (name: string, _args: Record<string, unknown>, context): Promise<SupervisorAdminToolCallResult> => {
        if (!harness.workloadAvailable) throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Workload Runtime is unavailable');
        workloadCalls.push(name);
        workloadContexts.push(context ?? {});
        return { structuredContent: name === 'runtime_status' ? { runtime: 'off', truthful: true } : { runtime: 'off', code: 'RUNTIME_NOT_RUNNING' }, isError: false };
      },
      workloadMutationStatus: async (input): Promise<SupervisorAdminToolCallResult> => ({
        structuredContent: { accepted: true, operation: input.name, requestId: input.args.requestId, clientId: input.context.clientId, sessionId: input.context.sessionId },
        isError: false,
      }),
    } : {}),
  };
  const server = await startSupervisorNativeControlServer(dataRoot, await freePort(), operations);
  return {
    ...harness,
    dataRoot,
    secret,
    ownerSecret: 'control-plane-credential-for-test-only-12345',
    ownerAccessSecret,
    recycleInputs,
    workloadCalls,
    workloadContexts,
    server,
    restart: async () => {
      const port = server.port;
      await server.close();
      return startSupervisorNativeControlServer(dataRoot, port, operations);
    },
    get workloadRuntimeId() { return harness.workloadRuntimeId; },
    set workloadRuntimeId(value: string) { harness.workloadRuntimeId = value; },
    get workloadAvailable() { return harness.workloadAvailable; },
    set workloadAvailable(value: boolean) { harness.workloadAvailable = value; },
  };
}

async function rpcTool(harness: Awaited<ReturnType<typeof startHarness>>, name: string, args: object, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
  return rpc(harness, {
    jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args },
  }, { 'Mcp-Name': name, ...extraHeaders });
}

async function rpc(
  harness: Awaited<ReturnType<typeof startHarness>>,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await postRpc(harness, body, { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, ...extraHeaders });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

async function postRpc(
  harness: Awaited<ReturnType<typeof startHarness>>,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  authenticated = true,
): Promise<Response> {
  return fetch(harness.server.mcpUrl, {
    method: 'POST',
    headers: {
      ...(authenticated ? { authorization: `Bearer ${harness.secret}` } : {}),
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function toolNames(value: Record<string, unknown>): string[] {
  if (!isRecord(value.result) || !Array.isArray(value.result.tools)) return [];
  return value.result.tools.flatMap((tool) => isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : []);
}

function structured(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.result) || !isRecord(value.result.structuredContent)) throw new Error('missing structuredContent');
  return value.result.structuredContent;
}

function toolError(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.result) || value.result.isError !== true || !isRecord(value.result.structuredContent)
    || !isRecord(value.result.structuredContent.error)) throw new Error('missing tool error');
  return value.result.structuredContent.error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Could not reserve native control test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
