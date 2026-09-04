import type { RuntimeHealth } from '@iris/domain';
import type { RuntimeState } from './state.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;

interface JsonRpcRequest { readonly jsonrpc: '2.0'; readonly id?: string | number | null; readonly method: string; readonly params?: unknown }

export async function handleMcpRequest(request: Request, state: RuntimeState, health: () => RuntimeHealth): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  const protocol = request.headers.get('MCP-Protocol-Version');
  if (protocol !== MCP_PROTOCOL_VERSION) return jsonRpcError(null, -32600, `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}`, 400);
  let rpc: JsonRpcRequest;
  try {
    rpc = await request.json() as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error', 400);
  }
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return jsonRpcError(rpc.id ?? null, -32600, 'Invalid Request', 400);

  if (rpc.method === 'server/discover') {
    return jsonRpcResult(rpc.id ?? null, { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'iris-local-runtime', version: '0.0.0' }, capabilities: { tools: {} } });
  }
  if (rpc.method === 'tools/list') {
    return jsonRpcResult(rpc.id ?? null, { tools: [
      { name: 'runtime_status', description: 'Read the local IRIS runtime status.', inputSchema: { type: 'object', additionalProperties: false } },
      { name: 'list_projects', description: 'List explicitly registered local projects.', inputSchema: { type: 'object', additionalProperties: false } },
    ] });
  }
  if (rpc.method === 'tools/call') {
    const params = isRecord(rpc.params) ? rpc.params : {};
    if (params.name === 'runtime_status') return jsonRpcResult(rpc.id ?? null, toolText(health()));
    if (params.name === 'list_projects') return jsonRpcResult(rpc.id ?? null, toolText(await state.listProjects()));
    return jsonRpcError(rpc.id ?? null, -32602, 'Unknown or invalid tool', 400);
  }
  return jsonRpcError(rpc.id ?? null, -32601, 'Method not found', 404);
}

function toolText(value: unknown): { content: readonly { type: 'text'; text: string }[]; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
function jsonRpcResult(id: string | number | null, result: unknown): Response { return json({ jsonrpc: '2.0', id, result }); }
function jsonRpcError(id: string | number | null, code: number, message: string, status = 200): Response { return json({ jsonrpc: '2.0', id, error: { code, message } }, status); }
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
