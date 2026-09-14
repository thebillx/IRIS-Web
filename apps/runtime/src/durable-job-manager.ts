import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError, type CapabilityEffect, type JobId, type MissionExecutionAssociation, type WorkspaceId } from '@iris/domain';
import { inspectPrivateRegularFile, privateDirectoryProblem } from './private-fs.js';
import { resolveExecutionProfile, type ExecutionProfilePlan } from './execution-profiles.js';
import { boundedTail, StreamingRedactor } from './output-redaction.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { observeProcessStart } from './macos-safety.js';

const execFileAsync = promisify(execFile);
const JOB_FILE = 'vnext-jobs.json';
const JOB_DIR = 'vnext-job-runtime';
const MAX_JOBS = 200;
const INLINE_OUTPUT_BYTES = 16 * 1024;
const LOG_WINDOW_MAX = 64 * 1024;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const RUNNER_PATH = fileURLToPath(new URL('../job-runner.mjs', import.meta.url));

export type DurableJobState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'LOST' | 'INTERRUPTED';

export interface ShellExecutionInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly executionProfile: string;
  readonly envOverrides: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stdinArtifactId?: string | undefined;
}

export interface PreparedShellExecution {
  readonly input: ShellExecutionInput;
  readonly plan: ExecutionProfilePlan;
  readonly workspaceId: WorkspaceId;
}

export interface DurableJobRecord {
  readonly jobId: JobId;
  readonly requestId: string;
  readonly projectId: string;
  readonly workspaceId: WorkspaceId;
  readonly missionId: string | null;
  readonly taskId: string | null;
  readonly actionId: string | null;
  readonly executionProfile: string;
  readonly executableIdentity: string;
  readonly argvDigest: string;
  readonly effectiveEffects: readonly CapabilityEffect[];
  readonly runnerIdentity: string;
  readonly runnerPid: number | null;
  readonly runnerStartMarker: string | null;
  readonly pid: number | null;
  readonly processStartMarker: string | null;
  readonly processGroupId: number | null;
  readonly state: DurableJobState;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly logWorkspaceId: WorkspaceId;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly claimPath: string;
  readonly resultPath: string;
  readonly cancelPath: string;
  readonly logArtifactIds: readonly string[];
  readonly artifactIds: readonly string[];
}

interface JobDocument { readonly schemaVersion: 1; readonly jobs: readonly DurableJobRecord[] }
interface RunnerOnlyClaim {
  readonly schemaVersion: 1; readonly jobId: string; readonly runnerIdentity: string;
  readonly runnerPid: number; readonly runnerProcessGroupId: number; readonly runnerStartMarker: string; readonly createdAt: string;
}
interface RunnerClaim {
  readonly schemaVersion: 1; readonly jobId: string; readonly runnerIdentity: string;
  readonly runnerPid: number; readonly runnerProcessGroupId: number; readonly runnerStartMarker: string;
  readonly targetPid: number; readonly targetProcessGroupId: number; readonly targetStartMarker: string; readonly createdAt: string;
}
interface RunnerResult {
  readonly schemaVersion: 1; readonly jobId: string; readonly runnerIdentity: string;
  readonly state: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'; readonly exitCode: number | null; readonly signal: string | null;
  readonly timedOut: boolean; readonly cancelled: boolean; readonly error: string | null; readonly finishedAt: string;
}

