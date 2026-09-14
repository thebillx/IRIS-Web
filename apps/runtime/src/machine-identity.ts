import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { inspectPrivateRegularFile } from './private-fs.js';

const MACHINE_ID_FILE = 'machine-id.json';

interface MachineIdentityDocument {
  readonly schemaVersion: 1;
  readonly machineId: string;
}

export function machineIdentityPath(dataRoot: string): string {
  return path.join(dataRoot, MACHINE_ID_FILE);
}

export async function loadOrCreateMachineId(dataRoot: string): Promise<string> {
  const filename = machineIdentityPath(dataRoot);
  const existing = await readMachineId(dataRoot);
  if (existing !== null) return existing;
  const machineId = randomUUID();
  const handle = await open(filename, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return null;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Could not create machine identity', { cause: error });
  });
  if (handle === null) {
    const concurrent = await readMachineId(dataRoot);
    if (concurrent === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Machine identity was created concurrently but is unreadable');
    return concurrent;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, machineId } satisfies MachineIdentityDocument)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return machineId;
}

export async function readMachineId(dataRoot: string): Promise<string | null> {
  const inspected = await inspectPrivateRegularFile(machineIdentityPath(dataRoot), 'Machine identity document');
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  try {
    const parsed = JSON.parse(inspected.content) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isUuid(parsed.machineId)) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Machine identity document is invalid');
    }
    return parsed.machineId;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Machine identity document is invalid JSON', { cause: error });
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
