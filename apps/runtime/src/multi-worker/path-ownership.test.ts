import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorkerAssignment, WorkerTask, WorkerTaskAuthorityMetadata, WorkspaceId } from '@iris/domain';
import type { MultiWorkerDocument } from './model.js';
import { findMutablePathConflicts, pathGrantsOverlap } from './path-ownership.js';

function workerTask(workspaceId: WorkspaceId, mutablePaths: readonly string[], state: WorkerTask['state'] = 'ASSIGNED'): WorkerTask {
  const id = randomUUID();
  const now = '2026-09-20T01:00:00.000Z';
  const authority: WorkerTaskAuthorityMetadata = {
    schemaVersion: 1,
    missionId: randomUUID(),
    taskId: id,
    sessionId: randomUUID(),
    projectId: randomUUID(),
    workspaceId,
    principalId: 'worker',
    parentOrchestratorId: 'orchestrator',
    allowedCapabilities: ['fs.read', ...(mutablePaths.length > 0 ? ['fs.write' as const] : [])],
    allowedPaths: ['**'],
    readOnlyPaths: ['**'],
    mutablePaths,
    allowedProcesses: [],
    approvalPolicy: 'INHERIT_MISSION',
    resourceBudget: { maxRuntimeMs: 1000, maxJobs: 0, maxArtifacts: 0, maxOutputBytes: 1024 },
    concurrencyPolicy: {
      maxParallelCapabilities: 1,
      mutablePathOwnership: mutablePaths.length === 0 ? 'READ_ONLY' : 'EXCLUSIVE',
      allowParallelReads: true,
    },
    createdAt: now,
    expiresAt: '2026-09-20T02:00:00.000Z',
  };
  return {
    id,
    orchestrationRunId: randomUUID(),
    missionId: authority.missionId,
    missionTaskId: null,
    title: 'Path ownership',
    state,
    dependencyTaskIds: [],
    authority,
    assignmentId: state === 'ASSIGNED' || state === 'RUNNING' || state === 'WAITING' ? randomUUID() : null,
    resultId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function document(owner: WorkerTask, releasedAt: string | null = null): MultiWorkerDocument {
  const assignment: WorkerAssignment = {
    id: owner.assignmentId!,
    orchestrationRunId: owner.orchestrationRunId,
    taskId: owner.id,
    workerId: randomUUID(),
    authorityTaskId: owner.id,
    runtimeFence: {
      machineId: randomUUID(), runtimeId: randomUUID(), instanceId: randomUUID(),
      deploymentEpoch: 1, connectorProfile: 'FULL', catalogHash: `sha256:${'3'.repeat(64)}`,
    },
    authorityDigest: 'a'.repeat(64),
    assignedAt: owner.createdAt,
    releasedAt,
  };
  return {
    schemaVersion: 1,
    generation: 1,
    runs: [],
    workers: [],
    tasks: [owner],
    assignments: [assignment],
    results: [],
  };
}

describe('IRIS multi-worker M06 path ownership', () => {
  it('detects exact and nested mutable overlap', () => {
    expect(pathGrantsOverlap('src/foo.ts', 'src/foo.ts')).toBe(true);
    expect(pathGrantsOverlap('src/**', 'src/foo.ts')).toBe(true);
    expect(pathGrantsOverlap('src/**', 'src/backend/**')).toBe(true);
    expect(pathGrantsOverlap('src/backend/**', 'src/frontend/**')).toBe(false);
  });

  it('blocks an overlapping candidate in the same workspace while an owner is active', () => {
    const workspaceId = randomUUID() as WorkspaceId;
    const owner = workerTask(workspaceId, ['src/**'], 'RUNNING');
    const candidate = workerTask(workspaceId, ['src/foo.ts']);
    const conflicts = findMutablePathConflicts(document(owner), candidate);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ ownerTaskId: owner.id, candidateTaskId: candidate.id });
  });

  it('allows read-only overlap and mutable ownership in a different workspace', () => {
    const workspaceId = randomUUID() as WorkspaceId;
    const owner = workerTask(workspaceId, ['src/**'], 'RUNNING');
    const readOnly = workerTask(workspaceId, []);
    const otherWorkspace = workerTask(randomUUID() as WorkspaceId, ['src/foo.ts']);
    expect(findMutablePathConflicts(document(owner), readOnly)).toEqual([]);
    expect(findMutablePathConflicts(document(owner), otherWorkspace)).toEqual([]);
  });

  it('releases ownership after the assignment is explicitly released', () => {
    const workspaceId = randomUUID() as WorkspaceId;
    const owner = workerTask(workspaceId, ['src/**'], 'SUCCEEDED');
    const candidate = workerTask(workspaceId, ['src/foo.ts']);
    expect(findMutablePathConflicts(document(owner, '2026-09-20T01:15:00.000Z'), candidate)).toEqual([]);
  });
});
