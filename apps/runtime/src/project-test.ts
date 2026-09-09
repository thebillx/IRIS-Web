import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { RuntimeError } from '@iris/domain';
import { node24Path } from './node-runtime.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_PROCESS_BUFFER = 64 * 1024;
const MAX_RETURNED_OUTPUT = 16 * 1024;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;

export interface ProjectTestResult {
  readonly scriptName: string;
  readonly packageManager: 'npm' | 'pnpm';
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

interface ExecutionOptions {
  readonly timeoutMs?: number;
  readonly execute?: typeof execFileAsync;
}

export async function runDeclaredProjectTest(projectRoot: string): Promise<ProjectTestResult> {
  return runDeclaredProjectScript(projectRoot, 'test');
}

export async function runDeclaredProjectScript(
  projectRoot: string,
  scriptName: string,
  options: ExecutionOptions = {},
): Promise<ProjectTestResult> {
  if (!SCRIPT_NAME.test(scriptName)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Validation script name is invalid');
  }
  const manifestPath = `${projectRoot}/package.json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Registered project does not provide a readable package.json for governed validation', { cause: error });
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Registered project does not declare project-owned validation scripts');
  }
  const declared = parsed.scripts[scriptName];
  if (typeof declared !== 'string' || declared.trim().length === 0 || declared.length > 2_000) {
    throw new RuntimeError('CAPABILITY_DENIED', `Registered project does not declare validation script ${scriptName}`);
  }

  const packageManager = declaredPackageManager(parsed.packageManager);
  const args = packageManager === 'npm'
    ? ['run', '--ignore-scripts', scriptName]
    : ['--config.ignore-scripts=true', 'run', scriptName];
  const execute = options.execute ?? execFileAsync;
  try {
    const result = await execute(packageManager, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_PROCESS_BUFFER,
      env: testEnvironment(),
    });
    return boundedResult(scriptName, packageManager, 0, false, result.stdout, result.stderr);
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string | null };
    const timedOut = candidate.killed === true && candidate.signal !== null;
    const exitCode = typeof candidate.code === 'number' ? candidate.code : null;
    return boundedResult(scriptName, packageManager, exitCode, timedOut, candidate.stdout ?? '', candidate.stderr ?? '');
  }
}

function declaredPackageManager(value: unknown): 'npm' | 'pnpm' {
  if (value === undefined) return 'pnpm';
  if (typeof value !== 'string') throw new RuntimeError('CAPABILITY_DENIED', 'Registered project packageManager must be a string');
  const match = /^(npm|pnpm)@[0-9][A-Za-z0-9.+-]*$/.exec(value.trim());
  if (match?.[1] === 'npm' || match?.[1] === 'pnpm') return match[1];
  throw new RuntimeError('CAPABILITY_DENIED', 'Registered project packageManager is not supported for governed validation');
}

function boundedResult(scriptName: string, packageManager: 'npm' | 'pnpm', exitCode: number | null, timedOut: boolean, stdout: string, stderr: string): ProjectTestResult {
  const outputTruncated = stdout.length > MAX_RETURNED_OUTPUT || stderr.length > MAX_RETURNED_OUTPUT;
  return { scriptName, packageManager, passed: exitCode === 0 && !timedOut, exitCode, timedOut,
    stdout: stdout.slice(-MAX_RETURNED_OUTPUT), stderr: stderr.slice(-MAX_RETURNED_OUTPUT), outputTruncated };
}

function testEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: node24Path(),
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
