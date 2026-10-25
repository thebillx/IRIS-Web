import { randomUUID, createHash } from 'node:crypto';
import { access, mkdtemp, realpath, rm, rename, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { DurableJobManager } from './durable-job-manager.js';
import { DurableMutationJournal } from './durable-mutation-journal.js';
import { DurableMissionLifecycleService } from './durable-mission-service.js';
import { DurableMissionLifecycleStore } from './durable-mission-store.js';
import { WorkerAdapterRegistry } from './durable-mission-workers.js';
import { loadOrCreateMachineId } from './machine-identity.js';
import { MCP_PROTOCOL_VERSION } from './mcp.js';
import { observeProcessStart } from './macos-safety.js';
import { MissionBrokerService, MissionBrokerStore } from './mission-broker.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { ProjectValidationJobManager } from './project-test.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { startRuntimeServer, type RuntimeServerHandle } from './server.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
const servers: RuntimeServerHandle[] = [];
const jobGates: Array<{ dataRoot: string; jobId: string; releasePath: string; pid: number | null; processStartMarker: string | null }> = [];
afterEach(async () => {
  let gateCleanupError: string | null = null;
  for (const gate of jobGates.splice(0)) {
    await writeFile(gate.releasePath, 'release\n').catch(() => undefined);
    if (gate.pid === null) {
      try {
        const document = JSON.parse(await readFile(path.join(gate.dataRoot, 'vnext-jobs.json'), 'utf8')) as { jobs: Array<Record<string, unknown>> };
        const job = document.jobs.find((record) => record.jobId === gate.jobId);
        if (typeof job?.pid === 'number' && typeof job.processStartMarker === 'string') {
          gate.pid = job.pid;
          gate.processStartMarker = job.processStartMarker;
        }
      } catch { /* The job may not have been durably admitted. */ }
    }
    if (gate.pid === null) continue;
    const deadline = Date.now() + 5000;
    let observed = observeProcessStart(gate.pid);
    while (observed.state !== 'dead'
      && !(observed.state === 'live' && gate.processStartMarker !== null && observed.marker !== gate.processStartMarker)
      && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      observed = observeProcessStart(gate.pid);
    }
    if (observed.state !== 'dead'
      && !(observed.state === 'live' && gate.processStartMarker !== null && observed.marker !== gate.processStartMarker)) {
      gateCleanupError = `Test-owned durable job process did not exit after releasing its gate: ${JSON.stringify({ pid: gate.pid, processStartMarker: gate.processStartMarker, observed })}`;
      break;
    }
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
  if (gateCleanupError !== null) throw new Error(gateCleanupError);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('serves durable conversations, real filesystem journal evidence, and logical checkpoint/resume over authenticated Runtime HTTP', async () => {
  const dataRoot = await temp(); const projectRoot = await temp(); const legacyRoot = await temp();
  await loadOrCreateMachineId(dataRoot);
  let f = await fixture(dataRoot, projectRoot, legacyRoot);
  const project = await f.state.registerProject('HTTP fixture', projectRoot);
  const ensure = { conversationId: randomUUID(), requestId: randomUUID() };
  const opened = await f.call('session_open', ensure);
  expect(opened.isError).toBe(false);
  const sessionId = String(opened.structuredContent.sessionId);
  expect((await f.call('session_open', ensure)).structuredContent.sessionId).toBe(sessionId);
  expect((await f.call('session_open', { conversationId: randomUUID(), requestId: randomUUID() })).structuredContent.sessionId).not.toBe(sessionId);
  const select = { sessionId, projectId: project.id, expectedRevision: 1, requestId: randomUUID() };
  expect((await f.call('workspace_select', select)).isError).toBe(false);
  const workspace = await f.resources.primaryWorkspace(project.id);
  const write = { operation: 'write', sessionId, projectId: project.id, workspaceId: workspace.workspaceId, path: 'proof.txt', content: 'first', writeMode: 'CREATE', requestId: randomUUID() };
  expect((await f.call('fs', write)).isError).toBe(false);
  expect(await readFile(path.join(projectRoot, 'proof.txt'), 'utf8')).toBe('first');
  await writeFile(path.join(projectRoot, 'proof.txt'), 'external-change');
  expect((await f.call('fs', write)).isError).toBe(false);
  expect(await readFile(path.join(projectRoot, 'proof.txt'), 'utf8')).toBe('external-change');
  expect((await f.call('fs', { ...write, content: 'conflict' })).isError).toBe(true);
  expect((await f.call('fs', { ...write, sessionId: undefined, requestId: randomUUID() })).isError).toBe(true);
  expect((await f.call('fs', write, 'other-client')).isError).toBe(true);

  const jobRequestId = randomUUID();
  const readyPath = path.join(dataRoot, `job-${jobRequestId}.ready`);
  const releasePath = path.join(dataRoot, `job-${jobRequestId}.release`);
  await writeFile(path.join(projectRoot, 'job.mjs'), [
    "import { existsSync, writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready\\n');`,
    'const deadline = Date.now() + 60_000;',
    `while (!existsSync(${JSON.stringify(releasePath)}) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));`,
    `if (!existsSync(${JSON.stringify(releasePath)})) throw new Error('job gate expired before test release');`,
    "console.log('captured-job-released');",
  ].join('\n') + '\n');
  const started = await f.call('shell', { operation: 'start', sessionId, projectId: project.id, workspaceId: workspace.workspaceId, executable: 'node', argv: ['job.mjs'], cwd: '.', executionProfile: 'node-script', envOverrides: {}, timeoutMs: 60_000, requestId: jobRequestId });
  expect(started.isError, JSON.stringify(started)).toBe(false);
  const jobId = String(started.structuredContent.jobId);
  const jobGate = { dataRoot, jobId, releasePath, pid: null as number | null, processStartMarker: null as string | null };
  jobGates.push(jobGate);
  const startedStatus = await f.call('job', { operation: 'status', sessionId, projectId: project.id, jobId });
  expect(startedStatus.isError, JSON.stringify(startedStatus)).toBe(false);
  expect(startedStatus.structuredContent.state, JSON.stringify({ jobId, jobRequestId, status: startedStatus.structuredContent })).toBe('RUNNING');
  expect(typeof startedStatus.structuredContent.pid).toBe('number');
  expect(typeof startedStatus.structuredContent.processStartMarker).toBe('string');
  const jobPid = Number(startedStatus.structuredContent.pid);
  const processStartMarker = String(startedStatus.structuredContent.processStartMarker);
  jobGate.pid = jobPid;
  jobGate.processStartMarker = processStartMarker;
  expect(observeProcessStart(jobPid)).toMatchObject({ state: 'live', marker: processStartMarker });
  await waitForFile(readyPath, 5000, `Durable job ${jobId} did not signal child readiness`);
  const projectB = await f.state.registerProject('Second selection', await temp());
  expect((await f.call('workspace_select', { sessionId, projectId: projectB.id, expectedRevision: 2, requestId: randomUUID() })).isError).toBe(false);
  const movedB = `${projectB.rootPath}.moved`; roots.push(movedB);
  await rename(projectB.rootPath, movedB);
  expect((await f.call('job', { operation: 'status', sessionId, projectId: project.id, jobId })).isError).toBe(false);
  const movedA = `${projectRoot}.moved`; roots.push(movedA);
  await rename(projectRoot, movedA);
  expect((await f.call('job', { operation: 'status', sessionId, projectId: project.id, jobId })).isError).toBe(true);
  await rename(movedA, projectRoot);
  expect((await f.call('job', { operation: 'logs', sessionId, projectId: project.id, jobId, stream: 'stdout' })).isError).toBe(false);
  const beforeCancel = await f.call('job', { operation: 'status', sessionId, projectId: project.id, jobId });
  expect(beforeCancel.isError, JSON.stringify(beforeCancel)).toBe(false);
  expect(beforeCancel.structuredContent.state, JSON.stringify({ jobId, jobRequestId, status: beforeCancel.structuredContent })).toBe('RUNNING');
  expect(beforeCancel.structuredContent.pid).toBe(jobPid);
  expect(beforeCancel.structuredContent.processStartMarker).toBe(processStartMarker);
  expect(observeProcessStart(jobPid)).toMatchObject({ state: 'live', marker: processStartMarker });
  const cancelRequestId = randomUUID();
  const cancelled = await f.call('job', { operation: 'cancel', sessionId, projectId: project.id, jobId, requestId: cancelRequestId });
  expect(cancelled.isError, JSON.stringify({ jobId, jobRequestId, cancelRequestId, beforeCancel: beforeCancel.structuredContent, cancelled })).toBe(false);
  expect(cancelled.structuredContent).toMatchObject({ state: 'RUNNING', cancelRequested: true });
  const jobResult = await waitForTerminalJob(f, sessionId, project.id, jobId, 8000);
  const evidence = await readCancellationEvidence(dataRoot, jobId, jobRequestId, cancelRequestId, beforeCancel.structuredContent, cancelled.structuredContent, jobResult.structuredContent);
  expect(jobResult.isError, JSON.stringify(evidence)).toBe(false);
  expect(jobResult.structuredContent.state, JSON.stringify(evidence)).toBe('CANCELLED');
  expect(jobResult.structuredContent.signal, JSON.stringify(evidence)).toBe('SIGTERM');
  expect(observeProcessStart(jobPid).state, JSON.stringify(evidence)).toBe('dead');
  console.info('CANCELLATION_FIXTURE_EVIDENCE', JSON.stringify({ jobId, jobRequestId, cancelRequestId, pid: jobPid, processStartMarker, beforeCancel: beforeCancel.structuredContent.state, cancel: cancelled.structuredContent, terminal: { state: jobResult.structuredContent.state, signal: jobResult.structuredContent.signal }, processAfter: observeProcessStart(jobPid).state }));
  await rename(movedB, projectB.rootPath);
  expect((await f.call('workspace_select', { sessionId, projectId: project.id, expectedRevision: 3, requestId: randomUUID() })).isError).toBe(false);

  const created = await f.call('mission_create', { sessionId, title: 'Logical receipt proof', requestId: randomUUID(), orchestratorMode: 'CHATGPT' });
  expect(created.isError).toBe(false);
  const missionId = String(created.structuredContent.id);
  expect((await f.call('mission_start', { sessionId, missionId, expectedRevision: 1, requestId: randomUUID(), workerType: 'IRIS_LOGICAL' })).isError).toBe(false);
  const checkpoint = { sessionId, missionId, expectedRevision: 3, checkpointId: randomUUID(), summary: 'Logical metadata saved', evidenceRefs: ['fixture:logical'] };
  expect((await f.call('mission_checkpoint', checkpoint)).structuredContent.state).toBe('WAITING_FOR_SUPERVISOR');
  expect((await f.call('mission_directive', { sessionId, missionId, basedOnRevision: 5, directiveId: randomUUID(), directive: 'Continue logical metadata worker' })).isError).toBe(false);
  expect((await f.call('mission_resume', { sessionId, missionId, expectedRevision: 6, requestId: randomUUID() })).structuredContent.state).toBe('RUNNING');

  const detach = { sessionId, expectedRevision: 4, requestId: randomUUID() };
  expect((await f.call('session_detach', detach)).structuredContent.attachmentState).toBe('DETACHED');
  expect((await f.call('fs', { ...write, requestId: randomUUID() })).isError).toBe(true);
  await f.server.close(); servers.splice(servers.indexOf(f.server), 1);
  f = await fixture(dataRoot, projectRoot, legacyRoot);
  expect((await f.call('session_resume', { sessionId, expectedRevision: 5, requestId: randomUUID() })).structuredContent.attachmentState).toBe('ATTACHED');
  expect((await f.call('session_get', { sessionId })).structuredContent.currentProjectId).toBe(project.id);
  const file = path.join(dataRoot, 'vnext-mutations', `${createHash('sha256').update(detach.requestId).digest('hex')}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...record, state: 'APPLYING', result: null }), { mode: 0o600 });
  const journalBeforeProbe = await readFile(file, 'utf8');
  const status = await f.call('mutation_status', { requestId: record.requestId, fingerprint: record.fingerprint, ...record.binding });
  expect(status).toMatchObject({ isError: false, structuredContent: { state: 'COMMITTED', evidence: { attachmentState: 'DETACHED' } } });
  expect(await readFile(file, 'utf8')).toBe(journalBeforeProbe);
}, 15_000);

it('preserves natural durable job completion when cancellation is requested after terminal success', async () => {
  const dataRoot = await temp(); const projectRoot = await temp(); const legacyRoot = await temp();
  await loadOrCreateMachineId(dataRoot);
  const f = await fixture(dataRoot, projectRoot, legacyRoot);
  const project = await f.state.registerProject('Natural completion fixture', projectRoot);
  const session = await f.call('session_open', { conversationId: randomUUID(), requestId: randomUUID() });
  const sessionId = String(session.structuredContent.sessionId);
  const selected = await f.call('workspace_select', { sessionId, projectId: project.id, expectedRevision: 1, requestId: randomUUID() });
  const workspaceId = String(selected.structuredContent.currentWorkspaceId);
  const jobRequestId = randomUUID();
  const readyPath = path.join(dataRoot, `job-${jobRequestId}.ready`);
  const releasePath = path.join(dataRoot, `job-${jobRequestId}.release`);
  await writeFile(path.join(projectRoot, 'job.mjs'), [
    "import { existsSync, writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready\\n');`,
    'const deadline = Date.now() + 60_000;',
    `while (!existsSync(${JSON.stringify(releasePath)}) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));`,
    `if (!existsSync(${JSON.stringify(releasePath)})) throw new Error('job gate expired before test release');`,
    "console.log('natural-job-released');",
  ].join('\n') + '\n');
  const started = await f.call('shell', { operation: 'start', sessionId, projectId: project.id, workspaceId, executable: 'node', argv: ['job.mjs'], cwd: '.', executionProfile: 'node-script', envOverrides: {}, timeoutMs: 60_000, requestId: jobRequestId });
  expect(started.isError, JSON.stringify(started)).toBe(false);
  const jobId = String(started.structuredContent.jobId);
  const gate = { dataRoot, jobId, releasePath, pid: null as number | null, processStartMarker: null as string | null };
  jobGates.push(gate);
  await waitForFile(readyPath, 5000, `Durable job ${jobId} did not signal child readiness`);
  const beforeRelease = await f.call('job', { operation: 'status', sessionId, projectId: project.id, jobId });
  expect(beforeRelease.structuredContent.state).toBe('RUNNING');
  expect(typeof beforeRelease.structuredContent.pid).toBe('number');
  expect(typeof beforeRelease.structuredContent.processStartMarker).toBe('string');
  const pid = Number(beforeRelease.structuredContent.pid);
  const processStartMarker = String(beforeRelease.structuredContent.processStartMarker);
  gate.pid = pid;
  gate.processStartMarker = processStartMarker;
  expect(observeProcessStart(pid)).toMatchObject({ state: 'live', marker: processStartMarker });

  await writeFile(releasePath, 'release\n');
  const completed = await waitForTerminalJob(f, sessionId, project.id, jobId, 8000);
  expect(completed.isError, JSON.stringify(completed)).toBe(false);
  expect(completed.structuredContent).toMatchObject({ state: 'SUCCEEDED', exitCode: 0, signal: null });
  expect(observeProcessStart(pid).state).toBe('dead');

  const cancelRequestId = randomUUID();
  const cancelAfterCompletion = await f.call('job', { operation: 'cancel', sessionId, projectId: project.id, jobId, requestId: cancelRequestId });
  expect(cancelAfterCompletion.isError, JSON.stringify({ jobId, jobRequestId, cancelRequestId, completed: completed.structuredContent, cancelAfterCompletion })).toBe(false);
  expect(cancelAfterCompletion.structuredContent).toMatchObject({ state: 'SUCCEEDED', cancelRequested: false });
  expect(await f.call('job', { operation: 'result', sessionId, projectId: project.id, jobId })).toMatchObject({ isError: false, structuredContent: { state: 'SUCCEEDED', exitCode: 0, signal: null } });
  console.info('NATURAL_COMPLETION_FIXTURE_EVIDENCE', JSON.stringify({ jobId, jobRequestId, cancelRequestId, pid, processStartMarker, terminal: { state: completed.structuredContent.state, exitCode: completed.structuredContent.exitCode, signal: completed.structuredContent.signal }, cancelAfterCompletion: cancelAfterCompletion.structuredContent }));
  const jobsDocument = JSON.parse(await readFile(path.join(dataRoot, 'vnext-jobs.json'), 'utf8')) as { jobs: Array<Record<string, unknown>> };
  const job = jobsDocument.jobs.find((record) => record.jobId === jobId)!;
  await expectPathAbsent(String(job.cancelPath));
}, 15_000);

async function fixture(dataRoot: string, projectRoot: string, legacyRoot: string) {
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const settings = new PermissionSettingsStore(dataRoot); await settings.initialize();
  const policy = new PermissionPolicyEngine(state, settings, projectRoot, dataRoot, legacyRoot);
  const resources = new VNextResourceRegistry(state, dataRoot);
  const jobs = new DurableJobManager(dataRoot, resources);
  const health = () => ({ status: 'ready' as const, version: '0.0.0' as const, platform: 'darwin' as const, runtimeId: 'fixture-runtime', instanceId: 'fixture-instance', pid: process.pid, uptimeMs: 1, authority: 'owned' as const, connectedClients: 1, connectedSessions: 1, agentExecutorType: 'local-development-executor' as const, productionModelConnected: false, apiUrl: '', mcpUrl: '' });
  const service = new CapabilityService(state, policy, new PermissionAuditStore(dataRoot), health, new ProjectValidationJobManager(dataRoot), resources, jobs);
  const broker = new MissionBrokerService(state, new MissionBrokerStore(dataRoot));
  const lifecycle = new DurableMissionLifecycleService(state, new DurableMissionLifecycleStore(dataRoot), new WorkerAdapterRegistry());
  const server = await startRuntimeServer({ identity: { runtimeId: 'fixture-runtime', instanceId: 'fixture-instance', pid: process.pid, startedAt: new Date().toISOString(), platform: 'darwin', version: '0.0.0' }, state, capabilities: service, missionBroker: broker, missionLifecycle: lifecycle, health, doctor: async () => ({ status: 'pass', checks: [] }), isShuttingDown: () => false, controlSecret: 'fixture-control-only', ownerAccessSecret: 'fixture-owner-only', tunnelServiceSecret: 'fixture-tunnel-only', connectorDeploymentEpoch: 1, connectorRuntimeId: 'fixture-runtime', catalogRuntimeContext: { runtimeId: 'fixture-runtime', instanceId: 'fixture-instance', deploymentEpoch: 1 }, mutationJournal: new DurableMutationJournal(dataRoot), requestShutdown: () => undefined }, 51000 + Math.floor(Math.random() * 5000));
  servers.push(server);
  const call = async (name: string, args: Record<string, unknown>, clientId = 'chatgpt') => {
    const response = await fetch(server.mcpUrl, { method: 'POST', headers: { authorization: 'Bearer fixture-tunnel-only', 'content-type': 'application/json', 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'x-iris-client-id': clientId, 'x-iris-connector-profile': 'FULL', 'x-iris-deployment-epoch': '1', 'x-iris-runtime-id': 'fixture-runtime' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    expect(response.status).toBe(200);
    return (await response.json() as { result: { isError: boolean; structuredContent: Record<string, unknown> } }).result;
  };
  return { state, resources, server, call };
}
async function temp() { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-blocker-http-'))); roots.push(root); return root; }

async function waitForFile(filename: string, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(filename); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error(message);
}

async function waitForTerminalJob(f: Awaited<ReturnType<typeof fixture>>, sessionId: string, projectId: string, jobId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let result = await f.call('job', { operation: 'result', sessionId, projectId, jobId });
  while (result.structuredContent.state === 'RUNNING' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = await f.call('job', { operation: 'result', sessionId, projectId, jobId });
  }
  if (result.structuredContent.state === 'RUNNING') throw new Error(`Durable job ${jobId} did not reach a terminal state within ${timeoutMs} ms`);
  return result;
}

async function readCancellationEvidence(dataRoot: string, jobId: string, jobRequestId: string, cancelRequestId: string, beforeCancel: Record<string, unknown>, cancelled: Record<string, unknown>, result: Record<string, unknown>) {
  const document = JSON.parse(await readFile(path.join(dataRoot, 'vnext-jobs.json'), 'utf8')) as { jobs: Array<Record<string, unknown>> };
  const job = document.jobs.find((record) => record.jobId === jobId) ?? null;
  const readJson = async (filename: unknown): Promise<unknown> => {
    if (typeof filename !== 'string') return null;
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch { return null; }
  };
  return {
    jobId, jobRequestId, cancelRequestId, beforeCancel, cancelled, result, job,
    process: typeof beforeCancel.pid === 'number' ? observeProcessStart(beforeCancel.pid) : null,
    claim: await readJson(job?.claimPath), runnerResult: await readJson(job?.resultPath),
  };
}

async function expectPathAbsent(filename: string): Promise<void> {
  let exists = true;
  try { await access(filename); } catch { exists = false; }
  expect(exists).toBe(false);
}
