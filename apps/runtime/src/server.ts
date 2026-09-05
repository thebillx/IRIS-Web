import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RuntimeError, type AgentRole, type DoctorReport, type PermissionMode, type RuntimeHealth, type RuntimeIdentity } from '@iris/domain';
import { handleMcpRequest } from './mcp.js';
import type { CapabilityOutcome, CapabilityService, OwnerApprovalChoice } from './capability-service.js';
import type { RuntimeState } from './state.js';

export const LOOPBACK_ADDRESS = '127.0.0.1' as const;
export const CLIENT_ID_HEADER = 'x-iris-client-id' as const;
export const SESSION_ID_HEADER = 'x-iris-session-id' as const;
const MAX_BODY_BYTES = 64 * 1024;

export interface RuntimeServerContext {
  readonly identity: RuntimeIdentity;
  readonly state: RuntimeState;
  readonly capabilities: CapabilityService;
  readonly health: () => RuntimeHealth;
  readonly doctor: () => Promise<DoctorReport>;
  readonly isShuttingDown: () => boolean;
  readonly controlSecret: string;
  readonly ownerAccessSecret: string;
  readonly requestShutdown: () => void;
}

export interface RuntimeServerHandle {
  readonly server: Server;
  readonly apiUrl: string;
  readonly mcpUrl: string;
  readonly port: number;
  close(): Promise<void>;
}

export function requireLoopbackAddress(address: string): typeof LOOPBACK_ADDRESS {
  if (address !== LOOPBACK_ADDRESS) throw new Error(`IRIS runtime must bind to ${LOOPBACK_ADDRESS}`);
  return LOOPBACK_ADDRESS;
}

