import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError } from '@iris/domain';
import { node24Path } from './node-runtime.js';
import { inspectPrivateRegularFile } from './private-fs.js';

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

export interface ProjectValidationDeclaration {
  readonly scriptName: string;
  readonly packageManager: 'npm' | 'pnpm';
  readonly source: 'root-package.json';
  readonly packageJsonPath: string;
  readonly cwd: string;
}

export type ValidationJobStatus = 'RUNNING' | 'PASSED' | 'FAILED' | 'INTERRUPTED';

export interface ProjectValidationJobSnapshot {
  readonly jobId: string;
  readonly requestId: string;
  readonly projectRoot: string;
  readonly scriptName: string;
  readonly packageManager: 'npm' | 'pnpm';
  readonly source: 'root-package.json';
  readonly status: ValidationJobStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly result: ProjectTestResult | null;
  readonly log: { readonly stdout: string; readonly stderr: string };
}

interface PersistedValidationDocument {
  readonly schemaVersion: 1;
  readonly jobs: readonly ProjectValidationJobSnapshot[];
}

const VALIDATION_JOB_FILE = 'validation-jobs.json';
const MAX_PERSISTED_JOBS = 100;

interface ExecutionOptions {
  readonly timeoutMs?: number;
  readonly execute?: typeof execFileAsync;
}

export async function discoverDeclaredProjectValidation(projectRoot: string): Promise<readonly ProjectValidationDeclaration[]> {
  const manifest = await readProjectManifest(projectRoot);
  const packageJsonPath = path.join(projectRoot, 'package.json');
  return Object.keys(manifest.scripts)
    .filter((scriptName) => SCRIPT_NAME.test(scriptName) && typeof manifest.scripts[scriptName] === 'string' && manifest.scripts[scriptName]!.trim().length > 0)
    .sort()
    .map((scriptName) => ({ scriptName, packageManager: declaredPackageManager(manifest.packageManager), source: 'root-package.json' as const, packageJsonPath, cwd: projectRoot }));
}

export class ProjectValidationJobManager {
  private readonly active = new Map<string, Promise<void>>();
  private startTail: Promise<void> = Promise.resolve();
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(private readonly dataRoot?: string) {}

