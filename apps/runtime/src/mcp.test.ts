import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { handleMcpProRequest, handleMcpRequest, MCP_PROTOCOL_VERSION } from './mcp.js';
import { MissionBrokerService, MissionBrokerStore } from './mission-broker.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('local MCP transport and permission boundary', () => {
  it('exposes only the dedicated sessionless read tools on the Pro endpoint', async () => {
    const fixture = await serviceFixture();
    await Promise.all([
      writeFile(path.join(fixture.projectRoot, 'README.md'), 'IRIS_PRO_TOKEN project-a\n', 'utf8'),
      execFileAsync('/usr/bin/git', ['init'], { cwd: fixture.projectRoot }),
    ]);
    const call = (id: number, name: string, args: Record<string, unknown>, clientId = 'chatgpt-pro') => handleMcpProRequest(
      rpc('tools/call', id, { name, arguments: args }, true, name, clientId, fixture.session.id), fixture.service,
    );

    const discovered = await handleMcpProRequest(rpc('server/discover', 1, undefined, false), fixture.service);
    expect(discovered.status).toBe(200);
    expect(await discovered.json()).toEqual({
      jsonrpc: '2.0', id: 1, result: {
        resultType: 'complete',
        supportedVersions: [MCP_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'IRIS Pro Read Only', version: '0.0.0' } },
      },
    });
    const listed = await handleMcpProRequest(rpc('tools/list', 2), fixture.service);
    const listedBody = await listed.json() as { result: { tools: Array<{ name: string }> } };
    expect(listedBody.result.tools.map((tool) => tool.name)).toEqual(['list_projects', 'project_info', 'git_status', 'file_read', 'search']);

    expect(await (await call(3, 'list_projects', {})).json()).toMatchObject({ result: { isError: false } });
    expect(await (await call(4, 'project_info', { projectId: fixture.project.id })).json()).toMatchObject({ result: { isError: false, structuredContent: { id: fixture.project.id } } });
    expect(await (await call(5, 'git_status', { projectId: fixture.project.id })).json()).toMatchObject({ result: { isError: false } });
    expect(await (await call(6, 'file_read', { projectId: fixture.project.id, targetPath: 'README.md' })).json()).toMatchObject({ result: { isError: false, structuredContent: { content: 'IRIS_PRO_TOKEN project-a\n' } } });
    expect(await (await call(7, 'search', { projectId: fixture.project.id, query: 'IRIS_PRO_TOKEN' })).json()).toMatchObject({ result: { isError: false, structuredContent: { matches: [{ path: 'README.md' }] } } });

    for (const name of [
      'runtime_status', 'mission_list', 'session_open', 'session_get', 'session_close', 'workspace_select',
      'mission_list_waiting_supervisor', 'mission_get', 'mission_events', 'mission_directive',
      'mission_orchestrator_handoff', 'mission_create', 'mission_state_set', 'mission_task_create',
      'mission_task_state_set', 'mission_action_prepare', 'mission_supervisor_gate_set', 'project_test_run',
      'project_validation_run', 'git_local', 'remote_publish', 'file_write', 'file_delete', 'directory_create', 'directory_delete',
    ]) {
      expect(await (await call(10, name, {})).json()).toMatchObject({
        result: { isError: true, structuredContent: { code: 'INVALID_REQUEST', message: `Unknown tool: ${name}` } },
      });
    }
    expect(await (await call(11, 'list_projects', {}, '')).json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'INVALID_REQUEST', message: 'x-iris-client-id is required' } } });
  });

  it('discovers the stateless endpoint and routes informational tools through the capability service', async () => {
    const fixture = await serviceFixture();
    const discovered = await handleMcpRequest(rpc('server/discover', 1, undefined, false), fixture.service);
    expect(discovered.status).toBe(200);
    expect(await discovered.json()).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSION } });

    const tunnelDiscovered = await handleMcpRequest(rpc('server/discover', 4, undefined, false), fixture.service, undefined, undefined, 'tunnel-service');
    expect(await tunnelDiscovered.json()).toMatchObject({
      result: { resultType: 'complete', supportedVersions: [MCP_PROTOCOL_VERSION], _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'IRIS' } } },
    });

    const listed = await handleMcpRequest(rpc('tools/list', 2), fixture.service);
    const listedBody = await listed.json() as { result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> } };
    expect(listedBody.result.tools.map((tool) => tool.name)).toEqual([
      'runtime_status', 'list_projects', 'project_info', 'git_status', 'search', 'mission_list', 'session_open', 'session_get', 'session_close', 'workspace_select', 'mission_list_waiting_supervisor', 'mission_get', 'mission_events', 'mission_directive', 'mission_orchestrator_handoff', 'mission_create', 'mission_state_set', 'mission_task_create', 'mission_task_state_set', 'mission_action_prepare', 'mission_supervisor_gate_set', 'project_test_run', 'project_validation_run', 'git_local', 'remote_publish', 'file_read', 'file_write', 'file_delete', 'directory_create', 'directory_delete',
    ]);
    expect(listedBody.result.tools.find((tool) => tool.name === 'session_open')?.inputSchema.required).toBeUndefined();

    const status = await handleMcpRequest(rpc('tools/call', 3, { name: 'runtime_status', arguments: {} }, true, 'runtime_status'), fixture.service);
    expect(await status.json()).toMatchObject({ result: { isError: false, structuredContent: { status: 'ready' } } });
    expect((await fixture.audit.recent(10)).some((event) => event.capabilityId === 'runtime.status' && event.result === 'SUCCESS')).toBe(true);
  });

  it('supports explicit registered-project reads without creating or sharing a session', async () => {
    const fixture = await serviceFixture();
    const secondRoot = path.join(fixture.sourceRoot, 'pro-second-project');
    await mkdir(secondRoot);
    const secondProject = await fixture.state.registerProject('Pro Second', secondRoot);
    const sessionsBeforeReads = fixture.state.listSessions();
    await Promise.all([
      writeFile(path.join(fixture.projectRoot, 'README.md'), 'IRIS_PRO_TOKEN project-a\n', 'utf8'),
      writeFile(path.join(secondRoot, 'README.md'), 'IRIS_PRO_TOKEN project-b\n', 'utf8'),
      execFileAsync('/usr/bin/git', ['init'], { cwd: fixture.projectRoot }),
      execFileAsync('/usr/bin/git', ['init'], { cwd: secondRoot }),
    ]);
    const call = (id: number, name: string, args: Record<string, unknown>) => handleMcpRequest(
      rpc('tools/call', id, { name, arguments: args }, true, name, 'chatgpt'), fixture.service, fixture.state,
    );

    const projects = await call(50, 'list_projects', {});
    expect(await projects.json()).toMatchObject({ result: { isError: false } });
    const info = await call(51, 'project_info', { projectId: fixture.project.id });
    expect(await info.json()).toMatchObject({ result: { isError: false, structuredContent: { id: fixture.project.id, name: 'Project' } } });
    const git = await call(52, 'git_status', { projectId: fixture.project.id });
    expect(await git.json()).toMatchObject({ result: { isError: false, structuredContent: { branch: expect.any(String), clean: false } } });
    const readA = await call(53, 'file_read', { projectId: fixture.project.id, targetPath: 'README.md' });
    expect(await readA.json()).toMatchObject({ result: { isError: false, structuredContent: { content: 'IRIS_PRO_TOKEN project-a\n' } } });
    const readB = await call(54, 'file_read', { projectId: secondProject.id, targetPath: 'README.md' });
    expect(await readB.json()).toMatchObject({ result: { isError: false, structuredContent: { content: 'IRIS_PRO_TOKEN project-b\n' } } });
    const search = await call(55, 'search', { projectId: secondProject.id, query: 'IRIS_PRO_TOKEN' });
    expect(await search.json()).toMatchObject({ result: { isError: false, structuredContent: { matches: [{ path: 'README.md', line: 1, text: 'IRIS_PRO_TOKEN project-b' }], truncated: false } } });
    expect(fixture.state.listSessions()).toEqual(sessionsBeforeReads);

    for (const [id, name, args] of [
      [56, 'project_info', {}], [57, 'git_status', {}], [58, 'file_read', { targetPath: 'README.md' }], [59, 'search', { query: 'token' }],
    ] as const) {
      const missing = await call(id, name, args);
      expect(await missing.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'INVALID_REQUEST', message: expect.stringContaining('projectId') } } });
    }
    const unknown = await call(60, 'file_read', { projectId: randomUUID(), targetPath: 'README.md' });
    expect(await unknown.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } } });
    const outside = await temp('iris-pro-read-outside-');
    const outsidePath = path.join(outside, 'secret.txt');
    await writeFile(outsidePath, 'outside', 'utf8');
    const traversal = await call(61, 'file_read', { projectId: fixture.project.id, targetPath: '../outside.txt' });
    expect(await traversal.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } } });
    const arbitraryRoot = await call(62, 'file_read', { projectId: randomUUID(), rootPath: outside, targetPath: outsidePath });
    expect(await arbitraryRoot.json()).toMatchObject({ result: { isError: true } });
    const sessionlessWrite = await call(63, 'file_write', { projectId: fixture.project.id, targetPath: 'blocked.txt', content: 'blocked' });
    expect(await sessionlessWrite.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'INVALID_REQUEST' } } });
    await expect(access(path.join(fixture.projectRoot, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exposes ChatGPT-direct mission contracts while keeping governed execution in CapabilityService', async () => {
    const fixture = await serviceFixture();
    const create = await handleMcpRequest(rpc('tools/call', 10, {
      name: 'mission_create', arguments: { title: 'ChatGPT bounded mission', orchestratorMode: 'CHATGPT' },
    }, true, 'mission_create', fixture.session.clientId, fixture.session.id), fixture.service, fixture.state, fixture.broker);
    const createdBody = await create.json() as { result: { structuredContent: { id: string } } };
    const missionId = createdBody.result.structuredContent.id;

    const task = await handleMcpRequest(rpc('tools/call', 11, {
      name: 'mission_task_create', arguments: { missionId, title: 'Write governed evidence' },
    }, true, 'mission_task_create', fixture.session.clientId, fixture.session.id), fixture.service, fixture.state, fixture.broker);
    const taskBody = await task.json() as { result: { structuredContent: { tasks: Array<{ id: string }> } } };
    const taskId = taskBody.result.structuredContent.tasks[0]!.id;

    const prepared = await handleMcpRequest(rpc('tools/call', 12, {
      name: 'mission_action_prepare', arguments: { missionId, taskId, capabilityId: 'file.write', summary: 'Write one bounded file' },
    }, true, 'mission_action_prepare', fixture.session.clientId, fixture.session.id), fixture.service, fixture.state, fixture.broker);
    const preparedBody = await prepared.json() as { result: { structuredContent: { tasks: Array<{ actions: Array<{ id: string }> }> } } };
    const actionId = preparedBody.result.structuredContent.tasks[0]!.actions[0]!.id;

    const targetPath = path.join(fixture.projectRoot, 'hermes-mission.txt');
    const executed = await handleMcpRequest(rpc('tools/call', 13, {
      name: 'file_write', arguments: { projectId: fixture.project.id, targetPath, content: 'mission-evidence', missionId, taskId, actionId },
    }, true, 'file_write', fixture.session.clientId, fixture.session.id), fixture.service, fixture.state, fixture.broker);
    expect(await executed.json()).toMatchObject({ result: { isError: false, structuredContent: { targetPath, bytes: 16 } } });

    const readMission = await handleMcpRequest(rpc('tools/call', 14, {
      name: 'mission_get', arguments: { missionId },
    }, true, 'mission_get'), fixture.service);
    const missionBody = await readMission.json() as { result: { structuredContent: { tasks: Array<{ actions: Array<{ state: string; result: { evidence: unknown[] } }> }> } } };
    expect(missionBody.result.structuredContent.tasks[0]!.actions[0]).toMatchObject({ state: 'SUCCEEDED', result: { evidence: [expect.objectContaining({ kind: 'CAPABILITY_RESULT' })] } });
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('mission-evidence');
  });

  it('bootstraps runtime sessions and keeps argument-based project contexts isolated', async () => {
    const fixture = await serviceFixture();
    const secondRoot = path.join(fixture.sourceRoot, 'second-project');
    await mkdir(secondRoot);
    const secondProject = await fixture.state.registerProject('Second Project', secondRoot);

    const missingClient = await handleMcpRequest(rpc('tools/call', 30, {
      name: 'session_open', arguments: {},
    }, true, 'session_open'), fixture.service, fixture.state);
    expect(await missingClient.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'INVALID_REQUEST', message: 'x-iris-client-id is required' } } });

    const open = async (id: number, clientId = 'chatgpt') => {
      const response = await handleMcpRequest(rpc('tools/call', id, {
        name: 'session_open', arguments: {},
      }, true, 'session_open', clientId), fixture.service, fixture.state);
      const body = await response.json() as { result: { isError: boolean; structuredContent: { sessionId: string; clientId: string; currentProjectId: null } } };
      expect(body.result).toMatchObject({ isError: false, structuredContent: { clientId, currentProjectId: null } });
      expect(body.result.structuredContent.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(fixture.state.getSessionForClient(body.result.structuredContent.sessionId, clientId)).toMatchObject({ clientId, agentId: 'chatgpt', agentRole: 'owner' });
      return body.result.structuredContent.sessionId;
    };
    const sessionA = await open(31);
    const sessionB = await open(32);
    const otherClientSession = await open(33, 'other-client');

    const listed = await handleMcpRequest(rpc('tools/call', 34, {
      name: 'list_projects', arguments: {},
    }, true, 'list_projects', 'chatgpt'), fixture.service, fixture.state);
    const listedBody = await listed.json() as { result: { isError: boolean; structuredContent: { projects: Array<{ id: string }> } } };
    expect(listedBody.result.isError).toBe(false);
    expect(listedBody.result.structuredContent.projects.map((project) => project.id)).toEqual(expect.arrayContaining([fixture.project.id, secondProject.id]));

    const select = async (id: number, sessionId: string, projectId: string) => handleMcpRequest(rpc('tools/call', id, {
      name: 'workspace_select', arguments: { sessionId, projectId },
    }, true, 'workspace_select', 'chatgpt'), fixture.service, fixture.state);
    expect(await (await select(35, sessionA, fixture.project.id)).json()).toMatchObject({ result: { isError: false, structuredContent: { currentProjectId: fixture.project.id } } });
    expect(await (await select(36, sessionB, secondProject.id)).json()).toMatchObject({ result: { isError: false, structuredContent: { currentProjectId: secondProject.id } } });
    expect(fixture.state.getSessionForClient(sessionA, 'chatgpt').currentProjectId).toBe(fixture.project.id);
    expect(fixture.state.getSessionForClient(sessionB, 'chatgpt').currentProjectId).toBe(secondProject.id);

    const argumentPath = path.join(fixture.projectRoot, 'argument.txt');
    const headerPath = path.join(fixture.projectRoot, 'header.txt');
    await writeFile(argumentPath, 'argument-session', 'utf8');
    await writeFile(headerPath, 'header-session', 'utf8');
    const argumentRead = await handleMcpRequest(rpc('tools/call', 37, {
      name: 'file_read', arguments: { sessionId: sessionA, targetPath: argumentPath },
    }, true, 'file_read', 'chatgpt'), fixture.service, fixture.state);
    expect(await argumentRead.json()).toMatchObject({ result: { isError: false, structuredContent: { content: 'argument-session' } } });
    const headerRead = await handleMcpRequest(rpc('tools/call', 38, {
      name: 'file_read', arguments: { targetPath: headerPath },
    }, true, 'file_read', 'chatgpt', sessionA), fixture.service, fixture.state);
    expect(await headerRead.json()).toMatchObject({ result: { isError: false, structuredContent: { content: 'header-session' } } });

    const mismatch = await handleMcpRequest(rpc('tools/call', 39, {
      name: 'session_get', arguments: { sessionId: sessionA },
    }, true, 'session_get', 'chatgpt', sessionB), fixture.service, fixture.state);
    expect(await mismatch.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'CONTROL_DENIED' } } });
    const missing = await handleMcpRequest(rpc('tools/call', 40, {
      name: 'session_get', arguments: {},
    }, true, 'session_get', 'chatgpt'), fixture.service, fixture.state);
    expect(await missing.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'INVALID_REQUEST', message: expect.stringContaining('call session_open first') } } });
    const nonexistent = await handleMcpRequest(rpc('tools/call', 41, {
      name: 'session_get', arguments: { sessionId: randomUUID() },
    }, true, 'session_get', 'chatgpt'), fixture.service, fixture.state);
    expect(await nonexistent.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'SESSION_NOT_FOUND' } } });
    const crossClient = await handleMcpRequest(rpc('tools/call', 42, {
      name: 'session_get', arguments: { sessionId: otherClientSession },
    }, true, 'session_get', 'chatgpt'), fixture.service, fixture.state);
    expect(await crossClient.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'CONTROL_DENIED' } } });
  });

  it('rejects ChatGPT operational mission mutation while HERMES is active and allows safe supervisor handoff', async () => {
    const fixture = await serviceFixture();
    const mission = await fixture.state.createMission(fixture.session.clientId, fixture.session.id, 'Hermes-owned mission');
    const rejected = await handleMcpRequest(rpc('tools/call', 15, {
      name: 'mission_task_create', arguments: { missionId: mission.id, title: 'Must not run from ChatGPT transport' },
    }, true, 'mission_task_create', fixture.session.clientId, fixture.session.id), fixture.service, fixture.state, fixture.broker);
    expect(await rejected.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } } });
    expect((await fixture.state.getMission(mission.id)).tasks).toHaveLength(0);

    const handoffId = randomUUID();
    const handed = await handleMcpRequest(rpc('tools/call', 16, {
      name: 'mission_orchestrator_handoff', arguments: { missionId: mission.id, targetMode: 'CHATGPT', expectedVersion: 1, handoffId },
    }, true, 'mission_orchestrator_handoff'), fixture.service, fixture.state, fixture.broker);
    expect(await handed.json()).toMatchObject({ result: { isError: false, structuredContent: { orchestratorMode: 'CHATGPT', orchestratorVersion: 2 } } });
    const task = await handleMcpRequest(rpc('tools/call', 17, {
      name: 'mission_task_create', arguments: { missionId: mission.id, title: 'Now ChatGPT may orchestrate' },
    }, true, 'mission_task_create', fixture.session.clientId, fixture.session.id), fixture.service, fixture.state, fixture.broker);
    expect(await task.json()).toMatchObject({ result: { isError: false, structuredContent: { tasks: [{ title: 'Now ChatGPT may orchestrate' }] } } });
  });

  it('exposes pull-based supervisor checkpoint state and versioned directives without changing permission authority', async () => {
    const fixture = await serviceFixture();
    const mission = await fixture.state.createMission(fixture.session.clientId, fixture.session.id, 'Supervisor pull mission');
    await fixture.broker.bindHermesSession({ missionId: mission.id, hermesSessionId: '20260905_210000_supervisor', worktreePath: fixture.project.rootPath, branch: 'proof' });
    const firstDirective = {
      missionId: mission.id,
      expectedVersion: 1,
      directiveId: randomUUID(),
      directiveSequence: 1,
      decision: 'CONTINUE' as const,
      instruction: 'Produce one bounded supervisor checkpoint.',
      authorizedScope: ['read-only proof'],
      doNot: ['do not mutate'],
      successCriteria: ['checkpoint recorded'],
    };
    const accepted = await fixture.broker.acceptDirective(firstDirective);
    const checkpointId = randomUUID();
    await fixture.broker.recordCheckpoint({
      checkpointId,
      missionId: mission.id,
      missionVersion: accepted.missionVersion,
      state: 'WAITING_SUPERVISOR',
      currentPhase: 'review',
      summary: 'Governed proof is ready for supervisor review.',
      evidenceRefs: ['project_git_status:clean'],
      blockers: [],
      hermesAssessment: 'Ready for next supervisor decision.',
      proposedNextAction: 'Continue the same Hermes mission.',
      decisionRequired: true,
      createdAt: new Date().toISOString(),
    });
    const beforePermissions = await fixture.settings.read();

    const waiting = await handleMcpRequest(rpc('tools/call', 20, { name: 'mission_list_waiting_supervisor', arguments: {} }, true, 'mission_list_waiting_supervisor'), fixture.service, fixture.state, fixture.broker);
    expect(await waiting.json()).toMatchObject({ result: { isError: false, structuredContent: { missions: [{ mission: { id: mission.id }, broker: { state: 'AWAITING_SUPERVISOR', missionVersion: 2 }, checkpoint: { checkpointId } }] } } });

    const get = await handleMcpRequest(rpc('tools/call', 21, { name: 'mission_get', arguments: { missionId: mission.id } }, true, 'mission_get'), fixture.service, fixture.state, fixture.broker);
    expect(await get.json()).toMatchObject({ result: { isError: false, structuredContent: { id: mission.id, broker: { hermesSessionId: '20260905_210000_supervisor', lastCheckpointId: checkpointId } } } });

    const events = await handleMcpRequest(rpc('tools/call', 22, { name: 'mission_events', arguments: { missionId: mission.id } }, true, 'mission_events'), fixture.service, fixture.state, fixture.broker);
    const eventsBody = await events.json() as { result: { structuredContent: { events: Array<{ type: string }> } } };
    expect(eventsBody.result.structuredContent.events.map((event) => event.type)).toContain('SUPERVISOR_CHECKPOINT');
    expect(eventsBody.result.structuredContent.events.map((event) => event.type)).toContain('SUPERVISOR_DIRECTIVE');

    const secondDirective = {
      missionId: mission.id,
      expectedVersion: 2,
      directiveId: randomUUID(),
      directiveSequence: 2,
      decision: 'CONTINUE',
      instruction: 'Resume the exact same Hermes mission.',
      authorizedScope: ['same mission only'],
      doNot: ['do not grant local permission'],
      successCriteria: ['same session resumes'],
    };
    const directiveResponse = await handleMcpRequest(rpc('tools/call', 23, { name: 'mission_directive', arguments: secondDirective }, true, 'mission_directive'), fixture.service, fixture.state, fixture.broker);
    expect(await directiveResponse.json()).toMatchObject({ result: { isError: false, structuredContent: { missionVersion: 3, lastDirectiveSequence: 2, lastDirectiveId: secondDirective.directiveId } } });
    const duplicate = await handleMcpRequest(rpc('tools/call', 24, { name: 'mission_directive', arguments: secondDirective }, true, 'mission_directive'), fixture.service, fixture.state, fixture.broker);
    expect(await duplicate.json()).toMatchObject({ result: { isError: false, structuredContent: { missionVersion: 3, lastDirectiveSequence: 2 } } });
    const stale = await handleMcpRequest(rpc('tools/call', 25, { name: 'mission_directive', arguments: { ...secondDirective, directiveId: randomUUID(), directiveSequence: 3, expectedVersion: 2 } }, true, 'mission_directive'), fixture.service, fixture.state, fixture.broker);
    expect(await stale.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'INVALID_REQUEST' } } });

    expect(await fixture.settings.read()).toEqual(beforePermissions);
    expect(fixture.service.listPendingApprovals()).toHaveLength(0);
  });

  it('cannot bypass session/project policy for file mutation', async () => {
    const fixture = await serviceFixture();
    const validTarget = path.join(fixture.projectRoot, 'mcp.txt');
    const valid = await handleMcpRequest(rpc('tools/call', 1, {
      name: 'file_write', arguments: { projectId: fixture.project.id, targetPath: validTarget, content: 'mcp-ok' },
    }, true, 'file_write', fixture.session.clientId, fixture.session.id), fixture.service, fixture.state);
    expect(await valid.json()).toMatchObject({ result: { isError: false } });
    await expect(readFile(validTarget, 'utf8')).resolves.toBe('mcp-ok');

    const outside = await temp('iris-mcp-outside-');
    const outsideTarget = path.join(outside, 'blocked.txt');
    const denied = await handleMcpRequest(rpc('tools/call', 2, {
      name: 'file_write', arguments: { projectId: fixture.project.id, targetPath: outsideTarget, content: 'must-not-run' },
    }, true, 'file_write', fixture.session.clientId, fixture.session.id), fixture.service, fixture.state);
    expect(await denied.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } } });
    await expect(access(outsideTarget)).rejects.toMatchObject({ code: 'ENOENT' });

    const wrongSession = await handleMcpRequest(rpc('tools/call', 3, {
      name: 'file_write', arguments: { targetPath: path.join(fixture.projectRoot, 'wrong.txt'), content: 'blocked' },
    }, true, 'file_write', 'other-client', fixture.session.id), fixture.service, fixture.state);
    expect(await wrongSession.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'CONTROL_DENIED' } } });
  });
});

