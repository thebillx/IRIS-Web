import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeIdentity } from '@iris/domain';
import { acquireRuntimeAuthority, probeRuntimeAuthority } from './authority.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-authority-'));
  roots.push(root);
  return root;
}

function identity(instanceId: string, pid = process.pid): RuntimeIdentity {
  return { runtimeId: 'runtime-test', instanceId, pid, startedAt: new Date().toISOString(), platform: 'darwin', version: '0.0.0' };
}

describe('single daemon authority', () => {
  it('denies a second live owner and observation does not mutate authority', async () => {
    const root = await fixture();
    const first = await acquireRuntimeAuthority(root, identity('instance-a'));
    const before = await probeRuntimeAuthority(root);
    expect(before).toMatchObject({ state: 'live', identity: { instanceId: 'instance-a' } });
    await expect(acquireRuntimeAuthority(root, identity('instance-b'))).rejects.toMatchObject({ code: 'AUTHORITY_HELD' });
    const after = await probeRuntimeAuthority(root);
    expect(after).toEqual(before);
    await first.release();
    expect(await probeRuntimeAuthority(root)).toEqual({ state: 'unowned' });
  });

  it('recovers a stale authority only after the recorded PID is proven dead', async () => {
    const root = await fixture();
    await acquireRuntimeAuthority(root, identity('stale-instance', 2_147_483_646));
    expect(await probeRuntimeAuthority(root)).toMatchObject({ state: 'stale', identity: { instanceId: 'stale-instance' } });
    const successor = await acquireRuntimeAuthority(root, identity('successor'));
    expect(await probeRuntimeAuthority(root)).toMatchObject({ state: 'live', identity: { instanceId: 'successor' } });
    await successor.release();
  });
});
