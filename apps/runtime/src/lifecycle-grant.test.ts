import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateOwnerAccessSecret } from './persistence.js';
import { LifecycleGrantStore, type LifecycleGrantBinding, type LifecycleGrantSpec } from './lifecycle-grant.js';

const roots: string[] = [];
const binding: LifecycleGrantBinding = {
  machineId: '11111111-1111-4111-8111-111111111111',
  tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourceRoot: '/tmp/iris-source',
  sourceSha: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  workloadSourceRoot: '/tmp/iris-workload',
  workloadSourceSha: 'c'.repeat(40),
  workloadSourceTree: 'd'.repeat(40),
};

afterEach(async () => { vi.restoreAllMocks();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; store: LifecycleGrantStore; spec: LifecycleGrantSpec }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-lifecycle-grant-'));
  roots.push(root);
  await loadOrCreateOwnerAccessSecret(root);
  return {
    root,
    store: new LifecycleGrantStore(root),
    spec: {
      ...binding,
      requestId: '22222222-2222-4222-8222-222222222222',
      allowedOperations: ['runtime_on', 'runtime_off'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxOperationCount: 2,
    },
  };
}

describe('owner-bound runtime lifecycle grants', () => {
  it('binds issuance and consumption to the exact machine, tunnel, source and request', async () => {
    const f = await fixture();
    const grant = await f.store.issue(f.spec);
    await expect(f.store.reserve(binding, 'runtime_on', { grantId: grant.grantId, requestId: grant.requestId, operationId: 'op-1' })).resolves.toMatchObject({ grantId: grant.grantId });
    await f.store.complete(grant.grantId, 'op-1', 'COMMITTED', { state: 'RUNNING' });
    await expect(f.store.reserve(binding, 'runtime_off', { grantId: grant.grantId, requestId: grant.requestId, operationId: 'op-1' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(f.store.reserve({ ...binding, tunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, 'runtime_off', { grantId: grant.grantId, requestId: grant.requestId, operationId: 'op-2' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(f.store.reserve({ ...binding, workloadSourceTree: 'e'.repeat(40) }, 'runtime_off', { grantId: grant.grantId, requestId: grant.requestId, operationId: 'op-3' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(f.store.reserve(binding, 'runtime_off', { grantId: grant.grantId, requestId: '33333333-3333-4333-8333-333333333333', operationId: 'op-2' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });

  it('fails closed for expiry, revocation, and unresolved outcomes', async () => {
    const f = await fixture();
    const grant = await f.store.issue(f.spec);
    await f.store.reserve(binding, 'runtime_on', { grantId: grant.grantId, requestId: grant.requestId, operationId: 'op-unknown' });
    await expect(f.store.reserve(binding, 'runtime_off', { grantId: grant.grantId, requestId: grant.requestId, operationId: 'op-retry' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await f.store.complete(grant.grantId, 'op-unknown', 'RECONCILIATION_REQUIRED');
    await expect(f.store.reserve(binding, 'runtime_off', { grantId: grant.grantId, requestId: grant.requestId, operationId: 'op-retry' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await f.store.reconcile(grant.grantId, 'op-unknown', 'FAILED', { observedState: 'stopped', operation: 'runtime_on' });
    await f.store.reserve(binding, 'runtime_off', { grantId: grant.grantId, requestId: grant.requestId, operationId: 'op-retry' });

    const revoked = await f.store.issue({ ...f.spec, requestId: '44444444-4444-4444-8444-444444444444' });
    await f.store.revoke(revoked.grantId);
    await expect(f.store.reserve(binding, 'runtime_on', { grantId: revoked.grantId, requestId: revoked.requestId, operationId: 'op-revoked' })).rejects.toMatchObject({ code: 'CONTROL_DENIED' });

    const expired = await f.store.issue({ ...f.spec, requestId: '55555555-5555-4555-8555-555555555555', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expired.expiresAt) + 1);
    await expect(f.store.reserve(binding, 'runtime_on', { grantId: expired.grantId, requestId: expired.requestId, operationId: 'op-expired' })).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  });

  it('rejects tampered durable state and serializes concurrent consumption', async () => {
    const f = await fixture();
    const grant = await f.store.issue(f.spec);
    const results = await Promise.allSettled([
      f.store.reserve(binding, 'runtime_on', { grantId: grant.grantId, requestId: grant.requestId, operationId: 'op-a' }),
      f.store.reserve(binding, 'runtime_off', { grantId: grant.grantId, requestId: grant.requestId, operationId: 'op-b' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const filename = path.join(f.root, 'runtime-lifecycle-grants.json');
    const original = JSON.parse(await readFile(filename, 'utf8')) as { grants: unknown[] };
    await writeFile(filename, `${JSON.stringify({ ...original, grants: [] })}\n`, { mode: 0o600 });
    await expect(f.store.read()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('does not allow reconciliation to choose a terminal state for a reserved operation', async () => {
    const f = await fixture();
    const grant = await f.store.issue(f.spec);
    await f.store.reserve(binding, 'runtime_on', { grantId: grant.grantId, requestId: grant.requestId, operationId: 'op-reserved' });
    await expect(f.store.reconcile(grant.grantId, 'op-reserved', 'FAILED', { observedState: 'stopped' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(f.store.reconcile(grant.grantId, 'op-reserved', 'FAILED', { observedState: 'stopped' }, true)).resolves.toBeUndefined();
  });
});

describe('paired workload restart journal', () => {
  const target = { pid: 123, processStartMarker: '123:456', runtimeId: 'runtime-before', instanceId: 'instance-before' };

  async function restartFixture() {
    const f = await fixture();
    const grant = await f.store.issue(f.spec);
    const execution = { grantId: grant.grantId, requestId: grant.requestId, operationId: randomUUID() };
    return { ...f, grant, execution, filename: path.join(f.root, 'runtime-lifecycle-grants.json') };
  }

  it('reserves both operations once and returns an immutable terminal replay', async () => {
    const f = await restartFixture();
    const attempts = await Promise.all([f.store.beginRestart(binding, f.execution, target), f.store.beginRestart(binding, f.execution, target)]);
    expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
    expect(attempts[0]!.record).toEqual(attempts[1]!.record);
    const record = attempts[0]!.record;
    expect(record).toMatchObject({ requestId: f.execution.operationId, grantId: f.grant.grantId, state: 'PENDING', phase: 'OFF_RESERVED', capturedTarget: target });
    expect(record.offOperationId).not.toBe(record.onOperationId);
    expect(record.offOperationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(record.onOperationId).toMatch(/^[a-f0-9-]{36}$/);
    expect((await f.store.get(f.grant.grantId)).operations).toMatchObject([{ operation: 'runtime_off', state: 'RESERVED' }, { operation: 'runtime_on', state: 'RESERVED' }]);
    await expect(f.store.authorizeRestartOn(binding, f.execution)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(f.store.complete(f.grant.grantId, record.offOperationId, 'COMMITTED')).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(f.store.reconcile(f.grant.grantId, record.offOperationId, 'FAILED', { observed: 'stopped' }, true)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await f.store.advanceRestartOff(f.grant.grantId, record.requestId, { targetDead: target });
    await expect(f.store.authorizeRestartOn(binding, f.execution)).resolves.toMatchObject({ phase: 'ON_RESERVED' });
    await f.store.completeRestartOn(f.grant.grantId, record.requestId, 'RUNNING', { runtimeInstance: 'replacement-instance' });
    await expect(f.store.assertNoUnresolvedRestart()).resolves.toBeUndefined();
    const before = await readFile(f.filename);
    await expect(f.store.beginRestart(binding, f.execution, target)).resolves.toMatchObject({ created: false, record: { state: 'RUNNING', phase: 'COMPLETE', offOperationId: record.offOperationId, onOperationId: record.onOperationId } });
    await expect(f.store.issue(f.spec)).resolves.toMatchObject({ grantId: f.grant.grantId });
    expect(await readFile(f.filename)).toEqual(before);
    await expect(f.store.reserve(binding, 'runtime_on', { ...f.execution, operationId: 'after-pair' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(f.store.beginRestart({ ...binding, workloadSourceTree: 'e'.repeat(40) }, f.execution, target)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(f.store.beginRestart(binding, f.execution, { ...target, pid: 124 })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    expect(await readFile(f.filename)).toEqual(before);
  });

  it('blocks every grant while a pair is pending and preserves partial OFF across reopening', async () => {
    const f = await restartFixture();
    const other = await f.store.issue({ ...f.spec, requestId: randomUUID() });
    const { record } = await f.store.beginRestart(binding, f.execution, target);
    await expect(f.store.reserve(binding, 'runtime_on', { grantId: other.grantId, requestId: other.requestId, operationId: 'other-on' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(f.store.beginRestart(binding, { grantId: other.grantId, requestId: other.requestId, operationId: randomUUID() }, null)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(f.store.revoke(f.grant.grantId)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await f.store.advanceRestartOff(f.grant.grantId, record.requestId, { targetDead: target });
    const reopened = new LifecycleGrantStore(f.root);
    const before = await readFile(f.filename);
    await expect(reopened.beginRestart(binding, f.execution, target)).resolves.toMatchObject({ created: false, record: { phase: 'ON_RESERVED', state: 'PENDING' } });
    expect(await readFile(f.filename)).toEqual(before);
    await expect(reopened.assertNoUnresolvedRestart()).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await reopened.markRestartUnknown(f.grant.grantId, record.requestId, { interruptedAfterOff: true });
    await expect(reopened.authorizeRestartOn(binding, f.execution)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(reopened.reconcileRestart(f.grant.grantId, record.requestId, 'FAILED', { off: 'FAILED', on: 'FAILED', observed: 'cannot replace proven OFF' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await reopened.reconcileRestart(f.grant.grantId, record.requestId, 'FAILED', { off: 'COMMITTED', on: 'FAILED', observed: { targetDead: target, onNeverStarted: true } });
    await expect(reopened.getRestart(record.requestId)).resolves.toMatchObject({ state: 'FAILED', phase: 'COMPLETE' });
    await expect(reopened.assertNoUnresolvedRestart()).resolves.toBeUndefined();
    await expect(reopened.reserve(binding, 'runtime_on', { grantId: other.grantId, requestId: other.requestId, operationId: 'other-on' })).resolves.toMatchObject({ grantId: other.grantId });
  });

  it('requires complete two-operation scope and budget before any reservation', async () => {
    for (const scope of [{ allowedOperations: ['runtime_off'] as const, maxOperationCount: 2 }, { allowedOperations: ['runtime_off', 'runtime_on'] as const, maxOperationCount: 1 }]) {
      const f = await fixture();
      const grant = await f.store.issue({ ...f.spec, ...scope });
      const before = await readFile(path.join(f.root, 'runtime-lifecycle-grants.json'));
      await expect(f.store.beginRestart(binding, { grantId: grant.grantId, requestId: grant.requestId, operationId: randomUUID() }, target)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
      expect(await readFile(path.join(f.root, 'runtime-lifecycle-grants.json'))).toEqual(before);
    }
    const f = await restartFixture();
    await f.store.reserve(binding, 'runtime_on', { ...f.execution, operationId: 'single' });
    await expect(f.store.beginRestart(binding, f.execution, target)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await f.store.complete(f.grant.grantId, 'single', 'COMMITTED');
    await expect(f.store.beginRestart(binding, f.execution, target)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  });

  it('checks revocation and expiry, including expiry between proven OFF and ON', async () => {
    const revoked = await restartFixture();
    await revoked.store.revoke(revoked.grant.grantId);
    await expect(revoked.store.beginRestart(binding, revoked.execution, target)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    const f = await restartFixture();
    const { record } = await f.store.beginRestart(binding, f.execution, target);
    await f.store.advanceRestartOff(f.grant.grantId, record.requestId, { targetDead: target });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.grant.expiresAt) + 1);
    const before = await readFile(f.filename);
    await expect(f.store.authorizeRestartOn(binding, f.execution)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    await expect(f.store.issue(f.spec)).resolves.toMatchObject({ grantId: f.grant.grantId });
    await expect(f.store.beginRestart(binding, f.execution, target)).resolves.toMatchObject({ created: false });
    expect(await readFile(f.filename)).toEqual(before);
    await f.store.completeRestartOn(f.grant.grantId, record.requestId, 'FAILED', { onNeverStarted: true, expired: true });
    await expect(f.store.assertNoUnresolvedRestart()).resolves.toBeUndefined();
    await expect(f.store.issue({ ...f.spec, requestId: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.store.beginRestart(binding, { ...f.execution, operationId: randomUUID() }, target)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  });

  it('records an unknown OFF without retry and requires consistent authoritative reconciliation', async () => {
    const f = await restartFixture();
    const { record } = await f.store.beginRestart(binding, f.execution, target);
    await f.store.markRestartUnknown(f.grant.grantId, record.requestId, { offOutcome: 'unknown' });
    await expect(f.store.beginRestart(binding, f.execution, target)).resolves.toMatchObject({ created: false, record: { state: 'RECONCILIATION_REQUIRED' } });
    await expect(f.store.advanceRestartOff(f.grant.grantId, record.requestId, { retry: true })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(f.store.reconcileRestart(f.grant.grantId, record.requestId, 'RUNNING', { off: 'FAILED', on: 'COMMITTED', observed: {} })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await f.store.reconcileRestart(f.grant.grantId, record.requestId, 'FAILED', { off: 'FAILED', on: 'FAILED', observed: { originalTargetUnchanged: target, noOnAttempt: true } });
    expect((await f.store.get(f.grant.grantId)).operations.map((operation) => operation.state)).toEqual(['FAILED', 'FAILED']);
    await expect(f.store.reserve(binding, 'runtime_on', { ...f.execution, operationId: 'reuse-failed-budget' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });

  it('keeps legacy signed records and absent first-use probes read-only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'iris-restart-first-use-'));
    roots.push(root);
    const store = new LifecycleGrantStore(root);
    await expect(store.assertNoUnresolvedRestart()).resolves.toBeUndefined();
    await expect(store.getRestart(randomUUID())).resolves.toBeNull();
    await expect(readFile(path.join(root, 'owner-access.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(root, 'runtime-lifecycle-grants.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(root, 'runtime-lifecycle-grants.json'), '{}', { mode: 0o600 });
    await expect(store.assertNoUnresolvedRestart()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await expect(store.getRestart(randomUUID())).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    expect(await readFile(path.join(root, 'runtime-lifecycle-grants.json'), 'utf8')).toBe('{}');
    const f = await restartFixture();
    const before = await readFile(f.filename);
    expect(JSON.parse(before.toString()).grants[0]).not.toHaveProperty('restart');
    await expect(f.store.getRestart(f.execution.operationId)).resolves.toBeNull();
    await expect(f.store.assertNoUnresolvedRestart()).resolves.toBeUndefined();
    expect(await readFile(f.filename)).toEqual(before);
    await f.store.beginRestart(binding, f.execution, target);
    const tampered = JSON.parse(await readFile(f.filename, 'utf8'));
    tampered.grants[0].restart.phase = 'COMPLETE';
    await writeFile(f.filename, JSON.stringify(tampered), { mode: 0o600 });
    await expect(f.store.getRestart(f.execution.operationId)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });
});
