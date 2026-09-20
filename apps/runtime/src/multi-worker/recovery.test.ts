import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerRuntimeFence, WorkspaceId } from '@iris/domain';
import type {
  WorkerAdapter,
  WorkerCheckpointReceipt,
  WorkerStartReceipt,
  WorkerStatusReceipt,
} from '../durable-mission-lifecycle.js';
import { WorkerAdapterRegistry } from '../durable-mission-workers.js';
import { FoundationStateStore } from '../persistence.js';
import { VNextResourceRegistry } from '../resource-registry.js';
import { RuntimeState } from '../state.js';
import { recoverMultiWorkerRuns } from './recovery.js';
import { MultiWorkerRoutingService } from './service.js';
import { MultiWorkerStore } from './store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class RecoveryAdapter implements WorkerAdapter {
  public readonly workerType = 'IRIS_LOGICAL';
  public starts = 0;
  public statuses = 0;
  public statusState: WorkerStatusReceipt['state'] = 'RUNNING';
  public throwStatus = false;
  public throwAfterStart = false;

  public planStart(input: Parameters<WorkerAdapter['planStart']>[0]): WorkerStartReceipt {
    return {
      workerId: `logical-${input.operationId}`,
      resumeToken: input.operationId,
      resumable: true,
    };
  }

  public async start(input: Parameters<WorkerAdapter['start']>[0]): Promise<WorkerStartReceipt> {
    this.starts += 1;
    const receipt = this.planStart(input);
    if (this.throwAfterStart) throw new Error('START_RESULT_LOST_AFTER_SIDE_EFFECT');
    return receipt;
  }

  public async checkpoint(input: Parameters<WorkerAdapter['checkpoint']>[0]): Promise<WorkerCheckpointReceipt> {
    return { workerStateRef: `logical:${input.binding.workerId}`, resumeMetadata: {} };
  }

  public async resume(input: Parameters<WorkerAdapter['resume']>[0]): Promise<WorkerStartReceipt> {
    return {
      workerId: input.binding.workerId,
      resumeToken: input.binding.resumeToken,
      resumable: input.binding.resumable,
    };
  }

  public async cancel(): Promise<void> {}

  public async status(input: Parameters<WorkerAdapter['status']>[0]): Promise<WorkerStatusReceipt> {
    this.statuses += 1;
    if (this.throwStatus) throw new Error('STATUS_UNAVAILABLE');
    return {
      state: this.statusState,
      workerId: input.binding.workerId,
      resumeToken: input.binding.resumeToken,
      resumable: this.statusState === 'RUNNING' || this.statusState === 'RESUMABLE',
    };
  }
}

