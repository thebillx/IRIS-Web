import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  return { state, broker, capabilities, audit, mission, projectRoot: project.rootPath };
}

function rpc(method: string, params?: unknown, id: number | null = 1): Request {
  return new Request('http://127.0.0.1/hermes-mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) });
}

describe('standard governed Hermes MCP adapter', () => {
  it('implements 2025-11-25 initialize and initialized notification', async () => {
    const f = await fixture();
    const initialized = await handleHermesMcpRequest(rpc('initialize', { protocolVersion: HERMES_MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'hermes', version: 'proof' } }), f.mission.id, f.state, f.broker, f.capabilities);
    expect(await initialized.json()).toMatchObject({ result: { protocolVersion: '2025-11-25', serverInfo: { name: 'iris-hermes-governed-bridge' } } });
    const notification = await handleHermesMcpRequest(rpc('notifications/initialized', {}, null), f.mission.id, f.state, f.broker, f.capabilities);
    expect(notification.status).toBe(202);
  });

  it('exposes only the bounded read-only Phase 2 toolset', async () => {
    const f = await fixture();
    const listed = await handleHermesMcpRequest(rpc('tools/list'), f.mission.id, f.state, f.broker, f.capabilities);
    const listBody = await listed.json() as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual(['runtime_status', 'mission_get', 'project_git_status', 'project_file_read']);
    expect(listBody.result.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(JSON.stringify(listBody)).not.toContain('file_write');
    expect(JSON.stringify(listBody)).not.toContain('delete');
    expect(JSON.stringify(listBody)).not.toContain('shell');
  });

  it('routes runtime, mission, Git status, and file reads through governed CapabilityService', async () => {
    const f = await fixture();
    const runtime = await handleHermesMcpRequest(rpc('tools/call', { name: 'runtime_status', arguments: {} }), f.mission.id, f.state, f.broker, f.capabilities);
    expect(await runtime.json()).toMatchObject({ result: { isError: false, structuredContent: { status: 'ready', authority: 'owned' } } });

    const mission = await handleHermesMcpRequest(rpc('tools/call', { name: 'mission_get', arguments: {} }), f.mission.id, f.state, f.broker, f.capabilities);
    expect(await mission.json()).toMatchObject({ result: { isError: false, structuredContent: { id: f.mission.id, title: 'Hermes MCP proof' } } });

    const git = await handleHermesMcpRequest(rpc('tools/call', { name: 'project_git_status', arguments: {} }), f.mission.id, f.state, f.broker, f.capabilities);
    expect(await git.json()).toMatchObject({ result: { isError: false, structuredContent: { branch: 'proof', clean: false, untrackedChanges: 1 } } });

    const read = await handleHermesMcpRequest(rpc('tools/call', { name: 'project_file_read', arguments: { targetPath: path.join(f.projectRoot, 'untracked.txt') } }), f.mission.id, f.state, f.broker, f.capabilities);
    expect(await read.json()).toMatchObject({ result: { isError: false, structuredContent: { content: 'read-only proof\n' } } });

    const audit = await f.audit.recent(40);
    for (const capabilityId of ['runtime.status', 'mission.get', 'project.git_status', 'file.read']) {
      expect(audit.some((event) => event.capabilityId === capabilityId && event.result === 'SUCCESS')).toBe(true);
    }
  });

  it('does not expose or accept mutation tools', async () => {
    const f = await fixture();
    const response = await handleHermesMcpRequest(rpc('tools/call', { name: 'file_write', arguments: { targetPath: '/tmp/nope', content: 'nope' } }), f.mission.id, f.state, f.broker, f.capabilities);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('not exposed');
  });
});
