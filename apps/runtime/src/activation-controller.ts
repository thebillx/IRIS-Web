import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { ACTIVATION_FINGERPRINT_ALGORITHM, assertActivationWorkloadReady, inspectActivationSourceIdentity, type ActivationSourceIdentity } from './activation-source-identity.js';
import { writePrivateJsonAtomic } from './credentials.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { GovernedGitEngine } from './governed-git-engine.js';
import { createSupervisor, type Supervisor } from './supervisor.js';
import { readSupervisorAdminSnapshot } from './supervisor-admin.js';

const TRANSACTION_FILE = 'activation-transactions.json';
const MAX_TRANSACTIONS = 64;
const FINGERPRINT_ALGORITHM = ACTIVATION_FINGERPRINT_ALGORITHM;

export type ActivationTransactionState =
  | 'PREPARED'
  | 'APPLYING'
  | 'APPLIED'
  | 'APPLY_FAILED'
  | 'CONFIRMED'
  | 'ROLLBACK_IN_PROGRESS'
  | 'ROLLED_BACK';

export interface ActivationPrepareInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly expectedHead: string;
  readonly expectedCandidateFingerprint: string;
  readonly expectedCurrentDeploymentEpoch: number;
  readonly expectedRuntimeId?: string | undefined;
  readonly expectedCatalogId?: string | undefined;
}

export interface ActivationRuntimeSnapshot {
  readonly readiness: 'READY' | 'DEGRADED';
  readonly runtimeId: string | null;
  readonly instanceId: string | null;
  readonly catalogId: string | null;
  readonly deploymentEpoch: number | null;
  readonly fullToolCount: number | null;
  readonly proToolCount: number | null;
  readonly workloadSourceRoot: string;
}

export interface ActivationCandidateSnapshot {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly sourceRoot: string;
  readonly head: string;
  readonly candidateFingerprint: string;
  readonly trackedModifiedCount: number;
  readonly fingerprintAlgorithm: typeof FINGERPRINT_ALGORITHM;
}

export interface ActivationTransaction {
  readonly transactionId: string;
  readonly state: ActivationTransactionState;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly expectedHead: string;
  readonly expectedCandidateFingerprint: string;
  readonly expectedCurrentDeploymentEpoch: number;
  readonly expectedRuntimeId: string | null;
  readonly expectedCatalogId: string | null;
  readonly candidate: ActivationCandidateSnapshot;
  readonly preActivation: ActivationRuntimeSnapshot;
  readonly postApply: ActivationRuntimeSnapshot | null;
  readonly postRollback: ActivationRuntimeSnapshot | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt: string | null;
  readonly confirmedAt: string | null;
  readonly rolledBackAt: string | null;
  readonly lastFailureCode: string | null;
}

interface ActivationTransactionDocument {
  readonly schemaVersion: 1;
  readonly transactions: readonly ActivationTransaction[];
}

export interface ActivationCandidateInspector {
  inspect(projectId: string, workspaceId: string, repositoryId: string): Promise<ActivationCandidateSnapshot>;
}

export interface ActivationRuntimeAdapter {
  snapshot(): Promise<ActivationRuntimeSnapshot>;
  applySourceRoot(sourceRoot: string, sourceIdentity?: ActivationSourceIdentity): Promise<ActivationRuntimeSnapshot>;
}

export interface ActivationStatus {
  readonly runtime: ActivationRuntimeSnapshot;
  readonly transaction: ActivationTransaction | null;
  readonly activeTransactionId: string | null;
  readonly fingerprintAlgorithm: typeof FINGERPRINT_ALGORITHM;
}

