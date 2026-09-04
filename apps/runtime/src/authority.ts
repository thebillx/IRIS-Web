import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type RuntimeIdentity } from '@iris/domain';
import { privateDirectoryProblem } from './private-fs.js';

const AUTHORITY_DIRECTORY = 'authority';
const OWNER_LOCK = 'owner.lock';
const MAX_ACQUISITION_ATTEMPTS = 8;

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
  const owner = await readOwner(ownerPath(dataRoot));
  if (owner.kind === 'missing') return { state: 'unowned' };
  if (owner.kind === 'invalid') return { state: 'indeterminate', reason: owner.reason };
  const liveness = processLiveness(owner.identity.pid);
  if (liveness === 'alive') return { state: 'live', identity: owner.identity };
  if (liveness === 'dead') return { state: 'stale', identity: owner.identity };
  return { state: 'indeterminate', reason: 'Previous authority process liveness could not be determined safely' };
}

export async function acquireRuntimeAuthority(dataRoot: string, identity: RuntimeIdentity): Promise<RuntimeAuthority> {
  validateRuntimeIdentity(identity);
  const authorityRoot = path.join(dataRoot, AUTHORITY_DIRECTORY);
  const owner = path.join(authorityRoot, OWNER_LOCK);
  await import('node:fs/promises').then(({ mkdir }) => mkdir(authorityRoot, { recursive: true, mode: 0o700 }));
  const authorityDirectoryProblem = await privateDirectoryProblem(authorityRoot, 'Runtime authority directory');
  if (authorityDirectoryProblem !== null) throw new RuntimeError('AUTHORITY_INDETERMINATE', authorityDirectoryProblem);

  for (let attempt = 0; attempt < MAX_ACQUISITION_ATTEMPTS; attempt += 1) {
    const observed = await probeRuntimeAuthority(dataRoot);
    if (observed.state === 'live') throw new RuntimeError('AUTHORITY_HELD', 'Another IRIS runtime already owns machine authority');
    if (observed.state === 'indeterminate') throw new RuntimeError('AUTHORITY_INDETERMINATE', observed.reason);
    if (observed.state === 'stale') {
      await removeVerifiedStaleOwner(authorityRoot, owner, observed.identity);
      continue;
    }

    const claim = path.join(authorityRoot, `.claim-${identity.instanceId}-${randomUUID()}.json`);
    await writeClaim(claim, identity);
    try {
      await link(claim, owner);
      const published = await readOwner(owner);
      if (published.kind !== 'owner' || !sameIdentity(published.identity, identity)) {
        throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime authority publication could not be verified');
      }
      return createAuthorityHandle(authorityRoot, owner, identity);
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) {
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Could not publish runtime authority', { cause: error });
      }
    } finally {
      await rm(claim, { force: true });
    }
  }

  throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime authority acquisition did not converge safely');
}

async function removeVerifiedStaleOwner(authorityRoot: string, owner: string, expectedIdentity: RuntimeIdentity): Promise<void> {
  const quarantine = path.join(authorityRoot, `.stale-${expectedIdentity.instanceId}-${randomUUID()}.json`);
  try {
    await rename(owner, quarantine);
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Stale runtime authority could not be isolated safely', { cause: error });
  }
  const isolated = await readOwner(quarantine);
  if (isolated.kind !== 'owner' || !sameIdentity(isolated.identity, expectedIdentity)) {
    await restoreQuarantine(quarantine, owner);
    throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority changed while stale ownership was being isolated');
  }
  const liveness = processLiveness(isolated.identity.pid);
  if (liveness !== 'dead') {
    await restoreQuarantine(quarantine, owner);
    if (liveness === 'alive') throw new RuntimeError('AUTHORITY_HELD', 'Previous runtime PID became live during stale recovery');
    throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Previous runtime liveness became ambiguous during stale recovery');
  }
  await rm(quarantine);
}

function createAuthorityHandle(authorityRoot: string, owner: string, identity: RuntimeIdentity): RuntimeAuthority {
  let released = false;
  return {
    identity,
    async release(): Promise<void> {
      if (released) return;
      const current = await readOwner(owner);
      if (current.kind !== 'owner' || !sameIdentity(current.identity, identity)) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority identity changed before release');
      }
      const quarantine = path.join(authorityRoot, `.release-${identity.instanceId}-${randomUUID()}.json`);
      try {
        await rename(owner, quarantine);
      } catch (error) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority could not be released safely', { cause: error });
      }
      const isolated = await readOwner(quarantine);
      if (isolated.kind !== 'owner' || !sameIdentity(isolated.identity, identity)) {
        await restoreQuarantine(quarantine, owner);
        throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority changed during release');
      }
      await rm(quarantine);
      released = true;
    },
  };
}

async function writeClaim(filename: string, identity: RuntimeIdentity): Promise<void> {
  const handle = await open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, identity } satisfies AuthorityOwnerDocument)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function restoreQuarantine(quarantine: string, destination: string): Promise<void> {
  try {
    await link(quarantine, destination);
    await rm(quarantine);
  } catch (error) {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Authority quarantine could not be restored safely', { cause: error });
  }
}

type OwnerRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'owner'; readonly identity: RuntimeIdentity };

async function readOwner(filename: string): Promise<OwnerRead> {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error: unknown) {
    return isNotFound(error) ? { kind: 'missing' } : { kind: 'invalid', reason: 'Authority owner metadata is unreadable' };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return { kind: 'invalid', reason: 'Authority owner is not a physical regular file' };
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) return { kind: 'invalid', reason: 'Authority owner is not owned by the current user' };
  if ((metadata.mode & 0o077) !== 0) return { kind: 'invalid', reason: 'Authority owner permissions grant group or other access' };
  try {
    const parsed = JSON.parse(await readFile(filename, 'utf8')) as unknown;
    if (!isAuthorityOwner(parsed)) return { kind: 'invalid', reason: 'Authority owner record is invalid' };
    return { kind: 'owner', identity: parsed.identity };
  } catch (error: unknown) {
    if (isNotFound(error)) return { kind: 'missing' };
    if (error instanceof SyntaxError) return { kind: 'invalid', reason: 'Authority owner record is invalid JSON' };
    return { kind: 'invalid', reason: 'Authority owner record is unreadable' };
  }
}

function ownerPath(dataRoot: string): string {
  return path.join(dataRoot, AUTHORITY_DIRECTORY, OWNER_LOCK);
}

function processLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function isAuthorityOwner(value: unknown): value is AuthorityOwnerDocument {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.identity)) return false;
  try {
    validateRuntimeIdentity(value.identity as unknown as RuntimeIdentity);
    return true;
  } catch {
    return false;
  }
}

function validateRuntimeIdentity(identity: RuntimeIdentity): void {
  if (!isUuid(identity.runtimeId)
    || !isUuid(identity.instanceId)
    || !Number.isSafeInteger(identity.pid)
    || identity.pid <= 0
    || !Number.isFinite(Date.parse(identity.startedAt))
    || identity.platform !== 'darwin'
    || identity.version !== '0.0.0') {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime identity is invalid');
  }
}

function sameIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.runtimeId === right.runtimeId
    && left.instanceId === right.instanceId
    && left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.platform === right.platform
    && left.version === right.version;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
