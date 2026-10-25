import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectActivationSourceIdentity } from './activation-source-identity.js';
import { bindConnectorRuntime, initializeConnectorRegistry, readConnectorRegistry, type ConnectorRegistryDocument } from './connector-registry.js';
import { loadOrCreateTunnelServiceSecret, persistControlPlaneApiKey } from './credentials.js';
import { runtimeStatus, startRuntime, stopRuntime } from './lifecycle.js';
import { loadOrCreateMachineId } from './machine-identity.js';
import { MCP_PROTOCOL_VERSION } from './mcp.js';
import { fullMcpToolDefinitionsV21 } from './mcp-v21.js';
import { FoundationStateStore, loadOrCreateRuntimeId } from './persistence.js';
import { RuntimeState } from './state.js';
import { createSupervisor, type Supervisor } from './supervisor.js';
import { startSupervisorNativeControlServer, type SupervisorNativeControlHandle, type SupervisorNativeOperations } from './supervisor-native-control.js';

// Keep the production lifecycle implementation; only choose an ephemeral fixture port.
vi.mock('./lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lifecycle.js')>();
  return { ...actual, startRuntime: (options: Parameters<typeof actual.startRuntime>[0] = {}) => actual.startRuntime({ ...options, preferredPort: options.preferredPort ?? 0 }) };
});

const sourceRoot = path.resolve(import.meta.dirname, '../../..');
const evidenceRoot = process.env.IRIS_GATEWAY_EVIDENCE_ROOT ?? path.join(os.tmpdir(), 'iris-blocker-gateway-evidence');
const fixtures: Array<{ root: string; dataRoot: string; supervisor?: Supervisor; gateway?: SupervisorNativeControlHandle; localTransport?: boolean }> = [];
afterEach(async ({ task }) => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const f of fixtures.splice(0)) {
    try {
      if (f.localTransport) await f.supervisor!.down();
      await f.gateway?.close();
      if ((await runtimeStatus(f.dataRoot)).state === 'running') {
        if (f.supervisor !== undefined) await f.supervisor.runtimeOff();
        else await stopRuntime(f.dataRoot, 15_000);
      }
      const observed = await runtimeStatus(f.dataRoot);
      if (observed.state !== 'stopped') throw new Error(`Fixture Runtime remains ${observed.state}`);
      if (task.result?.state === 'fail') {
        await mkdir(evidenceRoot, { recursive: true });
        await writeFile(path.join(evidenceRoot, `${path.basename(f.root)}-failed.json`), JSON.stringify({ root: f.root, dataRoot: f.dataRoot, test: task.name, terminalRuntime: observed.state, cleanup: 'verified; diagnostic files preserved' }, null, 2));
      } else await rm(f.root, { recursive: true, force: true });
    } catch (error) {
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(path.join(evidenceRoot, 'preserved-fixture.json'), JSON.stringify({ root: f.root, dataRoot: f.dataRoot, error: String(error) }, null, 2));
      throw error;
    }
  }
});