function rpc(
  method: string,
  id?: number,
  params?: unknown,
  includeProtocol = true,
  toolName?: string,
  clientId?: string,
  sessionId?: string,
): Request {
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(includeProtocol ? { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'Mcp-Method': method } : {}),
      ...(toolName === undefined ? {} : { 'Mcp-Name': toolName }),
      ...(clientId === undefined ? {} : { 'x-iris-client-id': clientId }),
      ...(sessionId === undefined ? {} : { 'x-iris-session-id': sessionId }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
  });
}

async function serviceFixture() {
  const sourceRoot = await realpath(await temp('iris-mcp-source-'));
  const dataRoot = await realpath(await temp('iris-mcp-data-'));
  const legacyRoot = await realpath(await temp('iris-mcp-legacy-'));
  const projectRoot = path.join(sourceRoot, 'project');
  await mkdir(projectRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Project', projectRoot);
  const session = state.createSession('client-a', 'agent-implementer', 'implementer');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, legacyRoot);
  const audit = new PermissionAuditStore(dataRoot);
  const broker = new MissionBrokerService(state, new MissionBrokerStore(dataRoot));
  const service = new CapabilityService(state, policy, audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: state.listClients().length, connectedSessions: state.listSessions().length,
    agentExecutorType: 'local-development-executor', productionModelConnected: false,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }));
  return { sourceRoot, dataRoot, legacyRoot, projectRoot, state, project, session, settings, policy, audit, broker, service };
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
