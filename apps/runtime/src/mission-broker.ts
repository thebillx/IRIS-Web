import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  RuntimeError,
  type MissionBrokerSnapshot,
  type MissionBrokerState,
  type MissionCheckpoint,
  type OrchestratorMode,
  type SupervisorDecision,
  type SupervisorDirective,
} from '@iris/domain';
import { inspectPrivateRegularFile } from './private-fs.js';
import type { RuntimeState } from './state.js';

const BROKER_FILE = 'mission-broker.json';
const MAX_RECORDS = 100;
const MAX_CHECKPOINTS = 100;
const MAX_DIRECTIVES = 100;
const MAX_LIST_ITEMS = 24;

interface MissionBrokerDocument {
  readonly schemaVersion: 1;
  readonly records: readonly MissionBrokerSnapshot[];
}

export interface BindHermesSessionInput {
  readonly missionId: string;
  readonly hermesSessionId: string;
  readonly worktreePath: string;
  readonly branch: string;
}

export interface RebindHermesSessionInput extends BindHermesSessionInput {
  readonly expectedVersion: number;
}

export interface OrchestratorHandoffInput {
  readonly missionId: string;
  readonly targetMode: OrchestratorMode;
  readonly expectedVersion: number;
  readonly handoffId: string;
}

export interface SupervisorDirectiveInput {
  readonly missionId: string;
  readonly expectedVersion: number;
  readonly directiveId: string;
  readonly directiveSequence: number;
  readonly decision: SupervisorDecision;
  readonly instruction: string;
  readonly authorizedScope: readonly string[];
  readonly doNot: readonly string[];
  readonly successCriteria: readonly string[];
}

export class MissionBrokerStore {
  public constructor(private readonly dataRoot: string) {}

