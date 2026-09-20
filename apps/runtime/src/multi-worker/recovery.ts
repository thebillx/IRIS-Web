import { RuntimeError, type OrchestrationRun, type Worker, type WorkerAssignment, type WorkerTask } from '@iris/domain';
import type { RuntimeState } from '../state.js';
import type { VNextResourceRegistry } from '../resource-registry.js';
import type { WorkerBinding, WorkerStatusReceipt } from '../durable-mission-lifecycle.js';
import { WorkerAdapterRegistry, normalizeWorkerStatusReceipt } from '../durable-mission-workers.js';
import type { MultiWorkerDocument } from './model.js';
import { MultiWorkerStore } from './store.js';
import { validateMultiWorkerDocument } from './validation.js';

export interface MultiWorkerRecoverySummary {
  readonly document: MultiWorkerDocument;
  readonly inspectedWorkerIds: readonly string[];
  readonly recoveredRunningWorkerIds: readonly string[];
  readonly waitingWorkerIds: readonly string[];
  readonly terminalWorkerIds: readonly string[];
  readonly replayedWorkerStarts: 0;
}

export async function recoverMultiWorkerRuns(
  state: RuntimeState,
  resources: VNextResourceRegistry,
  store: MultiWorkerStore,
  workers: WorkerAdapterRegistry = new WorkerAdapterRegistry(),
  clock: () => string = () => new Date().toISOString(),
): Promise<MultiWorkerRecoverySummary> {
  const current = await store.read();
  if (current.runs.length === 0) return summary(current, [], [], [], []);

  let runs = [...current.runs];
  let workerRecords = [...current.workers];
  let tasks = [...current.tasks];
  let assignments = [...current.assignments];
  const inspectedWorkerIds: string[] = [];
  const recoveredRunningWorkerIds: string[] = [];
  const waitingWorkerIds: string[] = [];
  const terminalWorkerIds: string[] = [];
  let changed = false;
  const now = canonicalTimestamp(clock());

  for (const initialRun of current.runs) {
    if (isTerminalRun(initialRun.state)) continue;
    let runChanged = false;
    const mission = await missionForRecovery(state, initialRun.missionId);
    if (mission === null
      || mission.projectId !== initialRun.projectId
      || mission.sessionId !== initialRun.sessionId) {
      const blocked = blockRun(initialRun, workerRecords, tasks, assignments, now);
      workerRecords = blocked.workers;
      tasks = blocked.tasks;
      assignments = blocked.assignments;
      runs = replaceById(runs, touchRun(initialRun, now, 'WAITING'));
      changed = true;
      continue;
    }
    if (mission.state === 'COMPLETED' || mission.state === 'FAILED' || mission.state === 'CANCELLED') {
      const cancelled = cancelRunState(initialRun, workerRecords, tasks, assignments, now);
      workerRecords = cancelled.workers;
      tasks = cancelled.tasks;
      assignments = cancelled.assignments;
      runs = replaceById(runs, touchRun(initialRun, now, 'CANCELLED'));
      changed = true;
      continue;
    }

    for (const task of tasks.filter((entry) => entry.orchestrationRunId === initialRun.id)) {
      if (!isRecoverableTask(task) || task.assignmentId === null) continue;
      const assignment = assignments.find((entry) => entry.id === task.assignmentId);
      if (assignment === undefined || assignment.releasedAt !== null) continue;
      const worker = workerRecords.find((entry) => entry.id === assignment.workerId);
      if (worker === undefined) throw new RuntimeError('PERSISTENCE_FAILURE', 'Recovery worker assignment is missing its worker');

      try {
        await resources.getActiveWorkspace(initialRun.projectId, task.authority.workspaceId);
      } catch {
        tasks = replaceById(tasks, { ...task, state: 'BLOCKED', updatedAt: now });
        workerRecords = replaceById(workerRecords, { ...worker, state: 'BLOCKED', resumable: false, updatedAt: now });
        assignments = replaceById(assignments, { ...assignment, releasedAt: now });
        terminalWorkerIds.push(worker.id);
        runChanged = true;
        continue;
      }

      if (worker.adapterWorkerId === null) {
        if (task.state === 'RUNNING' || task.state === 'WAITING') {
          tasks = replaceById(tasks, { ...task, state: 'WAITING', updatedAt: now });
          workerRecords = replaceById(workerRecords, { ...worker, state: 'WAITING', resumable: false, updatedAt: now });
          waitingWorkerIds.push(worker.id);
          runChanged = true;
        }
        continue;
      }

      inspectedWorkerIds.push(worker.id);
      let status: WorkerStatusReceipt;
      try {
        status = normalizeWorkerStatusReceipt(await workers.get(worker.workerType).status({
          missionId: initialRun.missionId,
          projectId: initialRun.projectId,
          binding: bindingFor(initialRun, worker),
        }));
      } catch {
        tasks = replaceById(tasks, { ...task, state: 'WAITING', updatedAt: now });
        workerRecords = replaceById(workerRecords, { ...worker, state: 'WAITING', resumable: false, updatedAt: now });
        waitingWorkerIds.push(worker.id);
        runChanged = true;
        continue;
      }

      const applied = applyStatus(task, worker, assignment, status, now);
      tasks = replaceById(tasks, applied.task);
      workerRecords = replaceById(workerRecords, applied.worker);
      assignments = replaceById(assignments, applied.assignment);
      if (applied.worker.state === 'RUNNING') recoveredRunningWorkerIds.push(worker.id);
      else if (applied.worker.state === 'WAITING') waitingWorkerIds.push(worker.id);
      else if (applied.worker.state === 'FAILED' || applied.worker.state === 'BLOCKED') terminalWorkerIds.push(worker.id);
      runChanged = true;
    }

    if (runChanged) {
      const runTasks = tasks.filter((entry) => entry.orchestrationRunId === initialRun.id);
      const runState: OrchestrationRun['state'] = runTasks.some((entry) => entry.state === 'RUNNING')
        ? 'RUNNING'
        : 'WAITING';
      runs = replaceById(runs, touchRun(initialRun, now, runState));
      changed = true;
    }
  }

  if (!changed) return summary(current, inspectedWorkerIds, recoveredRunningWorkerIds, waitingWorkerIds, terminalWorkerIds);

  const next = validateMultiWorkerDocument({
    ...current,
    generation: current.generation + 1,
    runs,
    workers: workerRecords,
    tasks,
    assignments,
  });
  await store.write(next, current.generation);
  return summary(next, inspectedWorkerIds, recoveredRunningWorkerIds, waitingWorkerIds, terminalWorkerIds);
}

