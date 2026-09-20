import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ArtifactId,
  OrchestrationRun,
  Worker,
  WorkerAssignment,
  WorkerResult,
  WorkerTask,
  WorkerTaskAuthorityMetadata,
  WorkspaceId,
} from '@iris/domain';
import { type MultiWorkerDocument } from './model.js';
import { MultiWorkerStore } from './store.js';
import { validateMultiWorkerDocument } from './validation.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function fixture(generation = 1): MultiWorkerDocument {
  const missionId = randomUUID();
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const workerId = randomUUID();
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  const resultId = randomUUID();
  const now = '2026-09-20T01:00:00.000Z';
  const authority: WorkerTaskAuthorityMetadata = {
    schemaVersion: 1,
    missionId,
    taskId,
    sessionId,
    projectId,
    workspaceId: randomUUID() as WorkspaceId,
    principalId: 'worker-principal-code-1',
    parentOrchestratorId: 'chatgpt-orchestrator',
    allowedCapabilities: ['project.search', 'fs.read'],
    allowedPaths: ['apps/runtime/**'],
    readOnlyPaths: ['apps/runtime/**'],
    mutablePaths: [],
    allowedProcesses: [],
    approvalPolicy: 'INHERIT_MISSION',
    resourceBudget: {
      maxRuntimeMs: 60_000,
      maxJobs: 0,
      maxArtifacts: 8,
      maxOutputBytes: 1_048_576,
    },
    concurrencyPolicy: {
      maxParallelCapabilities: 2,
      mutablePathOwnership: 'READ_ONLY',
      allowParallelReads: true,
    },
    createdAt: now,
    expiresAt: '2026-09-20T02:00:00.000Z',
  };
  const worker: Worker = {
    id: workerId,
    orchestrationRunId: runId,
    principalId: 'worker-principal-code-1',
    workerType: 'IRIS_LOGICAL',
    role: 'CODE',
    state: 'SUCCEEDED',
    parentOrchestratorId: 'chatgpt-orchestrator',
    createdAt: now,
    updatedAt: now,
  };
  const task: WorkerTask = {
    id: taskId,
    orchestrationRunId: runId,
    missionId,
    missionTaskId: randomUUID(),
    title: 'Inspect runtime implementation',
    state: 'SUCCEEDED',
    dependencyTaskIds: [],
    authority,
    assignmentId,
    resultId,
    createdAt: now,
    updatedAt: now,
  };
  const assignment: WorkerAssignment = {
    id: assignmentId,
    orchestrationRunId: runId,
    taskId,
    workerId,
    authorityTaskId: taskId,
    assignedAt: now,
    releasedAt: '2026-09-20T01:10:00.000Z',
  };
  const result: WorkerResult = {
    id: resultId,
    orchestrationRunId: runId,
    taskId,
    workerId,
    status: 'SUCCEEDED',
    summary: 'Bounded read-only inspection completed.',
    evidenceRefs: ['evidence:runtime'],
    artifactIds: [randomUUID() as ArtifactId],
    filesRead: ['apps/runtime/src/capability-service.ts'],
    filesChanged: [],
    commandsExecuted: [],
    validationResults: [{ name: 'focused-read', status: 'PASSED', summary: 'Read-only inspection completed.' }],
    risks: [],
    blockers: [],
    recommendedNextActions: ['Continue to authority-envelope implementation.'],
    createdAt: '2026-09-20T01:10:00.000Z',
  };
  const run: OrchestrationRun = {
    id: runId,
    missionId,
    projectId,
    sessionId,
    parentOrchestratorId: 'chatgpt-orchestrator',
    state: 'SUCCEEDED',
    revision: 1,
    taskIds: [taskId],
    workerIds: [workerId],
    assignmentIds: [assignmentId],
    resultIds: [resultId],
    createdAt: now,
    updatedAt: '2026-09-20T01:10:00.000Z',
  };
  return {
    schemaVersion: 1,
    generation,
    runs: [run],
    workers: [worker],
    tasks: [task],
    assignments: [assignment],
    results: [result],
  };
}

describe('IRIS multi-worker M02 domain and persistence', () => {
  it('accepts one fully linked run without replacing legacy Mission/MissionTask identity', () => {
    const document = validateMultiWorkerDocument(fixture());
    expect(document.runs).toHaveLength(1);
    expect(document.tasks[0]?.missionTaskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(document.tasks[0]?.authority.missionId).toBe(document.runs[0]?.missionId);
  });

  it('fails closed on malformed or unknown capability authority', () => {
    const document = structuredClone(fixture()) as unknown as {
      tasks: Array<{ authority: { allowedCapabilities: string[] } }>;
    };
    document.tasks[0]!.authority.allowedCapabilities = ['unknown.worker.capability'];
    expect(() => validateMultiWorkerDocument(document)).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILURE' }));
  });

  it('rejects duplicate durable identities', () => {
    const document = structuredClone(fixture()) as unknown as { tasks: unknown[] };
    document.tasks.push(structuredClone(document.tasks[0]));
    expect(() => validateMultiWorkerDocument(document)).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILURE' }));
  });

  it('rejects Worker-to-Worker parenting fields instead of silently accepting recursive hierarchy', () => {
    const document = structuredClone(fixture()) as unknown as {
      workers: Array<Record<string, unknown>>;
    };
    document.workers[0]!.parentWorkerId = randomUUID();
    expect(() => validateMultiWorkerDocument(document)).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILURE' }));
  });

  it('rejects task authority identity drift from mission/session/project/run identity', () => {
    const document = structuredClone(fixture()) as unknown as {
      tasks: Array<{ authority: { projectId: string } }>;
    };
    document.tasks[0]!.authority.projectId = randomUUID();
    expect(() => validateMultiWorkerDocument(document)).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILURE' }));
  });

  it('persists one generation atomically, survives store restart, and rejects stale generation writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'iris-multi-worker-m02-'));
    roots.push(root);
    const store = new MultiWorkerStore(root);
    expect((await store.read()).generation).toBe(0);

    const first = fixture(1);
    await store.write(first, 0);
    expect(await store.read()).toEqual(first);

    const restarted = new MultiWorkerStore(root);
    expect((await restarted.read()).runs[0]?.id).toBe(first.runs[0]?.id);

    const mode = (await stat(path.join(root, 'multi-worker-orchestration.json'))).mode & 0o777;
    expect(mode).toBe(0o600);

    const second = { ...first, generation: 2 };
    await expect(restarted.write(second, 0)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(restarted.write({ ...first, generation: 3 }, 1)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
