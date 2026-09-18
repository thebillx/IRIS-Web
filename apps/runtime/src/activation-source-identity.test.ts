import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectActivationSourceIdentity } from './activation-source-identity.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('activation source identity workload closure', () => {
  it('ignores untracked files outside the executable workload closure', async () => {
    const root = await fixture();
    const before = await inspectActivationSourceIdentity(root);
    await mkdir(path.join(root, '.cache'), { recursive: true });
    await writeFile(path.join(root, '.cache', 'local-only.tmp'), 'cache-only\n');
    await expect(inspectActivationSourceIdentity(root)).resolves.toEqual(before);
  });

  it('rejects an untracked runtime source file', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'apps', 'runtime', 'src', 'injected.ts'), 'export const injected = true;\n');
    await expect(inspectActivationSourceIdentity(root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects an untracked web source file', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'apps', 'web', 'src', 'injected.ts'), 'export const injected = true;\n');
    await expect(inspectActivationSourceIdentity(root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-activation-source-identity-'));
  roots.push(root);
  await mkdir(path.join(root, 'apps', 'runtime', 'src'), { recursive: true });
  await mkdir(path.join(root, 'apps', 'web', 'src'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'runtime', 'src', 'main.ts'), 'export const runtime = true;\n');
  await writeFile(path.join(root, 'apps', 'web', 'src', 'App.tsx'), 'export const App = () => null;\n');
  await execFileAsync('git', ['init', '-b', 'fixture'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  await execFileAsync('git', ['add', '--', 'apps/runtime/src/main.ts', 'apps/web/src/App.tsx'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  await execFileAsync('git', [
    '-c', 'user.name=IRIS Test',
    '-c', 'user.email=iris-test@example.invalid',
    'commit', '-m', 'activation source identity fixture',
  ], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  return root;
}
