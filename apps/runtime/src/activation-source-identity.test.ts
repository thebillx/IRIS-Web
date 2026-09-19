import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { assertActivationWorkloadReady, inspectActivationSourceIdentity } from './activation-source-identity.js';

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

  it('rejects an untracked workspace-domain source file used by the runtime', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'packages', 'domain', 'src', 'injected.ts'), 'export const injected = true;\n');
    await expect(inspectActivationSourceIdentity(root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects a clean source candidate that is not hydrated for runtime startup', async () => {
    const root = await fixture();
    await expect(assertActivationWorkloadReady(root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('accepts source-local runtime and web startup dependencies', async () => {
    const root = await fixture();
    await hydrateWorkload(root);
    await expect(assertActivationWorkloadReady(root)).resolves.toBeUndefined();
  });

  it('keeps source identity stable when ignored runtime dependencies are hydrated', async () => {
    const root = await fixture();
    const before = await inspectActivationSourceIdentity(root);
    await hydrateWorkload(root);
    await expect(inspectActivationSourceIdentity(root)).resolves.toEqual(before);
  });

  it('supports built runtime mode without tsx when dist main and runtime dependencies exist', async () => {
    const root = await fixture();
    await hydrateWorkload(root);
    await rm(path.join(root, 'apps', 'runtime', 'src', 'main.ts'));
    await rm(path.join(root, 'apps', 'runtime', 'node_modules', 'tsx'), { recursive: true, force: true });
    await mkdir(path.join(root, 'apps', 'runtime', 'dist'), { recursive: true });
    await writeFile(path.join(root, 'apps', 'runtime', 'dist', 'main.js'), 'export {};\n');
    await expect(assertActivationWorkloadReady(root)).resolves.toBeUndefined();
  });

  it('rejects a startup executable that resolves outside the candidate root', async () => {
    const root = await fixture();
    await hydrateWorkload(root);
    const vite = path.join(root, 'apps', 'web', 'node_modules', '.bin', 'vite');
    await rm(vite);
    await symlink('/bin/sh', vite);
    await expect(assertActivationWorkloadReady(root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects a partially hydrated web dependency set', async () => {
    const root = await fixture();
    await hydrateWorkload(root);
    await rm(path.join(root, 'apps', 'web', 'node_modules', '@vitejs', 'plugin-react', 'package.json'));
    await expect(assertActivationWorkloadReady(root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

async function hydrateWorkload(root: string): Promise<void> {
  await mkdir(path.join(root, 'apps', 'runtime', 'node_modules', 'tsx', 'dist'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'runtime', 'node_modules', 'tsx', 'dist', 'preflight.cjs'), 'module.exports = {};\n');
  await writeFile(path.join(root, 'apps', 'runtime', 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'export {};\n');
  await mkdir(path.join(root, 'apps', 'runtime', 'node_modules', '@iris'), { recursive: true });
  await symlink(
    path.join(root, 'packages', 'domain'),
    path.join(root, 'apps', 'runtime', 'node_modules', '@iris', 'domain'),
    'dir',
  );
  const webNodeModules = path.join(root, 'apps', 'web', 'node_modules');
  await mkdir(path.join(webNodeModules, '.bin'), { recursive: true });
  const vite = path.join(webNodeModules, '.bin', 'vite');
  await writeFile(vite, '#!/bin/sh\nexit 0\n');
  await chmod(vite, 0o700);
  for (const packageName of ['vite', '@vitejs/plugin-react', 'react', 'react-dom']) {
    const packageRoot = path.join(webNodeModules, ...packageName.split('/'));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: packageName }) + '\n');
  }
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-activation-source-identity-'));
  roots.push(root);
  await mkdir(path.join(root, 'apps', 'runtime', 'src'), { recursive: true });
  await mkdir(path.join(root, 'apps', 'web', 'src'), { recursive: true });
  await mkdir(path.join(root, 'packages', 'domain', 'src'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'apps/runtime/node_modules/\napps/web/node_modules/\n');
  await writeFile(path.join(root, 'apps', 'runtime', 'src', 'main.ts'), 'export const runtime = true;\n');
  await writeFile(path.join(root, 'apps', 'web', 'src', 'App.tsx'), 'export const App = () => null;\n');
  await writeFile(path.join(root, 'packages', 'domain', 'package.json'), '{"name":"@iris/domain","exports":{".":"./src/index.ts"}}\n');
  await writeFile(path.join(root, 'packages', 'domain', 'src', 'index.ts'), 'export const domain = true;\n');
  await execFileAsync('git', ['init', '-b', 'fixture'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  await execFileAsync('git', ['add', '--', '.gitignore', 'apps/runtime/src/main.ts', 'apps/web/src/App.tsx', 'packages/domain/package.json', 'packages/domain/src/index.ts'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  await execFileAsync('git', [
    '-c', 'user.name=IRIS Test',
    '-c', 'user.email=iris-test@example.invalid',
    'commit', '-m', 'activation source identity fixture',
  ], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  return root;
}
