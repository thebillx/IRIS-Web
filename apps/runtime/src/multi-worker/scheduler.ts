import { RuntimeError, type WorkerTask } from '@iris/domain';

const MAX_BATCH = 128;

export interface WorkerTaskSchedulePlan {
  readonly orchestrationRunId: string;
  readonly maxConcurrency: number;
  readonly runningTaskIds: readonly string[];
  readonly readyTaskIds: readonly string[];
  readonly waitingTaskIds: readonly string[];
  readonly blockedTaskIds: readonly string[];
  readonly terminalTaskIds: readonly string[];
}

export type WorkerBatchTaskStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

export interface WorkerBatchTaskResult<Value> {
  readonly taskId: string;
  readonly status: WorkerBatchTaskStatus;
  readonly value: Value | null;
  readonly errorCode: string | null;
}

export interface WorkerBatchResult<Value> {
  readonly results: readonly WorkerBatchTaskResult<Value>[];
  readonly maxObservedConcurrency: number;
}

export interface RunBoundedWorkerBatchInput<Value> {
  readonly taskIds: readonly string[];
  readonly maxConcurrency: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * Coordination only. The executor remains responsible for routing every machine effect through
   * CapabilityService / governed jobs and MUST honor the AbortSignal before continuing effects.
   */
  readonly execute: (taskId: string, signal: AbortSignal) => Promise<Value>;
}

/**
 * Validate one run-local DAG and deterministically identify runnable work.
 *
 * This function does not mutate task state. Downstream failed/cancelled/blocked dependencies are
 * surfaced as blocked so the orchestration service can persist the transition under its own CAS.
 */
export function planWorkerTaskSchedule(
  tasksInput: readonly WorkerTask[],
  maxConcurrencyInput: number,
): WorkerTaskSchedulePlan {
  const tasks = validateTaskGraph(tasksInput);
  const maxConcurrency = boundedConcurrency(maxConcurrencyInput);
  const runIds = new Set(tasks.map((task) => task.orchestrationRunId));
  if (runIds.size !== 1) throw new RuntimeError('INVALID_REQUEST', 'Worker scheduler requires exactly one orchestration run');
  const orchestrationRunId = tasks[0]!.orchestrationRunId;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const running = tasks.filter((task) => task.state === 'RUNNING').sort(taskOrder);
  const capacity = Math.max(0, maxConcurrency - running.length);
  const blocked: WorkerTask[] = [];
  const waiting: WorkerTask[] = [];
  const ready: WorkerTask[] = [];
  const terminal: WorkerTask[] = [];

  for (const task of [...tasks].sort(taskOrder)) {
    if (isTerminal(task.state)) {
      terminal.push(task);
      continue;
    }
    const dependencies = task.dependencyTaskIds.map((id) => byId.get(id)!);
    if (dependencies.some((dependency) => dependency.state === 'FAILED'
      || dependency.state === 'CANCELLED'
      || dependency.state === 'BLOCKED')) {
      blocked.push(task);
      continue;
    }
    if (task.state === 'RUNNING') continue;
    if (!dependencies.every((dependency) => dependency.state === 'SUCCEEDED')) {
      waiting.push(task);
      continue;
    }
    if (task.state === 'ASSIGNED') ready.push(task);
    else waiting.push(task);
  }

  return Object.freeze({
    orchestrationRunId,
    maxConcurrency,
    runningTaskIds: Object.freeze(running.map((task) => task.id)),
    readyTaskIds: Object.freeze(ready.slice(0, capacity).map((task) => task.id)),
    waitingTaskIds: Object.freeze(waiting.map((task) => task.id)),
    blockedTaskIds: Object.freeze(blocked.map((task) => task.id)),
    terminalTaskIds: Object.freeze(terminal.map((task) => task.id)),
  });
}

/**
 * Compute deterministic dependency-failure propagation without touching persistent state.
 */
export function propagateDependencyBlocks(tasksInput: readonly WorkerTask[]): readonly WorkerTask[] {
  const original = validateTaskGraph(tasksInput);
  let tasks = original.map((task) => ({ ...task }));
  let changed = true;
  while (changed) {
    changed = false;
    const byId = new Map(tasks.map((task) => [task.id, task]));
    tasks = tasks.map((task) => {
      if (isTerminal(task.state) || task.state === 'RUNNING') return task;
      const dependencies = task.dependencyTaskIds.map((id) => byId.get(id)!);
      if (dependencies.some((dependency) => dependency.state === 'FAILED'
        || dependency.state === 'CANCELLED'
        || dependency.state === 'BLOCKED')) {
        changed = task.state !== 'BLOCKED' || changed;
        return task.state === 'BLOCKED' ? task : { ...task, state: 'BLOCKED' as const };
      }
      return task;
    });
  }
  return Object.freeze(tasks);
}

/**
 * Execute an already-authorized batch with bounded concurrency.
 *
 * This is not a shell/process runner. The supplied executor must be a governed, abort-aware bridge
 * (for example a CapabilityService or DurableJobManager-backed operation in later slices).
 */