function applyStatus(
  task: WorkerTask,
  worker: Worker,
  assignment: WorkerAssignment,
  status: WorkerStatusReceipt,
  now: string,
): { readonly task: WorkerTask; readonly worker: Worker; readonly assignment: WorkerAssignment } {
  const shared = {
    adapterWorkerId: status.workerId,
    resumeToken: status.resumeToken,
    resumable: status.resumable,
    updatedAt: now,
  };

  if (status.state === 'RUNNING') {
    return {
      task: { ...task, state: 'RUNNING', updatedAt: now },
      worker: { ...worker, ...shared, state: 'RUNNING' },
      assignment,
    };
  }
  if (status.state === 'RESUMABLE' || status.state === 'UNKNOWN') {
    return {
      task: { ...task, state: 'WAITING', updatedAt: now },
      worker: { ...worker, ...shared, state: 'WAITING' },
      assignment,
    };
  }
  if (status.state === 'FAILED') {
    return {
      task: { ...task, state: 'FAILED', updatedAt: now },
      worker: { ...worker, ...shared, state: 'FAILED', resumable: false },
      assignment: { ...assignment, releasedAt: now },
    };
  }
  return {
    task: { ...task, state: 'BLOCKED', updatedAt: now },
    worker: { ...worker, ...shared, state: 'BLOCKED', resumable: false },
    assignment: { ...assignment, releasedAt: now },
  };
}

