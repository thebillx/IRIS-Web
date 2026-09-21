import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FoundationStateStore } from './persistence.js';
import { MissionLedgerStore } from './mission-store.js';
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

  public planStart(): WorkerStartReceipt {
    const next = this.starts + 1;
    return { workerId: `worker-start-${next}`, resumeToken: `start-token-${next}`, resumable: true };
  }

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

  it('reclaims one archived completed lifecycle record at capacity without restoring execution authority', async () => {
    const f = await fixture();
    const lifecycle = await f.service.ensureMission(f.mission.id, 'Archived lifecycle capacity proof.');
    const completed = await f.state.setMissionState(f.mission.id, f.session.clientId, f.session.id, 'COMPLETED');
    const missionStore = new MissionLedgerStore(f.dataRoot);
    await missionStore.archiveForCapacity(completed);
    await missionStore.write({ schemaVersion: 1, missions: [] });

    await expect(f.state.getMission(f.mission.id)).resolves.toMatchObject({ id: f.mission.id, state: 'COMPLETED' });
    await expect(f.service.assertSessionControl(f.mission.id, f.session.clientId, f.session.id))
      .rejects.toMatchObject({ code: 'CONTROL_DENIED' });

    const filler = Array.from({ length: 99 }, (_, index) => ({
      ...lifecycle,
      missionId: randomUUID(),
      title: `Synthetic lifecycle filler ${index}`,
      goal: `Synthetic lifecycle filler ${index}`,
    }));
    await f.store.write({ schemaVersion: 1, records: [lifecycle, ...filler] });

    const replacementMission = await f.state.createMission(
      f.session.clientId,
      f.session.id,
      'Replacement mission after authoritative archive',
      'CHATGPT',
    );
    const replacementLifecycle = await f.service.ensureMission(replacementMission.id, 'Replacement lifecycle after capacity reclaim.');
    expect(replacementLifecycle).toMatchObject({
      missionId: replacementMission.id,
      projectId: f.projectA.id,
      state: 'CREATED',
      revision: 1,
    });

    const active = await f.store.read();
    expect(active.records).toHaveLength(100);
    expect(active.records.some((record) => record.missionId === f.mission.id)).toBe(false);
    expect(active.records.some((record) => record.missionId === replacementMission.id)).toBe(true);
    await expect(f.store.readArchived(f.mission.id)).resolves.toEqual(lifecycle);
    await expect(f.store.archiveForCapacity(lifecycle)).resolves.toBeUndefined();
    await expect(f.store.archiveForCapacity({ ...lifecycle, goal: 'Different archived content must fail closed.' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(f.service.get(f.mission.id)).rejects.toMatchObject({ code: 'MISSION_NOT_FOUND' });
    await expect(f.service.ensureMission(f.mission.id))
      .rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  });

  it('reclaims a completed non-resumable worker binding without treating it as live execution authority', async () => {
    const f = await fixture();
    const created = await f.service.ensureMission(f.mission.id, 'Completed worker binding reclaim proof.');
    const running = await f.service.start({
      missionId: f.mission.id,
      expectedRevision: created.revision,
      requestId: randomUUID(),
      workerType: 'COUNTING',
    });
    const lifecycleCompleted = await f.service.complete({
      missionId: f.mission.id,
      expectedRevision: running.revision,
      requestId: randomUUID(),
    });
    expect(lifecycleCompleted).toMatchObject({
      state: 'COMPLETED',
      workerBinding: { resumable: false },
    });

    const authoritativeCompleted = await f.state.setMissionState(
      f.mission.id,
      f.session.clientId,
      f.session.id,
      'COMPLETED',
    );
    const missionStore = new MissionLedgerStore(f.dataRoot);
    await missionStore.archiveForCapacity(authoritativeCompleted);
    await missionStore.write({ schemaVersion: 1, missions: [] });

    const filler = Array.from({ length: 99 }, (_, index) => ({
      ...created,
      missionId: randomUUID(),
      title: `Synthetic completed-binding filler ${index}`,
      goal: `Synthetic completed-binding filler ${index}`,
    }));
    await f.store.write({ schemaVersion: 1, records: [lifecycleCompleted, ...filler] });

    const replacementMission = await f.state.createMission(
      f.session.clientId,
      f.session.id,
      'Replacement after completed worker lifecycle',
      'CHATGPT',
    );
    await expect(f.service.ensureMission(replacementMission.id))
      .resolves.toMatchObject({ missionId: replacementMission.id, state: 'CREATED' });
    await expect(f.store.readArchived(f.mission.id)).resolves.toEqual(lifecycleCompleted);
  });

  it('validates the replacement mission before reclaiming any archived lifecycle capacity', async () => {
    const f = await fixture();
    const lifecycle = await f.service.ensureMission(f.mission.id, 'Capacity must not mutate for an invalid target.');
    const authoritativeCompleted = await f.state.setMissionState(
      f.mission.id,
      f.session.clientId,
      f.session.id,
      'COMPLETED',
    );
    const missionStore = new MissionLedgerStore(f.dataRoot);
    await missionStore.archiveForCapacity(authoritativeCompleted);
    await missionStore.write({ schemaVersion: 1, missions: [] });

    const filler = Array.from({ length: 99 }, (_, index) => ({
      ...lifecycle,
      missionId: randomUUID(),
      title: `Synthetic validation-order filler ${index}`,
      goal: `Synthetic validation-order filler ${index}`,
    }));
    await f.store.write({ schemaVersion: 1, records: [lifecycle, ...filler] });

    const unboundSession = f.state.createSession('chatgpt-unbound-capacity', 'owner', 'owner');
    const unboundMission = await f.state.createMission(
      unboundSession.clientId,
      unboundSession.id,
      'Invalid capacity replacement without project',
      'CHATGPT',
    );
    await expect(f.service.ensureMission(unboundMission.id))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(f.store.readArchived(f.mission.id)).resolves.toBeNull();
    expect((await f.store.read()).records.some((record) => record.missionId === f.mission.id)).toBe(true);
  });

  it('does not reclaim an archived lifecycle record that still carries worker authority', async () => {
    const f = await fixture();
    const created = await f.service.ensureMission(f.mission.id, 'Worker authority must remain fail-closed.');
    const running = await f.service.start({
      missionId: f.mission.id,
      expectedRevision: created.revision,
      requestId: randomUUID(),
      workerType: 'COUNTING',
    });
    expect(running.workerBinding).not.toBeNull();

    const completed = await f.state.setMissionState(f.mission.id, f.session.clientId, f.session.id, 'COMPLETED');
    const missionStore = new MissionLedgerStore(f.dataRoot);
    await missionStore.archiveForCapacity(completed);
    await missionStore.write({ schemaVersion: 1, missions: [] });
    await expect(f.service.assertSessionControl(f.mission.id, f.session.clientId, f.session.id))
      .rejects.toMatchObject({ code: 'CONTROL_DENIED' });

    const filler = Array.from({ length: 99 }, (_, index) => ({
      ...created,
      missionId: randomUUID(),
      title: `Synthetic active filler ${index}`,
      goal: `Synthetic active filler ${index}`,
    }));
    await f.store.write({ schemaVersion: 1, records: [running, ...filler] });

    const replacementMission = await f.state.createMission(
      f.session.clientId,
      f.session.id,
      'Replacement must fail while worker authority is retained',
      'CHATGPT',
    );
    await expect(f.service.ensureMission(replacementMission.id))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(f.store.readArchived(f.mission.id)).resolves.toBeNull();
    expect((await f.store.read()).records.some((record) => record.missionId === f.mission.id)).toBe(true);
  });
});
