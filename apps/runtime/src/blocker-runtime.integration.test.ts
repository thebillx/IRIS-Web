import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, rename, readFile, writeFile } from 'node:fs/promises';
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
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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

  await writeFile(path.join(projectRoot, 'job.mjs'), "console.log('captured-job'); setTimeout(() => {}, 2500);\n");
  const started = await f.call('shell', { operation: 'start', sessionId, projectId: project.id, workspaceId: workspace.workspaceId, executable: 'node', argv: ['job.mjs'], cwd: '.', executionProfile: 'node-script', envOverrides: {}, timeoutMs: 5000, requestId: randomUUID() });
  expect(started.isError, JSON.stringify(started)).toBe(false);
  const jobId = String(started.structuredContent.jobId);
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
  const cancelled = await f.call('job', { operation: 'cancel', sessionId, projectId: project.id, jobId, requestId: randomUUID() });
  expect(cancelled.isError, JSON.stringify(cancelled)).toBe(false);
  const deadline = Date.now() + 8000;
  let jobResult = await f.call('job', { operation: 'result', sessionId, projectId: project.id, jobId });
  while (jobResult.structuredContent.state === 'RUNNING' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    jobResult = await f.call('job', { operation: 'result', sessionId, projectId: project.id, jobId });
  }
  expect(jobResult.isError).toBe(false);
  expect(jobResult.structuredContent.state).toBe('CANCELLED');
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
