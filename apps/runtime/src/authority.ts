import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type RuntimeIdentity } from '@iris/domain';

const AUTHORITY_DIRECTORY = 'authority';
const LOCK_DIRECTORY = 'owner.lock';
const OWNER_FILE = 'owner.json';

interface AuthorityOwnerDocument {
  readonly schemaVersion: 1;
  readonly identity: RuntimeIdentity;
}

export type AuthorityProbe =
  | { readonly state: 'unowned' }
  | { readonly state: 'live'; readonly identity: RuntimeIdentity }
  | { readonly state: 'stale'; readonly identity: RuntimeIdentity }
  | { readonly state: 'indeterminate'; readonly reason: string };

export interface RuntimeAuthority {
  readonly identity: RuntimeIdentity;
  release(): Promise<void>;
}

export async function probeRuntimeAuthority(dataRoot: string): Promise<AuthorityProbe> {
  const owner = await readOwner(path.join(dataRoot, AUTHORITY_DIRECTORY, LOCK_DIRECTORY));
  if (owner.kind === 'missing-lock') return { state: 'unowned' };
  if (owner.kind === 'invalid') return { state: 'indeterminate', reason: owner.reason };
  const liveness = processLiveness(owner.identity.pid);
  if (liveness === 'alive') return { state: 'live', identity: owner.identity };
  if (liveness === 'dead') return { state: 'stale', identity: owner.identity };
  return { state: 'indeterminate', reason: 'Previous authority process liveness could not be determined safely' };
}

export async function acquireRuntimeAuthority(
  dataRoot: string,
  identity: RuntimeIdentity,
): Promise<RuntimeAuthority> {
  const authorityRoot = path.join(dataRoot, AUTHORITY_DIRECTORY);
  const lockDirectory = path.join(authorityRoot, LOCK_DIRECTORY);
  await mkdir(authorityRoot, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claim = path.join(authorityRoot, `.claim-${identity.instanceId}-${randomUUID()}`);
    await mkdir(claim, { mode: 0o700 });
    await writeFile(
      path.join(claim, OWNER_FILE),
      `${JSON.stringify({ schemaVersion: 1, identity } satisfies AuthorityOwnerDocument, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    try {
      await rename(claim, lockDirectory);
      return createAuthorityHandle(lockDirectory, identity);
    } catch (error: unknown) {
      await rm(claim, { recursive: true, force: true });
      if (!isAlreadyExists(error)) {
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Could not acquire runtime authority', { cause: error });
      }
    }

    const probe = await probeRuntimeAuthority(dataRoot);
    if (probe.state === 'live') {
      throw new RuntimeError('AUTHORITY_HELD', 'Another IRIS runtime already owns machine authority');
    }
    if (probe.state === 'indeterminate') {
      throw new RuntimeError('AUTHORITY_INDETERMINATE', probe.reason);
    }
    if (probe.state === 'unowned') continue;

    const quarantine = path.join(authorityRoot, `.stale-${probe.identity.instanceId}-${randomUUID()}`);
    try {
      await rename(lockDirectory, quarantine);
    } catch (error: unknown) {
      if (isNotFound(error) || isAlreadyExists(error)) continue;
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Stale runtime authority could not be isolated safely', { cause: error });
    }
    await rm(quarantine, { recursive: true, force: true });
  }

  throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime authority acquisition did not converge safely');
}

function createAuthorityHandle(lockDirectory: string, identity: RuntimeIdentity): RuntimeAuthority {
  let released = false;
  return {
    identity,
    async release(): Promise<void> {
      if (released) return;
      const owner = await readOwner(lockDirectory);
      if (owner.kind !== 'owner'
        || owner.identity.instanceId !== identity.instanceId
        || owner.identity.runtimeId !== identity.runtimeId) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority identity changed before release');
      }

      const quarantine = `${lockDirectory}.release-${identity.instanceId}-${randomUUID()}`;
      try {
        await rename(lockDirectory, quarantine);
      } catch (error) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority could not be released safely', { cause: error });
      }
      await rm(quarantine, { recursive: true, force: true });
      released = true;
    },
  };
}

type OwnerRead =
  | { readonly kind: 'missing-lock' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'owner'; readonly identity: RuntimeIdentity };

async function readOwner(lockDirectory: string): Promise<OwnerRead> {
  let lockStats;
  try {
    lockStats = await lstat(lockDirectory);
  } catch (error: unknown) {
    return isNotFound(error)
      ? { kind: 'missing-lock' }
      : { kind: 'invalid', reason: 'Authority lock metadata is unreadable' };
  }
  if (!lockStats.isDirectory() || lockStats.isSymbolicLink()) {
    return { kind: 'invalid', reason: 'Authority lock is not a physical directory' };
  }

  const ownerFile = path.join(lockDirectory, OWNER_FILE);
  try {
    const ownerStats = await lstat(ownerFile);
    if (!ownerStats.isFile() || ownerStats.isSymbolicLink()) {
      return { kind: 'invalid', reason: 'Authority owner record is not a physical file' };
    }
    const parsed = JSON.parse(await readFile(ownerFile, 'utf8')) as unknown;
    if (!isAuthorityOwner(parsed)) return { kind: 'invalid', reason: 'Authority owner record is invalid' };
    return { kind: 'owner', identity: parsed.identity };
  } catch (error: unknown) {
    return isNotFound(error)
      ? { kind: 'invalid', reason: 'Authority lock exists without a valid owner record' }
      : { kind: 'invalid', reason: 'Authority owner record is unreadable' };
  }
}

function processLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function isAuthorityOwner(value: unknown): value is AuthorityOwnerDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1
    || typeof record.identity !== 'object'
    || record.identity === null
    || Array.isArray(record.identity)) return false;

  const identity = record.identity as Record<string, unknown>;
  return isIdentity(identity.runtimeId)
    && isIdentity(identity.instanceId)
    && Number.isSafeInteger(identity.pid)
    && (identity.pid as number) > 0
    && typeof identity.startedAt === 'string'
    && Number.isFinite(Date.parse(identity.startedAt))
    && identity.platform === 'darwin'
    && identity.version === '0.0.0';
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256 && !value.includes('\0');
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && ['EEXIST', 'ENOTEMPTY'].includes(String((error as NodeJS.ErrnoException).code));
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
