import {
  RuntimeError,
  type OrchestrationRun,
  type Worker,
  type WorkerAssignment,
  type WorkerResult,
  type WorkerRuntimeFence,
  type WorkerTask,
  type WorkerTaskAuthorityMetadata,
} from '@iris/domain';
import { capabilityDefinition } from '../capability-registry.js';
import type { MultiWorkerDocument } from './model.js';

const MAX_RUNS = 100;
const MAX_WORKERS = 1_000;
const MAX_TASKS = 2_000;
const MAX_ASSIGNMENTS = 2_000;
const MAX_RESULTS = 2_000;
const MAX_LIST = 128;

export function validateMultiWorkerDocument(value: unknown): MultiWorkerDocument {
  if (!isRecord(value)
    || !exactKeys(value, ['schemaVersion', 'generation', 'runs', 'workers', 'tasks', 'assignments', 'results'])
    || value.schemaVersion !== 1
    || !nonNegativeInteger(value.generation)
    || !boundedArray(value.runs, MAX_RUNS)
    || !boundedArray(value.workers, MAX_WORKERS)
    || !boundedArray(value.tasks, MAX_TASKS)
    || !boundedArray(value.assignments, MAX_ASSIGNMENTS)
    || !boundedArray(value.results, MAX_RESULTS)) {
    persistenceFailure('Multi-worker orchestration state is invalid');
  }

  const runs = value.runs as unknown[];
  const workers = value.workers as unknown[];
  const tasks = value.tasks as unknown[];
  const assignments = value.assignments as unknown[];
  const results = value.results as unknown[];

  if (!runs.every(isRun)
    || !workers.every(isWorker)
    || !tasks.every(isTask)
    || !assignments.every(isAssignment)
    || !results.every(isResult)) {
    persistenceFailure('Multi-worker orchestration record is invalid');
  }

  const typedRuns = runs as OrchestrationRun[];
  const typedWorkers = workers as Worker[];
  const typedTasks = tasks as WorkerTask[];
  const typedAssignments = assignments as WorkerAssignment[];
  const typedResults = results as WorkerResult[];

  ensureUnique(typedRuns.map((entry) => entry.id), 'run');
  ensureUnique(typedWorkers.map((entry) => entry.id), 'worker');
  ensureUnique(typedTasks.map((entry) => entry.id), 'task');
  ensureUnique(typedAssignments.map((entry) => entry.id), 'assignment');
  ensureUnique(typedResults.map((entry) => entry.id), 'result');

  const runById = new Map(typedRuns.map((entry) => [entry.id, entry]));
  const workerById = new Map(typedWorkers.map((entry) => [entry.id, entry]));
  const taskById = new Map(typedTasks.map((entry) => [entry.id, entry]));
  const assignmentById = new Map(typedAssignments.map((entry) => [entry.id, entry]));
  const resultById = new Map(typedResults.map((entry) => [entry.id, entry]));

  for (const worker of typedWorkers) {
    const run = runById.get(worker.orchestrationRunId);
    if (run === undefined || worker.parentOrchestratorId !== run.parentOrchestratorId) {
      persistenceFailure('Worker is not bound to its orchestration run');
    }
  }

  for (const task of typedTasks) {
    const run = runById.get(task.orchestrationRunId);
    if (run === undefined
      || task.missionId !== run.missionId
      || task.authority.missionId !== run.missionId
      || task.authority.taskId !== task.id
      || task.authority.sessionId !== run.sessionId
      || task.authority.projectId !== run.projectId
      || task.authority.parentOrchestratorId !== run.parentOrchestratorId) {
      persistenceFailure('Worker task authority does not match its orchestration run');
    }
    for (const dependencyId of task.dependencyTaskIds) {
      const dependency = taskById.get(dependencyId);
      if (dependency === undefined || dependency.orchestrationRunId !== task.orchestrationRunId || dependency.id === task.id) {
        persistenceFailure('Worker task dependency is invalid');
      }
    }
    if (task.assignmentId !== null) {
      const assignment = assignmentById.get(task.assignmentId);
      if (assignment === undefined || assignment.taskId !== task.id || assignment.orchestrationRunId !== task.orchestrationRunId) {
        persistenceFailure('Worker task assignment reference is invalid');
      }
    }
    if (task.resultId !== null) {
      const result = resultById.get(task.resultId);
      if (result === undefined || result.taskId !== task.id || result.orchestrationRunId !== task.orchestrationRunId) {
        persistenceFailure('Worker task result reference is invalid');
      }
    }
  }

  for (const assignment of typedAssignments) {
    const run = runById.get(assignment.orchestrationRunId);
    const task = taskById.get(assignment.taskId);
    const worker = workerById.get(assignment.workerId);
    if (run === undefined || task === undefined || worker === undefined
      || task.orchestrationRunId !== run.id
      || worker.orchestrationRunId !== run.id
      || assignment.authorityTaskId !== task.id
      || task.assignmentId !== assignment.id) {
      persistenceFailure('Worker assignment binding is invalid');
    }
  }

  for (const result of typedResults) {
    const run = runById.get(result.orchestrationRunId);
    const task = taskById.get(result.taskId);
    const worker = workerById.get(result.workerId);
    if (run === undefined || task === undefined || worker === undefined
      || task.orchestrationRunId !== run.id
      || worker.orchestrationRunId !== run.id
      || task.resultId !== result.id) {
      persistenceFailure('Worker result binding is invalid');
    }
  }

  for (const run of typedRuns) {
    assertExactMembership(run.taskIds, typedTasks.filter((entry) => entry.orchestrationRunId === run.id).map((entry) => entry.id), 'run task');
    assertExactMembership(run.workerIds, typedWorkers.filter((entry) => entry.orchestrationRunId === run.id).map((entry) => entry.id), 'run worker');
    assertExactMembership(run.assignmentIds, typedAssignments.filter((entry) => entry.orchestrationRunId === run.id).map((entry) => entry.id), 'run assignment');
    assertExactMembership(run.resultIds, typedResults.filter((entry) => entry.orchestrationRunId === run.id).map((entry) => entry.id), 'run result');
  }

  return value as unknown as MultiWorkerDocument;
}

