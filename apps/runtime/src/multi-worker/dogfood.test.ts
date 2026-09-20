import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  RuntimeHealth,
  Worker,
  WorkerAssignment,
  WorkerExecutionAssociation,
  WorkerRuntimeFence,
  WorkerTask,
  WorkspaceId,
} from '@iris/domain';
import { PermissionAuditStore } from '../audit.js';
import { CapabilityService } from '../capability-service.js';
import { PermissionSettingsStore } from '../permission-store.js';
import { PermissionPolicyEngine } from '../permissions.js';
import { FoundationStateStore } from '../persistence.js';
import { VNextResourceRegistry } from '../resource-registry.js';
import { RuntimeState } from '../state.js';
import { applyWorkerPreset, type WorkerPresetAuthorityBounds, type WorkerPresetRole } from './presets.js';
import { runBoundedWorkerBatch } from './scheduler.js';
import { MultiWorkerRoutingService } from './service.js';
import { MultiWorkerStore } from './store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('IRIS multi-worker M13 read-only dogfood', () => {
  it('runs three governed review tasks with two concurrent workers, structured results, and consolidated Orchestrator review', async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-mw-m13-source-'));
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-mw-m13-data-'));
    roots.push(sourceRoot, dataRoot);
    const projectRoot = path.join(sourceRoot, 'iris');
    await mkdir(path.join(projectRoot, 'apps/runtime/multi-worker'), { recursive: true });
    await mkdir(path.join(projectRoot, 'packages/domain/src'), { recursive: true });
    await writeFile(path.join(projectRoot, 'apps/runtime/capability-service.ts'), 'CapabilityService boundary\n', 'utf8');
    await writeFile(path.join(projectRoot, 'apps/runtime/multi-worker/service.ts'), 'MultiWorkerRoutingService boundary\n', 'utf8');
    await writeFile(path.join(projectRoot, 'packages/domain/src/index.ts'), 'Worker domain contracts\n', 'utf8');

    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    const project = await state.registerProject('iris', projectRoot);
    const session = state.createSession('chatgpt-m13', 'chatgpt-orchestrator', 'owner');
    await state.setSessionCurrentProject(session.id, session.clientId, project.id);
    let mission = await state.createMission(session.clientId, session.id, 'M13 read-only native multi-worker dogfood', 'CHATGPT');
    mission = await state.createMissionTask(mission.id, session.clientId, session.id, 'Review IRIS capability boundary');

    const resources = new VNextResourceRegistry(state, dataRoot);
    const workspace = await resources.primaryWorkspace(project.id);
    const store = new MultiWorkerStore(dataRoot);
    const clock = () => '2026-09-20T03:30:00.000Z';
    const multiWorker = new MultiWorkerRoutingService(state, resources, store, undefined, clock);

    const machineId = randomUUID();
    const runtimeId = randomUUID();
    const instanceId = randomUUID();
    const catalogHash = `sha256:${'6'.repeat(64)}`;
    const runtimeFence: WorkerRuntimeFence = {
      machineId,
      runtimeId,
      instanceId,
      deploymentEpoch: 12,
      connectorProfile: 'FULL',
      catalogHash,
    };
    const health = (): RuntimeHealth => ({
      status: 'ready',
      version: '0.0.0',
      platform: 'darwin',
      runtimeId,
      instanceId,
      pid: process.pid,
      uptimeMs: 1000,
      authority: 'owned',
      connectedClients: 1,
      connectedSessions: 1,
      agentExecutorType: 'local-development-executor',
      productionModelConnected: false,
      apiUrl: 'http://127.0.0.1:43110',
      mcpUrl: 'http://127.0.0.1:43110/mcp',
      machineId,
      identityState: 'COHERENT',
      identityCode: 'COHERENT',
      tunnelBindings: [{
        connectorProfile: 'FULL',
        tunnelId: 'tunnel-m13',
        deploymentEpoch: 12,
        catalogHash,
        leaseGeneration: 1,
        machineId,
        runtimeId,
      }],
    });

    const settings = new PermissionSettingsStore(dataRoot);
    await settings.initialize();
    await settings.setMode('FULL_LOCAL_OWNER');
    const audit = new PermissionAuditStore(dataRoot);
    const capabilities = new CapabilityService(
      state,
      new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot),
      audit,
      health,
      undefined,
      resources,
      undefined,
      multiWorker,
    );

    const run = (await multiWorker.createRun({
      expectedGeneration: 0,
      missionId: mission.id,
      parentOrchestratorId: session.agentId,
    })).run;

    const definitions: readonly {
      readonly role: WorkerPresetRole;
      readonly principalId: string;
      readonly title: string;
      readonly file: string;
      readonly allowedPath: string;
    }[] = [
      {
        role: 'CODE',
        principalId: 'dogfood-code',
        title: 'Inspect CapabilityService boundary',
        file: 'apps/runtime/capability-service.ts',
        allowedPath: 'apps/runtime/capability-service.ts',
      },
      {
        role: 'QA',
        principalId: 'dogfood-qa',
        title: 'Inspect multi-worker routing boundary',
        file: 'apps/runtime/multi-worker/service.ts',
        allowedPath: 'apps/runtime/multi-worker/**',
      },
      {
        role: 'RESEARCH',
        principalId: 'dogfood-research',
        title: 'Inspect domain contracts',
        file: 'packages/domain/src/index.ts',
        allowedPath: 'packages/domain/**',
      },
    ];

    const workerRecords: Worker[] = [];
    const taskRecords: WorkerTask[] = [];
    const assignmentRecords: WorkerAssignment[] = [];
    for (const definition of definitions) {
      const worker = await multiWorker.createWorker({
        expectedGeneration: (await store.read()).generation,
        orchestrationRunId: run.id,
        principalId: definition.principalId,
        workerType: 'IRIS_LOGICAL',
        role: definition.role,
      });
      workerRecords.push(worker);

      const parentBounds: WorkerPresetAuthorityBounds = {
        allowedCapabilities: ['fs.read', 'fs.write', 'system.sudo'],
        allowedPaths: [definition.allowedPath],
        readOnlyPaths: [definition.allowedPath],
        mutablePaths: [definition.allowedPath],
        allowedProcesses: ['node-script'],
        approvalPolicy: 'INHERIT_MISSION',
        resourceBudget: {
          maxRuntimeMs: 60_000,
          maxJobs: 1,
          maxArtifacts: 4,
          maxOutputBytes: 1_048_576,
        },
        concurrencyPolicy: {
          maxParallelCapabilities: 4,
          mutablePathOwnership: 'EXCLUSIVE',
          allowParallelReads: true,
        },
      };
      const authority = applyWorkerPreset(definition.role, parentBounds);
      expect(authority.allowedCapabilities).toEqual(['fs.read']);
      expect(authority.mutablePaths).toEqual([]);
      expect(authority.allowedProcesses).toEqual([]);

      const task = await multiWorker.createTask({
        expectedGeneration: (await store.read()).generation,
        orchestrationRunId: run.id,
        missionTaskId: mission.tasks[0]!.id,
        title: definition.title,
        dependencyTaskIds: [],
        workspaceId: workspace.workspaceId as WorkspaceId,
        principalId: definition.principalId,
        ...authority,
        expiresAt: '2026-09-20T04:30:00.000Z',
      });
      taskRecords.push(task);

      const assignment = await multiWorker.assignTask({
        expectedGeneration: (await store.read()).generation,
        orchestrationRunId: run.id,
        taskId: task.id,
        workerId: worker.id,
        runtimeFence,
      });
      assignmentRecords.push(assignment);
    }

    const associations = new Map<string, WorkerExecutionAssociation>();
    for (let index = 0; index < taskRecords.length; index += 1) {
      const task = taskRecords[index]!;
      const worker = workerRecords[index]!;
      const assignment = assignmentRecords[index]!;
      associations.set(task.id, {
        missionId: mission.id,
        orchestrationRunId: run.id,
        workerTaskId: task.id,
        assignmentId: assignment.id,
        workerId: worker.id,
        authorityDigest: assignment.authorityDigest,
      });
    }

    const executeTasks = async (taskIds: readonly string[]) => {
      for (const taskId of taskIds) {
        await multiWorker.startTask({
          expectedGeneration: (await store.read()).generation,
          orchestrationRunId: run.id,
          taskId,
          requestId: randomUUID(),
        });
      }

      let active = 0;
      let observed = 0;
      const batch = await runBoundedWorkerBatch({
        taskIds,
        maxConcurrency: 2,
        timeoutMs: 5_000,
        execute: async (taskId) => {
          active += 1;
          observed = Math.max(observed, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          const index = taskRecords.findIndex((entry) => entry.id === taskId);
          const definition = definitions[index]!;
          const outcome = await capabilities.execute({
            capabilityId: 'fs.read',
            clientId: session.clientId,
            sessionId: session.id,
            projectId: project.id,
            workspaceId: workspace.workspaceId,
            path: definition.file,
            mode: 'TEXT',
            encoding: 'utf-8',
            worker: associations.get(taskId)!,
          });
          active -= 1;
          if (outcome.status !== 'executed') throw new Error('DOGFOOD_CAPABILITY_NOT_EXECUTED');
          return { file: definition.file, outcome };
        },
      });
      expect(batch.results.every((entry) => entry.status === 'SUCCEEDED')).toBe(true);
      return { batch, observed };
    };

    const initialTasks = await multiWorker.listTasks(run.id);
    const firstTwo = initialTasks.slice(0, 2).map((entry) => entry.id);
    const first = await executeTasks(firstTwo);
    expect(first.batch.maxObservedConcurrency).toBe(2);
    expect(first.observed).toBe(2);

    for (const taskId of firstTwo) {
      await multiWorker.completeTask({
        expectedGeneration: (await store.read()).generation,
        orchestrationRunId: run.id,
        taskId,
      });
    }

    const thirdTaskId = taskRecords[2]!.id;
    const third = await executeTasks([thirdTaskId]);
    expect(third.batch.maxObservedConcurrency).toBe(1);
    await multiWorker.completeTask({
      expectedGeneration: (await store.read()).generation,
      orchestrationRunId: run.id,
      taskId: thirdTaskId,
    });

    const results = [];
    for (let index = 0; index < taskRecords.length; index += 1) {
      const task = taskRecords[index]!;
      const worker = workerRecords[index]!;
      const definition = definitions[index]!;
      const result = await multiWorker.recordResult({
        expectedGeneration: (await store.read()).generation,
        orchestrationRunId: run.id,
        taskId: task.id,
        workerId: worker.id,
        status: 'SUCCEEDED',
        summary: `Read-only dogfood inspected ${definition.file}`,
        evidenceRefs: [`dogfood:${task.id}`],
        artifactIds: [],
        filesRead: [definition.file],
        filesChanged: [],
        commandsExecuted: [],
        validationResults: [{
          name: 'governed-read',
          status: 'PASSED',
          summary: 'CapabilityService read completed inside immutable worker authority',
        }],
        risks: [],
        blockers: [],
        recommendedNextActions: [],
      });
      results.push(result);
    }

    for (const result of results) {
      const current = await multiWorker.getRun(run.id);
      await multiWorker.reviewResult({
        expectedGeneration: current.generation,
        orchestrationRunId: run.id,
        resultId: result.id,
        parentOrchestratorId: session.agentId,
        basedOnRunRevision: current.run.revision,
        decision: 'ACCEPT',
        instruction: 'Accepted read-only dogfood evidence',
        requestedEvidence: [],
      });
    }

    const final = await multiWorker.getRun(run.id);
    expect(final.run.state).toBe('SUCCEEDED');
    expect(final.tasks).toHaveLength(3);
    expect(final.results).toHaveLength(3);
    expect(final.reviews).toHaveLength(3);

    const tree = await multiWorker.observabilityForMission(mission.id);
    expect(tree?.run).toMatchObject({
      state: 'SUCCEEDED',
      taskCount: 3,
      workerCount: 3,
      activeAssignmentCount: 0,
      resultCount: 3,
      reviewCount: 3,
    });
    expect(tree?.tasks.every((entry) => entry.result?.status === 'SUCCEEDED' && entry.review?.decision === 'ACCEPT')).toBe(true);

    const auditEvents = await audit.recent(50);
    const workerReads = auditEvents.filter((entry) =>
      entry.result === 'SUCCESS'
      && entry.capabilityId === 'fs.read'
      && entry.orchestrationRunId === run.id);
    expect(workerReads).toHaveLength(3);
    expect(new Set(workerReads.map((entry) => entry.workerId))).toEqual(new Set(workerRecords.map((entry) => entry.id)));

    expect((await state.getMission(mission.id)).state).not.toBe('COMPLETED');
  });
});
