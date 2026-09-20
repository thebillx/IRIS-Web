import { randomUUID } from 'node:crypto';
import {
  RuntimeError,
  type CapabilityId,
  type OrchestrationRun,
  type Worker,
  type WorkerAssignment,
  type WorkerRuntimeFence,
  type WorkerTask,
  type WorkerTaskAuthorityMetadata,
  type WorkspaceId,
} from '@iris/domain';
import type { RuntimeState } from '../state.js';
import type { VNextResourceRegistry } from '../resource-registry.js';
import {
  WorkerAdapterRegistry,
  normalizeWorkerStartReceipt,
} from '../durable-mission-workers.js';
import type { WorkerBinding } from '../durable-mission-lifecycle.js';
import { deriveWorkerAuthorityDigest } from './authority.js';
import type { MultiWorkerDocument } from './model.js';
import { MultiWorkerStore } from './store.js';
import { validateMultiWorkerDocument, validateWorkerTaskAuthority } from './validation.js';

export interface CreateOrchestrationRunInput {
  readonly expectedGeneration: number;
  readonly missionId: string;
  readonly parentOrchestratorId: string;
}

export interface CreateWorkerInput {
  readonly expectedGeneration: number;
  readonly orchestrationRunId: string;
  readonly principalId: string;
  readonly workerType: string;
  readonly role: Worker['role'];
}

export interface CreateWorkerTaskInput {
  readonly expectedGeneration: number;
  readonly orchestrationRunId: string;
  readonly missionTaskId: string | null;
  readonly title: string;
  readonly dependencyTaskIds: readonly string[];
  readonly workspaceId: WorkspaceId;
  readonly principalId: string;
  readonly allowedCapabilities: readonly CapabilityId[];
  readonly allowedPaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
  readonly mutablePaths: readonly string[];
  readonly allowedProcesses: readonly string[];
  readonly approvalPolicy: WorkerTaskAuthorityMetadata['approvalPolicy'];
  readonly resourceBudget: WorkerTaskAuthorityMetadata['resourceBudget'];
  readonly concurrencyPolicy: WorkerTaskAuthorityMetadata['concurrencyPolicy'];
  readonly expiresAt: string;
}

export interface AssignWorkerTaskInput {
  readonly expectedGeneration: number;
  readonly orchestrationRunId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly runtimeFence: WorkerRuntimeFence;
}

export interface StartWorkerTaskInput {
  readonly expectedGeneration: number;
  readonly orchestrationRunId: string;
  readonly taskId: string;
  readonly requestId: string;
}

export interface TransitionWorkerTaskInput {
  readonly expectedGeneration: number;
  readonly orchestrationRunId: string;
  readonly taskId: string;
}

export interface CancelOrchestrationRunInput {
  readonly expectedGeneration: number;
  readonly orchestrationRunId: string;
}

export interface MultiWorkerRunView {
  readonly generation: number;
  readonly run: OrchestrationRun;
  readonly workers: readonly Worker[];
  readonly tasks: readonly WorkerTask[];
  readonly assignments: readonly WorkerAssignment[];
}

export class MultiWorkerRoutingService {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly state: RuntimeState,
    private readonly resources: VNextResourceRegistry,
    private readonly store: MultiWorkerStore,
    private readonly workers: WorkerAdapterRegistry = new WorkerAdapterRegistry(),
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  public async listRuns(): Promise<readonly OrchestrationRun[]> {
    return (await this.store.read()).runs;
  }

  public async listWorkers(orchestrationRunIdInput?: string): Promise<readonly Worker[]> {
    const document = await this.store.read();
    if (orchestrationRunIdInput === undefined) return document.workers;
    const orchestrationRunId = requireUuid(orchestrationRunIdInput, 'orchestrationRunId');
    requiredRun(document, orchestrationRunId);
    return document.workers.filter((entry) => entry.orchestrationRunId === orchestrationRunId);
  }

