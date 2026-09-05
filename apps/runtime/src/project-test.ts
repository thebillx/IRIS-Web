import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { RuntimeError } from '@iris/domain';

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT_MS = 120_000;
const MAX_PROCESS_BUFFER = 64 * 1024;
const MAX_RETURNED_OUTPUT = 16 * 1024;

export interface ProjectTestResult {
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export async function runDeclaredProjectTest(projectRoot: string): Promise<ProjectTestResult> {
  const manifestPath = `${projectRoot}/package.json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Registered project does not provide a readable package.json for governed test execution', { cause: error });
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts) || typeof parsed.scripts.test !== 'string'
    || parsed.scripts.test.trim().length === 0 || parsed.scripts.test.length > 2_000) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Registered project does not declare a bounded test script');
  }

  try {
    const result = await execFileAsync('pnpm', ['test'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: MAX_PROCESS_BUFFER,
      env: testEnvironment(),
    });
    return boundedResult(0, false, result.stdout, result.stderr);
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string | null };
    const timedOut = candidate.killed === true && candidate.signal !== null;
    const exitCode = typeof candidate.code === 'number' ? candidate.code : null;
    return boundedResult(exitCode, timedOut, candidate.stdout ?? '', candidate.stderr ?? '');
  }
}

function boundedResult(exitCode: number | null, timedOut: boolean, stdout: string, stderr: string): ProjectTestResult {
  const outputTruncated = stdout.length > MAX_RETURNED_OUTPUT || stderr.length > MAX_RETURNED_OUTPUT;
  return {
    passed: exitCode === 0 && !timedOut,
    exitCode,
    timedOut,
    stdout: stdout.slice(-MAX_RETURNED_OUTPUT),
    stderr: stderr.slice(-MAX_RETURNED_OUTPUT),
    outputTruncated,
  };
}

function testEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/opt/homebrew/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? '',
    USER: process.env.USER ?? '',
    CI: '1',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
