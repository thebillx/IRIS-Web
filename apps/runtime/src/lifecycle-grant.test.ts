import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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

    const expired = await f.store.issue({ ...f.spec, requestId: '55555555-5555-4555-8555-555555555555', expiresAt: new Date(Date.now() + 1).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 10));
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
