import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { readRuntimeSourceIdentity } from './source-identity.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('runtime source identity', () => {
  it('returns the deployed Git commit and tree identity without accepting caller input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'iris-source-identity-'));
    roots.push(root);
    await execFileAsync('git', ['init', '-q', '-b', 'candidate'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'iris@test.invalid'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'IRIS Test'], { cwd: root });
    await writeFile(path.join(root, 'README.md'), 'candidate\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-q', '-m', 'candidate'], { cwd: root });

    const identity = await readRuntimeSourceIdentity(root);
    expect(identity.state).toBe('VERIFIED');
    expect(identity.branch).toBe('candidate');
    expect(identity.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(identity.sourceTreeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(identity.sourceRoot).toBe(await realpath(root));
  });

  it('fails closed when the source is not a Git checkout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'iris-source-identity-unverified-'));
    roots.push(root);
    await writeFile(path.join(root, 'README.md'), 'not git\n', 'utf8');
    await expect(readRuntimeSourceIdentity(root)).resolves.toMatchObject({ state: 'SOURCE_IDENTITY_UNVERIFIED' });
  });
});
