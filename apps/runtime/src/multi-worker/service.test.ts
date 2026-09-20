import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerRuntimeFence, WorkspaceId } from '@iris/domain';
import { FoundationStateStore } from '../persistence.js';
import { VNextResourceRegistry } from '../resource-registry.js';
import { RuntimeState } from '../state.js';
import { MultiWorkerRoutingService } from './service.js';
import { MultiWorkerStore } from './store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-mw-m04-source-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-mw-m04-data-'));
  roots.push(sourceRoot, dataRoot);
  const projectRoot = path.join(sourceRoot, 'iris');
  await mkdir(projectRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('iris', projectRoot);
  const session = state.createSession('chatgpt-mw', 'chatgpt-orchestrator', 'owner');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  let mission = await state.createMission(session.clientId, session.id, 'Multi-worker routing test', 'CHATGPT');
  mission = await state.createMissionTask(mission.id, session.clientId, session.id, 'Legacy parent task');
  const resources = new VNextResourceRegistry(state, dataRoot);
  const workspace = await resources.primaryWorkspace(project.id);
  const store = new MultiWorkerStore(dataRoot);
  const service = new MultiWorkerRoutingService(
    state,
    resources,
    store,
    undefined,
    () => '2026-09-20T01:00:00.000Z',
  );
  const runtimeFence: WorkerRuntimeFence = {
    machineId: randomUUID(),
    runtimeId: randomUUID(),
    instanceId: randomUUID(),
    deploymentEpoch: 1,
    connectorProfile: 'FULL',
    catalogHash: `sha256:${'2'.repeat(64)}`,
  };
  return { state, project, session, mission, resources, workspace, store, service, runtimeFence };
}

function taskInput(
  expectedGeneration: number,
  orchestrationRunId: string,
  missionTaskId: string | null,
  workspaceId: WorkspaceId,
  principalId = 'worker-code-1',
  dependencyTaskIds: readonly string[] = [],
) {
  return {
    expectedGeneration,
    orchestrationRunId,
    missionTaskId,
    title: 'Inspect runtime routing',
    dependencyTaskIds,
    workspaceId,
    principalId,
    allowedCapabilities: ['project.search', 'fs.read'] as const,
    allowedPaths: ['apps/runtime/**'],
    readOnlyPaths: ['apps/runtime/**'],
    mutablePaths: [],
    allowedProcesses: [],
    approvalPolicy: 'INHERIT_MISSION' as const,
    resourceBudget: { maxRuntimeMs: 60_000, maxJobs: 0, maxArtifacts: 4, maxOutputBytes: 1_048_576 },
    concurrencyPolicy: { maxParallelCapabilities: 2, mutablePathOwnership: 'READ_ONLY' as const, allowParallelReads: true },
    expiresAt: '2026-09-20T03:00:00.000Z',
  };
}