export class ActivationController {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly dataRoot: string,
    private readonly candidates: ActivationCandidateInspector,
    private readonly runtime: ActivationRuntimeAdapter,
  ) {}

  public async status(transactionId?: string): Promise<ActivationStatus> {
    const document = await this.readDocument();
    const normalizedTransactionId = transactionId === undefined ? undefined : normalizeUuid(transactionId, 'transactionId');
    const transaction = normalizedTransactionId === undefined
      ? activeTransaction(document)
      : document.transactions.find((candidate) => candidate.transactionId === normalizedTransactionId) ?? null;
    return {
      runtime: await this.runtime.snapshot(),
      transaction,
      activeTransactionId: activeTransaction(document)?.transactionId ?? null,
      fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
    };
  }

  public recoverInterrupted(): Promise<ActivationTransaction | null> {
    return this.serialize(async () => {
      let document = await this.readDocument();
      let transaction = activeTransaction(document);
      if (transaction === null || transaction.state !== 'APPLYING' && transaction.state !== 'ROLLBACK_IN_PROGRESS') {
        return transaction;
      }

      const current = await this.runtime.snapshot();
      if (transaction.state === 'APPLYING') {
        let provenApplied = false;
        try {
          const candidate = await this.candidates.inspect(transaction.projectId, transaction.workspaceId, transaction.repositoryId);
          assertStoredCandidateMatches(candidate, transaction);
          assertAppliedBinding(current, transaction);
          provenApplied = true;
        } catch {
          provenApplied = false;
        }
        transaction = provenApplied
          ? updateTransaction(transaction, {
            state: 'APPLIED',
            postApply: current,
            appliedAt: transaction.appliedAt ?? new Date().toISOString(),
            lastFailureCode: null,
          })
          : updateTransaction(transaction, {
            state: 'APPLY_FAILED',
            lastFailureCode: 'RECOVERY_REQUIRED',
          });
      } else {
        let provenRolledBack = false;
        try {
          assertRolledBackBinding(current, transaction);
          provenRolledBack = true;
        } catch {
          provenRolledBack = false;
        }
        transaction = provenRolledBack
          ? updateTransaction(transaction, {
            state: 'ROLLED_BACK',
            postRollback: current,
            rolledBackAt: transaction.rolledBackAt ?? new Date().toISOString(),
            lastFailureCode: null,
          })
          : updateTransaction(transaction, {
            state: 'APPLY_FAILED',
            lastFailureCode: 'RECOVERY_REQUIRED',
          });
      }

      document = replaceTransaction(document, transaction);
      await this.writeDocument(document);
      return transaction;
    });
  }

  public prepare(input: ActivationPrepareInput): Promise<ActivationTransaction> {
    return this.serialize(async () => {
      const normalized = normalizePrepareInput(input);
      const document = await this.readDocument();
      const active = activeTransaction(document);
      if (active !== null) throw new RuntimeError('SUPERVISOR_BUSY', `Activation transaction ${active.transactionId} is already ${active.state}`);

      const candidate = await this.candidates.inspect(normalized.projectId, normalized.workspaceId, normalized.repositoryId);
      assertCandidateMatches(candidate, normalized);
      const runtime = await this.runtime.snapshot();
      assertRuntimePreparePreconditions(runtime, normalized);
      const now = new Date().toISOString();
      const transaction: ActivationTransaction = {
        transactionId: randomUUID(),
        state: 'PREPARED',
        projectId: normalized.projectId,
        workspaceId: normalized.workspaceId,
        repositoryId: normalized.repositoryId,
        expectedHead: normalized.expectedHead,
        expectedCandidateFingerprint: normalized.expectedCandidateFingerprint,
        expectedCurrentDeploymentEpoch: normalized.expectedCurrentDeploymentEpoch,
        expectedRuntimeId: normalized.expectedRuntimeId ?? null,
        expectedCatalogId: normalized.expectedCatalogId ?? null,
        candidate,
        preActivation: runtime,
        postApply: null,
        postRollback: null,
        createdAt: now,
        updatedAt: now,
        appliedAt: null,
        confirmedAt: null,
        rolledBackAt: null,
        lastFailureCode: null,
      };
      await this.writeDocument(appendTransaction(document, transaction));
      return transaction;
    });
  }

  public apply(transactionId: string): Promise<ActivationTransaction> {
    return this.serialize(async () => {
      const id = normalizeUuid(transactionId, 'transactionId');
      let document = await this.readDocument();
      let transaction = requireTransaction(document, id);
      if (transaction.state === 'APPLIED') return transaction;
      if (transaction.state !== 'PREPARED') throw invalidTransition(transaction.state, 'APPLIED');

      const candidate = await this.candidates.inspect(transaction.projectId, transaction.workspaceId, transaction.repositoryId);
      assertStoredCandidateMatches(candidate, transaction);
      const current = await this.runtime.snapshot();
      assertPreApplyRuntimeMatches(current, transaction);
      transaction = updateTransaction(transaction, { state: 'APPLYING', lastFailureCode: null });
      document = replaceTransaction(document, transaction);
      await this.writeDocument(document);
      try {
        const post = await this.runtime.applySourceRoot(candidate.sourceRoot, {
          head: candidate.head,
          candidateFingerprint: candidate.candidateFingerprint,
          trackedModifiedCount: candidate.trackedModifiedCount,
          fingerprintAlgorithm: candidate.fingerprintAlgorithm,
        });
        assertAppliedBinding(post, transaction);
        transaction = updateTransaction(transaction, {
          state: 'APPLIED',
          postApply: post,
          appliedAt: new Date().toISOString(),
          lastFailureCode: null,
        });
        await this.writeDocument(replaceTransaction(await this.readDocument(), transaction));
        return transaction;
      } catch (error) {
        transaction = updateTransaction(transaction, { state: 'APPLY_FAILED', lastFailureCode: runtimeErrorCode(error) });
        await this.writeDocument(replaceTransaction(await this.readDocument(), transaction));
        throw error;
      }
    });
  }

  public confirm(transactionId: string): Promise<ActivationTransaction> {
    return this.serialize(async () => {
      const id = normalizeUuid(transactionId, 'transactionId');
      let document = await this.readDocument();
      let transaction = requireTransaction(document, id);
      if (transaction.state === 'CONFIRMED') return transaction;
      if (transaction.state !== 'APPLIED' || transaction.postApply === null) throw invalidTransition(transaction.state, 'CONFIRMED');
      const candidate = await this.candidates.inspect(transaction.projectId, transaction.workspaceId, transaction.repositoryId);
      assertStoredCandidateMatches(candidate, transaction);
      const current = await this.runtime.snapshot();
      assertSnapshotIdentity(current, transaction.postApply, 'Post-apply runtime/catalog binding changed before confirmation');
      assertAppliedBinding(current, transaction);
      transaction = updateTransaction(transaction, { state: 'CONFIRMED', confirmedAt: new Date().toISOString(), lastFailureCode: null });
      document = replaceTransaction(document, transaction);
      await this.writeDocument(document);
      return transaction;
    });
  }

  public rollback(transactionId: string): Promise<ActivationTransaction> {
    return this.serialize(async () => {
      const id = normalizeUuid(transactionId, 'transactionId');
      let document = await this.readDocument();
      let transaction = requireTransaction(document, id);
      if (transaction.state === 'ROLLED_BACK') return transaction;
      if (transaction.state === 'CONFIRMED') throw invalidTransition(transaction.state, 'ROLLED_BACK');
      if (transaction.state !== 'PREPARED' && transaction.state !== 'APPLIED' && transaction.state !== 'APPLY_FAILED') {
        throw invalidTransition(transaction.state, 'ROLLED_BACK');
      }
      const requiresRuntimeRestore = transaction.state === 'APPLIED' || transaction.state === 'APPLY_FAILED';
      transaction = updateTransaction(transaction, { state: 'ROLLBACK_IN_PROGRESS', lastFailureCode: null });
      await this.writeDocument(replaceTransaction(document, transaction));
      try {
        const post = requiresRuntimeRestore
          ? await this.runtime.applySourceRoot(transaction.preActivation.workloadSourceRoot)
          : await this.runtime.snapshot();
        assertRolledBackBinding(post, transaction);
        transaction = updateTransaction(transaction, {
          state: 'ROLLED_BACK',
          postRollback: post,
          rolledBackAt: new Date().toISOString(),
          lastFailureCode: null,
        });
        document = replaceTransaction(await this.readDocument(), transaction);
        await this.writeDocument(document);
        return transaction;
      } catch (error) {
        transaction = updateTransaction(transaction, { state: 'APPLY_FAILED', lastFailureCode: runtimeErrorCode(error) });
        await this.writeDocument(replaceTransaction(await this.readDocument(), transaction));
        throw error;
      }
    });
  }

  private async readDocument(): Promise<ActivationTransactionDocument> {
    const filename = transactionPath(this.dataRoot);
    const content = await readFile(filename, 'utf8').catch((error: unknown) => isMissing(error) ? null : Promise.reject(error));
    if (content === null) return { schemaVersion: 1, transactions: [] };
    let parsed: unknown;
    try { parsed = JSON.parse(content) as unknown; }
    catch (error) { throw new RuntimeError('PERSISTENCE_FAILURE', 'Activation transaction store is invalid JSON', { cause: error }); }
    if (!isTransactionDocument(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Activation transaction store is invalid');
    return parsed;
  }

  private async writeDocument(document: ActivationTransactionDocument): Promise<void> {
    if (!isTransactionDocument(document)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to persist invalid activation transaction state');
    await writePrivateJsonAtomic(transactionPath(this.dataRoot), document);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function createProductionActivationController(dataRoot: string): Promise<ActivationController> {
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const resources = new VNextResourceRegistry(state, dataRoot);
  const git = new GovernedGitEngine(resources);
  const supervisor = await createSupervisor({ dataRoot });
  const controller = new ActivationController(
    dataRoot,
    new ProductionCandidateInspector(state, git),
    new ProductionRuntimeAdapter(dataRoot, supervisor),
  );
  await controller.recoverInterrupted();
  return controller;
}

class ProductionCandidateInspector implements ActivationCandidateInspector {
  public constructor(
    private readonly state: RuntimeState,
    private readonly git: GovernedGitEngine,
  ) {}

  public async inspect(projectId: string, workspaceId: string, repositoryId: string): Promise<ActivationCandidateSnapshot> {
    normalizeUuid(projectId, 'projectId');
    normalizeUuid(workspaceId, 'workspaceId');
    normalizeUuid(repositoryId, 'repositoryId');
    const project = (await this.state.listProjects()).find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new RuntimeError('PROJECT_NOT_FOUND', 'Activation project is not registered');
    const identity = await this.git.inspectRepository(projectId, workspaceId, repositoryId);
    if (identity.repositoryId !== repositoryId) throw new RuntimeError('CAPABILITY_DENIED', 'Activation repository identity mismatch');
    const sourceIdentity = await inspectActivationSourceIdentity(identity.workspaceRoot);
    await assertActivationWorkloadReady(identity.workspaceRoot);
    return {
      projectId,
      workspaceId,
      repositoryId,
      sourceRoot: identity.workspaceRoot,
      ...sourceIdentity,
    };
  }
}

class ProductionRuntimeAdapter implements ActivationRuntimeAdapter {
  public constructor(
    private readonly dataRoot: string,
    private readonly supervisor: Supervisor,
  ) {}

  public async snapshot(): Promise<ActivationRuntimeSnapshot> {
    const [admin, binding] = await Promise.all([
      readSupervisorAdminSnapshot(this.dataRoot),
      this.supervisor.workloadBinding(),
    ]);
    return {
      readiness: admin.readiness,
      runtimeId: admin.runtimeId,
      instanceId: admin.instanceId,
      catalogId: admin.fullCatalogId,
      deploymentEpoch: admin.deploymentEpoch,
      fullToolCount: admin.fullToolCount,
      proToolCount: admin.proToolCount,
      workloadSourceRoot: binding.sourceRoot,
    };
  }

  public async applySourceRoot(sourceRoot: string, sourceIdentity?: ActivationSourceIdentity): Promise<ActivationRuntimeSnapshot> {
    await this.supervisor.replaceWorkloadSourceRoot(sourceRoot, sourceIdentity);
    return this.snapshot();
  }
}

function assertCandidateMatches(candidate: ActivationCandidateSnapshot, expected: ReturnType<typeof normalizePrepareInput>): void {
  if (candidate.projectId !== expected.projectId || candidate.workspaceId !== expected.workspaceId || candidate.repositoryId !== expected.repositoryId) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Candidate project/workspace/repository identity mismatch');
  }
  if (candidate.head !== expected.expectedHead) throw new RuntimeError('PRECONDITION_FAILED', 'Candidate HEAD changed');
  if (candidate.candidateFingerprint !== expected.expectedCandidateFingerprint) throw new RuntimeError('PRECONDITION_FAILED', 'Candidate tracked fingerprint changed');
}

function assertStoredCandidateMatches(candidate: ActivationCandidateSnapshot, transaction: ActivationTransaction): void {
  if (candidate.projectId !== transaction.candidate.projectId || candidate.workspaceId !== transaction.candidate.workspaceId
    || candidate.repositoryId !== transaction.candidate.repositoryId || candidate.sourceRoot !== transaction.candidate.sourceRoot
    || candidate.head !== transaction.candidate.head || candidate.candidateFingerprint !== transaction.candidate.candidateFingerprint
    || candidate.trackedModifiedCount !== transaction.candidate.trackedModifiedCount) {
    throw new RuntimeError('PRECONDITION_FAILED', 'Prepared candidate identity is stale');
  }
}

function assertRuntimePreparePreconditions(runtime: ActivationRuntimeSnapshot, expected: ReturnType<typeof normalizePrepareInput>): void {
  if (runtime.readiness !== 'READY') throw new RuntimeError('PRECONDITION_FAILED', 'Persistent admin/runtime readiness must be READY before activation prepare');
  if (runtime.deploymentEpoch !== expected.expectedCurrentDeploymentEpoch) throw new RuntimeError('PRECONDITION_FAILED', 'Deployment epoch is stale');
  if (expected.expectedRuntimeId !== undefined && runtime.runtimeId !== expected.expectedRuntimeId) throw new RuntimeError('PRECONDITION_FAILED', 'Runtime identity is stale');
  if (expected.expectedCatalogId !== undefined && runtime.catalogId !== expected.expectedCatalogId) throw new RuntimeError('PRECONDITION_FAILED', 'Catalog identity is stale');
  if (runtime.runtimeId === null || runtime.instanceId === null || runtime.catalogId === null || runtime.deploymentEpoch === null
    || runtime.fullToolCount === null || runtime.proToolCount === null) {
    throw new RuntimeError('PRECONDITION_FAILED', 'Pre-activation runtime/catalog identity is incomplete');
  }
}

function assertPreApplyRuntimeMatches(current: ActivationRuntimeSnapshot, transaction: ActivationTransaction): void {
  assertSnapshotIdentity(current, transaction.preActivation, 'Pre-activation runtime/catalog identity changed after prepare');
  if (current.deploymentEpoch !== transaction.expectedCurrentDeploymentEpoch) throw new RuntimeError('PRECONDITION_FAILED', 'Deployment epoch changed after prepare');
}

function assertAppliedBinding(snapshot: ActivationRuntimeSnapshot, transaction: ActivationTransaction): void {
  if (snapshot.readiness !== 'READY') throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Activated workload did not reach READY through the persistent admin surface');
  if (snapshot.workloadSourceRoot !== transaction.candidate.sourceRoot) throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Activated workload source binding does not match the prepared candidate');
  if (snapshot.runtimeId === null || snapshot.instanceId === null || snapshot.catalogId === null || snapshot.deploymentEpoch === null
    || snapshot.fullToolCount === null || snapshot.proToolCount === null) {
    throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Activated workload identity is incomplete');
  }
  if (snapshot.runtimeId !== transaction.preActivation.runtimeId) {
    throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Activation changed the persistent runtime identity');
  }
  if (snapshot.instanceId === transaction.preActivation.instanceId) {
    throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Activation did not replace the workload runtime instance');
  }
  if (snapshot.proToolCount !== transaction.preActivation.proToolCount) {
    throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Activation changed the bounded PRO tool count');
  }
  if (snapshot.deploymentEpoch <= transaction.expectedCurrentDeploymentEpoch) {
    throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Activation did not advance the deployment epoch');
  }
}

function assertRolledBackBinding(snapshot: ActivationRuntimeSnapshot, transaction: ActivationTransaction): void {
  const expected = transaction.preActivation;
  if (snapshot.readiness !== 'READY' || snapshot.workloadSourceRoot !== expected.workloadSourceRoot) {
    throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Rollback did not restore the captured prior workload binding');
  }
  if (snapshot.runtimeId === null || snapshot.instanceId === null || snapshot.catalogId === null || snapshot.deploymentEpoch === null) {
    throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Rolled-back workload identity is incomplete');
  }
  if (snapshot.runtimeId !== expected.runtimeId || snapshot.catalogId !== expected.catalogId) {
    throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Rollback did not restore the captured runtime/catalog identity');
  }
  if (expected.fullToolCount !== null && snapshot.fullToolCount !== expected.fullToolCount) {
    throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Rollback did not restore the captured FULL tool count');
  }
  if (expected.proToolCount !== null && snapshot.proToolCount !== expected.proToolCount) {
    throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Rollback did not restore the captured PRO tool count');
  }
  if (expected.deploymentEpoch !== null && snapshot.deploymentEpoch < expected.deploymentEpoch) {
    throw new RuntimeError('RUNTIME_IDENTITY_MISMATCH', 'Rollback moved the deployment epoch backwards');
  }
}

function assertSnapshotIdentity(current: ActivationRuntimeSnapshot, expected: ActivationRuntimeSnapshot, message: string): void {
  if (current.runtimeId !== expected.runtimeId || current.instanceId !== expected.instanceId || current.catalogId !== expected.catalogId
    || current.deploymentEpoch !== expected.deploymentEpoch || current.workloadSourceRoot !== expected.workloadSourceRoot
    || expected.fullToolCount !== null && current.fullToolCount !== expected.fullToolCount
    || expected.proToolCount !== null && current.proToolCount !== expected.proToolCount) {
    throw new RuntimeError('PRECONDITION_FAILED', message);
  }
}

function normalizePrepareInput(input: ActivationPrepareInput) {
  const expectedHead = input.expectedHead.trim().toLowerCase();
  const expectedCandidateFingerprint = input.expectedCandidateFingerprint.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedHead)) throw new RuntimeError('INVALID_REQUEST', 'expectedHead must be a full 40-hex Git commit');
  if (!/^[0-9a-f]{64}$/.test(expectedCandidateFingerprint)) throw new RuntimeError('INVALID_REQUEST', 'expectedCandidateFingerprint must be a 64-hex SHA-256');
  if (!Number.isSafeInteger(input.expectedCurrentDeploymentEpoch) || input.expectedCurrentDeploymentEpoch <= 0) throw new RuntimeError('INVALID_REQUEST', 'expectedCurrentDeploymentEpoch is invalid');
  const expectedRuntimeId = input.expectedRuntimeId?.trim();
  const expectedCatalogId = input.expectedCatalogId?.trim();
  if (expectedRuntimeId !== undefined && (expectedRuntimeId.length === 0 || expectedRuntimeId.length > 200)) throw new RuntimeError('INVALID_REQUEST', 'expectedRuntimeId is invalid');
  if (expectedCatalogId !== undefined && !/^sha256:[0-9a-f]{64}$/.test(expectedCatalogId)) throw new RuntimeError('INVALID_REQUEST', 'expectedCatalogId is invalid');
  return {
    projectId: normalizeUuid(input.projectId, 'projectId'),
    workspaceId: normalizeUuid(input.workspaceId, 'workspaceId'),
    repositoryId: normalizeUuid(input.repositoryId, 'repositoryId'),
    expectedHead,
    expectedCandidateFingerprint,
    expectedCurrentDeploymentEpoch: input.expectedCurrentDeploymentEpoch,
    ...(expectedRuntimeId === undefined ? {} : { expectedRuntimeId }),
    ...(expectedCatalogId === undefined ? {} : { expectedCatalogId }),
  };
}

function normalizeUuid(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) throw new RuntimeError('INVALID_REQUEST', `${label} is invalid`);
  return normalized;
}

