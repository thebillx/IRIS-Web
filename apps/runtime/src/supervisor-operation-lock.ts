import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { observeProcessStart } from './macos-safety.js';
import { privateDirectoryProblem } from './private-fs.js';

const SUPERVISOR_DIRECTORY = 'supervisor';
const OPERATION_LOCK_FILE = 'operation.lock';
const RUNTIME_START_LOCK_FILE = 'runtime-start.lock';

interface StrictOperationLock {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly startedAt: string;
  readonly operation: string;
  readonly processStartMarker: string;
}

export interface StrictSupervisorOperationLease {
  release(): Promise<void>;
}

/**
 * Cross-process lock for mutations that must serialize with legacy lifecycle
 * commands as well as the Supervisor control path. Existing locks are never
 * reclaimed here: a credential mutation must stop on any ambiguity.
 */
export async function withStrictSupervisorOperationLock<T>(
  dataRoot: string,
  operation: string,
  work: () => Promise<T>,
  lockFile = OPERATION_LOCK_FILE,
): Promise<T> {
  const lease = await acquireStrictSupervisorOperationLock(dataRoot, operation, lockFile);
  let result: T | undefined;
  let workError: unknown;
  try {
    result = await work();
  } catch (error: unknown) {
    workError = error;
  }
  let releaseError: unknown;
  try {
    await lease.release();
  } catch (error: unknown) {
    releaseError = error;
  }
  if (releaseError !== undefined && operation === 'rotate-owner-access') {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Owner access rotation lock cleanup is unknown; verify before retrying', { cause: releaseError });
  }
  if (workError !== undefined) throw workError;
  if (releaseError !== undefined) throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor operation lock cleanup failed', { cause: releaseError });
  return result as T;
}

export async function acquireStrictSupervisorOperationLock(
  dataRoot: string,
  operation: string,
  lockFile = OPERATION_LOCK_FILE,
): Promise<StrictSupervisorOperationLease> {
  const supervisorRoot = path.join(path.resolve(dataRoot), SUPERVISOR_DIRECTORY);
  await mkdir(supervisorRoot, { recursive: true, mode: 0o700 });
  const directoryProblem = await privateDirectoryProblem(supervisorRoot, 'IRIS supervisor directory');
  if (directoryProblem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', directoryProblem);

  const processStart = observeProcessStart(process.pid);
  if (processStart.state !== 'live') throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor process start identity could not be measured safely');
  const filename = path.join(supervisorRoot, lockFile);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filename, 'wx', 0o600);
  } catch (error) {
    if (isAlreadyExists(error)) throw new RuntimeError('SUPERVISOR_BUSY', 'Supervisor operation state is present; refusing the bounded mutation');
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Supervisor operation lock could not be created', { cause: error });
  }

  let initialized = false;
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      operation,
      processStartMarker: processStart.marker,
    } satisfies StrictOperationLock)}\n`, 'utf8');
    await handle.sync();
    initialized = true;
  } finally {
    try {
      if (!initialized) await rm(filename, { force: true });
    } finally {
      await handle.close();
    }
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await rm(filename);
      } catch (error) {
        throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Supervisor operation lock could not be released safely', { cause: error });
      }
    },
  };
}

export function acquireRuntimeStartupLock(dataRoot: string, operation: string): Promise<StrictSupervisorOperationLease> {
  return acquireStrictSupervisorOperationLock(dataRoot, operation, RUNTIME_START_LOCK_FILE);
}

export function withRuntimeStartupLock<T>(dataRoot: string, operation: string, work: () => Promise<T>): Promise<T> {
  return withStrictSupervisorOperationLock(dataRoot, operation, work, RUNTIME_START_LOCK_FILE);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}
