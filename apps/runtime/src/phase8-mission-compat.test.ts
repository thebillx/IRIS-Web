import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  WorkerAdapter,
  WorkerCheckpointReceipt,
  WorkerStartReceipt,
  WorkerStatusReceipt,
} from './durable-mission-lifecycle.js';
import { DurableMissionLifecycleService } from './durable-mission-service.js';
import { DurableMissionLifecycleStore } from './durable-mission-store.js';
import { WorkerAdapterRegistry } from './durable-mission-workers.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class CompatibilityWorker implements WorkerAdapter {
  public readonly workerType = 'PHASE8_COMPAT';
  public starts = 0;
  public checkpoints = 0;
  public resumes = 0;
  public statuses = 0;

  public planStart(): WorkerStartReceipt {
    const next = this.starts + 1;
    return {
      workerId: `phase8-start-${next}`,
      resumeToken: `phase8-start-token-${next}`,
      resumable: true,
    };
  }

  public async start(): Promise<WorkerStartReceipt> {
    this.starts += 1;
    return {
      workerId: `phase8-start-${this.starts}`,
      resumeToken: `phase8-start-token-${this.starts}`,
      resumable: true,
    };
  }

  public async checkpoint(input: Parameters<WorkerAdapter['checkpoint']>[0]): Promise<WorkerCheckpointReceipt> {
    this.checkpoints += 1;
    return {
      workerStateRef: `phase8-checkpoint:${input.binding.workerId}:${this.checkpoints}`,
      resumeMetadata: { checkpoint: this.checkpoints },
    };
  }

  public async resume(): Promise<WorkerStartReceipt> {
    this.resumes += 1;
    return {
      workerId: `phase8-resume-${this.resumes}`,
      resumeToken: `phase8-resume-token-${this.resumes}`,
      resumable: true,
    };
  }

  public async cancel(): Promise<void> {}

  public async status(input: Parameters<WorkerAdapter['status']>[0]): Promise<WorkerStatusReceipt> {
    this.statuses += 1;
    return {
      state: 'RESUMABLE',
      workerId: input.binding.workerId,
      resumeToken: input.binding.resumeToken,
      resumable: true,
    };
  }
}

describe('Phase 8 durable legacy-mission compatibility', () => {
  it('AC-IRIS-007 preserves legacy mission/task/action identity across owner rebind + resume without replaying a completed action', async () => {
    const dataRoot = await temp('iris-phase8-mission-data-');
    const projectRoot = path.join(await temp('iris-phase8-mission-projects-'), 'iris');
    await mkdir(projectRoot);

    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    const project = await state.registerProject('iris', projectRoot);
    const original = state.createSession('chatgpt-phase8-old', 'chatgpt-direct-orchestrator', 'owner');
    await state.setSessionCurrentProject(original.id, original.clientId, project.id);

    let mission = await state.createMission(original.clientId, original.id, 'Pre-vNext compatibility fixture', 'CHATGPT');
    mission = await state.createMissionTask(mission.id, original.clientId, original.id, 'Legacy wrapper task');
    const taskId = mission.tasks[0]!.id;
    mission = await state.prepareMissionAction(
      mission.id,
      taskId,
      original.clientId,
      original.id,
      'file.write',
      'Completed legacy action must remain durable through Phase 8.',
    );
    const actionId = mission.tasks[0]!.actions[0]!.id;
    const association = {
      missionId: mission.id,
      taskId,
      actionId,
      orchestratorMode: 'CHATGPT' as const,
    };
    await state.markMissionActionStarted(association);
    await state.markMissionActionSucceeded(
      association,
      'file.write',
      { targetPath: path.join(projectRoot, 'fixture.txt'), bytes: 5 },
      ['WRITE', 'DESTRUCTIVE'],
    );

    const actionBefore = (await state.getMission(mission.id)).tasks[0]!.actions[0]!;
    expect(actionBefore).toMatchObject({
      id: actionId,
      capabilityId: 'file.write',
      state: 'SUCCEEDED',
      result: {
        status: 'SUCCEEDED',
        evidence: expect.arrayContaining([
          expect.objectContaining({
            kind: 'CAPABILITY_RESULT',
            label: 'file.write',
            data: expect.objectContaining({ effectiveEffects: 'WRITE,DESTRUCTIVE' }),
          }),
        ]),
      },
    });

    const worker = new CompatibilityWorker();
    const lifecycle = new DurableMissionLifecycleService(
      state,
      new DurableMissionLifecycleStore(dataRoot),
      new WorkerAdapterRegistry([worker]),
    );

    let durable = await lifecycle.ensureMission(mission.id, 'Resume the same pre-vNext durable mission after compatibility convergence.');
    durable = await lifecycle.start({
      missionId: mission.id,
      expectedRevision: durable.revision,
      requestId: randomUUID(),
      workerType: worker.workerType,
    });
    durable = await lifecycle.checkpoint({
      missionId: mission.id,
      expectedRevision: durable.revision,
      checkpointId: randomUUID(),
      summary: 'Pre-vNext mission reached a durable Phase 8 compatibility boundary.',
      evidenceRefs: ['phase8:legacy-action-complete'],
    });
    durable = await lifecycle.acceptDirective({
      missionId: mission.id,
      basedOnRevision: durable.revision,
      directiveId: randomUUID(),
      directive: 'Continue the same durable mission after owner session replacement.',
    });

    const replacement = state.createSession('chatgpt-phase8-new', 'chatgpt-direct-orchestrator', 'owner');
    await state.setSessionCurrentProject(replacement.id, replacement.clientId, project.id);
    const rebound = await state.rebindMissionSession({
      missionId: mission.id,
      clientId: replacement.clientId,
      sessionId: replacement.id,
      projectId: project.id,
      expectedBindingRevision: 1,
      reason: 'Phase 8 old-mission compatibility acceptance',
    });
    expect(rebound).toMatchObject({
      id: mission.id,
      projectId: project.id,
      sessionId: replacement.id,
      bindingRevision: 2,
    });

    await expect(lifecycle.assertSessionControl(mission.id, original.clientId, original.id))
      .rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    await expect(lifecycle.assertSessionControl(mission.id, replacement.clientId, replacement.id))
      .resolves.toMatchObject({ missionId: mission.id, projectId: project.id });

    const resumeRequestId = randomUUID();
    const resumed = await lifecycle.resume({
      missionId: mission.id,
      expectedRevision: durable.revision,
      requestId: resumeRequestId,
    });
    expect(resumed).toMatchObject({ missionId: mission.id, projectId: project.id, state: 'RUNNING' });
    expect(worker.resumes).toBe(1);

    const duplicate = await lifecycle.resume({
      missionId: mission.id,
      expectedRevision: durable.revision,
      requestId: resumeRequestId,
    });
    expect(duplicate.revision).toBe(resumed.revision);
    expect(worker.resumes).toBe(1);

    const after = await state.getMission(mission.id);
    expect(after.id).toBe(mission.id);
    expect(after.tasks[0]!.id).toBe(taskId);
    expect(after.tasks[0]!.actions[0]!.id).toBe(actionId);
    expect(after.tasks[0]!.actions[0]).toEqual(actionBefore);
    expect(after.tasks[0]!.actions[0]!.state).toBe('SUCCEEDED');
    expect(after.rebindAudit).toHaveLength(1);
    expect(after.rebindAudit[0]).toMatchObject({
      oldSessionId: original.id,
      newSessionId: replacement.id,
      result: 'SUCCESS',
    });
  });
});

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
