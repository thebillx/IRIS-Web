import { randomUUID } from 'node:crypto';
import { link, lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type RuntimeIdentity } from '@iris/domain';
import { inspectPrivateRegularFile, privateDirectoryProblem } from './private-fs.js';
import { atomicSwapPrivateFiles, observeProcessStart } from './macos-safety.js';

const AUTHORITY_DIRECTORY = 'authority';
const OWNER_LOCK = 'owner.lock';
const RECOVERY_LOCK = '.recovery.lock';
const RECOVERY_SWAP_GUARD = '.recovery.swap.guard';
const MAX_ACQUISITION_ATTEMPTS = 8;
export const AUTHORITY_RECOVERY_IN_PROGRESS = 'RUNTIME_RECOVERY_IN_PROGRESS' as const;

interface AuthorityOwnerDocumentV2 {
  readonly schemaVersion: 2;
  readonly identity: RuntimeIdentity;
  readonly processStartMarker: string;
}

interface LegacyAuthorityOwnerDocumentV1 {
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
  const authorityRoot = path.join(dataRoot, AUTHORITY_DIRECTORY);
  const directoryState = await inspectAuthorityDirectory(authorityRoot);
  if (directoryState === 'missing') return { state: 'unowned' };
  if (directoryState !== null) return { state: 'indeterminate', reason: directoryState };
  const owner = await readOwner(ownerPath(dataRoot));
  if (owner.kind === 'missing') return { state: 'unowned' };
  if (owner.kind === 'invalid') return { state: 'indeterminate', reason: owner.reason };
  const liveness = processOwnerLiveness(owner);
  if (liveness === 'alive') return { state: 'live', identity: owner.identity };
  if (liveness === 'dead') return { state: 'stale', identity: owner.identity };
  return { state: 'indeterminate', reason: 'Previous authority process identity could not be verified safely' };
}

export async function acquireRuntimeAuthority(dataRoot: string, identity: RuntimeIdentity): Promise<RuntimeAuthority> {
  validateRuntimeIdentity(identity);
  const processStart = observeProcessStart(identity.pid);
  if (processStart.state !== 'live') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Current process start identity could not be measured safely');
  const processStartMarker = processStart.marker;

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
    await writeClaim(claim, identity, processStartMarker);
    try {
      await link(claim, owner);
      const published = await readOwner(owner);
      if (published.kind !== 'owner'
        || !sameIdentity(published.identity, identity)
        || published.processStartMarker !== processStartMarker) {
        throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime authority publication could not be verified');
      }
      return createAuthorityHandle(authorityRoot, owner, identity, processStartMarker);
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
  const recoveryLock = path.join(authorityRoot, RECOVERY_LOCK);
  const guard = path.join(authorityRoot, RECOVERY_SWAP_GUARD);
  const releaseRecoveryLock = await acquireRecoveryLock(recoveryLock, expectedIdentity);
  try {
    const current = await readOwner(owner);
    if (current.kind === 'missing') return;
    if (current.kind === 'invalid') throw new RuntimeError('AUTHORITY_INDETERMINATE', current.reason);
    if (!sameIdentity(current.identity, expectedIdentity)) {
      const currentLiveness = processOwnerLiveness(current);
      if (currentLiveness === 'alive') throw new RuntimeError('AUTHORITY_HELD', 'A different live runtime owner appeared before stale recovery');
      if (currentLiveness === 'unknown') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime authority became ambiguous before stale recovery');
      throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority changed before stale recovery');
    }
    const currentLiveness = processOwnerLiveness(current);
    if (currentLiveness === 'alive') throw new RuntimeError('AUTHORITY_HELD', 'Previous runtime process became live before stale recovery');
    if (currentLiveness === 'unknown') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Previous runtime process identity became ambiguous before stale recovery');

    await writeRecoveryGuard(guard, expectedIdentity);
    try {
      await atomicSwapPrivateFiles(authorityRoot, OWNER_LOCK, RECOVERY_SWAP_GUARD);
    } catch (error) {
      await rm(guard, { force: true });
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Stale runtime authority could not be isolated atomically', { cause: error });
    }

    const isolated = await readOwner(guard);
    if (isolated.kind !== 'owner' || !sameIdentity(isolated.identity, expectedIdentity)) {
      await restoreSwappedOwner(authorityRoot, RECOVERY_SWAP_GUARD, guard);
      if (isolated.kind === 'owner') {
        const liveness = processOwnerLiveness(isolated);
        if (liveness === 'alive') throw new RuntimeError('AUTHORITY_HELD', 'A different live runtime owner appeared during stale recovery');
        if (liveness === 'unknown') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime authority became ambiguous during stale recovery');
      }
      throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority changed while stale ownership was being isolated');
    }

    const liveness = processOwnerLiveness(isolated);
    if (liveness !== 'dead') {
      await restoreSwappedOwner(authorityRoot, RECOVERY_SWAP_GUARD, guard);
      if (liveness === 'alive') throw new RuntimeError('AUTHORITY_HELD', 'Previous runtime process became live during stale recovery');
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Previous runtime process identity became ambiguous during stale recovery');
    }

    try {
      await rm(guard);
      await rm(owner);
    } catch (error) {
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Verified stale authority could not be retired safely', { cause: error });
    }
  } finally {
    await releaseRecoveryLock();
  }
}

async function acquireRecoveryLock(filename: string, expectedIdentity: RuntimeIdentity): Promise<() => Promise<void>> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filename, 'wx', 0o600);
  } catch (error) {
    if (isAlreadyExists(error)) throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Another stale-authority recovery is already in progress');
    throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Stale-authority recovery lock could not be created safely', { cause: error });
  }
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 0, kind: 'stale-recovery-lock', expectedInstanceId: expectedIdentity.instanceId })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return async () => {
    try {
      await rm(filename);
    } catch (error) {
      throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Stale-authority recovery lock could not be released safely', { cause: error });
    }
  };
}

