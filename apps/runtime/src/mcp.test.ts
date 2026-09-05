import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from './mcp.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('local MCP transport and permission boundary', () => {
  it('discovers the stateless endpoint and routes informational tools through the capability service', async () => {
    const fixture = await serviceFixture();
    const discovered = await handleMcpRequest(rpc('server/discover', 1, undefined, false), fixture.service);
    expect(discovered.status).toBe(200);
    expect(await discovered.json()).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSION } });

    const listed = await handleMcpRequest(rpc('tools/list', 2), fixture.service);
    const listedBody = await listed.json() as { result: { tools: Array<{ name: string }> } };
    expect(listedBody.result.tools.map((tool) => tool.name)).toEqual([
      'runtime_status', 'list_projects', 'file_read', 'file_write', 'file_delete', 'directory_create', 'directory_delete',
    ]);

    const status = await handleMcpRequest(rpc('tools/call', 3, { name: 'runtime_status', arguments: {} }, true, 'runtime_status'), fixture.service);
    expect(await status.json()).toMatchObject({ result: { isError: false, structuredContent: { status: 'ready' } } });
    expect((await fixture.audit.recent(10)).some((event) => event.capabilityId === 'runtime.status' && event.result === 'SUCCESS')).toBe(true);
  });

  it('cannot bypass session/project policy for file mutation', async () => {
    const fixture = await serviceFixture();
    const validTarget = path.join(fixture.projectRoot, 'mcp.txt');
    const valid = await handleMcpRequest(rpc('tools/call', 1, {
      name: 'file_write', arguments: { projectId: fixture.project.id, targetPath: validTarget, content: 'mcp-ok' },
    }, true, 'file_write', fixture.session.clientId, fixture.session.id), fixture.service);
    expect(await valid.json()).toMatchObject({ result: { isError: false } });
    await expect(readFile(validTarget, 'utf8')).resolves.toBe('mcp-ok');

    const outside = await temp('iris-mcp-outside-');
    const outsideTarget = path.join(outside, 'blocked.txt');
    const denied = await handleMcpRequest(rpc('tools/call', 2, {
      name: 'file_write', arguments: { projectId: fixture.project.id, targetPath: outsideTarget, content: 'must-not-run' },
    }, true, 'file_write', fixture.session.clientId, fixture.session.id), fixture.service);
    expect(await denied.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } } });
    await expect(access(outsideTarget)).rejects.toMatchObject({ code: 'ENOENT' });

    const wrongSession = await handleMcpRequest(rpc('tools/call', 3, {
      name: 'file_write', arguments: { targetPath: path.join(fixture.projectRoot, 'wrong.txt'), content: 'blocked' },
    }, true, 'file_write', 'other-client', fixture.session.id), fixture.service);
    expect(await wrongSession.json()).toMatchObject({ result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } } });
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
  const service = new CapabilityService(state, policy, audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: state.listClients().length, connectedSessions: state.listSessions().length,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }));
  return { sourceRoot, dataRoot, legacyRoot, projectRoot, state, project, session, settings, policy, audit, service };
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
