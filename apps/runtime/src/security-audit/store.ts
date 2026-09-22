import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { inspectPrivateRegularFile } from '../private-fs.js';
import { emptySecurityAuditDocument, type SecurityAuditDocument } from './model.js';
import { validateSecurityAuditDocument } from './validation.js';

const FILE = 'security-audit-engine.json';

export class SecurityAuditStore {
  public constructor(private readonly dataRoot: string) {}

  public async read(): Promise<SecurityAuditDocument> {
    const filename = path.join(this.dataRoot, FILE);
    const inspected = await inspectPrivateRegularFile(filename, 'Security audit engine state');
    if (inspected.state === 'missing') return emptySecurityAuditDocument();
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      return validateSecurityAuditDocument(JSON.parse(inspected.content) as unknown);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Security audit engine state is invalid JSON', { cause: error });
    }
  }

  public async write(document: SecurityAuditDocument, expectedGeneration: number): Promise<void> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new RuntimeError('INVALID_REQUEST', 'expectedGeneration must be a non-negative integer');
    }
    const current = await this.read();
    if (current.generation !== expectedGeneration) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Security audit generation is stale');
    }
    if (document.generation !== expectedGeneration + 1) {
      throw new RuntimeError('INVALID_REQUEST', 'Security audit generation must advance exactly once');
    }
    const validated = validateSecurityAuditDocument(document);
    const filename = path.join(this.dataRoot, FILE);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Atomic security audit publication failed', { cause: error });
    }
  }
}
