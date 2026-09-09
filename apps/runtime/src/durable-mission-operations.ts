import { RuntimeError } from '@iris/domain';
import type {
  DurableMissionLifecycleDocument,
} from './durable-mission-store.js';
import type {
  DurableMissionLifecycleSnapshot,
  DurableMissionLifecycleState,
  LifecycleOperationKind,
  LifecycleOperationReceipt,
  WorkerBinding,
  WorkerStartReceipt,
} from './durable-mission-lifecycle.js';

const MAX_OPERATIONS = 400;

export function replaceLifecycleRecord(
  document: DurableMissionLifecycleDocument,
  record: DurableMissionLifecycleSnapshot,
): DurableMissionLifecycleDocument {
  const index = document.records.findIndex((candidate) => candidate.missionId === record.missionId);
  if (index < 0) throw new RuntimeError('MISSION_NOT_FOUND', 'Durable mission lifecycle record was not found');
  const records = [...document.records];
  records[index] = record;
  return { schemaVersion: 1, records };
}

export function beginLifecycleOperation(
  record: DurableMissionLifecycleSnapshot,
  requestId: string,
  kind: LifecycleOperationKind,
  state: DurableMissionLifecycleState,
): DurableMissionLifecycleSnapshot {
  if (record.operations.length >= MAX_OPERATIONS) throw new RuntimeError('CAPABILITY_DENIED', 'Mission lifecycle operation capacity has been reached');
  const now = new Date().toISOString();
  const operation: LifecycleOperationReceipt = {
    requestId,
    kind,
    basedOnRevision: record.revision,
    resultRevision: null,
    status: 'PENDING',
    createdAt: now,
    completedAt: null,
  };
  return { ...record, state, revision: record.revision + 1, operations: [...record.operations, operation], updatedAt: now };
}

export function finishLifecycleOperation(
  record: DurableMissionLifecycleSnapshot,
  requestId: string,
  status: 'SUCCEEDED' | 'FAILED',
): DurableMissionLifecycleSnapshot {
  const now = new Date().toISOString();
  let found = false;
  const operations = record.operations.map((operation) => {
    if (operation.requestId !== requestId) return operation;
    found = true;
    if (operation.status !== 'PENDING') throw new RuntimeError('INVALID_REQUEST', 'Lifecycle operation is already terminal');
    return { ...operation, status, resultRevision: record.revision, completedAt: now };
  });
  if (!found) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle operation receipt was not found');
  return { ...record, operations, updatedAt: now };
}

export function bindWorker(
  workerType: string,
  receipt: WorkerStartReceipt,
  record: DurableMissionLifecycleSnapshot,
  createdAtInput?: string,
): WorkerBinding {
  const now = new Date().toISOString();
  return {
    workerType,
    workerId: receipt.workerId,
    resumeToken: receipt.resumeToken,
    missionId: record.missionId,
    projectId: record.projectId,
    createdAt: createdAtInput ?? now,
    lastSeenAt: now,
    resumable: receipt.resumable,
  };
}

export function touchWorker(binding: WorkerBinding): WorkerBinding {
  return { ...binding, lastSeenAt: new Date().toISOString() };
}

export function recoveryState(
  record: DurableMissionLifecycleSnapshot,
  status: { readonly state: string; readonly resumable: boolean },
): DurableMissionLifecycleState {
  if (status.state === 'FAILED') return 'FAILED';
  if (status.state === 'RUNNING') return 'RUNNING';
  if (status.resumable || status.state === 'RESUMABLE') return record.checkpoints.length > 0 ? 'WAITING_FOR_SUPERVISOR' : 'READY';
  return 'FAILED';
}
