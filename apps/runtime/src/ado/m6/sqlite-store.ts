import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SyncError, type SyncDocument } from './model.js';
import { emptyDocument, validateDocument, validateTransition, type SyncStore } from './store.js';

interface StoredRow {
  readonly generation: number;
  readonly document: string;
}

export class SqliteSyncStore implements SyncStore {
  readonly filename: string;
  #database!: DatabaseSync;
  #closed = false;

  constructor(runtimeDataRoot: string) {
    if (typeof runtimeDataRoot !== 'string' || !path.isAbsolute(runtimeDataRoot)
      || path.resolve(runtimeDataRoot) !== runtimeDataRoot || runtimeDataRoot.includes('\0')) {
      throw new SyncError('PERSISTENCE_FAILURE');
    }
    let physicalRoot: string;
    try {
      const metadata = lstatSync(runtimeDataRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('not physical directory');
      physicalRoot = realpathSync(runtimeDataRoot);
      if (physicalRoot !== runtimeDataRoot) throw new Error('aliased data root');
    } catch {
      throw new SyncError('PERSISTENCE_FAILURE');
    }

    const directory = path.join(physicalRoot, 'ado-sync');
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryMetadata = lstatSync(directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || realpathSync(directory) !== directory) {
        throw new Error('unsafe sync directory');
      }
      chmodSync(directory, 0o700);
    } catch {
      throw new SyncError('PERSISTENCE_FAILURE');
    }

    this.filename = path.join(directory, 'state.sqlite3');
    try {
      this.#database = new DatabaseSync(this.filename);
      chmodSync(this.filename, 0o600);
      this.#database.exec([
        'PRAGMA journal_mode = DELETE',
        'PRAGMA synchronous = FULL',
        'PRAGMA foreign_keys = ON',
        'CREATE TABLE IF NOT EXISTS ado_sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL CHECK (generation >= 0), document TEXT NOT NULL)',
      ].join('; '));
      const existing = this.#select();
      if (existing === null) {
        const initial = emptyDocument();
        const result = this.#database.prepare(
          'INSERT INTO ado_sync_state (id, generation, document) VALUES (1, ?, ?)',
        ).run(initial.generation, JSON.stringify(initial));
        if (Number(result.changes) !== 1) throw new Error('initial insert failed');
      } else {
        const document = this.#parse(existing);
        if (document.generation !== existing.generation) throw new Error('generation mismatch');
      }
    } catch (error) {
      try { this.#database?.close(); } catch { /* best effort */ }
      throw error instanceof SyncError ? error : new SyncError('PERSISTENCE_FAILURE');
    }
  }

  read(): SyncDocument {
    this.#assertOpen();
    const row = this.#select();
    if (row === null) throw new SyncError('PERSISTENCE_FAILURE');
    return structuredClone(this.#parse(row));
  }

  compareAndSwap(expectedGeneration: number, next: SyncDocument): void {
    this.#assertOpen();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#select();
      if (row === null) throw new SyncError('PERSISTENCE_FAILURE');
      const current = this.#parse(row);
      if (current.generation !== row.generation) throw new SyncError('INVALID_SNAPSHOT');
      validateTransition(current, expectedGeneration, next);
      const result = this.#database.prepare(
        'UPDATE ado_sync_state SET generation = ?, document = ? WHERE id = 1 AND generation = ?',
      ).run(next.generation, JSON.stringify(next), expectedGeneration);
      if (Number(result.changes) !== 1) throw new SyncError('CONFLICT');
      this.#database.exec('COMMIT');
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch { /* best effort */ }
      if (error instanceof SyncError) throw error;
      throw new SyncError('PERSISTENCE_FAILURE');
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new SyncError('PERSISTENCE_FAILURE');
  }

  #select(): StoredRow | null {
    const row = this.#database.prepare(
      'SELECT generation, document FROM ado_sync_state WHERE id = 1',
    ).get() as { generation?: unknown; document?: unknown } | undefined;
    if (row === undefined) return null;
    if (!Number.isSafeInteger(row.generation) || typeof row.document !== 'string') {
      throw new SyncError('INVALID_SNAPSHOT');
    }
    return { generation: Number(row.generation), document: row.document };
  }

  #parse(row: StoredRow): SyncDocument {
    try {
      const document = JSON.parse(row.document) as SyncDocument;
      validateDocument(document);
      if (document.generation !== row.generation) throw new Error('generation mismatch');
      return document;
    } catch {
      throw new SyncError('INVALID_SNAPSHOT');
    }
  }
}
