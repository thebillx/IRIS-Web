import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SyncCoordinator } from './sync.js';
import { SqliteSyncStore } from './sqlite-store.js';

const at = '2026-09-19T00:00:00.000Z';
const scope = { organizationId: 'org-example', projectId: 'project-example', teamId: 'team-example', boardId: 'board-example' };

function root(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iris-ado-sync-')));
}

describe('M6 SQLite durable store', () => {
  it('survives close/reopen and continues from the durable generation', () => {
    const dataRoot = root();
    try {
      let store = new SqliteSyncStore(dataRoot);
      const coordinator = new SyncCoordinator(store);
      coordinator.start({
        syncRunId: 'run-1',
        scope,
        mode: 'FULL',
        trigger: { kind: 'MANUAL' },
        inventory: { snapshotId: 'snapshot-1', complete: true, items: [{ itemId: 1, parentId: null, backlogIds: ['delivery'] }] },
        policy: { gateVersion: 'gate-1', minimumPromoted: 1, allowRejections: true },
        at,
      });
      const generation = store.read().generation;
      expect(generation).toBeGreaterThan(0);
      store.close();

      store = new SqliteSyncStore(dataRoot);
      expect(store.read().generation).toBe(generation);
      expect(new SyncCoordinator(store).inspect('run-1').pendingIds).toEqual([1]);
      store.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('serializes cross-instance writers with generation CAS', () => {
    const dataRoot = root();
    try {
      const first = new SqliteSyncStore(dataRoot);
      const second = new SqliteSyncStore(dataRoot);
      const left = first.read();
      const right = second.read();
      left.generation += 1;
      right.generation += 1;
      first.compareAndSwap(0, left);
      expect(() => second.compareAndSwap(0, right)).toThrow('CONFLICT');
      expect(second.read().generation).toBe(1);
      first.close();
      second.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('keeps the database private inside a private sync directory', () => {
    const dataRoot = root();
    try {
      const store = new SqliteSyncStore(dataRoot);
      expect(statSync(path.dirname(store.filename)).mode & 0o777).toBe(0o700);
      expect(statSync(store.filename).mode & 0o777).toBe(0o600);
      store.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('fails closed on an aliased runtime data root', () => {
    const dataRoot = root();
    const alias = `${dataRoot}-alias`;
    try {
      symlinkSync(dataRoot, alias, 'dir');
      expect(() => new SqliteSyncStore(alias)).toThrow('PERSISTENCE_FAILURE');
    } finally {
      rmSync(alias, { force: true });
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('does not expose persisted source bytes through store errors', () => {
    const dataRoot = root();
    try {
      const store = new SqliteSyncStore(dataRoot);
      const dbBytes = readFileSync(store.filename);
      expect(dbBytes.byteLength).toBeGreaterThan(0);
      store.close();
      chmodSync(store.filename, 0o000);
      let message = '';
      try { new SqliteSyncStore(dataRoot); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).not.toContain('Source');
    } finally {
      try { chmodSync(path.join(dataRoot, 'ado-sync', 'state.sqlite3'), 0o600); } catch { /* ignore */ }
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