export async function startRuntimeServer(context: RuntimeServerContext, preferredPort: number): Promise<RuntimeServerHandle> {
  requirePort(preferredPort);
  const server = createServer((request, response) => {
    void routeRequest(request, response, context).catch((error: unknown) => writeError(response, error));
  });
  const port = await listenWithFallback(server, preferredPort);
  const apiUrl = `http://${LOOPBACK_ADDRESS}:${port}`;
  return {
    server,
    apiUrl,
    mcpUrl: `${apiUrl}/mcp`,
    port,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function listenWithFallback(server: Server, preferredPort: number): Promise<number> {
  try {
    return await listen(server, preferredPort);
  } catch (error: unknown) {
    if (preferredPort !== 0 && isAddressInUse(error)) return listen(server, 0);
    throw new RuntimeError('PORT_UNAVAILABLE', 'IRIS runtime could not bind its loopback listener', { cause: error });
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      if (typeof address !== 'object' || address === null || address.address !== LOOPBACK_ADDRESS) {
        reject(new RuntimeError('PORT_UNAVAILABLE', 'Runtime listener did not bind to IPv4 loopback'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: LOOPBACK_ADDRESS, port });
  });
}

async function routeRequest(request: IncomingMessage, response: ServerResponse, context: RuntimeServerContext): Promise<void> {
  if (!hostAllowed(request.headers.host)) {
    writeJson(response, 403, { error: { code: 'CONTROL_DENIED', message: 'Host header is not loopback' } });
    return;
  }
  if (!originAllowed(request.headers.origin)) {
    writeJson(response, 403, { error: { code: 'CONTROL_DENIED', message: 'Origin is not loopback' } });
    return;
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    writeJson(response, 403, { error: { code: 'CONTROL_DENIED', message: 'Cross-site browser requests are not allowed' } });
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/control/stop') {
    requireJsonContentType(request);
    const body = await readJsonBody(request);
    authorizeRuntimeControl(request, body, context);
    writeJsonThen(response, 202, { accepted: true, runtimeId: context.identity.runtimeId, instanceId: context.identity.instanceId }, context.requestShutdown);
    return;
  }
  if (context.isShuttingDown()) {
    writeJson(response, 503, { error: { code: 'RUNTIME_SHUTTING_DOWN', message: 'Runtime is shutting down' } });
    return;
  }

  const publicObservation = request.method === 'GET'
    && (url.pathname === '/health' || url.pathname === '/status' || url.pathname === '/doctor');
  if (!publicObservation) authorizeOwnerAccess(request, context.ownerAccessSecret);

  if ((request.method === 'POST' || request.method === 'PUT') && url.pathname !== '/mcp') requireJsonContentType(request);

  if (url.pathname === '/mcp') {
    if (request.method === 'POST') requireJsonContentType(request);
    const body = request.method === 'POST' ? await readBody(request) : '';
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const init: RequestInit = { method: request.method ?? 'GET', headers };
    if (body.length > 0) init.body = body;
    const mcpResponse = await handleMcpRequest(new Request('http://127.0.0.1/mcp', init), context.capabilities);
    await writeFetchResponse(response, mcpResponse);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    writeJson(response, 200, context.health());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/status') {
    writeJson(response, 200, { identity: context.identity, health: context.health() });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/doctor') {
    writeJson(response, 200, await context.doctor());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/projects') {
    writeJson(response, 200, {
      projects: await context.state.listProjects(),
      defaultProjectId: await context.state.getDefaultProjectId(),
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/permissions') {
    writeJson(response, 200, {
      ...(await context.capabilities.permissionSnapshot()),
      recentDecisions: await context.capabilities.recentAudit(20),
      pendingApprovals: context.capabilities.listPendingApprovals(),
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/permissions/audit') {
    const requestedLimit = Number(url.searchParams.get('limit') ?? '50');
    writeJson(response, 200, { events: await context.capabilities.recentAudit(Number.isFinite(requestedLimit) ? requestedLimit : 50) });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/approvals') {
    writeJson(response, 200, { approvals: context.capabilities.listPendingApprovals() });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/permissions/mode') {
    const body = await readJsonBody(request);
    await writeCapabilityOutcome(response, await context.capabilities.execute({
      capabilityId: 'policy.mode.set',
      mode: permissionModeField(body, 'mode'),
      clientId: optionalClientId(request),
      sessionId: optionalSessionId(request),
    }));
    return;
  }
  const approvalMatch = /^\/approvals\/([^/]+)$/.exec(url.pathname);
  if (approvalMatch !== null && request.method === 'POST') {
    const body = await readJsonBody(request);
    await writeCapabilityOutcome(
      response,
      await context.capabilities.resolveApproval(decodeURIComponent(approvalMatch[1]!), approvalChoiceField(body, 'decision')),
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/projects') {
    const body = await readJsonBody(request);
    await writeCapabilityOutcome(response, await context.capabilities.execute({
      capabilityId: 'project.register',
      name: stringField(body, 'name'),
      rootPath: stringField(body, 'rootPath'),
      clientId: optionalClientId(request),
      sessionId: optionalSessionId(request),
    }), 201);
    return;
  }
  if (request.method === 'PUT' && url.pathname === '/projects/default') {
    const body = await readJsonBody(request);
    await writeCapabilityOutcome(response, await context.capabilities.execute({
      capabilityId: 'project.default.set',
      projectId: nullableStringField(body, 'projectId'),
      clientId: optionalClientId(request),
      sessionId: optionalSessionId(request),
    }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/sessions') {
    const clientId = requiredClientId(request);
    writeJson(response, 200, { sessions: context.state.listSessionsForClient(clientId) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/sessions') {
    const body = await readJsonBody(request, true);
    await writeCapabilityOutcome(response, await context.capabilities.execute({
      capabilityId: 'session.create',
      clientId: body === null ? undefined : optionalStringField(body, 'clientId'),
      agentId: body === null ? undefined : optionalStringField(body, 'agentId'),
      agentRole: body === null ? undefined : optionalAgentRoleField(body, 'agentRole'),
    }), 201);
    return;
  }

  const sessionMatch = /^\/sessions\/([^/]+)$/.exec(url.pathname);
  if (sessionMatch !== null) {
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    const clientId = requiredClientId(request);
    if (request.method === 'GET') {
      writeJson(response, 200, context.state.getSessionForClient(sessionId, clientId));
      return;
    }
    if (request.method === 'DELETE') {
      await writeCapabilityOutcome(response, await context.capabilities.execute({ capabilityId: 'session.delete', sessionId, clientId }));
      return;
    }
  }

  const instructionMatch = /^\/sessions\/([^/]+)\/instructions$/.exec(url.pathname);
  if (instructionMatch !== null && request.method === 'POST') {
    const body = await readJsonBody(request);
    await writeCapabilityOutcome(response, await context.capabilities.execute({
      capabilityId: 'session.instruction.submit',
      sessionId: decodeURIComponent(instructionMatch[1]!),
      clientId: requiredClientId(request),
      submissionId: stringField(body, 'submissionId'),
      instruction: stringField(body, 'instruction'),
    }));
    return;
  }

  const currentProjectMatch = /^\/sessions\/([^/]+)\/current-project$/.exec(url.pathname);
  if (currentProjectMatch !== null && request.method === 'PUT') {
    const body = await readJsonBody(request);
    await writeCapabilityOutcome(response, await context.capabilities.execute({
      capabilityId: 'session.current_project.set',
      sessionId: decodeURIComponent(currentProjectMatch[1]!),
      clientId: requiredClientId(request),
      projectId: nullableStringField(body, 'projectId'),
    }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/capabilities/file/read') {
    const body = await readJsonBody(request);
    await writeCapabilityOutcome(response, await context.capabilities.execute({
      capabilityId: 'file.read', clientId: requiredClientId(request), sessionId: requiredSessionId(request),
      projectId: optionalStringField(body!, 'projectId'), targetPath: stringField(body, 'targetPath'),
    }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/capabilities/file/write') {
    const body = await readJsonBody(request);
    await writeCapabilityOutcome(response, await context.capabilities.execute({
      capabilityId: 'file.write', clientId: requiredClientId(request), sessionId: requiredSessionId(request),
      projectId: optionalStringField(body!, 'projectId'), targetPath: stringField(body, 'targetPath'), content: stringField(body, 'content'),
    }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/capabilities/file/delete') {
    const body = await readJsonBody(request);
    await writeCapabilityOutcome(response, await context.capabilities.execute({
      capabilityId: 'file.delete', clientId: requiredClientId(request), sessionId: requiredSessionId(request),
      projectId: optionalStringField(body!, 'projectId'), targetPath: stringField(body, 'targetPath'),
    }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/capabilities/directory/create') {
    const body = await readJsonBody(request);
    await writeCapabilityOutcome(response, await context.capabilities.execute({
      capabilityId: 'directory.create', clientId: requiredClientId(request), sessionId: requiredSessionId(request),
      projectId: optionalStringField(body!, 'projectId'), targetPath: stringField(body, 'targetPath'),
    }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/capabilities/directory/delete') {
    const body = await readJsonBody(request);
    await writeCapabilityOutcome(response, await context.capabilities.execute({
      capabilityId: 'directory.delete', clientId: requiredClientId(request), sessionId: requiredSessionId(request),
      projectId: optionalStringField(body!, 'projectId'), targetPath: stringField(body, 'targetPath'),
    }));
    return;
  }

  writeJson(response, 404, { error: { code: 'INVALID_REQUEST', message: 'Route not found' } });
}

async function readJsonBody(request: IncomingMessage, allowEmpty = false): Promise<Record<string, unknown> | null> {
  const body = await readBody(request);
  if (body.length === 0 && allowEmpty) return null;
  try {
    const value = JSON.parse(body) as unknown;
    if (!isRecord(value)) throw new Error('not object');
    return value;
  } catch (error) {
    throw new RuntimeError('INVALID_REQUEST', 'Request body must be a JSON object', { cause: error });
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RuntimeError('INVALID_REQUEST', 'Request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requiredClientId(request: IncomingMessage): string {
  const value = optionalClientId(request);
  if (value === undefined) throw new RuntimeError('CONTROL_DENIED', `${CLIENT_ID_HEADER} is required for session access`);
  return value;
}

function optionalClientId(request: IncomingMessage): string | undefined {
  return optionalIdentityHeader(request.headers[CLIENT_ID_HEADER], CLIENT_ID_HEADER);
}

function requiredSessionId(request: IncomingMessage): string {
  const value = optionalSessionId(request);
  if (value === undefined) throw new RuntimeError('CONTROL_DENIED', `${SESSION_ID_HEADER} is required for capability execution`);
  return value;
}

function optionalSessionId(request: IncomingMessage): string | undefined {
  return optionalIdentityHeader(request.headers[SESSION_ID_HEADER], SESSION_ID_HEADER);
}

function optionalIdentityHeader(value: string | string[] | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RuntimeError('CONTROL_DENIED', `${name} must be a single value`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200 || normalized.includes('\0')) {
    throw new RuntimeError('CONTROL_DENIED', `${name} is invalid`);
  }
  return normalized;
}

function hostAllowed(host: string | undefined): boolean {
  return typeof host === 'string' && /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host.trim());
}

function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

function requireJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers['content-type'];
  const mediaType = typeof contentType === 'string' ? contentType.split(';', 1)[0]?.trim().toLowerCase() : undefined;
  if (mediaType !== 'application/json') {
    throw new RuntimeError('INVALID_REQUEST', 'Mutation requests require application/json');
  }
}

function requirePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RuntimeError('PORT_UNAVAILABLE', 'Runtime port must be an integer from 0 through 65535');
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

function stringField(body: Record<string, unknown> | null, name: string): string {
  const value = body?.[name];
  if (typeof value !== 'string') throw new RuntimeError('INVALID_REQUEST', `${name} must be a string`);
  return value;
}

function optionalStringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RuntimeError('INVALID_REQUEST', `${name} must be a string`);
  return value;
}

function optionalAgentRoleField(body: Record<string, unknown>, name: string): AgentRole | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (value === 'owner' || value === 'planner' || value === 'implementer' || value === 'reviewer'
    || value === 'security' || value === 'explorer' || value === 'other') return value;
  throw new RuntimeError('INVALID_REQUEST', `${name} is not a supported agent role`);
}

function nullableStringField(body: Record<string, unknown> | null, name: string): string | null {
  const value = body?.[name];
  if (value === null) return null;
  if (typeof value !== 'string') throw new RuntimeError('INVALID_REQUEST', `${name} must be a string or null`);
  return value;
}

function permissionModeField(body: Record<string, unknown> | null, name: string): PermissionMode {
  const value = body?.[name];
  if (value === 'ASK_EVERY_TIME' || value === 'AUTO_APPROVE_LOW_RISK'
    || value === 'AUTO_APPROVE_PROJECT_SCOPED' || value === 'FULL_LOCAL_OWNER') return value;
  throw new RuntimeError('INVALID_REQUEST', `${name} is not a supported permission mode`);
}

function approvalChoiceField(body: Record<string, unknown> | null, name: string): OwnerApprovalChoice {
  const value = body?.[name];
  if (value === 'ALLOW_ONCE' || value === 'ALWAYS_ALLOW_PROJECT' || value === 'DENY') return value;
  throw new RuntimeError('INVALID_REQUEST', `${name} is not a supported approval decision`);
}

async function writeCapabilityOutcome(response: ServerResponse, outcome: CapabilityOutcome, executedStatus = 200): Promise<void> {
  if (outcome.status === 'executed') {
    writeJson(response, executedStatus, outcome.value);
    return;
  }
  if (outcome.status === 'owner_required') {
    writeJson(response, 409, { error: { code: 'OWNER_DECISION_REQUIRED', message: 'Owner approval is required before this action can execute' }, approval: outcome.approval });
    return;
  }
  writeJson(response, 403, { error: { code: 'CAPABILITY_DENIED', message: outcome.reason } });
}

function authorizeOwnerAccess(request: IncomingMessage, secret: string): void {
  const authorization = request.headers.authorization;
  const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  if (!secretsEqual(supplied, secret)) throw new RuntimeError('CONTROL_DENIED', 'Owner access credential is required');
}

function authorizeRuntimeControl(request: IncomingMessage, body: Record<string, unknown> | null, context: RuntimeServerContext): void {
  const authorization = request.headers.authorization;
  const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  if (!secretsEqual(supplied, context.controlSecret)) throw new RuntimeError('CONTROL_DENIED', 'Runtime control credential is invalid');
  if (stringField(body, 'runtimeId') !== context.identity.runtimeId || stringField(body, 'instanceId') !== context.identity.instanceId) {
    throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime control request does not identify the active daemon instance');
  }
}

function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...securityHeaders(),
  });
  response.end(JSON.stringify(value));
}

function writeJsonThen(response: ServerResponse, status: number, value: unknown, after: () => void): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...securityHeaders(),
  });
  response.end(JSON.stringify(value), () => setImmediate(after));
}

function securityHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  };
}

function writeError(response: ServerResponse, error: unknown): void {
  const runtimeError = error instanceof RuntimeError
    ? error
    : new RuntimeError('INVALID_REQUEST', 'Runtime request failed', { cause: error });
  const status = runtimeError.code === 'SESSION_NOT_FOUND' || runtimeError.code === 'PROJECT_NOT_FOUND' || runtimeError.code === 'APPROVAL_NOT_FOUND'
    ? 404
    : runtimeError.code === 'CONTROL_DENIED' || runtimeError.code === 'CAPABILITY_DENIED'
      ? 403
      : runtimeError.code === 'OWNER_DECISION_REQUIRED' || runtimeError.code === 'SESSION_BUSY'
        ? 409
        : runtimeError.code === 'INVALID_REQUEST' || runtimeError.code === 'INVALID_PROJECT_PATH'
          ? 400
          : runtimeError.code === 'RUNTIME_SHUTTING_DOWN'
            ? 503
            : 500;
  writeJson(response, status, { error: { code: runtimeError.code, message: runtimeError.message } });
}

async function writeFetchResponse(response: ServerResponse, fetchResponse: Response): Promise<void> {
  response.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, key) => response.setHeader(key, value));
  for (const [key, value] of Object.entries(securityHeaders())) {
    if (!response.hasHeader(key)) response.setHeader(key, value);
  }
  response.end(Buffer.from(await fetchResponse.arrayBuffer()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