export function validateWorkerTaskAuthority(value: WorkerTaskAuthorityMetadata): WorkerTaskAuthorityMetadata {
  if (!isAuthority(value)) throw new RuntimeError('INVALID_REQUEST', 'Worker task authority metadata is invalid');
  return value;
}

function isRun(value: unknown): value is OrchestrationRun {
  return isRecord(value)
    && exactKeys(value, ['id', 'missionId', 'projectId', 'sessionId', 'parentOrchestratorId', 'state', 'revision', 'taskIds', 'workerIds', 'assignmentIds', 'resultIds', 'createdAt', 'updatedAt'])
    && uuid(value.id) && uuid(value.missionId) && uuid(value.projectId) && uuid(value.sessionId)
    && bounded(value.parentOrchestratorId, 200)
    && ['PLANNING', 'RUNNING', 'WAITING', 'REVIEWING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(String(value.state))
    && positiveInteger(value.revision)
    && idList(value.taskIds) && idList(value.workerIds) && idList(value.assignmentIds) && idList(value.resultIds)
    && timestamp(value.createdAt) && timestamp(value.updatedAt)
    && String(value.updatedAt) >= String(value.createdAt);
}

function isWorker(value: unknown): value is Worker {
  return isRecord(value)
    && exactKeys(value, ['id', 'orchestrationRunId', 'principalId', 'workerType', 'role', 'state', 'parentOrchestratorId', 'adapterWorkerId', 'resumeToken', 'resumable', 'createdAt', 'updatedAt'])
    && uuid(value.id) && uuid(value.orchestrationRunId)
    && bounded(value.principalId, 200) && bounded(value.workerType, 200)
    && ['CODE', 'QA', 'RESEARCH', 'DOCS', 'GENERIC'].includes(String(value.role))
    && ['IDLE', 'ASSIGNED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(String(value.state))
    && bounded(value.parentOrchestratorId, 200)
    && (value.adapterWorkerId === null || bounded(value.adapterWorkerId, 200))
    && (value.resumeToken === null || bounded(value.resumeToken, 200))
    && typeof value.resumable === 'boolean'
    && timestamp(value.createdAt) && timestamp(value.updatedAt)
    && String(value.updatedAt) >= String(value.createdAt);
}

function isTask(value: unknown): value is WorkerTask {
  return isRecord(value)
    && exactKeys(value, ['id', 'orchestrationRunId', 'missionId', 'missionTaskId', 'title', 'state', 'dependencyTaskIds', 'authority', 'assignmentId', 'resultId', 'createdAt', 'updatedAt'])
    && uuid(value.id) && uuid(value.orchestrationRunId) && uuid(value.missionId)
    && (value.missionTaskId === null || uuid(value.missionTaskId))
    && bounded(value.title, 500)
    && ['PENDING', 'ASSIGNED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(String(value.state))
    && idList(value.dependencyTaskIds)
    && isAuthority(value.authority)
    && (value.assignmentId === null || uuid(value.assignmentId))
    && (value.resultId === null || uuid(value.resultId))
    && timestamp(value.createdAt) && timestamp(value.updatedAt)
    && String(value.updatedAt) >= String(value.createdAt);
}

function isAssignment(value: unknown): value is WorkerAssignment {
  return isRecord(value)
    && exactKeys(value, ['id', 'orchestrationRunId', 'taskId', 'workerId', 'authorityTaskId', 'runtimeFence', 'authorityDigest', 'assignedAt', 'releasedAt'])
    && uuid(value.id) && uuid(value.orchestrationRunId) && uuid(value.taskId) && uuid(value.workerId) && uuid(value.authorityTaskId)
    && isRuntimeFence(value.runtimeFence)
    && typeof value.authorityDigest === 'string' && /^[a-f0-9]{64}$/.test(value.authorityDigest)
    && timestamp(value.assignedAt)
    && (value.releasedAt === null || (timestamp(value.releasedAt) && String(value.releasedAt) >= String(value.assignedAt)));
}

function isRuntimeFence(value: unknown): value is WorkerRuntimeFence {
  return isRecord(value)
    && exactKeys(value, ['machineId', 'runtimeId', 'instanceId', 'deploymentEpoch', 'connectorProfile', 'catalogHash'])
    && uuid(value.machineId)
    && uuid(value.runtimeId)
    && uuid(value.instanceId)
    && positiveInteger(value.deploymentEpoch)
    && value.connectorProfile === 'FULL'
    && typeof value.catalogHash === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(value.catalogHash);
}

function isResult(value: unknown): value is WorkerResult {
  return isRecord(value)
    && exactKeys(value, ['id', 'orchestrationRunId', 'taskId', 'workerId', 'status', 'summary', 'evidenceRefs', 'artifactIds', 'filesRead', 'filesChanged', 'commandsExecuted', 'validationResults', 'risks', 'blockers', 'recommendedNextActions', 'createdAt'])
    && uuid(value.id) && uuid(value.orchestrationRunId) && uuid(value.taskId) && uuid(value.workerId)
    && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(String(value.status))
    && bounded(value.summary, 4_000)
    && boundedStringList(value.evidenceRefs, 1_000)
    && boundedStringList(value.artifactIds, 200)
    && boundedStringList(value.filesRead, 2_000)
    && boundedStringList(value.filesChanged, 2_000)
    && boundedStringList(value.commandsExecuted, 2_000)
    && boundedArray(value.validationResults, MAX_LIST)
    && value.validationResults.every((entry: unknown) => isRecord(entry)
      && exactKeys(entry, ['name', 'status', 'summary'])
      && bounded(entry.name, 200)
      && ['PASSED', 'FAILED', 'SKIPPED'].includes(String(entry.status))
      && bounded(entry.summary, 2_000))
    && boundedStringList(value.risks, 2_000)
    && boundedStringList(value.blockers, 2_000)
    && boundedStringList(value.recommendedNextActions, 2_000)
    && timestamp(value.createdAt);
}

function isAuthority(value: unknown): value is WorkerTaskAuthorityMetadata {
  if (!isRecord(value)
    || !exactKeys(value, ['schemaVersion', 'missionId', 'taskId', 'sessionId', 'projectId', 'workspaceId', 'principalId', 'parentOrchestratorId', 'allowedCapabilities', 'allowedPaths', 'readOnlyPaths', 'mutablePaths', 'allowedProcesses', 'approvalPolicy', 'resourceBudget', 'concurrencyPolicy', 'createdAt', 'expiresAt'])
    || value.schemaVersion !== 1
    || !uuid(value.missionId) || !uuid(value.taskId) || !uuid(value.sessionId) || !uuid(value.projectId) || !uuid(value.workspaceId)
    || !bounded(value.principalId, 200) || !bounded(value.parentOrchestratorId, 200)
    || !capabilityList(value.allowedCapabilities)
    || !boundedStringList(value.allowedPaths, 1_000)
    || !boundedStringList(value.readOnlyPaths, 1_000)
    || !boundedStringList(value.mutablePaths, 1_000)
    || !boundedStringList(value.allowedProcesses, 500)
    || !['INHERIT_MISSION', 'OWNER_REQUIRED'].includes(String(value.approvalPolicy))
    || !isResourceBudget(value.resourceBudget)
    || !isConcurrencyPolicy(value.concurrencyPolicy)
    || !timestamp(value.createdAt) || !timestamp(value.expiresAt)
    || String(value.expiresAt) <= String(value.createdAt)) return false;

  const allowedPaths = value.allowedPaths as string[];
  const readOnlyPaths = value.readOnlyPaths as string[];
  const mutablePaths = value.mutablePaths as string[];
  if (![...allowedPaths, ...readOnlyPaths, ...mutablePaths].every(validAuthorityPathPattern)) return false;
  if (!readOnlyPaths.every((entry) => allowedPaths.some((allowed) => authorityPathGrantContains(allowed, entry)))
    || !mutablePaths.every((entry) => allowedPaths.some((allowed) => authorityPathGrantContains(allowed, entry)))) return false;
  return true;
}

function validAuthorityPathPattern(value: string): boolean {
  if (value === '**') return true;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0') || value === '.' || value === '..' || value.startsWith('../')) return false;
  const wildcardIndex = value.indexOf('*');
  return wildcardIndex === -1 || (value.endsWith('/**') && wildcardIndex === value.length - 2);
}

function authorityPathGrantContains(parent: string, child: string): boolean {
  if (parent === '**' || parent === child) return true;
  if (!parent.endsWith('/**')) return false;
  const parentBase = parent.slice(0, -3);
  const childBase = child.endsWith('/**') ? child.slice(0, -3) : child;
  return childBase === parentBase || childBase.startsWith(`${parentBase}/`);
}

function isResourceBudget(value: unknown): boolean {
  return isRecord(value)
    && exactKeys(value, ['maxRuntimeMs', 'maxJobs', 'maxArtifacts', 'maxOutputBytes'])
    && positiveInteger(value.maxRuntimeMs)
    && nonNegativeInteger(value.maxJobs)
    && nonNegativeInteger(value.maxArtifacts)
    && positiveInteger(value.maxOutputBytes);
}

function isConcurrencyPolicy(value: unknown): boolean {
  return isRecord(value)
    && exactKeys(value, ['maxParallelCapabilities', 'mutablePathOwnership', 'allowParallelReads'])
    && positiveInteger(value.maxParallelCapabilities)
    && ['EXCLUSIVE', 'READ_ONLY'].includes(String(value.mutablePathOwnership))
    && typeof value.allowParallelReads === 'boolean';
}

function capabilityList(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= MAX_LIST
    && unique(value)
    && value.every((entry) => typeof entry === 'string' && capabilityDefinition(entry) !== null);
}

function idList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_LIST && unique(value) && value.every(uuid);
}

function boundedStringList(value: unknown, maxLength: number): boolean {
  return Array.isArray(value)
    && value.length <= MAX_LIST
    && unique(value)
    && value.every((entry) => bounded(entry, maxLength));
}

function boundedArray(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && value.length <= max;
}

function assertExactMembership(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length
    || [...actual].sort().join('\0') !== [...expected].sort().join('\0')) {
    persistenceFailure(`Multi-worker ${label} index is inconsistent`);
  }
}

function ensureUnique(values: readonly string[], label: string): void {
  if (!unique(values)) persistenceFailure(`Duplicate multi-worker ${label} identity`);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((entry, index) => entry === wanted[index]);
}

function unique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && value === value.trim()
    && !value.includes('\0');
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function persistenceFailure(message: string): never {
  throw new RuntimeError('PERSISTENCE_FAILURE', message);
}