  public start(projectRoot: string, scriptName: string, requestId: string): Promise<ProjectValidationJobSnapshot> {
    const operation = this.startTail.then(() => this.startSerialized(projectRoot, scriptName, requestId));
    this.startTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async startSerialized(projectRoot: string, scriptName: string, requestId: string): Promise<ProjectValidationJobSnapshot> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(requestId)) throw new RuntimeError('INVALID_REQUEST', 'Validation requestId is invalid');
    const declaration = (await discoverDeclaredProjectValidation(projectRoot)).find((entry) => entry.scriptName === scriptName);
    if (declaration === undefined) throw new RuntimeError('CAPABILITY_DENIED', `Registered project does not declare validation script ${scriptName}`);
    const document = await this.readDocument();
    const existing = document.jobs.find((job) => job.requestId === requestId && job.projectRoot === projectRoot && job.scriptName === scriptName);
    if (existing !== undefined) return this.recoverStatus(existing);
    const job: ProjectValidationJobSnapshot = {
      jobId: randomUUID(), requestId, projectRoot, scriptName, packageManager: declaration.packageManager, source: declaration.source,
      status: 'RUNNING', startedAt: new Date().toISOString(), finishedAt: null, result: null, log: { stdout: '', stderr: '' },
    };
    await this.writeDocument({ schemaVersion: 1, jobs: [...document.jobs, job].slice(-MAX_PERSISTED_JOBS) });
    const task = this.execute(job);
    this.active.set(job.jobId, task);
    void task.then(() => this.active.delete(job.jobId), () => this.active.delete(job.jobId));
    return job;
  }

  public async read(jobId: string, view: 'status' | 'logs' | 'result', expectedProjectRoot?: string): Promise<Record<string, unknown>> {
    const job = (await this.readDocument()).jobs.find((candidate) => candidate.jobId === jobId);
    if (job === undefined) throw new RuntimeError('INVALID_REQUEST', 'Validation job was not found');
    if (expectedProjectRoot !== undefined && job.projectRoot !== expectedProjectRoot) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Validation job does not belong to the selected registered project');
    }
    const recovered = await this.recoverStatus(job);
    if (view === 'logs') return { jobId: recovered.jobId, status: recovered.status, stdout: recovered.log.stdout, stderr: recovered.log.stderr };
    if (view === 'result') return { jobId: recovered.jobId, status: recovered.status, result: recovered.result };
    return { ...recovered };
  }

  private async execute(job: ProjectValidationJobSnapshot): Promise<void> {
    let result: ProjectTestResult;
    try {
      result = await runDeclaredProjectScript(job.projectRoot, job.scriptName);
    } catch (error) {
      result = {
        scriptName: job.scriptName, packageManager: job.packageManager, passed: false, exitCode: null, timedOut: false,
        stdout: '', stderr: error instanceof Error ? error.message : 'Validation failed', outputTruncated: false,
      };
    }
    const finished: ProjectValidationJobSnapshot = {
      ...job, status: result.passed ? 'PASSED' : 'FAILED', finishedAt: new Date().toISOString(), result,
      log: { stdout: result.stdout, stderr: result.stderr },
    };
    const document = await this.readDocument();
    await this.writeDocument({ schemaVersion: 1, jobs: document.jobs.map((candidate) => candidate.jobId === job.jobId ? finished : candidate) });
  }

  private async recoverStatus(job: ProjectValidationJobSnapshot): Promise<ProjectValidationJobSnapshot> {
    if (job.status !== 'RUNNING' || this.active.has(job.jobId)) return job;

    // A read can have captured RUNNING just before the in-process task publishes
    // its terminal result and removes itself from active. Re-read after observing
    // that gap so a stale snapshot is never reported as an interruption.
    const latest = (await this.readDocument()).jobs.find((candidate) => candidate.jobId === job.jobId);
    if (latest !== undefined && latest.status !== 'RUNNING') return latest;
    return { ...job, status: 'INTERRUPTED', finishedAt: job.finishedAt ?? new Date().toISOString(), log: { ...job.log, stderr: `${job.log.stderr}${job.log.stderr.length > 0 ? '\n' : ''}Validation process was interrupted by an IRIS runtime restart.` } };
  }

  private async readDocument(): Promise<PersistedValidationDocument> {
    if (this.dataRoot === undefined) return { schemaVersion: 1, jobs: [] };
    const inspected = await inspectPrivateRegularFile(path.join(this.dataRoot, VALIDATION_JOB_FILE), 'Validation job store');
    if (inspected.state === 'missing') return { schemaVersion: 1, jobs: [] };
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      const parsed = JSON.parse(inspected.content) as unknown;
      if (!isPersistedValidationDocument(parsed)) throw new Error('schema validation failed');
      return parsed;
    } catch (error) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Validation job store is invalid', { cause: error });
    }
  }

  private writeDocument(document: PersistedValidationDocument): Promise<void> {
    if (this.dataRoot === undefined) return Promise.resolve();
    const operation = this.writeTail.then(async () => {
      const filename = path.join(this.dataRoot!, VALIDATION_JOB_FILE);
      const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, filename);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Validation job state publication failed', { cause: error });
      }
    });
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
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
  const parsed = await readProjectManifest(projectRoot);
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

interface ProjectManifest {
  readonly packageManager?: unknown;
  readonly scripts: Record<string, unknown>;
}

async function readProjectManifest(projectRoot: string): Promise<ProjectManifest> {
  const manifestPath = path.join(projectRoot, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Registered project does not provide a readable package.json for governed validation', { cause: error });
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Registered project does not declare project-owned validation scripts');
  }
  return { packageManager: parsed.packageManager, scripts: parsed.scripts };
}

function isPersistedValidationDocument(value: unknown): value is PersistedValidationDocument {
  return isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.jobs) && value.jobs.length <= MAX_PERSISTED_JOBS
    && value.jobs.every((job) => isRecord(job) && typeof job.jobId === 'string' && typeof job.requestId === 'string'
      && typeof job.projectRoot === 'string' && typeof job.scriptName === 'string'
      && (job.packageManager === 'npm' || job.packageManager === 'pnpm')
      && job.source === 'root-package.json'
      && (job.status === 'RUNNING' || job.status === 'PASSED' || job.status === 'FAILED' || job.status === 'INTERRUPTED')
      && typeof job.startedAt === 'string' && (job.finishedAt === null || typeof job.finishedAt === 'string')
      && (job.result === null || isRecord(job.result)) && isRecord(job.log)
      && typeof job.log.stdout === 'string' && typeof job.log.stderr === 'string');
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
