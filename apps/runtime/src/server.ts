import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RuntimeError, type DoctorReport, type RuntimeHealth, type RuntimeIdentity } from '@iris/domain';
import { handleMcpRequest } from './mcp.js';
import type { RuntimeState } from './state.js';

export const LOOPBACK_ADDRESS = '127.0.0.1' as const;
export const CLIENT_ID_HEADER = 'x-iris-client-id' as const;
const MAX_BODY_BYTES = 64 * 1024;

export interface RuntimeServerContext {
  readonly identity: RuntimeIdentity;
  readonly state: RuntimeState;
  readonly health: () => RuntimeHealth;
  readonly doctor: () => Promise<DoctorReport>;
  readonly isShuttingDown: () => boolean;
  readonly controlToken: string;
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

export async function startRuntimeServer(
  context: RuntimeServerContext,
  preferredPort: number,
): Promise<RuntimeServerHandle> {
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
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
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

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RuntimeServerContext,
): Promise<void> {
  if (!hostAllowed(request.headers.host)) {
    writeJson(response, 403, { error: { code: 'INVALID_REQUEST', message: 'Host header is not loopback' } });
    return;
  }
  if (!originAllowed(request.headers.origin)) {
    writeJson(response, 403, { error: { code: 'INVALID_REQUEST', message: 'Browser origin is not loopback' } });
    return;
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    writeJson(response, 403, { error: { code: 'INVALID_REQUEST', message: 'Cross-site browser requests are not allowed' } });
    return;
  }
  if (context.isShuttingDown()) {
    writeJson(response, 503, { error: { code: 'RUNTIME_SHUTTING_DOWN', message: 'Runtime is shutting down' } });
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if ((request.method === 'POST' || request.method === 'PUT') && url.pathname !== '/mcp') {
    requireJsonContentType(request);
  }

  if (url.pathname === '/mcp') {
    requireJsonContentType(request);
    const body = await readBody(request);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const mcpRequest = new Request('http://127.0.0.1/mcp', {
      method: request.method ?? 'GET',
      headers,
      body: body.length === 0 ? null : body,
    });
    await writeFetchResponse(response, await handleMcpRequest(mcpRequest, context.state, context.health));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/control/stop') {
    const body = await readJsonBody(request);
    authorizeStop(request, body, context);
    writeJsonThen(response, 202, {
      accepted: true,
      runtimeId: context.identity.runtimeId,
      instanceId: context.identity.instanceId,
    }, context.requestShutdown);
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
  if (request.method === 'POST' && url.pathname === '/projects') {
    const body = await readJsonBody(request);
    const project = await context.state.registerProject(stringField(body, 'name'), stringField(body, 'rootPath'));
    writeJson(response, 201, project);
    return;
  }
  if (request.method === 'PUT' && url.pathname === '/projects/default') {
    const body = await readJsonBody(request);
    const projectId = nullableStringField(body, 'projectId');
    await context.state.setDefaultProject(projectId);
    writeJson(response, 200, { defaultProjectId: projectId });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/sessions') {
    const body = await readJsonBody(request, true);
    const clientId = body === null ? undefined : optionalStringField(body, 'clientId');
    writeJson(response, 201, context.state.createSession(clientId));
    return;
  }

  const currentProjectMatch = /^\/sessions\/([^/]+)\/current-project$/.exec(url.pathname);
  if (currentProjectMatch !== null && request.method === 'PUT') {
    const body = await readJsonBody(request);
    const sessionId = decodeURIComponent(currentProjectMatch[1]!);
    const clientId = requiredClientId(request);
    writeJson(response, 200, await context.state.setSessionCurrentProject(
      sessionId,
      clientId,
      nullableStringField(body, 'projectId'),
    ));
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
      context.state.deleteSession(sessionId, clientId);
      response.writeHead(204, securityHeaders()).end();
      return;
    }
  }

  writeJson(response, 404, { error: { code: 'INVALID_REQUEST', message: 'Route not found' } });
}

function authorizeStop(
  request: IncomingMessage,
  body: Record<string, unknown> | null,
  context: RuntimeServerContext,
): void {
  const authorization = request.headers.authorization;
  const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  if (!tokensEqual(supplied, context.controlToken)) {
    throw new RuntimeError('CONTROL_DENIED', 'Runtime control token is invalid');
  }
  if (stringField(body, 'runtimeId') !== context.identity.runtimeId
    || stringField(body, 'instanceId') !== context.identity.instanceId) {
    throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime control request does not identify this daemon instance');
  }
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJsonBody(
  request: IncomingMessage,
  allowEmpty = false,
): Promise<Record<string, unknown> | null> {
  const body = await readBody(request);
  if (body.length === 0 && allowEmpty) return null;
  try {
    const value = JSON.parse(body) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not object');
    return value as Record<string, unknown>;
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

function hostAllowed(host: string | undefined): boolean {
  if (host === undefined) return false;
  return /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host.trim());
}

function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && (parsed.hostname === LOOPBACK_ADDRESS || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

function requireJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new RuntimeError('INVALID_REQUEST', 'Mutation requests require application/json');
  }
}

function requiredClientId(request: IncomingMessage): string {
  const value = request.headers[CLIENT_ID_HEADER];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeError('CONTROL_DENIED', `${CLIENT_ID_HEADER} is required for session access`);
  }
  return value;
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

function nullableStringField(body: Record<string, unknown> | null, name: string): string | null {
  const value = body?.[name];
  if (value === null) return null;
  if (typeof value !== 'string') throw new RuntimeError('INVALID_REQUEST', `${name} must be a string or null`);
  return value;
}

function securityHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  };
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

function writeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const runtimeError = error instanceof RuntimeError
    ? error
    : new RuntimeError('INVALID_REQUEST', 'Runtime request failed', { cause: error });
  const status = runtimeError.code === 'SESSION_NOT_FOUND' || runtimeError.code === 'PROJECT_NOT_FOUND'
    ? 404
    : runtimeError.code === 'CONTROL_DENIED'
      ? 403
      : runtimeError.code === 'AUTHORITY_CHANGED'
        ? 409
        : runtimeError.code === 'INVALID_REQUEST' || runtimeError.code === 'INVALID_PROJECT_PATH'
          ? 400
          : 500;
  writeJson(response, status, { error: { code: runtimeError.code, message: runtimeError.message } });
}

async function writeFetchResponse(response: ServerResponse, fetchResponse: Response): Promise<void> {
  response.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, key) => response.setHeader(key, value));
  for (const [name, value] of Object.entries(securityHeaders())) response.setHeader(name, value);
  response.end(Buffer.from(await fetchResponse.arrayBuffer()));
}