function activeTransaction(document: ActivationTransactionDocument): ActivationTransaction | null {
  const active = document.transactions.filter((transaction) => transaction.state !== 'CONFIRMED' && transaction.state !== 'ROLLED_BACK');
  if (active.length > 1) throw new RuntimeError('PERSISTENCE_FAILURE', 'Multiple non-terminal activation transactions exist');
  return active[0] ?? null;
}

function requireTransaction(document: ActivationTransactionDocument, id: string): ActivationTransaction {
  const transaction = document.transactions.find((candidate) => candidate.transactionId === id);
  if (transaction === undefined) throw new RuntimeError('INVALID_REQUEST', 'Activation transaction was not found');
  return transaction;
}

function appendTransaction(document: ActivationTransactionDocument, transaction: ActivationTransaction): ActivationTransactionDocument {
  if (document.transactions.length >= MAX_TRANSACTIONS) {
    const terminal = document.transactions.filter((candidate) => candidate.state === 'CONFIRMED' || candidate.state === 'ROLLED_BACK');
    if (terminal.length === 0) throw new RuntimeError('PERSISTENCE_FAILURE', 'Activation transaction history capacity is exhausted');
    const oldestTerminal = terminal[0]!;
    return { schemaVersion: 1, transactions: [...document.transactions.filter((candidate) => candidate.transactionId !== oldestTerminal.transactionId), transaction] };
  }
  return { schemaVersion: 1, transactions: [...document.transactions, transaction] };
}

