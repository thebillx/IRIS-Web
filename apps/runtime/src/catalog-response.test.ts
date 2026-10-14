import { describe, expect, it } from 'vitest';
import { serializeToolCatalog } from './catalog-response.js';
import { fullMcpToolDefinitions, handleMcpProRequest, handleMcpRequest, MCP_PROTOCOL_VERSION } from './mcp.js';
import { fullMcpToolDefinitionsV21, handleMcpV21Request } from './mcp-v21.js';
import { handleHermesMcpRequest } from './hermes-mcp.js';
import type { CapabilityService } from './capability-service.js';
import type { RuntimeState } from './state.js';
import type { MissionBrokerService } from './mission-broker.js';
import type { DurableMissionLifecycleService } from './durable-mission-service.js';
import { safeSerialize } from './output-redaction.js';

const pattern = '^[0-9a-fA-F]{64}$';
const tool = () => ({ name: 'fixture_edit', description: 'Static schema fixture', inputSchema: { type: 'object', required: ['expectedSha256'], properties: { expectedSha256: { type: 'string', pattern } }, additionalProperties: false } });
const request = (method = 'tools/list', params: unknown = {}) => new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

describe('server-owned catalog serialization', () => {
  it('preserves complete static catalogs through actual FULL, PRO, V21 and Hermes transport', async () => {
    const capabilities = {} as CapabilityService;
    const state = {} as RuntimeState;
    const broker = {} as MissionBrokerService;
    const full = await (await handleMcpRequest(request(), capabilities)).json();
    expect(full.result.tools).toEqual(fullMcpToolDefinitions());
    const edit = full.result.tools.find((entry: { name: string }) => entry.name === 'file_edit');
    expect(edit.inputSchema.properties.expectedSha256.pattern).toBe(pattern);
    expect(edit.inputSchema.required).toContain('expectedSha256');
    expect(edit.inputSchema.additionalProperties).toBe(false);
    for (const digest of ['a'.repeat(64), 'A'.repeat(64), '0123456789abcdef'.repeat(4)]) expect(new RegExp(edit.inputSchema.properties.expectedSha256.pattern).test(digest)).toBe(true);
    for (const digest of ['', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64)]) expect(new RegExp(edit.inputSchema.properties.expectedSha256.pattern).test(digest)).toBe(false);
    const pro = await (await handleMcpProRequest(request(), capabilities)).json();
    expect(pro.result.tools.map((entry: { name: string }) => entry.name)).toEqual(['list_projects', 'project_info', 'git_status', 'file_read', 'search']);
    const v21 = await (await handleMcpV21Request(request(), capabilities, state, broker, {} as DurableMissionLifecycleService)).json();
    expect(v21.result.tools).toEqual(fullMcpToolDefinitionsV21());
    const hermes = await (await handleHermesMcpRequest(request(), 'fixture', state, broker, capabilities)).json();
    expect(hermes.result.tools).toHaveLength(8);
    expect(hermes.result.tools.find((entry: { name: string }) => entry.name === 'project_file_write').inputSchema.required).toEqual(['taskId', 'actionId', 'targetPath', 'content']);
  });

  it('does not accept request-controlled replacement catalogs or untrusted correlation IDs', async () => {
    const response = await handleMcpRequest(request('tools/list', { tools: [{ ...tool(), description: 'PASSWORD=synthetic-secret' }] }), {} as CapabilityService);
    expect(await response.text()).not.toContain('synthetic-secret');
    expect(serializeToolCatalog('PASSWORD=synthetic-secret', [tool()])).not.toContain('synthetic-secret');
    const unsafe = { pattern, secret: ['alpha', 'beta'] };
    expect(safeSerialize(unsafe)).not.toMatch(/alpha|beta/);
    expect(safeSerialize({ pattern })).toContain('[REDACTED_UNCERTAIN]');
  });

  it('keeps arbitrary tool results and errors on the fail-closed path', async () => {
    const valid = JSON.stringify(JSON.stringify({ secret: ['alpha"]leak', 'beta'], safe: 'visible' }));
    for (const payload of [valid.slice(0, -1), `x${valid}`, { pattern, secret: ['alpha', 'beta'] }]) {
      for (const throws of [false, true]) {
        const capabilities = { execute: async () => {
          if (throws) throw new Error(typeof payload === 'string' ? payload : JSON.stringify(payload));
          return { status: 'executed', value: payload };
        } } as unknown as CapabilityService;
        const response = await handleMcpRequest(request('tools/call', { name: 'runtime_status', arguments: {} }), capabilities);
        expect(await response.text()).not.toMatch(/alpha|leak|beta/);
      }
    }
  });

  it('rejects unexpected structures, accessors, cycles, excessive depth, size and node count', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    let deep: unknown = { type: 'string' };
    for (let i = 0; i < 40; i++) deep = { type: 'array', items: deep };
    const getter = Object.defineProperty({}, 'name', { enumerable: true, get() { throw new Error('getter must never run'); } });
    for (const invalid of [[{ ...tool(), credentials: 'synthetic-secret' }], [{ ...tool(), inputSchema: cyclic }], [{ ...tool(), inputSchema: deep }], [{ ...tool(), description: 'x'.repeat(300000) }], [getter], [{ ...tool(), inputSchema: { unknownKeyword: true } }], Array.from({ length: 129 }, tool), [{ ...tool(), inputSchema: { enum: Array.from({ length: 17000 }, () => 'x') } }]]) {
      expect(() => serializeToolCatalog(1, invalid)).toThrow('Invalid server tool catalog');
    }
  });
});
