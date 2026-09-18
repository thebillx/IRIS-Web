import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeError } from '@iris/domain';
import {
  ActivationController,
  type ActivationCandidateInspector,
  type ActivationCandidateSnapshot,
  type ActivationPrepareInput,
  type ActivationRuntimeAdapter,
  type ActivationRuntimeSnapshot,
} from './activation-controller.js';

const roots: string[] = [];
const HEAD = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);
const CATALOG_A = `sha256:${'1'.repeat(64)}`;
const CATALOG_B = `sha256:${'2'.repeat(64)}`;
const SOURCE_A = '/synthetic/activation/a';
const SOURCE_B = '/synthetic/activation/b';

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('persistent activation controller', () => {
  it('reports current runtime and no active transaction initially', async () => {
    const harness = await createHarness();
    const status = await harness.controller.status();
    expect(status.runtime).toEqual(harness.runtime.current);
    expect(status.transaction).toBeNull();
    expect(status.activeTransactionId).toBeNull();
  });

  it('prepares one durable identity-bound transaction and exposes it through status', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    expect(prepared).toMatchObject({
      state: 'PREPARED',
      projectId: harness.projectId,
      workspaceId: harness.workspaceId,
      repositoryId: harness.repositoryId,
      expectedHead: HEAD,
      expectedCandidateFingerprint: FINGERPRINT,
    });
    const status = await harness.controller.status();
    expect(status.activeTransactionId).toBe(prepared.transactionId);
    expect(status.transaction?.transactionId).toBe(prepared.transactionId);
    expect(status.transaction?.preActivation.workloadSourceRoot).toBe(SOURCE_A);
  });

  it('rejects cross-project activation', async () => {
    const harness = await createHarness();
    await expect(harness.controller.prepare({ ...harness.input(), projectId: randomUUID() }))
      .rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('rejects cross-workspace activation', async () => {
    const harness = await createHarness();
    await expect(harness.controller.prepare({ ...harness.input(), workspaceId: randomUUID() }))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rejects cross-repository activation', async () => {
    const harness = await createHarness();
    await expect(harness.controller.prepare({ ...harness.input(), repositoryId: randomUUID() }))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rejects a stale or wrong HEAD', async () => {
    const harness = await createHarness();
    await expect(harness.controller.prepare({ ...harness.input(), expectedHead: 'c'.repeat(40) }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects a stale or wrong tracked candidate fingerprint', async () => {
    const harness = await createHarness();
    await expect(harness.controller.prepare({ ...harness.input(), expectedCandidateFingerprint: 'd'.repeat(64) }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects a stale deployment epoch', async () => {
    const harness = await createHarness();
    await expect(harness.controller.prepare({ ...harness.input(), expectedCurrentDeploymentEpoch: 9 }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects stale runtime and catalog identities when supplied', async () => {
    const harness = await createHarness();
    await expect(harness.controller.prepare({ ...harness.input(), expectedRuntimeId: 'runtime-stale' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(harness.controller.prepare({ ...harness.input(), expectedCatalogId: `sha256:${'f'.repeat(64)}` }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('serializes concurrent prepare and permits only one active transaction', async () => {
    const harness = await createHarness();
    const results = await Promise.allSettled([
      harness.controller.prepare(harness.input()),
      harness.controller.prepare(harness.input()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'SUPERVISOR_BUSY' });
  });

  it('rejects apply for an unknown transaction', async () => {
    const harness = await createHarness();
    await expect(harness.controller.apply(randomUUID())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(harness.runtime.appliedRoots).toEqual([]);
  });

  it('applies only a prepared transaction and advances the synthetic target binding', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    const applied = await harness.controller.apply(prepared.transactionId);
    expect(applied.state).toBe('APPLIED');
    expect(applied.postApply).toMatchObject({ workloadSourceRoot: SOURCE_B, readiness: 'READY', deploymentEpoch: 11 });
    expect(harness.runtime.current.workloadSourceRoot).toBe(SOURCE_B);
    expect(harness.runtime.appliedRoots).toEqual([SOURCE_B]);
    expect(harness.runtime.appliedSourceIdentities).toEqual([{
      head: HEAD,
      candidateFingerprint: FINGERPRINT,
      trackedModifiedCount: 3,
      fingerprintAlgorithm: 'sha256:sorted-tracked-path-content-v1',
    }]);
  });

  it('recovers interrupted APPLYING as APPLIED when the prepared candidate runtime already reached READY', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    await forceTransactionState(harness.dataRoot, prepared.transactionId, 'APPLYING');
    harness.runtime.current = {
      readiness: 'READY',
      runtimeId: 'runtime-a',
      instanceId: 'instance-b-11',
      catalogId: CATALOG_B,
      deploymentEpoch: 11,
      fullToolCount: 50,
      proToolCount: 5,
      workloadSourceRoot: SOURCE_B,
    };
    const restarted = new ActivationController(harness.dataRoot, harness.inspector, harness.runtime) as unknown as {
      recoverInterrupted(): Promise<{
        state: string;
        postApply: ActivationRuntimeSnapshot | null;
        postRollback: ActivationRuntimeSnapshot | null;
        lastFailureCode: string | null;
      } | null>;
    };
    const recovered = await restarted.recoverInterrupted();
    expect(recovered?.state).toBe('APPLIED');
    expect(recovered?.postApply).toEqual(harness.runtime.current);
    expect(recovered?.lastFailureCode).toBeNull();
  });

  it('recovers interrupted rollback as ROLLED_BACK when the captured baseline is already READY again', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    await harness.controller.apply(prepared.transactionId);
    await forceTransactionState(harness.dataRoot, prepared.transactionId, 'ROLLBACK_IN_PROGRESS');
    harness.runtime.current = {
      readiness: 'READY',
      runtimeId: 'runtime-a',
      instanceId: 'instance-a-12',
      catalogId: CATALOG_A,
      deploymentEpoch: 12,
      fullToolCount: 48,
      proToolCount: 5,
      workloadSourceRoot: SOURCE_A,
    };
    const restarted = new ActivationController(harness.dataRoot, harness.inspector, harness.runtime) as unknown as {
      recoverInterrupted(): Promise<{
        state: string;
        postApply: ActivationRuntimeSnapshot | null;
        postRollback: ActivationRuntimeSnapshot | null;
        lastFailureCode: string | null;
      } | null>;
    };
    const recovered = await restarted.recoverInterrupted();
    expect(recovered?.state).toBe('ROLLED_BACK');
    expect(recovered?.postRollback).toEqual(harness.runtime.current);
    expect(recovered?.lastFailureCode).toBeNull();
  });

  it('fails closed to APPLY_FAILED when interrupted activation outcome is ambiguous and remains explicitly rollbackable', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    await forceTransactionState(harness.dataRoot, prepared.transactionId, 'APPLYING');
    harness.runtime.current = {
      ...harness.runtime.current,
      readiness: 'DEGRADED',
      instanceId: 'instance-ambiguous',
      workloadSourceRoot: SOURCE_B,
    };
    const restarted = new ActivationController(harness.dataRoot, harness.inspector, harness.runtime) as unknown as {
      recoverInterrupted(): Promise<{
        state: string;
        postApply: ActivationRuntimeSnapshot | null;
        postRollback: ActivationRuntimeSnapshot | null;
        lastFailureCode: string | null;
      } | null>;
      rollback(transactionId: string): Promise<{ state: string }>;
    };
    const recovered = await restarted.recoverInterrupted();
    expect(recovered?.state).toBe('APPLY_FAILED');
    expect(recovered?.lastFailureCode).toBe('RECOVERY_REQUIRED');
    const rolled = await restarted.rollback(prepared.transactionId);
    expect(rolled.state).toBe('ROLLED_BACK');
    expect(harness.runtime.current.workloadSourceRoot).toBe(SOURCE_A);
  });

  it('rejects confirm before apply', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    await expect(harness.controller.confirm(prepared.transactionId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('confirms only an applied transaction whose live identity remains unchanged', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    const applied = await harness.controller.apply(prepared.transactionId);
    const confirmed = await harness.controller.confirm(applied.transactionId);
    expect(confirmed.state).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).not.toBeNull();
    expect((await harness.controller.status()).activeTransactionId).toBeNull();
  });

  it('rejects confirmation after the post-apply live identity drifts', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    const applied = await harness.controller.apply(prepared.transactionId);
    harness.runtime.current = { ...harness.runtime.current, instanceId: 'instance-drifted' };
    await expect(harness.controller.confirm(applied.transactionId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rolls back a prepared-only transaction without replacing workload runtime', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    const rolled = await harness.controller.rollback(prepared.transactionId);
    expect(rolled.state).toBe('ROLLED_BACK');
    expect(rolled.postRollback?.workloadSourceRoot).toBe(SOURCE_A);
    expect(harness.runtime.appliedRoots).toEqual([]);
  });

  it('rolls back an applied transaction using only its captured prior binding', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    await harness.controller.apply(prepared.transactionId);
    const rolled = await harness.controller.rollback(prepared.transactionId);
    expect(rolled.state).toBe('ROLLED_BACK');
    expect(rolled.postRollback).toMatchObject({ workloadSourceRoot: SOURCE_A, readiness: 'READY' });
    expect(harness.runtime.appliedRoots).toEqual([SOURCE_B, SOURCE_A]);
  });

  it('restores the captured prior binding after a failed apply', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    harness.runtime.failNextApplyAfterMutation = true;
    await expect(harness.controller.apply(prepared.transactionId)).rejects.toMatchObject({ code: 'RUNTIME_NOT_RUNNING' });
    expect(harness.runtime.current.workloadSourceRoot).toBe(SOURCE_B);
    const rolled = await harness.controller.rollback(prepared.transactionId);
    expect(rolled.state).toBe('ROLLED_BACK');
    expect(harness.runtime.current.workloadSourceRoot).toBe(SOURCE_A);
    expect(harness.runtime.appliedRoots).toEqual([SOURCE_B, SOURCE_A]);
  });

  it('makes duplicate apply idempotent and does not replace workload twice', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    const first = await harness.controller.apply(prepared.transactionId);
    const second = await harness.controller.apply(prepared.transactionId);
    expect(second).toEqual(first);
    expect(harness.runtime.appliedRoots).toEqual([SOURCE_B]);
  });

  it('makes duplicate rollback idempotent and does not restore twice', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    await harness.controller.apply(prepared.transactionId);
    const first = await harness.controller.rollback(prepared.transactionId);
    const second = await harness.controller.rollback(prepared.transactionId);
    expect(second).toEqual(first);
    expect(harness.runtime.appliedRoots).toEqual([SOURCE_B, SOURCE_A]);
  });

  it('rejects a stale prepared candidate before workload replacement', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    harness.inspector.candidate = { ...harness.inspector.candidate, candidateFingerprint: 'e'.repeat(64) };
    await expect(harness.controller.apply(prepared.transactionId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(harness.runtime.appliedRoots).toEqual([]);
  });

  it('rejects stale runtime/epoch state after prepare before workload replacement', async () => {
    const harness = await createHarness();
    const prepared = await harness.controller.prepare(harness.input());
    harness.runtime.current = { ...harness.runtime.current, deploymentEpoch: 11, instanceId: 'instance-stale' };
    await expect(harness.controller.apply(prepared.transactionId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(harness.runtime.appliedRoots).toEqual([]);
  });

  it('rejects confirm after rollback and rollback after confirm', async () => {
    const rolledHarness = await createHarness();
    const prepared = await rolledHarness.controller.prepare(rolledHarness.input());
    await rolledHarness.controller.rollback(prepared.transactionId);
    await expect(rolledHarness.controller.confirm(prepared.transactionId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const confirmedHarness = await createHarness();
    const prepared2 = await confirmedHarness.controller.prepare(confirmedHarness.input());
    await confirmedHarness.controller.apply(prepared2.transactionId);
    await confirmedHarness.controller.confirm(prepared2.transactionId);
    await expect(confirmedHarness.controller.rollback(prepared2.transactionId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects replay of an old transaction after a later transaction becomes active', async () => {
    const harness = await createHarness();
    const first = await harness.controller.prepare(harness.input());
    await harness.controller.rollback(first.transactionId);
    const second = await harness.controller.prepare({ ...harness.input(), expectedCurrentDeploymentEpoch: harness.runtime.current.deploymentEpoch! });
    await expect(harness.controller.apply(first.transactionId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await harness.controller.status()).activeTransactionId).toBe(second.transactionId);
  });

  it('returns null for a valid but unknown transaction id and rejects malformed ids', async () => {
    const harness = await createHarness();
    expect((await harness.controller.status(randomUUID())).transaction).toBeNull();
    await expect(harness.controller.status('not-a-uuid')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

class FakeCandidateInspector implements ActivationCandidateInspector {
  public constructor(
    public candidate: ActivationCandidateSnapshot,
    private readonly allowedProjectId: string,
    private readonly allowedWorkspaceId: string,
    private readonly allowedRepositoryId: string,
  ) {}

  public async inspect(projectId: string, workspaceId: string, repositoryId: string): Promise<ActivationCandidateSnapshot> {
    if (projectId !== this.allowedProjectId) throw new RuntimeError('PROJECT_NOT_FOUND', 'synthetic project mismatch');
    if (workspaceId !== this.allowedWorkspaceId) throw new RuntimeError('CAPABILITY_DENIED', 'synthetic workspace mismatch');
    if (repositoryId !== this.allowedRepositoryId) throw new RuntimeError('CAPABILITY_DENIED', 'synthetic repository mismatch');
    return { ...this.candidate };
  }
}

class FakeRuntimeAdapter implements ActivationRuntimeAdapter {
  public appliedRoots: string[] = [];
  public appliedSourceIdentities: Array<{
    readonly head: string;
    readonly candidateFingerprint: string;
    readonly trackedModifiedCount: number;
    readonly fingerprintAlgorithm: 'sha256:sorted-tracked-path-content-v1';
  } | undefined> = [];
  public failNextApplyAfterMutation = false;

  public constructor(public current: ActivationRuntimeSnapshot) {}

  public async snapshot(): Promise<ActivationRuntimeSnapshot> {
    return { ...this.current };
  }

  public async applySourceRoot(sourceRoot: string, sourceIdentity?: {
    readonly head: string;
    readonly candidateFingerprint: string;
    readonly trackedModifiedCount: number;
    readonly fingerprintAlgorithm: 'sha256:sorted-tracked-path-content-v1';
  }): Promise<ActivationRuntimeSnapshot> {
    this.appliedRoots.push(sourceRoot);
    this.appliedSourceIdentities.push(sourceIdentity);
    const nextEpoch = (this.current.deploymentEpoch ?? 0) + 1;
    const isTarget = sourceRoot === SOURCE_B;
    this.current = {
      ...this.current,
      readiness: 'READY',
      workloadSourceRoot: sourceRoot,
      runtimeId: 'runtime-a',
      instanceId: isTarget ? `instance-b-${nextEpoch}` : `instance-a-${nextEpoch}`,
      catalogId: isTarget ? CATALOG_B : CATALOG_A,
      deploymentEpoch: nextEpoch,
      fullToolCount: isTarget ? 50 : 48,
      proToolCount: 5,
    };
    if (this.failNextApplyAfterMutation) {
      this.failNextApplyAfterMutation = false;
      throw new RuntimeError('RUNTIME_NOT_RUNNING', 'synthetic apply failed after target mutation');
    }
    return { ...this.current };
  }
}

async function forceTransactionState(dataRoot: string, transactionId: string, state: 'APPLYING' | 'ROLLBACK_IN_PROGRESS'): Promise<void> {
  const filename = path.join(dataRoot, 'supervisor', 'activation-transactions.json');
  const document = JSON.parse(await readFile(filename, 'utf8')) as {
    schemaVersion: number;
    transactions: Array<Record<string, unknown>>;
  };
  let found = false;
  document.transactions = document.transactions.map((transaction) => {
    if (transaction.transactionId !== transactionId) return transaction;
    found = true;
    return { ...transaction, state, updatedAt: new Date().toISOString() };
  });
  if (!found) throw new Error('synthetic activation transaction was not found');
  await writeFile(filename, JSON.stringify(document) + '\n', { mode: 0o600 });
}

async function createHarness() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-activation-controller-'));
  roots.push(dataRoot);
  await mkdir(path.join(dataRoot, 'supervisor'), { recursive: true, mode: 0o700 });
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const repositoryId = randomUUID();
  const inspector = new FakeCandidateInspector({
    projectId,
    workspaceId,
    repositoryId,
    sourceRoot: SOURCE_B,
    head: HEAD,
    candidateFingerprint: FINGERPRINT,
    trackedModifiedCount: 3,
    fingerprintAlgorithm: 'sha256:sorted-tracked-path-content-v1',
  }, projectId, workspaceId, repositoryId);
  const runtime = new FakeRuntimeAdapter({
    readiness: 'READY',
    runtimeId: 'runtime-a',
    instanceId: 'instance-a',
    catalogId: CATALOG_A,
    deploymentEpoch: 10,
    fullToolCount: 48,
    proToolCount: 5,
    workloadSourceRoot: SOURCE_A,
  });
  const controller = new ActivationController(dataRoot, inspector, runtime);
  const input = (): ActivationPrepareInput => ({
    projectId,
    workspaceId,
    repositoryId,
    expectedHead: HEAD,
    expectedCandidateFingerprint: FINGERPRINT,
    expectedCurrentDeploymentEpoch: runtime.current.deploymentEpoch!,
    expectedRuntimeId: runtime.current.runtimeId!,
    expectedCatalogId: runtime.current.catalogId!,
  });
  return { dataRoot, projectId, workspaceId, repositoryId, inspector, runtime, controller, input };
}
