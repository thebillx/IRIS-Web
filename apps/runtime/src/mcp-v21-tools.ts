import { RuntimeError, type MissionEvidence, type OrchestratorMode } from '@iris/domain';
import type { CapabilityOutcome, CapabilityService } from './capability-service.js';
import type { DurableMissionLifecycleService } from './durable-mission-service.js';
import type { McpPrincipal } from './mcp.js';
import type { RuntimeState } from './state.js';

const CLIENT_ID_HEADER = 'x-iris-client-id';
const SESSION_ID_HEADER = 'x-iris-session-id';

export async function executeV21LifecycleTool(
  name: string,
  args: Record<string, unknown>,
  request: Request,
  capabilities: CapabilityService,
  state: RuntimeState,
  lifecycle: DurableMissionLifecycleService,
  principal: McpPrincipal = 'owner',
): Promise<CapabilityOutcome | unknown> {
  if (name === 'mission_create') return createLifecycleMission(args, request, capabilities, state, lifecycle);

  const identity = resolveSessionIdentity(args, request, state);
  const missionId = requiredBoundedString(args, 'missionId', 200);
  if (name === 'mission_rebind') {
    if (principal !== 'owner') throw new RuntimeError('CONTROL_DENIED', 'Only the authenticated IRIS owner may rebind a durable mission session');
    return state.rebindMissionSession({
      missionId,
      clientId: identity.clientId,
      sessionId: identity.sessionId,
      projectId: requiredBoundedString(args, 'projectId', 200),
      expectedBindingRevision: requiredPositiveInteger(args, 'expectedBindingRevision'),
      reason: optionalBoundedString(args, 'reason', 500) ?? 'Owner requested durable cross-session continuation',
    });
  }
  try {
    await lifecycle.assertSessionControl(missionId, identity.clientId, identity.sessionId);
  } catch (error) {
    if (principal === 'owner' && error instanceof RuntimeError && error.code === 'CONTROL_DENIED') {
      const mission = await state.getMission(missionId).catch(() => null);
      if (mission !== null && mission.state !== 'COMPLETED' && mission.state !== 'FAILED' && mission.state !== 'CANCELLED'
        && (mission.clientId !== identity.clientId || mission.sessionId !== identity.sessionId)) {
        throw new RuntimeError('MISSION_SESSION_STALE', 'Mission session binding is stale; call mission_rebind with the current project and binding revision before resuming');
      }
    }
    throw error;
  }

  if (name === 'mission_start') return lifecycle.start({
    missionId,
    expectedRevision: requiredPositiveInteger(args, 'expectedRevision'),
    requestId: requiredBoundedString(args, 'requestId', 200),
    workerType: requiredBoundedString(args, 'workerType', 200),
  });
  if (name === 'mission_checkpoint') return lifecycle.checkpoint({
    missionId,
    expectedRevision: requiredPositiveInteger(args, 'expectedRevision'),
    checkpointId: requiredBoundedString(args, 'checkpointId', 200),
    summary: requiredBoundedString(args, 'summary', 2_000),
    evidenceRefs: requiredStringArray(args, 'evidenceRefs'),
  });
  if (name === 'mission_directive') return lifecycle.acceptDirective({
    missionId,
    basedOnRevision: requiredPositiveInteger(args, 'basedOnRevision'),
    directiveId: requiredBoundedString(args, 'directiveId', 200),
    directive: requiredBoundedString(args, 'directive', 4_000),
  });
  if (name === 'mission_resume') return lifecycle.resume({
    missionId,
    expectedRevision: requiredPositiveInteger(args, 'expectedRevision'),
    requestId: requiredBoundedString(args, 'requestId', 200),
  });
  if (name === 'mission_cancel') return lifecycle.cancel({
    missionId,
    expectedRevision: requiredPositiveInteger(args, 'expectedRevision'),
    requestId: requiredBoundedString(args, 'requestId', 200),
  });
  if (name === 'mission_complete') return lifecycle.complete({
    missionId,
    expectedRevision: requiredPositiveInteger(args, 'expectedRevision'),
    requestId: requiredBoundedString(args, 'requestId', 200),
  });
  if (name === 'mission_evidence') return lifecycle.appendEvidence({
    missionId,
    expectedRevision: requiredPositiveInteger(args, 'expectedRevision'),
    evidence: evidenceField(args, 'evidence'),
  });
  throw new RuntimeError('INVALID_REQUEST', `Unknown V2.1 lifecycle tool: ${name}`);
}

export function isCapabilityOutcome(value: unknown): value is CapabilityOutcome {
  return isRecord(value) && (value.status === 'executed' || value.status === 'owner_required' || value.status === 'denied');
}

export function toolOutcome(outcome: CapabilityOutcome): ReturnType<typeof toolResult> | ReturnType<typeof toolError> {
  if (outcome.status === 'executed') return toolResult(outcome.value);
  if (outcome.status === 'owner_required') return toolError('OWNER_DECISION_REQUIRED', 'Owner approval is required before this action can execute', { approval: outcome.approval });
  return toolError('CAPABILITY_DENIED', outcome.reason);
}

export function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value, isError: false as const };
}

export function toolError(code: string, message: string, extra: Record<string, unknown> = {}) {
  const structuredContent = { code, message, ...extra };
  return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true as const };
}

