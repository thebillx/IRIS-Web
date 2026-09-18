import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type MissionRebindAuditEvent, type MissionSnapshot } from '@iris/domain';
import { capabilityDefinition } from './capability-registry.js';
import { inspectPrivateRegularFile } from './private-fs.js';

const MISSION_FILE = 'missions.json';
const MAX_MISSIONS = 100;
const MAX_TASKS = 200;
const MAX_ACTIONS_PER_TASK = 200;
const MAX_TIMELINE = 1_000;
const MAX_EVIDENCE = 20;
const MAX_DATA_ENTRIES = 24;

export interface MissionLedgerDocument {
  readonly schemaVersion: 1;
  readonly missions: readonly MissionSnapshot[];
}

export class MissionLedgerStore {
  public constructor(private readonly dataRoot: string) {}

  public async read(): Promise<MissionLedgerDocument> {
    const filename = path.join(this.dataRoot, MISSION_FILE);
    const inspected = await inspectPrivateRegularFile(filename, 'Mission ledger');
    if (inspected.state === 'missing') return { schemaVersion: 1, missions: [] };
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      const parsed = JSON.parse(inspected.content) as unknown;
      const normalized = normalizeMissionLedgerDocument(parsed);
      if (normalized === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Mission ledger is invalid');
      return normalized;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Mission ledger is invalid JSON', { cause: error });
    }
  }

  public async write(document: MissionLedgerDocument): Promise<void> {
    if (!isMissionLedgerDocument(document)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to write invalid mission ledger');
    await writeJsonAtomic(path.join(this.dataRoot, MISSION_FILE), document);
  }
}

async function writeJsonAtomic(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Atomic mission ledger publication failed', { cause: error });
  }
}

function normalizeMissionLedgerDocument(value: unknown): MissionLedgerDocument | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.missions) || value.missions.length > MAX_MISSIONS) return null;
  const missions: MissionSnapshot[] = [];
  for (const candidate of value.missions) {
    if (!isRecord(candidate)) return null;
    const orchestratorFields = [candidate.orchestratorMode, candidate.orchestratorVersion, candidate.lastOrchestratorHandoff, candidate.orchestratorHandoffIds];
    const legacyOrchestratorRecord = orchestratorFields.every((field) => field === undefined);
    if (!legacyOrchestratorRecord && orchestratorFields.some((field) => field === undefined)) return null;
    const normalized: MissionSnapshot = legacyOrchestratorRecord
      ? {
          ...(candidate as unknown as MissionSnapshot),
          orchestratorMode: 'HERMES',
          orchestratorVersion: 1,
          lastOrchestratorHandoff: null,
          orchestratorHandoffIds: [],
        }
      : candidate as unknown as MissionSnapshot;
    const withBinding = {
      ...normalized,
      ownerClientId: typeof candidate.ownerClientId === 'string' ? candidate.ownerClientId : candidate.clientId,
      bindingRevision: candidate.bindingRevision === undefined ? 1 : candidate.bindingRevision,
      rebindAudit: candidate.rebindAudit === undefined ? [] : candidate.rebindAudit,
    } as MissionSnapshot;
    if (!isMissionSnapshot(withBinding)) return null;
    missions.push(withBinding);
  }
  if (new Set(missions.map((mission) => mission.id)).size !== missions.length) return null;
  return { schemaVersion: 1, missions };
}

function isMissionLedgerDocument(value: unknown): value is MissionLedgerDocument {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.missions) || value.missions.length > MAX_MISSIONS) return false;
  if (!value.missions.every(isMissionSnapshot)) return false;
  const ids = new Set(value.missions.map((mission) => mission.id));
  return ids.size === value.missions.length;
}

function isMissionSnapshot(value: unknown): value is MissionSnapshot {
  if (!isRecord(value)
    || !isUuid(value.id)
    || !boundedText(value.title, 240)
    || !missionState(value.state)
    || !orchestratorMode(value.orchestratorMode)
    || !positiveVersion(value.orchestratorVersion)
    || !orchestratorHandoffHistory(value.lastOrchestratorHandoff, value.orchestratorHandoffIds)
    || !boundedIdentity(value.clientId)
    || !boundedIdentity(value.sessionId)
    || !boundedIdentity(value.ownerClientId)
    || !positiveVersion(value.bindingRevision)
    || !Array.isArray(value.rebindAudit)
    || value.rebindAudit.length > 64
    || !value.rebindAudit.every(isRebindAuditEvent)
    || (value.projectId !== null && !isUuid(value.projectId))
    || !timestamp(value.createdAt)
    || !timestamp(value.updatedAt)
    || !isSupervisorGate(value.supervisorGate)
    || !Array.isArray(value.tasks)
    || value.tasks.length > MAX_TASKS
    || !value.tasks.every(isMissionTask)
    || !Array.isArray(value.timeline)
    || value.timeline.length > MAX_TIMELINE
    || !value.timeline.every(isTimelineEvent)) return false;
  const taskIds = new Set(value.tasks.map((task) => task.id));
  return taskIds.size === value.tasks.length;
}

function isMissionTask(value: unknown): boolean {
  if (!isRecord(value)
    || !isUuid(value.id)
    || !boundedText(value.title, 240)
    || !taskState(value.state)
    || !timestamp(value.createdAt)
    || !timestamp(value.updatedAt)
    || !Array.isArray(value.actions)
    || value.actions.length > MAX_ACTIONS_PER_TASK
    || !value.actions.every(isMissionAction)) return false;
  const actionIds = new Set(value.actions.map((action) => action.id));
  return actionIds.size === value.actions.length;
}