export class DurableJobManager {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly dataRoot: string, private readonly resources: VNextResourceRegistry) {}

  public async prepare(input: ShellExecutionInput): Promise<PreparedShellExecution> {
    const workspace = await this.resources.getActiveWorkspace(input.projectId, input.workspaceId);
    let stdinPath: string | null = null;
    if (input.stdinArtifactId !== undefined) stdinPath = (await this.resources.getArtifact(input.projectId, input.stdinArtifactId)).physicalPath;
    const plan = await resolveExecutionProfile({
      workspace,
      executable: input.executable,
      argv: input.argv,
      cwd: input.cwd,
      executionProfile: input.executionProfile,
      envOverrides: input.envOverrides,
      timeoutMs: input.timeoutMs,
      stdinPath,
    });
    return { input, plan, workspaceId: workspace.workspaceId };
  }

  public async run(prepared: PreparedShellExecution, effects: readonly CapabilityEffect[], mission?: MissionExecutionAssociation): Promise<Record<string, unknown>> {
    const executionId = randomUUID();
    const logWorkspace = await this.resources.createScratch(prepared.input.projectId, mission?.actionId ?? null);
    const stdoutPath = path.join(logWorkspace.physicalRoot, 'stdout.log');
    const stderrPath = path.join(logWorkspace.physicalRoot, 'stderr.log');
    await writeFile(stdoutPath, '', { mode: 0o600, flag: 'wx' });
    await writeFile(stderrPath, '', { mode: 0o600, flag: 'wx' });
    const stdoutStream = createWriteStream(stdoutPath, { flags: 'a' });
    const stderrStream = createWriteStream(stderrPath, { flags: 'a' });
    const stdoutRedactor = new StreamingRedactor(prepared.plan.redactionValues);
    const stderrRedactor = new StreamingRedactor(prepared.plan.redactionValues);
    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    const startedAt = new Date().toISOString();
    const child = spawn(prepared.plan.executableIdentity, prepared.plan.argv, {
      cwd: prepared.plan.cwd,
      env: prepared.plan.environment,
      detached: true,
      stdio: [prepared.plan.stdinPath ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (child.pid === undefined) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Process did not expose a PID');
    const targetPid = child.pid;
    const terminalPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }).catch((error: unknown) => ({ code: null, signal: null as NodeJS.Signals | null, error }));
    if (prepared.plan.stdinPath !== null && child.stdin !== null) createReadStream(prepared.plan.stdinPath).pipe(child.stdin);
    child.stdout?.on('data', (chunk) => {
      const text = stdoutRedactor.push(String(chunk));
      if (text) { writeWithBackpressure(stdoutStream, text, child.stdout); stdoutTail = tailAppend(stdoutTail, text); }
    });
    child.stderr?.on('data', (chunk) => {
      const text = stderrRedactor.push(String(chunk));
      if (text) { writeWithBackpressure(stderrStream, text, child.stderr); stderrTail = tailAppend(stderrTail, text); }
    });

    const startObservation = observeProcessStart(targetPid);
    let pgid: number | null = null;
    if (startObservation.state === 'live') {
      try {
        pgid = await processGroupId(targetPid);
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) throw error;
      }
    } else if (startObservation.state === 'indeterminate') {
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Process start identity could not be established');
    }

    const timeout = pgid === null ? null : setTimeout(() => {
      timedOut = true;
      safeKillGroup(pgid, 'SIGTERM');
      setTimeout(() => safeKillGroup(pgid, 'SIGKILL'), 1000).unref();
    }, prepared.plan.timeoutMs);
    timeout?.unref();
    const terminal = await terminalPromise;
    if (timeout !== null) clearTimeout(timeout);
    const stdoutFinal = stdoutRedactor.finish();
    const stderrFinal = stderrRedactor.finish();
    if (stdoutFinal) { stdoutStream.write(stdoutFinal); stdoutTail = tailAppend(stdoutTail, stdoutFinal); }
    if (stderrFinal) { stderrStream.write(stderrFinal); stderrTail = tailAppend(stderrTail, stderrFinal); }
    await Promise.all([endStream(stdoutStream), endStream(stderrStream)]);
    const exitCode = 'code' in terminal ? terminal.code : null;
    const signal = 'signal' in terminal ? terminal.signal : null;
    const finishedAt = new Date().toISOString();
    const logArtifactIds = await this.registerLogArtifacts(prepared.input.projectId, logWorkspace.workspaceId, null, mission?.actionId ?? null, stdoutPath, stderrPath);
    const stdoutBounded = boundedTail(stdoutTail, INLINE_OUTPUT_BYTES);
    const stderrBounded = boundedTail(stderrTail, INLINE_OUTPUT_BYTES);
    return {
      executionId,
      workspaceId: prepared.workspaceId,
      executableIdentity: prepared.plan.executableIdentity,
      normalizedArgvDigest: argvDigest(prepared.plan.argv),
      effectiveEffects: effects,
      exitCode,
      signal,
      timedOut,
      stdoutTail: stdoutBounded.text,
      stderrTail: stderrBounded.text,
      stdoutTruncated: stdoutBounded.truncated || (await stat(stdoutPath)).size > INLINE_OUTPUT_BYTES,
      stderrTruncated: stderrBounded.truncated || (await stat(stderrPath)).size > INLINE_OUTPUT_BYTES,
      logArtifactIds,
      producedArtifactIds: [],
      startedAt,
      finishedAt,
    };
  }

  public async start(prepared: PreparedShellExecution, requestId: string, effects: readonly CapabilityEffect[], mission?: MissionExecutionAssociation): Promise<Record<string, unknown>> {
    if (!REQUEST_ID.test(requestId)) throw new RuntimeError('INVALID_REQUEST', 'requestId is invalid');
    const digest = argvDigest(prepared.plan.argv);
    const existing = (await this.readDocument()).jobs.find((job) => job.requestId === requestId && job.projectId === prepared.input.projectId);
    if (existing !== undefined) {
      if (existing.workspaceId !== prepared.workspaceId || existing.executionProfile !== prepared.plan.profileId || existing.executableIdentity !== prepared.plan.executableIdentity || existing.argvDigest !== digest) {
        throw new RuntimeError('PRECONDITION_FAILED', 'requestId already belongs to a different execution request');
      }
      const recovered = await this.reconcile(existing);
      return startView(recovered);
    }

    const jobId = randomUUID() as JobId;
    const runnerIdentity = randomUUID();
    const logWorkspace = await this.resources.createScratch(prepared.input.projectId, mission?.actionId ?? null);
    const stdoutPath = path.join(logWorkspace.physicalRoot, 'stdout.log');
    const stderrPath = path.join(logWorkspace.physicalRoot, 'stderr.log');
    await writeFile(stdoutPath, '', { mode: 0o600, flag: 'wx' });
    await writeFile(stderrPath, '', { mode: 0o600, flag: 'wx' });
    const runtimeDir = await this.ensureJobDirectory(jobId);
    const runnerClaimPath = path.join(runtimeDir, 'runner-claim.json');
    const permitPath = path.join(runtimeDir, 'start-permit.json');
    const claimPath = path.join(runtimeDir, 'claim.json');
    const resultPath = path.join(runtimeDir, 'result.json');
    const cancelPath = path.join(runtimeDir, 'cancel.json');
    const specPath = path.join(runtimeDir, 'spec.json');
    const startedAt = new Date().toISOString();
    const queued: DurableJobRecord = {
      jobId, requestId, projectId: prepared.input.projectId, workspaceId: prepared.workspaceId,
      missionId: mission?.missionId ?? null, taskId: mission?.taskId ?? null, actionId: mission?.actionId ?? null,
      executionProfile: prepared.plan.profileId, executableIdentity: prepared.plan.executableIdentity, argvDigest: digest,
      effectiveEffects: [...effects], runnerIdentity, runnerPid: null, runnerStartMarker: null, pid: null,
      processStartMarker: null, processGroupId: null, state: 'QUEUED', startedAt, finishedAt: null,
      exitCode: null, signal: null, logWorkspaceId: logWorkspace.workspaceId,
      stdoutPath, stderrPath, claimPath, resultPath, cancelPath, logArtifactIds: [], artifactIds: [],
    };
    await this.appendJob(queued);
    await writeFile(specPath, `${JSON.stringify({
      schemaVersion: 1, jobId, runnerIdentity, executableIdentity: prepared.plan.executableIdentity, argv: prepared.plan.argv,
      cwd: prepared.plan.cwd, environment: prepared.plan.environment, redactionValues: prepared.plan.redactionValues,
      timeoutMs: prepared.plan.timeoutMs, stdinPath: prepared.plan.stdinPath,
      stdoutPath, stderrPath, runnerClaimPath, permitPath, claimPath, resultPath, cancelPath,
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const runner = spawn(process.execPath, [RUNNER_PATH, '--spec', specPath, '--job', jobId, '--runner', runnerIdentity], {
      cwd: this.dataRoot,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: this.dataRoot, TMPDIR: '/tmp', LANG: 'en_US.UTF-8' },
      detached: true,
      stdio: 'ignore',
    });
    if (runner.pid === undefined) {
      const lost = { ...queued, state: 'LOST' as const, finishedAt: new Date().toISOString() };
      await this.replaceJob(lost);
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Durable runner did not expose a PID');
    }
    const spawnedRunnerPid = runner.pid;
    runner.unref();
    const runnerClaim = await waitForRunnerClaim(runnerClaimPath, resultPath, jobId, runnerIdentity, spawnedRunnerPid);
    if (!(await verifyRunnerClaim(runnerClaim, jobId, runnerIdentity, spawnedRunnerPid))) {
      const lost = { ...queued, state: 'LOST' as const, finishedAt: new Date().toISOString() };
      await this.replaceJob(lost);
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Durable runner identity could not be verified before target spawn');
    }
    await writeFile(permitPath, `${JSON.stringify({ jobId, runnerIdentity, permittedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
    const claim = await waitForClaim(claimPath, resultPath, jobId, runnerIdentity);
    const verified = await verifyClaim(claim, jobId, runnerIdentity);
    if (!verified || claim.runnerPid !== spawnedRunnerPid) {
      const lost = { ...queued, state: 'LOST' as const, finishedAt: new Date().toISOString() };
      await this.replaceJob(lost);
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Durable target identity could not be verified after permitted spawn');
    }
    const running: DurableJobRecord = {
      ...queued, state: 'RUNNING', runnerPid: claim.runnerPid, runnerStartMarker: claim.runnerStartMarker,
      pid: claim.targetPid, processStartMarker: claim.targetStartMarker, processGroupId: claim.targetProcessGroupId,
    };
    await this.replaceJob(running);
    return startView(running);
  }

  public async status(projectId: string, jobId: string): Promise<Record<string, unknown>> {
    return statusView(await this.reconcile(await this.getOwnedJob(projectId, jobId)));
  }

  public async logs(projectId: string, jobId: string, stream: 'stdout' | 'stderr', cursor?: string, maxBytes = 16 * 1024): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LOG_WINDOW_MAX) throw new RuntimeError('INVALID_REQUEST', 'maxBytes is outside the bounded log window');
    const job = await this.reconcile(await this.getOwnedJob(projectId, jobId));
    const offset = decodeCursor(cursor, stream);
    const filename = stream === 'stdout' ? job.stdoutPath : job.stderrPath;
    const handle = await open(filename, 'r');
    try {
      const metadata = await handle.stat();
      const remaining = Math.max(0, metadata.size - offset);
      const length = Math.min(maxBytes, remaining);
      const buffer = Buffer.alloc(length);
      const result = length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, length, offset);
      const nextOffset = offset + result.bytesRead;
      return { jobId, state: job.state, stream, cursor: encodeCursor(stream, nextOffset), text: buffer.subarray(0, result.bytesRead).toString('utf8'), eof: nextOffset >= metadata.size, bytes: result.bytesRead };
    } finally { await handle.close(); }
  }

  public async result(projectId: string, jobId: string): Promise<Record<string, unknown>> {
    return resultView(await this.reconcile(await this.getOwnedJob(projectId, jobId)));
  }

  public async cancel(projectId: string, jobId: string): Promise<Record<string, unknown>> {
    const job = await this.reconcile(await this.getOwnedJob(projectId, jobId));
    if (job.state !== 'RUNNING') return { jobId, state: job.state, cancelRequested: false };
    const claim = await readClaim(job.claimPath);
    if (claim === null || !(await verifyClaim(claim, job.jobId, job.runnerIdentity)) || claim.targetPid !== job.pid || claim.targetStartMarker !== job.processStartMarker || claim.targetProcessGroupId !== job.processGroupId) {
      const lost = await this.markLost(job);
      return { jobId, state: lost.state, cancelRequested: false, reason: 'PROCESS_OWNERSHIP_AMBIGUOUS' };
    }
    await writeFile(job.cancelPath, `${JSON.stringify({ jobId, runnerIdentity: job.runnerIdentity, requestedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    safeKillGroup(claim.targetProcessGroupId, 'SIGTERM');
    setTimeout(() => {
      void verifyClaim(claim, job.jobId, job.runnerIdentity).then((exact) => { if (exact) safeKillGroup(claim.targetProcessGroupId, 'SIGKILL'); });
    }, 1000).unref();
    return { jobId, state: 'RUNNING', cancelRequested: true };
  }

  public async recover(): Promise<void> {
    const document = await this.readDocument();
    for (const job of document.jobs) if (job.state === 'RUNNING' || job.state === 'QUEUED') await this.reconcile(job);
  }

  private async reconcile(job: DurableJobRecord): Promise<DurableJobRecord> {
    if (isTerminal(job.state)) return job;
    const runnerResult = await readRunnerResult(job.resultPath);
    if (runnerResult !== null) return this.finishFromRunner(job, runnerResult);
    const claim = await readClaim(job.claimPath);
    if (claim !== null && await verifyClaim(claim, job.jobId, job.runnerIdentity)) {
      if (job.state === 'QUEUED' || job.pid === null) {
        const running: DurableJobRecord = { ...job, state: 'RUNNING', runnerPid: claim.runnerPid, runnerStartMarker: claim.runnerStartMarker, pid: claim.targetPid, processStartMarker: claim.targetStartMarker, processGroupId: claim.targetProcessGroupId };
        await this.replaceJob(running);
        return running;
      }
      if (claim.targetPid === job.pid && claim.targetStartMarker === job.processStartMarker && claim.targetProcessGroupId === job.processGroupId) return job;
    }
    const retry = await readRunnerResult(job.resultPath);
    if (retry !== null) return this.finishFromRunner(job, retry);
    return this.markLost(job);
  }

  private async finishFromRunner(job: DurableJobRecord, runner: RunnerResult): Promise<DurableJobRecord> {
    if (runner.jobId !== job.jobId || runner.runnerIdentity !== job.runnerIdentity) return this.markLost(job);
    const logArtifactIds = job.logArtifactIds.length > 0 ? job.logArtifactIds : await this.registerLogArtifacts(job.projectId, job.logWorkspaceId, job.jobId, job.actionId, job.stdoutPath, job.stderrPath);
    const finished: DurableJobRecord = { ...job, state: runner.state, finishedAt: runner.finishedAt, exitCode: runner.exitCode, signal: runner.signal, logArtifactIds };
    await this.replaceJob(finished);
    return finished;
  }

  private async markLost(job: DurableJobRecord): Promise<DurableJobRecord> {
    const lost: DurableJobRecord = { ...job, state: job.state === 'QUEUED' ? 'INTERRUPTED' : 'LOST', finishedAt: job.finishedAt ?? new Date().toISOString() };
    await this.replaceJob(lost);
    return lost;
  }

  private async registerLogArtifacts(projectId: string, workspaceId: WorkspaceId, jobId: JobId | null, actionId: string | null, stdoutPath: string, stderrPath: string): Promise<readonly string[]> {
    const ids: string[] = [];
    for (const [file, stream] of [[stdoutPath, 'stdout'], [stderrPath, 'stderr']] as const) {
      const metadata = await stat(file);
      const artifact = await this.resources.registerArtifact({
        projectId, workspaceId, physicalPath: file, producerJobId: jobId, producerActionId: actionId,
        mime: 'text/plain; charset=utf-8', artifactType: `log-${stream}`, size: metadata.size,
        sha256: await sha256File(file), sensitivity: 'SENSITIVE', retentionPolicy: 'MISSION',
      });
      ids.push(artifact.artifactId);
    }
    return ids;
  }

  private async getOwnedJob(projectId: string, jobId: string): Promise<DurableJobRecord> {
    const job = (await this.readDocument()).jobs.find((candidate) => candidate.jobId === jobId);
    if (job === undefined) throw new RuntimeError('INVALID_REQUEST', 'Job was not found');
    if (job.projectId !== projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Job does not belong to the selected project');
    await this.resources.getActiveWorkspace(projectId, job.workspaceId);
    return job;
  }

  private async ensureJobDirectory(jobId: string): Promise<string> {
    const root = path.join(this.dataRoot, JOB_DIR);
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const problem = await privateDirectoryProblem(root, 'vNext job runtime');
    if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
    const directory = path.join(root, jobId);
    await mkdir(directory, { mode: 0o700 });
    return directory;
  }

  private async readDocument(): Promise<JobDocument> {
    const inspected = await inspectPrivateRegularFile(path.join(this.dataRoot, JOB_FILE), 'vNext job store');
    if (inspected.state === 'missing') return { schemaVersion: 1, jobs: [] };
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      const parsed = JSON.parse(inspected.content) as JobDocument;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs) || parsed.jobs.length > MAX_JOBS) throw new Error('schema');
      return parsed;
    } catch (error) { throw new RuntimeError('PERSISTENCE_FAILURE', 'vNext job store is invalid', { cause: error }); }
  }

  private appendJob(job: DurableJobRecord): Promise<void> {
    return this.serialized(async () => { const document = await this.readDocument(); await this.writeDocument({ schemaVersion: 1, jobs: [...document.jobs, job].slice(-MAX_JOBS) }); });
  }
  private replaceJob(job: DurableJobRecord): Promise<void> {
    return this.serialized(async () => { const document = await this.readDocument(); await this.writeDocument({ schemaVersion: 1, jobs: document.jobs.map((candidate) => candidate.jobId === job.jobId ? job : candidate) }); });
  }
  private serialized(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationTail.then(operation, operation); this.mutationTail = result.then(() => undefined, () => undefined); return result;
  }
  private async writeDocument(document: JobDocument): Promise<void> {
    const filename = path.join(this.dataRoot, JOB_FILE); const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temporary, filename); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw new RuntimeError('PERSISTENCE_FAILURE', 'vNext job state publication failed', { cause: error }); }
  }
}

function argvDigest(argv: readonly string[]): string { return createHash('sha256').update(JSON.stringify(argv)).digest('hex'); }
function startView(job: DurableJobRecord): Record<string, unknown> { return { jobId: job.jobId, requestId: job.requestId, state: job.state, workspaceId: job.workspaceId, startedAt: job.startedAt, effectiveEffects: job.effectiveEffects }; }
function statusView(job: DurableJobRecord): Record<string, unknown> { return { jobId: job.jobId, requestId: job.requestId, projectId: job.projectId, workspaceId: job.workspaceId, state: job.state, startedAt: job.startedAt, finishedAt: job.finishedAt, pid: job.pid, processStartMarker: job.processStartMarker, processGroupId: job.processGroupId, runnerIdentity: job.runnerIdentity, effectiveEffects: job.effectiveEffects }; }
function resultView(job: DurableJobRecord): Record<string, unknown> { return { jobId: job.jobId, state: job.state, exitCode: job.exitCode, signal: job.signal, startedAt: job.startedAt, finishedAt: job.finishedAt, logArtifactIds: job.logArtifactIds, artifactIds: job.artifactIds }; }
function isTerminal(state: DurableJobState): boolean { return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'LOST' || state === 'INTERRUPTED'; }
function tailAppend(current: string, addition: string): string { const combined = current + addition; return Buffer.byteLength(combined, 'utf8') <= INLINE_OUTPUT_BYTES * 2 ? combined : Buffer.from(combined, 'utf8').subarray(-INLINE_OUTPUT_BYTES * 2).toString('utf8'); }
function writeWithBackpressure(stream: NodeJS.WritableStream, text: string, source: NodeJS.ReadableStream | null): void { if (!stream.write(text) && source !== null && 'pause' in source) { source.pause(); stream.once('drain', () => source.resume()); } }
function endStream(stream: NodeJS.WritableStream): Promise<void> { return new Promise((resolve) => stream.end(resolve)); }
async function sha256File(filename: string): Promise<string> { return new Promise((resolve, reject) => { const hash = createHash('sha256'); const input = createReadStream(filename); input.on('data', (chunk) => hash.update(chunk)); input.on('error', reject); input.on('end', () => resolve(hash.digest('hex'))); }); }
function safeKillGroup(pgid: number, signal: NodeJS.Signals): void { if (!Number.isSafeInteger(pgid) || pgid <= 1) return; try { process.kill(-pgid, signal); } catch { /* Verified group may already be gone. */ } }
async function processGroupId(pid: number): Promise<number> { const value = await psField(pid, 'pgid'); const pgid = Number(value); if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Process group identity is invalid'); return pgid; }
async function psField(pid: number, field: string): Promise<string> { const result = await execFileAsync('/bin/ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 }); const value = result.stdout.trim(); if (!value) throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Process identity is unavailable'); return value; }
async function verifyProcess(pid: number, marker: string, pgid: number, commandContains?: readonly string[]): Promise<boolean> {
  try {
    const observed = observeProcessStart(pid);
    if (observed.state !== 'live' || observed.marker !== marker) return false;
    const [actualPgid, command] = await Promise.all([psField(pid, 'pgid'), psField(pid, 'command')]);
    return Number(actualPgid) === pgid && (commandContains?.every((part) => command.includes(part)) ?? true);
  } catch {
    return false;
  }
}
async function verifyRunnerClaim(claim: RunnerOnlyClaim, jobId: string, runnerIdentity: string, spawnedRunnerPid: number): Promise<boolean> {
  if (claim.schemaVersion !== 1 || claim.jobId !== jobId || claim.runnerIdentity !== runnerIdentity || claim.runnerPid !== spawnedRunnerPid || claim.runnerProcessGroupId !== claim.runnerPid) return false;
  return verifyProcess(claim.runnerPid, claim.runnerStartMarker, claim.runnerProcessGroupId, ['job-runner.mjs', jobId, runnerIdentity]);
}
async function verifyClaim(claim: RunnerClaim, jobId: string, runnerIdentity: string): Promise<boolean> { if (claim.schemaVersion !== 1 || claim.jobId !== jobId || claim.runnerIdentity !== runnerIdentity || claim.runnerProcessGroupId !== claim.runnerPid) return false; const [runner, target] = await Promise.all([verifyProcess(claim.runnerPid, claim.runnerStartMarker, claim.runnerProcessGroupId, ['job-runner.mjs', jobId, runnerIdentity]), verifyProcess(claim.targetPid, claim.targetStartMarker, claim.targetProcessGroupId)]); return runner && target; }
async function waitForRunnerClaim(filename: string, resultPath: string, jobId: string, runnerIdentity: string, spawnedRunnerPid: number): Promise<RunnerOnlyClaim> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const claim = await readRunnerClaim(filename);
    if (claim !== null && claim.jobId === jobId && claim.runnerIdentity === runnerIdentity && claim.runnerPid === spawnedRunnerPid) return claim;
    const bootstrapResult = await readRunnerResult(resultPath);
    if (bootstrapResult !== null) {
      const detail = bootstrapResult.error === null ? 'unknown bootstrap failure' : bootstrapResult.error.replace(/\s+/g, ' ').slice(-300);
      throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `Durable runner failed before publishing a verifiable claim: ${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Durable runner did not publish a verifiable runner claim before target spawn');
}
async function waitForClaim(filename: string, resultPath: string, jobId: string, runnerIdentity: string): Promise<RunnerClaim> { const deadline = Date.now() + 8000; while (Date.now() < deadline) { const claim = await readClaim(filename); if (claim !== null && claim.jobId === jobId && claim.runnerIdentity === runnerIdentity) return claim; const runnerResult = await readRunnerResult(resultPath); if (runnerResult !== null) { const detail = runnerResult.error === null ? 'runner terminated before target claim' : runnerResult.error.replace(/\s+/g, ' ').slice(-300); throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', `Durable runner failed before publishing a target claim: ${detail}`); } await new Promise((resolve) => setTimeout(resolve, 25)); } throw new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Durable runner did not publish a verified target process claim'); }
async function readRunnerClaim(filename: string): Promise<RunnerOnlyClaim | null> { try { const value = JSON.parse(await readFile(filename, 'utf8')) as RunnerOnlyClaim; return value.schemaVersion === 1 ? value : null; } catch { return null; } }
async function readClaim(filename: string): Promise<RunnerClaim | null> { try { const value = JSON.parse(await readFile(filename, 'utf8')) as RunnerClaim; return value.schemaVersion === 1 ? value : null; } catch { return null; } }
async function readRunnerResult(filename: string): Promise<RunnerResult | null> { try { const value = JSON.parse(await readFile(filename, 'utf8')) as RunnerResult; return value.schemaVersion === 1 ? value : null; } catch { return null; } }
function encodeCursor(stream: 'stdout' | 'stderr', offset: number): string { return Buffer.from(JSON.stringify({ stream, offset }), 'utf8').toString('base64url'); }
function decodeCursor(cursor: string | undefined, stream: 'stdout' | 'stderr'): number { if (cursor === undefined) return 0; try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { stream?: unknown; offset?: unknown }; if (parsed.stream !== stream || typeof parsed.offset !== 'number' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error('bad'); return parsed.offset; } catch { throw new RuntimeError('INVALID_REQUEST', 'Log cursor is invalid for the selected stream'); } }
