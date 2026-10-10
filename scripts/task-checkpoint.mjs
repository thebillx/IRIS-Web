import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const exec = promisify(execFile);
const fields = ['expectedRevision', 'requestId', 'objective', 'project', 'workspace', 'currentState', 'completed', 'changedFiles', 'tests', 'remaining', 'blockers', 'questions', 'nextAction', 'pendingMutation'];

function checkpointPathspecs() {
  return [
    ':(exclude,glob).agents/handoffs/*.json',
    ':(exclude,glob).agents/handoffs/.*.lock',
    ':(exclude,glob).agents/handoffs/.*.tmp',
  ];
}

function text(value, name, limit = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error(`Missing or invalid ${name}; ask the owner`);
  return value.trim();
}

function strings(value, name) {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`Invalid ${name}`);
  return value.map((item) => text(item, name));
}

function payload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new Error('Unsupported checkpoint fields');
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) throw new Error('expectedRevision must be a nonnegative integer');
  if (!Array.isArray(value.tests) || value.tests.length > 64) throw new Error('Invalid tests');
  const tests = value.tests.map((test) => {
    if (!test || !Number.isInteger(test.exitCode) || Object.keys(test).some((key) => !['command', 'exitCode', 'result'].includes(key))) throw new Error('Tests require command, result and integer exitCode');
    return { command: text(test.command, 'test command'), result: text(test.result, 'test result'), exitCode: test.exitCode };
  });
  return { expectedRevision: value.expectedRevision, requestId: text(value.requestId, 'requestId', 120),
    objective: text(value.objective, 'objective'), project: text(value.project, 'project', 240), workspace: text(value.workspace, 'workspace', 2048),
    currentState: text(value.currentState, 'currentState'), completed: strings(value.completed, 'completed'),
    changedFiles: strings(value.changedFiles, 'changedFiles'), tests, remaining: strings(value.remaining, 'remaining'),
    blockers: strings(value.blockers, 'blockers'), questions: strings(value.questions, 'questions'),
    nextAction: text(value.nextAction, 'nextAction'), pendingMutation: value.pendingMutation === null ? null : text(value.pendingMutation, 'pendingMutation') };
}

async function git(root, args) {
  return (await exec('/usr/bin/git', ['--no-optional-locks', ...args], { cwd: root, maxBuffer: 4 * 1024 * 1024 })).stdout;
}

async function location(cwd, task) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(task)) throw new Error('Task must be a bounded lowercase slug');
  const root = await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  if (root !== await realpath(cwd)) throw new Error('Run checkpoint commands from the verified Git root; do not expand workspace scope');
  const directory = path.join(root, '.agents', 'handoffs');
  for (const name of [path.join(root, '.agents'), directory]) {
    const stat = await lstat(name).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022))) throw new Error('Checkpoint directory is not an owner-controlled physical directory');
  }
  return { root, directory, filename: path.join(directory, `${task}.json`), task };
}

async function recordAt(filename) {
  const stat = await lstat(filename).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (stat === null) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 128 * 1024) throw new Error('Checkpoint file ownership or shape is unsafe');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (actual.ino !== stat.ino || actual.dev !== stat.dev) throw new Error('Checkpoint file changed while opening');
    const record = JSON.parse(await handle.readFile('utf8'));
    if (record.format !== 1 || !record.source || typeof record.source.root !== 'string' || typeof record.source.branch !== 'string'
      || !/^[a-f0-9]{40}$/.test(record.source.head) || !/^[a-f0-9]{64}$/.test(record.source.fingerprint)) throw new Error('Unsupported checkpoint format; preserve existing owner file');
    const data = payload(record.payload);
    if (record.revision !== data.expectedRevision + 1) throw new Error('Invalid checkpoint revision');
    return { format: 1, revision: record.revision, source: record.source, payload: data };
  } finally { await handle.close(); }
}