async function fixture(startWorker = true) {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-mw-m09-source-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-mw-m09-data-'));
  roots.push(sourceRoot, dataRoot);
  const projectRoot = path.join(sourceRoot, 'iris');
  await mkdir(projectRoot);

  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('iris', projectRoot);
  const session = state.createSession('chatgpt-mw-m09', 'chatgpt-orchestrator', 'owner');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  let mission = await state.createMission(session.clientId, session.id, 'M09 recovery test', 'CHATGPT');
  mission = await state.createMissionTask(mission.id, session.clientId, session.id, 'Parent task');

  const resources = new VNextResourceRegistry(state, dataRoot);
  const workspace = await resources.primaryWorkspace(project.id);
  const store = new MultiWorkerStore(dataRoot);
  const adapter = new RecoveryAdapter();
  const registry = new WorkerAdapterRegistry([adapter]);
  const service = new MultiWorkerRoutingService(
    state,
    resources,
    store,
    registry,
    () => '2026-09-20T01:00:00.000Z',
  );
  const runtimeFence: WorkerRuntimeFence = {
    machineId: randomUUID(),
    runtimeId: randomUUID(),
    instanceId: randomUUID(),
    deploymentEpoch: 1,
    connectorProfile: 'FULL',
    catalogHash: `sha256:${'3'.repeat(64)}`,
  };

  const run = (await service.createRun({
    expectedGeneration: 0,
    missionId: mission.id,
    parentOrchestratorId: session.agentId,
  })).run;
  const worker = await service.createWorker({
    expectedGeneration: 1,
    orchestrationRunId: run.id,
    principalId: 'worker-recovery-1',
    workerType: 'IRIS_LOGICAL',
    role: 'CODE',
  });
  const task = await service.createTask({
    expectedGeneration: 2,
    orchestrationRunId: run.id,
    missionTaskId: mission.tasks[0]!.id,
    title: 'Recover this worker',
    dependencyTaskIds: [],
    workspaceId: workspace.workspaceId as WorkspaceId,
    principalId: 'worker-recovery-1',
    allowedCapabilities: ['project.search', 'fs.read'],
    allowedPaths: ['apps/runtime/**'],
    readOnlyPaths: ['apps/runtime/**'],
    mutablePaths: [],
    allowedProcesses: [],
    approvalPolicy: 'INHERIT_MISSION',
    resourceBudget: { maxRuntimeMs: 60_000, maxJobs: 0, maxArtifacts: 2, maxOutputBytes: 1_048_576 },
    concurrencyPolicy: { maxParallelCapabilities: 1, mutablePathOwnership: 'READ_ONLY', allowParallelReads: true },
    expiresAt: '2026-09-20T03:00:00.000Z',
  });
  await service.assignTask({
    expectedGeneration: 3,
    orchestrationRunId: run.id,
    taskId: task.id,
    workerId: worker.id,
    runtimeFence,
  });
  if (startWorker) {
    await service.startTask({
      expectedGeneration: 4,
      orchestrationRunId: run.id,
      taskId: task.id,
      requestId: randomUUID(),
    });
  }

  return { dataRoot, state, project, session, mission, resources, workspace, store, adapter, registry, service, run, worker, task };
}

