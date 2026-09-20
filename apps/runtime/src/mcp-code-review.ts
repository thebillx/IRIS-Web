import type { CapabilityEffect, MissionExecutionAssociation } from '@iris/domain';
import { RuntimeError } from '@iris/domain';
import type { CapabilityOutcome, CapabilityService } from './capability-service.js';
import type { RuntimeState } from './state.js';

const CLIENT_ID_HEADER = 'x-iris-client-id';
const SESSION_ID_HEADER = 'x-iris-session-id';
const EFFECTS = ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const satisfies readonly CapabilityEffect[];

export const CODE_REVIEW_GROUPED_TOOL_NAME = 'code_review' as const;

export function isCodeReviewGroupedTool(name: string): name is typeof CODE_REVIEW_GROUPED_TOOL_NAME {
  return name === CODE_REVIEW_GROUPED_TOOL_NAME;
}

export function codeReviewGroupedToolDefinitions(): readonly Record<string, unknown>[] {
  return [{
    name: CODE_REVIEW_GROUPED_TOOL_NAME,
    description: 'Run and finalize one native Ponytail LOCAL_NATIVE review inside an exact ACTIVE IRIS PRIMARY/WORKTREE. The caller supplies only governed identities; executable, model, prompt, sandbox and environment are server-owned.',
    inputSchema: {
      type: 'object',
      required: ['operation','projectId','expectedEffects'],
      properties: {
        sessionId: { type: 'string', description: 'IRIS runtime session UUID returned by session_open. May be omitted when x-iris-session-id is supplied.' },
        operation: { enum: ['prepare','start','status','result'] },
        projectId: { type: 'string', description: 'Registered project UUID; must equal the live session project.' },
        workspaceId: { type: 'string', description: 'Required for start. Exact ACTIVE PRIMARY or WORKTREE workspace to review.' },
        contextArtifactId: { type: 'string', description: 'Required for start. Project-bound local-native-review-context artifact.' },
        requestId: { type: 'string', minLength: 1, maxLength: 200, description: 'Required for start; idempotent durable review-job request.' },
        missionId: { type: 'string', description: 'Required for start and must identify the prepared review mission action.' },
        taskId: { type: 'string', description: 'Required for start.' },
        actionId: { type: 'string', description: 'Required for start; action capability must be code_review.start.' },
        jobId: { type: 'string', description: 'Required for status/result.' },
        expectedEffects: {
          type: 'array', maxItems: 5, uniqueItems: true, items: { enum: EFFECTS },
          description: 'Surprise-prevention assertion. prepare=WRITE, start=READ/WRITE/EXECUTE/NETWORK/DESTRUCTIVE, status=READ, result=READ/WRITE.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }];
}

export async function executeCodeReviewGroupedTool(
  args: Record<string, unknown>,
  request: Request,
  capabilities: CapabilityService,
  state: RuntimeState | undefined,
): Promise<CapabilityOutcome> {
  assertOnlyKnownKeys(args);
  const identity = resolveSessionIdentity(args, request, state);
  const projectId = requiredBoundedString(args, 'projectId', 200);
  const expectedEffects = requiredExpectedEffects(args);
  const operation = requiredEnum(args, 'operation', ['prepare','start','status','result'] as const);

  if (operation === 'prepare') {
    if (state === undefined) throw new RuntimeError('INVALID_REQUEST', 'Mission state is unavailable for native code review');
    const missionId = requiredBoundedString(args, 'missionId', 200);
    const taskId = requiredBoundedString(args, 'taskId', 200);
    const session = state.getSessionForClient(identity.sessionId, identity.clientId);
    const mission = await state.assertMissionOrchestrator(missionId, 'CHATGPT');
    if (session.currentProjectId !== projectId || mission.projectId !== projectId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Review preparation project does not match the live mission/session project');
    }
    return capabilities.execute({
      capabilityId: 'mission.action.prepare',
      ...identity,
      missionId,
      taskId,
      actionCapabilityId: 'code_review.start',
      summary: 'Run Ponytail LOCAL_NATIVE exact-diff review',
      expectedEffects,
    });
  }

  if (operation === 'start') {
    if (state === undefined) throw new RuntimeError('INVALID_REQUEST', 'Mission state is unavailable for native code review');
    const missionId = requiredBoundedString(args, 'missionId', 200);
    const mission = await state.getMission(missionId);
    const association: MissionExecutionAssociation = {
      missionId,
      taskId: requiredBoundedString(args, 'taskId', 200),
      actionId: requiredBoundedString(args, 'actionId', 200),
      orchestratorMode: mission.orchestratorMode,
    };
    return capabilities.execute({
      capabilityId: 'code_review.start',
      ...identity,
      projectId,
      workspaceId: requiredBoundedString(args, 'workspaceId', 200),
      contextArtifactId: requiredBoundedString(args, 'contextArtifactId', 200),
      requestId: requiredBoundedString(args, 'requestId', 200),
      mission: association,
      expectedEffects,
    });
  }

  const jobId = requiredBoundedString(args, 'jobId', 200);
  if (operation === 'status') {
    return capabilities.execute({ capabilityId: 'code_review.status', ...identity, projectId, jobId, expectedEffects });
  }
  return capabilities.execute({ capabilityId: 'code_review.result', ...identity, projectId, jobId, expectedEffects });
}

const ALLOWED_KEYS = new Set([
  'operation','sessionId','projectId','workspaceId','contextArtifactId','requestId',
  'missionId','taskId','actionId','jobId','expectedEffects',
]);

function assertOnlyKnownKeys(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) if (!ALLOWED_KEYS.has(key)) throw new RuntimeError('INVALID_REQUEST', `Unsupported code_review field: ${key}`);
}

interface SessionIdentity { readonly clientId: string; readonly sessionId: string }

function resolveSessionIdentity(args: Record<string, unknown>, request: Request, state: RuntimeState | undefined): SessionIdentity {
  const clientId = requiredHeader(request, CLIENT_ID_HEADER);
  const argumentSessionId = optionalBoundedString(args, 'sessionId', 200);
  const headerSessionId = optionalHeader(request, SESSION_ID_HEADER);
  if (argumentSessionId !== undefined && headerSessionId !== undefined && argumentSessionId !== headerSessionId) {
    throw new RuntimeError('CONTROL_DENIED', 'sessionId argument does not match x-iris-session-id');
  }
  const sessionId = argumentSessionId ?? headerSessionId;
  if (sessionId === undefined) throw new RuntimeError('INVALID_REQUEST', 'IRIS session is required; call session_open first.');
  if (state === undefined) throw new RuntimeError('INVALID_REQUEST', 'IRIS session validation is unavailable');
  state.getSessionForClient(sessionId, clientId);
  return { clientId, sessionId };
}

function requiredExpectedEffects(record: Record<string, unknown>): readonly CapabilityEffect[] {
  const value = record.expectedEffects;
  if (!Array.isArray(value) || value.length > EFFECTS.length) throw new RuntimeError('INVALID_REQUEST', 'expectedEffects must be a bounded effect array');
  const result: CapabilityEffect[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !EFFECTS.some((effect) => effect === item)) {
      throw new RuntimeError('INVALID_REQUEST', 'expectedEffects contains an unsupported effect');
    }
    const effect = item as CapabilityEffect;
    if (!result.includes(effect)) result.push(effect);
  }
  return result;
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

function requiredBoundedString(record: Record<string, unknown>, name: string, maxLength: number): string {
  const value = record[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', `${name} must be a bounded non-empty string`);
  }
  return value;
}

function optionalBoundedString(record: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  if (record[name] === undefined) return undefined;
  return requiredBoundedString(record, name, maxLength);
}

function requiredEnum<const T extends readonly string[]>(record: Record<string, unknown>, name: string, allowed: T): T[number] {
  const value = record[name];
  if (typeof value === 'string' && allowed.some((candidate) => candidate === value)) return value as T[number];
  throw new RuntimeError('INVALID_REQUEST', `${name} is not a supported value`);
}
