import { constants as fsConstants } from 'node:fs';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';

export const RUNTIME_DATA_ENV = 'IRIS_RUNTIME_DATA_ROOT' as const;

export async function resolveRuntimeDataRoot(
  environment: NodeJS.ProcessEnv = process.env,
  sourceRoot = path.resolve(import.meta.dirname, '../../..'),
  homeDirectory = os.homedir(),
): Promise<string> {
  const configured = environment[RUNTIME_DATA_ENV]?.trim();
  const candidate = configured === undefined || configured.length === 0
    ? path.join(homeDirectory, 'Library', 'Application Support', 'IRIS')
    : configured;
  if (!path.isAbsolute(candidate)) throw new RuntimeError('PERSISTENCE_FAILURE', `${RUNTIME_DATA_ENV} must be an absolute path`);
  const canonical = await canonicalizeFuturePath(candidate);
  const canonicalSource = await canonicalizeFuturePath(sourceRoot);
  if (isWithin(canonicalSource, canonical)) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime data root must be outside the source checkout');
  }
  return canonical;
}

export async function ensureRuntimeDataRoot(dataRoot: string): Promise<void> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await verifyRuntimeDataRoot(dataRoot);
}

export async function runtimeDataRootWritable(dataRoot: string): Promise<boolean> {
  try {
    await verifyRuntimeDataRoot(dataRoot);
    return true;
  } catch {
    return false;
  }
}

async function verifyRuntimeDataRoot(dataRoot: string): Promise<void> {
  const absolute = path.resolve(dataRoot);
  let physical: string;
  try {
    physical = await realpath(absolute);
  } catch (error) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime data root cannot be resolved physically', { cause: error });
  }
  if (physical !== absolute) throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime data root changed through a filesystem alias');

  const metadata = await stat(physical).catch((error: unknown) => {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime data root metadata is unavailable', { cause: error });
  });
  if (!metadata.isDirectory()) throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime data root is not a directory');
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime data root is not owned by the current user');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime data root permissions must not grant group or other access');
  }
  try {
    await access(physical, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime data root is not readable and writable', { cause: error });
  }
}

export async function canonicalizeFuturePath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  const suffix: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const physical = await realpath(current);
      return path.join(physical, ...suffix.reverse());
    } catch (error: unknown) {
      if (!isMissingPath(error)) {
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime path cannot be canonicalized safely', { cause: error });
      }
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..');
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code));
}
