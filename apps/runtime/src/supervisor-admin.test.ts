import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateTunnelServiceSecret, readTunnelServiceSecret } from './credentials.js';
import { catalogToolNames } from './mcp-catalog.js';
import { MCP_PROTOCOL_VERSION } from './mcp.js';
import { startSupervisorAdminServer } from './supervisor-admin.js';

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('persistent supervisor admin transport', () => {
  it('requires authentication and exposes persistent admin lifecycle tools outside workload catalogs', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-admin-'));
    roots.push(dataRoot);
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const secret = await readTunnelServiceSecret(dataRoot);
    if (secret === null) throw new Error('missing supervisor admin test secret');

    const server = await startSupervisorAdminServer(dataRoot, await freePort());
    try {
      const unauthorized = await fetch(server.healthUrl);
      expect(unauthorized.status).toBe(401);

      const health = await fetch(server.healthUrl, { headers: { authorization: `Bearer ${secret}` } });
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({
        ok: true,
        owner: 'PERSISTENT_SUPERVISOR_OR_CONTROL_PLANE',
        pid: process.pid,
      });

      const discovery = await postRpc(server.mcpUrl, secret, {
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
      });
      expect(discovery.status).toBe(200);
      const discovered = await discovery.json() as { result: { supportedVersions: string[] } };
      expect(discovered.result.supportedVersions).toEqual([MCP_PROTOCOL_VERSION]);

      const listed = await postRpc(server.mcpUrl, secret, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }, { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION });
      expect(listed.status).toBe(200);
      const listBody = await listed.json() as { result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> } };
      const adminToolNames = [
        'admin_status',
        'admin_identity',
        'activation_status',
        'activation_prepare',
        'activation_apply',
        'activation_confirm',
        'activation_rollback',
      ];
      expect(listBody.result.tools.map((tool) => tool.name)).toEqual(adminToolNames);
      const readOnlyNames = new Set(['admin_status', 'admin_identity', 'activation_status']);
      for (const tool of listBody.result.tools) {
        expect(tool.annotations?.readOnlyHint).toBe(readOnlyNames.has(tool.name));
      }
      for (const name of adminToolNames) {
        expect(catalogToolNames('FULL')).not.toContain(name);
        expect(catalogToolNames('PRO')).not.toContain(name);
      }

      const status = await postRpc(server.mcpUrl, secret, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'admin_status', arguments: {} },
      }, { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'Mcp-Name': 'admin_status' });
      expect(status.status).toBe(200);
      const statusBody = await status.json() as { result: { structuredContent: Record<string, unknown> } };
      expect(statusBody.result.structuredContent).toMatchObject({
        adminEndpointOwner: 'PERSISTENT_SUPERVISOR_OR_CONTROL_PLANE',
        adminProcessId: process.pid,
        readiness: 'DEGRADED',
      });
    } finally {
      await server.close();
    }
  });
});

async function postRpc(url: string, secret: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Could not reserve a test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
