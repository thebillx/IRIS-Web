import { RuntimeError } from '@iris/domain';
import type { MissionEvidence } from '@iris/domain';
import type { RuntimeState } from './state.js';
import { DurableMissionLifecycleStore, type DurableMissionLifecycleDocument } from './durable-mission-store.js';
import type {
  AppendMissionEvidenceInput,
  CancelMissionInput,
  CheckpointMissionInput,
  CompleteMissionInput,
  DirectiveMissionInput,
  DurableMissionCheckpoint,
  DurableMissionLifecycleSnapshot,
  DurableMissionLifecycleState,
  ResumeMissionInput,
  StartMissionInput,
  WorkerBinding,
} from './durable-mission-lifecycle.js';
import {
  WorkerAdapterRegistry,
  normalizeWorkerCheckpointReceipt,
  normalizeWorkerStartReceipt,
} from './durable-mission-workers.js';
import {
  assertExpectedRevision,
  boundedText,
  boundedTextList,
  ensureNoPendingOperation,
  normalizeEvidence,
  operationByRequest,
  positiveRevision,
  requireWorkerBinding,
  resolveDuplicateOperation,
  uuid,
  validateLifecycleRecord,
} from './durable-mission-validation.js';
import {
  beginLifecycleOperation,
  bindWorker,
  finishLifecycleOperation,
  replaceLifecycleRecord,
  touchWorker,
} from './durable-mission-operations.js';

const MAX_RECORDS = 100;
const MAX_CHECKPOINTS = 200;
const MAX_DIRECTIVES = 200;
const MAX_EVIDENCE = 400;
const MAX_OPERATIONS = 400;

type WorkerOperationResult = {
  readonly state: DurableMissionLifecycleState;
  readonly workerBinding: WorkerBinding | null;
  readonly directiveId?: string;
};

