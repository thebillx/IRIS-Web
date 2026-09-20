import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeHealth, WorkerExecutionAssociation, WorkerRuntimeFence } from '@iris/domain';
import { PermissionAuditStore } from '../audit.js';
import { CapabilityService } from '../capability-service.js';
import { PermissionSettingsStore } from '../permission-store.js';
import { PermissionPolicyEngine } from '../permissions.js';
import { FoundationStateStore } from '../persistence.js';
import { VNextResourceRegistry } from '../resource-registry.js';
import { RuntimeState } from '../state.js';
import { MultiWorkerRoutingService } from './service.js';
import { MultiWorkerStore } from './store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-mw-m11-source-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-mw-m11-data-'));
  roots.push(sourceRoot, dataRoot);
  const projectRoot = path.join(sourceRoot, 'iris');
  await mkdir(path.join(projectRoot, 'apps/runtime'), { recursive: true });
  await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  await writeFile(path.join(projectRoot, 'apps/runtime/visible.txt'), 'worker-visible', 'utf8');
  await writeFile(path.join(projectRoot, 'docs/outside.txt'), 'must-stay-private', 'utf8');

  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('iris', projectRoot);
  const session = state.createSession('chatgpt-m11', 'chatgpt-orchestrator', 'owner');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  let mission = await state.createMission(session.clientId, session.id, 'M11 worker capability security', 'CHATGPT');
  mission = await state.createMissionTask(mission.id, session.clientId, session.id, 'Parent read-only worker task');

  const resources = new VNextResourceRegistry(state, dataRoot);
  const workspace = await resources.primaryWorkspace(project.id);
  const store = new MultiWorkerStore(dataRoot);
  const multiWorker = new MultiWorkerRoutingService(
    state,
    resources,
    store,
    undefined,
    () => '2026-09-20T03:00:00.000Z',
  );

  const machineId = randomUUID();
  const runtimeId = randomUUID();
  const instanceId = randomUUID();
  const catalogHash = `sha256:${'5'.repeat(64)}`;
  const runtimeFence: WorkerRuntimeFence = {
    machineId,
    runtimeId,
    instanceId,
    deploymentEpoch: 11,
    connectorProfile: 'FULL',
    catalogHash,
  };

  const run = (await multiWorker.createRun({
    expectedGeneration: 0,
    missionId: mission.id,
    parentOrchestratorId: session.agentId,
  })).run;
  const worker = await multiWorker.createWorker({
    expectedGeneration: 1,
    orchestrationRunId: run.id,
    principalId: 'worker-security-read',
    workerType: 'IRIS_LOGICAL',
    role: 'RESEARCH',
  });
  const task = await multiWorker.createTask({
    expectedGeneration: 2,
    orchestrationRunId: run.id,
    missionTaskId: mission.tasks[0]!.id,
    title: 'Read only apps/runtime',
    dependencyTaskIds: [],
    workspaceId: workspace.workspaceId,
    principalId: 'worker-security-read',
    allowedCapabilities: ['fs.read', 'fs.find', 'project.search'],
    allowedPaths: ['apps/runtime/**'],
    readOnlyPaths: ['apps/runtime/**'],
    mutablePaths: [],
    allowedProcesses: [],
    approvalPolicy: 'INHERIT_MISSION',
    resourceBudget: { maxRuntimeMs: 60_000, maxJobs: 0, maxArtifacts: 0, maxOutputBytes: 1_048_576 },
    concurrencyPolicy: { maxParallelCapabilities: 2, mutablePathOwnership: 'READ_ONLY', allowParallelReads: true },
    expiresAt: '2026-09-20T04:00:00.000Z',
  });
  const assignment = await multiWorker.assignTask({
    expectedGeneration: 3,
    orchestrationRunId: run.id,
    taskId: task.id,
    workerId: worker.id,
    runtimeFence,
  });
  await multiWorker.startTask({
    expectedGeneration: 4,
    orchestrationRunId: run.id,
    taskId: task.id,
    requestId: randomUUID(),
  });

  const association: WorkerExecutionAssociation = {
    missionId: mission.id,
    orchestrationRunId: run.id,
    workerTaskId: task.id,
    assignmentId: assignment.id,
    workerId: worker.id,
    authorityDigest: assignment.authorityDigest,
  };

  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  await settings.setMode('FULL_LOCAL_OWNER');
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot);
  const audit = new PermissionAuditStore(dataRoot);

  const health = (profile: 'FULL' | 'PRO' = 'FULL', deploymentEpoch = 11): RuntimeHealth => ({
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
      connectorProfile: profile,
      tunnelId: 'tunnel-m11',
      deploymentEpoch,
      catalogHash,
      leaseGeneration: 1,
      machineId,
      runtimeId,
    }],
  });

  const createCapabilities = (healthValue: RuntimeHealth = health()) => new CapabilityService(
    state,
    policy,
    audit,
    () => healthValue,
    undefined,
    resources,
    undefined,
    multiWorker,
  );

  return {
    sourceRoot, dataRoot, projectRoot, state, project, session, mission, resources, workspace,
    multiWorker, run, worker, task, assignment, association, audit, health, createCapabilities,
  };
}

