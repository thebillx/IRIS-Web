import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from './mcp.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('local MCP transport skeleton', () => {
  it('discovers the modern stateless endpoint and exposes only informational tools', async () => {
    const state = await fixtureState();
    const health = () => ({
      status: 'ready' as const,
      version: '0.0.0' as const,
      platform: 'darwin' as const,
      runtimeId: 'runtime',
      instanceId: 'instance',
      pid: process.pid,
      uptimeMs: 10,
      authority: 'owned' as const,
      connectedClients: 0,
      connectedSessions: 0,
      apiUrl: 'http://127.0.0.1:43110',
      mcpUrl: 'http://127.0.0.1:43110/mcp',
    });

    const discovered = await handleMcpRequest(rpc('server/discover', 1, undefined, false), state, health);
    expect(discovered.status).toBe(200);
    expect(await discovered.json()).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSION } });

    const listed = await handleMcpRequest(rpc('tools/list', 2), state, health);
    expect((await listed.json() as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name)).toEqual([
      'runtime_status',
      'list_projects',
    ]);

    const called = await handleMcpRequest(rpc('tools/call', 3, { name: 'runtime_status', arguments: {} }, true, 'runtime_status'), state, health);
    expect(await called.json()).toMatchObject({ result: { isError: false, structuredContent: { status: 'ready' } } });
  });
});

function rpc(
  method: string,
  id?: number,
  params?: unknown,
  includeProtocol = true,
  toolName?: string,
): Request {
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(includeProtocol ? { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'Mcp-Method': method } : {}),
      ...(toolName === undefined ? {} : { 'Mcp-Name': toolName }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
  });
}

async function fixtureState(): Promise<RuntimeState> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-mcp-'));
  roots.push(root);
  return new RuntimeState(new FoundationStateStore(root));
}