describe('IRIS multi-worker M04 routing', () => {
  it('creates, assigns, starts, and completes one logical worker task without completing the parent Mission', async () => {
    const f = await fixture();
    const parentTaskId = f.mission.tasks[0]!.id;
    const runView = await f.service.createRun({
      expectedGeneration: 0,
      missionId: f.mission.id,
      parentOrchestratorId: f.session.agentId,
    });
    expect(runView).toMatchObject({ generation: 1, run: { state: 'PLANNING', missionId: f.mission.id } });

    const worker = await f.service.createWorker({
      expectedGeneration: 1,
      orchestrationRunId: runView.run.id,
      principalId: 'worker-code-1',
      workerType: 'IRIS_LOGICAL',
      role: 'CODE',
    });
    const task = await f.service.createTask(taskInput(2, runView.run.id, parentTaskId, f.workspace.workspaceId));
    const assignment = await f.service.assignTask({
      expectedGeneration: 3,
      orchestrationRunId: runView.run.id,
      taskId: task.id,
      workerId: worker.id,
      runtimeFence: f.runtimeFence,
    });
    expect(assignment.authorityDigest).toMatch(/^[a-f0-9]{64}$/);

    const running = await f.service.startTask({
      expectedGeneration: 4,
      orchestrationRunId: runView.run.id,
      taskId: task.id,
      requestId: randomUUID(),
    });
    expect(running.state).toBe('RUNNING');
    expect((await f.service.getWorker(worker.id)).adapterWorkerId).toMatch(/^logical-/);

    const completed = await f.service.completeTask({
      expectedGeneration: 5,
      orchestrationRunId: runView.run.id,
      taskId: task.id,
    });
    expect(completed.state).toBe('SUCCEEDED');

    const final = await f.service.getRun(runView.run.id);
    expect(final.generation).toBe(6);
    expect(final.run.state).toBe('REVIEWING');
    expect(final.tasks[0]?.state).toBe('SUCCEEDED');
    expect(final.workers[0]?.state).toBe('SUCCEEDED');
    expect(final.assignments[0]?.releasedAt).toBe('2026-09-20T01:00:00.000Z');
    expect(await f.service.listWorkers(runView.run.id)).toHaveLength(1);
    expect(await f.service.listTasks(runView.run.id)).toHaveLength(1);

    const authoritativeMission = await f.state.getMission(f.mission.id);
    expect(authoritativeMission.state).not.toBe('COMPLETED');
  });

  it('rejects stale generation, unknown worker adapters, and foreign workspaces', async () => {
    const f = await fixture();
    const run = (await f.service.createRun({
      expectedGeneration: 0,
      missionId: f.mission.id,
      parentOrchestratorId: f.session.agentId,
    })).run;

    await expect(f.service.createWorker({
      expectedGeneration: 0,
      orchestrationRunId: run.id,
      principalId: 'worker-code-1',
      workerType: 'IRIS_LOGICAL',
      role: 'CODE',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    await expect(f.service.createWorker({
      expectedGeneration: 1,
      orchestrationRunId: run.id,
      principalId: 'worker-code-1',
      workerType: 'UNREGISTERED_WORKER',
      role: 'CODE',
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await expect(f.service.createTask(taskInput(
      1,
      run.id,
      f.mission.tasks[0]!.id,
      randomUUID() as WorkspaceId,
    ))).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    expect((await f.store.read()).generation).toBe(1);
  });

  it('rejects assignment when worker principal does not match immutable task authority', async () => {
    const f = await fixture();
    const run = (await f.service.createRun({
      expectedGeneration: 0,
      missionId: f.mission.id,
      parentOrchestratorId: f.session.agentId,
    })).run;
    const worker = await f.service.createWorker({
      expectedGeneration: 1,
      orchestrationRunId: run.id,
      principalId: 'worker-code-a',
      workerType: 'IRIS_LOGICAL',
      role: 'CODE',
    });
    const task = await f.service.createTask(taskInput(
      2,
      run.id,
      f.mission.tasks[0]!.id,
      f.workspace.workspaceId,
      'worker-code-b',
    ));
    await expect(f.service.assignTask({
      expectedGeneration: 3,
      orchestrationRunId: run.id,
      taskId: task.id,
      workerId: worker.id,
      runtimeFence: f.runtimeFence,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    expect((await f.store.read()).generation).toBe(3);
  });

  it('fails closed when dependencies are incomplete before task start', async () => {
    const f = await fixture();
    const run = (await f.service.createRun({
      expectedGeneration: 0,
      missionId: f.mission.id,
      parentOrchestratorId: f.session.agentId,
    })).run;
    const dependency = await f.service.createTask(taskInput(
      1,
      run.id,
      f.mission.tasks[0]!.id,
      f.workspace.workspaceId,
      'worker-dependency',
    ));
    const worker = await f.service.createWorker({
      expectedGeneration: 2,
      orchestrationRunId: run.id,
      principalId: 'worker-code-1',
      workerType: 'IRIS_LOGICAL',
      role: 'CODE',
    });
    const task = await f.service.createTask(taskInput(
      3,
      run.id,
      f.mission.tasks[0]!.id,
      f.workspace.workspaceId,
      'worker-code-1',
      [dependency.id],
    ));
    await f.service.assignTask({
      expectedGeneration: 4,
      orchestrationRunId: run.id,
      taskId: task.id,
      workerId: worker.id,
      runtimeFence: f.runtimeFence,
    });
    await expect(f.service.startTask({
      expectedGeneration: 5,
      orchestrationRunId: run.id,
      taskId: task.id,
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    expect((await f.store.read()).generation).toBe(5);
  });

  it('cancels an active logical run without touching parent Mission state', async () => {
    const f = await fixture();
    const run = (await f.service.createRun({
      expectedGeneration: 0,
      missionId: f.mission.id,
      parentOrchestratorId: f.session.agentId,
    })).run;
    const worker = await f.service.createWorker({
      expectedGeneration: 1,
      orchestrationRunId: run.id,
      principalId: 'worker-code-1',
      workerType: 'IRIS_LOGICAL',
      role: 'CODE',
    });
    const task = await f.service.createTask(taskInput(2, run.id, f.mission.tasks[0]!.id, f.workspace.workspaceId));
    await f.service.assignTask({
      expectedGeneration: 3,
      orchestrationRunId: run.id,
      taskId: task.id,
      workerId: worker.id,
      runtimeFence: f.runtimeFence,
    });
    await f.service.startTask({
      expectedGeneration: 4,
      orchestrationRunId: run.id,
      taskId: task.id,
      requestId: randomUUID(),
    });
    const cancelled = await f.service.cancelRun({ expectedGeneration: 5, orchestrationRunId: run.id });
    expect(cancelled.run.state).toBe('CANCELLED');
    expect(cancelled.tasks[0]?.state).toBe('CANCELLED');
    expect(cancelled.workers[0]?.state).toBe('CANCELLED');
    expect((await f.state.getMission(f.mission.id)).state).not.toBe('COMPLETED');
  });

  it('rejects a forged parent orchestrator identity before creating durable run state', async () => {
    const f = await fixture();
    await expect(f.service.createRun({
      expectedGeneration: 0,
      missionId: f.mission.id,
      parentOrchestratorId: 'foreign-orchestrator',
    })).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    expect((await f.store.read()).generation).toBe(0);
  });

  it('rejects creation from a terminal parent Mission', async () => {
    const f = await fixture();
    await f.state.setMissionState(f.mission.id, f.session.clientId, f.session.id, 'COMPLETED');
    await expect(f.service.createRun({
      expectedGeneration: 0,
      missionId: f.mission.id,
      parentOrchestratorId: f.session.agentId,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    expect((await f.store.read()).generation).toBe(0);
  });
});


describe('IRIS multi-worker M06 routing ownership integration', () => {
  it('rejects overlapping mutable assignment until the current owner is explicitly released', async () => {
    const f = await fixture();
    const run = (await f.service.createRun({
      expectedGeneration: 0,
      missionId: f.mission.id,
      parentOrchestratorId: f.session.agentId,
    })).run;
    const workerA = await f.service.createWorker({
      expectedGeneration: 1,
      orchestrationRunId: run.id,
      principalId: 'worker-a',
      workerType: 'IRIS_LOGICAL',
      role: 'CODE',
    });
    const workerB = await f.service.createWorker({
      expectedGeneration: 2,
      orchestrationRunId: run.id,
      principalId: 'worker-b',
      workerType: 'IRIS_LOGICAL',
      role: 'CODE',
    });
    const baseA = taskInput(3, run.id, f.mission.tasks[0]!.id, f.workspace.workspaceId, 'worker-a');
    const taskA = await f.service.createTask({
      ...baseA,
      allowedCapabilities: ['fs.read', 'fs.write'] as const,
      mutablePaths: ['apps/runtime/**'],
      concurrencyPolicy: { ...baseA.concurrencyPolicy, mutablePathOwnership: 'EXCLUSIVE' as const },
    });
    const baseB = taskInput(4, run.id, f.mission.tasks[0]!.id, f.workspace.workspaceId, 'worker-b');
    const taskB = await f.service.createTask({
      ...baseB,
      allowedCapabilities: ['fs.read', 'fs.write'] as const,
      mutablePaths: ['apps/runtime/src/state.ts'],
      concurrencyPolicy: { ...baseB.concurrencyPolicy, mutablePathOwnership: 'EXCLUSIVE' as const },
    });

    await f.service.assignTask({
      expectedGeneration: 5,
      orchestrationRunId: run.id,
      taskId: taskA.id,
      workerId: workerA.id,
      runtimeFence: f.runtimeFence,
    });

    await expect(f.service.assignTask({
      expectedGeneration: 6,
      orchestrationRunId: run.id,
      taskId: taskB.id,
      workerId: workerB.id,
      runtimeFence: f.runtimeFence,
    })).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    expect((await f.store.read()).generation).toBe(6);

    await f.service.cancelTask({
      expectedGeneration: 6,
      orchestrationRunId: run.id,
      taskId: taskA.id,
    });
    const assigned = await f.service.assignTask({
      expectedGeneration: 7,
      orchestrationRunId: run.id,
      taskId: taskB.id,
      workerId: workerB.id,
      runtimeFence: f.runtimeFence,
    });
    expect(assigned.taskId).toBe(taskB.id);
    expect((await f.store.read()).generation).toBe(8);
  });
});

describe('IRIS multi-worker M07 structured worker results', () => {
  async function completedReadOnlyTask() {
    const f = await fixture();
    const run = (await f.service.createRun({
      expectedGeneration: 0,
      missionId: f.mission.id,
      parentOrchestratorId: f.session.agentId,
    })).run;
    const worker = await f.service.createWorker({
      expectedGeneration: 1,
      orchestrationRunId: run.id,
      principalId: 'worker-result-1',
      workerType: 'IRIS_LOGICAL',
      role: 'RESEARCH',
    });
    const task = await f.service.createTask(taskInput(
      2,
      run.id,
      f.mission.tasks[0]!.id,
      f.workspace.workspaceId,
      'worker-result-1',
    ));
    await f.service.assignTask({
      expectedGeneration: 3,
      orchestrationRunId: run.id,
      taskId: task.id,
      workerId: worker.id,
      runtimeFence: f.runtimeFence,
    });
    await f.service.startTask({
      expectedGeneration: 4,
      orchestrationRunId: run.id,
      taskId: task.id,
      requestId: randomUUID(),
    });
    await f.service.completeTask({
      expectedGeneration: 5,
      orchestrationRunId: run.id,
      taskId: task.id,
    });
    return { ...f, run, worker, task };
  }

  it('persists a bounded structured result and links it to run/task/worker without completing the parent Mission', async () => {
    const f = await completedReadOnlyTask();
    const result = await f.service.recordResult({
      expectedGeneration: 6,
      orchestrationRunId: f.run.id,
      taskId: f.task.id,
      workerId: f.worker.id,
      status: 'SUCCEEDED',
      summary: 'Runtime routing evidence collected',
      evidenceRefs: ['evidence:runtime-routing'],
      artifactIds: [],
      filesRead: ['apps/runtime/src/state.ts'],
      filesChanged: [],
      commandsExecuted: [],
      validationResults: [{ name: 'focused-review', status: 'PASSED', summary: 'Read-only checks passed' }],
      risks: ['No mutation was performed'],
      blockers: [],
      recommendedNextActions: ['Review the structured evidence'],
    });

    expect(result).toMatchObject({
      taskId: f.task.id,
      workerId: f.worker.id,
      status: 'SUCCEEDED',
      filesRead: ['apps/runtime/src/state.ts'],
    });
    const final = await f.service.getRun(f.run.id);
    expect(final.generation).toBe(7);
    expect(final.run.resultIds).toEqual([result.id]);
    expect(final.tasks[0]?.resultId).toBe(result.id);
    expect(final.results).toEqual([result]);
    expect(await f.service.getResult(result.id)).toEqual(result);
    expect(await f.service.listResults(f.run.id)).toEqual([result]);
    expect((await f.state.getMission(f.mission.id)).state).not.toBe('COMPLETED');
  });

  it('rejects result path escalation and status mismatch without publishing a generation', async () => {
    const f = await completedReadOnlyTask();
    const base = {
      expectedGeneration: 6,
      orchestrationRunId: f.run.id,
      taskId: f.task.id,
      workerId: f.worker.id,
      summary: 'Result',
      evidenceRefs: [] as string[],
      artifactIds: [] as string[],
      commandsExecuted: [] as string[],
      validationResults: [],
      risks: [] as string[],
      blockers: [] as string[],
      recommendedNextActions: [] as string[],
    };

    await expect(f.service.recordResult({
      ...base,
      status: 'FAILED',
      filesRead: ['apps/runtime/src/state.ts'],
      filesChanged: [],
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await expect(f.service.recordResult({
      ...base,
      status: 'SUCCEEDED',
      filesRead: ['docs/outside.md'],
      filesChanged: [],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await expect(f.service.recordResult({
      ...base,
      status: 'SUCCEEDED',
      filesRead: ['apps/runtime/src/state.ts'],
      filesChanged: ['apps/runtime/src/state.ts'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    expect((await f.store.read()).generation).toBe(6);
  });

  it('rejects invented artifact references and duplicate result publication', async () => {
    const f = await completedReadOnlyTask();
    const input = {
      expectedGeneration: 6,
      orchestrationRunId: f.run.id,
      taskId: f.task.id,
      workerId: f.worker.id,
      status: 'SUCCEEDED' as const,
      summary: 'Result',
      evidenceRefs: [] as string[],
      artifactIds: [] as string[],
      filesRead: ['apps/runtime/src/state.ts'],
      filesChanged: [] as string[],
      commandsExecuted: [] as string[],
      validationResults: [],
      risks: [] as string[],
      blockers: [] as string[],
      recommendedNextActions: [] as string[],
    };

    await expect(f.service.recordResult({
      ...input,
      artifactIds: [randomUUID()],
    })).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
    expect((await f.store.read()).generation).toBe(6);

    const result = await f.service.recordResult(input);
    await expect(f.service.recordResult({
      ...input,
      expectedGeneration: 7,
      summary: 'Second result',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect((await f.store.read()).generation).toBe(7);
    expect((await f.service.getTask(f.task.id)).resultId).toBe(result.id);
  });
});