function bindingFor(run: OrchestrationRun, worker: Worker): WorkerBinding {
  if (worker.adapterWorkerId === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Recovery worker has no adapter identity');
  return {
    workerType: worker.workerType,
    workerId: worker.adapterWorkerId,
    resumeToken: worker.resumeToken,
    missionId: run.missionId,
    projectId: run.projectId,
    createdAt: worker.createdAt,
    lastSeenAt: worker.updatedAt,
    resumable: worker.resumable,
  };
}

async function missionForRecovery(state: RuntimeState, missionId: string) {
  try {
    return await state.getMission(missionId);
  } catch {
    return null;
  }
}

function blockRun(
  run: OrchestrationRun,
  workers: readonly Worker[],
  tasks: readonly WorkerTask[],
  assignments: readonly WorkerAssignment[],
  now: string,
) {
  let nextWorkers = [...workers];
  let nextTasks = [...tasks];
  let nextAssignments = [...assignments];
  for (const task of tasks.filter((entry) => entry.orchestrationRunId === run.id && !isTerminalTask(entry.state))) {
    nextTasks = replaceById(nextTasks, { ...task, state: 'BLOCKED', updatedAt: now });
    if (task.assignmentId === null) continue;
    const assignment = nextAssignments.find((entry) => entry.id === task.assignmentId);
    if (assignment === undefined) continue;
    const worker = nextWorkers.find((entry) => entry.id === assignment.workerId);
    if (worker !== undefined) nextWorkers = replaceById(nextWorkers, { ...worker, state: 'BLOCKED', resumable: false, updatedAt: now });
    if (assignment.releasedAt === null) nextAssignments = replaceById(nextAssignments, { ...assignment, releasedAt: now });
  }
  return { workers: nextWorkers, tasks: nextTasks, assignments: nextAssignments };
}

function cancelRunState(
  run: OrchestrationRun,
  workers: readonly Worker[],
  tasks: readonly WorkerTask[],
  assignments: readonly WorkerAssignment[],
  now: string,
) {
  let nextWorkers = [...workers];
  let nextTasks = [...tasks];
  let nextAssignments = [...assignments];
  for (const task of tasks.filter((entry) => entry.orchestrationRunId === run.id && !isTerminalTask(entry.state))) {
    nextTasks = replaceById(nextTasks, { ...task, state: 'CANCELLED', updatedAt: now });
    if (task.assignmentId === null) continue;
    const assignment = nextAssignments.find((entry) => entry.id === task.assignmentId);
    if (assignment === undefined) continue;
    const worker = nextWorkers.find((entry) => entry.id === assignment.workerId);
    if (worker !== undefined) nextWorkers = replaceById(nextWorkers, { ...worker, state: 'CANCELLED', resumable: false, updatedAt: now });
    if (assignment.releasedAt === null) nextAssignments = replaceById(nextAssignments, { ...assignment, releasedAt: now });
  }
  return { workers: nextWorkers, tasks: nextTasks, assignments: nextAssignments };
}

function isRecoverableTask(task: WorkerTask): boolean {
  return task.state === 'ASSIGNED' || task.state === 'RUNNING' || task.state === 'WAITING';
}

function isTerminalTask(state: WorkerTask['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'BLOCKED';
}

function isTerminalRun(state: OrchestrationRun['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
}

function touchRun(run: OrchestrationRun, now: string, state: OrchestrationRun['state']): OrchestrationRun {
  return { ...run, state, revision: run.revision + 1, updatedAt: now };
}

function replaceById<T extends { readonly id: string }>(items: readonly T[], replacement: T): T[] {
  return items.map((entry) => entry.id === replacement.id ? replacement : entry);
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new RuntimeError('INVALID_REQUEST', 'Recovery clock is not a timestamp');
  const canonical = new Date(value).toISOString();
  if (canonical !== value) throw new RuntimeError('INVALID_REQUEST', 'Recovery clock must be canonical UTC ISO-8601');
  return canonical;
}

function summary(
  document: MultiWorkerDocument,
  inspectedWorkerIds: readonly string[],
  recoveredRunningWorkerIds: readonly string[],
  waitingWorkerIds: readonly string[],
  terminalWorkerIds: readonly string[],
): MultiWorkerRecoverySummary {
  return Object.freeze({
    document,
    inspectedWorkerIds: Object.freeze([...new Set(inspectedWorkerIds)]),
    recoveredRunningWorkerIds: Object.freeze([...new Set(recoveredRunningWorkerIds)]),
    waitingWorkerIds: Object.freeze([...new Set(waitingWorkerIds)]),
    terminalWorkerIds: Object.freeze([...new Set(terminalWorkerIds)]),
    replayedWorkerStarts: 0 as const,
  });
}
