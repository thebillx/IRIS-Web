import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService, type CapabilityOutcome } from './capability-service.js';
import { DurableJobManager } from './durable-job-manager.js';
import { executePhase3GroupedTool, phase3GroupedToolDefinitions } from './mcp-phase3.js';
import { catalogToolNames } from './mcp-catalog.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { ProjectValidationJobManager, runDeclaredProjectScript } from './project-test.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
const ALL_EXECUTION_EFFECTS = ['READ','WRITE','EXECUTE','NETWORK','DESTRUCTIVE'] as const;

afterEach(async () => {
  delete process.env.IRIS_PHASE3_AMBIENT_SECRET;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('IRIS vNext Phase 3 governed shell and durable jobs', () => {
  it('AC-SEC-009 + AC-RDJ-006 rejects unknown/raw/inline execution forms and still runs a physical script in a project without package.json', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    await writeFile(path.join(fixture.projectARoot, 'hello.mjs'), "console.log('rdj-shell-ok')\n");

    const executed = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'shell.run', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, executable: 'node', argv: ['hello.mjs'], cwd: '.',
      executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000, expectedEffects: ALL_EXECUTION_EFFECTS,
    }));
    expect(executed).toMatchObject({ exitCode: 0, timedOut: false, effectiveEffects: ALL_EXECUTION_EFFECTS });
    expect(executed.stdoutTail).toContain('rdj-shell-ok');
    await expect(access(path.join(fixture.projectARoot, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const request = new Request('http://127.0.0.1/mcp', { headers: { 'x-iris-client-id': fixture.sessionA.clientId } });
    await expect(executePhase3GroupedTool('shell', {
      operation: 'run', sessionId: fixture.sessionA.id, projectId: fixture.projectA.id, workspaceId: primary.workspaceId,
      executable: 'node', argv: ['hello.mjs'], cwd: '.', executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000,
      expectedEffects: ALL_EXECUTION_EFFECTS, command: 'echo raw-shell-must-be-rejected',
    }, request, fixture.service, fixture.state)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await expect(fixture.service.execute({
      capabilityId: 'shell.run', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, executable: 'node', argv: ['hello.mjs'], cwd: '.',
      executionProfile: 'future-profile', envOverrides: {}, timeoutMs: 5000, expectedEffects: ALL_EXECUTION_EFFECTS,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(fixture.service.execute({
      capabilityId: 'shell.run', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, executable: 'sh', argv: ['-c','echo nope'], cwd: '.',
      executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000, expectedEffects: ALL_EXECUTION_EFFECTS,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(fixture.service.execute({
      capabilityId: 'shell.run', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, executable: 'node', argv: ['-e','console.log(1)'], cwd: '.',
      executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000, expectedEffects: ALL_EXECUTION_EFFECTS,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(fixture.service.execute({
      capabilityId: 'shell.run', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, executable: 'node', argv: ['hello.mjs'], cwd: '..',
      executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000, expectedEffects: ALL_EXECUTION_EFFECTS,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const primaryB = await fixture.resources.primaryWorkspace(fixture.projectB.id);
    await expect(fixture.service.execute({
      capabilityId: 'shell.run', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primaryB.workspaceId, executable: 'node', argv: ['hello.mjs'], cwd: '.',
      executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000, expectedEffects: ALL_EXECUTION_EFFECTS,
    })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  });

  it('AC-SEC-010 redacts explicit secrets, excludes ambient secret inheritance, bounds inline output, and keeps audit/artifact metadata secret-free', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    process.env.IRIS_PHASE3_AMBIENT_SECRET = 'ambient-should-not-cross';
    const explicit = 'phase3-super-secret-token';
    await writeFile(path.join(fixture.projectARoot, 'secrets.mjs'), [
      "console.log('ambient=' + (process.env.IRIS_PHASE3_AMBIENT_SECRET ?? 'ABSENT'))",
      "console.log('API_TOKEN=' + process.env.API_TOKEN)",
      "console.error('Authorization: Bearer ' + process.env.API_TOKEN)",
      "console.log('x'.repeat(40000))",
    ].join('\n') + '\n');

    const value = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'shell.run', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, executable: 'node', argv: ['secrets.mjs'], cwd: '.',
      executionProfile: 'node-script', envOverrides: { API_TOKEN: explicit }, timeoutMs: 5000, expectedEffects: ALL_EXECUTION_EFFECTS,
    }));
    expect(JSON.stringify(value)).not.toContain(explicit);
    expect(JSON.stringify(value)).not.toContain('ambient-should-not-cross');
    expect(String(value.stderrTail)).toContain('[REDACTED]');
    expect(value.stdoutTruncated).toBe(true);
    const artifacts = await fixture.resources.listArtifacts(fixture.projectA.id);
    expect(artifacts.filter((artifact) => artifact.artifactType.startsWith('log-'))).toHaveLength(2);
    const stdoutArtifact = artifacts.find((artifact) => artifact.artifactType === 'log-stdout');
    expect(stdoutArtifact).toBeDefined();
    const completeStdout = await readFile(stdoutArtifact!.physicalPath, 'utf8');
    expect(completeStdout).toContain('ambient=ABSENT');
    expect(completeStdout).not.toContain(explicit);
    expect(completeStdout).not.toContain('ambient-should-not-cross');
    expect(JSON.stringify(artifacts)).not.toContain(explicit);
    expect(JSON.stringify(await fixture.audit.recent(100))).not.toContain(explicit);
  });

  it('AC-NINJA-003 + AC-NINJA-004 + AC-NINJA-008 starts promptly, persists bounded cursor logs/artifact refs, and requestId is idempotent', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    await writeFile(path.join(fixture.projectARoot, 'async.mjs'), [
      "console.log('begin')",
      "for (let i=0;i<200;i++) console.log('line-' + i + '-' + 'q'.repeat(200))",
      "setTimeout(() => { console.error('done-stderr'); process.exit(0) }, 700)",
    ].join('\n') + '\n');
    const requestId = `ninja-${randomUUID()}`;
    const startAt = Date.now();
    const first = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'shell.start', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, executable: 'node', argv: ['async.mjs'], cwd: '.',
      executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000, requestId, expectedEffects: ALL_EXECUTION_EFFECTS,
    }));
    expect(Date.now() - startAt).toBeLessThan(4000);
    expect(first).toMatchObject({ requestId, state: 'RUNNING', workspaceId: primary.workspaceId });
    const second = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'shell.start', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, executable: 'node', argv: ['async.mjs'], cwd: '.',
      executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000, requestId, expectedEffects: ALL_EXECUTION_EFFECTS,
    }));
    expect(second.jobId).toBe(first.jobId);

    let cursor: string | undefined;
    let log = '';
    for (let i = 0; i < 20; i += 1) {
      const chunk = executedValue<Record<string, unknown>>(await fixture.service.execute({
        capabilityId: 'job.logs', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
        projectId: fixture.projectA.id, jobId: String(first.jobId), stream: 'stdout', ...(cursor === undefined ? {} : { cursor }), maxBytes: 4096, expectedEffects: ['READ'],
      }));
      log += String(chunk.text);
      cursor = String(chunk.cursor);
      if (chunk.eof === true) {
        const status = executedValue<Record<string, unknown>>(await fixture.service.execute({ capabilityId: 'job.status', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id, projectId: fixture.projectA.id, jobId: String(first.jobId), expectedEffects: ['READ'] }));
        if (status.state !== 'RUNNING') break;
      }
      await delay(50);
    }
    expect(log).toContain('begin');
    const result = await waitForResult(fixture, String(first.jobId));
    expect(result).toMatchObject({ state: 'SUCCEEDED', exitCode: 0 });
    expect(Array.isArray(result.logArtifactIds) && (result.logArtifactIds as unknown[]).length === 2).toBe(true);
    expect(result).not.toHaveProperty('stdout');
    expect(result).not.toHaveProperty('stderr');
  }, 15_000);

  it('AC-NINJA-005 + AC-NINJA-006 reattaches across manager restart and duplicate requestId never duplicates target spawn', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    await writeFile(path.join(fixture.projectARoot, 'restart.mjs'), [
      "import { appendFileSync } from 'node:fs'",
      "appendFileSync('spawn-count.txt', 'spawn\\n')",
      "console.log('restart-job-alive')",
      "setTimeout(() => process.exit(0), 1400)",
    ].join('\n') + '\n');
    const requestId = `restart-${randomUUID()}`;
    const prepared = await fixture.jobs.prepare({ projectId: fixture.projectA.id, workspaceId: primary.workspaceId, executable: 'node', argv: ['restart.mjs'], cwd: '.', executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000 });
    const started = await fixture.jobs.start(prepared, requestId, ALL_EXECUTION_EFFECTS);
    const jobId = String(started.jobId);

    const replacementManager = new DurableJobManager(fixture.dataRoot, fixture.resources);
    await replacementManager.recover();
    const reattached = await replacementManager.status(fixture.projectA.id, jobId);
    expect(reattached.state).toBe('RUNNING');
    const duplicate = await replacementManager.start(prepared, requestId, ALL_EXECUTION_EFFECTS);
    expect(duplicate.jobId).toBe(jobId);

    await waitUntil(async () => (await replacementManager.result(fixture.projectA.id, jobId)).state !== 'RUNNING', 6000);
    expect((await replacementManager.result(fixture.projectA.id, jobId)).state).toBe('SUCCEEDED');
    expect((await readFile(path.join(fixture.projectARoot, 'spawn-count.txt'), 'utf8')).trim().split('\n')).toEqual(['spawn']);
  }, 15_000);

  it('AC-SEC-006 times out only the owned target process group including descendants', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    await writeFile(path.join(fixture.projectARoot, 'timeout.mjs'), [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })",
      "writeFileSync('descendant.pid', String(child.pid))",
      "setInterval(()=>{},1000)",
    ].join('\n') + '\n');
    const value = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'shell.run', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, executable: 'node', argv: ['timeout.mjs'], cwd: '.',
      executionProfile: 'node-script', envOverrides: {}, timeoutMs: 300, expectedEffects: ALL_EXECUTION_EFFECTS,
    }));
    expect(value.timedOut).toBe(true);
    const descendant = Number((await readFile(path.join(fixture.projectARoot, 'descendant.pid'), 'utf8')).trim());
    await delay(1200);
    expect(processAlive(descendant)).toBe(false);
  }, 10_000);

  it('ambiguous persisted PID/start identity fails closed and job.cancel does not kill the still-running process', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    await writeFile(path.join(fixture.projectARoot, 'ambiguous.mjs'), "import { writeFileSync } from 'node:fs'; setTimeout(() => { writeFileSync('survived.txt','yes'); process.exit(0) }, 900)\n");
    const prepared = await fixture.jobs.prepare({ projectId: fixture.projectA.id, workspaceId: primary.workspaceId, executable: 'node', argv: ['ambiguous.mjs'], cwd: '.', executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000 });
    const started = await fixture.jobs.start(prepared, `amb-${randomUUID()}`, ALL_EXECUTION_EFFECTS);
    const storePath = path.join(fixture.dataRoot, 'vnext-jobs.json');
    const store = JSON.parse(await readFile(storePath, 'utf8')) as { jobs: Array<Record<string, unknown>> };
    const record = store.jobs.find((job) => job.jobId === started.jobId)!;
    record.processStartMarker = '1:000001';
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });

    const replacement = new DurableJobManager(fixture.dataRoot, fixture.resources);
    const cancelled = await replacement.cancel(fixture.projectA.id, String(started.jobId));
    expect(cancelled).toMatchObject({ state: 'LOST', cancelRequested: false });
    await delay(1300);
    await expect(readFile(path.join(fixture.projectARoot, 'survived.txt'), 'utf8')).resolves.toBe('yes');
  }, 10_000);

  it('AC-IRIS-001 routes grouped shell through CapabilityService with server-derived effects and rejects downgraded expectedEffects before spawn', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    await writeFile(path.join(fixture.projectARoot, 'self.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('self.out','ok'); console.log('self-ok')\n");
    const request = new Request('http://127.0.0.1/mcp', { headers: { 'x-iris-client-id': fixture.sessionA.clientId } });
    const denied = await executePhase3GroupedTool('shell', {
      operation: 'run', sessionId: fixture.sessionA.id, projectId: fixture.projectA.id, workspaceId: primary.workspaceId,
      executable: 'node', argv: ['self.mjs'], cwd: '.', executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000, expectedEffects: ['EXECUTE'],
    }, request, fixture.service, fixture.state);
    expect(denied).toMatchObject({ status: 'denied', reason: expect.stringContaining('EFFECT_MISMATCH') });
    await expect(access(path.join(fixture.projectARoot, 'self.out'))).rejects.toMatchObject({ code: 'ENOENT' });
    const allowed = await executePhase3GroupedTool('shell', {
      operation: 'run', sessionId: fixture.sessionA.id, projectId: fixture.projectA.id, workspaceId: primary.workspaceId,
      executable: 'node', argv: ['self.mjs'], cwd: '.', executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000, expectedEffects: ALL_EXECUTION_EFFECTS,
    }, request, fixture.service, fixture.state);
    expect(allowed.status).toBe('executed');
    await expect(readFile(path.join(fixture.projectARoot, 'self.out'), 'utf8')).resolves.toBe('ok');
    expect(await fixture.audit.recent(50)).toEqual(expect.arrayContaining([expect.objectContaining({ capabilityId: 'shell.run', effectiveEffects: ALL_EXECUTION_EFFECTS })]));
  });

  it('AC-IRIS-009 preserves declared-script validation restrictions while source FULL adds shell/job and PRO remains exactly five read-only tools', async () => {
    const fixture = await serviceFixture();
    expect(phase3GroupedToolDefinitions().map((tool) => tool.name)).toEqual(['shell','job']);
    expect(catalogToolNames('FULL')).toEqual(expect.arrayContaining(['shell','job','workspace','fs','artifact','project_validation_run','project_validation_start']));
    expect(catalogToolNames('FULL')).toHaveLength(49);
    expect(catalogToolNames('PRO')).toEqual(['list_projects','project_info','git_status','file_read','search']);

    await expect(runDeclaredProjectScript(fixture.projectARoot, 'anything')).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await writeFile(path.join(fixture.projectARoot, 'declared.mjs'), "console.log('safe-declared-script')\n");
    await writeFile(path.join(fixture.projectARoot, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { safe: 'node declared.mjs' } }));
    const validation = await runDeclaredProjectScript(fixture.projectARoot, 'safe');
    expect(validation.scriptName).toBe('safe');
    expect(validation.passed).toBe(true);
    await expect(runDeclaredProjectScript(fixture.projectARoot, 'not-declared')).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  }, 15_000);
});