  public async listTasks(orchestrationRunIdInput?: string): Promise<readonly WorkerTask[]> {
    const document = await this.store.read();
    if (orchestrationRunIdInput === undefined) return document.tasks;
    const orchestrationRunId = requireUuid(orchestrationRunIdInput, 'orchestrationRunId');
    requiredRun(document, orchestrationRunId);
    return document.tasks.filter((entry) => entry.orchestrationRunId === orchestrationRunId);
  }

  public async getRun(orchestrationRunIdInput: string): Promise<MultiWorkerRunView> {
    const orchestrationRunId = requireUuid(orchestrationRunIdInput, 'orchestrationRunId');
    const document = await this.store.read();
    const run = requiredRun(document, orchestrationRunId);
    return view(document, run);
  }

  public async getWorker(workerIdInput: string): Promise<Worker> {
    const workerId = requireUuid(workerIdInput, 'workerId');
    const worker = (await this.store.read()).workers.find((entry) => entry.id === workerId);
    if (worker === undefined) throw new RuntimeError('INVALID_REQUEST', 'Worker was not found');
    return worker;
  }

  public async getTask(taskIdInput: string): Promise<WorkerTask> {
    const taskId = requireUuid(taskIdInput, 'taskId');
    const task = (await this.store.read()).tasks.find((entry) => entry.id === taskId);
    if (task === undefined) throw new RuntimeError('INVALID_REQUEST', 'Worker task was not found');
    return task;
  }

