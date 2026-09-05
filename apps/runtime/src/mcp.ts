import type { MissionExecutionAssociation, MissionState, MissionTaskState, SupervisorGateState } from '@iris/domain';
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
  if (name === 'mission_list') return capabilities.execute({ capabilityId: 'mission.list', clientId, sessionId });
  if (name === 'mission_get') return capabilities.execute({ capabilityId: 'mission.get', clientId, sessionId, missionId: requiredString(args, 'missionId') });

  const requiredClient = requiredHeader(request, CLIENT_ID_HEADER);
  const requiredSession = requiredHeader(request, SESSION_ID_HEADER);
  if (name === 'mission_create') return capabilities.execute({ capabilityId: 'mission.create', clientId: requiredClient, sessionId: requiredSession, title: requiredString(args, 'title') });
  if (name === 'mission_state_set') return capabilities.execute({ capabilityId: 'mission.state.set', clientId: requiredClient, sessionId: requiredSession,
    missionId: requiredString(args, 'missionId'), state: missionState(args, 'state') });
  if (name === 'mission_task_create') return capabilities.execute({ capabilityId: 'mission.task.create', clientId: requiredClient, sessionId: requiredSession,
    missionId: requiredString(args, 'missionId'), title: requiredString(args, 'title') });
  if (name === 'mission_task_state_set') return capabilities.execute({ capabilityId: 'mission.task.state.set', clientId: requiredClient, sessionId: requiredSession,
    missionId: requiredString(args, 'missionId'), taskId: requiredString(args, 'taskId'), state: missionTaskState(args, 'state') });
  if (name === 'mission_action_prepare') return capabilities.execute({ capabilityId: 'mission.action.prepare', clientId: requiredClient, sessionId: requiredSession,
    missionId: requiredString(args, 'missionId'), taskId: requiredString(args, 'taskId'), actionCapabilityId: missionActionCapability(args, 'capabilityId'), summary: requiredString(args, 'summary') });
  if (name === 'mission_supervisor_gate_set') return capabilities.execute({ capabilityId: 'mission.supervisor_gate.set', clientId: requiredClient, sessionId: requiredSession,
    missionId: requiredString(args, 'missionId'), state: supervisorGateState(args, 'state'), reason: optionalNullableString(args, 'reason') });

  const projectId = optionalString(args, 'projectId');
  const targetPath = requiredString(args, 'targetPath');
  const mission = optionalMissionAssociation(args);
  if (name === 'file_read') return capabilities.execute({ capabilityId: 'file.read', clientId: requiredClient, sessionId: requiredSession, projectId, targetPath, mission });
  if (name === 'file_write') return capabilities.execute({ capabilityId: 'file.write', clientId: requiredClient, sessionId: requiredSession, projectId, targetPath, content: requiredString(args, 'content'), mission });
  if (name === 'file_delete') return capabilities.execute({ capabilityId: 'file.delete', clientId: requiredClient, sessionId: requiredSession, projectId, targetPath, mission });
  if (name === 'directory_create') return capabilities.execute({ capabilityId: 'directory.create', clientId: requiredClient, sessionId: requiredSession, projectId, targetPath, mission });
  if (name === 'directory_delete') return capabilities.execute({ capabilityId: 'directory.delete', clientId: requiredClient, sessionId: requiredSession, projectId, targetPath, mission });
  throw new Error(`Unknown tool: ${name}`);
}

