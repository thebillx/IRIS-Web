import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';
import { DurableMissionLifecycleStore } from './durable-mission-store.js';
import { DurableMissionLifecycleService } from './durable-mission-service.js';
import { WorkerAdapterRegistry } from './durable-mission-workers.js';
import { recoverDurableMissions } from './durable-mission-recovery.js';
import type { WorkerAdapter, WorkerCheckpointReceipt, WorkerStartReceipt, WorkerStatusReceipt } from './durable-mission-lifecycle.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class CountingWorker implements WorkerAdapter {
  public readonly workerType = 'COUNTING';
  public starts = 0;
  public checkpoints = 0;
  public resumes = 0;
  public cancels = 0;
  public statuses = 0;

  public async start(): Promise<WorkerStartReceipt> {
    this.starts += 1;
    return { workerId: `worker-start-${this.starts}`, resumeToken: `start-token-${this.starts}`, resumable: true };
  }

  public async checkpoint(input: Parameters<WorkerAdapter['checkpoint']>[0]): Promise<WorkerCheckpointReceipt> {
    this.checkpoints += 1;
    return { workerStateRef: `checkpoint:${input.binding.workerId}:${this.checkpoints}`, resumeMetadata: { checkpoint: this.checkpoints } };
  }

  public async resume(): Promise<WorkerStartReceipt> {
    this.resumes += 1;
    return { workerId: `worker-resumed-${this.resumes}`, resumeToken: `resume-token-${this.resumes}`, resumable: true };
  }

  public async cancel(): Promise<void> { this.cancels += 1; }

  public async status(input: Parameters<WorkerAdapter['status']>[0]): Promise<WorkerStatusReceipt> {
    this.statuses += 1;
    return { state: 'RESUMABLE', workerId: input.binding.workerId, resumeToken: input.binding.resumeToken, resumable: true };
  }
}

async function fixture() {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-v21-source-')); roots.push(sourceRoot);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-v21-data-')); roots.push(dataRoot);
  const projectARoot = path.join(sourceRoot, 'iris');
  const projectBRoot = path.join(sourceRoot, 'farmer-project');
  await mkdir(projectARoot); await mkdir(projectBRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const projectA = await state.registerProject('iris', projectARoot);
  const projectB = await state.registerProject('farmer-project', projectBRoot);
  const session = state.createSession('chatgpt-v21', 'chatgpt-direct-orchestrator', 'owner');
  await state.setSessionCurrentProject(session.id, session.clientId, projectA.id);
  const mission = await state.createMission(session.clientId, session.id, 'V2.1 durable mission', 'CHATGPT');
  const store = new DurableMissionLifecycleStore(dataRoot);
  const worker = new CountingWorker();
  const service = new DurableMissionLifecycleService(state, store, new WorkerAdapterRegistry([worker]));
  return { dataRoot, state, projectA, projectB, session, mission, store, worker, service };
}

