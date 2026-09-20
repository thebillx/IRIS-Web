import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  OrchestrationRun,
  Worker,
  WorkerAssignment,
  WorkerRuntimeFence,
  WorkerTask,
  WorkerTaskAuthorityMetadata,
  WorkspaceId,
} from '@iris/domain';
import type { MultiWorkerDocument } from './model.js';
import {
  authorizeWorkerCapability,
  deriveWorkerAuthorityDigest,
  resolveWorkerExecutionEnvelope,
  type WorkerAuthorityClaims,
  type WorkerAuthorityServerContext,
} from './authority.js';

function fixture() {
  const missionId = randomUUID();
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const workspaceId = randomUUID() as WorkspaceId;
  const runId = randomUUID();
  const taskId = randomUUID();
  const workerId = randomUUID();
  const assignmentId = randomUUID();
  const parentOrchestratorId = 'chatgpt-orchestrator';
  const principalId = 'worker-principal-code-1';
  const runtimeFence: WorkerRuntimeFence = {
    machineId: randomUUID(),
    runtimeId: randomUUID(),
    instanceId: randomUUID(),
    deploymentEpoch: 9,
    connectorProfile: 'FULL',
    catalogHash: `sha256:${'1'.repeat(64)}`,
  };
  const authority: WorkerTaskAuthorityMetadata = {
    schemaVersion: 1,
    missionId,
    taskId,
    sessionId,
    projectId,
    workspaceId,
    principalId,
    parentOrchestratorId,
    allowedCapabilities: ['project.search', 'fs.read', 'fs.write', 'shell.run'],
    allowedPaths: ['apps/runtime/**'],
    readOnlyPaths: ['apps/runtime/**'],
    mutablePaths: ['apps/runtime/generated/**'],
    allowedProcesses: ['node-script'],
    approvalPolicy: 'INHERIT_MISSION',
    resourceBudget: {
      maxRuntimeMs: 60_000,
      maxJobs: 2,
      maxArtifacts: 4,
      maxOutputBytes: 1_048_576,
    },
    concurrencyPolicy: {
      maxParallelCapabilities: 2,
      mutablePathOwnership: 'EXCLUSIVE',
      allowParallelReads: true,
    },
    createdAt: '2026-09-20T01:00:00.000Z',
    expiresAt: '2026-09-20T02:00:00.000Z',
  };
  const task: WorkerTask = {
    id: taskId,
    orchestrationRunId: runId,
    missionId,
    missionTaskId: randomUUID(),
    title: 'Implement bounded authority',
    state: 'ASSIGNED',
    dependencyTaskIds: [],
    authority,
    assignmentId,
    resultId: null,
    createdAt: '2026-09-20T01:00:00.000Z',
    updatedAt: '2026-09-20T01:00:00.000Z',
  };
  const worker: Worker = {
    id: workerId,
    orchestrationRunId: runId,
    principalId,
    workerType: 'IRIS_LOGICAL',
    role: 'CODE',
    state: 'ASSIGNED',
    parentOrchestratorId,
    createdAt: '2026-09-20T01:00:00.000Z',
    updatedAt: '2026-09-20T01:00:00.000Z',
  };
  const assignmentBase: WorkerAssignment = {
    id: assignmentId,
    orchestrationRunId: runId,
    taskId,
    workerId,
    authorityTaskId: taskId,
    runtimeFence,
    authorityDigest: '0'.repeat(64),
    assignedAt: '2026-09-20T01:00:00.000Z',
    releasedAt: null,
  };
  const assignment: WorkerAssignment = {
    ...assignmentBase,
    authorityDigest: deriveWorkerAuthorityDigest(task, worker, assignmentBase),
  };
  const run: OrchestrationRun = {
    id: runId,
    missionId,
    projectId,
    sessionId,
    parentOrchestratorId,
    state: 'RUNNING',
    revision: 1,
    taskIds: [taskId],
    workerIds: [workerId],
    assignmentIds: [assignmentId],
    resultIds: [],
    createdAt: '2026-09-20T01:00:00.000Z',
    updatedAt: '2026-09-20T01:00:00.000Z',
  };
  const document: MultiWorkerDocument = {
    schemaVersion: 1,
    generation: 1,
    runs: [run],
    workers: [worker],
    tasks: [task],
    assignments: [assignment],
    results: [],
  };
  const claims: WorkerAuthorityClaims = {
    missionId,
    taskId,
    workerId,
    assignmentId,
    authorityDigest: assignment.authorityDigest,
  };
  const server: WorkerAuthorityServerContext = {
    sessionId,
    projectId,
    workspaceId,
    parentOrchestratorId,
    runtimeFence,
    now: '2026-09-20T01:15:00.000Z',
  };
  return { document, claims, server, task, worker, assignment, runtimeFence };
}