  public async read(): Promise<MissionBrokerDocument> {
    const inspected = await inspectPrivateRegularFile(path.join(this.dataRoot, BROKER_FILE), 'Mission broker state');
    if (inspected.state === 'missing') return { schemaVersion: 1, records: [] };
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      const parsed = JSON.parse(inspected.content) as unknown;
      if (!isDocument(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Mission broker state is invalid');
      return parsed;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Mission broker state is invalid JSON', { cause: error });
    }
  }

  public async write(document: MissionBrokerDocument): Promise<void> {
    if (!isDocument(document)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to write invalid mission broker state');
    await writeJsonAtomic(path.join(this.dataRoot, BROKER_FILE), document);
  }
}

export class MissionBrokerService {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly state: RuntimeState,
    private readonly store: MissionBrokerStore,
  ) {}

  public async list(): Promise<readonly MissionBrokerSnapshot[]> {
    return (await this.store.read()).records;
  }

  public async listWaitingSupervisor(): Promise<readonly MissionBrokerSnapshot[]> {
    return (await this.list()).filter((record) => record.state === 'AWAITING_SUPERVISOR');
  }

  public async get(missionIdInput: string): Promise<MissionBrokerSnapshot> {
    const missionId = uuid(missionIdInput, 'missionId');
    const record = (await this.store.read()).records.find((candidate) => candidate.missionId === missionId);
    if (record === undefined) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission broker mapping was not found');
    return record;
  }

  public async orchestratorHandoffStatus(missionIdInput: string): Promise<{ safe: boolean; reason: string }> {
    const mission = await this.state.getMission(missionIdInput);
    const record = (await this.list()).find((candidate) => candidate.missionId === mission.id) ?? null;
    return this.state.missionHandoffSafety(mission, brokerHandoffSafe(mission.orchestratorMode, mission.state, record));
  }

  public async changeOrchestrator(input: OrchestratorHandoffInput) {
    const missionId = uuid(input.missionId, 'missionId');
    const targetMode = orchestratorMode(input.targetMode);
    const expectedVersion = version(input.expectedVersion, 'expectedVersion');
    const handoffId = uuid(input.handoffId, 'handoffId');
    return this.serializeBrokerAccess(async (document) => {
      const mission = await this.state.getMission(missionId);
      const record = document.records.find((candidate) => candidate.missionId === mission.id) ?? null;
      return this.state.changeMissionOrchestrator(
        mission.id,
        targetMode,
        expectedVersion,
        handoffId,
        brokerHandoffSafe(mission.orchestratorMode, mission.state, record),
      );
    });
  }

  public bindHermesSession(input: BindHermesSessionInput): Promise<MissionBrokerSnapshot> {
    const normalized = normalizeBinding(input);
    return this.mutate(async (document) => {
      const mission = await this.state.getMission(normalized.missionId);
      if (mission.orchestratorMode !== 'HERMES') throw new RuntimeError('CAPABILITY_DENIED', 'Hermes session binding requires HERMES orchestrator mode');
      const existing = document.records.find((record) => record.missionId === normalized.missionId);
      if (existing !== undefined) {
        if (sameBinding(existing, normalized)) return { document, result: existing };
        throw new RuntimeError('INVALID_REQUEST', 'Mission already has a Hermes session mapping; use an explicit rebind transition');
      }
      if (document.records.length >= MAX_RECORDS) throw new RuntimeError('CAPABILITY_DENIED', 'Mission broker capacity has been reached');
      const now = new Date().toISOString();
      const record: MissionBrokerSnapshot = {
        ...normalized,
        missionVersion: 1,
        state: 'ACTIVE',
        lastCheckpointId: null,
        lastDirectiveId: null,
        lastDirectiveSequence: 0,
        checkpoints: [],
        directives: [],
        updatedAt: now,
      };
      return { document: { schemaVersion: 1, records: [...document.records, record] }, result: record };
    });
  }

  public rebindHermesSession(input: RebindHermesSessionInput): Promise<MissionBrokerSnapshot> {
    const normalized = normalizeBinding(input);
    const expectedVersion = version(input.expectedVersion, 'expectedVersion');
    return this.update(normalized.missionId, (record) => {
      if (record.missionVersion !== expectedVersion) throw new RuntimeError('INVALID_REQUEST', 'Mission version does not match for Hermes session transition');
      if (record.state === 'COMPLETED') throw new RuntimeError('INVALID_REQUEST', 'Completed mission cannot change Hermes session mapping');
      return {
        ...record,
        ...normalized,
        missionVersion: record.missionVersion + 1,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  public recordCheckpoint(checkpointInput: MissionCheckpoint): Promise<MissionBrokerSnapshot> {
    const checkpoint = normalizeCheckpoint(checkpointInput);
    return this.update(checkpoint.missionId, (record) => {
      const duplicate = record.checkpoints.find((candidate) => candidate.checkpointId === checkpoint.checkpointId);
      if (duplicate !== undefined) {
        if (stableJson(duplicate) === stableJson(checkpoint)) return record;
        throw new RuntimeError('INVALID_REQUEST', 'checkpointId is already bound to different checkpoint content');
      }
      if (record.state === 'COMPLETED') throw new RuntimeError('INVALID_REQUEST', 'Completed mission cannot accept a new checkpoint');
      if (record.missionVersion !== checkpoint.missionVersion) throw new RuntimeError('INVALID_REQUEST', 'Checkpoint missionVersion is stale');
      if (record.checkpoints.length >= MAX_CHECKPOINTS) throw new RuntimeError('CAPABILITY_DENIED', 'Mission checkpoint capacity has been reached');
      return {
        ...record,
        state: 'AWAITING_SUPERVISOR',
        lastCheckpointId: checkpoint.checkpointId,
        checkpoints: [...record.checkpoints, checkpoint],
        updatedAt: new Date().toISOString(),
      };
    });
  }

  public acceptDirective(input: SupervisorDirectiveInput): Promise<MissionBrokerSnapshot> {
    const normalized = normalizeDirectiveInput(input);
    return this.update(normalized.missionId, (record) => {
      const duplicateById = record.directives.find((directive) => directive.directiveId === normalized.directiveId);
      if (duplicateById !== undefined) {
        if (sameDirectiveInput(duplicateById, normalized)) return record;
        throw new RuntimeError('INVALID_REQUEST', 'directiveId is already bound to different directive content');
      }
      const duplicateSequence = record.directives.find((directive) => directive.directiveSequence === normalized.directiveSequence);
      if (duplicateSequence !== undefined) throw new RuntimeError('INVALID_REQUEST', 'directiveSequence is already bound to another directive');
      if (record.state === 'COMPLETED') throw new RuntimeError('INVALID_REQUEST', 'Completed mission cannot accept a new directive');
      if (record.missionVersion !== normalized.expectedVersion) throw new RuntimeError('INVALID_REQUEST', 'Supervisor directive expectedVersion is stale');
      if (normalized.directiveSequence !== record.lastDirectiveSequence + 1) throw new RuntimeError('INVALID_REQUEST', 'Supervisor directive sequence is out of order');
      if (record.directives.length >= MAX_DIRECTIVES) throw new RuntimeError('CAPABILITY_DENIED', 'Mission directive capacity has been reached');
      const accepted: SupervisorDirective = { ...normalized, acceptedAt: new Date().toISOString() };
      return {
        ...record,
        missionVersion: record.missionVersion + 1,
        state: accepted.decision === 'PAUSE' ? 'AWAITING_SUPERVISOR' : 'ACTIVE',
        lastDirectiveId: accepted.directiveId,
        lastDirectiveSequence: accepted.directiveSequence,
        directives: [...record.directives, accepted],
        updatedAt: accepted.acceptedAt,
      };
    });
  }

  public markCompleted(missionIdInput: string, hermesSessionIdInput: string, expectedVersionInput: number): Promise<MissionBrokerSnapshot> {
    const missionId = uuid(missionIdInput, 'missionId');
    const hermesSessionId = identity(hermesSessionIdInput, 'hermesSessionId');
    const expectedVersion = version(expectedVersionInput, 'expectedVersion');
    return this.update(missionId, (record) => {
      if (record.state === 'COMPLETED') return record;
      if (record.missionVersion !== expectedVersion) throw new RuntimeError('INVALID_REQUEST', 'Mission version does not match completion transition');
      if (record.hermesSessionId !== hermesSessionId) throw new RuntimeError('CONTROL_DENIED', 'Hermes completion session does not match the bound mission session');
      const lastDirective = record.directives.at(-1);
      if (lastDirective?.decision !== 'COMPLETE') throw new RuntimeError('INVALID_REQUEST', 'Mission completion requires an accepted COMPLETE supervisor directive');
      return { ...record, state: 'COMPLETED', updatedAt: new Date().toISOString() };
    });
  }

  public latestDirective(record: MissionBrokerSnapshot): SupervisorDirective | null {
    return record.directives.at(-1) ?? null;
  }

  private update(missionId: string, transform: (record: MissionBrokerSnapshot) => MissionBrokerSnapshot): Promise<MissionBrokerSnapshot> {
    return this.mutate(async (document) => {
      await this.state.getMission(missionId);
      const index = document.records.findIndex((record) => record.missionId === missionId);
      if (index < 0) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission broker mapping was not found');
      const current = document.records[index]!;
      const next = transform(current);
      if (next === current) return { document, result: current };
      const records = [...document.records];
      records[index] = next;
      return { document: { schemaVersion: 1, records }, result: next };
    });
  }

  private async mutate(
    operation: (document: MissionBrokerDocument) => Promise<{ document: MissionBrokerDocument; result: MissionBrokerSnapshot }>,
  ): Promise<MissionBrokerSnapshot> {
    return this.serializeBrokerAccess(async (current) => {
      const next = await operation(current);
      if (next.document !== current) await this.store.write(next.document);
      return next.result;
    });
  }

  private async serializeBrokerAccess<T>(operation: (document: MissionBrokerDocument) => Promise<T>): Promise<T> {
    let result!: T;
    const queued = this.mutationTail.then(async () => {
      result = await operation(await this.store.read());
    });
    this.mutationTail = queued.then(() => undefined, () => undefined);
    await queued;
    return result;
  }
}

async function writeJsonAtomic(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Atomic mission broker publication failed', { cause: error });
  }
}

function normalizeBinding(input: BindHermesSessionInput): BindHermesSessionInput {
  const worktreePath = input.worktreePath.trim();
  if (!path.isAbsolute(worktreePath) || worktreePath.includes('\0') || worktreePath.length > 2048) throw new RuntimeError('INVALID_REQUEST', 'worktreePath must be a bounded absolute path');
  return {
    missionId: uuid(input.missionId, 'missionId'),
    hermesSessionId: identity(input.hermesSessionId, 'hermesSessionId'),
    worktreePath,
    branch: text(input.branch, 'branch', 240),
  };
}

function normalizeCheckpoint(input: MissionCheckpoint): MissionCheckpoint {
  return {
    checkpointId: uuid(input.checkpointId, 'checkpointId'),
    missionId: uuid(input.missionId, 'missionId'),
    missionVersion: version(input.missionVersion, 'missionVersion'),
    state: input.state,
    currentPhase: text(input.currentPhase, 'currentPhase', 240),
    summary: text(input.summary, 'summary', 2000),
    evidenceRefs: textList(input.evidenceRefs, 'evidenceRefs'),
    blockers: textList(input.blockers, 'blockers'),
    hermesAssessment: text(input.hermesAssessment, 'hermesAssessment', 2000),
    proposedNextAction: text(input.proposedNextAction, 'proposedNextAction', 1000),
    decisionRequired: strictBoolean(input.decisionRequired, 'decisionRequired'),
    createdAt: timestamp(input.createdAt, 'createdAt'),
  };
}

function normalizeDirectiveInput(input: SupervisorDirectiveInput): SupervisorDirectiveInput {
  return {
    missionId: uuid(input.missionId, 'missionId'),
    expectedVersion: version(input.expectedVersion, 'expectedVersion'),
    directiveId: uuid(input.directiveId, 'directiveId'),
    directiveSequence: positiveSequence(input.directiveSequence),
    decision: decision(input.decision),
    instruction: text(input.instruction, 'instruction', 4000),
    authorizedScope: textList(input.authorizedScope, 'authorizedScope'),
    doNot: textList(input.doNot, 'doNot'),
    successCriteria: textList(input.successCriteria, 'successCriteria'),
  };
}

function sameDirectiveInput(existing: SupervisorDirective, input: SupervisorDirectiveInput): boolean {
  const comparable = {
    missionId: existing.missionId,
    expectedVersion: existing.expectedVersion,
    directiveId: existing.directiveId,
    directiveSequence: existing.directiveSequence,
    decision: existing.decision,
    instruction: existing.instruction,
    authorizedScope: existing.authorizedScope,
    doNot: existing.doNot,
    successCriteria: existing.successCriteria,
  };
  return stableJson(comparable) === stableJson(input);
}

function sameBinding(record: MissionBrokerSnapshot, input: BindHermesSessionInput): boolean {
  return record.hermesSessionId === input.hermesSessionId && record.worktreePath === input.worktreePath && record.branch === input.branch;
}

function isDocument(value: unknown): value is MissionBrokerDocument {
  return isRecord(value)
    && value.schemaVersion === 1
    && Array.isArray(value.records)
    && value.records.length <= MAX_RECORDS
    && value.records.every(isBrokerRecord)
    && new Set(value.records.map((record) => record.missionId)).size === value.records.length;
}

function isBrokerRecord(value: unknown): value is MissionBrokerSnapshot {
  return isRecord(value)
    && isUuid(value.missionId)
    && isVersion(value.missionVersion)
    && boundedIdentity(value.hermesSessionId)
    && typeof value.worktreePath === 'string' && path.isAbsolute(value.worktreePath) && value.worktreePath.length <= 2048 && !value.worktreePath.includes('\0')
    && boundedText(value.branch, 240)
    && brokerState(value.state)
    && (value.lastCheckpointId === null || isUuid(value.lastCheckpointId))
    && (value.lastDirectiveId === null || isUuid(value.lastDirectiveId))
    && typeof value.lastDirectiveSequence === 'number' && Number.isInteger(value.lastDirectiveSequence) && value.lastDirectiveSequence >= 0
    && Array.isArray(value.checkpoints) && value.checkpoints.length <= MAX_CHECKPOINTS && value.checkpoints.every(isCheckpoint)
    && Array.isArray(value.directives) && value.directives.length <= MAX_DIRECTIVES && value.directives.every(isDirective)
    && isTimestamp(value.updatedAt);
}

function isCheckpoint(value: unknown): boolean {
  return isRecord(value) && isUuid(value.checkpointId) && isUuid(value.missionId) && isVersion(value.missionVersion)
    && missionState(value.state) && boundedText(value.currentPhase, 240) && boundedText(value.summary, 2000)
    && boundedTextList(value.evidenceRefs) && boundedTextList(value.blockers) && boundedText(value.hermesAssessment, 2000)
    && boundedText(value.proposedNextAction, 1000) && typeof value.decisionRequired === 'boolean' && isTimestamp(value.createdAt);
}

function isDirective(value: unknown): boolean {
  return isRecord(value) && isUuid(value.missionId) && isVersion(value.expectedVersion) && isUuid(value.directiveId)
    && typeof value.directiveSequence === 'number' && Number.isInteger(value.directiveSequence) && value.directiveSequence > 0 && supervisorDecision(value.decision)
    && boundedText(value.instruction, 4000) && boundedTextList(value.authorizedScope) && boundedTextList(value.doNot)
    && boundedTextList(value.successCriteria) && isTimestamp(value.acceptedAt);
}

function textList(value: readonly string[], name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw new RuntimeError('INVALID_REQUEST', `${name} exceeds its bounded item limit`);
  return value.map((item, index) => text(item, `${name}[${index}]`, 1000));
}

function boundedTextList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_LIST_ITEMS && value.every((item) => boundedText(item, 1000));
}

function uuid(value: string, name: string): string {
  const normalized = value.trim();
  if (!isUuid(normalized)) throw new RuntimeError('INVALID_REQUEST', `${name} must be a UUID`);
  return normalized;
}

function identity(value: string, name: string): string {
  const normalized = value.trim();
  if (!boundedIdentity(normalized)) throw new RuntimeError('INVALID_REQUEST', `${name} is invalid`);
  return normalized;
}

function text(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (!boundedText(normalized, max)) throw new RuntimeError('INVALID_REQUEST', `${name} is invalid or too large`);
  return normalized;
}

function timestamp(value: string, name: string): string {
  if (!isTimestamp(value)) throw new RuntimeError('INVALID_REQUEST', `${name} must be a valid timestamp`);
  return value;
}

function brokerHandoffSafe(
  currentMode: OrchestratorMode,
  missionStateValue: string,
  record: MissionBrokerSnapshot | null,
): boolean {
  if (currentMode !== 'HERMES' || record === null) return true;
  if (missionStateValue === 'COMPLETED') return true;
  if (record.state === 'AWAITING_SUPERVISOR' && record.lastCheckpointId !== null) return true;
  if (missionStateValue === 'PLANNED') return record.directives.length === 0 && record.checkpoints.length === 0;
  return false;
}

function orchestratorMode(value: OrchestratorMode): OrchestratorMode {
  if (value !== 'HERMES' && value !== 'CHATGPT') throw new RuntimeError('INVALID_REQUEST', 'orchestratorMode is invalid');
  return value;
}

function strictBoolean(value: boolean, name: string): boolean {
  if (typeof value !== 'boolean') throw new RuntimeError('INVALID_REQUEST', `${name} must be boolean`);
  return value;
}

function version(value: number, name: string): number {
  if (!isVersion(value)) throw new RuntimeError('INVALID_REQUEST', `${name} must be a positive integer`);
  return value;
}

function positiveSequence(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new RuntimeError('INVALID_REQUEST', 'directiveSequence must be a positive integer');
  return value;
}

function decision(value: SupervisorDecision): SupervisorDecision {
  if (!supervisorDecision(value)) throw new RuntimeError('INVALID_REQUEST', 'Supervisor decision is invalid');
  return value;
}

function brokerState(value: unknown): value is MissionBrokerState {
  return value === 'ACTIVE' || value === 'AWAITING_SUPERVISOR' || value === 'COMPLETED' || value === 'FAILED';
}

function supervisorDecision(value: unknown): value is SupervisorDecision {
  return value === 'CONTINUE' || value === 'REVISE' || value === 'PAUSE' || value === 'COMPLETE';
}

function missionState(value: unknown): boolean {
  return value === 'PLANNED' || value === 'RUNNING' || value === 'WAITING_APPROVAL' || value === 'WAITING_SUPERVISOR'
    || value === 'PAUSED' || value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED';
}

function isVersion(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() && !value.includes('\0');
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !value.includes('\0');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
