import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { inspectPrivateRegularFile, privateDirectoryProblem } from './private-fs.js';
import { readOwnerAccessSecret } from './persistence.js';

const FILE = 'runtime-lifecycle-grants.json';
const SCHEMA_VERSION = 1 as const;
const MAX_GRANTS = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;

export const lifecycleOperations = ['runtime_on', 'runtime_off'] as const;
export type LifecycleOperation = typeof lifecycleOperations[number];
export type LifecycleExecutionState = 'RESERVED' | 'COMMITTED' | 'FAILED' | 'RECONCILIATION_REQUIRED';

export interface LifecycleGrantBinding {
  readonly machineId: string;
  readonly tunnelId: string;
  readonly sourceRoot: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly workloadSourceRoot: string;
  readonly workloadSourceSha: string;
  readonly workloadSourceTree: string;
}

export interface LifecycleGrantSpec extends LifecycleGrantBinding {
  readonly requestId: string;
  readonly allowedOperations: readonly LifecycleOperation[];
  readonly expiresAt: string;
  readonly maxOperationCount: number;
}

export interface LifecycleGrantExecution {
  readonly grantId: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly target?: LifecycleGrantTarget;
}

export interface LifecycleGrantTarget {
  readonly pid: number;
  readonly processStartMarker: string;
  readonly runtimeId?: string | null;
  readonly instanceId?: string | null;
}

export interface LifecycleGrantOperation {
  readonly operationId: string;
  readonly operation: LifecycleOperation;
  readonly state: LifecycleExecutionState;
  readonly reservedAt: string;
  readonly completedAt?: string;
  readonly resultDigest?: string;
  readonly target?: LifecycleGrantTarget;
}

export interface LifecycleRestartRecord {
  readonly requestId: string;
  readonly grantId: string;
  readonly offOperationId: string;
  readonly onOperationId: string;
  readonly capturedTarget: LifecycleGrantTarget | null;
  readonly state: 'PENDING' | 'RUNNING' | 'FAILED' | 'RECONCILIATION_REQUIRED';
  readonly phase: 'OFF_RESERVED' | 'ON_RESERVED' | 'COMPLETE' | 'UNKNOWN';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resultDigest?: string;
}

export interface LifecycleGrantRecord extends LifecycleGrantSpec {
  readonly grantId: string;
  readonly issuedAt: string;
  readonly revokedAt: string | null;
  readonly operations: readonly LifecycleGrantOperation[];
  readonly restart?: LifecycleRestartRecord;
  readonly digest: string;
}

interface LifecycleGrantDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly grants: readonly LifecycleGrantRecord[];
  readonly mac: string;
}