export async function runBoundedWorkerBatch<Value>(
  input: RunBoundedWorkerBatchInput<Value>,
): Promise<WorkerBatchResult<Value>> {
  const taskIds = boundedTaskIds(input.taskIds);
  const maxConcurrency = boundedConcurrency(input.maxConcurrency);
  const timeoutMs = boundedTimeout(input.timeoutMs);
  if (typeof input.execute !== 'function') throw new RuntimeError('INVALID_REQUEST', 'Worker batch executor is required');

  let nextIndex = 0;
  let active = 0;
  let maxObservedConcurrency = 0;
  const results = new Map<string, WorkerBatchTaskResult<Value>>();

  const runOne = async (taskId: string): Promise<void> => {
    if (input.signal?.aborted) {
      results.set(taskId, terminalResult<Value>(taskId, 'CANCELLED', null, 'BATCH_CANCELLED'));
      return;
    }

    active += 1;
    maxObservedConcurrency = Math.max(maxObservedConcurrency, active);
    const controller = new AbortController();
    let timeoutTriggered = false;
    let parentCancelled = false;

    const onParentAbort = () => {
      parentCancelled = true;
      controller.abort('BATCH_CANCELLED');
    };
    input.signal?.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort('TASK_TIMEOUT');
    }, timeoutMs);

    try {
      const execution = Promise.resolve().then(() => input.execute(taskId, controller.signal));
      const abort = new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted) {
          reject(new BatchAbortError());
          return;
        }
        controller.signal.addEventListener('abort', () => reject(new BatchAbortError()), { once: true });
      });
      const value = await Promise.race([execution, abort]);
      results.set(taskId, terminalResult<Value>(taskId, 'SUCCEEDED', value, null));
    } catch (error) {
      if (timeoutTriggered) results.set(taskId, terminalResult<Value>(taskId, 'TIMED_OUT', null, 'TASK_TIMEOUT'));
      else if (parentCancelled || input.signal?.aborted) results.set(taskId, terminalResult<Value>(taskId, 'CANCELLED', null, 'BATCH_CANCELLED'));
      else results.set(taskId, terminalResult<Value>(taskId, 'FAILED', null, boundedErrorCode(error)));
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onParentAbort);
      active -= 1;
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (input.signal?.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= taskIds.length) return;
      await runOne(taskIds[index]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, taskIds.length) }, () => worker()));

  if (input.signal?.aborted) {
    for (const taskId of taskIds) {
      if (!results.has(taskId)) results.set(taskId, terminalResult<Value>(taskId, 'CANCELLED', null, 'BATCH_CANCELLED'));
    }
  }

  return Object.freeze({
    results: Object.freeze(taskIds.map((taskId) => results.get(taskId)
      ?? terminalResult<Value>(taskId, 'CANCELLED', null, 'BATCH_CANCELLED'))),
    maxObservedConcurrency,
  });
}

function validateTaskGraph(tasksInput: readonly WorkerTask[]): readonly WorkerTask[] {
  if (!Array.isArray(tasksInput) || tasksInput.length === 0 || tasksInput.length > 2_000) {
    throw new RuntimeError('INVALID_REQUEST', 'Worker task graph must be non-empty and bounded');
  }
  const tasks = [...tasksInput];
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) throw new RuntimeError('INVALID_REQUEST', 'Worker task graph contains duplicate IDs');
  const runIds = new Set(tasks.map((task) => task.orchestrationRunId));
  if (runIds.size !== 1) throw new RuntimeError('INVALID_REQUEST', 'Worker task graph mixes orchestration runs');
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.dependencyTaskIds.includes(task.id)
      || task.dependencyTaskIds.some((id: string) => !byId.has(id))
      || new Set(task.dependencyTaskIds).size !== task.dependencyTaskIds.length) {
      throw new RuntimeError('INVALID_REQUEST', 'Worker task graph contains invalid dependencies');
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new RuntimeError('INVALID_REQUEST', 'Worker task graph contains a dependency cycle');
    visiting.add(taskId);
    for (const dependencyId of byId.get(taskId)!.dependencyTaskIds) visit(dependencyId);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
  return tasks;
}

function taskOrder(left: WorkerTask, right: WorkerTask): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function boundedTaskIds(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH || new Set(value).size !== value.length
    || value.some((entry) => typeof entry !== 'string' || !/^[0-9a-f-]{36}$/i.test(entry))) {
    throw new RuntimeError('INVALID_REQUEST', 'Worker batch task IDs are invalid or unbounded');
  }
  return Object.freeze([...value]);
}

function boundedConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new RuntimeError('INVALID_REQUEST', 'Worker concurrency must be from 1 through 32');
  }
  return value;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
    throw new RuntimeError('INVALID_REQUEST', 'Worker timeout must be from 1 through 3600000 milliseconds');
  }
  return value;
}

function isTerminal(state: WorkerTask['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'BLOCKED';
}

function terminalResult<Value>(
  taskId: string,
  status: WorkerBatchTaskStatus,
  value: Value | null,
  errorCode: string | null,
): WorkerBatchTaskResult<Value> {
  return Object.freeze({ taskId, status, value, errorCode });
}

function boundedErrorCode(error: unknown): string {
  if (error instanceof RuntimeError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)) return error.message;
  return 'WORKER_EXECUTION_FAILED';
}

class BatchAbortError extends Error {}
