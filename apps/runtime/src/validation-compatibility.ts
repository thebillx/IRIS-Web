import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  RuntimeError,
  type CapabilityEffect,
  type MissionExecutionAssociation,
  type ProjectReference,
} from '@iris/domain';
import { DurableJobManager, type ShellExecutionInput } from './durable-job-manager.js';
import { inspectPrivateRegularFile } from './private-fs.js';
import {
  discoverDeclaredProjectValidation,
  type ProjectTestResult,
  type ProjectValidationDeclaration,
  type ProjectValidationJobManager,
} from './project-test.js';
import { VNextResourceRegistry } from './resource-registry.js';

const COMPAT_FILE = 'validation-compatibility-v2.json';
const MAX_RECORDS = 100;
const VALIDATION_TIMEOUT_MS = 15 * 60_000;

interface ValidationCompatibilityRecord {
  readonly jobId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly scriptName: string;
  readonly packageManager: 'npm' | 'pnpm';
  readonly source: 'root-package.json';
  readonly startedAt: string;
}

interface ValidationCompatibilityDocument {
  readonly schemaVersion: 1;
  readonly jobs: readonly ValidationCompatibilityRecord[];
}

export interface DeclaredScriptCompatibilityPlan {
  readonly declaration: ProjectValidationDeclaration;
  readonly input: ShellExecutionInput;
}

export class ValidationCompatibilityAdapter {
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly jobs: DurableJobManager,
    private readonly resources: VNextResourceRegistry,
    private readonly legacyJobs: ProjectValidationJobManager,
  ) {}

  public async plan(project: ProjectReference, scriptName: string): Promise<DeclaredScriptCompatibilityPlan> {
    const declaration = (await discoverDeclaredProjectValidation(project.rootPath)).find((entry) => entry.scriptName === scriptName);
    if (declaration === undefined) {
      throw new RuntimeError('CAPABILITY_DENIED', `Registered project does not declare validation script ${scriptName}`);
    }
    const workspace = await this.resources.primaryWorkspace(project.id);
    if (workspace.physicalRoot !== project.rootPath) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Declared-script compatibility requires the canonical PRIMARY workspace');
    }
    return {
      declaration,
      input: {
        projectId: project.id,
        workspaceId: workspace.workspaceId,
        executable: declaration.packageManager,
        argv: declaration.packageManager === 'npm'
          ? ['run', '--ignore-scripts', declaration.scriptName]
          : ['--config.ignore-scripts=true', '--config.enable-pre-post-scripts=false', 'run', declaration.scriptName],
        cwd: '.',
        executionProfile: declaration.packageManager === 'npm' ? 'npm-script' : 'pnpm-script',
        envOverrides: {},
        timeoutMs: VALIDATION_TIMEOUT_MS,
      },
    };
  }

  public async run(
    project: ProjectReference,
    scriptName: string,
    effects: readonly CapabilityEffect[],
    mission?: MissionExecutionAssociation,
  ): Promise<ProjectTestResult> {
    const plan = await this.plan(project, scriptName);
    const prepared = await this.jobs.prepare(plan.input);
    const result = await this.jobs.run(prepared, effects, mission);
    return projectTestResult(plan.declaration, result);
  }

  public async start(
    project: ProjectReference,
    scriptName: string,
    requestId: string,
    effects: readonly CapabilityEffect[],
    mission?: MissionExecutionAssociation,
  ): Promise<Record<string, unknown>> {
    const plan = await this.plan(project, scriptName);
    const existing = (await this.readDocument()).jobs.find((record) => record.projectId === project.id && record.requestId === requestId);
    if (existing !== undefined && existing.scriptName !== scriptName) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Validation requestId already belongs to a different declared script');
    }
    const prepared = await this.jobs.prepare(plan.input);
    const started = await this.jobs.start(prepared, requestId, effects, mission);
    const jobId = requiredString(started, 'jobId');
    const startedAt = requiredString(started, 'startedAt');
    const record: ValidationCompatibilityRecord = {
      jobId,
      requestId,
      projectId: project.id,
      projectRoot: project.rootPath,
      scriptName: plan.declaration.scriptName,
      packageManager: plan.declaration.packageManager,
      source: 'root-package.json',
      startedAt,
    };
    await this.upsert(record);
    requiredString(started, 'state');
    if (existing !== undefined) {
      return this.read(project, jobId, 'status');
    }
    return {
      jobId,
      requestId,
      projectRoot: project.rootPath,
      scriptName: record.scriptName,
      packageManager: record.packageManager,
      source: record.source,
      status: 'RUNNING',
      startedAt,
      finishedAt: null,
      result: null,
      log: { stdout: '', stderr: '' },
    };
  }

  public async read(
    project: ProjectReference,
    jobId: string,
    view: 'status' | 'logs' | 'result',
  ): Promise<Record<string, unknown>> {
    const record = (await this.readDocument()).jobs.find((candidate) => candidate.jobId === jobId);
    if (record === undefined) {
      return this.legacyJobs.read(jobId, view, project.rootPath);
    }
    if (record.projectId !== project.id || record.projectRoot !== project.rootPath) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Validation job does not belong to the selected registered project');
    }
    const snapshot = await this.jobs.compatibilitySnapshot(project.id, jobId);
    const state = requiredString(snapshot, 'state');
    const status = legacyStatus(state);
    const stdout = requiredString(snapshot, 'stdout');
    const stderr = requiredString(snapshot, 'stderr');
    if (view === 'logs') return { jobId, status, stdout, stderr };

    const result = legacyResult(record, snapshot, status);
    if (view === 'result') return { jobId, status, result };

    return {
      jobId,
      requestId: record.requestId,
      projectRoot: record.projectRoot,
      scriptName: record.scriptName,
      packageManager: record.packageManager,
      source: record.source,
      status,
      startedAt: requiredString(snapshot, 'startedAt'),
      finishedAt: nullableString(snapshot, 'finishedAt'),
      result,
      log: { stdout, stderr },
    };
  }

  private upsert(record: ValidationCompatibilityRecord): Promise<void> {
    const operation = this.writeTail.then(async () => {
      const document = await this.readDocument();
      const existing = document.jobs.find((candidate) => candidate.jobId === record.jobId);
      if (existing !== undefined) {
        if (existing.projectId !== record.projectId || existing.requestId !== record.requestId || existing.scriptName !== record.scriptName) {
          throw new RuntimeError('PRECONDITION_FAILED', 'Validation compatibility metadata conflicts with the durable job identity');
        }
        return;
      }
      await this.writeDocument({ schemaVersion: 1, jobs: [...document.jobs, record].slice(-MAX_RECORDS) });
    });
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readDocument(): Promise<ValidationCompatibilityDocument> {
    const filename = path.join(this.resources.dataRoot, COMPAT_FILE);
    const inspected = await inspectPrivateRegularFile(filename, 'Validation compatibility store');
    if (inspected.state === 'missing') return { schemaVersion: 1, jobs: [] };
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      const parsed = JSON.parse(inspected.content) as unknown;
      if (!isDocument(parsed)) throw new Error('schema validation failed');
      return parsed;
    } catch (error) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Validation compatibility store is invalid', { cause: error });
    }
  }

  private async writeDocument(document: ValidationCompatibilityDocument): Promise<void> {
    if (!isDocument(document)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to write invalid validation compatibility metadata');
    const filename = path.join(this.resources.dataRoot, COMPAT_FILE);
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
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Validation compatibility metadata publication failed', { cause: error });
    }
  }
}

