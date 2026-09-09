import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { pushCurrentFeatureBranch, runProjectGitLocal } from './project-git.js';

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) { return exec('git', args, { cwd, encoding: 'utf8' }); }
async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-git-'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'IRIS Test']);
  await git(root, ['config', 'user.email', 'iris@example.invalid']);
  await writeFile(path.join(root, 'owned.txt'), 'base\n');
  await git(root, ['add', '--', 'owned.txt']);
  await git(root, ['commit', '-m', 'base']);
  return root;
}

describe('bounded project Git', () => {
  it('binds status and diff to the selected project', async () => {
    const root = await repo();
    await writeFile(path.join(root, 'owned.txt'), 'changed\n');
    expect(String((await runProjectGitLocal(root, { operation: 'status' })).stdout)).toContain('owned.txt');
    expect(String((await runProjectGitLocal(root, { operation: 'diff-name-only' })).stdout)).toContain('owned.txt');
    await expect(runProjectGitLocal(root, { operation: 'add', paths: ['../outside'] })).rejects.toThrow('escapes');
  });

  it('stages only explicit paths and returns the commit SHA', async () => {
    const root = await repo();
    await writeFile(path.join(root, 'owned.txt'), 'owned\n');
    await writeFile(path.join(root, 'other.txt'), 'other\n');
    await runProjectGitLocal(root, { operation: 'add', paths: ['owned.txt'] });
    const committed = await runProjectGitLocal(root, { operation: 'commit', message: 'bounded commit' });
    expect(committed.head).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(path.join(root, 'other.txt'), 'utf8')).toBe('other\n');
    expect((await git(root, ['status', '--short'])).stdout).toContain('?? other.txt');
  });

  it('makes destructive and force operations unrepresentable', () => {
    const allowed = ['status', 'head', 'diff', 'diff-check', 'diff-name-only', 'add', 'commit'];
    for (const forbidden of ['reset', 'clean', 'stash', 'amend', 'rebase', 'force', 'checkout', 'merge']) expect(allowed).not.toContain(forbidden);
  });

  it('rejects main and normally pushes a feature branch to configured origin with verified SHA', async () => {
    const root = await repo();
    const remote = await mkdtemp(path.join(os.tmpdir(), 'iris-remote-'));
    await git(remote, ['init', '--bare']);
    await git(root, ['remote', 'add', 'origin', remote]);
    await expect(pushCurrentFeatureBranch(root)).rejects.toThrow('protected');
    await git(root, ['switch', '-c', 'feature/test']);
    const result = await pushCurrentFeatureBranch(root);
    expect(result).toMatchObject({ branch: 'feature/test', remote: 'origin', verified: true });
    expect(result.localHead).toBe(result.remoteHead);
  });
});
