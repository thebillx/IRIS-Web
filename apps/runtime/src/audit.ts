import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { RuntimeError, type AuditResult, type PermissionAuditEvent, type PermissionDecisionRecord } from '@iris/domain';
import { inspectPrivateRegularFile, openPrivateAppendFile } from './private-fs.js';

const AUDIT_FILE = 'audit.jsonl';
const MAX_AUDIT_READ_BYTES = 1024 * 1024;
const MAX_RECENT_EVENTS = 200;

export class PermissionAuditStore {
  private appendTail: Promise<void> = Promise.resolve();

  public constructor(private readonly dataRoot: string) {}

  public append(record: PermissionDecisionRecord, result: AuditResult): Promise<PermissionAuditEvent> {
    const event: PermissionAuditEvent = { id: randomUUID(), ...record, result };
    const operation = this.appendTail.then(async () => {
      const filename = path.join(this.dataRoot, AUDIT_FILE);
      let handle: Awaited<ReturnType<typeof openPrivateAppendFile>>;
      try {
        handle = await openPrivateAppendFile(filename, 'Permission audit log');
      } catch (error) {
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Permission audit log could not be opened safely', { cause: error });
      }
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.appendTail = operation.then(() => undefined, () => undefined);
    return operation.then(() => event);
  }

  public async recent(limit = 50): Promise<readonly PermissionAuditEvent[]> {
    const boundedLimit = Math.min(MAX_RECENT_EVENTS, Math.max(1, Math.trunc(limit)));
    const filename = path.join(this.dataRoot, AUDIT_FILE);
    const inspected = await inspectPrivateRegularFile(filename, 'Permission audit log');
    if (inspected.state === 'missing') return [];
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    const content = inspected.content.length <= MAX_AUDIT_READ_BYTES
      ? inspected.content
      : inspected.content.slice(-MAX_AUDIT_READ_BYTES);
    const lines = content.split('\n').filter((line) => line.length > 0);
    const events: PermissionAuditEvent[] = [];
    for (const line of lines.slice(-boundedLimit)) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isPermissionAuditEvent(parsed)) events.push(parsed);
      } catch {
        // Corrupt audit tails do not become trusted events.
      }
    }
    return events.reverse();
  }
}

export async function auditFileContains(dataRoot: string, needle: string): Promise<boolean> {
  const inspected = await inspectPrivateRegularFile(path.join(dataRoot, AUDIT_FILE), 'Permission audit log');
  return inspected.state === 'ok' && inspected.content.includes(needle);
}

function isPermissionAuditEvent(value: unknown): value is PermissionAuditEvent {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.timestamp === 'string'
    && (value.clientId === null || typeof value.clientId === 'string')
    && (value.sessionId === null || typeof value.sessionId === 'string')
    && (value.agentId === null || typeof value.agentId === 'string')
    && typeof value.capabilityId === 'string'
    && (value.riskClass === 'LOW' || value.riskClass === 'MODERATE' || value.riskClass === 'HIGH' || value.riskClass === 'SYSTEM')
    && (value.projectId === null || typeof value.projectId === 'string')
    && (value.target === null || typeof value.target === 'string')
    && (value.decision === 'ALLOW_AUTO' || value.decision === 'ALLOW_ONCE' || value.decision === 'DENY' || value.decision === 'OWNER_REQUIRED')
    && typeof value.reason === 'string'
    && (value.result === 'DECISION' || value.result === 'PENDING' || value.result === 'SUCCESS' || value.result === 'FAILED' || value.result === 'DENIED');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
