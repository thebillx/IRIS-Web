import type { RuntimeHealth } from '@iris/domain';
import type { RuntimeState } from './state.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export async function handleMcpRequest(
  request: Request,
  state: RuntimeState,
  health: () => RuntimeHealth,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });

  let rpc: JsonRpcRequest;
  try {
    rpc = await request.json() as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error', 400);
  }
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return jsonRpcError(rpc.id ?? null, -32600, 'Invalid Request', 400);
  }

  if (rpc.method === 'server/discover') {
    return jsonRpcResult(rpc.id ?? null, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: 'iris-local-runtime', version: '0.0.0' },
      capabilities: { tools: {} },
    });
  }

  if (request.headers.get('MCP-Protocol-Version') !== MCP_PROTOCOL_VERSION) {
    return jsonRpcError(rpc.id ?? null, -32600, `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}`, 400);
  }
  const methodHeader = request.headers.get('Mcp-Method');
  if (methodHeader !== null && methodHeader !== rpc.method) {
    return jsonRpcError(rpc.id ?? null, -32600, 'Mcp-Method does not match JSON-RPC method', 400);
  }

  if (rpc.method === 'ping') return jsonRpcResult(rpc.id ?? null, {});
  if (rpc.method === 'tools/list') {
    return jsonRpcResult(rpc.id ?? null, {
      tools: [
        {
          name: 'runtime_status',
          description: 'Read the local IRIS runtime status.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          name: 'list_projects',
          description: 'List explicitly registered local projects.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    });
  }
  if (rpc.method === 'tools/call') {
    const params = isRecord(rpc.params) ? rpc.params : null;
    if (params === null || typeof params.name !== 'string' || !emptyArguments(params.arguments)) {
      return jsonRpcError(rpc.id ?? null, -32602, 'Invalid tool call parameters', 400);
    }
    const toolHeader = request.headers.get('Mcp-Name');
    if (toolHeader !== null && toolHeader !== params.name) {
      return jsonRpcError(rpc.id ?? null, -32600, 'Mcp-Name does not match tool name', 400);
    }
    if (params.name === 'runtime_status') return jsonRpcResult(rpc.id ?? null, toolResult(health()));
    if (params.name === 'list_projects') return jsonRpcResult(rpc.id ?? null, toolResult(await state.listProjects()));
    return jsonRpcError(rpc.id ?? null, -32602, 'Unknown tool', 400);
  }

  if (rpc.id === undefined) return new Response(null, { status: 202 });
  return jsonRpcError(rpc.id, -32601, 'Method not found', 404);
}

function emptyArguments(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.keys(value).length === 0);
}

function toolResult(value: unknown): {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent: unknown;
  readonly isError: false;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  return json({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: string | number | null, code: number, message: string, status = 200): Response {
  return json({ jsonrpc: '2.0', id, error: { code, message } }, status);
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