  public createRun(input: CreateOrchestrationRunInput): Promise<MultiWorkerRunView> {
    const missionId = requireUuid(input.missionId, 'missionId');
    const parentOrchestratorId = bounded(input.parentOrchestratorId, 'parentOrchestratorId', 200);
    return this.mutate(input.expectedGeneration, async (document) => {
      if (document.runs.some((entry) => entry.missionId === missionId)) {
        throw new RuntimeError('INVALID_REQUEST', 'Mission already has a multi-worker orchestration run');
      }
      const mission = await this.state.getMission(missionId);
      if (mission.projectId === null) throw new RuntimeError('CAPABILITY_DENIED', 'Multi-worker orchestration requires an explicit project');
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(mission.state)) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Terminal Mission cannot create a multi-worker orchestration run');
      }
      if (!(await this.state.listProjects()).some((project) => project.id === mission.projectId)) {
        throw new RuntimeError('PROJECT_NOT_FOUND', 'Mission project is not registered');
      }
      const session = this.state.getSessionForClient(mission.sessionId, mission.clientId);
      if (session.agentId !== parentOrchestratorId) {
        throw new RuntimeError('CONTROL_DENIED', 'parentOrchestratorId does not match the authoritative Mission session agent');
      }
      if (session.currentProjectId !== mission.projectId) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Mission session is not selected on the durable Mission project');
      }
      const now = this.now();
      const run: OrchestrationRun = {
        id: randomUUID(),
        missionId,
        projectId: mission.projectId,
        sessionId: mission.sessionId,
        parentOrchestratorId,
        state: 'PLANNING',
        revision: 1,
        taskIds: [],
        workerIds: [],
        assignmentIds: [],
        resultIds: [],
        createdAt: now,
        updatedAt: now,
      };
      return {
        document: { ...document, runs: [...document.runs, run] },
        value: (next: MultiWorkerDocument) => view(next, runById(next, run.id)),
      };
    });
  }

  public createWorker(input: CreateWorkerInput): Promise<Worker> {
    const runId = requireUuid(input.orchestrationRunId, 'orchestrationRunId');
    const principalId = bounded(input.principalId, 'principalId', 200);
    const workerType = bounded(input.workerType, 'workerType', 200);
    if (!['CODE', 'QA', 'RESEARCH', 'DOCS', 'GENERIC'].includes(input.role)) {
      throw new RuntimeError('INVALID_REQUEST', 'Worker role is invalid');
    }
    return this.mutate(input.expectedGeneration, async (document) => {
      const run = requiredActiveRun(document, runId);
      this.workers.get(workerType);
      const now = this.now();
      const worker: Worker = {
        id: randomUUID(),
        orchestrationRunId: run.id,
        principalId,
        workerType,
        role: input.role,
        state: 'IDLE',
        parentOrchestratorId: run.parentOrchestratorId,
        adapterWorkerId: null,
        resumeToken: null,
        resumable: false,
        createdAt: now,
        updatedAt: now,
      };
      const updatedRun = touchRun(run, now, { workerIds: [...run.workerIds, worker.id] });
      return {
        document: {
          ...document,
          runs: replaceById(document.runs, updatedRun),
          workers: [...document.workers, worker],
        },
        value: (next: MultiWorkerDocument) => requiredWorker(next, worker.id),
      };
    });
  }

  public createTask(input: CreateWorkerTaskInput): Promise<WorkerTask> {
    const runId = requireUuid(input.orchestrationRunId, 'orchestrationRunId');
    const missionTaskId = input.missionTaskId === null ? null : requireUuid(input.missionTaskId, 'missionTaskId');
    const title = bounded(input.title, 'title', 500);
    const principalId = bounded(input.principalId, 'principalId', 200);
    const dependencyTaskIds = boundedIds(input.dependencyTaskIds, 'dependencyTaskIds');
    return this.mutate(input.expectedGeneration, async (document) => {
      const run = requiredActiveRun(document, runId);
      await this.resources.getActiveWorkspace(run.projectId, input.workspaceId);
      const mission = await this.state.getMission(run.missionId);
      if (mission.sessionId !== run.sessionId || mission.projectId !== run.projectId) {
        throw new RuntimeError('CONTROL_DENIED', 'Orchestration run no longer matches authoritative mission identity');
      }
      if (missionTaskId !== null && !mission.tasks.some((task) => task.id === missionTaskId)) {
        throw new RuntimeError('INVALID_REQUEST', 'missionTaskId does not belong to the authoritative Mission');
      }
      for (const dependencyId of dependencyTaskIds) {
        const dependency = document.tasks.find((entry) => entry.id === dependencyId);
        if (dependency === undefined || dependency.orchestrationRunId !== run.id) {
          throw new RuntimeError('INVALID_REQUEST', 'Worker task dependency does not belong to this orchestration run');
        }
      }
      const now = this.now();
      const taskId = randomUUID();
      const authority = validateWorkerTaskAuthority({
        schemaVersion: 1,
        missionId: run.missionId,
        taskId,
        sessionId: run.sessionId,
        projectId: run.projectId,
        workspaceId: input.workspaceId,
        principalId,
        parentOrchestratorId: run.parentOrchestratorId,
        allowedCapabilities: [...input.allowedCapabilities],
        allowedPaths: [...input.allowedPaths],
        readOnlyPaths: [...input.readOnlyPaths],
        mutablePaths: [...input.mutablePaths],
        allowedProcesses: [...input.allowedProcesses],
        approvalPolicy: input.approvalPolicy,
        resourceBudget: { ...input.resourceBudget },
        concurrencyPolicy: { ...input.concurrencyPolicy },
        createdAt: now,
        expiresAt: canonicalTimestamp(input.expiresAt, 'expiresAt'),
      });
      const task: WorkerTask = {
        id: taskId,
        orchestrationRunId: run.id,
        missionId: run.missionId,
        missionTaskId,
        title,
        state: 'PENDING',
        dependencyTaskIds,
        authority,
        assignmentId: null,
        resultId: null,
        createdAt: now,
        updatedAt: now,
      };
      const updatedRun = touchRun(run, now, { taskIds: [...run.taskIds, task.id] });
      return {
        document: {
          ...document,
          runs: replaceById(document.runs, updatedRun),
          tasks: [...document.tasks, task],
        },
        value: (next: MultiWorkerDocument) => requiredTask(next, task.id),
      };
    });
  }

  public assignTask(input: AssignWorkerTaskInput): Promise<WorkerAssignment> {
    const runId = requireUuid(input.orchestrationRunId, 'orchestrationRunId');
    const taskId = requireUuid(input.taskId, 'taskId');
    const workerId = requireUuid(input.workerId, 'workerId');
    return this.mutate(input.expectedGeneration, async (document) => {
      const run = requiredActiveRun(document, runId);
      const task = requiredTask(document, taskId);
      const worker = requiredWorker(document, workerId);
      if (task.orchestrationRunId !== run.id || worker.orchestrationRunId !== run.id) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Task/worker do not belong to the selected orchestration run');
      }
      if (task.state !== 'PENDING' || task.assignmentId !== null || worker.state !== 'IDLE') {
        throw new RuntimeError('INVALID_REQUEST', 'Task or worker is not eligible for assignment');
      }
      if (task.authority.principalId !== worker.principalId) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Worker principal does not match immutable task authority');
      }
      await this.resources.getActiveWorkspace(run.projectId, task.authority.workspaceId);
      const now = this.now();
      const base: WorkerAssignment = {
        id: randomUUID(),
        orchestrationRunId: run.id,
        taskId: task.id,
        workerId: worker.id,
        authorityTaskId: task.id,
        runtimeFence: structuredClone(input.runtimeFence),
        authorityDigest: '0'.repeat(64),
        assignedAt: now,
        releasedAt: null,
      };
      const assignment: WorkerAssignment = {
        ...base,
        authorityDigest: deriveWorkerAuthorityDigest(task, worker, base),
      };
      const updatedTask: WorkerTask = { ...task, state: 'ASSIGNED', assignmentId: assignment.id, updatedAt: now };
      const updatedWorker: Worker = { ...worker, state: 'ASSIGNED', updatedAt: now };
      const updatedRun = touchRun(run, now, { assignmentIds: [...run.assignmentIds, assignment.id] });
      const candidate: MultiWorkerDocument = {
        ...document,
        runs: replaceById(document.runs, updatedRun),
        workers: replaceById(document.workers, updatedWorker),
        tasks: replaceById(document.tasks, updatedTask),
        assignments: [...document.assignments, assignment],
      };
      validateMultiWorkerDocument({ ...candidate, generation: document.generation });
      return {
        document: candidate,
        value: (next: MultiWorkerDocument) => requiredAssignment(next, assignment.id),
      };
    });
  }

  public startTask(input: StartWorkerTaskInput): Promise<WorkerTask> {
    const runId = requireUuid(input.orchestrationRunId, 'orchestrationRunId');
    const taskId = requireUuid(input.taskId, 'taskId');
    const requestId = requireUuid(input.requestId, 'requestId');
    return this.mutate(input.expectedGeneration, async (document) => {
      const run = requiredActiveRun(document, runId);
      const task = requiredTask(document, taskId);
      const assignment = task.assignmentId === null ? null : document.assignments.find((entry) => entry.id === task.assignmentId) ?? null;
      if (task.orchestrationRunId !== run.id || task.state !== 'ASSIGNED' || assignment === null || assignment.releasedAt !== null) {
        throw new RuntimeError('INVALID_REQUEST', 'Worker task is not ready to start');
      }
      const worker = requiredWorker(document, assignment.workerId);
      if (worker.state !== 'ASSIGNED' || worker.workerType !== 'IRIS_LOGICAL') {
        throw new RuntimeError('CAPABILITY_DENIED', 'M04 starts only the bounded IRIS_LOGICAL worker adapter');
      }
      if (!task.dependencyTaskIds.every((dependencyId) => requiredTask(document, dependencyId).state === 'SUCCEEDED')) {
        throw new RuntimeError('CONTROL_DENIED', 'Worker task dependencies are not complete');
      }
      const receipt = normalizeWorkerStartReceipt(await this.workers.get(worker.workerType).start({
        operationId: requestId,
        missionId: task.missionId,
        projectId: run.projectId,
        goal: task.title,
      }));
      const now = this.now();
      const updatedTask: WorkerTask = { ...task, state: 'RUNNING', updatedAt: now };
      const updatedWorker: Worker = {
        ...worker,
        state: 'RUNNING',
        adapterWorkerId: receipt.workerId,
        resumeToken: receipt.resumeToken,
        resumable: receipt.resumable,
        updatedAt: now,
      };
      const updatedRun = touchRun(run, now, { state: 'RUNNING' });
      return {
        document: {
          ...document,
          runs: replaceById(document.runs, updatedRun),
          workers: replaceById(document.workers, updatedWorker),
          tasks: replaceById(document.tasks, updatedTask),
        },
        value: (next: MultiWorkerDocument) => requiredTask(next, task.id),
      };
    });
  }

  public completeTask(input: TransitionWorkerTaskInput): Promise<WorkerTask> {
    return this.finishTask(input, 'SUCCEEDED');
  }

  public failTask(input: TransitionWorkerTaskInput): Promise<WorkerTask> {
    return this.finishTask(input, 'FAILED');
  }

  public cancelTask(input: TransitionWorkerTaskInput): Promise<WorkerTask> {
    const runId = requireUuid(input.orchestrationRunId, 'orchestrationRunId');
    const taskId = requireUuid(input.taskId, 'taskId');
    return this.mutate(input.expectedGeneration, async (document) => {
      const run = requiredActiveRun(document, runId);
      const task = requiredTask(document, taskId);
      if (task.orchestrationRunId !== run.id || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state)) {
        throw new RuntimeError('INVALID_REQUEST', 'Worker task is not cancellable');
      }
      const assignment = task.assignmentId === null ? null : requiredAssignment(document, task.assignmentId);
      const worker = assignment === null ? null : requiredWorker(document, assignment.workerId);
      if (worker !== null && worker.adapterWorkerId !== null) {
        await this.cancelAdapter(run, worker);
      }
      const now = this.now();
      const updatedTask: WorkerTask = { ...task, state: 'CANCELLED', updatedAt: now };
      const updatedWorker = worker === null ? null : { ...worker, state: 'CANCELLED' as const, resumable: false, updatedAt: now };
      const updatedAssignment = assignment === null ? null : { ...assignment, releasedAt: now };
      const updatedRun = touchRun(run, now, { state: 'REVIEWING' });
      return {
        document: {
          ...document,
          runs: replaceById(document.runs, updatedRun),
          workers: updatedWorker === null ? document.workers : replaceById(document.workers, updatedWorker),
          tasks: replaceById(document.tasks, updatedTask),
          assignments: updatedAssignment === null ? document.assignments : replaceById(document.assignments, updatedAssignment),
        },
        value: (next: MultiWorkerDocument) => requiredTask(next, task.id),
      };
    });
  }

  public cancelRun(input: CancelOrchestrationRunInput): Promise<MultiWorkerRunView> {
    const runId = requireUuid(input.orchestrationRunId, 'orchestrationRunId');
    return this.mutate(input.expectedGeneration, async (document) => {
      const run = requiredActiveRun(document, runId);
      const now = this.now();
      let workers = [...document.workers];
      let tasks = [...document.tasks];
      let assignments = [...document.assignments];
      for (const task of document.tasks.filter((entry) => entry.orchestrationRunId === run.id)) {
        if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state)) continue;
        const assignment = task.assignmentId === null ? null : requiredAssignment(document, task.assignmentId);
        const worker = assignment === null ? null : requiredWorker(document, assignment.workerId);
        if (worker !== null && worker.adapterWorkerId !== null) await this.cancelAdapter(run, worker);
        tasks = replaceById(tasks, { ...task, state: 'CANCELLED', updatedAt: now });
        if (worker !== null) workers = replaceById(workers, { ...worker, state: 'CANCELLED', resumable: false, updatedAt: now });
        if (assignment !== null) assignments = replaceById(assignments, { ...assignment, releasedAt: now });
      }
      const updatedRun = touchRun(run, now, { state: 'CANCELLED' });
      return {
        document: { ...document, runs: replaceById(document.runs, updatedRun), workers, tasks, assignments },
        value: (next: MultiWorkerDocument) => view(next, runById(next, run.id)),
      };
    });
  }

  private finishTask(input: TransitionWorkerTaskInput, state: 'SUCCEEDED' | 'FAILED'): Promise<WorkerTask> {
    const runId = requireUuid(input.orchestrationRunId, 'orchestrationRunId');
    const taskId = requireUuid(input.taskId, 'taskId');
    return this.mutate(input.expectedGeneration, async (document) => {
      const run = requiredActiveRun(document, runId);
      const task = requiredTask(document, taskId);
      if (task.orchestrationRunId !== run.id || task.state !== 'RUNNING' || task.assignmentId === null) {
        throw new RuntimeError('INVALID_REQUEST', 'Worker task is not running');
      }
      const assignment = requiredAssignment(document, task.assignmentId);
      const worker = requiredWorker(document, assignment.workerId);
      const now = this.now();
      const updatedTask: WorkerTask = { ...task, state, updatedAt: now };
      const updatedWorker: Worker = { ...worker, state, resumable: false, updatedAt: now };
      const updatedAssignment: WorkerAssignment = { ...assignment, releasedAt: now };
      const tasks = replaceById(document.tasks, updatedTask);
      const runTasks = tasks.filter((entry) => entry.orchestrationRunId === run.id);
      const runState = runTasks.every((entry) => entry.state === 'SUCCEEDED') ? 'REVIEWING' : state === 'FAILED' ? 'REVIEWING' : 'RUNNING';
      const updatedRun = touchRun(run, now, { state: runState });
      return {
        document: {
          ...document,
          runs: replaceById(document.runs, updatedRun),
          workers: replaceById(document.workers, updatedWorker),
          tasks,
          assignments: replaceById(document.assignments, updatedAssignment),
        },
        value: (next: MultiWorkerDocument) => requiredTask(next, task.id),
      };
    });
  }

  private async cancelAdapter(run: OrchestrationRun, worker: Worker): Promise<void> {
    if (worker.workerType !== 'IRIS_LOGICAL' || worker.adapterWorkerId === null) {
      throw new RuntimeError('CAPABILITY_DENIED', 'M04 cancellation is limited to IRIS_LOGICAL workers');
    }
    const binding: WorkerBinding = {
      workerType: worker.workerType,
      workerId: worker.adapterWorkerId,
      resumeToken: worker.resumeToken,
      missionId: run.missionId,
      projectId: run.projectId,
      createdAt: worker.createdAt,
      lastSeenAt: worker.updatedAt,
      resumable: worker.resumable,
    };
    await this.workers.get(worker.workerType).cancel({
      operationId: randomUUID(),
      missionId: run.missionId,
      projectId: run.projectId,
      binding,
    });
  }

  private mutate<T>(
    expectedGenerationInput: number,
    operation: (document: MultiWorkerDocument) => Promise<{
      readonly document: MultiWorkerDocument;
      readonly value: (next: MultiWorkerDocument) => T;
    }>,
  ): Promise<T> {
    const expectedGeneration = requireGeneration(expectedGenerationInput);
    const result = this.mutationTail.then(async () => {
      const current = await this.store.read();
      if (current.generation !== expectedGeneration) {
        throw new RuntimeError('PRECONDITION_FAILED', 'Multi-worker orchestration generation is stale');
      }
      const mutation = await operation(current);
      const next = validateMultiWorkerDocument({ ...mutation.document, generation: current.generation + 1 });
      await this.store.write(next, current.generation);
      return mutation.value(next);
    }, async () => {
      const current = await this.store.read();
      if (current.generation !== expectedGeneration) {
        throw new RuntimeError('PRECONDITION_FAILED', 'Multi-worker orchestration generation is stale');
      }
      const mutation = await operation(current);
      const next = validateMultiWorkerDocument({ ...mutation.document, generation: current.generation + 1 });
      await this.store.write(next, current.generation);
      return mutation.value(next);
    });
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private now(): string {
    return canonicalTimestamp(this.clock(), 'clock');
  }
}

