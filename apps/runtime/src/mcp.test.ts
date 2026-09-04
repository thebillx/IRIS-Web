import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeHealth } from '@iris/domain';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from './mcp.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const health = (): RuntimeHealth => ({ status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid, uptimeMs: 1, authority: 'owned', connectedClients: 0, connectedSessions: 0, apiUrl: 'http://127.0.0.1:1', mcpUrl: 'http://127.0.0.1:1/mcp' });

async function request(method: string, params?: unknown): Promise<Request> {
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
}

describe('local MCP transport skeleton', () => {
  it('exposes informational tools only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'iris-mcp-'));
    roots.push(root);
    const state = new RuntimeState(new FoundationStateStore(root));
    const response = await handleMcpRequest(await request('tools/list'), state, health);
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['runtime_status', 'list_projects']);
  });
});
