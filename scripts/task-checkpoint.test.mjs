import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { inspectCheckpoint, saveCheckpoint } from './task-checkpoint.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => exec('/usr/bin/git', args, { cwd: root });
  await git('init', '-b', 'task');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'base');
  const input = { expectedRevision: 0, requestId: 'checkpoint-1', objective: 'Continue a task safely', project: 'Fixture', workspace: root,
    currentState: 'Code ready', completed: ['Implemented change'], changedFiles: ['owner.txt'],
    tests: [{ command: 'node --test', exitCode: 0, result: 'PASS' }], remaining: ['Review'], blockers: [], questions: [],
    nextAction: 'Review the changed file', pendingMutation: null };
  await writeFile(path.join(root, 'owner.txt'), 'owner work');
  return { root, input, git, filename: path.join(root, '.agents/handoffs/task.json') };
}

test('inspection is read-only when no checkpoint exists', async (t) => {
  const { root } = await fixture(t);
  assert.equal((await inspectCheckpoint(root, 'task')).action, 'ASK');
  await assert.rejects(stat(path.join(root, '.agents')), { code: 'ENOENT' });
  await mkdir(path.join(root, 'subproject'));
  await assert.rejects(inspectCheckpoint(path.join(root, 'subproject'), 'task'), /do not expand workspace scope/);
});

test('one durable canonical checkpoint survives takeover and lost acknowledgement retries', async (t) => {
  const { root, input, filename } = await fixture(t);
  const first = await saveCheckpoint(root, 'task', input);
  const bytes = await readFile(filename);
  assert.deepEqual(await saveCheckpoint(root, 'task', input), first);
  assert.deepEqual(await readFile(filename), bytes);
  assert.equal((await inspectCheckpoint(root, 'task')).action, 'EXECUTE');
  assert.equal((await stat(filename)).mode & 0o077, 0);
  await assert.rejects(saveCheckpoint(root, 'task', { ...input, objective: 'A different task' }), /conflicts/);
  await assert.rejects(saveCheckpoint(root, 'task', { ...input, requestId: 'new-request' }), /Stale/);
  assert.equal(await readFile(path.join(root, 'owner.txt'), 'utf8'), 'owner work');
});

test('takeover asks about blockers and verifies unknown outcomes without replaying them', async (t) => {
  const { root, input } = await fixture(t);
  await saveCheckpoint(root, 'task', { ...input, blockers: ['Need owner answer'] });
  assert.equal((await inspectCheckpoint(root, 'task')).action, 'ASK');
  await saveCheckpoint(root, 'task', { ...input, expectedRevision: 1, requestId: 'checkpoint-2', pendingMutation: 'Publish request 123: acknowledgement missing' });
  assert.equal((await inspectCheckpoint(root, 'task')).action, 'VERIFY');
});

test('takeover stops on changed owner bytes, branch or commit', async (t) => {
  const { root, input, git } = await fixture(t);
  await saveCheckpoint(root, 'task', input);
  await writeFile(path.join(root, 'owner.txt'), 'different owner work');
  assert.equal((await inspectCheckpoint(root, 'task')).action, 'STOP');
  await writeFile(path.join(root, 'owner.txt'), 'owner work');
  await git('switch', '-c', 'another-task');
  assert.equal((await inspectCheckpoint(root, 'task')).action, 'STOP');
  await git('switch', 'task');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'changed HEAD');
  assert.equal((await inspectCheckpoint(root, 'task')).action, 'STOP');
});

test('concurrent writers cannot overwrite the same revision', async (t) => {
  const { root, input } = await fixture(t);
  const results = await Promise.allSettled([
    saveCheckpoint(root, 'task', input), saveCheckpoint(root, 'task', { ...input, requestId: 'competing-request' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await inspectCheckpoint(root, 'task')).checkpoint.revision, 1);
});

test('takeover fingerprints undeclared untracked owner work and binds the physical repository', async (t) => {
  const { root, input } = await fixture(t);
  await writeFile(path.join(root, 'other.txt'), 'owner work outside the task');
  const checkpoint = await saveCheckpoint(root, 'task', input);
  const common = await stat(path.join(root, '.git'), { bigint: true });
  assert.equal(checkpoint.source.commonDevice, String(common.dev));
  assert.equal(checkpoint.source.commonInode, String(common.ino));
  await writeFile(path.join(root, 'other.txt'), 'changed outside this task');
  assert.equal((await inspectCheckpoint(root, 'task')).action, 'STOP');
});

test('unsafe paths, incomplete requirements and owner-held checkpoint files fail closed', async (t) => {
  const { root, input, filename } = await fixture(t);
  await assert.rejects(saveCheckpoint(root, '../escape', input), /slug/);
  await assert.rejects(saveCheckpoint(root, 'task', { ...input, objective: '' }), /ask the owner/);
  await assert.rejects(saveCheckpoint(root, 'task', { ...input, changedFiles: ['../outside'] }), /project-relative/);
  await saveCheckpoint(root, 'task', input);
  await writeFile(filename, 'owner document');
  await assert.rejects(saveCheckpoint(root, 'task', input));
  assert.equal(await readFile(filename, 'utf8'), 'owner document');
});

test('symlinked checkpoint directories and changed files cannot escape the project', async (t) => {
  const { root, input } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'iris-checkpoint-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, '.agents'));
  await assert.rejects(saveCheckpoint(root, 'task', input), /physical directory/);
  await rm(path.join(root, '.agents'));
  await writeFile(path.join(outside, 'private.txt'), 'untouched');
  await symlink(path.join(outside, 'private.txt'), path.join(root, 'linked.txt'));
  await assert.rejects(saveCheckpoint(root, 'task', { ...input, changedFiles: ['linked.txt'] }), /physical project file/);
  assert.equal(await readFile(path.join(outside, 'private.txt'), 'utf8'), 'untouched');
});
