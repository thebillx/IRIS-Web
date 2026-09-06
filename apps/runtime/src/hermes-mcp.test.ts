import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { handleHermesMcpRequest, HERMES_MCP_PROTOCOL_VERSION } from './hermes-mcp.js';
import { MissionBrokerService, MissionBrokerStore } from './mission-broker.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-hermes-mcp-source-')); roots.push(sourceRoot);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-hermes-mcp-data-')); roots.push(dataRoot);
  const projectRoot = path.join(sourceRoot, 'proof-worktree'); await mkdir(projectRoot);
  await execFileAsync('/usr/bin/git', ['init', '-b', 'proof'], { cwd: projectRoot });
  await writeFile(path.join(projectRoot, 'untracked.txt'), 'read-only proof\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ private: true, scripts: { test: "node -e \"console.log('hermes-governed-test-pass')\"" } }));
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Hermes Proof', projectRoot);
  const session = state.createSession('hermes-client', 'hermes-loop-engineer', 'implementer');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const mission = await state.createMission(session.clientId, session.id, 'Hermes MCP proof');
  const broker = new MissionBrokerService(state, new MissionBrokerStore(dataRoot));
  await broker.bindHermesSession({ missionId: mission.id, hermesSessionId: '20260905_120000_mcp001', worktreePath: project.rootPath, branch: 'proof' });
  const settings = new PermissionSettingsStore(dataRoot); await settings.initialize();
  const audit = new PermissionAuditStore(dataRoot);
  const capabilities = new CapabilityService(state, new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot), audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid, uptimeMs: 1,
    authority: 'owned', connectedClients: 1, connectedSessions: 1, agentExecutorType: 'local-development-executor', productionModelConnected: false, apiUrl: '', mcpUrl: '',
  }));
  return { state, broker, capabilities, settings, audit, mission, projectRoot: project.rootPath };
}

