import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogToolNames } from './mcp-catalog.js';
import { loadOrCreateTunnelServiceSecret } from './credentials.js';
import { MCP_PROTOCOL_VERSION, TUNNEL_CLIENT_MCP_PROTOCOL_VERSION } from './mcp.js';
import {
  startSupervisorNativeControlServer,
  type AdminRecycleInput,
  type AdminTunnelRecycleInput,
  type SupervisorNativeOperations,
} from './supervisor-native-control.js';
import { adminToolDefinitions, type SupervisorAdminToolCallResult } from './supervisor-admin.js';

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
        'supervisor_status', 'admin_status', 'runtime_reconcile', 'admin_recycle', 'admin_tunnel_recycle',
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

      const listed = await rpc(harness, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(toolNames(listed)).toEqual([
        'supervisor_status',
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
      for (const name of ['supervisor_status', 'admin_status', 'runtime_reconcile', 'admin_recycle', 'admin_tunnel_recycle']) {
        expect(catalogToolNames('FULL')).not.toContain(name);
        expect(catalogToolNames('PRO')).not.toContain(name);
      }
      for (const name of ['supervisor_status', 'runtime_reconcile', 'admin_recycle', 'admin_tunnel_recycle']) {
        expect(adminToolDefinitions().map((tool) => tool.name)).not.toContain(name);
      }
      expect(adminToolDefinitions().map((tool) => tool.name)).toContain('admin_status');
      expect(structured(await rpcTool(harness, 'supervisor_status', {}))).toMatchObject({ supervisor: 'outer', workloadRuntimeId: 'runtime-a' });
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
});

async function startHarness() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-native-supervisor-control-'));
  roots.push(dataRoot);
  const secret = await loadOrCreateTunnelServiceSecret(dataRoot);
  const recycleInputs: AdminRecycleInput[] = [];
  const harness = { workloadRuntimeId: 'runtime-a' };
  const operations: SupervisorNativeOperations = {
    supervisorStatus: async () => ({ supervisor: 'outer', workloadRuntimeId: harness.workloadRuntimeId }),
    adminStatus: async () => ({ adminIdentity: recycleInputs.length === 0 ? 'admin-a' : 'admin-b' }),
    runtimeReconcile: async () => ({ readiness: 'READY', workloadAnchorsPreserved: true }),
    adminRecycle: async (input) => {
      recycleInputs.push(input);
      return { beforeAdminIdentity: 'admin-a', afterAdminIdentity: 'admin-b', workloadRuntimeIdUnchanged: true };
    },
    adminTunnelRecycle: async (input: AdminTunnelRecycleInput) => ({ ...input, readiness: 'READY' }),
    adminToolCall: async (name): Promise<SupervisorAdminToolCallResult> => ({ structuredContent: { proxied: name }, isError: false }),
  };
  const server = await startSupervisorNativeControlServer(dataRoot, await freePort(), operations);
  return { ...harness, dataRoot, secret, recycleInputs, server, get workloadRuntimeId() { return harness.workloadRuntimeId; }, set workloadRuntimeId(value: string) { harness.workloadRuntimeId = value; } };
}

async function rpcTool(harness: Awaited<ReturnType<typeof startHarness>>, name: string, args: object): Promise<Record<string, unknown>> {
  return rpc(harness, {
    jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args },
  }, { 'Mcp-Name': name });
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
