import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, realpath } from 'node:fs/promises';
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
  const physical = await realpath(dataRoot);
  if (physical !== path.resolve(dataRoot)) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime data root changed identity during creation');
  }
  await chmod(dataRoot, 0o700);
  await access(dataRoot, fsConstants.R_OK | fsConstants.W_OK);
}

export async function runtimeDataRootWritable(dataRoot: string): Promise<boolean> {
  try {
    await access(dataRoot, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
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
    } catch {
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