function toolDefinitions(): readonly Record<string, unknown>[] {
  const associationProperties = {
    missionId: { type: 'string', description: 'Prepared mission identity. missionId/taskId/actionId must be supplied together.' },
    taskId: { type: 'string', description: 'Prepared task identity. missionId/taskId/actionId must be supplied together.' },
    actionId: { type: 'string', description: 'Prepared action identity. missionId/taskId/actionId must be supplied together.' },
  };
  const projectProperties = {
    projectId: { type: 'string', description: 'Optional expected project id; must match the live session project.' },
    targetPath: { type: 'string', description: 'Absolute path physically contained by the live session project.' },
    ...associationProperties,
  };
  return [
    { name: 'runtime_status', description: 'Read the local IRIS runtime status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'list_projects', description: 'List explicitly registered local projects.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'mission_list', description: 'List durable mission execution records visible to the local owner.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'mission_get', description: 'Read one durable mission with tasks, governed actions, evidence, supervisor-gate representation, and timeline.', inputSchema: { type: 'object', required: ['missionId'], properties: { missionId: { type: 'string' } }, additionalProperties: false } },
    { name: 'mission_create', description: 'Register mission identity for the live client/session. Hermes remains orchestration authority.', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 240 } }, additionalProperties: false } },
    { name: 'mission_state_set', description: 'Record orchestration-owned mission state; this does not grant execution authority.', inputSchema: { type: 'object', required: ['missionId', 'state'], properties: { missionId: { type: 'string' }, state: { enum: ['PLANNED','RUNNING','WAITING_APPROVAL','WAITING_SUPERVISOR','PAUSED','COMPLETED','FAILED','CANCELLED'] } }, additionalProperties: false } },
    { name: 'mission_task_create', description: 'Register a task identity inside a mission.', inputSchema: { type: 'object', required: ['missionId','title'], properties: { missionId: { type: 'string' }, title: { type: 'string', maxLength: 240 } }, additionalProperties: false } },
    { name: 'mission_task_state_set', description: 'Record orchestration-owned task state.', inputSchema: { type: 'object', required: ['missionId','taskId','state'], properties: { missionId: { type: 'string' }, taskId: { type: 'string' }, state: { enum: ['PENDING','RUNNING','BLOCKED','COMPLETED','FAILED','CANCELLED'] } }, additionalProperties: false } },
    { name: 'mission_action_prepare', description: 'Prepare one governed IRIS execution action. Preparation never executes the capability.', inputSchema: { type: 'object', required: ['missionId','taskId','capabilityId','summary'], properties: { missionId: { type: 'string' }, taskId: { type: 'string' }, capabilityId: { enum: ['file.read','file.write','file.delete','directory.create','directory.delete'] }, summary: { type: 'string', maxLength: 400 } }, additionalProperties: false } },
    { name: 'mission_supervisor_gate_set', description: 'Record supervisor-gate state only. The gate never overrides IRIS permission policy.', inputSchema: { type: 'object', required: ['missionId','state'], properties: { missionId: { type: 'string' }, state: { enum: ['NOT_REQUIRED','PENDING','APPROVED','DENIED'] }, reason: { type: ['string','null'], maxLength: 500 } }, additionalProperties: false } },
    { name: 'file_read', description: 'Read one bounded regular file from the live session project; may bind to a prepared mission action.', inputSchema: { type: 'object', required: ['targetPath'], properties: projectProperties, additionalProperties: false } },
    { name: 'file_write', description: 'Create or replace one bounded regular file in the live session project; may bind to a prepared mission action.', inputSchema: { type: 'object', required: ['targetPath', 'content'], properties: { ...projectProperties, content: { type: 'string' } }, additionalProperties: false } },
    { name: 'file_delete', description: 'Delete one regular file in the live session project; may bind to a prepared mission action.', inputSchema: { type: 'object', required: ['targetPath'], properties: projectProperties, additionalProperties: false } },
    { name: 'directory_create', description: 'Create one directory whose parent already exists inside the live session project; may bind to a prepared mission action.', inputSchema: { type: 'object', required: ['targetPath'], properties: projectProperties, additionalProperties: false } },
    { name: 'directory_delete', description: 'Remove one empty directory inside the live session project; may bind to a prepared mission action.', inputSchema: { type: 'object', required: ['targetPath'], properties: projectProperties, additionalProperties: false } },
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

function optionalMissionAssociation(args: Record<string, unknown>): MissionExecutionAssociation | undefined {
  const values = [args.missionId, args.taskId, args.actionId];
  if (values.every((value) => value === undefined)) return undefined;
  if (!values.every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('missionId, taskId, and actionId must be supplied together');
  }
  return { missionId: String(args.missionId), taskId: String(args.taskId), actionId: String(args.actionId) };
}

function missionState(record: Record<string, unknown>, name: string): MissionState {
  const value = record[name];
  if (value === 'PLANNED' || value === 'RUNNING' || value === 'WAITING_APPROVAL' || value === 'WAITING_SUPERVISOR'
    || value === 'PAUSED' || value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED') return value;
  throw new Error(`${name} is not a supported mission state`);
}

function missionTaskState(record: Record<string, unknown>, name: string): MissionTaskState {
  const value = record[name];
  if (value === 'PENDING' || value === 'RUNNING' || value === 'BLOCKED' || value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED') return value;
  throw new Error(`${name} is not a supported mission task state`);
}

function supervisorGateState(record: Record<string, unknown>, name: string): SupervisorGateState {
  const value = record[name];
  if (value === 'NOT_REQUIRED' || value === 'PENDING' || value === 'APPROVED' || value === 'DENIED') return value;
  throw new Error(`${name} is not a supported supervisor gate state`);
}

function missionActionCapability(record: Record<string, unknown>, name: string): 'file.read' | 'file.write' | 'file.delete' | 'directory.create' | 'directory.delete' {
  const value = record[name];
  if (value === 'file.read' || value === 'file.write' || value === 'file.delete' || value === 'directory.create' || value === 'directory.delete') return value;
  throw new Error(`${name} is not a supported governed mission capability`);
}

function optionalNullableString(record: Record<string, unknown>, name: string): string | null {
  const value = record[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string or null`);
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
