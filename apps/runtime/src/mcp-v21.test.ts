import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { DurableMissionLifecycleService } from './durable-mission-service.js';
import { DurableMissionLifecycleStore } from './durable-mission-store.js';
import { WorkerAdapterRegistry } from './durable-mission-workers.js';
import { handleMcpProRequest, MCP_PROTOCOL_VERSION } from './mcp.js';
import { handleMcpV21Request } from './mcp-v21.js';
import { MissionBrokerService, MissionBrokerStore } from './mission-broker.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { ProjectValidationJobManager } from './project-test.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('IRIS V2.1 Full MCP lifecycle transport', () => {
  it('adds durable lifecycle contracts only to Full MCP while Pro remains exactly the V2.0 five-tool allowlist', async () => {
    const f = await fixture();
    const full = await handleMcpV21Request(rpc('tools/list', 1), f.service, f.state, f.broker, f.lifecycle);
    const fullBody = await full.json() as { result: { tools: Array<{ name: string; inputSchema?: unknown }> } };
    const names = fullBody.result.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'mission_create', 'mission_start', 'mission_checkpoint', 'mission_directive',
      'mission_resume', 'mission_cancel', 'mission_complete', 'mission_evidence',
    ]));
    expect(names.filter((name) => name === 'mission_directive')).toHaveLength(1);

    const identity = await handleMcpV21Request(
      rpc('tools/call', 4, { name: 'catalog_identity', arguments: {} }, 'chatgpt-v21', f.session.id, 'catalog_identity'),
      f.service, f.state, f.broker, f.lifecycle,
    );
    expect(await identity.json()).toMatchObject({ result: { isError: false, structuredContent: { profile: 'FULL', toolCount: names.length, catalogHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) } } });

    const pro = await handleMcpProRequest(rpc('tools/list', 2, undefined, 'chatgpt-pro'), f.service);
    const proBody = await pro.json() as { result: { tools: Array<{ name: string }> } };
    expect(proBody.result.tools.map((tool) => tool.name)).toEqual([
      'list_projects', 'project_info', 'git_status', 'file_read', 'search',
    ]);

    const mutation = await handleMcpProRequest(rpc('tools/call', 3, {
      name: 'file_write', arguments: { projectId: f.project.id, targetPath: path.join(f.project.rootPath, 'must-not-exist.txt'), content: 'blocked' },
    }, 'chatgpt-pro', f.session.id, 'file_write'), f.service);
    expect(await mutation.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'INVALID_REQUEST' } } });
  });

  it('executes create, start, checkpoint, directive, resume with one durable mission id and fail-closed stale revision', async () => {
    const f = await fixture();
    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      const response = await handleMcpV21Request(
        rpc('tools/call', id, { name, arguments: args }, f.session.clientId, f.session.id, name),
        f.service,
        f.state,
        f.broker,
        f.lifecycle,
      );
      return response.json() as Promise<{ result: { isError: boolean; structuredContent: Record<string, unknown> } }>;
    };

    const created = await call(10, 'mission_create', {
      title: 'V2.1 MCP durable mission', goal: 'Continue safely across durable supervisor checkpoints.', orchestratorMode: 'CHATGPT',
    });
    expect(created.result.isError).toBe(false);
    const missionId = String(created.result.structuredContent.id);
    const createdLifecycle = created.result.structuredContent.lifecycle as { missionId: string; projectId: string; state: string; revision: number };
    expect(createdLifecycle).toMatchObject({ missionId, projectId: f.project.id, state: 'CREATED', revision: 1 });

    const started = await call(11, 'mission_start', {
      missionId, expectedRevision: 1, requestId: randomUUID(), workerType: 'IRIS_LOGICAL',
    });
    expect(started.result).toMatchObject({ isError: false, structuredContent: { missionId, state: 'RUNNING', revision: 3 } });

    const checkpointId = randomUUID();
    const checkpointed = await call(12, 'mission_checkpoint', {
      missionId, expectedRevision: 3, checkpointId, summary: 'Durable MCP checkpoint is ready.', evidenceRefs: ['test:mcp-v21'],
    });
    expect(checkpointed.result).toMatchObject({
      isError: false,
      structuredContent: { missionId, state: 'WAITING_FOR_SUPERVISOR', revision: 5 },
    });

    const stale = await call(13, 'mission_directive', {
      missionId, basedOnRevision: 4, directiveId: randomUUID(), directive: 'This must be rejected as stale.',
    });
    expect(stale.result).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_REQUEST' } });

    const directed = await call(14, 'mission_directive', {
      missionId, basedOnRevision: 5, directiveId: randomUUID(), directive: 'Continue the exact same mission safely.',
    });
    expect(directed.result).toMatchObject({ isError: false, structuredContent: { missionId, revision: 6 } });

    const resumeRequestId = randomUUID();
    const resumed = await call(15, 'mission_resume', { missionId, expectedRevision: 6, requestId: resumeRequestId });
    expect(resumed.result).toMatchObject({ isError: false, structuredContent: { missionId, state: 'RUNNING', revision: 8 } });
    const duplicate = await call(16, 'mission_resume', { missionId, expectedRevision: 6, requestId: resumeRequestId });
    expect(duplicate.result).toMatchObject({ isError: false, structuredContent: { missionId, state: 'RUNNING', revision: 8 } });
  });

  it('rebinds a durable mission to one new owner session with CAS and revokes the old session authority', async () => {
    const f = await fixture();
    const mission = await f.state.createMission(f.session.clientId, f.session.id, 'Cross-session mission', 'CHATGPT');
    const replacement = f.state.createSession('chatgpt-session-b', 'chatgpt-direct-orchestrator', 'owner');
    await f.state.setSessionCurrentProject(replacement.id, replacement.clientId, f.project.id);

    const call = async (id: number, session: typeof replacement, name: string, args: Record<string, unknown>) => {
      const response = await handleMcpV21Request(
        rpc('tools/call', id, { name, arguments: args }, session.clientId, session.id, name),
        f.service, f.state, f.broker, f.lifecycle,
      );
      return response.json() as Promise<{ result: { isError: boolean; structuredContent: Record<string, unknown> } }>;
    };

    const rebound = await call(20, replacement, 'mission_rebind', {
      missionId: mission.id, projectId: f.project.id, expectedBindingRevision: 1, reason: 'Continue from a new ChatGPT session',
    });
    expect(rebound.result).toMatchObject({
      isError: false,
      structuredContent: { id: mission.id, clientId: replacement.clientId, sessionId: replacement.id, bindingRevision: 2 },
    });

    const oldAuthority = await call(21, f.session, 'mission_state_set', { missionId: mission.id, state: 'PAUSED' });
    expect(oldAuthority.result).toMatchObject({ isError: true, structuredContent: { code: 'MISSION_SESSION_STALE' } });

    const current = await f.state.getMission(mission.id);
    expect(current).toMatchObject({ id: mission.id, projectId: f.project.id, bindingRevision: 2, sessionId: replacement.id });
    expect(current.rebindAudit).toHaveLength(1);
    expect(current.rebindAudit[0]).toMatchObject({ oldSessionId: f.session.id, newSessionId: replacement.id, result: 'SUCCESS' });
    expect(current.timeline.at(-1)?.kind).toBe('MISSION_SESSION_REBOUND');

    const stale = await call(22, f.session, 'mission_rebind', {
      missionId: mission.id, projectId: f.project.id, expectedBindingRevision: 1,
    });
    expect(stale.result).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_REQUEST' } });

    const tunnelAttempt = await handleMcpV21Request(
      rpc('tools/call', 23, { name: 'mission_rebind', arguments: { missionId: mission.id, projectId: f.project.id, expectedBindingRevision: 2 } }, replacement.clientId, replacement.id, 'mission_rebind'),
      f.service, f.state, f.broker, f.lifecycle, 'tunnel-service',
    );
    expect(await tunnelAttempt.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'CONTROL_DENIED' } } });
  });

  it('allows exactly one winner for concurrent rebind claims and fails closed on project mismatch', async () => {
    const f = await fixture();
    const mission = await f.state.createMission(f.session.clientId, f.session.id, 'Concurrent rebind mission', 'CHATGPT');
    const first = f.state.createSession('chatgpt-session-c', 'chatgpt-direct-orchestrator', 'owner');
    const second = f.state.createSession('chatgpt-session-d', 'chatgpt-direct-orchestrator', 'owner');
    await f.state.setSessionCurrentProject(first.id, first.clientId, f.project.id);
    await f.state.setSessionCurrentProject(second.id, second.clientId, f.project.id);

    const rebind = (id: number, session: typeof first) => handleMcpV21Request(
      rpc('tools/call', id, { name: 'mission_rebind', arguments: { missionId: mission.id, projectId: f.project.id, expectedBindingRevision: 1 } }, session.clientId, session.id, 'mission_rebind'),
      f.service, f.state, f.broker, f.lifecycle,
    ).then((response) => response.json() as Promise<{ result: { isError: boolean; structuredContent: Record<string, unknown> } }>);

    const results = await Promise.all([rebind(30, first), rebind(31, second)]);
    expect(results.filter((result) => !result.result.isError)).toHaveLength(1);
    expect(results.filter((result) => result.result.structuredContent.code === 'INVALID_REQUEST')).toHaveLength(1);
    expect((await f.state.getMission(mission.id)).bindingRevision).toBe(2);

    const wrongProjectRoot = await temp('iris-v21-rebind-wrong-project-');
    const wrongProject = await f.state.registerProject('wrong', wrongProjectRoot);
    const wrong = f.state.createSession('chatgpt-session-e', 'chatgpt-direct-orchestrator', 'owner');
    await f.state.setSessionCurrentProject(wrong.id, wrong.clientId, wrongProject.id);
    const mismatch = await handleMcpV21Request(
      rpc('tools/call', 32, { name: 'mission_rebind', arguments: { missionId: mission.id, projectId: wrongProject.id, expectedBindingRevision: 2 } }, wrong.clientId, wrong.id, 'mission_rebind'),
      f.service, f.state, f.broker, f.lifecycle,
    );
    expect(await mismatch.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } } });
  });

  it('starts a declared validation job through the mission contract and reads it without a session', async () => {
    const f = await fixture();
    await writeFile(path.join(f.project.rootPath, 'package.json'), JSON.stringify({ packageManager: 'npm@11.17.0', scripts: {
      'iris:bounded-validation': "node -e \"process.stdout.write('mcp-validation-ok')\"",
    }}));
    const call = async (id: number, name: string, args: Record<string, unknown>, session = f.session) => {
      const response = await handleMcpV21Request(
        rpc('tools/call', id, { name, arguments: args }, session.clientId, session.id, name),
        f.service, f.state, f.broker, f.lifecycle,
      );
      return response.json() as Promise<{ result: { isError: boolean; structuredContent: Record<string, unknown> } }>;
    };

    const mission = await call(40, 'mission_create', { title: 'Validation job mission', orchestratorMode: 'CHATGPT' });
    const missionId = String(mission.result.structuredContent.id);
    const task = await call(41, 'mission_task_create', { missionId, title: 'Run bounded validation' });
    const taskId = String((task.result.structuredContent.tasks as Array<{ id: string }>)[0]!.id);
    const prepared = await call(42, 'mission_action_prepare', { missionId, taskId, capabilityId: 'project.validation.start', summary: 'Run one declared validation script' });
    const actionId = String(((prepared.result.structuredContent.tasks as Array<{ actions: Array<{ id: string }> }>)[0]!.actions[0]!).id);
    const started = await call(43, 'project_validation_start', {
      missionId, taskId, actionId, scriptName: 'iris:bounded-validation', requestId: 'mcp-validation-request', projectId: f.project.id,
    });
    const jobId = String(started.result.structuredContent.jobId);
    expect(started.result).toMatchObject({ isError: false, structuredContent: { status: 'RUNNING', requestId: 'mcp-validation-request' } });

    let result: { result: { structuredContent: Record<string, unknown> } } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await handleMcpV21Request(
        rpc('tools/call', 44, { name: 'project_validation_job', arguments: { projectId: f.project.id, jobId, view: 'result' } }, f.session.clientId, undefined, 'project_validation_job'),
        f.service, f.state, f.broker, f.lifecycle,
      );
      const current = await response.json() as NonNullable<typeof result>;
      result = current;
      if (current.result.structuredContent.status !== 'RUNNING') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(result?.result.structuredContent).toMatchObject({ status: 'PASSED', result: { passed: true, exitCode: 0 } });
  });
});

