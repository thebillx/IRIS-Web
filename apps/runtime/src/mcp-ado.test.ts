import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { DurableJobManager } from './durable-job-manager.js';
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
import { VNextResourceRegistry } from './resource-registry.js';
import { RuntimeState } from './state.js';
import { AdoRequirementContextService } from './ado/runtime-context.js';
import type { AdoRuntimeBindingProvider, ResolvedAdoRuntimeBinding } from './ado/runtime-binding.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('ADO FULL MCP requirement context', () => {
  it('exposes four ADO read tools only on FULL while PRO remains exactly five tools', async () => {
    const f = await fixture();
    const full = await handleMcpV21Request(rpc('tools/list', 1), f.service, f.state, f.broker, f.lifecycle);
    const fullBody = await full.json() as { result: { tools: Array<{ name: string }> } };
    const names = fullBody.result.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'ado_discovery',
      'ado_workitem_read',
      'ado_hierarchy_read',
      'ado_context_search',
    ]));

    const pro = await handleMcpProRequest(rpc('tools/list', 2, undefined, 'chatgpt-pro'), f.service);
    const proBody = await pro.json() as { result: { tools: Array<{ name: string }> } };
    expect(proBody.result.tools.map((tool) => tool.name)).toEqual([
      'list_projects', 'project_info', 'git_status', 'file_read', 'search',
    ]);
    expect(proBody.result.tools.some((tool) => tool.name.startsWith('ado_'))).toBe(false);
  });

  it('routes ado_workitem_read through CapabilityService with READ+NETWORK and returns canonical provenance', async () => {
    const f = await fixture();
    const response = await handleMcpV21Request(
      rpc('tools/call', 3, {
        name: 'ado_workitem_read',
        arguments: {
          projectId: f.project.id,
          requestId: 'mcp-ado-item',
          workItemId: 101,
          includeComments: false,
          includeLinks: true,
          expectedEffects: ['READ','NETWORK'],
        },
      }, f.session.clientId, f.session.id, 'ado_workitem_read'),
      f.service, f.state, f.broker, f.lifecycle,
    );
    const body = await response.json() as {
      result: { isError: boolean; structuredContent: Record<string, unknown> };
    };
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toMatchObject({
      item: {
        id: 101,
        revision: 7,
        title: 'ETB Login Story',
        state: 'Active',
        areaPath: 'Project\\Team\\ETB',
        acceptanceCriteria: { text: 'Given valid user' },
      },
      provenance: {
        provider: 'azure-devops',
        operation: 'workitem.read',
        revision: 7,
        changedDate: '2026-09-20T12:00:00Z',
      },
    });
    expect(JSON.stringify(body)).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
    const audit = await f.audit.recent();
    expect(audit.some((entry) => entry.capabilityId === 'ado.workitem.read'
      && entry.result === 'SUCCESS'
      && entry.effectiveEffects?.join(',') === 'READ,NETWORK')).toBe(true);
  });

  it('fails closed on downgraded expectedEffects and on session/project mismatch', async () => {
    const f = await fixture();
    const downgraded = await handleMcpV21Request(
      rpc('tools/call', 4, {
        name: 'ado_discovery',
        arguments: {
          projectId: f.project.id,
          requestId: 'mcp-ado-effects',
          expectedEffects: ['READ'],
        },
      }, f.session.clientId, f.session.id, 'ado_discovery'),
      f.service, f.state, f.broker, f.lifecycle,
    );
    expect(await downgraded.json()).toMatchObject({
      result: { isError: true, structuredContent: { code: 'INVALID_REQUEST' } },
    });

    const otherRoot = path.join(path.dirname(f.project.rootPath), 'other');
    await mkdir(otherRoot);
    const other = await f.state.registerProject('other', otherRoot);
    const mismatch = await handleMcpV21Request(
      rpc('tools/call', 5, {
        name: 'ado_discovery',
        arguments: {
          projectId: other.id,
          requestId: 'mcp-ado-mismatch',
          expectedEffects: ['READ','NETWORK'],
        },
      }, f.session.clientId, f.session.id, 'ado_discovery'),
      f.service, f.state, f.broker, f.lifecycle,
    );
    expect(await mismatch.json()).toMatchObject({
      result: { isError: true, structuredContent: { code: 'CAPABILITY_DENIED' } },
    });
  });

  it('returns structured local rate-limit metadata without automatic retry', async () => {
    const f = await fixture(1);
    const response = await handleMcpV21Request(
      rpc('tools/call', 7, {
        name: 'ado_discovery',
        arguments: {
          projectId: f.project.id,
          requestId: 'mcp-ado-local-rate-limit',
          expectedEffects: ['READ','NETWORK'],
        },
      }, f.session.clientId, f.session.id, 'ado_discovery'),
      f.service, f.state, f.broker, f.lifecycle,
    );
    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          code: 'LOCAL_RATE_LIMITED',
          retryAfterMs: expect.any(Number),
          limit: 1,
          remaining: 0,
          windowMs: 60_000,
        },
      },
    });
  });

  it('rejects ADO calls on the PRO endpoint', async () => {
    const f = await fixture();
    const response = await handleMcpProRequest(
      rpc('tools/call', 6, {
        name: 'ado_discovery',
        arguments: {
          projectId: f.project.id,
          requestId: 'mcp-ado-pro',
          expectedEffects: ['READ','NETWORK'],
        },
      }, 'chatgpt-pro', undefined, 'ado_discovery'),
      f.service,
    );
    expect(await response.json()).toMatchObject({
      result: { isError: true, structuredContent: { code: 'INVALID_REQUEST' } },
    });
  });
});