async function createGatewayFixture(localTransport = false) {
  vi.stubEnv('IRIS_AGENT_EXECUTOR', 'development');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-blocker-gateway-')));
  const dataRoot = path.join(root, 'data');
  const projectRoot = path.join(root, 'project');
  const protectedRoot = path.join(root, 'protected-reference');
  const projectBRoot = path.join(root, 'project-b');
  for (const directory of [dataRoot, projectRoot, projectBRoot, protectedRoot]) await mkdir(directory, { mode: 0o700 });
  const f: (typeof fixtures)[number] = { root, dataRoot }; fixtures.push(f);
  const runtimeId = await loadOrCreateRuntimeId(dataRoot);
  const machineId = await loadOrCreateMachineId(dataRoot);
  const secret = await loadOrCreateTunnelServiceSecret(dataRoot);
  const ownerSecret = `fixture-owner-${randomUUID()}`;
  await persistControlPlaneApiKey(dataRoot, ownerSecret);
  await initializeConnectorRegistry(dataRoot, { unified: true, fullTunnelId: `tunnel_${'a'.repeat(32)}`, fullHealthPort: await freePort() });
  await bindConnectorRuntime(dataRoot, runtimeId, machineId);
  const preparationState = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await preparationState.registerProject('Gateway fixture', projectRoot);
  const projectB = await preparationState.registerProject('Second selection', projectBRoot);
  await writeFile(path.join(projectRoot, 'job.mjs'), "console.log('gateway-job'); setTimeout(() => {}, 6000);\n");
  const started = await startRuntime({ dataRoot, sourceRoot, preferredPort: 0, protectedReferenceRoot: protectedRoot, startupDeadlineMs: 20_000 });
  expect(started.state).toBe('running');
  expect(started.endpoint?.pid).not.toBe(process.pid);
  const controlPort = await freePort();
  const tunnelClientPath = localTransport ? await writeLocalTunnelClient(root) : undefined;
  const supervisor = await createSupervisor({ ...(tunnelClientPath === undefined ? {} : { tunnelClientPath }), dataRoot, sourceRoot, protectedReferenceRoot: protectedRoot, supervisorControlPort: controlPort, adminPort: await freePort(), adminTunnelHealthPort: await freePort(), webPort: await freePort() });
  f.supervisor = supervisor;
  await supervisor.adoptRuntime();
  const internals = supervisor as unknown as Pick<Required<SupervisorNativeOperations>, 'workloadToolCall' | 'workloadMutationStatus'> & {
    forwardWorkloadTool: Required<SupervisorNativeOperations>['workloadToolCall'];
  };
  const gateway = await startSupervisorNativeControlServer(dataRoot, controlPort, {
    supervisorStatus: () => supervisor.supervisorNativeStatus(), supervisorDoctor: () => supervisor.doctor(),
    runtimeRestart: (requestId) => supervisor.runtimeRestart(requestId),
    runtimeRestartAuthorized: (input) => supervisor.runtimeRestart(input.operationId, input),
    runtimeRestartStatus: (requestId, reconcile) => supervisor.runtimeRestartStatus(requestId, reconcile),
    runtimeStatus: () => supervisor.runtimeStatus(), runtimeOn: () => supervisor.runtimeOn(), runtimeOff: () => supervisor.runtimeOff(),
    listProjects: () => supervisor.listProjects(), projectInfo: (id) => supervisor.projectInfo(id),
    workloadToolDefinitions: fullMcpToolDefinitionsV21,
    workloadToolCall: (name, args, context) => internals.forwardWorkloadTool(name, args, context),
    workloadMutationStatus: (input) => internals.workloadMutationStatus(input),
    adminStatus: () => supervisor.adminNativeStatus(), runtimeReconcile: () => supervisor.runtimeReconcile(),
    adminRecycle: (input) => supervisor.adminRecycle(input), adminTunnelRecycle: (input) => supervisor.adminTunnelRecycle(input), adminToolCall: (name, args) => supervisor.adminToolCall(name, args),
  });
  f.gateway = gateway;
  const call = async (name: string, args: Record<string, unknown>, sessionId?: string, owner = false) => {
    const response = await fetch(gateway.mcpUrl, { method: 'POST', headers: {
      authorization: `Bearer ${owner ? ownerSecret : secret}`, 'content-type': 'application/json', 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      'x-iris-client-id': 'gateway-conversation-owner', ...(sessionId === undefined ? {} : { 'x-iris-session-id': sessionId }),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
    expect(response.status).toBe(200);
    const result = (await response.json() as { result: { isError: boolean; structuredContent: Record<string, unknown> } }).result;
    return result;
  };
  const success = async (name: string, args: Record<string, unknown>, sessionId?: string, owner = false) => {
    const result = await call(name, args, sessionId, owner);
    expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBe(false);
    return result.structuredContent;
  };
  if (localTransport) {
    f.localTransport = true;
    const registry = (await readConnectorRegistry(dataRoot))!;
    const transport = supervisor as unknown as TransportFixtureInternals;
    await transport.withOperationLock('fixture-local-transport', () => transport.startupTransaction(async () => {
      const state = await transport.readState();
      const profiles = await transport.writeManagedProfiles(registry, started.endpoint!.apiUrl);
      await transport.ensureTunnel(state, 'full', registry, profiles.full, null, [], false);
    }));
  }
  return { root, dataRoot, projectRoot, project, projectB, runtimeId, started, supervisor, gateway, call, success };
}

it('forwards authenticated gateway mutations into an adopted real Runtime and reconciles a lost downstream response', async () => {
  const { dataRoot, projectRoot, project, projectB, runtimeId, started, gateway, call, success } = await createGatewayFixture(true);
  await success('runtime_off', {}, undefined, true);
  expect((await success('runtime_status', {})).state).toBe('stopped');
  await success('supervisor_status', {});
  await success('supervisor_doctor', {});
  expect((await call('runtime_on', {})).isError).toBe(true);
  await success('runtime_on', {}, undefined, true);
  let activeEndpoint = (await runtimeStatus(dataRoot)).endpoint!;
  expect(activeEndpoint.instanceId).not.toBe(started.endpoint!.instanceId);
  await success('runtime_status', {});
  const ensure = { conversationId: randomUUID(), requestId: randomUUID() };
  const session = await success('session_open', ensure);
  const sessionId = String(session.sessionId);
  const selected = await success('workspace_select', { sessionId, projectId: project.id, expectedRevision: 1, requestId: randomUUID() }, sessionId);
  const workspaceId = String(selected.currentWorkspaceId);
  const start = { operation: 'start', sessionId, projectId: project.id, workspaceId, executable: 'node', argv: ['job.mjs'], cwd: '.', executionProfile: 'node-script', envOverrides: {}, timeoutMs: 10_000, requestId: randomUUID() };
  const startResponse = await call('shell', start, sessionId);
  let job = startResponse.structuredContent;
  let jobStartReconciled = false;
  if (startResponse.isError) {
    expect(job).toMatchObject({ error: { code: 'AUTHORITY_INDETERMINATE' } });
    const evidenceDeadline = Date.now() + 10_000;
    let downstreamCommitted = false;
    const observations: unknown[] = [];
    while (Date.now() < evidenceDeadline) {
      const status = await call('workload_mutation_status', { operation: 'shell', arguments: start }, sessionId);
      observations.push(status);
      if (status.isError) expect(status.structuredContent).toMatchObject({ error: { code: 'AUTHORITY_INDETERMINATE' } });
      else {
        expect(status.structuredContent.requestId).toBe(start.requestId);
        expect(status.structuredContent.state).toBe('RECONCILIATION_REQUIRED');
        downstreamCommitted = status.structuredContent.downstreamState === 'COMMITTED';
        if (downstreamCommitted) break;
        expect(['PREPARED', 'APPLYING', 'RECONCILIATION_REQUIRED']).toContain(status.structuredContent.downstreamState);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(path.join(evidenceRoot, `job-start-${start.requestId}.json`), JSON.stringify({ requestId: start.requestId, startResponse, observations }, null, 2));
    expect(downstreamCommitted, 'Job admission must have authenticated committed evidence before explicit reconciliation').toBe(true);
    const settled = await success('workload_mutation_status', { operation: 'shell', arguments: { ...start, reconcile: true } }, sessionId);
    expect(settled.state).toBe('COMMITTED');
    const evidence = settled.evidence as { isError: boolean; structuredContent: Record<string, unknown> };
    expect(evidence.isError).toBe(false);
    job = evidence.structuredContent;
    jobStartReconciled = true;
  }
  const durableJobs = JSON.parse(await readFile(path.join(dataRoot, 'vnext-jobs.json'), 'utf8')) as { jobs: Array<{ requestId: string; jobId: string }> };
  const matchingJobs = durableJobs.jobs.filter((record) => record.requestId === start.requestId);
  expect(matchingJobs).toHaveLength(1);
  expect(matchingJobs[0]!.jobId).toBe(job.jobId);
  const jobId = String(job.jobId);
  await success('workspace_select', { sessionId, projectId: projectB.id, expectedRevision: 2, requestId: randomUUID() }, sessionId);
  expect((await success('job', { operation: 'status', sessionId, projectId: project.id, jobId }, sessionId)).state).toBe('RUNNING');
  await success('job', { operation: 'logs', sessionId, projectId: project.id, jobId, stream: 'stdout' }, sessionId);
  const secondSession = await success('session_open', { conversationId: randomUUID(), requestId: randomUUID() });
  const successorId = String(secondSession.sessionId);
  expect(successorId).not.toBe(sessionId);
  expect((await call('job', { operation: 'status', sessionId: successorId, projectId: project.id, jobId }, successorId)).isError).toBe(true);
  const cancel = { operation: 'cancel', sessionId, projectId: project.id, jobId, requestId: randomUUID() };
  expect((await success('job', cancel, sessionId)).cancelRequested).toBe(true);
  let terminal = await success('job', { operation: 'result', sessionId, projectId: project.id, jobId }, sessionId);
  const deadline = Date.now() + 10_000;
  while (terminal.state === 'RUNNING' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    terminal = await success('job', { operation: 'result', sessionId, projectId: project.id, jobId }, sessionId);
  }
  expect(terminal.state).toBe('CANCELLED');
  expect((await success('job', cancel, sessionId)).cancelRequested).toBe(true);
  expect((await success('job', { operation: 'status', sessionId, projectId: project.id, jobId }, sessionId)).state).toBe('CANCELLED');
  await rename(projectB.rootPath, `${projectB.rootPath}.unavailable`);
  try {
    expect((await success('job', cancel, sessionId)).cancelRequested).toBe(true);
    expect((await success('job', { operation: 'status', sessionId, projectId: project.id, jobId }, sessionId)).state).toBe('CANCELLED');
    await rename(projectRoot, `${projectRoot}.unavailable`);
    try {
      expect((await call('job', cancel, sessionId)).isError).toBe(true);
      expect((await call('job', { operation: 'status', sessionId, projectId: project.id, jobId }, sessionId)).isError).toBe(true);
    } finally { await rename(`${projectRoot}.unavailable`, projectRoot); }
  } finally { await rename(`${projectB.rootPath}.unavailable`, projectB.rootPath); }
  await success('workspace_select', { sessionId, projectId: project.id, expectedRevision: 3, requestId: randomUUID() }, sessionId);
  const detached = { sessionId, expectedRevision: 4, requestId: randomUUID() };
  await success('session_detach', detached, sessionId);
  expect((await call('job', { operation: 'status', sessionId, projectId: project.id, jobId }, sessionId)).isError).toBe(true);
  await success('runtime_off', {}, undefined, true);
  await success('supervisor_doctor', {});
  await success('runtime_on', {}, undefined, true);
  activeEndpoint = (await runtimeStatus(dataRoot)).endpoint!;
  const resumed = await success('session_resume', { sessionId, expectedRevision: 5, requestId: randomUUID() }, sessionId);
  expect(resumed.currentProjectId).toBe(project.id);
  expect(resumed.id).toBe(sessionId);
  const mission = await success('mission_create', { sessionId, title: 'Gateway logical handoff', orchestratorMode: 'HERMES', requestId: randomUUID() }, sessionId);
  const missionId = String(mission.id);
  const handoff = { sessionId, missionId, targetMode: 'CHATGPT', expectedVersion: 1, handoffId: randomUUID() };
  expect((await success('mission_orchestrator_handoff', handoff, sessionId)).orchestratorVersion).toBe(2);
  expect((await success('mission_orchestrator_handoff', handoff, sessionId)).orchestratorVersion).toBe(2);
  expect((await call('mission_orchestrator_handoff', { ...handoff, handoffId: randomUUID(), targetMode: 'HERMES' }, sessionId)).isError).toBe(true);
  await success('mission_start', { sessionId, missionId, workerType: 'IRIS_LOGICAL', expectedRevision: 1, requestId: randomUUID() }, sessionId);
  await success('mission_checkpoint', { sessionId, missionId, expectedRevision: 3, checkpointId: randomUUID(), summary: 'Logical checkpoint through gateway', evidenceRefs: ['fixture:gateway'] }, sessionId);
  await success('mission_directive', { sessionId, missionId, basedOnRevision: 5, directiveId: randomUUID(), directive: 'Continue this logical worker' }, sessionId);
  await success('mission_resume', { sessionId, missionId, expectedRevision: 6, requestId: randomUUID() }, sessionId);
  await success('workspace_select', { sessionId: successorId, projectId: project.id, expectedRevision: 1, requestId: randomUUID() }, successorId);
  expect((await success('mission_rebind', { sessionId: successorId, missionId, projectId: project.id, expectedBindingRevision: 1, requestId: randomUUID() }, successorId)).sessionId).toBe(successorId);
  expect((await call('mission_checkpoint', { sessionId, missionId, expectedRevision: 8, checkpointId: randomUUID(), summary: 'Stale controller', evidenceRefs: [] }, sessionId)).isError).toBe(true);
  const write = { operation: 'write', sessionId, projectId: project.id, workspaceId, path: 'gateway-proof.txt', content: 'one effect', writeMode: 'CREATE', requestId: randomUUID() };
  const actualFetch = globalThis.fetch;
  let dropped = false;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await actualFetch(input, init);
    if (!dropped && String(input) === `${activeEndpoint.apiUrl}/mcp` && typeof init?.body === 'string' && JSON.parse(init.body).params?.name === 'fs') {
      dropped = true;
      await response.arrayBuffer();
      throw new TypeError('Fixture lost response after real downstream execution');
    }
    return response;
  });
  const uncertain = await call('fs', write, sessionId);
  vi.unstubAllGlobals();
  expect(dropped).toBe(true);
  expect(uncertain.isError).toBe(true);
  expect(await readFile(path.join(projectRoot, 'gateway-proof.txt'), 'utf8')).toBe('one effect');
  const unresolved = await success('workload_mutation_status', { operation: 'fs', arguments: write }, sessionId);
  expect(unresolved.state).toBe('RECONCILIATION_REQUIRED');
  const reconciled = await success('workload_mutation_status', { operation: 'fs', arguments: { ...write, reconcile: true } }, sessionId);
  expect(reconciled.state).toBe('COMMITTED');
  await writeFile(path.join(projectRoot, 'gateway-proof.txt'), 'external marker');
  await success('fs', write, sessionId);
  expect(await readFile(path.join(projectRoot, 'gateway-proof.txt'), 'utf8')).toBe('external marker');
  const journalPath = path.join(dataRoot, 'supervisor', 'vnext-mutations', `${createHash('sha256').update(write.requestId).digest('hex')}.json`);
  expect(JSON.parse(await readFile(journalPath, 'utf8')).state).toBe('COMMITTED');
  await success('session_detach', { sessionId, expectedRevision: 6, requestId: randomUUID() }, sessionId);
  expect((await call('fs', write, sessionId)).isError).toBe(true);
  await success('session_resume', { sessionId, expectedRevision: 7, requestId: randomUUID() }, sessionId);
  await success('fs', write, sessionId);
  const close = { sessionId, expectedRevision: 8, requestId: randomUUID() };
  await success('session_close', close, sessionId);
  await success('session_close', close, sessionId);
  expect((await call('fs', write, sessionId)).isError).toBe(true);
  expect((await call('session_open', ensure)).isError).toBe(true);
  await success('runtime_off', {}, undefined, true);
  expect((await success('runtime_status', {})).state).toBe('stopped');
  await success('supervisor_status', {});
  await success('supervisor_doctor', {});
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(path.join(evidenceRoot, 'gateway-positive.json'), JSON.stringify({ sourceRoot, runtimeId, initialInstance: started.endpoint?.instanceId, replacementInstance: activeEndpoint.instanceId, runtimePid: activeEndpoint.pid, sessionId, successorId, jobId, jobStartRequestId: start.requestId, jobStartReconciled, missionId, lostResponseRequestId: write.requestId, gatewayPort: gateway.port, terminalRuntime: (await runtimeStatus(dataRoot)).state, transport: 'authenticated localhost fixture; no public tunnel created', noMutationReplay: true, sourceCleanlinessClaimed: false }, null, 2));
}, 90_000);


it('restarts only the workload through a paired owner-authorized native request and preserves the ONE transport', async () => {
  // This authority proof deliberately requires committed source, including this fixture.
  const source = await inspectActivationSourceIdentity(sourceRoot);
  expect(source.trackedModifiedCount, 'Commit the coherent integration source before exercising lifecycle grants').toBe(0);
  const { dataRoot, project, started, supervisor, gateway, call, success } = await createGatewayFixture(true);
  const transport = supervisor as unknown as TransportFixtureInternals;
  const before = (await transport.readState()).tunnels.full!;
  const session = await success('session_open', { conversationId: randomUUID(), requestId: randomUUID() });
  const sessionId = String(session.sessionId);
  await success('workspace_select', { sessionId, projectId: project.id, expectedRevision: 1, requestId: randomUUID() }, sessionId);
  expect((await call('runtime_restart', { requestId: randomUUID() })).isError).toBe(true);
  const requestId = randomUUID();
  const receipt = await success('runtime_restart', { requestId }, undefined, true);
  expect(receipt.state).toBe('RUNNING');
  expect(receipt.phase).toBe('COMPLETE');
  const replacement = (await runtimeStatus(dataRoot)).endpoint!;
  expect(replacement.instanceId).not.toBe(started.endpoint!.instanceId);
  expect(replacement.pid).not.toBe(started.endpoint!.pid);
  expect((await transport.readState()).tunnels.full).toEqual(before);
  expect((await success('session_get', { sessionId }, sessionId)).currentProjectId).toBe(project.id);
  expect(await success('runtime_restart', { requestId }, undefined, true)).toEqual(receipt);
  expect((await runtimeStatus(dataRoot)).endpoint!.instanceId).toBe(replacement.instanceId);
  expect(await success('runtime_restart_status', { requestId }, undefined, true)).toEqual(receipt);
  await success('runtime_off', {}, undefined, true);
  expect((await success('runtime_status', {})).state).toBe('stopped');
  await success('supervisor_doctor', {});
  expect((await transport.readState()).tunnels.full).toEqual(before);
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(path.join(evidenceRoot, 'gateway-restart-positive.json'), JSON.stringify({ source, requestId, receipt, initialInstance: started.endpoint!.instanceId, replacementInstance: replacement.instanceId, transportPid: before.pid, gatewayPort: gateway.port, terminalRuntime: 'stopped', transport: 'locally owned health listener; no public route created', retryCreatedNoRuntime: true }, null, 2));
}, 90_000);

type TransportFixtureState = { tunnels: { full: { pid: number; profileDigest: string } | null } };
interface TransportFixtureInternals {
  withOperationLock<T>(operation: string, work: () => Promise<T>): Promise<T>;
  startupTransaction<T>(work: () => Promise<T>): Promise<T>;
  readState(): Promise<TransportFixtureState>;
  writeManagedProfiles(registry: ConnectorRegistryDocument, runtimeApiUrl: string): Promise<{ full: string }>;
  ensureTunnel(state: TransportFixtureState, profile: 'full', registry: ConnectorRegistryDocument, profilePath: string, runtimeInstance: null, started: string[], runtimeReplaced: boolean): Promise<unknown>;
}

async function writeLocalTunnelClient(root: string): Promise<string> {
  const executable = path.join(root, 'tunnel-client-local-fixture.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] === 'health') {
  const origin = 'http://127.0.0.1:' + option('--port');
  const healthz = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(800) }).then(r => ({ ok: r.ok }));
  const readyz = await fetch(origin + '/readyz', { signal: AbortSignal.timeout(800) }).then(r => ({ ok: r.ok }));
  console.log(JSON.stringify({ result: healthz.ok && readyz.ok ? 'ok' : 'error', healthz, readyz }));
} else if (args[0] === 'run') {
  const profile = readFileSync(option('--profile-file'), 'utf8');
  const port = Number(profile.match(/listen_addr:.*127\\.0\\.0\\.1:(\\d+)/)?.[1]);
  if (!Number.isInteger(port) || port <= 0) throw new Error('Missing loopback health port');
  const server = createServer((req, res) => { res.writeHead(['/healthz', '/readyz'].includes(req.url) ? 200 : 404); res.end(); });
  server.listen(port, '127.0.0.1');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} else throw new Error('Unsupported fixture command');
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
