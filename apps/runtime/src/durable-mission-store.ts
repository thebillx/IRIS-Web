import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { inspectPrivateRegularFile } from './private-fs.js';
import type { DurableMissionLifecycleSnapshot } from './durable-mission-lifecycle.js';

const FILE = 'mission-lifecycle.json';
const MAX_RECORDS = 100;

export interface DurableMissionLifecycleDocument {
  readonly schemaVersion: 1;
  readonly records: readonly DurableMissionLifecycleSnapshot[];
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

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
