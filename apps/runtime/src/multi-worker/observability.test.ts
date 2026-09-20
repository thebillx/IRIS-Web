import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  OrchestrationRun,
  Worker,
  WorkerAssignment,
  WorkerResult,
  WorkerReview,
  WorkerTask,
  WorkerTaskAuthorityMetadata,
  WorkspaceId,
} from '@iris/domain';
import type { MultiWorkerDocument } from './model.js';
import { projectMultiWorkerObservability } from './observability.js';

const createdAt = '2026-09-20T01:00:00.000Z';
const generatedAt = '2026-09-20T01:20:00.000Z';

function authority(missionId: string, taskId: string, sessionId: string, projectId: string, workspaceId: WorkspaceId): WorkerTaskAuthorityMetadata {
  return {
    schemaVersion: 1,
    missionId,
    taskId,
    sessionId,
    projectId,
    workspaceId,
    principalId: `principal-${taskId}`,
    parentOrchestratorId: 'chatgpt-orchestrator',
    allowedCapabilities: ['project.search', 'fs.read'],
    allowedPaths: ['apps/runtime/**'],
    readOnlyPaths: ['apps/runtime/**'],
    mutablePaths: [],
    allowedProcesses: [],
    approvalPolicy: 'INHERIT_MISSION',
    resourceBudget: { maxRuntimeMs: 60_000, maxJobs: 0, maxArtifacts: 8, maxOutputBytes: 1_048_576 },
    concurrencyPolicy: { maxParallelCapabilities: 2, mutablePathOwnership: 'READ_ONLY', allowParallelReads: true },
    createdAt,
    expiresAt: '2026-09-20T03:00:00.000Z',
  };
}

function fixture(): { document: MultiWorkerDocument; runId: string; blockedTaskId: string; runningTaskId: string } {
  const missionId = randomUUID();
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const workspaceId = randomUUID() as WorkspaceId;
  const runId = randomUUID();
  const acceptedTaskId = randomUUID();
  const runningTaskId = randomUUID();
  const failedTaskId = randomUUID();
  const blockedTaskId = randomUUID();
  const workerAId = randomUUID();
  const workerBId = randomUUID();
  const assignmentAId = randomUUID();
  const assignmentBId = randomUUID();
  const resultId = randomUUID();
  const reviewId = randomUUID();

  const acceptedTask: WorkerTask = {
    id: acceptedTaskId,
    orchestrationRunId: runId,
    missionId,
    missionTaskId: null,
    title: 'Reviewed read-only task',
    state: 'SUCCEEDED',
    dependencyTaskIds: [],
    authority: authority(missionId, acceptedTaskId, sessionId, projectId, workspaceId),
    assignmentId: assignmentAId,
    resultId,
    createdAt,
    updatedAt: '2026-09-20T01:05:00.000Z',
  };
  const runningTask: WorkerTask = {
    id: runningTaskId,
    orchestrationRunId: runId,
    missionId,
    missionTaskId: null,
    title: 'Inspect runtime worker state',
    state: 'RUNNING',
    dependencyTaskIds: [acceptedTaskId],
    authority: authority(missionId, runningTaskId, sessionId, projectId, workspaceId),
    assignmentId: assignmentBId,
    resultId: null,
    createdAt: '2026-09-20T01:06:00.000Z',
    updatedAt: '2026-09-20T01:07:00.000Z',
  };
  const failedTask: WorkerTask = {
    id: failedTaskId,
    orchestrationRunId: runId,
    missionId,
    missionTaskId: null,
    title: 'Failed prerequisite',
    state: 'FAILED',
    dependencyTaskIds: [],
    authority: authority(missionId, failedTaskId, sessionId, projectId, workspaceId),
    assignmentId: null,
    resultId: null,
    createdAt,
    updatedAt: '2026-09-20T01:04:00.000Z',
  };
  const blockedTask: WorkerTask = {
    id: blockedTaskId,
    orchestrationRunId: runId,
    missionId,
    missionTaskId: null,
    title: 'Downstream task',
    state: 'PENDING',
    dependencyTaskIds: [failedTaskId],
    authority: authority(missionId, blockedTaskId, sessionId, projectId, workspaceId),
    assignmentId: null,
    resultId: null,
    createdAt: '2026-09-20T01:08:00.000Z',
    updatedAt: '2026-09-20T01:08:00.000Z',
  };

  const workerA: Worker = {
    id: workerAId,
    orchestrationRunId: runId,
    principalId: acceptedTask.authority.principalId,
    workerType: 'IRIS_LOGICAL',
    role: 'RESEARCH',
    state: 'SUCCEEDED',
    parentOrchestratorId: 'chatgpt-orchestrator',
    adapterWorkerId: 'logical-worker-a',
    resumeToken: null,
    resumable: false,
    createdAt,
    updatedAt: '2026-09-20T01:05:00.000Z',
  };
  const workerB: Worker = {
    id: workerBId,
    orchestrationRunId: runId,
    principalId: runningTask.authority.principalId,
    workerType: 'IRIS_LOGICAL',
    role: 'QA',
    state: 'RUNNING',
    parentOrchestratorId: 'chatgpt-orchestrator',
    adapterWorkerId: 'logical-worker-b',
    resumeToken: 'resume-token-b',
    resumable: true,
    createdAt: '2026-09-20T01:06:00.000Z',
    updatedAt: '2026-09-20T01:07:00.000Z',
  };

  const runtimeFence = {
    machineId: randomUUID(),
    runtimeId: randomUUID(),
    instanceId: randomUUID(),
    deploymentEpoch: 3,
    connectorProfile: 'FULL' as const,
    catalogHash: `sha256:${'4'.repeat(64)}`,
  };
  const assignmentA: WorkerAssignment = {
    id: assignmentAId,
    orchestrationRunId: runId,
    taskId: acceptedTaskId,
    workerId: workerAId,
    authorityTaskId: acceptedTaskId,
    runtimeFence,
    authorityDigest: 'a'.repeat(64),
    assignedAt: createdAt,
    releasedAt: '2026-09-20T01:05:00.000Z',
  };
  const assignmentB: WorkerAssignment = {
    id: assignmentBId,
    orchestrationRunId: runId,
    taskId: runningTaskId,
    workerId: workerBId,
    authorityTaskId: runningTaskId,
    runtimeFence,
    authorityDigest: 'b'.repeat(64),
    assignedAt: '2026-09-20T01:06:00.000Z',
    releasedAt: null,
  };

  const evidenceRefs = Array.from({ length: 70 }, (_, index) => `evidence-${index}`);
  const result: WorkerResult = {
    id: resultId,
    orchestrationRunId: runId,
    taskId: acceptedTaskId,
    workerId: workerAId,
    status: 'SUCCEEDED',
    summary: `Authorization: Bearer secret-token PASSWORD=hunter2 ${'x'.repeat(1_200)}`,
    evidenceRefs,
    artifactIds: [],
    filesRead: ['apps/runtime/src/state.ts'],
    filesChanged: [],
    commandsExecuted: ['node hidden.js --token=super-secret'],
    validationResults: [{ name: 'focused', status: 'PASSED', summary: 'token=validation-secret passed' }],
    risks: ['PASSWORD=risk-secret'],
    blockers: [],
    recommendedNextActions: ['Keep Authorization: Bearer next-secret private'],
    createdAt: '2026-09-20T01:05:00.000Z',
  };
  const review: WorkerReview = {
    id: reviewId,
    orchestrationRunId: runId,
    taskId: acceptedTaskId,
    workerId: workerAId,
    resultId,
    decision: 'ACCEPT',
    instruction: 'Accept; PASSWORD=review-secret',
    requestedEvidence: [],
    reviewedByOrchestratorId: 'chatgpt-orchestrator',
    basedOnRunRevision: 3,
    createdAt: '2026-09-20T01:10:00.000Z',
  };
  const run: OrchestrationRun = {
    id: runId,
    missionId,
    projectId,
    sessionId,
    parentOrchestratorId: 'chatgpt-orchestrator',
    state: 'REVIEWING',
    revision: 4,
    taskIds: [acceptedTaskId, runningTaskId, failedTaskId, blockedTaskId],
    workerIds: [workerAId, workerBId],
    assignmentIds: [assignmentAId, assignmentBId],
    resultIds: [resultId],
    createdAt,
    updatedAt: '2026-09-20T01:10:00.000Z',
  };

  return {
    runId,
    blockedTaskId,
    runningTaskId,
    document: {
      schemaVersion: 1,
      generation: 9,
      runs: [run],
      workers: [workerA, workerB],
      tasks: [acceptedTask, runningTask, failedTask, blockedTask],
      assignments: [assignmentA, assignmentB],
      results: [result],
      reviews: [review],
    },
  };
}

