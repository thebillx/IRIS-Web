import type { RuntimeState } from './state.js';
import { DurableMissionLifecycleStore } from './durable-mission-store.js';
import type { DurableMissionLifecycleSnapshot } from './durable-mission-lifecycle.js';
import { WorkerAdapterRegistry, normalizeWorkerStatusReceipt } from './durable-mission-workers.js';
import { finishLifecycleOperation, recoveryState, replaceLifecycleRecord } from './durable-mission-operations.js';
import { validateLifecycleRecord } from './durable-mission-validation.js';

export async function recoverDurableMissions(
  state: RuntimeState,
  store: DurableMissionLifecycleStore,
  workers: WorkerAdapterRegistry = new WorkerAdapterRegistry(),
): Promise<readonly DurableMissionLifecycleSnapshot[]> {
  let document = await store.read();
  const recovered: DurableMissionLifecycleSnapshot[] = [];
  for (const candidate of document.records) {
    const record = validateLifecycleRecord(candidate);
    const mission = await state.getMission(record.missionId);
    const projectRegistered = (await state.listProjects()).some((project) => project.id === record.projectId);
    if (mission.projectId !== record.projectId || !projectRegistered) {
      recovered.push(record);
      continue;
    }
    if (record.state === 'COMPLETED' || record.state === 'FAILED' || record.state === 'CANCELLED') {
      recovered.push(record);
      continue;
    }
    const pending = record.operations.find((operation) => operation.status === 'PENDING');
    if (pending !== undefined) {
      const failed = finishLifecycleOperation(validateLifecycleRecord({
        ...record,
        state: 'FAILED',
        revision: record.revision + 1,
        updatedAt: new Date().toISOString(),
      }), pending.requestId, 'FAILED');
      document = replaceLifecycleRecord(document, failed);
      await store.write(document);
      recovered.push(failed);
      continue;
    }
    if (record.workerBinding === null) {
      recovered.push(record);
      continue;
    }
    try {
      const status = normalizeWorkerStatusReceipt(await workers.get(record.workerBinding.workerType).status({
        missionId: record.missionId,
        projectId: record.projectId,
        binding: record.workerBinding,
      }));
      const now = new Date().toISOString();
      const next = validateLifecycleRecord({
        ...record,
        state: recoveryState(record, status),
        revision: record.revision + 1,
        workerBinding: {
          ...record.workerBinding,
          workerId: status.workerId,
          resumeToken: status.resumeToken,
          resumable: status.resumable,
          lastSeenAt: now,
        },
        updatedAt: now,
      });
      document = replaceLifecycleRecord(document, next);
      await store.write(document);
      recovered.push(next);
    } catch {
      recovered.push(record);
    }
  }
  return recovered;
}
