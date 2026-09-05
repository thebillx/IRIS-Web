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
      serverInfo: { name: 'iris-hermes-readonly-bridge', version: '0.0.0' },
    });
  }
  if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (rpc.method === 'ping') return rpcResult(rpc.id ?? null, {});
  if (rpc.method === 'tools/list') return rpcResult(rpc.id ?? null, { tools: [projectGitStatusTool()] });
  if (rpc.method !== 'tools/call') {
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    return rpcError(rpc.id, -32601, 'Method not found', 404);
  }

  const params = isRecord(rpc.params) ? rpc.params : null;
  if (params === null || params.name !== 'project_git_status') return rpcError(rpc.id ?? null, -32602, 'Only project_git_status is exposed by this proof adapter', 400);
  const args = params.arguments === undefined ? {} : params.arguments;
  if (!isRecord(args) || Object.keys(args).length !== 0) return rpcError(rpc.id ?? null, -32602, 'project_git_status does not accept arguments', 400);

  try {
    const mapping = await broker.get(missionId);
    if (mapping.state === 'COMPLETED') throw new RuntimeError('CAPABILITY_DENIED', 'Completed mission cannot execute additional Hermes tools');
    const mission = await state.getMission(missionId);
    if (mission.projectId === null) throw new RuntimeError('CAPABILITY_DENIED', 'Mission has no bound project');
    const project = (await state.listProjects()).find((candidate) => candidate.id === mission.projectId);
    if (project === undefined) throw new RuntimeError('CAPABILITY_DENIED', 'Mission project is no longer registered');
    if (project.rootPath !== mapping.worktreePath) throw new RuntimeError('CAPABILITY_DENIED', 'Mission worktree mapping does not match its registered project');
    const session = state.getSessionForClient(mission.sessionId, mission.clientId);
    if (session.currentProjectId !== mission.projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Mission session is no longer bound to the mission project');

    const outcome = await capabilities.execute({
      capabilityId: 'project.git_status',
      clientId: mission.clientId,
      sessionId: mission.sessionId,
      projectId: mission.projectId,
    });
    if (outcome.status === 'executed') return rpcResult(rpc.id ?? null, toolResult(outcome.value));
    if (outcome.status === 'owner_required') return rpcResult(rpc.id ?? null, toolError('OWNER_DECISION_REQUIRED', 'Owner approval is required'));
    return rpcResult(rpc.id ?? null, toolError('CAPABILITY_DENIED', outcome.reason));
  } catch (error) {
    const message = error instanceof RuntimeError ? error.message : 'Governed project status inspection failed';
    const code = error instanceof RuntimeError ? error.code : 'CAPABILITY_DENIED';
    return rpcResult(rpc.id ?? null, toolError(code, message));
  }
}

function projectGitStatusTool() {
  return {
    name: 'project_git_status',
    description: 'Read the branch and clean/dirty state of the mission-bound registered worktree through IRIS governance.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  } as const;
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value, isError: false as const };
}

function toolError(code: string, message: string) {
  const structuredContent = { code, message };
  return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true as const };
}

function rpcResult(id: string | number | null, result: unknown): Response {
  return json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number | null, code: number, message: string, status = 200): Response {
  return json({ jsonrpc: '2.0', id, error: { code, message } }, status);
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
