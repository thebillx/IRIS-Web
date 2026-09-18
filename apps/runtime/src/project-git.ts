import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError } from '@iris/domain';
import { node24Environment } from './node-runtime.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER = 1024 * 1024;
const MAX_OUTPUT = 16 * 1024;
const PROTECTED_BRANCH = /^(main|master|release(?:[-/].*)?)$/i;
const COMMIT_MESSAGE = /^[^\0\r\n]{1,200}$/;

export type GitLocalOperation = 'status' | 'head' | 'diff' | 'diff-check' | 'diff-name-only' | 'add' | 'commit';

export interface GitLocalInput {
  readonly operation: GitLocalOperation;
  readonly paths?: readonly string[];
  readonly message?: string;
}

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
}

export async function runProjectGitLocal(projectRoot: string, input: GitLocalInput): Promise<Record<string, unknown>> {
  if (input.operation === 'status') {
    const result = await requireGit(projectRoot, ['status', '--short', '--branch', '--untracked-files=all'], 'status');
    const untracked = await requireGit(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z'], 'untracked inventory');
    return {
      ...boundedOutput('status', result),
      untrackedFiles: parseNulList(untracked.stdout),
      untrackedFilesTruncated: untracked.outputLimitExceeded,
      trackedDiffOnly: true,
    };
  }
  if (input.operation === 'head') {
    const result = await requireGit(projectRoot, ['rev-parse', 'HEAD'], 'HEAD');
    return { operation: 'head', head: result.stdout.trim() };
  }
  if (input.operation === 'diff') {
    const result = await requireGit(projectRoot, ['diff', 'HEAD', '--no-ext-diff', ...diffPaths(input.paths, projectRoot)], 'diff');
    return { ...boundedOutput('diff', result), ...await untrackedInventory(projectRoot, input.paths), paths: input.paths ?? [], trackedOnly: true };
  }
  if (input.operation === 'diff-check') {
    const result = await runGit(projectRoot, ['diff', 'HEAD', '--check', ...diffPaths(input.paths, projectRoot)]);
    if (result.exitCode === 2 && !result.timedOut && !result.outputLimitExceeded) {
      return {
        ...boundedOutput('diff-check', result),
        ...await untrackedInventory(projectRoot, input.paths),
        status: 'whitespace_issues',
        passed: false,
        whitespaceIssues: true,
        trackedOnly: true,
      };
    }
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) {
      throw gitFailure('diff-check', result);
    }
    return {
      ...boundedOutput('diff-check', result),
      ...await untrackedInventory(projectRoot, input.paths),
      status: 'passed',
      passed: true,
      whitespaceIssues: false,
      trackedOnly: true,
    };
  }
  if (input.operation === 'diff-name-only') {
    const result = await requireGit(projectRoot, ['diff', 'HEAD', '--name-only', ...diffPaths(input.paths, projectRoot)], 'diff-name-only');
    return { ...boundedOutput('diff-name-only', result), ...await untrackedInventory(projectRoot, input.paths), paths: input.paths ?? [], trackedOnly: true };
  }
  if (input.operation === 'add') {
    const paths = validatePaths(projectRoot, input.paths);
    await requireGit(projectRoot, ['add', '--', ...paths], 'add');
    return { operation: 'add', paths };
  }
  if (input.operation === 'commit') {
    if (typeof input.message !== 'string' || !COMMIT_MESSAGE.test(input.message.trim())) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Commit message must be one bounded single line');
    }
    await requireGit(projectRoot, ['commit', '-m', input.message.trim()], 'commit');
    return { operation: 'commit', head: (await requireGit(projectRoot, ['rev-parse', 'HEAD'], 'HEAD')).stdout.trim() };
  }
  throw new RuntimeError('CAPABILITY_DENIED', 'Unsupported local Git operation');
}