describe('IRIS multi-worker M03 authority envelope', () => {
  it('resolves authority only from durable task/worker/assignment state', () => {
    const f = fixture();
    const envelope = resolveWorkerExecutionEnvelope(f.document, f.claims, f.server);
    expect(envelope).toMatchObject({
      missionId: f.claims.missionId,
      taskId: f.claims.taskId,
      workerId: f.claims.workerId,
      assignmentId: f.claims.assignmentId,
      projectId: f.server.projectId,
      workspaceId: f.server.workspaceId,
      authorityDigest: f.claims.authorityDigest,
    });
    expect(envelope.allowedCapabilities).toEqual(['project.search', 'fs.read', 'fs.write', 'shell.run']);
  });

  it('ignores caller authority expansion and returns only server-owned grants', () => {
    const f = fixture();
    const forged = {
      ...f.claims,
      allowedCapabilities: ['system.sudo'],
      mutablePaths: ['**'],
    } as WorkerAuthorityClaims;
    const envelope = resolveWorkerExecutionEnvelope(f.document, forged, f.server);
    expect(envelope.allowedCapabilities).not.toContain('system.sudo');
    expect(envelope.mutablePaths).toEqual(['apps/runtime/generated/**']);
  });

  it('fails closed for mission/task/project/workspace/orchestrator impersonation', () => {
    const f = fixture();
    expect(() => resolveWorkerExecutionEnvelope(f.document, { ...f.claims, missionId: randomUUID() }, f.server)).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => resolveWorkerExecutionEnvelope(f.document, { ...f.claims, taskId: randomUUID() }, f.server)).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => resolveWorkerExecutionEnvelope(f.document, f.claims, { ...f.server, projectId: randomUUID() })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => resolveWorkerExecutionEnvelope(f.document, f.claims, { ...f.server, workspaceId: randomUUID() })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => resolveWorkerExecutionEnvelope(f.document, f.claims, { ...f.server, parentOrchestratorId: 'foreign-orchestrator' })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  });

  it('fails closed for stale runtime/tunnel fence, expired authority, or digest tampering', () => {
    const f = fixture();
    expect(() => resolveWorkerExecutionEnvelope(f.document, f.claims, {
      ...f.server,
      runtimeFence: { ...f.runtimeFence, deploymentEpoch: f.runtimeFence.deploymentEpoch + 1 },
    })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => resolveWorkerExecutionEnvelope(f.document, f.claims, { ...f.server, now: '2026-09-20T02:00:00.000Z' }))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => resolveWorkerExecutionEnvelope(f.document, { ...f.claims, authorityDigest: 'f'.repeat(64) }, f.server))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  });

  it('allows granted reads and bounded writes while denying path scope escalation', () => {
    const f = fixture();
    const envelope = resolveWorkerExecutionEnvelope(f.document, f.claims, f.server);
    expect(authorizeWorkerCapability(envelope, 'fs.read', { paths: ['apps/runtime/src/state.ts'] }).id).toBe('fs.read');
    expect(authorizeWorkerCapability(envelope, 'fs.write', { paths: ['apps/runtime/generated/result.json'] }).id).toBe('fs.write');
    expect(() => authorizeWorkerCapability(envelope, 'fs.write', { paths: ['apps/runtime/src/state.ts'] }))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => authorizeWorkerCapability(envelope, 'fs.read', { paths: ['../outside.txt'] }))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  });

  it('denies unknown capabilities, ungranted processes, and resource-budget overflow', () => {
    const f = fixture();
    const envelope = resolveWorkerExecutionEnvelope(f.document, f.claims, f.server);
    expect(() => authorizeWorkerCapability(envelope, 'system.sudo')).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(authorizeWorkerCapability(envelope, 'shell.run', { processProfile: 'node-script' }).id).toBe('shell.run');
    expect(() => authorizeWorkerCapability(envelope, 'shell.run', { processProfile: 'unrestricted-shell' }))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => authorizeWorkerCapability(envelope, 'project.search', {
      usage: { elapsedMs: 60_001, jobs: 0, artifacts: 0, outputBytes: 0 },
    })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  });
});
