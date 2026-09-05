import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeRuntimeAuthority } from './authority.js';
import { startDaemon } from './daemon.js';
import { readEndpoint, readRuntimeControl } from './persistence.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('daemon startup cleanup', () => {
  it('releases runtime authority when permission initialization fails', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-daemon-init-failure-'));
    roots.push(dataRoot);
    await writeFile(path.join(dataRoot, 'permissions.json'), '{not-json', { mode: 0o600 });

    await expect(startDaemon({ dataRoot, preferredPort: 0 })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await expect(probeRuntimeAuthority(dataRoot)).resolves.toEqual({ state: 'unowned' });
    await expect(readEndpoint(dataRoot)).resolves.toBeNull();
    await expect(readRuntimeControl(dataRoot)).resolves.toBeNull();
  });
});
