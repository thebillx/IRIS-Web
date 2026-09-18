import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';

const PYTHON = '/usr/bin/python3';
const HELPER = path.resolve(import.meta.dirname, '..', 'macos-safety-helper.py');
const MAX_HELPER_OUTPUT_BYTES = 4 * 1024 * 1024;

export type ProcessStartObservation =
  | { readonly state: 'live'; readonly marker: string }
  | { readonly state: 'dead' }
  | { readonly state: 'indeterminate' };

export interface SecureProjectFileEditResult {
  readonly changed: boolean;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly matchCount: number;
  readonly dryRun: boolean;
}

export function observeProcessStart(pid: number): ProcessStartObservation {
  const result = spawnSync(PYTHON, ['-I', '-S', HELPER, 'process-start', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 16 * 1024,
    env: { PATH: '/usr/bin:/bin' },
  });
  if (result.status === 0) {
    const marker = result.stdout.trim();
    return /^\d+:\d{6}$/.test(marker) ? { state: 'live', marker } : { state: 'indeterminate' };
  }
  if (result.status === 2 && result.stderr.includes('process does not exist')) return { state: 'dead' };
  return { state: 'indeterminate' };
}

export async function secureProjectFileRead(projectRoot: string, targetPath: string): Promise<string> {
  const parsed = await runJsonHelper(['read-file', projectRoot, targetPath]);
  if (!isRecord(parsed) || typeof parsed.content !== 'string' || Object.keys(parsed).length !== 1) {
    throw new RuntimeError('CAPABILITY_DENIED', 'macOS safety helper returned an invalid project-read result');
  }
  return parsed.content;
}

export async function secureProjectFileWrite(projectRoot: string, targetPath: string, content: string): Promise<number> {
  const parsed = await runJsonHelper(['write-file', projectRoot, targetPath], content);
  if (!isRecord(parsed) || !Number.isSafeInteger(parsed.bytes) || (parsed.bytes as number) < 0 || Object.keys(parsed).length !== 1) {
    throw new RuntimeError('CAPABILITY_DENIED', 'macOS safety helper returned an invalid project-write result');
  }
  return parsed.bytes as number;
}

export async function secureProjectFileEdit(
  projectRoot: string,
  targetPath: string,
  find: string,
  replace: string,
  expectedSha256: string,
  dryRun = false,
): Promise<SecureProjectFileEditResult> {
  const parsed = await runJsonHelper(['edit-file', projectRoot, targetPath], JSON.stringify({ find, replace, expectedSha256, dryRun }));
  if (!isRecord(parsed)
    || typeof parsed.changed !== 'boolean'
    || typeof parsed.beforeSha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(parsed.beforeSha256)
    || typeof parsed.afterSha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(parsed.afterSha256)
    || !Number.isSafeInteger(parsed.bytesBefore)
    || !Number.isSafeInteger(parsed.bytesAfter)
    || !Number.isSafeInteger(parsed.matchCount)
    || parsed.matchCount !== 1
    || typeof parsed.dryRun !== 'boolean'
    || Object.keys(parsed).length !== 7) {
    throw new RuntimeError('CAPABILITY_DENIED', 'macOS safety helper returned an invalid project-edit result');
  }
  return parsed as unknown as SecureProjectFileEditResult;
}

export async function secureProjectMutation(
  operation: 'unlink' | 'mkdir' | 'rmdir',
  projectRoot: string,
  targetPath: string,
): Promise<Readonly<Record<string, boolean>>> {
  const parsed = await runJsonHelper([operation, projectRoot, targetPath]);
  if (!isBooleanRecord(parsed)) throw new RuntimeError('CAPABILITY_DENIED', 'macOS safety helper returned an invalid project-mutation result');
  return parsed;
}

export async function atomicSwapPrivateFiles(root: string, leftName: string, rightName: string): Promise<void> {
  const parsed = await runJsonHelper(['swap-files', root, leftName, rightName], undefined, 'AUTHORITY_INDETERMINATE');
  if (!isRecord(parsed) || parsed.swapped !== true || Object.keys(parsed).length !== 1) {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', 'macOS safety helper returned an invalid authority-swap result');
  }
}

export function macosSafetyHelperReady(): boolean {
  const observed = observeProcessStart(process.pid);
  return observed.state === 'live';
}

async function runJsonHelper(
  args: readonly string[],
  input?: string,
  errorCode: 'CAPABILITY_DENIED' | 'AUTHORITY_INDETERMINATE' = 'CAPABILITY_DENIED',
): Promise<unknown> {
  try {
    const stdout = await runHelper(args, input);
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    const detail = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(-500) : 'unknown helper failure';
    throw new RuntimeError(errorCode, `macOS safety helper refused the protected local operation${detail.length > 0 ? `: ${detail}` : ''}`, { cause: error });
  }
}

function runHelper(args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-I', '-S', HELPER, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(Buffer.concat(stdout).toString('utf8'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('macOS safety helper timed out'));
    }, 5_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('macOS safety helper stdout exceeded the bounded result size'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`macOS safety helper failed (${code ?? 'signal'}): ${Buffer.concat(stderr).toString('utf8').trim()}`));
        return;
      }
      finish();
    });
    child.stdin.on('error', (error) => finish(error));
    child.stdin.end(input ?? '');
  });
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'boolean');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
