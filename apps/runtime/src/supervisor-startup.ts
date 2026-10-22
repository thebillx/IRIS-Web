import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';

export const startupStates = ['PREPARED', 'SPAWNING', 'OWNERSHIP_VERIFIED', 'RUNNING', 'SPAWN_FAILED', 'OWNERSHIP_UNVERIFIED', 'CLEANUP_PENDING', 'CLEANUP_FAILED', 'RECONCILIATION_REQUIRED', 'STOPPED'] as const;
export type StartupState = typeof startupStates[number];
export interface HistoricalOwnershipReconciliation {
  readonly version: 1;
  readonly sourceSchemaVersion: 1 | 2 | 3;
  readonly method: 'RUNTIME_AUTHORITY_ENDPOINT';
  readonly historicalRecordDigest: string;
  readonly listenerPorts: readonly number[];
}
export interface StartupOperation {
  readonly version: 1;
  readonly id: string;
  readonly transactionId: string;
  readonly component: string;
  readonly state: StartupState;
  readonly supervisorPid: number;
  readonly supervisorStartMarker: string;
  readonly sourceRoot: string;
  readonly dataRoot: string;
  readonly executable: string;
  readonly profilePath: string | null;
  readonly configurationDigest: string;
  readonly pid: number | null;
  readonly processStartMarker: string | null;
  readonly processExecutable: string | null;
  readonly expectedProcessExecutable?: string;
  readonly failureCode: string | null;
  readonly ownedProcess?: unknown;
  readonly historicalOwnership?: HistoricalOwnershipReconciliation;
}
export const MAX_STARTUP_OPERATIONS = 38;
export function unresolvedStartup(operation: StartupOperation): boolean {
  return !['RUNNING', 'STOPPED', 'SPAWN_FAILED'].includes(operation.state);
}
export function validStartupOperations(value: unknown): value is StartupOperation[] {
  if (!Array.isArray(value) || value.length > MAX_STARTUP_OPERATIONS) return false;
  const ids = new Set<string>();
  return value.every((item: unknown) => {
    if (typeof item !== 'object' || item === null) return false;
    const op = item as StartupOperation;
    if (op.version !== 1 || typeof op.id !== 'string' || !/^[\da-f-]{36}$/.test(op.id) || ids.has(op.id)) return false;
    ids.add(op.id);
    return typeof op.transactionId === 'string' && /^[\da-f-]{36}$/.test(op.transactionId)
      && ['runtime', 'admin', 'web', 'tunnel-full', 'tunnel-pro', 'tunnel-admin', 'runtime-probe'].includes(op.component)
      && startupStates.includes(op.state) && Number.isSafeInteger(op.supervisorPid) && op.supervisorPid > 0
      && typeof op.supervisorStartMarker === 'string' && /^\d+:\d+$/.test(op.supervisorStartMarker)
      && [op.sourceRoot, op.dataRoot, op.executable].every((p) => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0'))
      && (op.profilePath === null || typeof op.profilePath === 'string' && path.isAbsolute(op.profilePath))
      && typeof op.configurationDigest === 'string' && /^[a-f0-9]{64}$/.test(op.configurationDigest)
      && (op.pid === null || Number.isSafeInteger(op.pid) && op.pid > 0)
      && (op.processStartMarker === null || typeof op.processStartMarker === 'string' && /^\d+:\d+$/.test(op.processStartMarker))
      && (op.processExecutable === null || typeof op.processExecutable === 'string' && path.isAbsolute(op.processExecutable))
      && (op.expectedProcessExecutable === undefined || typeof op.expectedProcessExecutable === 'string' && path.isAbsolute(op.expectedProcessExecutable))
      && (op.failureCode === null || typeof op.failureCode === 'string' && /^[A-Z_]{1,80}$/.test(op.failureCode))
      && (op.historicalOwnership === undefined || validHistoricalOwnership(op.historicalOwnership))
      && (!['OWNERSHIP_VERIFIED', 'RUNNING'].includes(op.state) || op.pid !== null && op.processStartMarker !== null && op.processExecutable !== null);
  });
}

function validHistoricalOwnership(value: unknown): value is HistoricalOwnershipReconciliation {
  if (typeof value !== 'object' || value === null) return false;
  const evidence = value as HistoricalOwnershipReconciliation;
  return evidence.version === 1
    && [1, 2, 3].includes(evidence.sourceSchemaVersion)
    && evidence.method === 'RUNTIME_AUTHORITY_ENDPOINT'
    && typeof evidence.historicalRecordDigest === 'string' && /^[a-f0-9]{64}$/.test(evidence.historicalRecordDigest)
    && Array.isArray(evidence.listenerPorts) && evidence.listenerPorts.length === 1
    && evidence.listenerPorts.every((port) => Number.isSafeInteger(port) && port > 0 && port <= 65_535);
}

// Only ENOENT permits a new state; an unreadable or unsafe file is not an empty supervisor.
export async function readSupervisorStateFile(filename: string): Promise<string | null> {
  let handle;
  try { handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor state cannot be opened safely');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 1_048_576) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor state metadata is invalid');
    }
    const buffer = Buffer.alloc(1_048_577);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1_048_576) throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor state exceeds the size limit');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

export async function writeSupervisorStateFile(filename: string, state: unknown): Promise<void> {
  const content = JSON.stringify(state);
  if (Buffer.byteLength(content) > 1_048_576) throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor state exceeds the size limit');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, filename);
    renamed = true;
    const directory = await open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor state durability could not be established');
  } finally {
    if (!renamed) await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
