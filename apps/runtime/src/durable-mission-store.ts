import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { inspectPrivateRegularFile, privateDirectoryProblem } from './private-fs.js';
import type { DurableMissionLifecycleSnapshot } from './durable-mission-lifecycle.js';
import { validateLifecycleRecord } from './durable-mission-validation.js';

const FILE = 'mission-lifecycle.json';
const ARCHIVE_DIRECTORY = 'mission-lifecycle-archive';
const MAX_RECORDS = 100;

export interface DurableMissionLifecycleDocument {
  readonly schemaVersion: 1;
  readonly records: readonly DurableMissionLifecycleSnapshot[];
}

export interface ArchivedDurableMissionLifecycleRecord {
  readonly schemaVersion: 1;
  readonly archivedAt: string;
  readonly reason: 'MISSION_ARCHIVED_FOR_CAPACITY';
  readonly lifecycle: DurableMissionLifecycleSnapshot;
}

export class DurableMissionLifecycleStore {
  public constructor(private readonly dataRoot: string) {}

  public async read(): Promise<DurableMissionLifecycleDocument> {
    const inspected = await inspectPrivateRegularFile(path.join(this.dataRoot, FILE), 'Durable mission lifecycle state');
    if (inspected.state === 'missing') return { schemaVersion: 1, records: [] };
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      const parsed = JSON.parse(inspected.content) as unknown;
      if (!validDocumentShape(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Durable mission lifecycle state is invalid');
      return parsed as DurableMissionLifecycleDocument;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Durable mission lifecycle state is invalid JSON', { cause: error });
    }
  }

  public async write(document: DurableMissionLifecycleDocument): Promise<void> {
    if (!validDocumentShape(document)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to write invalid durable mission lifecycle state');
    const filename = path.join(this.dataRoot, FILE);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    } catch (error) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Atomic durable mission lifecycle publication failed', { cause: error });
    }
  }

  public async readArchived(missionId: string): Promise<DurableMissionLifecycleSnapshot | null> {
    if (!isUuid(missionId)) throw new RuntimeError('INVALID_REQUEST', 'Archived mission lifecycle identity is invalid');
    const directory = path.join(this.dataRoot, ARCHIVE_DIRECTORY);
    try {
      await lstat(directory);
    } catch (error) {
      if (isNodeErrorCode(error, 'ENOENT')) return null;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Mission lifecycle archive directory metadata is unreadable', { cause: error });
    }
    const problem = await privateDirectoryProblem(directory, 'Mission lifecycle archive directory');
    if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
    const inspected = await inspectPrivateRegularFile(
      path.join(directory, `${missionId}.json`),
      'Archived mission lifecycle record',
    );
    if (inspected.state === 'missing') return null;
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    let parsed: unknown;
    try {
      parsed = JSON.parse(inspected.content) as unknown;
    } catch (error) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Archived mission lifecycle record is invalid JSON', { cause: error });
    }
    const record = normalizeArchivedRecord(parsed);
    if (record === null || record.lifecycle.missionId !== missionId) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Archived mission lifecycle record is invalid');
    }
    return record.lifecycle;
  }

  public async archiveForCapacity(recordInput: DurableMissionLifecycleSnapshot): Promise<void> {
    const record = validateLifecycleRecord(recordInput);
    if (!lifecycleCapacityArchiveEligible(record)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Mission lifecycle record is not eligible for capacity archival');
    }
    const directory = path.join(this.dataRoot, ARCHIVE_DIRECTORY);
    await ensurePrivateArchiveDirectory(directory);
    const filename = path.join(directory, `${record.missionId}.json`);
    const existing = await inspectPrivateRegularFile(filename, 'Archived mission lifecycle record');
    if (existing.state === 'ok') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing.content) as unknown;
      } catch (error) {
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Archived mission lifecycle record is invalid JSON', { cause: error });
      }
      const archived = normalizeArchivedRecord(parsed);
      if (archived === null
        || archived.reason !== 'MISSION_ARCHIVED_FOR_CAPACITY'
        || JSON.stringify(archived.lifecycle) !== JSON.stringify(record)) {
        throw new RuntimeError('PRECONDITION_FAILED', 'Archived mission lifecycle identity is already bound to different content');
      }
      return;
    }
    if (existing.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', existing.reason);

    const archived: ArchivedDurableMissionLifecycleRecord = {
      schemaVersion: 1,
      archivedAt: new Date().toISOString(),
      reason: 'MISSION_ARCHIVED_FOR_CAPACITY',
      lifecycle: record,
    };
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(filename, flags, 0o600);
      await handle.writeFile(`${JSON.stringify(archived, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      const raced = await inspectPrivateRegularFile(filename, 'Archived mission lifecycle record');
      if (raced.state === 'ok') {
        try {
          const parsed = normalizeArchivedRecord(JSON.parse(raced.content) as unknown);
          if (parsed !== null && JSON.stringify(parsed.lifecycle) === JSON.stringify(record)) return;
        } catch {
          // Fall through to the fail-closed publication error below.
        }
      }
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Immutable mission lifecycle archive publication failed', { cause: error });
    }
  }
}

export function lifecycleCapacityArchiveEligible(record: DurableMissionLifecycleSnapshot): boolean {
  if (record.operations.some((operation) => operation.status === 'PENDING')) return false;
  if (record.state === 'CREATED' || record.state === 'READY') return record.workerBinding === null;
  if (record.state !== 'COMPLETED' && record.state !== 'FAILED' && record.state !== 'CANCELLED') return false;
  return record.workerBinding === null || record.workerBinding.resumable === false;
}

function normalizeArchivedRecord(value: unknown): ArchivedDurableMissionLifecycleRecord | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !timestamp(value.archivedAt)
    || value.reason !== 'MISSION_ARCHIVED_FOR_CAPACITY'
    || !isRecord(value.lifecycle)) return null;
  try {
    const lifecycle = validateLifecycleRecord(value.lifecycle as unknown as DurableMissionLifecycleSnapshot);
    return {
      schemaVersion: 1,
      archivedAt: value.archivedAt as string,
      reason: 'MISSION_ARCHIVED_FOR_CAPACITY',
      lifecycle,
    };
  } catch {
    return null;
  }
}

async function ensurePrivateArchiveDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeErrorCode(error, 'EEXIST')) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Mission lifecycle archive directory could not be created safely', { cause: error });
    }
  }
  const problem = await privateDirectoryProblem(directory, 'Mission lifecycle archive directory');
  if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
}

function validDocumentShape(value: unknown): boolean {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) return false;
  const ids: string[] = [];
  for (const record of value.records) {
    if (!isRecord(record) || !isUuid(record.missionId) || !isUuid(record.projectId)) return false;
    ids.push(record.missionId);
  }
  return new Set(ids).size === ids.length;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function timestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
