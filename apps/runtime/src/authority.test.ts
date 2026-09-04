import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeIdentity } from '@iris/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRuntimeAuthority, probeRuntimeAuthority } from './authority.js';

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
    await expect(probeRuntimeAuthority(root)).resolves.toEqual({ state: 'unowned' });
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