function rpc(
  method: string,
  id: number,
  params?: unknown,
  clientId?: string,
  sessionId?: string,
  toolName?: string,
): Request {
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      'Mcp-Method': method,
      ...(toolName === undefined ? {} : { 'Mcp-Name': toolName }),
      ...(clientId === undefined ? {} : { 'x-iris-client-id': clientId }),
      ...(sessionId === undefined ? {} : { 'x-iris-session-id': sessionId }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
  });
}

async function fixture() {
  const sourceRoot = await realpath(await temp('iris-v21-mcp-source-'));
  const dataRoot = await realpath(await temp('iris-v21-mcp-data-'));
  const legacyRoot = await realpath(await temp('iris-v21-mcp-legacy-'));
  const projectRoot = path.join(sourceRoot, 'iris');
  await mkdir(projectRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('iris', projectRoot);
  const session = state.createSession('chatgpt-v21', 'chatgpt-direct-orchestrator', 'owner');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, legacyRoot);
  const audit = new PermissionAuditStore(dataRoot);
  const broker = new MissionBrokerService(state, new MissionBrokerStore(dataRoot));
  const service = new CapabilityService(state, policy, audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1,
    agentExecutorType: 'local-development-executor', productionModelConnected: false,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }), new ProjectValidationJobManager(dataRoot));
  const lifecycle = new DurableMissionLifecycleService(state, new DurableMissionLifecycleStore(dataRoot), new WorkerAdapterRegistry());
  return { dataRoot, state, project, session, broker, service, lifecycle };
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