async function writeRecoveryGuard(filename: string, expectedIdentity: RuntimeIdentity): Promise<void> {
  const handle = await open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 0,
      kind: 'stale-recovery-guard',
      expectedInstanceId: expectedIdentity.instanceId,
    })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function restoreSwappedOwner(authorityRoot: string, guardName: string, guardPath: string): Promise<void> {
  try {
    await atomicSwapPrivateFiles(authorityRoot, OWNER_LOCK, guardName);
    await rm(guardPath, { force: true });
  } catch (error) {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Runtime authority could not be restored after stale-recovery contention', { cause: error });
  }
}

function createAuthorityHandle(
  authorityRoot: string,
  owner: string,
  identity: RuntimeIdentity,
  processStartMarker: string,
): RuntimeAuthority {
  let released = false;
  return {
    identity,
    async release(): Promise<void> {
      if (released) return;
      const current = await readOwner(owner);
      if (current.kind !== 'owner'
        || !sameIdentity(current.identity, identity)
        || current.processStartMarker !== processStartMarker) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority identity changed before release');
      }
      const quarantine = path.join(authorityRoot, `.release-${identity.instanceId}-${randomUUID()}.json`);
      try {
        await rename(owner, quarantine);
      } catch (error) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority could not be released safely', { cause: error });
      }
      const isolated = await readOwner(quarantine);
      if (isolated.kind !== 'owner'
        || !sameIdentity(isolated.identity, identity)
        || isolated.processStartMarker !== processStartMarker) {
        await restoreQuarantine(quarantine, owner);
        throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority changed during release');
      }
      await rm(quarantine);
      released = true;
    },
  };
}

async function writeClaim(filename: string, identity: RuntimeIdentity, processStartMarker: string): Promise<void> {
  const handle = await open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 2, identity, processStartMarker } satisfies AuthorityOwnerDocumentV2)}\n`, 'utf8');
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
  | { readonly kind: 'owner'; readonly identity: RuntimeIdentity; readonly processStartMarker: string | null };

async function readOwner(filename: string): Promise<OwnerRead> {
  const inspected = await inspectPrivateRegularFile(filename, 'Runtime authority owner');
  if (inspected.state === 'missing') return { kind: 'missing' };
  if (inspected.state === 'invalid') return { kind: 'invalid', reason: inspected.reason };
  try {
    const parsed = JSON.parse(inspected.content) as unknown;
    if (isAuthorityOwnerV2(parsed)) return { kind: 'owner', identity: parsed.identity, processStartMarker: parsed.processStartMarker };
    if (isLegacyAuthorityOwnerV1(parsed)) return { kind: 'owner', identity: parsed.identity, processStartMarker: null };
    if (isRecoveryGuard(parsed)) return { kind: 'invalid', reason: AUTHORITY_RECOVERY_IN_PROGRESS };
    return { kind: 'invalid', reason: 'Authority owner record is invalid' };
  } catch {
    return { kind: 'invalid', reason: 'Authority owner record is invalid JSON' };
  }
}

function ownerPath(dataRoot: string): string {
  return path.join(dataRoot, AUTHORITY_DIRECTORY, OWNER_LOCK);
}

async function inspectAuthorityDirectory(authorityRoot: string): Promise<'missing' | string | null> {
  try {
    await lstat(authorityRoot);
  } catch (error: unknown) {
    return isNotFound(error) ? 'missing' : 'Runtime authority directory metadata is unreadable';
  }
  return privateDirectoryProblem(authorityRoot, 'Runtime authority directory');
}

function processOwnerLiveness(owner: Extract<OwnerRead, { kind: 'owner' }>): 'alive' | 'dead' | 'unknown' {
  const observed = observeProcessStart(owner.identity.pid);
  if (observed.state === 'dead') return 'dead';
  if (observed.state === 'indeterminate') return 'unknown';
  if (owner.processStartMarker === null) return 'unknown';
  return observed.marker === owner.processStartMarker ? 'alive' : 'dead';
}

function isRecoveryGuard(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['schemaVersion', 'kind', 'expectedInstanceId'])
    && value.schemaVersion === 0
    && value.kind === 'stale-recovery-guard'
    && isUuid(value.expectedInstanceId);
}

function isAuthorityOwnerV2(value: unknown): value is AuthorityOwnerDocumentV2 {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'identity', 'processStartMarker'])
    || value.schemaVersion !== 2
    || !isRecord(value.identity)
    || typeof value.processStartMarker !== 'string'
    || !/^[1-9]\d*:\d{6}$/.test(value.processStartMarker)) return false;
  try {
    validateRuntimeIdentity(value.identity as unknown as RuntimeIdentity);
    return true;
  } catch {
    return false;
  }
}

function isLegacyAuthorityOwnerV1(value: unknown): value is LegacyAuthorityOwnerDocumentV1 {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'identity'])
    || value.schemaVersion !== 1
    || !isRecord(value.identity)) return false;
  try {
    validateRuntimeIdentity(value.identity as unknown as RuntimeIdentity);
    return true;
  } catch {
    return false;
  }
}

function validateRuntimeIdentity(identity: RuntimeIdentity): void {
  if (!isRecord(identity)
    || !hasOnlyKeys(identity, ['runtimeId', 'instanceId', 'pid', 'startedAt', 'platform', 'version'])
    || !isUuid(identity.runtimeId)
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

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAlreadyExists(error: unknown): boolean {
  return errnoCode(error) === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return errnoCode(error) === 'ENOENT';
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}