function projectTestResult(declaration: ProjectValidationDeclaration, value: Record<string, unknown>): ProjectTestResult {
  const exitCode = nullableInteger(value, 'exitCode');
  const timedOut = requiredBoolean(value, 'timedOut');
  const stdout = requiredString(value, 'stdoutTail');
  const stderr = requiredString(value, 'stderrTail');
  const outputTruncated = requiredBoolean(value, 'stdoutTruncated') || requiredBoolean(value, 'stderrTruncated');
  return {
    scriptName: declaration.scriptName,
    packageManager: declaration.packageManager,
    passed: exitCode === 0 && !timedOut,
    exitCode,
    timedOut,
    stdout,
    stderr,
    outputTruncated,
  };
}

function legacyResult(
  record: ValidationCompatibilityRecord,
  snapshot: Record<string, unknown>,
  status: 'RUNNING' | 'PASSED' | 'FAILED' | 'INTERRUPTED',
): ProjectTestResult | null {
  if (status === 'RUNNING' || status === 'INTERRUPTED') return null;
  const exitCode = nullableInteger(snapshot, 'exitCode');
  const timedOut = requiredBoolean(snapshot, 'timedOut');
  return {
    scriptName: record.scriptName,
    packageManager: record.packageManager,
    passed: status === 'PASSED',
    exitCode,
    timedOut,
    stdout: requiredString(snapshot, 'stdout'),
    stderr: requiredString(snapshot, 'stderr'),
    outputTruncated: requiredBoolean(snapshot, 'stdoutTruncated') || requiredBoolean(snapshot, 'stderrTruncated'),
  };
}

function legacyStatus(state: string): 'RUNNING' | 'PASSED' | 'FAILED' | 'INTERRUPTED' {
  if (state === 'QUEUED' || state === 'RUNNING') return 'RUNNING';
  if (state === 'SUCCEEDED') return 'PASSED';
  if (state === 'FAILED' || state === 'CANCELLED') return 'FAILED';
  if (state === 'LOST' || state === 'INTERRUPTED') return 'INTERRUPTED';
  throw new RuntimeError('PERSISTENCE_FAILURE', 'Durable job exposed an unknown validation compatibility state');
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string') throw new RuntimeError('PERSISTENCE_FAILURE', `Durable job compatibility field ${key} is invalid`);
  return candidate;
}

function nullableString(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  if (candidate === null) return null;
  if (typeof candidate !== 'string') throw new RuntimeError('PERSISTENCE_FAILURE', `Durable job compatibility field ${key} is invalid`);
  return candidate;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  const candidate = value[key];
  if (typeof candidate !== 'boolean') throw new RuntimeError('PERSISTENCE_FAILURE', `Durable job compatibility field ${key} is invalid`);
  return candidate;
}

function nullableInteger(value: Record<string, unknown>, key: string): number | null {
  const candidate = value[key];
  if (candidate === null) return null;
  if (!Number.isSafeInteger(candidate)) throw new RuntimeError('PERSISTENCE_FAILURE', `Durable job compatibility field ${key} is invalid`);
  return candidate as number;
}

function isDocument(value: unknown): value is ValidationCompatibilityDocument {
  return isRecord(value)
    && value.schemaVersion === 1
    && Array.isArray(value.jobs)
    && value.jobs.length <= MAX_RECORDS
    && value.jobs.every((job) => isRecord(job)
      && typeof job.jobId === 'string'
      && typeof job.requestId === 'string'
      && typeof job.projectId === 'string'
      && typeof job.projectRoot === 'string'
      && typeof job.scriptName === 'string'
      && (job.packageManager === 'npm' || job.packageManager === 'pnpm')
      && job.source === 'root-package.json'
      && typeof job.startedAt === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
