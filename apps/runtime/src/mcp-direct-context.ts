import { RuntimeError } from '@iris/domain';
import type { McpPrincipal } from './mcp.js';
import type { RuntimeState } from './state.js';

const CLIENT_ID_HEADER = 'x-iris-client-id';
const SESSION_ID_HEADER = 'x-iris-session-id';

export interface DirectSessionIdentity {
  readonly clientId: string;
  readonly sessionId: string;
}

export async function resolveDirectSessionIdentity(
  args: Record<string, unknown>,
  request: Request,
  state: RuntimeState | undefined,
  projectId: string,
  principal: McpPrincipal = 'owner',
): Promise<DirectSessionIdentity> {
  const clientId = requiredHeader(request, CLIENT_ID_HEADER);
  const argumentSessionId = optionalBoundedString(args, 'sessionId', 200);
  const headerSessionId = optionalHeader(request, SESSION_ID_HEADER);
  if (argumentSessionId !== undefined && headerSessionId !== undefined && argumentSessionId !== headerSessionId) {
    throw new RuntimeError('CONTROL_DENIED', 'sessionId argument does not match x-iris-session-id');
  }
  if (state === undefined) throw new RuntimeError('INVALID_REQUEST', 'IRIS session validation is unavailable');

  const explicitSessionId = argumentSessionId ?? headerSessionId;
  if (explicitSessionId !== undefined) {
    const session = state.getSessionForClient(explicitSessionId, clientId);
    if (session.currentProjectId !== projectId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Requested project does not match the live session project');
    }
    return { clientId, sessionId: explicitSessionId };
  }

  if (principal !== 'tunnel-service') {
    throw new RuntimeError('INVALID_REQUEST', 'IRIS session is required for non-connector callers; call session_open first.');
  }
  const project = (await state.listProjects()).find((candidate) => candidate.id === projectId);
  if (project === undefined) throw new RuntimeError('PROJECT_NOT_FOUND', 'Requested project is not registered');

  const reusable = state.listSessionsForClient(clientId)
    .filter((session) => session.agentId === 'iris-tunnel-service' && session.currentProjectId === projectId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (reusable !== undefined) return { clientId, sessionId: reusable.id };

  const created = state.createSession(clientId, 'iris-tunnel-service', 'other');
  await state.setSessionCurrentProject(created.id, created.clientId, projectId);
  return { clientId, sessionId: created.id };
}

function requiredHeader(request: Request, name: string): string {
  const value = optionalHeader(request, name);
  if (value === undefined) throw new RuntimeError('INVALID_REQUEST', `${name} is required`);
  return value;
}

function optionalHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 200 || value.includes('\0')) throw new RuntimeError('INVALID_REQUEST', `${name} is invalid`);
  return value;
}

function optionalBoundedString(record: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', `${name} must be a bounded non-empty string`);
  }
  return value;
}