describe('IRIS V2.1 durable supervisor mission lifecycle', () => {
  it('keeps one mission id across start, checkpoint, directive, idempotent resume, restart, and worker replacement', async () => {
    const f = await fixture();
    let lifecycle = await f.service.ensureMission(f.mission.id, 'Prove durable worker-agnostic continuation.');
    expect(lifecycle).toMatchObject({ missionId: f.mission.id, projectId: f.projectA.id, state: 'CREATED', revision: 1 });

    const startRequest = randomUUID();
    lifecycle = await f.service.start({ missionId: f.mission.id, expectedRevision: lifecycle.revision, requestId: startRequest, workerType: 'COUNTING' });
    expect(lifecycle).toMatchObject({ missionId: f.mission.id, state: 'RUNNING', revision: 3 });
    expect(f.worker.starts).toBe(1);
    const duplicateStart = await f.service.start({ missionId: f.mission.id, expectedRevision: 1, requestId: startRequest, workerType: 'COUNTING' });
    expect(duplicateStart.revision).toBe(3);
    expect(f.worker.starts).toBe(1);

    const checkpointId = randomUUID();
    lifecycle = await f.service.checkpoint({
      missionId: f.mission.id, expectedRevision: lifecycle.revision, checkpointId,
      summary: 'Worker reached a durable supervisor boundary.', evidenceRefs: ['governed-test:pass'],
    });
    expect(lifecycle).toMatchObject({ missionId: f.mission.id, state: 'WAITING_FOR_SUPERVISOR', revision: 5 });
    expect(lifecycle.checkpoints.at(-1)).toMatchObject({ checkpointId, projectId: f.projectA.id, revision: 5 });
    expect(f.worker.checkpoints).toBe(1);

    const directiveId = randomUUID();
    lifecycle = await f.service.acceptDirective({
      missionId: f.mission.id, basedOnRevision: lifecycle.revision, directiveId, directive: 'Continue within the same registered project.',
    });
    expect(lifecycle.revision).toBe(6);
    await expect(f.service.acceptDirective({
      missionId: f.mission.id, basedOnRevision: 5, directiveId: randomUUID(), directive: 'This stale directive must fail closed.',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    const resumeRequest = randomUUID();
    lifecycle = await f.service.resume({ missionId: f.mission.id, expectedRevision: lifecycle.revision, requestId: resumeRequest });
    expect(lifecycle).toMatchObject({ missionId: f.mission.id, state: 'RUNNING', revision: 8 });
    expect(lifecycle.workerBinding?.workerId).toBe('worker-resumed-1');
    expect(f.worker.resumes).toBe(1);
    const duplicateResume = await f.service.resume({ missionId: f.mission.id, expectedRevision: 6, requestId: resumeRequest });
    expect(duplicateResume.revision).toBe(8);
    expect(f.worker.resumes).toBe(1);

    const restartedState = new RuntimeState(new FoundationStateStore(f.dataRoot));
    const restartedWorker = new CountingWorker();
    const restartedStore = new DurableMissionLifecycleStore(f.dataRoot);
    const recovered = await recoverDurableMissions(restartedState, restartedStore, new WorkerAdapterRegistry([restartedWorker]));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ missionId: f.mission.id, projectId: f.projectA.id, state: 'WAITING_FOR_SUPERVISOR', revision: 9 });
    expect(restartedWorker.statuses).toBe(1);

    await restartedState.rehydrateBrokerMissionSession(f.mission.id);
    const restartedService = new DurableMissionLifecycleService(restartedState, restartedStore, new WorkerAdapterRegistry([restartedWorker]));
    lifecycle = await restartedService.acceptDirective({
      missionId: f.mission.id, basedOnRevision: 9, directiveId: randomUUID(), directive: 'Resume after daemon restart.',
    });
    lifecycle = await restartedService.resume({ missionId: f.mission.id, expectedRevision: lifecycle.revision, requestId: randomUUID() });
    expect(lifecycle.missionId).toBe(f.mission.id);
    expect(lifecycle.state).toBe('RUNNING');
    expect(restartedWorker.resumes).toBe(1);
  });

  it('denies cross-project session control and requires an explicit registered project', async () => {
    const f = await fixture();
    await f.service.ensureMission(f.mission.id);
    await expect(f.service.assertSessionControl(f.mission.id, f.session.clientId, f.session.id)).resolves.toMatchObject({ projectId: f.projectA.id });
    await f.state.setSessionCurrentProject(f.session.id, f.session.clientId, f.projectB.id);
    await expect(f.service.assertSessionControl(f.mission.id, f.session.clientId, f.session.id)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const unboundSession = f.state.createSession('chatgpt-unbound', 'owner', 'owner');
    const unboundMission = await f.state.createMission(unboundSession.clientId, unboundSession.id, 'No project mission', 'CHATGPT');
    await expect(f.service.ensureMission(unboundMission.id)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });
});