function view(document: MultiWorkerDocument, run: OrchestrationRun): MultiWorkerRunView {
  return {
    generation: document.generation,
    run,
    workers: document.workers.filter((entry) => entry.orchestrationRunId === run.id),
    tasks: document.tasks.filter((entry) => entry.orchestrationRunId === run.id),
    assignments: document.assignments.filter((entry) => entry.orchestrationRunId === run.id),
  };
}

function requiredActiveRun(document: MultiWorkerDocument, runId: string): OrchestrationRun {
  const run = requiredRun(document, runId);
  if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.state)) {
    throw new RuntimeError('INVALID_REQUEST', 'Orchestration run is terminal');
  }
  return run;
}

function requiredRun(document: MultiWorkerDocument, runId: string): OrchestrationRun {
  const run = document.runs.find((entry) => entry.id === runId);
  if (run === undefined) throw new RuntimeError('INVALID_REQUEST', 'Orchestration run was not found');
  return run;
}

function runById(document: MultiWorkerDocument, runId: string): OrchestrationRun {
  return requiredRun(document, runId);
}

function requiredWorker(document: MultiWorkerDocument, workerId: string): Worker {
  const worker = document.workers.find((entry) => entry.id === workerId);
  if (worker === undefined) throw new RuntimeError('INVALID_REQUEST', 'Worker was not found');
  return worker;
}

