import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorkerTask, WorkerTaskAuthorityMetadata, WorkspaceId } from '@iris/domain';
import {
  planWorkerTaskSchedule,
  propagateDependencyBlocks,
  runBoundedWorkerBatch,
} from './scheduler.js';

function task(
  runId: string,
  state: WorkerTask['state'],
  dependencies: readonly string[] = [],
  id = randomUUID(),
  createdAt = '2026-09-20T01:00:00.000Z',
): WorkerTask {
  const authority: WorkerTaskAuthorityMetadata = {
    schemaVersion: 1,
    missionId: randomUUID(),
    taskId: id,
    sessionId: randomUUID(),
    projectId: randomUUID(),
    workspaceId: randomUUID() as WorkspaceId,
    principalId: 'worker-principal',
    parentOrchestratorId: 'chatgpt-orchestrator',
    allowedCapabilities: ['project.search'],
    allowedPaths: ['**'],
    readOnlyPaths: ['**'],
    mutablePaths: [],
    allowedProcesses: [],
    approvalPolicy: 'INHERIT_MISSION',
    resourceBudget: { maxRuntimeMs: 60_000, maxJobs: 0, maxArtifacts: 0, maxOutputBytes: 1024 },
    concurrencyPolicy: { maxParallelCapabilities: 2, mutablePathOwnership: 'READ_ONLY', allowParallelReads: true },
    createdAt,
    expiresAt: '2026-09-20T03:00:00.000Z',
  };
  return {
    id,
    orchestrationRunId: runId,
    missionId: authority.missionId,
    missionTaskId: null,
    title: `Task ${id}`,
    state,
    dependencyTaskIds: dependencies,
    authority,
    assignmentId: state === 'ASSIGNED' || state === 'RUNNING' ? randomUUID() : null,
    resultId: state === 'SUCCEEDED' ? randomUUID() : null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('IRIS multi-worker M05 DAG scheduler', () => {
  it('supports a deterministic sequential A → B → C chain', () => {
    const runId = randomUUID();
    const a = task(runId, 'ASSIGNED', [], randomUUID(), '2026-09-20T01:00:00.000Z');
    const b = task(runId, 'ASSIGNED', [a.id], randomUUID(), '2026-09-20T01:01:00.000Z');
    const c = task(runId, 'ASSIGNED', [b.id], randomUUID(), '2026-09-20T01:02:00.000Z');

    expect(planWorkerTaskSchedule([a, b, c], 3)).toMatchObject({
      readyTaskIds: [a.id],
      waitingTaskIds: [b.id, c.id],
    });

    const afterA = [{ ...a, state: 'SUCCEEDED' as const }, b, c];
    expect(planWorkerTaskSchedule(afterA, 3)).toMatchObject({
      readyTaskIds: [b.id],
      waitingTaskIds: [c.id],
    });
  });

  it('selects independent tasks in stable order up to bounded concurrency', () => {
    const runId = randomUUID();
    const a = task(runId, 'ASSIGNED', [], randomUUID(), '2026-09-20T01:00:03.000Z');
    const b = task(runId, 'ASSIGNED', [], randomUUID(), '2026-09-20T01:00:01.000Z');
    const c = task(runId, 'ASSIGNED', [], randomUUID(), '2026-09-20T01:00:02.000Z');

    expect(planWorkerTaskSchedule([a, b, c], 2).readyTaskIds).toEqual([b.id, c.id]);
  });

  it('supports a fan-out/fan-in DAG A → (B,C) → D', () => {
    const runId = randomUUID();
    const a = task(runId, 'SUCCEEDED');
    const b = task(runId, 'ASSIGNED', [a.id]);
    const c = task(runId, 'ASSIGNED', [a.id]);
    const d = task(runId, 'ASSIGNED', [b.id, c.id]);

    const plan = planWorkerTaskSchedule([a, b, c, d], 4);
    expect(new Set(plan.readyTaskIds)).toEqual(new Set([b.id, c.id]));
    expect(plan.waitingTaskIds).toEqual([d.id]);

    const afterBranches = [
      a,
      { ...b, state: 'SUCCEEDED' as const },
      { ...c, state: 'SUCCEEDED' as const },
      d,
    ];
    expect(planWorkerTaskSchedule(afterBranches, 4).readyTaskIds).toEqual([d.id]);
  });

  it('fails closed on cycles and foreign/missing dependency identities', () => {
    const runId = randomUUID();
    const aId = randomUUID();
    const bId = randomUUID();
    const a = task(runId, 'ASSIGNED', [bId], aId);
    const b = task(runId, 'ASSIGNED', [aId], bId);
    expect(() => planWorkerTaskSchedule([a, b], 2)).toThrow('dependency cycle');

    const missing = task(runId, 'ASSIGNED', [randomUUID()]);
    expect(() => planWorkerTaskSchedule([missing], 1)).toThrow('invalid dependencies');

    const foreign = task(randomUUID(), 'ASSIGNED');
    expect(() => planWorkerTaskSchedule([task(runId, 'ASSIGNED'), foreign], 2)).toThrow('mixes orchestration runs');
  });

  it('propagates failed/cancelled dependency blocking through downstream tasks', () => {
    const runId = randomUUID();
    const a = task(runId, 'FAILED');
    const b = task(runId, 'ASSIGNED', [a.id]);
    const c = task(runId, 'ASSIGNED', [b.id]);
    const propagated = propagateDependencyBlocks([a, b, c]);
    expect(propagated.map((entry) => entry.state)).toEqual(['FAILED', 'BLOCKED', 'BLOCKED']);
    expect(planWorkerTaskSchedule(propagated, 3).blockedTaskIds).toEqual([]);
    expect(planWorkerTaskSchedule([a, b, c], 3).blockedTaskIds).toContain(b.id);
  });

  it('executes at least two independent tasks concurrently while respecting the cap', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    let active = 0;
    let observed = 0;
    const result = await runBoundedWorkerBatch({
      taskIds: ids,
      maxConcurrency: 2,
      timeoutMs: 1_000,
      execute: async (taskId) => {
        active += 1;
        observed = Math.max(observed, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return `done:${taskId}`;
      },
    });
    expect(result.maxObservedConcurrency).toBe(2);
    expect(observed).toBe(2);
    expect(result.results.every((entry) => entry.status === 'SUCCEEDED')).toBe(true);
  });

  it('propagates cancellation to active workers and cancels queued work deterministically', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const controller = new AbortController();
    let starts = 0;
    const resultPromise = runBoundedWorkerBatch({
      taskIds: ids,
      maxConcurrency: 2,
      timeoutMs: 1_000,
      signal: controller.signal,
      execute: async (_taskId, signal) => {
        starts += 1;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
        });
        throw new Error('UNREACHABLE');
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await resultPromise;
    expect(starts).toBe(2);
    expect(result.results.map((entry) => entry.status)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
  });

  it('times out an abort-aware worker without starting a second queued task above the cap', async () => {
    const ids = [randomUUID(), randomUUID()];
    const result = await runBoundedWorkerBatch({
      taskIds: ids,
      maxConcurrency: 1,
      timeoutMs: 20,
      execute: async (taskId, signal) => {
        if (taskId === ids[0]) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
          });
        }
        return 'ok';
      },
    });
    expect(result.results[0]).toMatchObject({ taskId: ids[0], status: 'TIMED_OUT', errorCode: 'TASK_TIMEOUT' });
    expect(result.results[1]).toMatchObject({ taskId: ids[1], status: 'SUCCEEDED' });
    expect(result.maxObservedConcurrency).toBe(1);
  });
});
