import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RuntimeError, type AgentRole, type DoctorReport, type MissionState, type PermissionMode, type RuntimeHealth, type RuntimeIdentity, type SupervisorDecision } from '@iris/domain';
import { handleMcpRequest } from './mcp.js';
import type { CapabilityOutcome, CapabilityService, OwnerApprovalChoice } from './capability-service.js';
import type { RuntimeState } from './state.js';
import type { MissionBrokerService } from './mission-broker.js';
import { handleHermesMcpRequest } from './hermes-mcp.js';

export const LOOPBACK_ADDRESS = '127.0.0.1' as const;
export const CLIENT_ID_HEADER = 'x-iris-client-id' as const;
export const SESSION_ID_HEADER = 'x-iris-session-id' as const;
const MAX_BODY_BYTES = 64 * 1024;
const HERMES_MISSION_TOKEN_CONTEXT = 'iris-hermes-mcp-v2';

export function hermesMissionAccessToken(ownerAccessSecret: string, missionId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(missionId)) {
    throw new RuntimeError('INVALID_REQUEST', 'Mission identity is invalid');
  }
  return createHmac('sha256', ownerAccessSecret).update(`${HERMES_MISSION_TOKEN_CONTEXT}:${missionId}`).digest('base64url');
}

export interface RuntimeServerContext {
  readonly identity: RuntimeIdentity;
  readonly state: RuntimeState;
  readonly capabilities: CapabilityService;
  readonly missionBroker: MissionBrokerService;
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