describe('IRIS multi-worker M09 durable worker recovery', () => {
  it('reattaches a running worker by status only and never replays worker start', async () => {
    const f = await fixture();
    expect(f.adapter.starts).toBe(1);
    f.adapter.statusState = 'RUNNING';

    const recovered = await recoverMultiWorkerRuns(
      f.state,
      f.resources,
      new MultiWorkerStore(f.dataRoot),
      f.registry,
      () => '2026-09-20T01:30:00.000Z',
    );

    expect(recovered.replayedWorkerStarts).toBe(0);
    expect(f.adapter.starts).toBe(1);
    expect(f.adapter.statuses).toBe(1);
    expect(recovered.document.generation).toBe(7);
    expect(recovered.document.tasks[0]?.state).toBe('RUNNING');
    expect(recovered.document.workers[0]?.state).toBe('RUNNING');
    expect(recovered.document.runs[0]?.state).toBe('RUNNING');
    expect(recovered.recoveredRunningWorkerIds).toEqual([f.worker.id]);
  });

  it('recovers a durably planned STARTING worker without replaying worker start', async () => {
    const f = await fixture(false);
    const requestId = randomUUID();
    f.adapter.throwAfterStart = true;

    await expect(f.service.startTask({
      expectedGeneration: 4,
      orchestrationRunId: f.run.id,
      taskId: f.task.id,
      requestId,
    })).rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED' });

    const starting = await f.store.read();
    expect(starting.generation).toBe(5);
    expect(starting.tasks[0]?.state).toBe('STARTING');
    expect(starting.workers[0]).toMatchObject({
      state: 'STARTING',
      adapterWorkerId: `logical-${requestId}`,
      resumeToken: requestId,
      resumable: true,
    });
    expect(f.adapter.starts).toBe(1);

    f.adapter.throwAfterStart = false;
    f.adapter.statusState = 'RUNNING';
    const recovered = await recoverMultiWorkerRuns(
      f.state,
      f.resources,
      f.store,
      f.registry,
      () => '2026-09-20T01:30:00.000Z',
    );

    expect(recovered.replayedWorkerStarts).toBe(0);
    expect(f.adapter.starts).toBe(1);
    expect(f.adapter.statuses).toBe(1);
    expect(recovered.document.generation).toBe(6);
    expect(recovered.document.tasks[0]?.state).toBe('RUNNING');
    expect(recovered.document.workers[0]?.state).toBe('RUNNING');
  });

  it('moves resumable or unknown workers to WAITING without releasing their assignment authority', async () => {
    for (const statusState of ['RESUMABLE', 'UNKNOWN'] as const) {
      const f = await fixture();
      f.adapter.statusState = statusState;
      const recovered = await recoverMultiWorkerRuns(
        f.state,
        f.resources,
        f.store,
        f.registry,
        () => '2026-09-20T01:30:00.000Z',
      );

      expect(recovered.document.tasks[0]?.state).toBe('WAITING');
      expect(recovered.document.workers[0]?.state).toBe('WAITING');
      expect(recovered.document.assignments[0]?.releasedAt).toBeNull();
      expect(recovered.document.runs[0]?.state).toBe('WAITING');
      expect(recovered.waitingWorkerIds).toEqual([f.worker.id]);
      expect(f.adapter.starts).toBe(1);
    }
  });

  it.each([
    ['STOPPED', 'BLOCKED'],
    ['FAILED', 'FAILED'],
  ] as const)('fails closed for %s worker state and releases the stale assignment as %s', async (statusState, expectedState) => {
    const f = await fixture();
    f.adapter.statusState = statusState;
    const recovered = await recoverMultiWorkerRuns(
      f.state,
      f.resources,
      f.store,
      f.registry,
      () => '2026-09-20T01:30:00.000Z',
    );

    expect(recovered.document.tasks[0]?.state).toBe(expectedState);
    expect(recovered.document.workers[0]?.state).toBe(expectedState);
    expect(recovered.document.assignments[0]?.releasedAt).toBe('2026-09-20T01:30:00.000Z');
    expect(recovered.document.runs[0]?.state).toBe('WAITING');
    expect(recovered.terminalWorkerIds).toEqual([f.worker.id]);
    expect(f.adapter.starts).toBe(1);
  });

  it('fails safe to WAITING when adapter status cannot be proven and still performs no replay', async () => {
    const f = await fixture();
    f.adapter.throwStatus = true;
    const recovered = await recoverMultiWorkerRuns(
      f.state,
      f.resources,
      f.store,
      f.registry,
      () => '2026-09-20T01:30:00.000Z',
    );

    expect(recovered.document.tasks[0]?.state).toBe('WAITING');
    expect(recovered.document.workers[0]?.state).toBe('WAITING');
    expect(recovered.document.assignments[0]?.releasedAt).toBeNull();
    expect(f.adapter.starts).toBe(1);
    expect(recovered.replayedWorkerStarts).toBe(0);
  });

  it('cancels recoverable run state when the authoritative parent Mission is already terminal without touching the worker adapter', async () => {
    const f = await fixture();
    await f.state.setMissionState(f.mission.id, f.session.clientId, f.session.id, 'COMPLETED');
    const recovered = await recoverMultiWorkerRuns(
      f.state,
      f.resources,
      f.store,
      f.registry,
      () => '2026-09-20T01:30:00.000Z',
    );

    expect(recovered.document.runs[0]?.state).toBe('CANCELLED');
    expect(recovered.document.tasks[0]?.state).toBe('CANCELLED');
    expect(recovered.document.workers[0]?.state).toBe('CANCELLED');
    expect(recovered.document.assignments[0]?.releasedAt).toBe('2026-09-20T01:30:00.000Z');
    expect(f.adapter.statuses).toBe(0);
    expect(f.adapter.starts).toBe(1);
  });
});
