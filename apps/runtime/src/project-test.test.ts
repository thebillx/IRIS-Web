import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { discoverDeclaredProjectValidation, ProjectValidationJobManager, runDeclaredProjectScript, runDeclaredProjectTest } from './project-test.js';

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

  it('discovers root declarations and runs an idempotent persistent validation job', async () => {
    const root = await fixture('npm@11.17.0', {
      'unit:contract': "node -e \"process.stdout.write('validation-ok')\"",
      lint: "node -e \"process.stdout.write('lint-ok')\"",
    });
    const declarations = await discoverDeclaredProjectValidation(root);
    expect(declarations).toEqual([
      expect.objectContaining({ scriptName: 'lint', packageManager: 'npm', source: 'root-package.json', cwd: root }),
      expect.objectContaining({ scriptName: 'unit:contract', packageManager: 'npm', source: 'root-package.json', cwd: root }),
    ]);
    expect(JSON.stringify(declarations)).not.toContain('validation-ok');

    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-validation-data-'));
    const manager = new ProjectValidationJobManager(dataRoot);
    const first = await manager.start(root, 'unit:contract', 'validation-request-1');
    const retry = await manager.start(root, 'unit:contract', 'validation-request-1');
    expect(retry.jobId).toBe(first.jobId);
    const terminal = await waitForTerminal(manager, first.jobId);
    expect(terminal).toMatchObject({ jobId: first.jobId, status: 'PASSED', result: { passed: true, exitCode: 0 } });
    expect((await manager.read(first.jobId, 'logs')).stdout).toContain('validation-ok');
    const afterRestart = new ProjectValidationJobManager(dataRoot);
    expect(await afterRestart.read(first.jobId, 'result')).toMatchObject({ status: 'PASSED', result: { passed: true } });
  });

  it('persists a failing declared validation result with its exit code', async () => {
    const root = await fixture('npm@11.17.0', {
      'unit:fail': "node -e \"process.stdout.write('validation-failed'); process.exit(3)\"",
    });
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-validation-failure-data-'));
    const manager = new ProjectValidationJobManager(dataRoot);
    const job = await manager.start(root, 'unit:fail', 'validation-failure-request');
    const terminal = await waitForTerminal(manager, job.jobId);
    expect(terminal).toMatchObject({ status: 'FAILED', result: { passed: false, exitCode: 3 } });
    expect((await manager.read(job.jobId, 'logs')).stdout).toContain('validation-failed');
  });

  it('does not expose a validation job through another registered project', async () => {
    const root = await fixture('npm@11.17.0', { test: "node -e \"process.stdout.write('private-validation')\"" });
    const otherRoot = await fixture('npm@11.17.0', { test: "node -e \"process.stdout.write('other')\"" });
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-validation-ownership-data-'));
    const manager = new ProjectValidationJobManager(dataRoot);
    const job = await manager.start(root, 'test', 'validation-ownership-request');
    await expect(manager.read(job.jobId, 'status', otherRoot)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(manager.read(job.jobId, 'result', root)).resolves.toMatchObject({ jobId: job.jobId });
  });
});

async function waitForTerminal(manager: ProjectValidationJobManager, jobId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await manager.read(jobId, 'status') as { readonly status: string };
    if (snapshot.status !== 'RUNNING') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('validation job did not finish within the test bound');
}
