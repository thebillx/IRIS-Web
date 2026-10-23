import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { privateDirectoryProblem } from './private-fs.js';

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type MutationState = 'PREPARED' | 'APPLYING' | 'COMMITTED' | 'FAILED' | 'RECONCILIATION_REQUIRED';
export interface MutationRecord { readonly schemaVersion: 1; readonly requestId: string; readonly fingerprint: string; readonly state: MutationState; readonly result: unknown; readonly errorCode: string | null; readonly updatedAt: string; }

/** A per-request durable guard. APPLYING is deliberately terminal for retries: the caller must reconcile. */
export class DurableMutationJournal {
  private tail: Promise<void> = Promise.resolve();
  public constructor(private readonly dataRoot: string, private readonly directoryName = 'vnext-mutations') {}

  public execute<T>(requestId: string, fingerprint: string, operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => this.executeSerialized(requestId, fingerprint, operation), () => this.executeSerialized(requestId, fingerprint, operation));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  public inspect(requestId: string, fingerprint: string): Promise<MutationRecord | null> {
    return this.tail.then(() => this.inspectSerialized(requestId, fingerprint), () => this.inspectSerialized(requestId, fingerprint));
  }

  public reconcile<T>(requestId: string, fingerprint: string, result: T): Promise<T> {
    const run = this.tail.then(() => this.reconcileSerialized(requestId, fingerprint, result), () => this.reconcileSerialized(requestId, fingerprint, result));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async executeSerialized<T>(requestId: string, fingerprint: string, operation: () => Promise<T>): Promise<T> {
    const filename = await this.recordFilename(requestId, fingerprint);
    const existing = await readMutation(filename);
    if (existing !== null) {
      if (existing.requestId !== requestId || existing.fingerprint !== fingerprint) throw new RuntimeError('AUTHORITY_CHANGED', 'Mutation request identity conflicts with its durable record');
      if (existing.state === 'COMMITTED') return existing.result as T;
      if (existing.state === 'FAILED') throw new RuntimeError(existing.errorCode === 'PRECONDITION_FAILED' ? 'PRECONDITION_FAILED' : 'PERSISTENCE_FAILURE', 'Mutation request already reached a terminal failure');
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Mutation request has an unresolved outcome; reconcile before retry');
    }
    const prepared: MutationRecord = { schemaVersion: 1, requestId, fingerprint, state: 'PREPARED', result: null, errorCode: null, updatedAt: new Date().toISOString() };
    try { await writeNew(filename, prepared); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return this.executeSerialized(requestId, fingerprint, operation);
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Mutation journal reservation failed', { cause: error });
    }
    await writeRecord(filename, { ...prepared, state: 'APPLYING', updatedAt: new Date().toISOString() });
    try {
      const result = await operation();
      await writeRecord(filename, { ...prepared, state: 'COMMITTED', result, updatedAt: new Date().toISOString() });
      return result;
    } catch (error: unknown) {
      const code = error instanceof RuntimeError ? error.code : 'PERSISTENCE_FAILURE';
      await writeRecord(filename, {
        ...prepared,
        state: code === 'AUTHORITY_INDETERMINATE' ? 'RECONCILIATION_REQUIRED' : 'FAILED',
        errorCode: code,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
      throw error;
    }
  }

  private async inspectSerialized(requestId: string, fingerprint: string): Promise<MutationRecord | null> {
    return readMutation(await this.recordFilename(requestId, fingerprint));
  }

  private async reconcileSerialized<T>(requestId: string, fingerprint: string, result: T): Promise<T> {
    const filename = await this.recordFilename(requestId, fingerprint);
    const existing = await readMutation(filename);
    if (existing === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Mutation request has no durable record to reconcile');
    if (existing.requestId !== requestId || existing.fingerprint !== fingerprint) throw new RuntimeError('AUTHORITY_CHANGED', 'Mutation request identity conflicts with its durable record');
    if (existing.state === 'COMMITTED') return existing.result as T;
    if (existing.state !== 'RECONCILIATION_REQUIRED') throw new RuntimeError('AUTHORITY_CHANGED', 'Mutation request is not awaiting reconciliation');
    await writeRecord(filename, { ...existing, state: 'COMMITTED', result, errorCode: null, updatedAt: new Date().toISOString() });
    return result;
  }

  private async recordFilename(requestId: string, fingerprint: string): Promise<string> {
    if (!REQUEST_ID.test(requestId)) throw new RuntimeError('INVALID_REQUEST', 'Mutation requestId is invalid');
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new RuntimeError('INVALID_REQUEST', 'Mutation fingerprint is invalid');
    const directory = path.join(this.dataRoot, this.directoryName);
    const problem = await privateDirectoryProblem(this.dataRoot, 'Mutation journal parent');
    if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return path.join(directory, `${createHash('sha256').update(requestId).digest('hex')}.json`);
  }
}

async function readMutation(filename: string): Promise<MutationRecord | null> {
  try {
    const metadata = await stat(filename);
    if (!metadata.isFile() || metadata.mode & 0o077) throw new Error('Mutation journal record metadata is unsafe');
    const record = JSON.parse(await readFile(filename, 'utf8')) as MutationRecord;
    if (record.schemaVersion !== 1 || typeof record.requestId !== 'string' || typeof record.fingerprint !== 'string'
      || !['PREPARED','APPLYING','COMMITTED','FAILED','RECONCILIATION_REQUIRED'].includes(record.state)) throw new Error('Mutation journal record is invalid');
    return record;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Mutation journal record is invalid', { cause: error });
  }
}

async function writeNew(filename: string, record: MutationRecord): Promise<void> {
  const handle = await open(filename, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

async function writeRecord(filename: string, record: MutationRecord): Promise<void> {
  const temp = `${filename}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, filename);
  const parent = await open(path.dirname(filename), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