async function fixture(rateLimitRequests = 100) {
  const sourceRoot = await realpath(await temp('iris-ado-mcp-source-'));
  const dataRoot = await realpath(await temp('iris-ado-mcp-data-'));
  const legacyRoot = await realpath(await temp('iris-ado-mcp-legacy-'));
  const projectRoot = path.join(sourceRoot, 'iris');
  await mkdir(projectRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('iris', projectRoot);
  const session = state.createSession('chatgpt-ado', 'chatgpt-direct-orchestrator', 'owner');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, legacyRoot);
  const audit = new PermissionAuditStore(dataRoot);
  const broker = new MissionBrokerService(state, new MissionBrokerStore(dataRoot));
  const resources = new VNextResourceRegistry(state, dataRoot);
  const jobs = new DurableJobManager(dataRoot, resources);
  const ado = new AdoRequirementContextService(bindingProvider(project.id, rateLimitRequests), fakeFetch());
  const service = new CapabilityService(state, policy, audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1,
    agentExecutorType: 'local-development-executor', productionModelConnected: false,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }), new ProjectValidationJobManager(dataRoot), resources, jobs, undefined, ado);
  const lifecycle = new DurableMissionLifecycleService(state, new DurableMissionLifecycleStore(dataRoot), new WorkerAdapterRegistry());
  return { state, project, session, broker, service, lifecycle, audit };
}

function bindingProvider(irisProjectId: string, rateLimitRequests = 100): AdoRuntimeBindingProvider {
  const resolved: ResolvedAdoRuntimeBinding = {
    identity: {
      organization: { id: 'org-id', name: 'org' },
      project: { id: 'project-id', name: 'Project' },
      team: { id: 'team-id', name: 'Team' },
      board: { id: 'board-id', name: 'Stories' },
    },
    organizationName: 'org',
    projectName: 'Project',
    auth: { kind: 'PAT', secret: 'abcdefghijklmnopqrstuvwxyz1234567890' },
    grant: {
      projectId: irisProjectId,
      connectorBindingId: 'ado-binding',
      credentialRef: 'ado-credential',
      sessionRef: 'ado-session',
      network: 'allowed',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revoked: false,
      tokenScopes: ['vso.work'],
      policy: {
        mode: 'READ_ONLY',
        allowlist: [{
          organization: 'org-id',
          project: 'project-id',
          team: 'team-id',
          board: 'board-id',
          resources: ['board','scope','backlogs','query','workItems','comments','links'],
        }],
        timeoutMs: 5000,
        maxResponseBytes: 1048576,
        maxPageItems: 100,
        maxPages: 4,
        maxBatchItems: 100,
        rateLimit: { requests: rateLimitRequests, windowMs: 60000, maxRetryAfterMs: 10000 },
      },
    },
  };
  return { resolve: async (projectId) => {
    if (projectId !== irisProjectId) throw new Error('wrong IRIS project');
    return resolved;
  }};
}

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/_apis/work/teamsettings/teamfieldvalues')) return json({
      field: { referenceName: 'System.AreaPath' },
      defaultValue: 'Project\\Team',
      values: [{ value: 'Project\\Team', includeChildren: true }],
    });
    if (url.pathname.endsWith('/_apis/work/boards/board-id')) return json({ id: 'board-id', name: 'Stories' });
    if (url.pathname.endsWith('/_apis/work/backlogs')) return json({ value: [
      { id: 'story', name: 'Stories', rank: 1, type: 'requirement', workItemTypes: [{ name: 'User Story' }] },
    ] });
    if (url.pathname.endsWith('/_apis/wit/wiql')) return json({ workItems: [{ id: 101 }] });
    if (url.pathname.endsWith('/_apis/wit/workitems/101')) return json({
      id: 101,
      rev: 7,
      fields: {
        'System.WorkItemType': 'User Story',
        'System.Title': 'ETB Login Story',
        'System.State': 'Active',
        'System.Description': '<p>User can login</p>',
        'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>Given valid user</p>',
        'System.AreaPath': 'Project\\Team\\ETB',
        'System.IterationPath': 'Project\\Sprint 1',
        'System.Parent': null,
        'System.Tags': 'etb;automation',
        'System.BoardColumn': 'Doing',
        'System.CreatedDate': '2026-09-01T10:00:00Z',
        'System.ChangedDate': '2026-09-20T12:00:00Z',
      },
      relations: [],
    });
    throw new Error('unexpected ADO fake route: ' + url.pathname);
  }) as typeof fetch;
}

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

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
