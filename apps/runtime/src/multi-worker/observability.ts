import { RuntimeError, type WorkerReview, type WorkerTask } from '@iris/domain';
import { redactOutput } from '../output-redaction.js';
import type { MultiWorkerDocument } from './model.js';
import { validateMultiWorkerDocument } from './validation.js';

const MAX_TEXT = 1_000;
const MAX_LIST = 64;

export interface MultiWorkerObservabilityTree {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly run: {
    readonly id: string;
    readonly missionId: string;
    readonly projectId: string;
    readonly state: string;
    readonly revision: number;
    readonly elapsedMs: number;
    readonly taskCount: number;
    readonly workerCount: number;
    readonly activeAssignmentCount: number;
    readonly resultCount: number;
    readonly reviewCount: number;
  };
  readonly tasks: readonly MultiWorkerTaskObservation[];
}

export interface MultiWorkerTaskObservation {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly dependencyTaskIds: readonly string[];
  readonly blockingReason: string | null;
  readonly elapsedMs: number;
  readonly workspaceId: string;
  readonly worker: null | {
    readonly id: string;
    readonly role: string;
    readonly workerType: string;
    readonly state: string;
    readonly adapterWorkerId: string | null;
    readonly resumable: boolean;
  };
  readonly assignment: null | {
    readonly id: string;
    readonly active: boolean;
    readonly assignedAt: string;
    readonly releasedAt: string | null;
  };
  readonly activeExecution: null | {
    readonly adapterWorkerId: string | null;
    readonly capabilityId: null;
    readonly jobId: null;
  };
  readonly result: null | {
    readonly id: string;
    readonly status: string;
    readonly summary: string;
    readonly evidenceRefs: readonly string[];
    readonly artifactIds: readonly string[];
    readonly filesReadCount: number;
    readonly filesChangedCount: number;
    readonly commandsExecutedCount: number;
    readonly validationResults: readonly {
      readonly name: string;
      readonly status: string;
      readonly summary: string;
    }[];
    readonly risks: readonly string[];
    readonly blockers: readonly string[];
    readonly recommendedNextActions: readonly string[];
    readonly createdAt: string;
  };
  readonly review: null | {
    readonly id: string;
    readonly decision: string;
    readonly instruction: string;
    readonly requestedEvidence: readonly string[];
    readonly reviewedByOrchestratorId: string;
    readonly basedOnRunRevision: number;
    readonly createdAt: string;
  };
}

/**
 * Build a bounded, display-safe projection of one multi-worker orchestration run.
 *
 * This is intentionally observational only. Raw command strings are never returned. Capability/job
 * correlation remains null until M11 binds worker attribution into CapabilityService/DurableJobManager.
 */
export function projectMultiWorkerObservability(
  documentInput: MultiWorkerDocument,
  orchestrationRunIdInput: string,
  generatedAtInput: string,
): MultiWorkerObservabilityTree {
  const document = validateMultiWorkerDocument(documentInput);
  const orchestrationRunId = requireUuid(orchestrationRunIdInput, 'orchestrationRunId');
  const generatedAt = canonicalTimestamp(generatedAtInput, 'generatedAt');
  const run = document.runs.find((entry) => entry.id === orchestrationRunId);
  if (run === undefined) throw new RuntimeError('INVALID_REQUEST', 'Orchestration run was not found');

  const tasks = document.tasks
    .filter((entry) => entry.orchestrationRunId === run.id)
    .sort((left, right) => left.createdAt !== right.createdAt
      ? (left.createdAt < right.createdAt ? -1 : 1)
      : left.id.localeCompare(right.id));
  const workers = document.workers.filter((entry) => entry.orchestrationRunId === run.id);
  const assignments = document.assignments.filter((entry) => entry.orchestrationRunId === run.id);
  const results = document.results.filter((entry) => entry.orchestrationRunId === run.id);
  const reviews = document.reviews.filter((entry) => entry.orchestrationRunId === run.id);

  const taskObservations = tasks.map((task) => {
    const assignment = task.assignmentId === null
      ? null
      : assignments.find((entry) => entry.id === task.assignmentId) ?? null;
    const worker = assignment === null
      ? null
      : workers.find((entry) => entry.id === assignment.workerId) ?? null;
    const result = task.resultId === null
      ? null
      : results.find((entry) => entry.id === task.resultId) ?? null;
    const review = result === null
      ? null
      : reviews.find((entry) => entry.resultId === result.id) ?? null;

    return Object.freeze({
      id: task.id,
      title: displayText(task.title),
      state: task.state,
      dependencyTaskIds: Object.freeze([...task.dependencyTaskIds]),
      blockingReason: blockingReason(task, tasks, review, result?.blockers ?? []),
      elapsedMs: elapsedMs(task.createdAt, isTerminalTask(task.state) ? task.updatedAt : generatedAt),
      workspaceId: String(task.authority.workspaceId),
      worker: worker === null ? null : Object.freeze({
        id: worker.id,
        role: worker.role,
        workerType: displayText(worker.workerType),
        state: worker.state,
        adapterWorkerId: worker.adapterWorkerId === null ? null : displayText(worker.adapterWorkerId),
        resumable: worker.resumable,
      }),
      assignment: assignment === null ? null : Object.freeze({
        id: assignment.id,
        active: assignment.releasedAt === null,
        assignedAt: assignment.assignedAt,
        releasedAt: assignment.releasedAt,
      }),
      activeExecution: task.state !== 'RUNNING' || worker === null ? null : Object.freeze({
        adapterWorkerId: worker.adapterWorkerId === null ? null : displayText(worker.adapterWorkerId),
        capabilityId: null,
        jobId: null,
      }),
      result: result === null ? null : Object.freeze({
        id: result.id,
        status: result.status,
        summary: displayText(result.summary),
        evidenceRefs: displayList(result.evidenceRefs),
        artifactIds: Object.freeze(result.artifactIds.slice(0, MAX_LIST).map(String)),
        filesReadCount: result.filesRead.length,
        filesChangedCount: result.filesChanged.length,
        commandsExecutedCount: result.commandsExecuted.length,
        validationResults: Object.freeze(result.validationResults.slice(0, MAX_LIST).map((entry) => Object.freeze({
          name: displayText(entry.name),
          status: entry.status,
          summary: displayText(entry.summary),
        }))),
        risks: displayList(result.risks),
        blockers: displayList(result.blockers),
        recommendedNextActions: displayList(result.recommendedNextActions),
        createdAt: result.createdAt,
      }),
      review: review === null ? null : projectReview(review),
    } satisfies MultiWorkerTaskObservation);
  });

  return Object.freeze({
    schemaVersion: 1,
    generatedAt,
    run: Object.freeze({
      id: run.id,
      missionId: run.missionId,
      projectId: run.projectId,
      state: run.state,
      revision: run.revision,
      elapsedMs: elapsedMs(run.createdAt, isTerminalRun(run.state) ? run.updatedAt : generatedAt),
      taskCount: tasks.length,
      workerCount: workers.length,
      activeAssignmentCount: assignments.filter((entry) => entry.releasedAt === null).length,
      resultCount: results.length,
      reviewCount: reviews.length,
    }),
    tasks: Object.freeze(taskObservations),
  });
}