function replaceTransaction(document: ActivationTransactionDocument, transaction: ActivationTransaction): ActivationTransactionDocument {
  let found = false;
  const transactions = document.transactions.map((candidate) => {
    if (candidate.transactionId !== transaction.transactionId) return candidate;
    found = true;
    return transaction;
  });
  if (!found) throw new RuntimeError('PERSISTENCE_FAILURE', 'Activation transaction disappeared during update');
  return { schemaVersion: 1, transactions };
}

function updateTransaction(transaction: ActivationTransaction, changes: Partial<ActivationTransaction>): ActivationTransaction {
  return { ...transaction, ...changes, transactionId: transaction.transactionId, updatedAt: new Date().toISOString() };
}

function invalidTransition(from: ActivationTransactionState, to: ActivationTransactionState): RuntimeError {
  return new RuntimeError('PRECONDITION_FAILED', `Activation transaction cannot transition from ${from} to ${to}`);
}

function transactionPath(dataRoot: string): string {
  return path.join(dataRoot, 'supervisor', TRANSACTION_FILE);
}

function isTransactionDocument(value: unknown): value is ActivationTransactionDocument {
  return isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.transactions)
    && value.transactions.length <= MAX_TRANSACTIONS && value.transactions.every(isTransaction)
    && new Set(value.transactions.map((candidate) => candidate.transactionId)).size === value.transactions.length;
}

