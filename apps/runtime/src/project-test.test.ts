import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runDeclaredProjectScript, runDeclaredProjectTest } from './project-test.js';

async function fixture(packageManager: string, scripts: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-project-test-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager, scripts }));
  return root;
}

describe('governed project validation', () => {
  it('uses npm for an npm project and keeps metacharacters inert', async () => {
    const root = await fixture('npm@11.17.0', { 'unit:contract': 'ignored command text' });
    const execute = vi.fn(async () => ({ stdout: 'ok', stderr: '' }));
    const result = await runDeclaredProjectScript(root, 'unit:contract', { execute: execute as never });
    expect(result.packageManager).toBe('npm');
    expect(execute).toHaveBeenCalledWith('npm', ['run', '--ignore-scripts', 'unit:contract'], expect.objectContaining({ cwd: root }));
    await expect(runDeclaredProjectScript(root, 'unit:contract;touch')).rejects.toThrow('script name is invalid');
  });

  it('uses pnpm for a pnpm project', async () => {
    const root = await fixture('pnpm@10.15.0', { test: 'ignored' });
    const execute = vi.fn(async () => ({ stdout: 'ok', stderr: '' }));
    const result = await runDeclaredProjectScript(root, 'test', { execute: execute as never });
    expect(result.packageManager).toBe('pnpm');
    expect(execute).toHaveBeenCalledWith('pnpm', ['--config.ignore-scripts=true', 'run', 'test'], expect.objectContaining({ cwd: root }));
  });

  it('fails closed for missing and unknown scripts', async () => {
    const root = await fixture('npm@11.17.0', { test: 'ignored' });
    await expect(runDeclaredProjectScript(root, 'missing')).rejects.toThrow('does not declare validation script');
    const empty = await fixture('npm@11.17.0', {});
    await expect(runDeclaredProjectTest(empty)).rejects.toThrow('does not declare validation script test');
  });

  it('physically binds cwd and preserves timeout reporting', async () => {
    const root = await fixture('npm@11.17.0', { test: 'ignored' });
    const execute = vi.fn(async (_file, _args, options) => {
      expect(options.cwd).toBe(root);
      throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM', stdout: '', stderr: '' });
    });
    const result = await runDeclaredProjectScript(root, 'test', { timeoutMs: 1, execute: execute as never });
    expect(result).toMatchObject({ timedOut: true, passed: false });
  });

  it('preserves legacy undeclared manifests as pnpm without installing dependencies', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'iris-project-test-'));
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'ignored' } }));
    const execute = vi.fn(async () => ({ stdout: 'ok', stderr: '' }));
    const result = await runDeclaredProjectScript(root, 'test', { execute: execute as never });
    expect(result.packageManager).toBe('pnpm');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