describe('IRIS multi-worker M10 observability projection', () => {
  it('renders a deterministic run/task/worker/result/review tree with dependency and active-assignment state', () => {
    const f = fixture();
    const tree = projectMultiWorkerObservability(f.document, f.runId, generatedAt);

    expect(tree.run).toMatchObject({
      id: f.runId,
      state: 'REVIEWING',
      revision: 4,
      taskCount: 4,
      workerCount: 2,
      activeAssignmentCount: 1,
      resultCount: 1,
      reviewCount: 1,
      elapsedMs: 20 * 60_000,
    });

    const blocked = tree.tasks.find((task) => task.id === f.blockedTaskId)!;
    expect(blocked.blockingReason).toMatch(/^Dependency .* is FAILED$/);

    const running = tree.tasks.find((task) => task.id === f.runningTaskId)!;
    expect(running.worker).toMatchObject({ role: 'QA', state: 'RUNNING', adapterWorkerId: 'logical-worker-b' });
    expect(running.assignment).toMatchObject({ active: true });
    expect(running.activeExecution).toEqual({
      adapterWorkerId: 'logical-worker-b',
      capabilityId: null,
      jobId: null,
    });
    expect(running.elapsedMs).toBe(14 * 60_000);
  });

  it('redacts and bounds display text while exposing only command counts, never raw command payloads', () => {
    const f = fixture();
    const tree = projectMultiWorkerObservability(f.document, f.runId, generatedAt);
    const serialized = JSON.stringify(tree);
    const resultTask = tree.tasks.find((task) => task.result !== null)!;

    expect(resultTask.result?.summary).toContain('Bearer [REDACTED]');
    expect(resultTask.result?.summary).toContain('PASSWORD=[REDACTED]');
    expect(resultTask.result?.summary.length).toBeLessThanOrEqual(1_001);
    expect(resultTask.result?.evidenceRefs).toHaveLength(64);
    expect(resultTask.result?.commandsExecutedCount).toBe(1);
    expect(resultTask.review?.instruction).toContain('PASSWORD=[REDACTED]');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('review-secret');
    expect(serialized).not.toContain('next-secret');
    expect(serialized).not.toContain('hidden.js');
  });

  it('rejects an unknown run identity instead of returning an ambiguous empty tree', () => {
    const f = fixture();
    expect(() => projectMultiWorkerObservability(f.document, randomUUID(), generatedAt))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});