export class DurableMissionLifecycleService {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly state: RuntimeState,
    private readonly store: DurableMissionLifecycleStore,
    private readonly workers: WorkerAdapterRegistry = new WorkerAdapterRegistry(),
  ) {}

  public async list(): Promise<readonly DurableMissionLifecycleSnapshot[]> {
    const records: DurableMissionLifecycleSnapshot[] = [];
    for (const candidate of (await this.store.read()).records) {
      const record = validateLifecycleRecord(candidate);
      await this.assertProjectBinding(record);
      records.push(record);
    }
    return records;
  }

  public async get(missionIdInput: string): Promise<DurableMissionLifecycleSnapshot> {
    const missionId = uuid(missionIdInput, 'missionId');
    const candidate = (await this.store.read()).records.find((record) => record.missionId === missionId);
    if (candidate === undefined) throw new RuntimeError('MISSION_NOT_FOUND', 'Durable mission lifecycle record was not found');
    const record = validateLifecycleRecord(candidate);
    await this.assertProjectBinding(record);
    return record;
  }

  public ensureMission(missionIdInput: string, goalInput?: string): Promise<DurableMissionLifecycleSnapshot> {
    const missionId = uuid(missionIdInput, 'missionId');
    return this.serialize(async () => {
      const document = await this.store.read();
      const existing = document.records.find((candidate) => candidate.missionId === missionId);
      if (existing !== undefined) {
        const record = validateLifecycleRecord(existing);
        await this.assertProjectBinding(record);
        if (goalInput !== undefined && boundedText(goalInput, 'goal', 4_000) !== record.goal) {
          throw new RuntimeError('INVALID_REQUEST', 'Mission lifecycle goal is already bound to different content');
        }
        return record;
      }
      if (document.records.length >= MAX_RECORDS) throw new RuntimeError('CAPABILITY_DENIED', 'Durable mission lifecycle capacity has been reached');
      const mission = await this.state.getMission(missionId);
      if (mission.projectId === null) throw new RuntimeError('CAPABILITY_DENIED', 'Durable mission lifecycle requires an explicit registered project');
      await this.assertRegisteredProject(mission.projectId);
      const now = new Date().toISOString();
      const record: DurableMissionLifecycleSnapshot = validateLifecycleRecord({
        missionId: mission.id,
        projectId: mission.projectId,
        title: mission.title,
        goal: goalInput === undefined ? mission.title : boundedText(goalInput, 'goal', 4_000),
        state: 'CREATED',
        revision: 1,
        workerBinding: null,
        checkpoints: [],
        directives: [],
        evidence: [],
        operations: [],
        createdAt: now,
        updatedAt: now,
      });
      await this.store.write({ schemaVersion: 1, records: [...document.records, record] });
      return record;
    });
  }

  public async assertSessionControl(missionIdInput: string, clientId: string, sessionId: string): Promise<DurableMissionLifecycleSnapshot> {
    const record = await this.get(missionIdInput);
    const mission = await this.state.getMission(record.missionId);
    if (mission.clientId !== clientId || mission.sessionId !== sessionId) {
      throw new RuntimeError('CONTROL_DENIED', 'Mission lifecycle does not belong to this client/session identity');
    }
    const session = this.state.getSessionForClient(sessionId, clientId);
    if (session.currentProjectId !== record.projectId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Mission lifecycle project does not match the live session project');
    }
    return record;
  }

  public start(input: StartMissionInput): Promise<DurableMissionLifecycleSnapshot> {
    const missionId = uuid(input.missionId, 'missionId');
    const expectedRevision = positiveRevision(input.expectedRevision, 'expectedRevision');
    const requestId = uuid(input.requestId, 'requestId');
    const workerType = boundedText(input.workerType, 'workerType', 200);
    return this.workerOperation(missionId, expectedRevision, requestId, 'START', 'RESUMING',
      (record) => {
        if (record.state !== 'CREATED') throw new RuntimeError('INVALID_REQUEST', `Mission cannot start from state ${record.state}`);
      },
      async (pending) => ({
        state: 'RUNNING',
        workerBinding: bindWorker(workerType, normalizeWorkerStartReceipt(await this.workers.get(workerType).start({
          operationId: requestId, missionId: pending.missionId, projectId: pending.projectId, goal: pending.goal,
        })), pending),
      }));
  }

  public checkpoint(input: CheckpointMissionInput): Promise<DurableMissionLifecycleSnapshot> {
    const missionId = uuid(input.missionId, 'missionId');
    const expectedRevision = positiveRevision(input.expectedRevision, 'expectedRevision');
    const checkpointId = uuid(input.checkpointId, 'checkpointId');
    const summary = boundedText(input.summary, 'summary', 2_000);
    const evidenceRefs = boundedTextList(input.evidenceRefs, 'evidenceRefs');
    return this.serialize(async () => {
      let document = await this.store.read();
      let record = await this.recordFrom(document, missionId);
      const duplicate = record.checkpoints.find((item) => item.checkpointId === checkpointId);
      if (duplicate !== undefined) {
        if (duplicate.summary === summary && JSON.stringify(duplicate.evidenceRefs) === JSON.stringify(evidenceRefs)) return record;
        throw new RuntimeError('INVALID_REQUEST', 'checkpointId is already bound to different content');
      }
      ensureNoPendingOperation(record);
      assertExpectedRevision(record, expectedRevision);
      if (record.state !== 'RUNNING') throw new RuntimeError('INVALID_REQUEST', `Mission cannot checkpoint from state ${record.state}`);
      if (record.checkpoints.length >= MAX_CHECKPOINTS) throw new RuntimeError('CAPABILITY_DENIED', 'Mission checkpoint capacity has been reached');
      const binding = requireWorkerBinding(record);
      record = beginLifecycleOperation(record, checkpointId, 'CHECKPOINT', 'VALIDATING');
      document = replaceLifecycleRecord(document, record);
      await this.store.write(document);
      try {
        const receipt = normalizeWorkerCheckpointReceipt(await this.workers.get(binding.workerType).checkpoint({
          operationId: checkpointId, missionId: record.missionId, projectId: record.projectId, binding,
        }));
        const now = new Date().toISOString();
        const nextRevision = record.revision + 1;
        const checkpoint: DurableMissionCheckpoint = {
          checkpointId,
          missionId: record.missionId,
          projectId: record.projectId,
          sequence: record.checkpoints.length + 1,
          revision: nextRevision,
          workerStateRef: receipt.workerStateRef,
          summary,
          evidenceRefs,
          createdAt: now,
          resumeMetadata: receipt.resumeMetadata,
        };
        const next = finishLifecycleOperation(validateLifecycleRecord({
          ...record,
          state: 'WAITING_FOR_SUPERVISOR',
          revision: nextRevision,
          workerBinding: touchWorker(binding),
          checkpoints: [...record.checkpoints, checkpoint],
          updatedAt: now,
        }), checkpointId, 'SUCCEEDED');
        await this.store.write(replaceLifecycleRecord(document, next));
        return next;
      } catch (error) {
        const failed = finishLifecycleOperation(validateLifecycleRecord({
          ...record, state: 'FAILED', revision: record.revision + 1, updatedAt: new Date().toISOString(),
        }), checkpointId, 'FAILED');
        await this.store.write(replaceLifecycleRecord(document, failed));
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Worker checkpoint failed', { cause: error });
      }
    });
  }

  public acceptDirective(input: DirectiveMissionInput): Promise<DurableMissionLifecycleSnapshot> {
    const missionId = uuid(input.missionId, 'missionId');
    const basedOnRevision = positiveRevision(input.basedOnRevision, 'basedOnRevision');
    const directiveId = uuid(input.directiveId, 'directiveId');
    const directive = boundedText(input.directive, 'directive', 4_000);
    return this.serialize(async () => {
      const document = await this.store.read();
      const record = await this.recordFrom(document, missionId);
      const duplicate = record.directives.find((item) => item.directiveId === directiveId);
      if (duplicate !== undefined) {
        if (duplicate.basedOnRevision === basedOnRevision && duplicate.directive === directive) return record;
        throw new RuntimeError('INVALID_REQUEST', 'directiveId is already bound to different content');
      }
      ensureNoPendingOperation(record);
      assertExpectedRevision(record, basedOnRevision);
      if (record.state !== 'WAITING_FOR_SUPERVISOR' && record.state !== 'CHECKPOINTED') {
        throw new RuntimeError('INVALID_REQUEST', `Mission cannot accept a directive from state ${record.state}`);
      }
      if (record.directives.length >= MAX_DIRECTIVES) throw new RuntimeError('CAPABILITY_DENIED', 'Mission directive capacity has been reached');
      const now = new Date().toISOString();
      const next = validateLifecycleRecord({
        ...record,
        revision: record.revision + 1,
        directives: [...record.directives, {
          directiveId, missionId: record.missionId, projectId: record.projectId, basedOnRevision,
          directive, createdAt: now, appliedAt: null, status: 'ACCEPTED' as const,
        }],
        updatedAt: now,
      });
      await this.store.write(replaceLifecycleRecord(document, next));
      return next;
    });
  }

  public resume(input: ResumeMissionInput): Promise<DurableMissionLifecycleSnapshot> {
    const missionId = uuid(input.missionId, 'missionId');
    const expectedRevision = positiveRevision(input.expectedRevision, 'expectedRevision');
    const requestId = uuid(input.requestId, 'requestId');
    return this.workerOperation(missionId, expectedRevision, requestId, 'RESUME', 'RESUMING',
      (record) => {
        if (record.state !== 'WAITING_FOR_SUPERVISOR' && record.state !== 'CHECKPOINTED') {
          throw new RuntimeError('INVALID_REQUEST', `Mission cannot resume from state ${record.state}`);
        }
        if (record.checkpoints.length === 0 || !record.directives.some((item) => item.status === 'ACCEPTED')) {
          throw new RuntimeError('INVALID_REQUEST', 'Mission resume requires a durable checkpoint and unapplied directive');
        }
      },
      async (pending, original) => {
        const binding = requireWorkerBinding(original);
        const checkpoint = original.checkpoints.at(-1)!;
        const directive = [...original.directives].reverse().find((item) => item.status === 'ACCEPTED')!;
        const receipt = normalizeWorkerStartReceipt(await this.workers.get(binding.workerType).resume({
          operationId: requestId, missionId: original.missionId, projectId: original.projectId, binding, checkpoint, directive,
        }));
        return {
          state: 'RUNNING',
          workerBinding: bindWorker(binding.workerType, receipt, pending, binding.createdAt),
          directiveId: directive.directiveId,
        };
      });
  }

  public cancel(input: CancelMissionInput): Promise<DurableMissionLifecycleSnapshot> {
    const missionId = uuid(input.missionId, 'missionId');
    const expectedRevision = positiveRevision(input.expectedRevision, 'expectedRevision');
    const requestId = uuid(input.requestId, 'requestId');
    return this.workerOperation(missionId, expectedRevision, requestId, 'CANCEL', 'RESUMING',
      (record) => {
        if (record.state === 'COMPLETED') throw new RuntimeError('INVALID_REQUEST', 'Completed mission cannot be cancelled');
      },
      async (_pending, original) => {
        const binding = original.workerBinding;
        if (binding !== null) await this.workers.get(binding.workerType).cancel({
          operationId: requestId, missionId: original.missionId, projectId: original.projectId, binding,
        });
        return { state: 'CANCELLED', workerBinding: binding === null ? null : { ...touchWorker(binding), resumable: false } };
      });
  }

  public complete(input: CompleteMissionInput): Promise<DurableMissionLifecycleSnapshot> {
    const missionId = uuid(input.missionId, 'missionId');
    const expectedRevision = positiveRevision(input.expectedRevision, 'expectedRevision');
    const requestId = uuid(input.requestId, 'requestId');
    return this.serialize(async () => {
      const document = await this.store.read();
      const record = await this.recordFrom(document, missionId);
      const duplicate = operationByRequest(record, requestId, 'COMPLETE');
      if (duplicate !== null) return resolveDuplicateOperation(record, duplicate);
      ensureNoPendingOperation(record);
      assertExpectedRevision(record, expectedRevision);
      if (record.state !== 'RUNNING' && record.state !== 'WAITING_FOR_SUPERVISOR' && record.state !== 'CHECKPOINTED') {
        throw new RuntimeError('INVALID_REQUEST', `Mission cannot complete from state ${record.state}`);
      }
      if (record.operations.length >= MAX_OPERATIONS) throw new RuntimeError('CAPABILITY_DENIED', 'Mission lifecycle operation capacity has been reached');
      const now = new Date().toISOString();
      const resultRevision = record.revision + 1;
      const next = validateLifecycleRecord({
        ...record,
        state: 'COMPLETED',
        revision: resultRevision,
        workerBinding: record.workerBinding === null ? null : { ...touchWorker(record.workerBinding), resumable: false },
        operations: [...record.operations, {
          requestId, kind: 'COMPLETE' as const, basedOnRevision: expectedRevision, resultRevision,
          status: 'SUCCEEDED' as const, createdAt: now, completedAt: now,
        }],
        updatedAt: now,
      });
      await this.store.write(replaceLifecycleRecord(document, next));
      return next;
    });
  }

  public appendEvidence(input: AppendMissionEvidenceInput): Promise<DurableMissionLifecycleSnapshot> {
    const missionId = uuid(input.missionId, 'missionId');
    const expectedRevision = positiveRevision(input.expectedRevision, 'expectedRevision');
    const evidence = normalizeEvidence(input.evidence);
    return this.serialize(async () => {
      const document = await this.store.read();
      const record = await this.recordFrom(document, missionId);
      const duplicate = record.evidence.find((item) => item.id === evidence.id);
      if (duplicate !== undefined) {
        if (JSON.stringify(duplicate) === JSON.stringify(evidence)) return record;
        throw new RuntimeError('INVALID_REQUEST', 'Evidence id is already bound to different content');
      }
      ensureNoPendingOperation(record);
      assertExpectedRevision(record, expectedRevision);
      if (record.evidence.length >= MAX_EVIDENCE) throw new RuntimeError('CAPABILITY_DENIED', 'Mission evidence capacity has been reached');
      const next = validateLifecycleRecord({
        ...record, revision: record.revision + 1, evidence: [...record.evidence, evidence], updatedAt: new Date().toISOString(),
      });
      await this.store.write(replaceLifecycleRecord(document, next));
      return next;
    });
  }

  private workerOperation(
    missionId: string,
    expectedRevision: number,
    requestId: string,
    kind: 'START' | 'RESUME' | 'CANCEL',
    pendingState: DurableMissionLifecycleState,
    assertEligible: (record: DurableMissionLifecycleSnapshot) => void,
    execute: (pending: DurableMissionLifecycleSnapshot, original: DurableMissionLifecycleSnapshot) => Promise<WorkerOperationResult>,
  ): Promise<DurableMissionLifecycleSnapshot> {
    return this.serialize(async () => {
      let document = await this.store.read();
      const original = await this.recordFrom(document, missionId);
      const duplicate = operationByRequest(original, requestId, kind);
      if (duplicate !== null) return resolveDuplicateOperation(original, duplicate);
      ensureNoPendingOperation(original);
      assertExpectedRevision(original, expectedRevision);
      assertEligible(original);
      let record = beginLifecycleOperation(original, requestId, kind, pendingState);
      document = replaceLifecycleRecord(document, record);
      await this.store.write(document);
      try {
        const result = await execute(record, original);
        const now = new Date().toISOString();
        const directives = result.directiveId === undefined ? record.directives : record.directives.map((item) => item.directiveId === result.directiveId
          ? { ...item, status: 'APPLIED' as const, appliedAt: now } : item);
        record = finishLifecycleOperation(validateLifecycleRecord({
          ...record,
          state: result.state,
          revision: record.revision + 1,
          workerBinding: result.workerBinding,
          directives,
          updatedAt: now,
        }), requestId, 'SUCCEEDED');
        await this.store.write(replaceLifecycleRecord(document, record));
        return record;
      } catch (error) {
        const failed = finishLifecycleOperation(validateLifecycleRecord({
          ...record, state: 'FAILED', revision: record.revision + 1, updatedAt: new Date().toISOString(),
        }), requestId, 'FAILED');
        await this.store.write(replaceLifecycleRecord(document, failed));
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError('AGENT_EXECUTION_FAILED', `Worker ${kind.toLowerCase()} failed`, { cause: error });
      }
    });
  }

  private async recordFrom(document: DurableMissionLifecycleDocument, missionId: string): Promise<DurableMissionLifecycleSnapshot> {
    const candidate = document.records.find((record) => record.missionId === missionId);
    if (candidate === undefined) throw new RuntimeError('MISSION_NOT_FOUND', 'Durable mission lifecycle record was not found');
    const record = validateLifecycleRecord(candidate);
    await this.assertProjectBinding(record);
    return record;
  }

  private async assertProjectBinding(record: DurableMissionLifecycleSnapshot): Promise<void> {
    const mission = await this.state.getMission(record.missionId);
    if (mission.projectId === null || mission.projectId !== record.projectId) {
      throw new RuntimeError('CONTROL_DENIED', 'Durable mission project binding no longer matches the authoritative mission');
    }
    await this.assertRegisteredProject(record.projectId);
  }

  private async assertRegisteredProject(projectId: string): Promise<void> {
    if (!(await this.state.listProjects()).some((project) => project.id === projectId)) {
      throw new RuntimeError('CONTROL_DENIED', 'Durable mission project is no longer registered');
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function missionEvidenceInput(value: MissionEvidence): MissionEvidence { return normalizeEvidence(value); }