  const hermesMcpMatch = /^\/hermes-mcp\/([^/]+)$/.exec(url.pathname);
  if (hermesMcpMatch !== null) {
    const missionId = decodeURIComponent(hermesMcpMatch[1]!);
    authorizeHermesMissionAccess(request, context.ownerAccessSecret, missionId);
    if (request.method === 'POST') requireJsonContentType(request);
    const body = request.method === 'POST' ? await readBody(request) : '';
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value);
    const init: RequestInit = { method: request.method ?? 'GET', headers };
    if (body.length > 0) init.body = body;
    const bridgeResponse = await handleHermesMcpRequest(
      new Request(`http://127.0.0.1${url.pathname}`, init),
      missionId,
      context.state,
      context.missionBroker,
      context.capabilities,
    );
    await writeFetchResponse(response, bridgeResponse);
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
    const mcpResponse = await handleMcpRequest(new Request('http://127.0.0.1/mcp', init), context.capabilities, context.state, context.missionBroker);
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
  if (request.method === 'GET' && url.pathname === '/missions') {
    const brokerRecords = await context.missionBroker.list();
    const brokerByMission = new Map(brokerRecords.map((record) => [record.missionId, record]));
    writeJson(response, 200, {
      missions: await Promise.all((await context.state.listMissions()).map(async (mission) => ({
        ...mission,
        broker: brokerByMission.get(mission.id) ?? null,
        orchestratorHandoff: await context.missionBroker.orchestratorHandoffStatus(mission.id),
      }))),
    });
    return;
  }
  const orchestratorMatch = /^\/missions\/([^/]+)\/orchestrator$/.exec(url.pathname);
  if (orchestratorMatch !== null && request.method === 'POST') {
    const missionId = decodeURIComponent(orchestratorMatch[1]!);
    const body = await readJsonBody(request);
    writeJson(response, 200, await context.missionBroker.changeOrchestrator({
      missionId,
      targetMode: orchestratorModeField(body, 'targetMode'),
      expectedVersion: integerField(body, 'expectedVersion'),
      handoffId: stringField(body, 'handoffId'),
    }));
    return;
  }
  const missionBrokerMatch = /^\/missions\/([^/]+)\/broker$/.exec(url.pathname);
  if (missionBrokerMatch !== null) {
    const missionId = decodeURIComponent(missionBrokerMatch[1]!);
    if (request.method === 'GET') { writeJson(response, 200, await context.missionBroker.get(missionId)); return; }
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      writeJson(response, 200, await context.missionBroker.bindHermesSession({
        missionId,
        hermesSessionId: stringField(body, 'hermesSessionId'),
        worktreePath: stringField(body, 'worktreePath'),
        branch: stringField(body, 'branch'),
      }));
      return;
    }
  }
  const checkpointMatch = /^\/missions\/([^/]+)\/checkpoints$/.exec(url.pathname);
  if (checkpointMatch !== null && request.method === 'POST') {
    const missionId = decodeURIComponent(checkpointMatch[1]!);
    const body = await readJsonBody(request);
    writeJson(response, 200, await context.missionBroker.recordCheckpoint({
      checkpointId: stringField(body, 'checkpointId'), missionId, missionVersion: integerField(body, 'missionVersion'),
      state: missionStateField(body, 'state'), currentPhase: stringField(body, 'currentPhase'), summary: stringField(body, 'summary'),
      evidenceRefs: stringArrayField(body, 'evidenceRefs'), blockers: stringArrayField(body, 'blockers'),
      hermesAssessment: stringField(body, 'hermesAssessment'), proposedNextAction: stringField(body, 'proposedNextAction'),
      decisionRequired: booleanField(body, 'decisionRequired'), createdAt: stringField(body, 'createdAt'),
    }));
    return;
  }
  const directiveMatch = /^\/missions\/([^/]+)\/directives$/.exec(url.pathname);
  if (directiveMatch !== null && request.method === 'POST') {
    const missionId = decodeURIComponent(directiveMatch[1]!);
    const body = await readJsonBody(request);
    writeJson(response, 200, await context.missionBroker.acceptDirective({
      missionId, expectedVersion: integerField(body, 'expectedVersion'), directiveId: stringField(body, 'directiveId'),
      directiveSequence: integerField(body, 'directiveSequence'), decision: supervisorDecisionField(body, 'decision'),
      instruction: stringField(body, 'instruction'), authorizedScope: stringArrayField(body, 'authorizedScope'),
      doNot: stringArrayField(body, 'doNot'), successCriteria: stringArrayField(body, 'successCriteria'),
    }));
    return;
  }
  const completeMatch = /^\/missions\/([^/]+)\/complete$/.exec(url.pathname);
  if (completeMatch !== null && request.method === 'POST') {
    const missionId = decodeURIComponent(completeMatch[1]!);
    const body = await readJsonBody(request);
    writeJson(response, 200, await context.missionBroker.markCompleted(
      missionId, stringField(body, 'hermesSessionId'), integerField(body, 'expectedVersion'),
    ));
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

function orchestratorModeField(body: Record<string, unknown> | null, name: string): 'HERMES' | 'CHATGPT' {
  const value = body?.[name];
  if (value === 'HERMES' || value === 'CHATGPT') return value;
  throw new RuntimeError('INVALID_REQUEST', `${name} is not a supported orchestrator mode`);
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

function authorizeHermesMissionAccess(request: IncomingMessage, ownerAccessSecret: string, missionId: string): void {
  const authorization = request.headers.authorization;
  const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const expected = hermesMissionAccessToken(ownerAccessSecret, missionId);
  if (!secretsEqual(supplied, expected)) throw new RuntimeError('CONTROL_DENIED', 'Mission-scoped Hermes bridge credential is required');
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

function integerField(record: Record<string, unknown> | null, name: string): number {
  const value = record?.[name];
  if (!Number.isInteger(value)) throw new RuntimeError('INVALID_REQUEST', `${name} must be an integer`);
  return Number(value);
}

function booleanField(record: Record<string, unknown> | null, name: string): boolean {
  const value = record?.[name];
  if (typeof value !== 'boolean') throw new RuntimeError('INVALID_REQUEST', `${name} must be boolean`);
  return value;
}

function stringArrayField(record: Record<string, unknown> | null, name: string): readonly string[] {
  const value = record?.[name];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new RuntimeError('INVALID_REQUEST', `${name} must be a string array`);
  return value;
}

function missionStateField(record: Record<string, unknown> | null, name: string): MissionState {
  const value = record?.[name];
  if (value === 'PLANNED' || value === 'RUNNING' || value === 'WAITING_APPROVAL' || value === 'WAITING_SUPERVISOR'
    || value === 'PAUSED' || value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED') return value;
  throw new RuntimeError('INVALID_REQUEST', `${name} must be a mission state`);
}

function supervisorDecisionField(record: Record<string, unknown> | null, name: string): SupervisorDecision {
  const value = record?.[name];
  if (value === 'CONTINUE' || value === 'REVISE' || value === 'PAUSE' || value === 'COMPLETE') return value;
  throw new RuntimeError('INVALID_REQUEST', `${name} must be a supervisor decision`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