export class LifecycleGrantStore {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly dataRoot: string) {}

  public async issue(spec: LifecycleGrantSpec): Promise<LifecycleGrantRecord> {
    validateSpec(spec, false);
    const secret = await this.requireSecret();
    let issued!: LifecycleGrantRecord;
    await this.mutate(async (document) => {
      const existing = document.grants.find((grant) => grant.requestId === spec.requestId);
      if (existing !== undefined) {
        if (!sameSpec(existing, spec)) throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle grant requestId was already used for a different scope');
        issued = existing;
        return document;
      }
      validateSpec(spec);
      if (document.grants.length >= MAX_GRANTS) throw new RuntimeError('PERSISTENCE_FAILURE', 'Lifecycle grant capacity is exhausted; revoke or reconcile an existing grant first');
      const issuedAt = new Date().toISOString();
      const base = { ...spec, grantId: randomUUID(), issuedAt, revokedAt: null, operations: [] };
      issued = { ...base, digest: digest(base) };
      return { ...document, grants: [...document.grants, issued] };
    }, secret);
    return issued;
  }

  public async revoke(grantId: string): Promise<void> {
    if (!UUID_PATTERN.test(grantId)) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle grant identity is invalid');
    const secret = await this.requireSecret();
    await this.mutate(async (document) => {
      const index = document.grants.findIndex((grant) => grant.grantId === grantId);
      if (index < 0) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle grant was not found');
      const current = document.grants[index]!;
      if (current.operations.some((operation) => operation.state === 'RESERVED' || operation.state === 'RECONCILIATION_REQUIRED')) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle grant has an unresolved operation');
      }
      if (current.revokedAt !== null) return document;
      const next = { ...current, revokedAt: new Date().toISOString() };
      const grants = [...document.grants];
      grants[index] = { ...next, digest: digest(next) };
      return { ...document, grants };
    }, secret);
  }

  public async reserve(binding: LifecycleGrantBinding, operation: LifecycleOperation, execution: LifecycleGrantExecution): Promise<LifecycleGrantRecord> {
    validateBinding(binding);
    validateExecution(execution);
    if (!lifecycleOperations.includes(operation)) throw new RuntimeError('INVALID_REQUEST', 'Unsupported runtime lifecycle operation');
    const secret = await this.requireSecret();
    let reserved!: LifecycleGrantRecord;
    await this.mutate(async (document) => {
      assertNoPendingRestart(document);
      const index = document.grants.findIndex((grant) => grant.grantId === execution.grantId);
      if (index < 0) throw new RuntimeError('CONTROL_DENIED', 'Lifecycle grant was not found');
      const current = document.grants[index]!;
      if (current.requestId !== execution.requestId) throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle grant request binding does not match');
      if (!sameBinding(current, binding)) throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle grant binding does not match current machine, tunnel, or source identity');
      if (current.revokedAt !== null) throw new RuntimeError('CONTROL_DENIED', 'Lifecycle grant was revoked');
      if (Date.parse(current.expiresAt) <= Date.now()) throw new RuntimeError('CONTROL_DENIED', 'Lifecycle grant has expired');
      if (!current.allowedOperations.includes(operation)) throw new RuntimeError('CONTROL_DENIED', 'Lifecycle operation is outside the grant scope');
      if (current.operations.some((entry) => entry.state === 'RESERVED' || entry.state === 'RECONCILIATION_REQUIRED')) throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle grant has an unresolved operation; reconcile before retry');
      if (current.operations.some((entry) => entry.operationId === execution.operationId)) throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle operation replay was rejected');
      if (consumedBudget(current) >= current.maxOperationCount) throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle grant execution limit was reached');
      const operationRecord: LifecycleGrantOperation = { operationId: execution.operationId, operation, state: 'RESERVED', reservedAt: new Date().toISOString(), ...(execution.target === undefined ? {} : { target: execution.target }) };
      const next = { ...current, operations: [...current.operations, operationRecord] };
      reserved = { ...next, digest: digest(next) };
      const grants = [...document.grants];
      grants[index] = reserved;
      return { ...document, grants };
    }, secret);
    return reserved;
  }

  public async complete(grantId: string, operationId: string, state: Exclude<LifecycleExecutionState, 'RESERVED'>, result?: unknown): Promise<void> {
    if (!UUID_PATTERN.test(grantId) || !OPERATION_ID_PATTERN.test(operationId)) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle operation identity is invalid');
    const secret = await this.requireSecret();
    await this.mutate(async (document) => {
      const index = document.grants.findIndex((grant) => grant.grantId === grantId);
      if (index < 0) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle grant was not found');
      const current = document.grants[index]!;
      assertNotPairedOperation(current, operationId);
      const operationIndex = current.operations.findIndex((entry) => entry.operationId === operationId);
      if (operationIndex < 0) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle operation was not found');
      const operation = current.operations[operationIndex]!;
      if (operation.state !== 'RESERVED') {
        if (operation.state === state) return document;
        throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle operation is already terminal');
      }
      const updated: LifecycleGrantOperation = {
        ...operation,
        state,
        completedAt: new Date().toISOString(),
        ...(result === undefined ? {} : { resultDigest: digest(result) }),
      };
      const operations = [...current.operations];
      operations[operationIndex] = updated;
      const next = { ...current, operations };
      const grants = [...document.grants];
      grants[index] = { ...next, digest: digest(next) };
      return { ...document, grants };
    }, secret);
  }

  public async reconcile(grantId: string, operationId: string, terminal: 'COMMITTED' | 'FAILED', evidence: unknown, allowReserved = false): Promise<void> {
    if (evidence === undefined) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle reconciliation requires observed evidence');
    if (!UUID_PATTERN.test(grantId) || !OPERATION_ID_PATTERN.test(operationId)) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle operation identity is invalid');
    const secret = await this.requireSecret();
    await this.mutate(async (document) => {
      const index = document.grants.findIndex((grant) => grant.grantId === grantId);
      if (index < 0) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle grant was not found');
      const current = document.grants[index]!;
      assertNotPairedOperation(current, operationId);
      const operationIndex = current.operations.findIndex((entry) => entry.operationId === operationId);
      if (operationIndex < 0) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle operation was not found');
      const operation = current.operations[operationIndex]!;
      if (operation.state !== 'RECONCILIATION_REQUIRED' && !(allowReserved && operation.state === 'RESERVED')) throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle operation is not awaiting reconciliation');
      const updated: LifecycleGrantOperation = { ...operation, state: terminal, completedAt: new Date().toISOString(), resultDigest: digest(evidence) };
      const operations = [...current.operations];
      operations[operationIndex] = updated;
      const next = { ...current, operations };
      const grants = [...document.grants];
      grants[index] = { ...next, digest: digest(next) };
      return { ...document, grants };
    }, secret);
  }

  public async get(grantId: string): Promise<LifecycleGrantRecord> {
    if (!UUID_PATTERN.test(grantId)) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle grant identity is invalid');
    const grants = await this.read();
    const grant = grants.find((entry) => entry.grantId === grantId);
    if (grant === undefined) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle grant was not found');
    return grant;
  }

  /** The caller holds the Supervisor operation lock until this newly created pair settles. */
  public async beginRestart(binding: LifecycleGrantBinding, execution: LifecycleGrantExecution, capturedTarget: LifecycleGrantTarget | null): Promise<{ record: LifecycleRestartRecord; created: boolean }> {
    validateRestartExecution(binding, execution);
    if (capturedTarget !== null && !isTarget(capturedTarget)) throw new RuntimeError('INVALID_REQUEST', 'Restart target is invalid');
    const secret = await this.requireSecret();
    let outcome!: { record: LifecycleRestartRecord; created: boolean };
    await this.mutate(async (document) => {
      const current = boundGrant(document, binding, execution);
      const existing = document.grants.find((grant) => grant.restart?.requestId === execution.operationId);
      if (existing !== undefined) {
        if (existing.grantId !== current.grantId || !sameTarget(existing.restart!.capturedTarget, capturedTarget)) throw new RuntimeError('AUTHORITY_CHANGED', 'Restart request is already bound to another grant or target');
        outcome = { record: existing.restart!, created: false };
        return document;
      }
      assertGrantActive(current);
      if (current.restart !== undefined) throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle grant already contains a restart');
      assertNoPendingRestart(document);
      if (document.grants.some((grant) => grant.operations.some(unresolvedOperation))) throw new RuntimeError('AUTHORITY_CHANGED', 'A lifecycle operation is unresolved');
      if (!lifecycleOperations.every((operation) => current.allowedOperations.includes(operation)) || consumedBudget(current) + 2 > current.maxOperationCount) throw new RuntimeError('CONTROL_DENIED', 'Restart requires both lifecycle operations and two remaining uses');
      const now = new Date().toISOString();
      const record: LifecycleRestartRecord = { requestId: execution.operationId, grantId: current.grantId, offOperationId: randomUUID(), onOperationId: randomUUID(), capturedTarget, state: 'PENDING', phase: 'OFF_RESERVED', createdAt: now, updatedAt: now };
      const operations: LifecycleGrantOperation[] = [
        ...current.operations,
        { operationId: record.offOperationId, operation: 'runtime_off', state: 'RESERVED', reservedAt: now, ...(capturedTarget === null ? {} : { target: capturedTarget }) },
        { operationId: record.onOperationId, operation: 'runtime_on', state: 'RESERVED', reservedAt: now },
      ];
      outcome = { record, created: true };
      return replaceGrant(document, { ...current, operations, restart: record });
    }, secret);
    return outcome;
  }

  public async advanceRestartOff(grantId: string, requestId: string, evidence: unknown): Promise<LifecycleRestartRecord> {
    return this.updateRestart(grantId, requestId, evidence, (grant, restart, now) => {
      if (restart.state !== 'PENDING' || restart.phase !== 'OFF_RESERVED') throw new RuntimeError('AUTHORITY_CHANGED', 'Restart OFF is not pending');
      return { ...grant, operations: updateOperation(grant, restart.offOperationId, 'COMMITTED', evidence, now), restart: { ...restart, phase: 'ON_RESERVED', updatedAt: now } };
    });
  }

  /** This authorizes only the ON half of the original uninterrupted, locked call. It never resumes a replay. */
  public async authorizeRestartOn(binding: LifecycleGrantBinding, execution: LifecycleGrantExecution): Promise<LifecycleRestartRecord> {
    validateRestartExecution(binding, execution);
    const document = await this.readDocument(await this.requireSecret());
    const grant = boundGrant(document, binding, execution);
    assertGrantActive(grant);
    const restart = grant.restart;
    if (restart === undefined || restart.requestId !== execution.operationId || restart.state !== 'PENDING' || restart.phase !== 'ON_RESERVED') throw new RuntimeError('AUTHORITY_CHANGED', 'Restart ON is not pending');
    return restart;
  }

  public async completeRestartOn(grantId: string, requestId: string, terminal: 'RUNNING' | 'FAILED', evidence: unknown): Promise<LifecycleRestartRecord> {
    return this.updateRestart(grantId, requestId, evidence, (grant, restart, now) => {
      if (restart.state !== 'PENDING' || restart.phase !== 'ON_RESERVED') throw new RuntimeError('AUTHORITY_CHANGED', 'Restart ON is not pending');
      if (terminal !== 'RUNNING' && terminal !== 'FAILED') throw new RuntimeError('INVALID_REQUEST', 'Restart terminal result is invalid');
      return { ...grant, operations: updateOperation(grant, restart.onOperationId, terminal === 'RUNNING' ? 'COMMITTED' : 'FAILED', evidence, now), restart: { ...restart, state: terminal, phase: 'COMPLETE', updatedAt: now, resultDigest: digest(evidence) } };
    });
  }

  public async markRestartUnknown(grantId: string, requestId: string, evidence: unknown): Promise<LifecycleRestartRecord> {
    return this.updateRestart(grantId, requestId, evidence, (grant, restart, now) => {
      if (restart.state !== 'PENDING') throw new RuntimeError('AUTHORITY_CHANGED', 'Restart is not pending');
      const operations = grant.operations.map((operation) => isPairedOperation(restart, operation.operationId) && operation.state === 'RESERVED'
        ? { ...operation, state: 'RECONCILIATION_REQUIRED' as const, completedAt: now, resultDigest: digest(evidence) } : operation);
      return { ...grant, operations, restart: { ...restart, state: 'RECONCILIATION_REQUIRED', phase: 'UNKNOWN', updatedAt: now, resultDigest: digest(evidence) } };
    });
  }

  /** Reconciliation records authoritative observations supplied by the Supervisor; it never performs or resumes effects. */
  public async reconcileRestart(grantId: string, requestId: string, terminal: 'RUNNING' | 'FAILED', evidence: { readonly off: 'COMMITTED' | 'FAILED'; readonly on: 'COMMITTED' | 'FAILED'; readonly observed: unknown }): Promise<LifecycleRestartRecord> {
    if (evidence === undefined || evidence.observed === undefined || !['COMMITTED', 'FAILED'].includes(evidence.off) || !['COMMITTED', 'FAILED'].includes(evidence.on)
      || (terminal !== 'RUNNING' && terminal !== 'FAILED') || (terminal === 'RUNNING' ? evidence.off !== 'COMMITTED' || evidence.on !== 'COMMITTED' : evidence.on !== 'FAILED')) throw new RuntimeError('INVALID_REQUEST', 'Restart reconciliation requires consistent OFF and ON evidence');
    return this.updateRestart(grantId, requestId, evidence, (grant, restart, now) => {
      if (restart.state !== 'PENDING' && restart.state !== 'RECONCILIATION_REQUIRED') throw new RuntimeError('AUTHORITY_CHANGED', 'Restart is not awaiting reconciliation');
      const operations = grant.operations.map((operation) => {
        if (!isPairedOperation(restart, operation.operationId)) return operation;
        const state = operation.operationId === restart.offOperationId ? evidence.off : evidence.on;
        if ((operation.state === 'COMMITTED' || operation.state === 'FAILED') && operation.state !== state) throw new RuntimeError('AUTHORITY_CHANGED', 'Reconciliation cannot replace a known lifecycle outcome');
        return { ...operation, state, completedAt: now, resultDigest: digest(evidence) };
      });
      return { ...grant, operations, restart: { ...restart, state: terminal, phase: 'COMPLETE', updatedAt: now, resultDigest: digest(evidence) } };
    });
  }

  public async getRestart(requestId: string): Promise<LifecycleRestartRecord | null> {
    if (!UUID_PATTERN.test(requestId)) throw new RuntimeError('INVALID_REQUEST', 'Restart request identity is invalid');
    return (await this.readRestartDocument())?.grants.find((grant) => grant.restart?.requestId === requestId)?.restart ?? null;
  }

  public async assertNoUnresolvedRestart(): Promise<void> {
    const document = await this.readRestartDocument();
    if (document !== null) assertNoPendingRestart(document);
  }

  private async readRestartDocument(): Promise<LifecycleGrantDocument | null> {
    const inspected = await inspectPrivateRegularFile(path.join(this.dataRoot, FILE), 'Runtime lifecycle grant document');
    if (inspected.state === 'missing') return null;
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    return this.readDocument(await this.requireSecret());
  }

  private async updateRestart(grantId: string, requestId: string, evidence: unknown, transform: (grant: LifecycleGrantRecord, restart: LifecycleRestartRecord, now: string) => LifecycleGrantRecord): Promise<LifecycleRestartRecord> {
    if (!UUID_PATTERN.test(grantId) || !UUID_PATTERN.test(requestId) || evidence === undefined) throw new RuntimeError('INVALID_REQUEST', 'Restart identity and evidence are required');
    const secret = await this.requireSecret();
    let updated!: LifecycleRestartRecord;
    await this.mutate(async (document) => {
      const grant = document.grants.find((entry) => entry.grantId === grantId);
      if (grant?.restart === undefined || grant.restart.requestId !== requestId) throw new RuntimeError('INVALID_REQUEST', 'Restart was not found');
      const next = transform(grant, grant.restart, new Date().toISOString());
      updated = next.restart!;
      return replaceGrant(document, next);
    }, secret);
    return updated;
  }

  public async read(): Promise<readonly LifecycleGrantRecord[]> {
    const secret = await this.requireSecret();
    return (await this.readDocument(secret)).grants;
  }

  private async requireSecret(): Promise<string> {
    const problem = await privateDirectoryProblem(this.dataRoot, 'IRIS runtime data root');
    if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
    const secret = await readOwnerAccessSecret(this.dataRoot);
    if (secret === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Owner access credential is unavailable');
    return secret;
  }

  private async readDocument(secret: string): Promise<LifecycleGrantDocument> {
    const inspected = await inspectPrivateRegularFile(path.join(this.dataRoot, FILE), 'Runtime lifecycle grant document');
    if (inspected.state === 'missing') return { schemaVersion: SCHEMA_VERSION, grants: [], mac: mac(secret, { schemaVersion: SCHEMA_VERSION, grants: [] }) };
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    let parsed: unknown;
    try { parsed = JSON.parse(inspected.content); } catch { throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime lifecycle grant document is invalid JSON'); }
    if (!isDocument(parsed) || !safeEqual(parsed.mac, mac(secret, payload(parsed)))) throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime lifecycle grant authentication failed');
    return parsed;
  }

  private async mutate(transform: (document: LifecycleGrantDocument) => Promise<LifecycleGrantDocument>, secret: string): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      const current = await this.readDocument(secret);
      const next = await transform(current);
      if (next === current) return;
      if (!isDocument(next)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing invalid lifecycle grant publication');
      await writeAtomic(path.join(this.dataRoot, FILE), { ...next, mac: mac(secret, payload(next)) });
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    await operation;
  }
}

function validateSpec(spec: LifecycleGrantSpec, requireFuture = true): void {
  validateBinding(spec);
  if (!UUID_PATTERN.test(spec.requestId) || spec.allowedOperations.length === 0 || spec.allowedOperations.some((operation) => !lifecycleOperations.includes(operation)) || new Set(spec.allowedOperations).size !== spec.allowedOperations.length) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle grant scope is invalid');
  if (!Number.isFinite(Date.parse(spec.expiresAt)) || requireFuture && Date.parse(spec.expiresAt) <= Date.now()) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle grant expiry must be in the future');
  if (!Number.isSafeInteger(spec.maxOperationCount) || spec.maxOperationCount < 1 || spec.maxOperationCount > 8) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle grant operation count is invalid');
}

function validateBinding(binding: LifecycleGrantBinding): void {
  if (!UUID_PATTERN.test(binding.machineId) || binding.tunnelId.trim().length === 0 || binding.tunnelId.length > 200 || !path.isAbsolute(binding.sourceRoot) || binding.sourceRoot.includes('\0') || !SHA_PATTERN.test(binding.sourceSha) || !SHA_PATTERN.test(binding.sourceTree) || !path.isAbsolute(binding.workloadSourceRoot) || binding.workloadSourceRoot.includes('\0') || !SHA_PATTERN.test(binding.workloadSourceSha) || !SHA_PATTERN.test(binding.workloadSourceTree)) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle grant binding is invalid');
}

function validateExecution(execution: LifecycleGrantExecution): void {
  if (!UUID_PATTERN.test(execution.grantId) || !UUID_PATTERN.test(execution.requestId) || !OPERATION_ID_PATTERN.test(execution.operationId)) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle execution identity is invalid');
  if (execution.target !== undefined && !isTarget(execution.target)) throw new RuntimeError('INVALID_REQUEST', 'Lifecycle execution target is invalid');
}

function sameBinding(left: LifecycleGrantBinding, right: LifecycleGrantBinding): boolean {
  return left.machineId === right.machineId && left.tunnelId === right.tunnelId && left.sourceRoot === right.sourceRoot && left.sourceSha === right.sourceSha && left.sourceTree === right.sourceTree && left.workloadSourceRoot === right.workloadSourceRoot && left.workloadSourceSha === right.workloadSourceSha && left.workloadSourceTree === right.workloadSourceTree;
}

function sameSpec(record: LifecycleGrantRecord, spec: LifecycleGrantSpec): boolean {
  return record.requestId === spec.requestId && sameBinding(record, spec) && JSON.stringify(record.allowedOperations) === JSON.stringify(spec.allowedOperations) && record.expiresAt === spec.expiresAt && record.maxOperationCount === spec.maxOperationCount;
}

function validateRestartExecution(binding: LifecycleGrantBinding, execution: LifecycleGrantExecution): void {
  validateBinding(binding);
  validateExecution(execution);
  if (!UUID_PATTERN.test(execution.operationId)) throw new RuntimeError('INVALID_REQUEST', 'Restart request identity must be a UUID');
}

function boundGrant(document: LifecycleGrantDocument, binding: LifecycleGrantBinding, execution: LifecycleGrantExecution): LifecycleGrantRecord {
  const grant = document.grants.find((entry) => entry.grantId === execution.grantId);
  if (grant === undefined) throw new RuntimeError('CONTROL_DENIED', 'Lifecycle grant was not found');
  if (grant.requestId !== execution.requestId || !sameBinding(grant, binding)) throw new RuntimeError('AUTHORITY_CHANGED', 'Lifecycle grant request or current binding does not match');
  return grant;
}

function assertGrantActive(grant: LifecycleGrantRecord): void {
  if (grant.revokedAt !== null) throw new RuntimeError('CONTROL_DENIED', 'Lifecycle grant was revoked');
  if (Date.parse(grant.expiresAt) <= Date.now()) throw new RuntimeError('CONTROL_DENIED', 'Lifecycle grant has expired');
}

function unresolvedOperation(operation: LifecycleGrantOperation): boolean { return operation.state === 'RESERVED' || operation.state === 'RECONCILIATION_REQUIRED'; }
function isPairedOperation(restart: LifecycleRestartRecord, operationId: string): boolean { return operationId === restart.offOperationId || operationId === restart.onOperationId; }
function assertNotPairedOperation(grant: LifecycleGrantRecord, operationId: string): void {
  if (grant.restart !== undefined && isPairedOperation(grant.restart, operationId)) throw new RuntimeError('AUTHORITY_CHANGED', 'Paired restart operations require paired completion or reconciliation');
}
function assertNoPendingRestart(document: LifecycleGrantDocument): void {
  if (document.grants.some((grant) => grant.restart !== undefined && grant.restart.phase !== 'COMPLETE')) throw new RuntimeError('AUTHORITY_CHANGED', 'A workload restart requires completion or reconciliation');
}
function consumedBudget(grant: LifecycleGrantRecord): number {
  return grant.operations.filter((operation) => operation.state === 'COMMITTED' || grant.restart !== undefined && isPairedOperation(grant.restart, operation.operationId)).length;
}
function sameTarget(left: LifecycleGrantTarget | null, right: LifecycleGrantTarget | null): boolean {
  return left === null || right === null ? left === right : left.pid === right.pid && left.processStartMarker === right.processStartMarker && left.runtimeId === right.runtimeId && left.instanceId === right.instanceId;
}
function replaceGrant(document: LifecycleGrantDocument, next: LifecycleGrantRecord): LifecycleGrantDocument {
  return { ...document, grants: document.grants.map((grant) => grant.grantId === next.grantId ? { ...next, digest: digest(next) } : grant) };
}
function updateOperation(grant: LifecycleGrantRecord, operationId: string, state: 'COMMITTED' | 'FAILED', evidence: unknown, now: string): readonly LifecycleGrantOperation[] {
  return grant.operations.map((operation) => operation.operationId === operationId ? { ...operation, state, completedAt: now, resultDigest: digest(evidence) } : operation);
}

function digest(value: unknown): string { return mac('runtime-lifecycle-grant-digest', value); }
function mac(secret: string, value: unknown): string { return createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex'); }
function payload(document: LifecycleGrantDocument | { readonly schemaVersion: typeof SCHEMA_VERSION; readonly grants: readonly LifecycleGrantRecord[] }): Record<string, unknown> { return { schemaVersion: document.schemaVersion, grants: document.grants }; }
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

async function writeAtomic(filename: string, value: unknown): Promise<void> {
  const parent = path.dirname(filename);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    const directory = await open(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime lifecycle grant publication failed', { cause: error });
  }
}

function isDocument(value: unknown): value is LifecycleGrantDocument {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || typeof value.mac !== 'string' || !Array.isArray(value.grants) || value.grants.length > MAX_GRANTS) return false;
  if (!value.grants.every(isGrant)) return false;
  const restartIds = value.grants.flatMap((grant) => grant.restart === undefined ? [] : [grant.restart.requestId]);
  return new Set(restartIds).size === restartIds.length;
}

function isGrant(value: unknown): value is LifecycleGrantRecord {
  if (!isRecord(value)) return false;
  const candidate = value;
  const maxOperationCount = candidate.maxOperationCount;
  const revokedAt = candidate.revokedAt;
  const operations = candidate.operations;
  if (!UUID_PATTERN.test(String(candidate.grantId)) || !UUID_PATTERN.test(String(candidate.requestId)) || !UUID_PATTERN.test(String(candidate.machineId))
    || typeof candidate.tunnelId !== 'string' || typeof candidate.sourceRoot !== 'string' || !path.isAbsolute(candidate.sourceRoot) || typeof candidate.workloadSourceRoot !== 'string' || !path.isAbsolute(candidate.workloadSourceRoot)
    || !SHA_PATTERN.test(String(candidate.sourceSha)) || !SHA_PATTERN.test(String(candidate.sourceTree))
    || !SHA_PATTERN.test(String(candidate.workloadSourceSha)) || !SHA_PATTERN.test(String(candidate.workloadSourceTree))
    || !Array.isArray(candidate.allowedOperations) || candidate.allowedOperations.length === 0
    || candidate.allowedOperations.some((operation) => !lifecycleOperations.includes(operation as LifecycleOperation))
    || typeof candidate.expiresAt !== 'string' || !Number.isFinite(Date.parse(candidate.expiresAt))
    || typeof maxOperationCount !== 'number' || !Number.isSafeInteger(maxOperationCount) || maxOperationCount < 1 || maxOperationCount > 8
    || typeof candidate.issuedAt !== 'string' || !Number.isFinite(Date.parse(candidate.issuedAt))
    || (revokedAt !== null && typeof revokedAt !== 'string') || !Array.isArray(operations)
    || typeof candidate.digest !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.digest)) return false;
  const validOperations = operations.every((operation) => isRecord(operation) && typeof operation.operationId === 'string' && OPERATION_ID_PATTERN.test(operation.operationId) && lifecycleOperations.includes(operation.operation as LifecycleOperation) && ['RESERVED', 'COMMITTED', 'FAILED', 'RECONCILIATION_REQUIRED'].includes(String(operation.state)) && typeof operation.reservedAt === 'string' && Number.isFinite(Date.parse(operation.reservedAt)) && (operation.completedAt === undefined || typeof operation.completedAt === 'string') && (operation.resultDigest === undefined || typeof operation.resultDigest === 'string' && /^[a-f0-9]{64}$/.test(operation.resultDigest)) && (operation.target === undefined || isTarget(operation.target)));
  return validOperations && (candidate.restart === undefined || isRestart(candidate.restart, candidate as unknown as LifecycleGrantRecord));
}

