import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableMutationJournal } from './durable-mutation-journal.js';

const fingerprint = 'a'.repeat(64);

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
});
