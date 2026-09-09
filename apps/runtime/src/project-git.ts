import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError } from '@iris/domain';
import { node24Path } from './node-runtime.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER = 64 * 1024;
const MAX_OUTPUT = 16 * 1024;
const PROTECTED_BRANCH = /^(main|master|release(?:[-/].*)?)$/i;
const COMMIT_MESSAGE = /^[^\0\r\n]{1,200}$/;

export type GitLocalOperation = 'status' | 'head' | 'diff' | 'diff-check' | 'diff-name-only' | 'add' | 'commit';

export interface GitLocalInput {
  readonly operation: GitLocalOperation;
  readonly paths?: readonly string[];
  readonly message?: string;
}

export async function runProjectGitLocal(projectRoot: string, input: GitLocalInput): Promise<Record<string, unknown>> {
  if (input.operation === 'status') return output('status', await git(projectRoot, ['status', '--short', '--branch']));
  if (input.operation === 'head') return { operation: 'head', head: (await git(projectRoot, ['rev-parse', 'HEAD'])).stdout.trim() };
  if (input.operation === 'diff') return output('diff', await git(projectRoot, ['diff', '--no-ext-diff']));
  if (input.operation === 'diff-check') return output('diff-check', await git(projectRoot, ['diff', '--check']));
  if (input.operation === 'diff-name-only') return output('diff-name-only', await git(projectRoot, ['diff', '--name-only']));
  if (input.operation === 'add') {
    const paths = validatePaths(projectRoot, input.paths);
    await git(projectRoot, ['add', '--', ...paths]);
    return { operation: 'add', paths };
  }
  if (input.operation === 'commit') {
    if (typeof input.message !== 'string' || !COMMIT_MESSAGE.test(input.message.trim())) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Commit message must be one bounded single line');
    }
    await git(projectRoot, ['commit', '-m', input.message.trim()]);
    return { operation: 'commit', head: (await git(projectRoot, ['rev-parse', 'HEAD'])).stdout.trim() };
  }
  throw new RuntimeError('CAPABILITY_DENIED', 'Unsupported local Git operation');
}

export async function pushCurrentFeatureBranch(projectRoot: string): Promise<Record<string, unknown>> {
  const branch = (await git(projectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (branch.length === 0 || PROTECTED_BRANCH.test(branch)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Remote publish rejects protected or detached branches');
  }
  const defaultRef = await gitOptional(projectRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (defaultRef.stdout.trim() === `origin/${branch}`) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Remote publish rejects the configured default branch');
  }
  const remoteUrl = (await git(projectRoot, ['remote', 'get-url', 'origin'])).stdout.trim();
  if (remoteUrl.length === 0) throw new RuntimeError('CAPABILITY_DENIED', 'Configured origin is unavailable');
  const localHead = (await git(projectRoot, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(projectRoot, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], PUSH_TIMEOUT_MS);
  const remote = await git(projectRoot, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  const remoteHead = remote.stdout.trim().split(/\s+/)[0] ?? '';
  if (remoteHead !== localHead) throw new RuntimeError('CAPABILITY_DENIED', 'Remote branch HEAD did not verify against local HEAD');
  return { operation: 'push-current-feature-branch', branch, remote: 'origin', localHead, remoteHead, verified: true };
}

function validatePaths(projectRoot: string, supplied: readonly string[] | undefined): string[] {
  if (!Array.isArray(supplied) || supplied.length === 0 || supplied.length > 100) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Git add requires an explicit bounded path list');
  }
  return supplied.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.includes('\0')) throw new RuntimeError('CAPABILITY_DENIED', 'Git path is invalid');
    const absolute = path.resolve(projectRoot, item);
    const relative = path.relative(projectRoot, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Git path escapes or broadly targets the registered project root');
    }
    return relative;
  });
}

async function git(projectRoot: string, args: readonly string[], timeout = TIMEOUT_MS) {
  try {
    return await execFileAsync('git', [...args], { cwd: projectRoot, encoding: 'utf8', timeout, maxBuffer: MAX_BUFFER,
      env: { PATH: node24Path(), HOME: process.env.HOME ?? '', LANG: process.env.LANG ?? 'en_US.UTF-8', GIT_TERMINAL_PROMPT: '0' } });
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    throw new RuntimeError('CAPABILITY_DENIED', `Bounded Git operation failed: ${String(candidate.stderr ?? candidate.message).slice(-MAX_OUTPUT)}`, { cause: error });
  }
}

async function gitOptional(projectRoot: string, args: readonly string[]) {
  try { return await git(projectRoot, args); } catch { return { stdout: '', stderr: '' }; }
}

function output(operation: string, result: { stdout: string; stderr: string }) {
  return { operation, stdout: result.stdout.slice(-MAX_OUTPUT), stderr: result.stderr.slice(-MAX_OUTPUT),
    outputTruncated: result.stdout.length > MAX_OUTPUT || result.stderr.length > MAX_OUTPUT };
}
