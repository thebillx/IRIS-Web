import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { pushCurrentFeatureBranch, runProjectGitLocal } from './project-git.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function git(cwd: string, args: string[]) { return exec('git', args, { cwd, encoding: 'utf8' }); }
async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-git-'));
  roots.push(root);
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

  it('returns tracked staged/unstaged diff separately from an untracked inventory and supports pathspecs with spaces', async () => {
    const root = await repo();
    await writeFile(path.join(root, 'owned.txt'), 'changed\n');
    await writeFile(path.join(root, 'space name.txt'), 'new tracked\n');
    await git(root, ['add', '--', 'space name.txt']);
    await writeFile(path.join(root, 'untracked file.txt'), 'untracked\n');

    const diff = await runProjectGitLocal(root, { operation: 'diff' });
    expect(diff.trackedOnly).toBe(true);
    expect(String(diff.stdout)).toContain('changed');
    expect(String(diff.stdout)).toContain('space name.txt');
    expect(String(diff.stdout)).not.toContain('untracked file.txt');
    expect(diff.untrackedFiles).toEqual(['untracked file.txt']);

    const status = await runProjectGitLocal(root, { operation: 'status' });
    expect(status.untrackedFiles).toEqual(['untracked file.txt']);
    const selected = await runProjectGitLocal(root, { operation: 'diff-name-only', paths: ['space name.txt'] });
    expect(String(selected.stdout)).toContain('space name.txt');
    await expect(runProjectGitLocal(root, { operation: 'diff', paths: ['../outside'] })).rejects.toThrow(/escapes/i);
  });

  it('distinguishes whitespace findings from Git invocation failures', async () => {
    const root = await repo();
    await writeFile(path.join(root, 'owned.txt'), 'bad trailing whitespace   \n');
    const result = await runProjectGitLocal(root, { operation: 'diff-check' });
    expect(result).toMatchObject({ status: 'whitespace_issues', passed: false, whitespaceIssues: true, trackedOnly: true });
    expect(String(result.stdout)).toContain('trailing whitespace');
  });

  it('returns actionable diagnostics for Git invocation failures and marks bounded output truncation', async () => {
    const notARepository = await mkdtemp(path.join(os.tmpdir(), 'iris-git-invalid-'));
    roots.push(notARepository);
    await expect(runProjectGitLocal(notARepository, { operation: 'diff-check' })).rejects.toThrow(/Bounded Git diff-check failed \(exit=(?:128|129)\).*not a git repository/i);

    const root = await repo();
    await writeFile(path.join(root, 'owned.txt'), 'changed\n'.repeat(8_000));
    const result = await runProjectGitLocal(root, { operation: 'diff' });
    expect(result).toMatchObject({ trackedOnly: true, outputTruncated: true, untrackedFiles: [], untrackedFilesTruncated: false });
    expect(String(result.stdout)).toContain('[IRIS_OUTPUT_TRUNCATED]');
  });

  it('works from a linked Git worktree whose .git is a file', async () => {
    const root = await repo();
    const linked = await mkdtemp(path.join(os.tmpdir(), 'iris-git-linked-'));
    roots.push(linked);
    await rm(linked, { recursive: true, force: true });
    await git(root, ['worktree', 'add', '-b', 'linked/test', linked]);
    const metadata = await readFile(path.join(linked, '.git'), 'utf8');
    expect(metadata).toContain('gitdir:');
    await writeFile(path.join(linked, 'owned.txt'), 'linked change\n');
    const result = await runProjectGitLocal(linked, { operation: 'diff' });
    expect(String(result.stdout)).toContain('linked change');
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