export async function pushCurrentFeatureBranch(projectRoot: string): Promise<Record<string, unknown>> {
  const branch = (await requireGit(projectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'branch')).stdout.trim();
  if (branch.length === 0 || PROTECTED_BRANCH.test(branch)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Remote publish rejects protected or detached branches');
  }
  const defaultRef = await optionalGit(projectRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (defaultRef.stdout.trim() === `origin/${branch}`) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Remote publish rejects the configured default branch');
  }
  const remoteUrl = (await requireGit(projectRoot, ['remote', 'get-url', 'origin'], 'configured origin')).stdout.trim();
  if (remoteUrl.length === 0) throw new RuntimeError('CAPABILITY_DENIED', 'Configured origin is unavailable');
  const localHead = (await requireGit(projectRoot, ['rev-parse', 'HEAD'], 'HEAD')).stdout.trim();
  await requireGit(projectRoot, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], 'feature branch push', PUSH_TIMEOUT_MS);
  const remote = await requireGit(projectRoot, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], 'remote HEAD verification');
  const remoteHead = remote.stdout.trim().split(/\s+/)[0] ?? '';
  if (remoteHead !== localHead) throw new RuntimeError('CAPABILITY_DENIED', `Remote branch HEAD verification failed: local=${localHead} remote=${remoteHead || 'missing'}`);
  return { operation: 'push-current-feature-branch', branch, remote: 'origin', localHead, remoteHead, verified: true };
}

function diffPaths(supplied: readonly string[] | undefined, projectRoot: string): string[] {
  return supplied === undefined ? [] : ['--', ...validatePaths(projectRoot, supplied)];
}

function validatePaths(projectRoot: string, supplied: readonly string[] | undefined): string[] {
  if (!Array.isArray(supplied) || supplied.length === 0 || supplied.length > 100) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Git path selection requires an explicit bounded path list');
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

async function requireGit(projectRoot: string, args: readonly string[], operation: string, timeout = TIMEOUT_MS): Promise<GitCommandResult> {
  const result = await runGit(projectRoot, args, timeout);
  if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) throw gitFailure(operation, result);
  return result;
}

async function optionalGit(projectRoot: string, args: readonly string[]): Promise<GitCommandResult> {
  const result = await runGit(projectRoot, args);
  return result.exitCode === 0 ? result : { stdout: '', stderr: '', exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded };
}

async function runGit(projectRoot: string, args: readonly string[], timeout = TIMEOUT_MS): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout,
      maxBuffer: MAX_BUFFER,
      env: { ...node24Environment(), GIT_TERMINAL_PROMPT: '0' },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string | null; code?: number | string };
    return {
      stdout: candidate.stdout ?? '',
      stderr: candidate.stderr ?? '',
      exitCode: typeof candidate.code === 'number' ? candidate.code : null,
      signal: candidate.signal ?? null,
      timedOut: candidate.killed === true || candidate.code === 'ETIMEDOUT',
      outputLimitExceeded: candidate.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    };
  }
}

function gitFailure(operation: string, result: GitCommandResult): RuntimeError {
  const reason = result.outputLimitExceeded
    ? 'output limit exceeded'
    : result.timedOut
      ? 'timed out'
      : `exit=${result.exitCode ?? 'signal'}${result.signal === null ? '' : ` signal=${result.signal}`}`;
  const diagnostics = redact(`${result.stderr}\n${result.stdout}`).trim().slice(-MAX_OUTPUT);
  return new RuntimeError('CAPABILITY_DENIED', `Bounded Git ${operation} failed (${reason})${diagnostics.length > 0 ? `: ${diagnostics}` : ''}`);
}

function boundedOutput(operation: string, result: GitCommandResult): Record<string, unknown> {
  const stdout = bounded(result.stdout);
  const stderr = bounded(result.stderr);
  return {
    operation,
    stdout: stdout.value,
    stderr: stderr.value,
    outputTruncated: stdout.truncated || stderr.truncated,
    stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
    omittedOutputBytes: stdout.omittedBytes + stderr.omittedBytes,
  };
}

function bounded(value: string): { readonly value: string; readonly truncated: boolean; readonly omittedBytes: number } {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= MAX_OUTPUT) return { value, truncated: false, omittedBytes: 0 };
  const valueBytes = Buffer.from(value, 'utf8').subarray(0, MAX_OUTPUT).toString('utf8');
  return { value: `${valueBytes}\n[IRIS_OUTPUT_TRUNCATED]`, truncated: true, omittedBytes: bytes - Buffer.byteLength(valueBytes, 'utf8') };
}

function parseNulList(value: string): string[] {
  return value.split('\0').filter((item) => item.length > 0);
}

async function untrackedInventory(projectRoot: string, paths: readonly string[] | undefined): Promise<Record<string, unknown>> {
  const selection = paths === undefined ? [] : ['--', ...validatePaths(projectRoot, paths)];
  const result = await requireGit(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z', ...selection], 'untracked inventory');
  return { untrackedFiles: parseNulList(result.stdout), untrackedFilesTruncated: result.outputLimitExceeded };
}

function redact(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+):([^\s/@]+)@/gi, '$1[credentials-redacted]@');
}
