import { RuntimeError } from '@iris/domain';
import type { CapabilityService } from './capability-service.js';
import type { MissionBrokerService } from './mission-broker.js';
import type { RuntimeState } from './state.js';

export const HERMES_MCP_PROTOCOL_VERSION = '2025-11-25' as const;

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

const TOOLS = [
  runtimeStatusTool(), missionGetTool(), projectGitStatusTool(), projectFileReadTool(), projectTestRunTool(),
  missionTaskCreateTool(), missionActionPrepareTool(), projectFileWriteTool(),
] as const;

type MissionContext = Awaited<ReturnType<typeof resolveMissionContext>>;

export async function handleHermesMcpRequest(
  request: Request,
  missionId: string,
  state: RuntimeState,
  broker: MissionBrokerService,
  capabilities: CapabilityService,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  let rpc: JsonRpcRequest;
  try {
    rpc = await request.json() as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return rpcError(rpc.id ?? null, -32600, 'Invalid Request', 400);

  if (rpc.method === 'initialize') {
    return rpcResult(rpc.id ?? null, {
      protocolVersion: HERMES_MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'iris-hermes-governed-bridge', version: '0.0.0' },
    });
  }
  if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (rpc.method === 'ping') return rpcResult(rpc.id ?? null, {});
  if (rpc.method === 'tools/list') return rpcResult(rpc.id ?? null, { tools: TOOLS });
  if (rpc.method !== 'tools/call') {
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    return rpcError(rpc.id, -32601, 'Method not found', 404);
  }

  const params = isRecord(rpc.params) ? rpc.params : null;
  if (params === null || typeof params.name !== 'string') return rpcError(rpc.id ?? null, -32602, 'Tool name is required', 400);
  const args = params.arguments === undefined ? {} : params.arguments;
  if (!isRecord(args)) return rpcError(rpc.id ?? null, -32602, 'Tool arguments must be an object', 400);
  if (!TOOLS.some((tool) => tool.name === params.name)) return rpcError(rpc.id ?? null, -32602, 'Tool is not exposed by the governed Hermes adapter', 400);

  try {
    const context = await resolveMissionContext(missionId, state, broker);
    const result = await executeTool(params.name, args, context, capabilities);
    return rpcResult(rpc.id ?? null, result);
  } catch (error) {
    const message = error instanceof RuntimeError ? error.message : 'Governed Hermes tool execution failed';
    const code = error instanceof RuntimeError ? error.code : 'CAPABILITY_DENIED';
    return rpcResult(rpc.id ?? null, toolError(code, message));
  }
}