function isTransaction(value: unknown): value is ActivationTransaction {
  if (!isRecord(value) || !isUuid(value.transactionId) || !isActivationState(value.state)
    || !isUuid(value.projectId) || !isUuid(value.workspaceId) || !isUuid(value.repositoryId)
    || typeof value.expectedHead !== 'string' || !/^[0-9a-f]{40}$/.test(value.expectedHead)
    || typeof value.expectedCandidateFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedCandidateFingerprint)
    || !isPositiveInteger(value.expectedCurrentDeploymentEpoch)
    || !(value.expectedRuntimeId === null || typeof value.expectedRuntimeId === 'string')
    || !(value.expectedCatalogId === null || typeof value.expectedCatalogId === 'string')
    || !isCandidate(value.candidate) || !isRuntimeSnapshot(value.preActivation)
    || !(value.postApply === null || isRuntimeSnapshot(value.postApply))
    || !(value.postRollback === null || isRuntimeSnapshot(value.postRollback))) return false;
  for (const key of ['createdAt', 'updatedAt'] as const) if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key]))) return false;
  for (const key of ['appliedAt', 'confirmedAt', 'rolledBackAt'] as const) if (!(value[key] === null || typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key])))) return false;
  return value.lastFailureCode === null || typeof value.lastFailureCode === 'string';
}