async function serviceFixture() {
  const sourceRoot = await realpath(await temp('iris-phase3-source-'));
  const dataRoot = await realpath(await temp('iris-phase3-data-'));
  const legacyRoot = await realpath(await temp('iris-phase3-legacy-'));
  const projectARoot = path.join(sourceRoot, 'project-a');
  const projectBRoot = path.join(sourceRoot, 'project-b');
  await mkdir(projectARoot);
  await mkdir(projectBRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const projectA = await state.registerProject('Phase3 Project A', projectARoot);
  const projectB = await state.registerProject('Phase3 Project B', projectBRoot);
  const sessionA = state.createSession('phase3-client-a', 'phase3-agent-a', 'security');
  const sessionB = state.createSession('phase3-client-b', 'phase3-agent-b', 'security');
  await state.setSessionCurrentProject(sessionA.id, sessionA.clientId, projectA.id);
  await state.setSessionCurrentProject(sessionB.id, sessionB.clientId, projectB.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, legacyRoot);
  const audit = new PermissionAuditStore(dataRoot);
  const resources = new VNextResourceRegistry(state, dataRoot);
  const jobs = new DurableJobManager(dataRoot, resources);
  const service = new CapabilityService(state, policy, audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: 2, connectedSessions: 2,
    agentExecutorType: 'local-development-executor', productionModelConnected: false,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }), new ProjectValidationJobManager(dataRoot), resources, jobs);
  return { sourceRoot, dataRoot, legacyRoot, projectARoot, projectBRoot, state, projectA, projectB, sessionA, sessionB, settings, audit, resources, jobs, service };
}

async function waitForResult(fixture: Awaited<ReturnType<typeof serviceFixture>>, jobId: string): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (let i = 0; i < 120; i += 1) {
    last = executedValue<Record<string, unknown>>(await fixture.service.execute({ capabilityId: 'job.result', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id, projectId: fixture.projectA.id, jobId, expectedEffects: ['READ'] }));
    if (last.state !== 'RUNNING' && last.state !== 'QUEUED') return last;
    await delay(50);
  }
  throw new Error(`Job did not finish: ${JSON.stringify(last)}`);
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  throw new Error('condition timed out');
}

function executedValue<T>(outcome: CapabilityOutcome): T {
  if (outcome.status !== 'executed') throw new Error(`Expected executed outcome, received ${outcome.status}: ${'reason' in outcome ? outcome.reason : ''}`);
  return outcome.value as T;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function temp(prefix: string): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(root); return root; }