function projectReview(review: WorkerReview) {
  return Object.freeze({
    id: review.id,
    decision: review.decision,
    instruction: displayText(review.instruction),
    requestedEvidence: displayList(review.requestedEvidence),
    reviewedByOrchestratorId: displayText(review.reviewedByOrchestratorId),
    basedOnRunRevision: review.basedOnRunRevision,
    createdAt: review.createdAt,
  });
}

function blockingReason(
  task: WorkerTask,
  tasks: readonly WorkerTask[],
  review: WorkerReview | null,
  resultBlockers: readonly string[],
): string | null {
  if (task.state === 'BLOCKED') {
    if (resultBlockers.length > 0) return displayText(resultBlockers[0]!);
    return 'Task is blocked';
  }
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  const terminalDependency = task.dependencyTaskIds
    .map((id) => byId.get(id))
    .find((dependency) => dependency !== undefined
      && (dependency.state === 'FAILED' || dependency.state === 'CANCELLED' || dependency.state === 'BLOCKED'));
  if (terminalDependency !== undefined) return `Dependency ${terminalDependency.id} is ${terminalDependency.state}`;

  const pending = task.dependencyTaskIds
    .map((id) => byId.get(id))
    .filter((dependency) => dependency !== undefined && dependency.state !== 'SUCCEEDED');
  if (pending.length > 0) return `Waiting for ${pending.length} dependenc${pending.length === 1 ? 'y' : 'ies'}`;
  if (task.state === 'PENDING') return 'Awaiting assignment';
  if (task.state === 'WAITING' && review !== null && review.decision !== 'ACCEPT') {
    return `Orchestrator decision: ${review.decision}`;
  }
  if (task.state === 'WAITING') return 'Waiting for Orchestrator or worker recovery';
  return null;
}

function displayList(values: readonly string[]): readonly string[] {
  return Object.freeze(values.slice(0, MAX_LIST).map(displayText));
}

function displayText(value: string): string {
  const redacted = redactOutput(value);
  if (redacted.length <= MAX_TEXT) return redacted;
  return `${redacted.slice(0, MAX_TEXT)}…`;
}

function elapsedMs(startInput: string, endInput: string): number {
  const start = Date.parse(startInput);
  const end = Date.parse(endInput);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function isTerminalTask(state: WorkerTask['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'BLOCKED';
}

function isTerminalRun(state: string): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
}

function requireUuid(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new RuntimeError('INVALID_REQUEST', `${name} must be a UUID`);
  }
  return normalized;
}

function canonicalTimestamp(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new RuntimeError('INVALID_REQUEST', `${name} is not a timestamp`);
  const canonical = new Date(value).toISOString();
  if (canonical !== value) throw new RuntimeError('INVALID_REQUEST', `${name} must be canonical UTC ISO-8601`);
  return canonical;
}
