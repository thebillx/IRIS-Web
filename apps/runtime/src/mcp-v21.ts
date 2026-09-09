import { RuntimeError } from '@iris/domain';
import type { CapabilityService } from './capability-service.js';
import type { DurableMissionLifecycleService } from './durable-mission-service.js';
import type { MissionBrokerService } from './mission-broker.js';
import { MCP_PROTOCOL_VERSION, fullMcpToolDefinitions, handleMcpRequest, type McpPrincipal } from './mcp.js';
import { augmentV21ToolDefinitions, V21_LIFECYCLE_TOOL_NAMES } from './mcp-v21-definitions.js';
import { executeV21LifecycleTool, isCapabilityOutcome, toolError, toolOutcome, toolResult } from './mcp-v21-tools.js';
import type { RuntimeState } from './state.js';

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export async function handleMcpV21Request(
  request: Request,
  capabilities: CapabilityService,
  state: RuntimeState,
  broker: MissionBrokerService,
  lifecycle: DurableMissionLifecycleService,
  principal: McpPrincipal = 'owner',
): Promise<Response> {
  if (request.method !== 'POST') return handleMcpRequest(request, capabilities, state, broker, principal);

  let rpc: JsonRpcRequest;
  try {
    rpc = await request.clone().json() as JsonRpcRequest;
  } catch {
    return handleMcpRequest(request, capabilities, state, broker, principal);
  }

  if (rpc.method === 'tools/list') {
    return augmentToolList(await handleMcpRequest(request, capabilities, state, broker, principal));
  }
  if (rpc.method !== 'tools/call') return handleMcpRequest(request, capabilities, state, broker, principal);

  const params = isRecord(rpc.params) ? rpc.params : null;
  const args = params !== null && isRecord(params.arguments) ? params.arguments : null;
  const name = params !== null && typeof params.name === 'string' ? params.name : null;
  if (name === null || args === null) return handleMcpRequest(request, capabilities, state, broker, principal);

  const lifecycleDirective = name === 'mission_directive' && args.basedOnRevision !== undefined;
  const lifecycleCreate = name === 'mission_create';
  if (!V21_LIFECYCLE_TOOL_NAMES.has(name) && !lifecycleDirective && !lifecycleCreate) {
    return handleMcpRequest(request, capabilities, state, broker, principal);
  }

  if (request.headers.get('MCP-Protocol-Version') !== MCP_PROTOCOL_VERSION) {
    return jsonRpcError(rpc.id ?? null, -32600, `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}`, 400);
  }
  const toolHeader = request.headers.get('Mcp-Name');
  if (toolHeader !== null && toolHeader !== name) return jsonRpcError(rpc.id ?? null, -32600, 'Mcp-Name does not match tool name', 400);

  try {
    const result = await executeV21LifecycleTool(name, args, request, capabilities, state, lifecycle);
    return jsonRpcResult(rpc.id ?? null, isCapabilityOutcome(result) ? toolOutcome(result) : toolResult(result));
  } catch (error) {
    const runtimeError = error instanceof RuntimeError
      ? error
      : new RuntimeError('INVALID_REQUEST', error instanceof Error ? error.message : 'Lifecycle tool call failed');
    return jsonRpcResult(rpc.id ?? null, toolError(runtimeError.code, runtimeError.message));
  }
}

export function fullMcpToolNames(): readonly string[] {
  return augmentV21ToolDefinitions(fullMcpToolDefinitions())
    .flatMap((tool) => isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : []);
}

async function augmentToolList(base: Response): Promise<Response> {
  if (!base.ok) return base;
  const payload = await base.json() as unknown;
  if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) return cloneJsonResponse(base, payload);
  return cloneJsonResponse(base, {
    ...payload,
    result: { ...payload.result, tools: augmentV21ToolDefinitions(payload.result.tools) },
  });
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  return json({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: string | number | null, code: number, message: string, status = 200): Response {
  return json({ jsonrpc: '2.0', id, error: { code, message } }, status);
}

function cloneJsonResponse(base: Response, value: unknown): Response {
  return new Response(JSON.stringify(value), { status: base.status, headers: new Headers(base.headers) });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