function isCandidate(value: unknown): value is ActivationCandidateSnapshot {
  return isRecord(value) && isUuid(value.projectId) && isUuid(value.workspaceId) && isUuid(value.repositoryId)
    && typeof value.sourceRoot === 'string' && path.isAbsolute(value.sourceRoot)
    && typeof value.head === 'string' && /^[0-9a-f]{40}$/.test(value.head)
    && typeof value.candidateFingerprint === 'string' && /^[0-9a-f]{64}$/.test(value.candidateFingerprint)
    && typeof value.trackedModifiedCount === 'number' && Number.isSafeInteger(value.trackedModifiedCount) && value.trackedModifiedCount >= 0
    && value.fingerprintAlgorithm === FINGERPRINT_ALGORITHM;
}

function isRuntimeSnapshot(value: unknown): value is ActivationRuntimeSnapshot {
  return isRecord(value) && (value.readiness === 'READY' || value.readiness === 'DEGRADED')
    && (value.runtimeId === null || typeof value.runtimeId === 'string')
    && (value.instanceId === null || typeof value.instanceId === 'string')
    && (value.catalogId === null || typeof value.catalogId === 'string')
    && (value.deploymentEpoch === null || isPositiveInteger(value.deploymentEpoch))
    && (value.fullToolCount === null || isNonNegativeInteger(value.fullToolCount))
    && (value.proToolCount === null || isNonNegativeInteger(value.proToolCount))
    && typeof value.workloadSourceRoot === 'string' && path.isAbsolute(value.workloadSourceRoot);
}

function isActivationState(value: unknown): value is ActivationTransactionState {
  return value === 'PREPARED' || value === 'APPLYING' || value === 'APPLIED' || value === 'APPLY_FAILED'
    || value === 'CONFIRMED' || value === 'ROLLBACK_IN_PROGRESS' || value === 'ROLLED_BACK';
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function runtimeErrorCode(error: unknown): string { return error instanceof RuntimeError ? error.code : 'PERSISTENCE_FAILURE'; }