function isRestart(value: unknown, grant: LifecycleGrantRecord): value is LifecycleRestartRecord {
  if (!isRecord(value) || !UUID_PATTERN.test(String(value.requestId)) || value.grantId !== grant.grantId
    || !UUID_PATTERN.test(String(value.offOperationId)) || !UUID_PATTERN.test(String(value.onOperationId)) || value.offOperationId === value.onOperationId
    || (value.capturedTarget !== null && !isTarget(value.capturedTarget))
    || !['PENDING', 'RUNNING', 'FAILED', 'RECONCILIATION_REQUIRED'].includes(String(value.state))
    || !['OFF_RESERVED', 'ON_RESERVED', 'COMPLETE', 'UNKNOWN'].includes(String(value.phase))
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.resultDigest !== undefined && (typeof value.resultDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.resultDigest)))
    || !lifecycleOperations.every((operation) => grant.allowedOperations.includes(operation)) || consumedBudget(grant) > grant.maxOperationCount
    || new Set(grant.operations.map((operation) => operation.operationId)).size !== grant.operations.length) return false;
  const off = grant.operations.find((operation) => operation.operationId === value.offOperationId);
  const on = grant.operations.find((operation) => operation.operationId === value.onOperationId);
  if (off?.operation !== 'runtime_off' || on?.operation !== 'runtime_on' || !sameTarget(off.target ?? null, value.capturedTarget as LifecycleGrantTarget | null)) return false;
  if (value.phase === 'OFF_RESERVED') return value.state === 'PENDING' && off.state === 'RESERVED' && on.state === 'RESERVED';
  if (value.phase === 'ON_RESERVED') return value.state === 'PENDING' && off.state === 'COMMITTED' && on.state === 'RESERVED';
  if (value.phase === 'UNKNOWN') return value.state === 'RECONCILIATION_REQUIRED' && ['COMMITTED', 'RECONCILIATION_REQUIRED'].includes(off.state) && on.state === 'RECONCILIATION_REQUIRED';
  return value.state === 'RUNNING' ? off.state === 'COMMITTED' && on.state === 'COMMITTED' : value.state === 'FAILED' && ['COMMITTED', 'FAILED'].includes(off.state) && on.state === 'FAILED';
}

function isTarget(value: unknown): value is LifecycleGrantTarget {
  return isRecord(value) && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.processStartMarker === 'string' && /^\d+:\d+$/.test(value.processStartMarker)
    && (value.runtimeId === undefined || value.runtimeId === null || typeof value.runtimeId === 'string')
    && (value.instanceId === undefined || value.instanceId === null || typeof value.instanceId === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
