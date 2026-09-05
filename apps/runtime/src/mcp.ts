import type { CapabilityOutcome, CapabilityService } from './capability-service.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;
const CLIENT_ID_HEADER = 'x-iris-client-id';
const SESSION_ID_HEADER = 'x-iris-session-id';

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export async function handleMcpRequest(request: Request, capabilities: CapabilityService): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });

  let rpc: JsonRpcRequest;
  try {
    rpc = await request.json() as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error', 400);
  }
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return jsonRpcError(rpc.id ?? null, -32600, 'Invalid Request', 400);

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
  if (methodHeader !== null && methodHeader !== rpc.method) return jsonRpcError(rpc.id ?? null, -32600, 'Mcp-Method does not match JSON-RPC method', 400);

  if (rpc.method === 'ping') return jsonRpcResult(rpc.id ?? null, {});
  if (rpc.method === 'tools/list') return jsonRpcResult(rpc.id ?? null, { tools: toolDefinitions() });

  if (rpc.method === 'tools/call') {
    const params = isRecord(rpc.params) ? rpc.params : null;
    if (params === null || typeof params.name !== 'string') return jsonRpcError(rpc.id ?? null, -32602, 'Invalid tool call parameters', 400);
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isRecord(args)) return jsonRpcError(rpc.id ?? null, -32602, 'Tool arguments must be an object', 400);
    const toolHeader = request.headers.get('Mcp-Name');
    if (toolHeader !== null && toolHeader !== params.name) return jsonRpcError(rpc.id ?? null, -32600, 'Mcp-Name does not match tool name', 400);

    try {
      const outcome = await executeTool(params.name, args, request, capabilities);
      return jsonRpcResult(rpc.id ?? null, toolOutcome(outcome));
    } catch (error) {
      return jsonRpcResult(rpc.id ?? null, toolError('INVALID_REQUEST', error instanceof Error ? error.message : 'Tool call failed'));
    }
  }

  if (rpc.id === undefined) return new Response(null, { status: 202 });
  return jsonRpcError(rpc.id, -32601, 'Method not found', 404);
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  request: Request,
  capabilities: CapabilityService,
): Promise<CapabilityOutcome> {
  const clientId = optionalHeader(request, CLIENT_ID_HEADER);
  const sessionId = optionalHeader(request, SESSION_ID_HEADER);
  if (name === 'runtime_status') return capabilities.execute({ capabilityId: 'runtime.status', clientId, sessionId });
  if (name === 'list_projects') return capabilities.execute({ capabilityId: 'project.list', clientId, sessionId });

  const requiredClient = requiredHeader(request, CLIENT_ID_HEADER);
  const requiredSession = requiredHeader(request, SESSION_ID_HEADER);
  const projectId = optionalString(args, 'projectId');
  const targetPath = requiredString(args, 'targetPath');
  if (name === 'file_read') return capabilities.execute({ capabilityId: 'file.read', clientId: requiredClient, sessionId: requiredSession, projectId, targetPath });
  if (name === 'file_write') return capabilities.execute({ capabilityId: 'file.write', clientId: requiredClient, sessionId: requiredSession, projectId, targetPath, content: requiredString(args, 'content') });
  if (name === 'file_delete') return capabilities.execute({ capabilityId: 'file.delete', clientId: requiredClient, sessionId: requiredSession, projectId, targetPath });
  if (name === 'directory_create') return capabilities.execute({ capabilityId: 'directory.create', clientId: requiredClient, sessionId: requiredSession, projectId, targetPath });
  if (name === 'directory_delete') return capabilities.execute({ capabilityId: 'directory.delete', clientId: requiredClient, sessionId: requiredSession, projectId, targetPath });
  throw new Error(`Unknown tool: ${name}`);
}

function toolDefinitions(): readonly Record<string, unknown>[] {
  const projectProperties = {
    projectId: { type: 'string', description: 'Optional expected project id; must match the live session project.' },
    targetPath: { type: 'string', description: 'Absolute path physically contained by the live session project.' },
  };
  return [
    { name: 'runtime_status', description: 'Read the local IRIS runtime status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'list_projects', description: 'List explicitly registered local projects.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'file_read', description: 'Read one bounded regular file from the live session project.', inputSchema: { type: 'object', required: ['targetPath'], properties: projectProperties, additionalProperties: false } },
    { name: 'file_write', description: 'Create or replace one bounded regular file in the live session project.', inputSchema: { type: 'object', required: ['targetPath', 'content'], properties: { ...projectProperties, content: { type: 'string' } }, additionalProperties: false } },
    { name: 'file_delete', description: 'Delete one regular file in the live session project.', inputSchema: { type: 'object', required: ['targetPath'], properties: projectProperties, additionalProperties: false } },
    { name: 'directory_create', description: 'Create one directory whose parent already exists inside the live session project.', inputSchema: { type: 'object', required: ['targetPath'], properties: projectProperties, additionalProperties: false } },
    { name: 'directory_delete', description: 'Remove one empty directory inside the live session project.', inputSchema: { type: 'object', required: ['targetPath'], properties: projectProperties, additionalProperties: false } },
  ];
}

function toolOutcome(outcome: CapabilityOutcome): ReturnType<typeof toolResult> | ReturnType<typeof toolError> {
  if (outcome.status === 'executed') return toolResult(outcome.value);
  if (outcome.status === 'owner_required') return toolError('OWNER_DECISION_REQUIRED', 'Owner approval is required before this action can execute', { approval: outcome.approval });
  return toolError('CAPABILITY_DENIED', outcome.reason);
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value, isError: false as const };
}

function toolError(code: string, message: string, extra: Record<string, unknown> = {}) {
  const structuredContent = { code, message, ...extra };
  return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true as const };
}

function requiredHeader(request: Request, name: string): string {
  const value = optionalHeader(request, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function optionalHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 200 || value.includes('\0')) throw new Error(`${name} is invalid`);
  return value;
}

function requiredString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  return json({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: string | number | null, code: number, message: string, status = 200): Response {
  return json({ jsonrpc: '2.0', id, error: { code, message } }, status);
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
