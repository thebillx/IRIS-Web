import { RuntimeError, type MissionEvidence } from '@iris/domain';
import type {
  DurableMissionLifecycleSnapshot,
  LifecycleOperationKind,
  LifecycleOperationReceipt,
  WorkerBinding,
} from './durable-mission-lifecycle.js';

const MAX_CHECKPOINTS = 200;
const MAX_DIRECTIVES = 200;
const MAX_EVIDENCE = 400;
const MAX_OPERATIONS = 400;

export function validateLifecycleRecord(value: DurableMissionLifecycleSnapshot): DurableMissionLifecycleSnapshot {
  if (!isLifecycleRecord(value)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Durable mission lifecycle record is invalid');
  return value;
}

export function uuid(value: string, name: string): string {
  const normalized = value.trim();
  if (!isUuid(normalized)) throw new RuntimeError('INVALID_REQUEST', `${name} must be a UUID`);
  return normalized;
}

export function positiveRevision(value: number, name: string): number {
  if (!positiveInteger(value)) throw new RuntimeError('INVALID_REQUEST', `${name} must be a positive integer`);
  return value;
}

export function boundedText(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max || normalized.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', `${name} is invalid`);
  }
  return normalized;
}

export function boundedTextList(value: readonly string[], name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 24) throw new RuntimeError('INVALID_REQUEST', `${name} exceeds its bounded item limit`);
  return value.map((item, index) => boundedText(item, `${name}[${index}]`, 1_000));
}

export function normalizeEvidence(value: MissionEvidence): MissionEvidence {
  if (!isEvidence(value)) throw new RuntimeError('INVALID_REQUEST', 'Mission evidence is invalid');
  return {
    ...value,
    label: value.label.trim(),
    summary: value.summary.trim(),
    reference: value.reference === null ? null : value.reference.trim(),
    data: { ...value.data },
  };
}

export function assertExpectedRevision(record: DurableMissionLifecycleSnapshot, expectedRevision: number): void {
  if (record.revision !== expectedRevision) throw new RuntimeError('INVALID_REQUEST', 'Mission lifecycle revision is stale');
}

export function ensureNoPendingOperation(record: DurableMissionLifecycleSnapshot): void {
  if (record.operations.some((operation) => operation.status === 'PENDING')) {
    throw new RuntimeError('CONTROL_DENIED', 'Mission has an indeterminate worker operation; IRIS will not risk a replay');
  }
}

export function operationByRequest(record: DurableMissionLifecycleSnapshot, requestId: string, kind: LifecycleOperationKind): LifecycleOperationReceipt | null {
  const operation = record.operations.find((candidate) => candidate.requestId === requestId);
  if (operation === undefined) return null;
  if (operation.kind !== kind) throw new RuntimeError('INVALID_REQUEST', 'requestId is already bound to a different lifecycle operation');
  return operation;
}

export function resolveDuplicateOperation(record: DurableMissionLifecycleSnapshot, operation: LifecycleOperationReceipt): DurableMissionLifecycleSnapshot {
  if (operation.status === 'SUCCEEDED') return record;
  if (operation.status === 'PENDING') throw new RuntimeError('CONTROL_DENIED', 'Lifecycle operation outcome is indeterminate; replay is blocked');
  throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Lifecycle operation already failed; replay is blocked');
}

export function requireWorkerBinding(record: DurableMissionLifecycleSnapshot): WorkerBinding {
  if (record.workerBinding === null) throw new RuntimeError('INVALID_REQUEST', 'Mission has no worker binding');
  return record.workerBinding;
}

