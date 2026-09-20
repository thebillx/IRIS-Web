import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { inspectPrivateRegularFile } from '../private-fs.js';
import { emptyMultiWorkerDocument, type MultiWorkerDocument } from './model.js';
import { validateMultiWorkerDocument } from './validation.js';

const FILE = 'multi-worker-orchestration.json';

export class MultiWorkerStore {
  public constructor(private readonly dataRoot: string) {}

  public async read(): Promise<MultiWorkerDocument> {
    const filename = path.join(this.dataRoot, FILE);
    const inspected = await inspectPrivateRegularFile(filename, 'Multi-worker orchestration state');
    if (inspected.state === 'missing') return emptyMultiWorkerDocument();
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      return validateMultiWorkerDocument(JSON.parse(inspected.content) as unknown);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Multi-worker orchestration state is invalid JSON', { cause: error });
    }
  }

  /**
   * Publish one generation with a fail-closed optimistic generation precondition.
   *
   * M02 deliberately keeps mutation serialization outside this store. The orchestration service
   * introduced later owns serialization/CAS retry policy; this store only refuses stale writers.
   */
  public async write(document: MultiWorkerDocument, expectedGeneration: number): Promise<void> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new RuntimeError('INVALID_REQUEST', 'expectedGeneration must be a non-negative integer');
    }

    const current = await this.read();
    if (current.generation !== expectedGeneration) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Multi-worker orchestration generation is stale');
    }
    if (document.generation !== expectedGeneration + 1) {
      throw new RuntimeError('INVALID_REQUEST', 'Multi-worker orchestration generation must advance exactly once');
    }

    const validated = validateMultiWorkerDocument(document);
    const filename = path.join(this.dataRoot, FILE);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, filename);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Atomic multi-worker orchestration publication failed', { cause: error });
    }
  }
}