function isMissionAction(value: unknown): boolean {
  return isRecord(value)
    && isUuid(value.id)
    && typeof value.capabilityId === 'string'
    && capabilityDefinition(value.capabilityId) !== null
    && boundedText(value.summary, 400)
    && actionState(value.state)
    && timestamp(value.createdAt)
    && timestamp(value.updatedAt)
    && (value.approvalId === null || isUuid(value.approvalId))
    && (value.result === null || isActionResult(value.result));
}

function isActionResult(value: unknown): boolean {
  return isRecord(value)
    && (value.status === 'SUCCEEDED' || value.status === 'OWNER_REQUIRED' || value.status === 'DENIED' || value.status === 'FAILED')
    && boundedText(value.summary, 500)
    && (value.approvalId === null || isUuid(value.approvalId))
    && (value.completedAt === null || timestamp(value.completedAt))
    && Array.isArray(value.evidence)
    && value.evidence.length <= MAX_EVIDENCE
    && value.evidence.every(isEvidence);
}

function isEvidence(value: unknown): boolean {
  return isRecord(value)
    && isUuid(value.id)
    && (value.kind === 'CAPABILITY_RESULT' || value.kind === 'AUDIT' || value.kind === 'ARTIFACT' || value.kind === 'OBSERVATION')
    && boundedText(value.label, 120)
    && boundedText(value.summary, 500)
    && (value.reference === null || boundedText(value.reference, 2048))
    && isEvidenceData(value.data);
}

function isEvidenceData(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length > MAX_DATA_ENTRIES) return false;
  return Object.entries(value).every(([key, item]) => boundedText(key, 120)
    && (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) || boundedText(item, 2048)));
}

function isSupervisorGate(value: unknown): boolean {
  return isRecord(value)
    && (value.state === 'NOT_REQUIRED' || value.state === 'PENDING' || value.state === 'APPROVED' || value.state === 'DENIED')
    && (value.reason === null || boundedText(value.reason, 500))
    && timestamp(value.updatedAt);
}

function isTimelineEvent(value: unknown): boolean {
  return isRecord(value)
    && isUuid(value.id)
    && timestamp(value.timestamp)
    && timelineKind(value.kind)
    && (value.taskId === null || isUuid(value.taskId))
    && (value.actionId === null || isUuid(value.actionId))
    && boundedText(value.message, 500);
}

function isRebindAuditEvent(value: unknown): value is MissionRebindAuditEvent {
  return isRecord(value)
    && isUuid(value.id)
    && isUuid(value.missionId)
    && boundedIdentity(value.oldClientId)
    && boundedIdentity(value.oldSessionId)
    && boundedIdentity(value.newClientId)
    && boundedIdentity(value.newSessionId)
    && value.principal === 'owner'
    && isUuid(value.projectId)
    && timestamp(value.timestamp)
    && boundedText(value.reason, 500)
    && positiveVersion(value.bindingRevision)
    && value.result === 'SUCCESS';
}

function orchestratorMode(value: unknown): boolean {
  return value === 'HERMES' || value === 'CHATGPT';
}

function positiveVersion(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isOrchestratorHandoff(value: unknown): value is NonNullable<MissionSnapshot['lastOrchestratorHandoff']> {
  return isRecord(value)
    && isUuid(value.handoffId)
    && positiveVersion(value.expectedVersion)
    && orchestratorMode(value.from)
    && orchestratorMode(value.to)
    && value.from !== value.to
    && timestamp(value.completedAt);
}

function orchestratorHandoffHistory(last: unknown, ids: unknown): boolean {
  if (!Array.isArray(ids) || ids.length > 64 || !ids.every(isUuid) || new Set(ids).size !== ids.length) return false;
  if (last === null) return true;
  return isOrchestratorHandoff(last) && ids.includes(last.handoffId);
}

function missionState(value: unknown): boolean {
  return value === 'PLANNED' || value === 'RUNNING' || value === 'WAITING_APPROVAL' || value === 'WAITING_SUPERVISOR'
    || value === 'PAUSED' || value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED';
}

function taskState(value: unknown): boolean {
  return value === 'PENDING' || value === 'RUNNING' || value === 'BLOCKED' || value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED';
}

function actionState(value: unknown): boolean {
  return value === 'PLANNED' || value === 'RUNNING' || value === 'OWNER_APPROVAL_REQUIRED' || value === 'SUCCEEDED'
    || value === 'DENIED' || value === 'FAILED' || value === 'CANCELLED';
}

function timelineKind(value: unknown): boolean {
  return value === 'MISSION_CREATED' || value === 'MISSION_STATE_CHANGED' || value === 'TASK_CREATED' || value === 'TASK_STATE_CHANGED'
    || value === 'ACTION_PREPARED' || value === 'ACTION_STARTED' || value === 'APPROVAL_REQUIRED' || value === 'ACTION_SUCCEEDED'
    || value === 'ACTION_DENIED' || value === 'ACTION_FAILED' || value === 'SUPERVISOR_GATE_CHANGED' || value === 'ORCHESTRATOR_MODE_CHANGED'
    || value === 'MISSION_SESSION_REBOUND';
}

function timestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function boundedIdentity(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() && !value.includes('\0');
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !value.includes('\0');
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
