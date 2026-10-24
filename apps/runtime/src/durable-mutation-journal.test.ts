import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableMutationJournal, type MutationBinding } from './durable-mutation-journal.js';

const fingerprint = 'a'.repeat(64);
const binding: MutationBinding = {
  operation: 'fs', clientId: 'client-a', sessionId: 'session-a', projectId: 'project-a', workspaceId: 'workspace-a',
  runtimeId: 'runtime-a', instanceId: 'instance-a', deploymentEpoch: 7,
};

describe('DurableMutationJournal', () => {
  it('returns the committed result for an exact duplicate without rerunning the mutation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    let calls = 0;
    await expect(journal.execute('git-commit-1', fingerprint, async () => { calls += 1; return { head: 'abc' }; })).resolves.toEqual({ head: 'abc' });
    await expect(journal.execute('git-commit-1', fingerprint, async () => { calls += 1; return { head: 'def' }; })).resolves.toEqual({ head: 'abc' });
    expect(calls).toBe(1);
  });

  it('rejects a duplicate request with a changed operation fingerprint', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    await journal.execute('git-commit-2', fingerprint, async () => ({ ok: true }));
    await expect(journal.execute('git-commit-2', 'b'.repeat(64), async () => ({ ok: false }))).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });

  it('fails closed when the durable record is still APPLYING', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    await journal.execute('git-commit-3', fingerprint, async () => ({ ok: true }));
    const record = path.join(root, 'vnext-mutations', `${await import('node:crypto').then(({ createHash }) => createHash('sha256').update('git-commit-3').digest('hex'))}.json`);
    const raw = JSON.parse(await readFile(record, 'utf8')) as Record<string, unknown>;
    raw.state = 'APPLYING';
    await writeFile(record, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    await expect(journal.execute('git-commit-3', fingerprint, async () => ({ ok: false }))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('records a terminal failure and never replays it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    await expect(journal.execute('git-commit-4', fingerprint, async () => { throw new Error('known failure'); })).rejects.toThrow('known failure');
    await expect(journal.execute('git-commit-4', fingerprint, async () => ({ ok: false }))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('preserves an unknown transport outcome as reconciliation-required', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    await expect(journal.execute('unknown-1', fingerprint, async () => {
      const { RuntimeError } = await import('@iris/domain');
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'response lost');
    })).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
    await expect(journal.execute('unknown-1', fingerprint, async () => ({ replayed: true }))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    const recordPath = path.join(root, 'vnext-mutations', `${await import('node:crypto').then(({ createHash }) => createHash('sha256').update('unknown-1').digest('hex'))}.json`);
    await expect(readFile(recordPath, 'utf8')).resolves.toContain('RECONCILIATION_REQUIRED');
  });

  it('rejects an unresolved request when its fingerprint changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    const { RuntimeError } = await import('@iris/domain');
    await expect(journal.execute('unknown-reconcile-1', fingerprint, async () => {
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'response lost');
    })).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
    await expect(journal.inspect('unknown-reconcile-1', fingerprint)).resolves.toMatchObject({ state: 'RECONCILIATION_REQUIRED' });
    await expect(journal.inspect('unknown-reconcile-1', 'b'.repeat(64))).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });

  it('allows the Supervisor and Runtime journals to consume one forwarded request independently', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    await mkdir(path.join(root, 'supervisor'), { mode: 0o700 });
    const supervisor = new DurableMutationJournal(path.join(root, 'supervisor'));
    const runtime = new DurableMutationJournal(root);
    const requestId = 'forwarded-git-1';
    await expect(supervisor.execute(requestId, fingerprint, async () => ({ layer: 'supervisor' }))).resolves.toEqual({ layer: 'supervisor' });
    await expect(runtime.execute(requestId, fingerprint, async () => ({ layer: 'runtime' }))).resolves.toEqual({ layer: 'runtime' });
  });

  it('binds status and replay to the exact downstream client/session/project/workspace/runtime identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    const logicalFingerprint = 'c'.repeat(64);
    await journal.execute('bound-1', fingerprint, async () => ({ changed: true }), binding, logicalFingerprint);
    await expect(journal.inspect('bound-1', fingerprint, binding)).resolves.toMatchObject({ state: 'COMMITTED', binding });
    await expect(journal.inspectByLogicalIdentity('bound-1', logicalFingerprint, binding)).resolves.toMatchObject({ state: 'COMMITTED', binding, logicalFingerprint });
    await expect(journal.inspectByLogicalIdentity('bound-1', logicalFingerprint, {
      ...binding, runtimeId: 'runtime-after-restart', instanceId: 'instance-after-restart', deploymentEpoch: 8,
    })).resolves.toMatchObject({ state: 'COMMITTED', binding });
    await expect(journal.inspect('bound-1', fingerprint, { ...binding, clientId: 'client-b' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(journal.execute('bound-1', fingerprint, async () => ({ changed: false }), { ...binding, deploymentEpoch: 8 }, logicalFingerprint)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });

  it('rejects legacy records when an authenticated downstream binding is required', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    await journal.execute('legacy-1', fingerprint, async () => ({ legacy: true }));
    await expect(journal.inspect('legacy-1', fingerprint, binding)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });

  it('rejects the same logical mutation under a new request ID before applying it again', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    const logicalFingerprint = 'd'.repeat(64);
    let calls = 0;
    await journal.execute('logical-request-a', fingerprint, async () => { calls += 1; return { committed: true }; }, binding, logicalFingerprint);
    await expect(journal.execute('logical-request-b', 'b'.repeat(64), async () => { calls += 1; return { duplicate: true }; }, binding, logicalFingerprint)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    expect(calls).toBe(1);
  });

  it('atomically claims a logical mutation across journal instances', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const first = new DurableMutationJournal(root);
    const second = new DurableMutationJournal(root);
    const logicalFingerprint = 'd'.repeat(64);
    let effects = 0;
    const run = (journal: DurableMutationJournal, requestId: string, operationFingerprint: string) => journal.execute(
      requestId,
      operationFingerprint,
      async () => { effects += 1; return { requestId }; },
      binding,
      logicalFingerprint,
    );
    const results = await Promise.allSettled([run(first, 'request-a', 'a'.repeat(64)), run(second, 'request-b', 'b'.repeat(64))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(effects).toBe(1);
  });

  it('does not create a journal directory during a read-only evidence lookup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    await expect(journal.inspect('missing-read-only', fingerprint, binding)).resolves.toBeNull();
    await expect(access(path.join(root, 'vnext-mutations'))).rejects.toThrow();
  });

  it('settles runtime evidence exactly once and rejects mismatched or ambiguous evidence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    const { RuntimeError } = await import('@iris/domain');
    await expect(journal.execute('reconcile-1', fingerprint, async () => {
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'response lost');
    }, binding, 'e'.repeat(64))).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
    await expect(journal.reconcile('reconcile-1', fingerprint, binding, 'COMMITTED', { changed: true })).resolves.toMatchObject({ state: 'COMMITTED', result: { changed: true } });
    await expect(journal.reconcile('reconcile-1', fingerprint, binding, 'COMMITTED', { changed: false })).resolves.toMatchObject({ state: 'COMMITTED', result: { changed: true } });
    await expect(journal.reconcile('reconcile-1', fingerprint, { ...binding, clientId: 'revoked-client' }, 'COMMITTED', {})).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(journal.execute('reconcile-1', fingerprint, async () => ({ replayed: true }), binding, 'e'.repeat(64))).resolves.toEqual({ changed: true });
  });

  it('can settle a failed downstream outcome but never settles a missing record', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const journal = new DurableMutationJournal(root);
    const { RuntimeError } = await import('@iris/domain');
    await expect(journal.execute('reconcile-2', fingerprint, async () => {
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'restart interrupted response');
    }, binding, 'f'.repeat(64))).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
    await expect(journal.reconcile('reconcile-2', fingerprint, binding, 'FAILED', null, 'PRECONDITION_FAILED')).resolves.toMatchObject({ state: 'FAILED', errorCode: 'PRECONDITION_FAILED' });
    await expect(journal.reconcile('unknown-reconcile', fingerprint, binding, 'FAILED', null, 'PRECONDITION_FAILED')).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
  });

  it('preserves unresolved evidence across a Runtime journal restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'iris-mutation-journal-'));
    const first = new DurableMutationJournal(root);
    const { RuntimeError } = await import('@iris/domain');
    await expect(first.execute('restart-reconcile', fingerprint, async () => {
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'response lost during restart');
    }, binding, '1'.repeat(64))).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });

    const restarted = new DurableMutationJournal(root);
    await expect(restarted.inspect('restart-reconcile', fingerprint, binding)).resolves.toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      requestId: 'restart-reconcile',
      logicalFingerprint: '1'.repeat(64),
    });
    await expect(restarted.reconcile('restart-reconcile', fingerprint, binding, 'COMMITTED', { recovered: true })).resolves.toMatchObject({
      state: 'COMMITTED',
      result: { recovered: true },
    });
  });
});