async function createLifecycleMission(
  args: Record<string, unknown>,
  request: Request,
  capabilities: CapabilityService,
  state: RuntimeState,
  lifecycle: DurableMissionLifecycleService,
): Promise<CapabilityOutcome | unknown> {
  const identity = resolveSessionIdentity(args, request, state);
  if (identity.session.currentProjectId === null) {
    throw new RuntimeError('CAPABILITY_DENIED', 'V2.1 mission creation requires an explicitly selected registered project');
  }
  if (!(await state.listProjects()).some((project) => project.id === identity.session.currentProjectId)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Selected mission project is not registered');
  }
  const outcome = await capabilities.execute({
    capabilityId: 'mission.create',
    clientId: identity.clientId,
    sessionId: identity.sessionId,
    title: requiredBoundedString(args, 'title', 240),
    orchestratorMode: optionalOrchestratorMode(args, 'orchestratorMode') ?? 'HERMES',
  });
  if (outcome.status !== 'executed') return outcome;
  const mission = asRecord(outcome.value);
  const durable = await lifecycle.ensureMission(requiredRecordString(mission, 'id'), optionalBoundedString(args, 'goal', 4_000));
  return { ...mission, lifecycle: durable };
}

function resolveSessionIdentity(
  args: Record<string, unknown>,
  request: Request,
  state: RuntimeState,
): { clientId: string; sessionId: string; session: ReturnType<RuntimeState['getSessionForClient']> } {
  const clientId = requiredHeader(request, CLIENT_ID_HEADER);
  const argumentSessionId = optionalBoundedString(args, 'sessionId', 200);
  const headerSessionId = optionalHeader(request, SESSION_ID_HEADER);
  if (argumentSessionId !== undefined && headerSessionId !== undefined && argumentSessionId !== headerSessionId) {
    throw new RuntimeError('CONTROL_DENIED', 'sessionId argument does not match x-iris-session-id');
  }
  const sessionId = argumentSessionId ?? headerSessionId;
  if (sessionId === undefined) throw new RuntimeError('INVALID_REQUEST', 'IRIS session is required; call session_open first.');
  return { clientId, sessionId, session: state.getSessionForClient(sessionId, clientId) };
}

function evidenceField(record: Record<string, unknown>, name: string): MissionEvidence {
  const value = record[name];
  if (!isRecord(value)) throw new RuntimeError('INVALID_REQUEST', `${name} must be an evidence object`);
  const kind = value.kind;
  if (kind !== 'CAPABILITY_RESULT' && kind !== 'AUDIT' && kind !== 'ARTIFACT' && kind !== 'OBSERVATION') {
    throw new RuntimeError('INVALID_REQUEST', `${name}.kind is invalid`);
  }
  if (value.reference !== null && typeof value.reference !== 'string') {
    throw new RuntimeError('INVALID_REQUEST', `${name}.reference must be a string or null`);
  }
  if (!isScalarRecord(value.data)) throw new RuntimeError('INVALID_REQUEST', `${name}.data must contain bounded scalar values`);
  return {
    id: requiredRecordString(value, 'id'),
    kind,
    label: requiredRecordString(value, 'label'),
    summary: requiredRecordString(value, 'summary'),
    reference: value.reference,
    data: value.data,
  };
}

function isScalarRecord(value: unknown): value is Readonly<Record<string, string | number | boolean | null>> {
  return isRecord(value) && Object.keys(value).length <= 24 && Object.values(value).every((item) => item === null || typeof item === 'boolean'
    || (typeof item === 'number' && Number.isFinite(item)) || (typeof item === 'string' && item.length <= 2_048 && !item.includes('\0')));
}

function optionalOrchestratorMode(record: Record<string, unknown>, name: string): OrchestratorMode | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (value === 'HERMES' || value === 'CHATGPT') return value;
  throw new RuntimeError('INVALID_REQUEST', `${name} is not a supported orchestrator mode`);
}

function requiredHeader(request: Request, name: string): string {
  const value = optionalHeader(request, name);
  if (value === undefined) throw new RuntimeError('CONTROL_DENIED', `${name} is required`);
  return value;
}

function optionalHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 200 || value.includes('\0')) throw new RuntimeError('CONTROL_DENIED', `${name} is invalid`);
  return value;
}

function requiredPositiveInteger(record: Record<string, unknown>, name: string): number {
  const value = record[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RuntimeError('INVALID_REQUEST', `${name} must be a positive integer`);
  }
  return value;
}

function requiredStringArray(record: Record<string, unknown>, name: string): readonly string[] {
  const value = record[name];
  if (!Array.isArray(value) || value.length > 24) throw new RuntimeError('INVALID_REQUEST', `${name} must be a bounded string array`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > 1_000 || item.includes('\0')) {
      throw new RuntimeError('INVALID_REQUEST', `${name}[${index}] must be a bounded string`);
    }
    return item.trim();
  });
}

function requiredBoundedString(record: Record<string, unknown>, name: string, max: number): string {
  const value = record[name];
  if (typeof value !== 'string') throw new RuntimeError('INVALID_REQUEST', `${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max || normalized.includes('\0')) throw new RuntimeError('INVALID_REQUEST', `${name} is invalid`);
  return normalized;
}

function optionalBoundedString(record: Record<string, unknown>, name: string, max: number): string | undefined {
  if (record[name] === undefined) return undefined;
  return requiredBoundedString(record, name, max);
}

function requiredRecordString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== 'string' || value.trim().length === 0) throw new RuntimeError('INVALID_REQUEST', `${name} must be a non-empty string`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
