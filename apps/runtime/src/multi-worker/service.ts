import { randomUUID } from 'node:crypto';
import {
  RuntimeError,
  type ArtifactId,
  type CapabilityId,
  type OrchestrationRun,
  type Worker,
  type WorkerAssignment,
  type WorkerExecutionAssociation,
  type WorkerResult,
  type WorkerReview,
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
import type { WorkerBinding, WorkerStartReceipt } from '../durable-mission-lifecycle.js';
import {
  authorizeWorkerCapability,
  deriveWorkerAuthorityDigest,
  resolveWorkerExecutionEnvelope,
  workerPathAllowed,
  type WorkerCapabilityRequest,
  type WorkerExecutionEnvelope,
} from './authority.js';
import type { MultiWorkerDocument } from './model.js';
import { projectMultiWorkerObservability, type MultiWorkerObservabilityTree } from './observability.js';
import { assertMutablePathOwnershipAvailable } from './path-ownership.js';
import { MultiWorkerStore } from './store.js';
import { validateMultiWorkerDocument, validateWorkerResult, validateWorkerReview, validateWorkerTaskAuthority } from './validation.js';

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

export interface RebindOrchestrationRunSessionInput {
  readonly expectedGeneration: number;
  readonly orchestrationRunId: string;
  readonly sessionId: string;
}

export interface RecordWorkerResultInput {
  readonly expectedGeneration: number;
  readonly orchestrationRunId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly status: WorkerResult['status'];
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly artifactIds: readonly string[];
  readonly filesRead: readonly string[];
  readonly filesChanged: readonly string[];
  readonly commandsExecuted: readonly string[];
  readonly validationResults: WorkerResult['validationResults'];
  readonly risks: readonly string[];
  readonly blockers: readonly string[];
  readonly recommendedNextActions: readonly string[];
}

export interface ReviewWorkerResultInput {
  readonly expectedGeneration: number;
  readonly orchestrationRunId: string;
  readonly resultId: string;
  readonly parentOrchestratorId: string;
  readonly basedOnRunRevision: number;
  readonly decision: WorkerReview['decision'];
  readonly instruction: string;
  readonly requestedEvidence: readonly string[];
}

export interface AuthorizeWorkerExecutionInput {
  readonly association: WorkerExecutionAssociation;
  readonly sessionId: string;
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly capabilityId: string;
  readonly runtimeFence: WorkerRuntimeFence;
  readonly request?: WorkerCapabilityRequest;
}

export interface MultiWorkerRunView {
  readonly generation: number;
  readonly run: OrchestrationRun;
  readonly workers: readonly Worker[];
  readonly tasks: readonly WorkerTask[];
  readonly assignments: readonly WorkerAssignment[];
  readonly results: readonly WorkerResult[];
  readonly reviews: readonly WorkerReview[];
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

  public async currentGeneration(): Promise<number> {
    return (await this.store.read()).generation;
  }

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

  public async listResults(orchestrationRunIdInput?: string): Promise<readonly WorkerResult[]> {
    const document = await this.store.read();
    if (orchestrationRunIdInput === undefined) return document.results;
    const orchestrationRunId = requireUuid(orchestrationRunIdInput, 'orchestrationRunId');
    requiredRun(document, orchestrationRunId);
    return document.results.filter((entry) => entry.orchestrationRunId === orchestrationRunId);
  }

  public async listReviews(orchestrationRunIdInput?: string): Promise<readonly WorkerReview[]> {
    const document = await this.store.read();
    if (orchestrationRunIdInput === undefined) return document.reviews;
    const orchestrationRunId = requireUuid(orchestrationRunIdInput, 'orchestrationRunId');
    requiredRun(document, orchestrationRunId);
    return document.reviews.filter((entry) => entry.orchestrationRunId === orchestrationRunId);
  }

  public async observabilityForMission(missionIdInput: string): Promise<MultiWorkerObservabilityTree | null> {
    const missionId = requireUuid(missionIdInput, 'missionId');
    const document = await this.store.read();
    const run = document.runs.find((entry) => entry.missionId === missionId);
    if (run === undefined) return null;
    return projectMultiWorkerObservability(document, run.id, this.now());
  }

  public async authorizeExecution(input: AuthorizeWorkerExecutionInput): Promise<WorkerExecutionEnvelope> {
    const document = await this.store.read();
    const task = requiredTask(document, input.association.workerTaskId);
    const run = requiredRun(document, task.orchestrationRunId);
    if (input.association.missionId !== run.missionId
      || input.association.orchestrationRunId !== run.id
      || input.association.assignmentId !== task.assignmentId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Worker execution association does not match durable run/task state');
    }
    const selectedWorkspaceId = input.workspaceId ?? String(task.authority.workspaceId);
    if (selectedWorkspaceId !== String(task.authority.workspaceId)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Worker execution workspace does not match immutable task authority');
    }
    await this.resources.getActiveWorkspace(run.projectId, task.authority.workspaceId);

    const envelope = resolveWorkerExecutionEnvelope(document, {
      missionId: input.association.missionId,
      taskId: input.association.workerTaskId,
      workerId: input.association.workerId,
      assignmentId: input.association.assignmentId,
      authorityDigest: input.association.authorityDigest,
    }, {
      sessionId: input.sessionId,
      projectId: input.projectId,
      workspaceId: selectedWorkspaceId,
      parentOrchestratorId: run.parentOrchestratorId,
      runtimeFence: input.runtimeFence,
      now: this.now(),
    });
    authorizeWorkerCapability(envelope, input.capabilityId, input.request);
    if (input.capabilityId === 'project.search' && !workerPathAllowed(envelope.allowedPaths, '**')) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Worker project.search requires whole-project read authority');
    }
    return envelope;
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

  public async getResult(resultIdInput: string): Promise<WorkerResult> {
    const resultId = requireUuid(resultIdInput, 'resultId');
    const result = (await this.store.read()).results.find((entry) => entry.id === resultId);
    if (result === undefined) throw new RuntimeError('INVALID_REQUEST', 'Worker result was not found');
    return result;
  }

  public async getReview(reviewIdInput: string): Promise<WorkerReview> {
    const reviewId = requireUuid(reviewIdInput, 'reviewId');
    const review = (await this.store.read()).reviews.find((entry) => entry.id === reviewId);
    if (review === undefined) throw new RuntimeError('INVALID_REQUEST', 'Worker review was not found');
    return review;
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

  public rebindRunSession(input: RebindOrchestrationRunSessionInput): Promise<MultiWorkerRunView> {
    const runId = requireUuid(input.orchestrationRunId, 'orchestrationRunId');
    const sessionId = requireUuid(input.sessionId, 'sessionId');
    return this.mutate(input.expectedGeneration, async (document) => {
      const run = requiredActiveRun(document, runId);
      if (run.sessionId === sessionId) return { document, value: (next: MultiWorkerDocument) => view(next, runById(next, run.id)) };
      const mission = await this.state.getMission(run.missionId);
      if (mission.sessionId !== sessionId || mission.projectId !== run.projectId) {
        throw new RuntimeError('CONTROL_DENIED', 'Multi-worker run rebind must match the authoritative mission binding');
      }
      const session = this.state.getSessionForClient(sessionId, mission.clientId);
      if (session.currentProjectId !== run.projectId || session.agentId !== run.parentOrchestratorId) {
        throw new RuntimeError('CONTROL_DENIED', 'Multi-worker run rebind session does not preserve project/orchestrator authority');
      }
      const runTasks = document.tasks.filter((entry) => entry.orchestrationRunId === run.id);
      if (runTasks.some((task) => task.authority.mutablePaths.length > 0 || task.authority.concurrencyPolicy.mutablePathOwnership !== 'READ_ONLY')) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Only read-only multi-worker runs may rebind session authority');
      }
      const now = this.now();
      const tasks = document.tasks.map((task) => task.orchestrationRunId === run.id
        ? { ...task, authority: { ...task.authority, sessionId }, updatedAt: now }
        : task);
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      const workerById = new Map(document.workers.map((worker) => [worker.id, worker]));
      const assignments = document.assignments.map((assignment) => {
        if (assignment.orchestrationRunId !== run.id) return assignment;
        const task = taskById.get(assignment.taskId);
        const worker = workerById.get(assignment.workerId);
        if (task === undefined || worker === undefined) throw new RuntimeError('PERSISTENCE_FAILURE', 'Multi-worker rebind assignment binding is invalid');
        return { ...assignment, authorityDigest: deriveWorkerAuthorityDigest(task, worker, assignment) };
      });
      const updatedRun = { ...run, sessionId, updatedAt: now, revision: run.revision + 1 };
      const candidate = validateMultiWorkerDocument({
        ...document,
        generation: document.generation,
        runs: replaceById(document.runs, updatedRun),
        tasks,
        assignments,
      });
      return {
        document: candidate,
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
      assertMutablePathOwnershipAvailable(document, task);
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
    const expectedGeneration = requireGeneration(input.expectedGeneration);
    const runId = requireUuid(input.orchestrationRunId, 'orchestrationRunId');
    const taskId = requireUuid(input.taskId, 'taskId');
    const requestId = requireUuid(input.requestId, 'requestId');

    const execute = async (): Promise<WorkerTask> => {
      const current = await this.store.read();
      if (current.generation !== expectedGeneration) {
        throw new RuntimeError('PRECONDITION_FAILED', 'Multi-worker orchestration generation is stale');
      }

      const run = requiredActiveRun(current, runId);
      const task = requiredTask(current, taskId);
      const assignment = task.assignmentId === null ? null : current.assignments.find((entry) => entry.id === task.assignmentId) ?? null;
      if (task.orchestrationRunId !== run.id || task.state !== 'ASSIGNED' || assignment === null || assignment.releasedAt !== null) {
        throw new RuntimeError('INVALID_REQUEST', 'Worker task is not ready to start');
      }
      const worker = requiredWorker(current, assignment.workerId);
      if (worker.state !== 'ASSIGNED' || worker.workerType !== 'IRIS_LOGICAL') {
        throw new RuntimeError('CAPABILITY_DENIED', 'M04 starts only the bounded IRIS_LOGICAL worker adapter');
      }
      if (!task.dependencyTaskIds.every((dependencyId) => requiredTask(current, dependencyId).state === 'SUCCEEDED')) {
        throw new RuntimeError('CONTROL_DENIED', 'Worker task dependencies are not complete');
      }

      const adapter = this.workers.get(worker.workerType);
      const startInput = {
        operationId: requestId,
        missionId: task.missionId,
        projectId: run.projectId,
        goal: task.title,
      };
      const planned = normalizeWorkerStartReceipt(adapter.planStart(startInput));
      const startingAt = this.now();
      const startingTask: WorkerTask = { ...task, state: 'STARTING', updatedAt: startingAt };
      const startingWorker: Worker = {
        ...worker,
        state: 'STARTING',
        adapterWorkerId: planned.workerId,
        resumeToken: planned.resumeToken,
        resumable: planned.resumable,
        updatedAt: startingAt,
      };
      const startingRun = touchRun(run, startingAt, { state: 'RUNNING' });
      const starting = validateMultiWorkerDocument({
        ...current,
        generation: current.generation + 1,
        runs: replaceById(current.runs, startingRun),
        workers: replaceById(current.workers, startingWorker),
        tasks: replaceById(current.tasks, startingTask),
      });
      await this.store.write(starting, current.generation);

      let receipt: WorkerStartReceipt;
      try {
        receipt = normalizeWorkerStartReceipt(await adapter.start(startInput));
      } catch (error) {
        throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Worker start failed after durable STARTING publication', { cause: error });
      }

      if (!sameWorkerStartReceipt(planned, receipt)) {
        const actualBinding: WorkerBinding = {
          workerType: worker.workerType,
          workerId: receipt.workerId,
          resumeToken: receipt.resumeToken,
          missionId: task.missionId,
          projectId: run.projectId,
          createdAt: worker.createdAt,
          lastSeenAt: startingAt,
          resumable: receipt.resumable,
        };
        await adapter.cancel({
          operationId: randomUUID(),
          missionId: task.missionId,
          projectId: run.projectId,
          binding: actualBinding,
        }).catch(() => undefined);
        throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Worker start receipt does not match the durable planned binding');
      }

      const latest = await this.store.read();
      if (latest.generation !== starting.generation) {
        throw new RuntimeError('PRECONDITION_FAILED', 'Multi-worker orchestration changed before worker start finalization');
      }
      const latestRun = requiredActiveRun(latest, runId);
      const latestTask = requiredTask(latest, taskId);
      const latestAssignment = latestTask.assignmentId === null
        ? null
        : latest.assignments.find((entry) => entry.id === latestTask.assignmentId) ?? null;
      const latestWorker = latestAssignment === null
        ? null
        : latest.workers.find((entry) => entry.id === latestAssignment.workerId) ?? null;
      if (latestTask.state !== 'STARTING'
        || latestAssignment === null
        || latestAssignment.releasedAt !== null
        || latestWorker === null
        || latestWorker.state !== 'STARTING'
        || latestWorker.adapterWorkerId === null) {
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Durable worker STARTING state changed before finalization');
      }
      const persisted: WorkerStartReceipt = {
        workerId: latestWorker.adapterWorkerId,
        resumeToken: latestWorker.resumeToken,
        resumable: latestWorker.resumable,
      };
      if (!sameWorkerStartReceipt(planned, persisted)) {
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Durable planned worker binding changed before finalization');
      }

      const runningAt = this.now();
      const runningTask: WorkerTask = { ...latestTask, state: 'RUNNING', updatedAt: runningAt };
      const runningWorker: Worker = { ...latestWorker, state: 'RUNNING', updatedAt: runningAt };
      const runningRun = touchRun(latestRun, runningAt, { state: 'RUNNING' });
      const running = validateMultiWorkerDocument({
        ...latest,
        generation: latest.generation + 1,
        runs: replaceById(latest.runs, runningRun),
        workers: replaceById(latest.workers, runningWorker),
        tasks: replaceById(latest.tasks, runningTask),
      });
      await this.store.write(running, latest.generation);
      return requiredTask(running, taskId);
    };

    const result = this.mutationTail.then(execute, execute);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
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

  public recordResult(input: RecordWorkerResultInput): Promise<WorkerResult> {
    const runId = requireUuid(input.orchestrationRunId, 'orchestrationRunId');
    const taskId = requireUuid(input.taskId, 'taskId');
    const workerId = requireUuid(input.workerId, 'workerId');
    return this.mutate(input.expectedGeneration, async (document) => {
      const run = requiredActiveRun(document, runId);
      const task = requiredTask(document, taskId);
      const worker = requiredWorker(document, workerId);
      if (task.orchestrationRunId !== run.id || worker.orchestrationRunId !== run.id) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Worker result does not belong to the selected orchestration run');
      }
      if (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(task.state)
        || input.status !== task.state
        || worker.state !== task.state
        || task.assignmentId === null) {
        throw new RuntimeError('INVALID_REQUEST', 'Worker result must match one terminal assigned task and worker state');
      }
      if (task.resultId !== null) throw new RuntimeError('INVALID_REQUEST', 'Worker task already has a result');
      const assignment = requiredAssignment(document, task.assignmentId);
      if (assignment.workerId !== worker.id || assignment.releasedAt === null) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Worker result assignment is not the released assignment for this task');
      }

      const now = this.now();
      const result = validateWorkerResult({
        id: randomUUID(),
        orchestrationRunId: run.id,
        taskId: task.id,
        workerId: worker.id,
        status: input.status,
        summary: input.summary,
        evidenceRefs: [...input.evidenceRefs],
        artifactIds: input.artifactIds.map((artifactId) => artifactId as ArtifactId),
        filesRead: [...input.filesRead],
        filesChanged: [...input.filesChanged],
        commandsExecuted: [...input.commandsExecuted],
        validationResults: input.validationResults.map((entry) => ({ ...entry })),
        risks: [...input.risks],
        blockers: [...input.blockers],
        recommendedNextActions: [...input.recommendedNextActions],
        createdAt: now,
      });

      if (result.filesRead.some((candidate) => !workerPathAllowed(task.authority.allowedPaths, candidate))) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Worker result claims a read path outside immutable task authority');
      }
      if (result.filesChanged.length > 0 && task.authority.concurrencyPolicy.mutablePathOwnership === 'READ_ONLY') {
        throw new RuntimeError('CAPABILITY_DENIED', 'Read-only worker result cannot claim changed files');
      }
      if (result.filesChanged.some((candidate) => !workerPathAllowed(task.authority.mutablePaths, candidate))) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Worker result claims a changed path outside immutable task authority');
      }
      if (result.artifactIds.length > task.authority.resourceBudget.maxArtifacts) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Worker result exceeds its artifact resource budget');
      }
      for (const artifactId of result.artifactIds) {
        const artifact = await this.resources.getArtifact(run.projectId, artifactId);
        if (artifact.workspaceId !== task.authority.workspaceId) {
          throw new RuntimeError('CAPABILITY_DENIED', 'Worker result artifact does not belong to the task workspace');
        }
      }

      const updatedTask: WorkerTask = { ...task, resultId: result.id, updatedAt: now };
      const updatedRun = touchRun(run, now, { resultIds: [...run.resultIds, result.id] });
      return {
        document: {
          ...document,
          runs: replaceById(document.runs, updatedRun),
          tasks: replaceById(document.tasks, updatedTask),
          results: [...document.results, result],
        },
        value: (next: MultiWorkerDocument) => requiredResult(next, result.id),
      };
    });
  }

  public reviewResult(input: ReviewWorkerResultInput): Promise<WorkerReview> {
    const runId = requireUuid(input.orchestrationRunId, 'orchestrationRunId');
    const resultId = requireUuid(input.resultId, 'resultId');
    const parentOrchestratorId = bounded(input.parentOrchestratorId, 'parentOrchestratorId', 200);
    if (!Number.isSafeInteger(input.basedOnRunRevision) || input.basedOnRunRevision <= 0) {
      throw new RuntimeError('INVALID_REQUEST', 'basedOnRunRevision must be a positive integer');
    }
    return this.mutate(input.expectedGeneration, async (document) => {
      const run = requiredActiveRun(document, runId);
      if (run.parentOrchestratorId !== parentOrchestratorId) {
        throw new RuntimeError('CONTROL_DENIED', 'Worker result review is not owned by the parent Orchestrator');
      }
      if (run.revision !== input.basedOnRunRevision) {
        throw new RuntimeError('PRECONDITION_FAILED', 'Worker result review is based on a stale orchestration run revision');
      }
      const result = requiredResult(document, resultId);
      if (result.orchestrationRunId !== run.id) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Worker result does not belong to the selected orchestration run');
      }
      if (document.reviews.some((entry) => entry.resultId === result.id)) {
        throw new RuntimeError('INVALID_REQUEST', 'Worker result already has an Orchestrator review');
      }
      const task = requiredTask(document, result.taskId);
      const worker = requiredWorker(document, result.workerId);
      if (task.resultId !== result.id
        || task.orchestrationRunId !== run.id
        || worker.orchestrationRunId !== run.id
        || !['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(task.state)) {
        throw new RuntimeError('CONTROL_DENIED', 'Worker result review target is not a terminal bound task/result');
      }
      if (input.decision === 'ACCEPT' && result.status !== 'SUCCEEDED') {
        throw new RuntimeError('INVALID_REQUEST', 'Only a successful worker result can be accepted');
      }

      const now = this.now();
      const review = validateWorkerReview({
        id: randomUUID(),
        orchestrationRunId: run.id,
        taskId: task.id,
        workerId: worker.id,
        resultId: result.id,
        decision: input.decision,
        instruction: input.instruction,
        requestedEvidence: [...input.requestedEvidence],
        reviewedByOrchestratorId: run.parentOrchestratorId,
        basedOnRunRevision: run.revision,
        createdAt: now,
      });
      const reviews = [...document.reviews, review];
      const runTasks = document.tasks.filter((entry) => entry.orchestrationRunId === run.id);
      const allAccepted = runTasks.length > 0 && runTasks.every((entry) =>
        entry.state === 'SUCCEEDED'
        && entry.resultId !== null
        && reviews.some((candidate) => candidate.resultId === entry.resultId && candidate.decision === 'ACCEPT'));
      const nextState: OrchestrationRun['state'] = input.decision === 'ACCEPT'
        ? (allAccepted ? 'SUCCEEDED' : 'REVIEWING')
        : 'WAITING';
      const updatedRun = touchRun(run, now, { state: nextState });
      return {
        document: {
          ...document,
          runs: replaceById(document.runs, updatedRun),
          reviews,
        },
        value: (next: MultiWorkerDocument) => requiredReview(next, review.id),
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
    results: document.results.filter((entry) => entry.orchestrationRunId === run.id),
    reviews: document.reviews.filter((entry) => entry.orchestrationRunId === run.id),
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

function requiredResult(document: MultiWorkerDocument, resultId: string): WorkerResult {
  const result = document.results.find((entry) => entry.id === resultId);
  if (result === undefined) throw new RuntimeError('INVALID_REQUEST', 'Worker result was not found');
  return result;
}

function requiredReview(document: MultiWorkerDocument, reviewId: string): WorkerReview {
  const review = document.reviews.find((entry) => entry.id === reviewId);
  if (review === undefined) throw new RuntimeError('INVALID_REQUEST', 'Worker review was not found');
  return review;
}

function touchRun(
  run: OrchestrationRun,
  now: string,
  changes: Partial<Pick<OrchestrationRun, 'state' | 'taskIds' | 'workerIds' | 'assignmentIds' | 'resultIds'>>,
): OrchestrationRun {
  return { ...run, ...changes, revision: run.revision + 1, updatedAt: now };
}

function sameWorkerStartReceipt(left: WorkerStartReceipt, right: WorkerStartReceipt): boolean {
  return left.workerId === right.workerId
    && left.resumeToken === right.resumeToken
    && left.resumable === right.resumable;
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