function rpc(method: string, params?: unknown, id: number | null = 1): Request {
  return new Request('http://127.0.0.1/hermes-mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) });
}
async function call(f: Awaited<ReturnType<typeof fixture>>, name: string, args: Record<string, unknown> = {}) {
  const response = await handleHermesMcpRequest(rpc('tools/call', { name, arguments: args }), f.mission.id, f.state, f.broker, f.capabilities);
  return response.json() as Promise<{ result: { isError: boolean; structuredContent: Record<string, unknown> } }>;
}
interface TestMissionShape {
  readonly tasks: readonly { readonly id: string; readonly actions: readonly { readonly id: string }[] }[];
}

interface TestApprovalShape {
  readonly id: string;
}

function asMission(value: Record<string, unknown>): TestMissionShape {
  return value as unknown as TestMissionShape;
}

function taskAndAction(mission: TestMissionShape) {
  const task = mission.tasks.at(-1)!;
  const action = task.actions.at(-1)!;
  return { taskId: task.id, actionId: action.id };
}

function approvalFrom(value: Record<string, unknown>): TestApprovalShape {
  return value.approval as TestApprovalShape;
}

describe('standard governed Hermes MCP adapter', () => {
  it('implements 2025-11-25 initialize and initialized notification', async () => {
    const f = await fixture();
    const initialized = await handleHermesMcpRequest(rpc('initialize', { protocolVersion: HERMES_MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'hermes', version: 'proof' } }), f.mission.id, f.state, f.broker, f.capabilities);
    expect(await initialized.json()).toMatchObject({ result: { protocolVersion: '2025-11-25', serverInfo: { name: 'iris-hermes-governed-bridge' } } });
    const notification = await handleHermesMcpRequest(rpc('notifications/initialized', {}, null), f.mission.id, f.state, f.broker, f.capabilities);
    expect(notification.status).toBe(202);
  });

  it('exposes bounded governed tools and no direct shell/delete capability', async () => {
    const f = await fixture();
    const listed = await handleHermesMcpRequest(rpc('tools/list'), f.mission.id, f.state, f.broker, f.capabilities);
    const listBody = await listed.json() as { result: { tools: { name: string }[] } };
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual([
      'runtime_status', 'mission_get', 'project_git_status', 'project_file_read', 'project_test_run',
      'mission_task_create', 'mission_action_prepare', 'project_file_write',
    ]);
    expect(JSON.stringify(listBody)).not.toContain('file_delete');
    expect(JSON.stringify(listBody)).not.toContain('shell');
    expect(JSON.stringify(listBody)).not.toContain('git_command');
  });

  it('routes runtime, mission, Git status, and file reads through governed CapabilityService', async () => {
    const f = await fixture();
    expect(await call(f, 'runtime_status')).toMatchObject({ result: { isError: false, structuredContent: { status: 'ready', authority: 'owned' } } });
    expect(await call(f, 'mission_get')).toMatchObject({ result: { isError: false, structuredContent: { id: f.mission.id, title: 'Hermes MCP proof' } } });
    expect(await call(f, 'project_git_status')).toMatchObject({ result: { isError: false, structuredContent: { branch: 'proof', clean: false, untrackedChanges: 2 } } });
    expect(await call(f, 'project_file_read', { targetPath: path.join(f.projectRoot, 'untracked.txt') })).toMatchObject({ result: { isError: false, structuredContent: { content: 'read-only proof\n' } } });
    const audit = await f.audit.recent(40);
    for (const capabilityId of ['runtime.status', 'mission.get', 'project.git_status', 'file.read']) expect(audit.some((event) => event.capabilityId === capabilityId && event.result === 'SUCCESS')).toBe(true);
  });

  it('fails closed on secret-like project paths and high-confidence secret content', async () => {
    const f = await fixture();
    const envSecret = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
    await writeFile(path.join(f.projectRoot, '.env'), `OPENAI_API_KEY=${envSecret}\n`);
    const blockedPath = await call(f, 'project_file_read', { targetPath: path.join(f.projectRoot, '.env') });
    expect(blockedPath).toMatchObject({ result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } } });
    expect(JSON.stringify(blockedPath)).not.toContain(envSecret);

    const privateKeyMarker = '-----BEGIN PRIVATE KEY-----';
    await writeFile(path.join(f.projectRoot, 'ordinary-notes.txt'), `${privateKeyMarker}\nnot-a-real-key\n-----END PRIVATE KEY-----\n`);
    const blockedContent = await call(f, 'project_file_read', { targetPath: path.join(f.projectRoot, 'ordinary-notes.txt') });
    expect(blockedContent).toMatchObject({ result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } } });
    expect(JSON.stringify(blockedContent)).not.toContain(privateKeyMarker);
  });

  it('runs only the declared project test script through a prepared governed mission action', async () => {
    const f = await fixture();
    const task = await call(f, 'mission_task_create', { title: 'Validate disposable fixture' });
    const taskId = asMission(task.result.structuredContent).tasks.at(-1)!.id;
    const prepared = await call(f, 'mission_action_prepare', { taskId, capabilityId: 'project.test.run', summary: 'Run declared fixture tests' });
    const { actionId } = taskAndAction(asMission(prepared.result.structuredContent));
    const result = await call(f, 'project_test_run', { taskId, actionId });
    expect(result).toMatchObject({ result: { isError: false, structuredContent: { passed: true, exitCode: 0, timedOut: false } } });
    expect(JSON.stringify(result)).toContain('hermes-governed-test-pass');
    const mission = await f.state.getMission(f.mission.id);
    const action = mission.tasks.at(-1)!.actions.at(-1)!;
    expect(action).toMatchObject({ capabilityId: 'project.test.run', state: 'SUCCEEDED', result: { status: 'SUCCEEDED' } });
    expect(action.result?.evidence.at(-1)?.data).toMatchObject({ passed: true, exitCode: 0, timedOut: false });
  });

  it('requires prepared mission identity and owner approval, then executes the exact file.write once', async () => {
    const f = await fixture();
    const taskCreated = await call(f, 'mission_task_create', { title: 'Write disposable proof' });
    expect(taskCreated.result.isError).toBe(false);
    const taskId = asMission(taskCreated.result.structuredContent).tasks.at(-1)!.id;
    const prepared = await call(f, 'mission_action_prepare', { taskId, capabilityId: 'file.write', summary: 'Write one disposable proof file' });
    expect(prepared.result.isError).toBe(false);
    const ids = taskAndAction(asMission(prepared.result.structuredContent));
    expect(ids.taskId).toBe(taskId);
    const targetPath = path.join(f.projectRoot, 'approved.txt');
    await f.settings.setMode('ASK_EVERY_TIME');

    const pending = await call(f, 'project_file_write', { taskId, actionId: ids.actionId, targetPath, content: 'approved-once' });
    expect(pending).toMatchObject({ result: { isError: true, structuredContent: { code: 'OWNER_DECISION_REQUIRED', approval: { missionId: f.mission.id, taskId, actionId: ids.actionId } } } });
    const approval = approvalFrom(pending.result.structuredContent);
    const resolved = await f.capabilities.resolveApproval(approval.id, 'ALLOW_ONCE');
    expect(resolved.status).toBe('executed');
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('approved-once');

    const replay = await call(f, 'project_file_write', { taskId, actionId: ids.actionId, targetPath, content: 'must-not-replay' });
    expect(replay).toMatchObject({ result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } } });
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('approved-once');
    await expect(f.capabilities.resolveApproval(approval.id, 'ALLOW_ONCE')).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
  });

  it('owner denial prevents the prepared mission write from executing', async () => {
    const f = await fixture();
    const task = await call(f, 'mission_task_create', { title: 'Denied proof' });
    const taskId = asMission(task.result.structuredContent).tasks.at(-1)!.id;
    const prepared = await call(f, 'mission_action_prepare', { taskId, capabilityId: 'file.write', summary: 'Must be denied' });
    const { actionId } = taskAndAction(asMission(prepared.result.structuredContent));
    const targetPath = path.join(f.projectRoot, 'denied.txt');
    await f.settings.setMode('ASK_EVERY_TIME');
    const pending = await call(f, 'project_file_write', { taskId, actionId, targetPath, content: 'must-not-exist' });
    const approval = approvalFrom(pending.result.structuredContent);
    const denied = await f.capabilities.resolveApproval(approval.id, 'DENY');
    expect(denied.status).toBe('denied');
    await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const mission = await f.state.getMission(f.mission.id);
    expect((mission.tasks.at(-1)!.actions.at(-1)!)).toMatchObject({ state: 'DENIED', approvalId: approval.id });
  });

  it('disables all Hermes operational tools immediately after a safe handoff to CHATGPT', async () => {
    const f = await fixture();
    const handed = await f.broker.changeOrchestrator({ missionId: f.mission.id, targetMode: 'CHATGPT', expectedVersion: 1, handoffId: crypto.randomUUID() });
    expect(handed.orchestratorMode).toBe('CHATGPT');
    const result = await call(f, 'runtime_status');
    expect(result).toMatchObject({ result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } } });
  });

  it('does not expose or accept unprepared or unsupported mutation tools', async () => {
    const f = await fixture();
    const response = await handleHermesMcpRequest(rpc('tools/call', { name: 'file_delete', arguments: { targetPath: '/tmp/nope' } }), f.mission.id, f.state, f.broker, f.capabilities);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('not exposed');
  });
});