async function sourceAt(where, changedFiles) {
  const commonGitDir = await realpath(path.resolve(where.root, (await git(where.root, ['rev-parse', '--git-common-dir'])).trim()));
  const common = await lstat(commonGitDir, { bigint: true });
  const root = await lstat(where.root, { bigint: true });
  if (!common.isDirectory()) throw new Error('Git common directory identity is unavailable');
  const excluded = checkpointPathspecs();
  const head = (await git(where.root, ['rev-parse', 'HEAD'])).trim();
  const branch = (await git(where.root, ['branch', '--show-current'])).trim();
  const hash = createHash('sha256');
  hash.update(await git(where.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ...excluded]));
  hash.update(await git(where.root, ['diff', '--binary', 'HEAD', '--', '.', ...excluded]));
  const untracked = (await git(where.root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...excluded])).split('\0').filter(Boolean);
  for (const name of untracked) {
    const absolute = path.resolve(where.root, name);
    const stat = await lstat(absolute);
    hash.update(name + '\0');
    if (stat.isSymbolicLink()) { hash.update('LINK:' + await readlink(absolute)); continue; }
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || await realpath(absolute) !== absolute) throw new Error('Untracked owner work cannot be safely fingerprinted');
    hash.update(await readFile(absolute));
  }
  for (const name of changedFiles) {
    const absolute = path.resolve(where.root, name);
    if (path.isAbsolute(name) || absolute === where.root || !absolute.startsWith(where.root + path.sep) || absolute === where.filename) throw new Error('Changed file must be project-relative and cannot be the checkpoint itself');
    hash.update(name + '\0');
    const stat = await lstat(absolute).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat === null) { hash.update('DELETED'); continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(absolute) !== absolute || stat.size > 8 * 1024 * 1024) throw new Error('Changed file is not a bounded physical project file');
    hash.update(await readFile(absolute));
  }
  return { root: where.root, rootDevice: String(root.dev), rootInode: String(root.ino),
    commonGitDir, commonDevice: String(common.dev), commonInode: String(common.ino), head, branch, fingerprint: hash.digest('hex') };
}

export async function saveCheckpoint(cwd, task, input) {
  const data = payload(input);
  const where = await location(cwd, task);
  if (!path.isAbsolute(data.workspace) || await realpath(data.workspace) !== where.root) throw new Error('Workspace conflicts with the actual Git root; ask the owner');
  await mkdir(where.directory, { recursive: true, mode: 0o700 });
  const lock = path.join(where.directory, `.${task}.lock`);
  await mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error('Checkpoint writer busy or interrupted; inspect before retry, never delete an unknown lock'); });
  let staging;
  try {
    const previous = await recordAt(where.filename);
    if (previous?.payload.requestId === data.requestId) {
      if (JSON.stringify(previous.payload) !== JSON.stringify(data)) throw new Error('Request identity conflicts with saved content');
      return previous;
    }
    if ((previous?.revision ?? 0) !== data.expectedRevision) throw new Error('Stale checkpoint revision; inspect before retry');
    const source = await sourceAt(where, data.changedFiles);
    if (!source.branch) throw new Error('Detached source identity; ask the owner before continuing');
    const record = { format: 1, revision: data.expectedRevision + 1, source, payload: data };
    const serialized = JSON.stringify(record, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 128 * 1024) throw new Error('Checkpoint exceeds size limit');
    staging = path.join(where.directory, `.${task}.${randomUUID()}.tmp`);
    const file = await open(staging, 'wx', 0o600);
    try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
    await rename(staging, where.filename);
    const parent = await open(where.directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return record;
  } finally {
    if (staging) await unlink(staging).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(lock);
  }
}

export async function inspectCheckpoint(cwd, task) {
  const where = await location(cwd, task);
  const checkpoint = await recordAt(where.filename);
  if (checkpoint === null) return { action: 'ASK', reason: 'No canonical checkpoint; ask for the objective and next action', checkpoint };
  const source = await sourceAt(where, checkpoint.payload.changedFiles);
  const authorityChanged = source.root !== checkpoint.source.root
    || source.rootDevice !== checkpoint.source.rootDevice
    || source.rootInode !== checkpoint.source.rootInode
    || source.commonGitDir !== checkpoint.source.commonGitDir
    || source.commonDevice !== checkpoint.source.commonDevice
    || source.commonInode !== checkpoint.source.commonInode
    || source.branch !== checkpoint.source.branch
    || source.head !== checkpoint.source.head;
  if (authorityChanged) return { action: 'STOP', reason: 'Source identity, branch or owner authority conflicts with the checkpoint', checkpoint };
  if (checkpoint.payload.pendingMutation !== null) return { action: 'VERIFY', reason: 'Mutation outcome is unknown; inspect the result before retry', checkpoint };
  if (JSON.stringify(source) !== JSON.stringify(checkpoint.source)) return { action: 'STOP', reason: 'Source identity or owner work conflicts with the checkpoint', checkpoint };
  if (checkpoint.payload.questions.length || checkpoint.payload.blockers.length) return { action: 'ASK', reason: 'Resolve recorded blockers/questions before dependent work', checkpoint };
  return { action: 'EXECUTE', reason: 'Verified source agrees with the canonical next action; existing authorization still applies', checkpoint };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [operation, task, ...extra] = process.argv.slice(2);
    if (extra.length || !['save', 'inspect'].includes(operation)) throw new Error('Usage: task-checkpoint.mjs <save|inspect> <task-slug>');
    let input = '';
    if (operation === 'save') for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 128 * 1024) throw new Error('Checkpoint input exceeds size limit');
    }
    const result = operation === 'save' ? await saveCheckpoint(process.cwd(), task, JSON.parse(input)) : await inspectCheckpoint(process.cwd(), task);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