function requiredTask(document: MultiWorkerDocument, taskId: string): WorkerTask {
  const task = document.tasks.find((entry) => entry.id === taskId);
  if (task === undefined) throw new RuntimeError('INVALID_REQUEST', 'Worker task was not found');
  return task;
}

function requiredAssignment(document: MultiWorkerDocument, assignmentId: string): WorkerAssignment {
  const assignment = document.assignments.find((entry) => entry.id === assignmentId);
  if (assignment === undefined) throw new RuntimeError('INVALID_REQUEST', 'Worker assignment was not found');
  return assignment;
}

function touchRun(
  run: OrchestrationRun,
  now: string,
  changes: Partial<Pick<OrchestrationRun, 'state' | 'taskIds' | 'workerIds' | 'assignmentIds' | 'resultIds'>>,
): OrchestrationRun {
  return { ...run, ...changes, revision: run.revision + 1, updatedAt: now };
}

function replaceById<T extends { readonly id: string }>(items: readonly T[], replacement: T): T[] {
  return items.map((entry) => entry.id === replacement.id ? replacement : entry);
}

function requireGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RuntimeError('INVALID_REQUEST', 'expectedGeneration must be a non-negative integer');
  return value;
}

function requireUuid(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new RuntimeError('INVALID_REQUEST', `${name} must be a UUID`);
  }
  return normalized;
}

function bounded(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max || normalized.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', `${name} is invalid`);
  }
  return normalized;
}

function boundedIds(values: readonly string[], name: string): readonly string[] {
  if (!Array.isArray(values) || values.length > 128) throw new RuntimeError('INVALID_REQUEST', `${name} exceeds its bounded limit`);
  const normalized = values.map((value, index) => requireUuid(value, `${name}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new RuntimeError('INVALID_REQUEST', `${name} contains duplicates`);
  return normalized;
}

function canonicalTimestamp(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new RuntimeError('INVALID_REQUEST', `${name} is not a timestamp`);
  const canonical = new Date(value).toISOString();
  if (canonical !== value) throw new RuntimeError('INVALID_REQUEST', `${name} must be canonical UTC ISO-8601`);
  return canonical;
}