async function resolveMissionContext(missionId: string, state: RuntimeState, broker: MissionBrokerService) {
  const mapping = await broker.get(missionId);
  if (mapping.state === 'COMPLETED') throw new RuntimeError('CAPABILITY_DENIED', 'Completed mission cannot execute additional Hermes tools');
  const mission = await state.getMission(missionId);
  if (mission.projectId === null) throw new RuntimeError('CAPABILITY_DENIED', 'Mission has no bound project');
  const project = (await state.listProjects()).find((candidate) => candidate.id === mission.projectId);
  if (project === undefined) throw new RuntimeError('CAPABILITY_DENIED', 'Mission project is no longer registered');
  if (project.rootPath !== mapping.worktreePath) throw new RuntimeError('CAPABILITY_DENIED', 'Mission worktree mapping does not match its registered project');
  const session = state.getSessionForClient(mission.sessionId, mission.clientId);
  if (session.currentProjectId !== mission.projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Mission session is no longer bound to the mission project');
  return { mapping, mission, project, session };
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: MissionContext,
  capabilities: CapabilityService,
) {
  const { mission } = context;
  if (name === 'runtime_status') {
    requireNoArguments(args, name);
    return outcomeResult(await capabilities.execute({ capabilityId: 'runtime.status', clientId: mission.clientId, sessionId: mission.sessionId }));
  }
  if (name === 'mission_get') {
    requireNoArguments(args, name);
    return outcomeResult(await capabilities.execute({ capabilityId: 'mission.get', clientId: mission.clientId, sessionId: mission.sessionId, missionId: mission.id }));
  }
  if (name === 'project_git_status') {
    requireNoArguments(args, name);
    return outcomeResult(await capabilities.execute({ capabilityId: 'project.git_status', clientId: mission.clientId, sessionId: mission.sessionId, projectId: mission.projectId ?? undefined }));
  }
  if (name === 'project_test_run') {
    const taskId = requiredString(args, 'taskId', 200);
    const actionId = requiredString(args, 'actionId', 200);
    onlyArguments(args, ['taskId', 'actionId'], name);
    return outcomeResult(await capabilities.execute({
      capabilityId: 'project.test.run', clientId: mission.clientId, sessionId: mission.sessionId,
      projectId: mission.projectId ?? undefined, mission: { missionId: mission.id, taskId, actionId },
    }));
  }
  if (name === 'project_file_read') {
    const targetPath = requiredString(args, 'targetPath', 4096);
    onlyArguments(args, ['targetPath'], name);
    return outcomeResult(await capabilities.execute({
      capabilityId: 'file.read', clientId: mission.clientId, sessionId: mission.sessionId,
      projectId: mission.projectId ?? undefined, targetPath,
    }));
  }
  if (name === 'mission_task_create') {
    const title = requiredString(args, 'title', 240);
    onlyArguments(args, ['title'], name);
    return outcomeResult(await capabilities.execute({
      capabilityId: 'mission.task.create', clientId: mission.clientId, sessionId: mission.sessionId,
      missionId: mission.id, title,
    }));
  }
  if (name === 'mission_action_prepare') {
    const taskId = requiredString(args, 'taskId', 200);
    const capabilityId = requiredString(args, 'capabilityId', 200);
    const summary = requiredString(args, 'summary', 400);
    onlyArguments(args, ['taskId', 'capabilityId', 'summary'], name);
    if (capabilityId !== 'file.write' && capabilityId !== 'project.test.run') throw new RuntimeError('CAPABILITY_DENIED', 'This V2 profile exposes only file.write and project.test.run mission actions');
    return outcomeResult(await capabilities.execute({
      capabilityId: 'mission.action.prepare', clientId: mission.clientId, sessionId: mission.sessionId,
      missionId: mission.id, taskId, actionCapabilityId: capabilityId, summary,
    }));
  }
  if (name === 'project_file_write') {
    const taskId = requiredString(args, 'taskId', 200);
    const actionId = requiredString(args, 'actionId', 200);
    const targetPath = requiredString(args, 'targetPath', 4096);
    const content = requiredString(args, 'content', 1024 * 1024, false);
    onlyArguments(args, ['taskId', 'actionId', 'targetPath', 'content'], name);
    return outcomeResult(await capabilities.execute({
      capabilityId: 'file.write', clientId: mission.clientId, sessionId: mission.sessionId,
      projectId: mission.projectId ?? undefined, targetPath, content,
      mission: { missionId: mission.id, taskId, actionId },
    }));
  }
  throw new RuntimeError('CAPABILITY_DENIED', 'Hermes tool is not implemented');
}

function outcomeResult(outcome: Awaited<ReturnType<CapabilityService['execute']>>) {
  if (outcome.status === 'executed') return toolResult(outcome.value);
  if (outcome.status === 'owner_required') {
    return toolError('OWNER_DECISION_REQUIRED', 'Owner approval is required before this exact action can execute', { approval: outcome.approval });
  }
  return toolError('CAPABILITY_DENIED', outcome.reason);
}

function runtimeStatusTool() {
  return { name: 'runtime_status', description: 'Read the current IRIS runtime health through the mission-bound governed capability path.', inputSchema: emptySchema(), annotations: { readOnlyHint: true } } as const;
}
function missionGetTool() {
  return { name: 'mission_get', description: 'Read the current durable IRIS mission record bound to this Hermes reasoning session.', inputSchema: emptySchema(), annotations: { readOnlyHint: true } } as const;
}
function projectGitStatusTool() {
  return { name: 'project_git_status', description: 'Read the branch and clean/dirty state of the mission-bound registered worktree through IRIS governance.', inputSchema: emptySchema(), annotations: { readOnlyHint: true } } as const;
}
function projectTestRunTool() {
  return {
    name: 'project_test_run', description: 'Run only the mission-bound project declared test script through IRIS governed execution. No arbitrary command is accepted.',
    inputSchema: { type: 'object', required: ['taskId', 'actionId'], additionalProperties: false, properties: { taskId: { type: 'string' }, actionId: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  } as const;
}
function projectFileReadTool() {
  return {
    name: 'project_file_read', description: 'Read one bounded regular file from the mission-bound project through IRIS path and permission governance.',
    inputSchema: { type: 'object', required: ['targetPath'], additionalProperties: false, properties: { targetPath: { type: 'string', description: 'Absolute file path physically contained by the mission-bound project.' } } },
    annotations: { readOnlyHint: true },
  } as const;
}
function missionTaskCreateTool() {
  return {
    name: 'mission_task_create', description: 'Register one orchestration task inside the current durable mission. This grants no local execution authority.',
    inputSchema: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', maxLength: 240 } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  } as const;
}
function missionActionPrepareTool() {
  return {
    name: 'mission_action_prepare', description: 'Prepare one exact governed file.write action identity. Preparation does not execute the mutation or satisfy owner approval.',
    inputSchema: {
      type: 'object', required: ['taskId', 'capabilityId', 'summary'], additionalProperties: false,
      properties: { taskId: { type: 'string' }, capabilityId: { enum: ['file.write', 'project.test.run'] }, summary: { type: 'string', maxLength: 400 } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  } as const;
}
function projectFileWriteTool() {
  return {
    name: 'project_file_write', description: 'Execute one prepared mission-bound file.write through IRIS permission and exact-action approval governance.',
    inputSchema: {
      type: 'object', required: ['taskId', 'actionId', 'targetPath', 'content'], additionalProperties: false,
      properties: { taskId: { type: 'string' }, actionId: { type: 'string' }, targetPath: { type: 'string' }, content: { type: 'string' } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  } as const;
}

function emptySchema() { return { type: 'object', properties: {}, additionalProperties: false } as const; }
function requireNoArguments(args: Record<string, unknown>, name: string): void { if (Object.keys(args).length !== 0) throw new RuntimeError('INVALID_REQUEST', `${name} does not accept arguments`); }
function onlyArguments(args: Record<string, unknown>, names: readonly string[], tool: string): void {
  const allowed = new Set(names);
  if (Object.keys(args).some((key) => !allowed.has(key))) throw new RuntimeError('INVALID_REQUEST', `${tool} received unsupported arguments`);
}
function requiredString(args: Record<string, unknown>, name: string, max: number, trim = true): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (trim && value.trim().length === 0)) {
    throw new RuntimeError('INVALID_REQUEST', `${name} must be a bounded string`);
  }
  return trim ? value.trim() : value;
}
function toolResult(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value, isError: false as const }; }
function toolError(code: string, message: string, extra: Record<string, unknown> = {}) {
  const structuredContent = { code, message, ...extra };
  return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true as const };
}
function rpcResult(id: string | number | null, result: unknown): Response { return json({ jsonrpc: '2.0', id, result }); }
function rpcError(id: string | number | null, code: number, message: string, status = 200): Response { return json({ jsonrpc: '2.0', id, error: { code, message } }, status); }
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
