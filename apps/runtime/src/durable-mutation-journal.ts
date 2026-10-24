import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { privateDirectoryProblem } from './private-fs.js';

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type MutationState = 'PREPARED' | 'APPLYING' | 'COMMITTED' | 'FAILED' | 'RECONCILIATION_REQUIRED';
export interface MutationBinding {
  readonly operation: string;
  readonly clientId: string;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly deploymentEpoch: number;
}

export interface MutationRecord {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly state: MutationState;
  readonly result: unknown;
  readonly errorCode: string | null;
  readonly updatedAt: string;
  /** New records carry the authenticated downstream identity used for the mutation. */
  readonly binding?: MutationBinding;
  /** Stable request identity used to retrieve evidence after a runtime restart. */
  readonly logicalFingerprint?: string;
}

/** A per-request durable guard. APPLYING is deliberately terminal for retries: the caller must reconcile. */
export class DurableMutationJournal {
  private tail: Promise<void> = Promise.resolve();
  public constructor(private readonly dataRoot: string, private readonly directoryName = 'vnext-mutations') {}

  public execute<T>(requestId: string, fingerprint: string, operation: () => Promise<T>, binding?: MutationBinding, logicalFingerprint?: string): Promise<T> {
    const run = this.tail.then(() => this.executeSerialized(requestId, fingerprint, operation, binding, logicalFingerprint), () => this.executeSerialized(requestId, fingerprint, operation, binding, logicalFingerprint));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  public inspect(requestId: string, fingerprint: string, binding?: MutationBinding): Promise<MutationRecord | null> {
    return this.tail.then(() => this.inspectSerialized(requestId, fingerprint, binding), () => this.inspectSerialized(requestId, fingerprint, binding));
  }

  /** Read terminal or unresolved evidence by stable request identity without authorizing replay. */
  public inspectByLogicalIdentity(requestId: string, logicalFingerprint: string, binding: MutationBinding): Promise<MutationRecord | null> {
    return this.tail.then(() => this.inspectByLogicalIdentitySerialized(requestId, logicalFingerprint, binding), () => this.inspectByLogicalIdentitySerialized(requestId, logicalFingerprint, binding));
  }

  private async executeSerialized<T>(requestId: string, fingerprint: string, operation: () => Promise<T>, binding?: MutationBinding, logicalFingerprint?: string): Promise<T> {
    const filename = await this.recordFilename(requestId, fingerprint, true);
    const existing = await readMutation(filename);
    if (existing !== null) {
      assertRecordBinding(existing, requestId, fingerprint, binding, logicalFingerprint);
      if (existing.state === 'COMMITTED') return existing.result as T;
      if (existing.state === 'FAILED') throw new RuntimeError(existing.errorCode === 'PRECONDITION_FAILED' ? 'PRECONDITION_FAILED' : 'PERSISTENCE_FAILURE', 'Mutation request already reached a terminal failure');
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Mutation request has an unresolved outcome; reconcile before retry');
    }
    const prepared: MutationRecord = { schemaVersion: 1, requestId, fingerprint, state: 'PREPARED', result: null, errorCode: null, updatedAt: new Date().toISOString(), ...(binding === undefined ? {} : { binding }), ...(logicalFingerprint === undefined ? {} : { logicalFingerprint }) };
    try { await writeNew(filename, prepared); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return this.executeSerialized(requestId, fingerprint, operation, binding, logicalFingerprint);
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

  private async inspectSerialized(requestId: string, fingerprint: string, binding?: MutationBinding): Promise<MutationRecord | null> {
    const record = await readMutation(await this.recordFilename(requestId, fingerprint, false));
    if (record !== null) assertRecordBinding(record, requestId, fingerprint, binding);
    return record;
  }

  private async inspectByLogicalIdentitySerialized(requestId: string, logicalFingerprint: string, binding: MutationBinding): Promise<MutationRecord | null> {
    if (!/^[a-f0-9]{64}$/.test(logicalFingerprint)) throw new RuntimeError('INVALID_REQUEST', 'Mutation logical fingerprint is invalid');
    const filename = await this.recordFilename(requestId, logicalFingerprint, false);
    const record = await readMutation(filename);
    if (record === null) return null;
    if (record.requestId !== requestId || record.logicalFingerprint !== logicalFingerprint || !sameLogicalBinding(record.binding, binding)) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'Mutation evidence identity conflicts with its durable record');
    }
    return record;
  }

  private async recordFilename(requestId: string, fingerprint: string, createDirectory: boolean): Promise<string> {
    if (!REQUEST_ID.test(requestId)) throw new RuntimeError('INVALID_REQUEST', 'Mutation requestId is invalid');
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new RuntimeError('INVALID_REQUEST', 'Mutation fingerprint is invalid');
    const directory = path.join(this.dataRoot, this.directoryName);
    const problem = await privateDirectoryProblem(this.dataRoot, 'Mutation journal parent');
    if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
    if (createDirectory) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    } else {
      try {
        const metadata = await lstat(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new RuntimeError('PERSISTENCE_FAILURE', 'Mutation journal directory is not a physical directory');
        const directoryProblem = await privateDirectoryProblem(directory, 'Mutation journal directory');
        if (directoryProblem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', directoryProblem);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
    }
    return path.join(directory, `${createHash('sha256').update(requestId).digest('hex')}.json`);
  }
}

function assertRecordBinding(record: MutationRecord, requestId: string, fingerprint: string, binding?: MutationBinding, logicalFingerprint?: string): void {
  if (record.requestId !== requestId || record.fingerprint !== fingerprint) {
    throw new RuntimeError('AUTHORITY_CHANGED', 'Mutation request identity conflicts with its durable record');
  }
  if (binding !== undefined && !sameBinding(record.binding, binding)) {
    throw new RuntimeError('AUTHORITY_CHANGED', 'Mutation downstream identity conflicts with its durable record');
  }
  if (logicalFingerprint !== undefined && record.logicalFingerprint !== logicalFingerprint) {
    throw new RuntimeError('AUTHORITY_CHANGED', 'Mutation logical identity conflicts with its durable record');
  }
}

function sameLogicalBinding(left: MutationBinding | undefined, right: MutationBinding): boolean {
  return left !== undefined
    && left.operation === right.operation
    && left.clientId === right.clientId
    && left.sessionId === right.sessionId
    && left.projectId === right.projectId
    && left.workspaceId === right.workspaceId;
}

function sameBinding(left: MutationBinding | undefined, right: MutationBinding): boolean {
  return left !== undefined
    && left.operation === right.operation
    && left.clientId === right.clientId
    && left.sessionId === right.sessionId
    && left.projectId === right.projectId
    && left.workspaceId === right.workspaceId
    && left.runtimeId === right.runtimeId
    && left.instanceId === right.instanceId
    && left.deploymentEpoch === right.deploymentEpoch;
}

async function readMutation(filename: string): Promise<MutationRecord | null> {
  try {
    const metadata = await stat(filename);
    if (!metadata.isFile() || metadata.mode & 0o077) throw new Error('Mutation journal record metadata is unsafe');
    const record = JSON.parse(await readFile(filename, 'utf8')) as MutationRecord;
    if (record.schemaVersion !== 1 || typeof record.requestId !== 'string' || typeof record.fingerprint !== 'string'
      || !['PREPARED','APPLYING','COMMITTED','FAILED','RECONCILIATION_REQUIRED'].includes(record.state)
      || (record.binding !== undefined && !isMutationBinding(record.binding))
      || (record.logicalFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(record.logicalFingerprint))) throw new Error('Mutation journal record is invalid');
    return record;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Mutation journal record is invalid', { cause: error });
  }
}

function isMutationBinding(value: unknown): value is MutationBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.operation === 'string' && candidate.operation.length > 0 && candidate.operation.length <= 200
    && typeof candidate.clientId === 'string' && candidate.clientId.length > 0 && candidate.clientId.length <= 200
    && (candidate.sessionId === null || typeof candidate.sessionId === 'string')
    && (candidate.projectId === null || typeof candidate.projectId === 'string')
    && (candidate.workspaceId === null || typeof candidate.workspaceId === 'string')
    && typeof candidate.runtimeId === 'string' && candidate.runtimeId.length > 0 && candidate.runtimeId.length <= 200
    && typeof candidate.instanceId === 'string' && candidate.instanceId.length > 0 && candidate.instanceId.length <= 200
    && typeof candidate.deploymentEpoch === 'number' && Number.isSafeInteger(candidate.deploymentEpoch) && candidate.deploymentEpoch > 0;
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