function isLifecycleRecord(value: unknown): value is DurableMissionLifecycleSnapshot {
  if (!isRecord(value)
    || !isUuid(value.missionId)
    || !isUuid(value.projectId)
    || !bounded(value.title, 240)
    || !bounded(value.goal, 4_000)
    || !lifecycleState(value.state)
    || !positiveInteger(value.revision)
    || (value.workerBinding !== null && !isWorkerBinding(value.workerBinding))
    || !Array.isArray(value.checkpoints) || value.checkpoints.length > MAX_CHECKPOINTS
    || !Array.isArray(value.directives) || value.directives.length > MAX_DIRECTIVES
    || !Array.isArray(value.evidence) || value.evidence.length > MAX_EVIDENCE
    || !Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) return false;

  if (!value.checkpoints.every((item) => isRecord(item) && isUuid(item.checkpointId) && item.missionId === value.missionId
    && item.projectId === value.projectId && positiveInteger(item.sequence) && positiveInteger(item.revision)
    && bounded(item.workerStateRef, 2_048) && bounded(item.summary, 2_000) && stringList(item.evidenceRefs)
    && timestamp(item.createdAt) && scalarRecord(item.resumeMetadata))) return false;
  if (!value.directives.every((item) => isRecord(item) && isUuid(item.directiveId) && item.missionId === value.missionId
    && item.projectId === value.projectId && positiveInteger(item.basedOnRevision) && bounded(item.directive, 4_000)
    && timestamp(item.createdAt) && (item.appliedAt === null || timestamp(item.appliedAt))
    && (item.status === 'ACCEPTED' || item.status === 'APPLIED'))) return false;
  if (!value.evidence.every(isEvidence) || !value.operations.every(isOperation)) return false;
  if (!unique(value.checkpoints.map((item) => item.checkpointId)) || !unique(value.directives.map((item) => item.directiveId))
    || !unique(value.evidence.map((item) => item.id)) || !unique(value.operations.map((item) => item.requestId))) return false;
  return value.workerBinding === null || (value.workerBinding.missionId === value.missionId && value.workerBinding.projectId === value.projectId);
}

function isWorkerBinding(value: unknown): value is WorkerBinding {
  return isRecord(value) && bounded(value.workerType, 200) && bounded(value.workerId, 200)
    && (value.resumeToken === null || bounded(value.resumeToken, 200)) && isUuid(value.missionId) && isUuid(value.projectId)
    && timestamp(value.createdAt) && timestamp(value.lastSeenAt) && typeof value.resumable === 'boolean';
}

function isEvidence(value: unknown): value is MissionEvidence {
  return isRecord(value) && isUuid(value.id)
    && (value.kind === 'CAPABILITY_RESULT' || value.kind === 'AUDIT' || value.kind === 'ARTIFACT' || value.kind === 'OBSERVATION')
    && bounded(value.label, 120) && bounded(value.summary, 500)
    && (value.reference === null || bounded(value.reference, 2_048)) && scalarRecord(value.data);
}

function isOperation(value: unknown): value is LifecycleOperationReceipt {
  return isRecord(value) && isUuid(value.requestId) && operationKind(value.kind) && positiveInteger(value.basedOnRevision)
    && (value.resultRevision === null || positiveInteger(value.resultRevision))
    && (value.status === 'PENDING' || value.status === 'SUCCEEDED' || value.status === 'FAILED')
    && timestamp(value.createdAt) && (value.completedAt === null || timestamp(value.completedAt));
}

function lifecycleState(value: unknown): boolean {
  return value === 'CREATED' || value === 'READY' || value === 'RUNNING' || value === 'CHECKPOINTED'
    || value === 'WAITING_FOR_SUPERVISOR' || value === 'RESUMING' || value === 'VALIDATING'
    || value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED';
}

function operationKind(value: unknown): value is LifecycleOperationKind {
  return value === 'START' || value === 'CHECKPOINT' || value === 'RESUME' || value === 'CANCEL' || value === 'COMPLETE';
}

function scalarRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length <= 24 && Object.entries(value).every(([key, item]) => bounded(key, 120)
    && (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) || bounded(item, 2_048)));
}

function stringList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 24 && value.every((item) => bounded(item, 1_000));
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !value.includes('\0');
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