describe('IRIS multi-worker M11 CapabilityService audit and security acceptance', () => {
  it('executes an in-envelope worker read through CapabilityService and writes immutable worker attribution to audit', async () => {
    const f = await fixture();
    const capabilities = f.createCapabilities();

    const result = await capabilities.execute({
      capabilityId: 'fs.read',
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      workspaceId: f.workspace.workspaceId,
      path: 'apps/runtime/visible.txt',
      mode: 'TEXT',
      encoding: 'utf-8',
      worker: f.association,
    });

    expect(result).toMatchObject({ status: 'executed', value: { text: 'worker-visible' } });
    const audit = await f.audit.recent(20);
    const success = audit.find((entry) => entry.result === 'SUCCESS' && entry.capabilityId === 'fs.read');
    expect(success).toMatchObject({
      missionId: f.mission.id,
      orchestrationRunId: f.run.id,
      workerTaskId: f.task.id,
      workerId: f.worker.id,
      assignmentId: f.assignment.id,
      authorityDigest: f.assignment.authorityDigest,
    });
  });

  it('denies cross-path, forged digest, foreign workspace, and broad project search before execution', async () => {
    const f = await fixture();
    const capabilities = f.createCapabilities();

    await expect(capabilities.execute({
      capabilityId: 'fs.read',
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      workspaceId: f.workspace.workspaceId,
      path: 'docs/outside.txt',
      mode: 'TEXT',
      encoding: 'utf-8',
      worker: f.association,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await expect(capabilities.execute({
      capabilityId: 'fs.read',
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      workspaceId: f.workspace.workspaceId,
      path: 'apps/runtime/visible.txt',
      mode: 'TEXT',
      encoding: 'utf-8',
      worker: { ...f.association, authorityDigest: 'f'.repeat(64) },
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await expect(capabilities.execute({
      capabilityId: 'fs.read',
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      workspaceId: randomUUID(),
      path: 'apps/runtime/visible.txt',
      mode: 'TEXT',
      encoding: 'utf-8',
      worker: f.association,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await expect(capabilities.execute({
      capabilityId: 'project.search',
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      query: 'worker-visible',
      worker: f.association,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await expect(readFile(path.join(f.projectRoot, 'docs/outside.txt'), 'utf8')).resolves.toBe('must-stay-private');
  });

  it('requires coherent FULL runtime/catalog fencing and rejects stale deployment identity or PRO-only identity', async () => {
    const f = await fixture();

    await expect(f.createCapabilities(f.health('FULL', 12)).execute({
      capabilityId: 'fs.read',
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      workspaceId: f.workspace.workspaceId,
      path: 'apps/runtime/visible.txt',
      mode: 'TEXT',
      encoding: 'utf-8',
      worker: f.association,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await expect(f.createCapabilities(f.health('PRO', 11)).execute({
      capabilityId: 'fs.read',
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      workspaceId: f.workspace.workspaceId,
      path: 'apps/runtime/visible.txt',
      mode: 'TEXT',
      encoding: 'utf-8',
      worker: f.association,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('keeps worker mutation and worker-spawn/control capabilities fail-closed in V1', async () => {
    const f = await fixture();
    const capabilities = f.createCapabilities();

    await expect(capabilities.execute({
      capabilityId: 'fs.write',
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      workspaceId: f.workspace.workspaceId,
      path: 'apps/runtime/visible.txt',
      mode: 'REPLACE',
      content: 'must-not-change',
      worker: f.association,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await expect(capabilities.execute({
      capabilityId: 'mission.task.create',
      clientId: f.session.clientId,
      sessionId: f.session.id,
      missionId: f.mission.id,
      title: 'recursive worker attempt',
      worker: f.association,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await expect(readFile(path.join(f.projectRoot, 'apps/runtime/visible.txt'), 'utf8')).resolves.toBe('worker-visible');
    expect((await f.multiWorker.getRun(f.run.id)).tasks).toHaveLength(1);
  });
});
