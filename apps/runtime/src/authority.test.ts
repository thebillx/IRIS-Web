import { randomUUID } from 'node:crypto';
import { access, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeIdentity } from '@iris/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRuntimeAuthority, probeRuntimeAuthority } from './authority.js';
import { observeProcessStart } from './macos-safety.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('machine runtime authority', () => {
  it('allows exactly one owner and denies a concurrent second daemon', async () => {
    const root = await fixture();
    const attempts = await Promise.allSettled([
      acquireRuntimeAuthority(root, identity(process.pid)),
      acquireRuntimeAuthority(root, identity(process.pid)),
    ]);
    const winners = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireRuntimeAuthority>>> => result.status === 'fulfilled');
    const losers = attempts.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ reason: { code: 'AUTHORITY_HELD' } });
    await winners[0]!.value.release();
    expect(await probeRuntimeAuthority(root)).toEqual({ state: 'unowned' });
  });

  it('recovers a valid stale owner only after its recorded PID is proven dead', async () => {
    const root = await fixture();
    const stale = identity(2_147_483_647);
    const owner = await ownerFixture(root, stale);
    expect(await probeRuntimeAuthority(root)).toMatchObject({ state: 'stale', identity: stale });
    expect((await lstat(owner)).isFile()).toBe(true);

    const replacement = identity(process.pid);
    const authority = await acquireRuntimeAuthority(root, replacement);
    expect(await probeRuntimeAuthority(root)).toMatchObject({ state: 'live', identity: replacement });
    await authority.release();
  });

  it('allows at most one successor when contenders race to recover the same verified stale owner', async () => {
    const root = await fixture();
    const stale = identity(2_147_483_647);
    await ownerFixture(root, stale);

    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => acquireRuntimeAuthority(root, identity(process.pid))));
    const winners = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireRuntimeAuthority>>> => result.status === 'fulfilled');
    const losers = attempts.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(3);
    for (const loser of losers) {
      expect(['AUTHORITY_HELD', 'AUTHORITY_INDETERMINATE', 'AUTHORITY_CHANGED']).toContain((loser.reason as { code?: string }).code);
    }
    await expect(probeRuntimeAuthority(root)).resolves.toMatchObject({ state: 'live', identity: winners[0]!.value.identity });
    await expect(access(path.join(root, 'authority', '.recovery.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(root, 'authority', '.recovery.swap.guard'))).rejects.toMatchObject({ code: 'ENOENT' });
    await winners[0]!.value.release();
  });

  it('fails closed for a supported v1 owner while its PID is live because process-instance identity is unavailable', async () => {
    const root = await fixture();
    const legacyLive = identity(process.pid);
    await ownerFixture(root, legacyLive);

    await expect(probeRuntimeAuthority(root)).resolves.toMatchObject({ state: 'indeterminate' });
    await expect(acquireRuntimeAuthority(root, identity(process.pid))).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
  });

  it('fails closed for unknown or ambiguous authority record representations', async () => {
    const root = await fixture();
    const authorityRoot = path.join(root, 'authority');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(authorityRoot, { recursive: true, mode: 0o700 }));
    const owner = path.join(authorityRoot, 'owner.lock');
    await writeFile(owner, `${JSON.stringify({ schemaVersion: 3, identity: identity(process.pid) })}\n`, { mode: 0o600 });
    await expect(probeRuntimeAuthority(root)).resolves.toMatchObject({ state: 'indeterminate' });
    await expect(acquireRuntimeAuthority(root, identity(process.pid))).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });

    await writeFile(owner, `${JSON.stringify({ schemaVersion: 1, identity: identity(process.pid), processStartMarker: '1:000001' })}\n`, { mode: 0o600 });
    await expect(probeRuntimeAuthority(root)).resolves.toMatchObject({ state: 'indeterminate' });
  });

  it('observes authority without mutating the owner record', async () => {
    const root = await fixture();
    const authority = await acquireRuntimeAuthority(root, identity(process.pid));
    const owner = path.join(root, 'authority', 'owner.lock');
    const before = await readFile(owner, 'utf8');
    await probeRuntimeAuthority(root);
    const after = await readFile(owner, 'utf8');
    expect(after).toBe(before);
    await authority.release();
  });

  it('rejects a reused PID when the process-start marker differs only at microsecond precision', async () => {
    const root = await fixture();
    const observed = observeProcessStart(process.pid);
    if (observed.state !== 'live') throw new Error('Expected current macOS process identity');
    const [seconds, microseconds] = observed.marker.split(':');
    const differentMicroseconds = ((Number(microseconds) + 1) % 1_000_000).toString().padStart(6, '0');
    const reused = identity(process.pid);
    await ownerFixtureV2(root, reused, `${seconds}:${differentMicroseconds}`);

    await expect(probeRuntimeAuthority(root)).resolves.toMatchObject({ state: 'stale', identity: reused });
    const successor = await acquireRuntimeAuthority(root, identity(process.pid));
    await expect(probeRuntimeAuthority(root)).resolves.toMatchObject({ state: 'live', identity: successor.identity });
    await successor.release();
  });

  it('fails closed for an incomplete or symlinked authority owner', async () => {
    const root = await fixture();
    const authorityRoot = path.join(root, 'authority');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(authorityRoot, { recursive: true, mode: 0o700 }));
    const owner = path.join(authorityRoot, 'owner.lock');
    await writeFile(owner, '', { mode: 0o600 });
    expect(await probeRuntimeAuthority(root)).toMatchObject({ state: 'indeterminate' });
    await expect(acquireRuntimeAuthority(root, identity(process.pid))).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });

    await rm(owner);
    const outside = path.join(await fixture(), 'outside-owner.json');
    await writeFile(outside, '{}', { mode: 0o600 });
    await symlink(outside, owner);
    expect(await probeRuntimeAuthority(root)).toMatchObject({ state: 'indeterminate' });
    expect((await lstat(owner)).isSymbolicLink()).toBe(true);
    await expect(acquireRuntimeAuthority(root, identity(process.pid))).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
  });

  it('refuses a symlinked authority directory instead of publishing through it', async () => {
    const root = await fixture();
    const outsideRoot = await fixture();
    const outsideAuthority = path.join(outsideRoot, 'authority-target');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(outsideAuthority, { mode: 0o700 }));
    await symlink(outsideAuthority, path.join(root, 'authority'));

    await expect(acquireRuntimeAuthority(root, identity(process.pid))).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
    await expect(probeRuntimeAuthority(root)).resolves.toMatchObject({ state: 'indeterminate' });
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-authority-'));
  roots.push(root);
  return root;
}

async function ownerFixture(root: string, runtimeIdentity: RuntimeIdentity): Promise<string> {
  const authorityRoot = path.join(root, 'authority');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(authorityRoot, { recursive: true, mode: 0o700 }));
  const owner = path.join(authorityRoot, 'owner.lock');
  await writeFile(owner, `${JSON.stringify({ schemaVersion: 1, identity: runtimeIdentity })}\n`, { mode: 0o600 });
  return owner;
}

async function ownerFixtureV2(root: string, runtimeIdentity: RuntimeIdentity, processStartMarker: string): Promise<string> {
  const authorityRoot = path.join(root, 'authority');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(authorityRoot, { recursive: true, mode: 0o700 }));
  const owner = path.join(authorityRoot, 'owner.lock');
  await writeFile(owner, `${JSON.stringify({ schemaVersion: 2, identity: runtimeIdentity, processStartMarker })}\n`, { mode: 0o600 });
  return owner;
}

function identity(pid: number): RuntimeIdentity {
  return {
    runtimeId: randomUUID(),
    instanceId: randomUUID(),
    pid,
    startedAt: new Date().toISOString(),
    platform: 'darwin',
    version: '0.0.0',
  };
}
