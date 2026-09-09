import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityService } from './capability-service.js';
import { DurableMissionLifecycleService } from './durable-mission-service.js';
import { DurableMissionLifecycleStore } from './durable-mission-store.js';
import { WorkerAdapterRegistry } from './durable-mission-workers.js';
import { MCP_PROTOCOL_VERSION } from './mcp.js';
import { MissionBrokerService, MissionBrokerStore } from './mission-broker.js';
import { FoundationStateStore } from './persistence.js';
import { startRuntimeServer, type RuntimeServerHandle } from './server.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
let handle: RuntimeServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('V2.1 live server integration', () => {
  it('serves Full MCP lifecycle tools, preserves the five-tool Pro profile, and enforces owner-authenticated lifecycle resume/cancel/evidence', async () => {
    const dataRoot = await temp('iris-v21-live-data-');
    const projectRoot = await temp('iris-v21-live-project-');
    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    const project = await state.registerProject('iris', projectRoot);
    const session = state.createSession('client-v21', 'owner-v21', 'owner');
    await state.setSessionCurrentProject(session.id, session.clientId, project.id);
    const broker = new MissionBrokerService(state, new MissionBrokerStore(dataRoot));
    const lifecycle = new DurableMissionLifecycleService(
      state,
      new DurableMissionLifecycleStore(dataRoot),
      new WorkerAdapterRegistry(),
    );
    const mission = await state.createMission(session.clientId, session.id, 'Live V2.1 mission', 'CHATGPT');
    let durable = await lifecycle.ensureMission(mission.id, 'Prove live server lifecycle integration.');
    durable = await lifecycle.start({
      missionId: mission.id,
      expectedRevision: durable.revision,
      requestId: randomUUID(),
      workerType: 'IRIS_LOGICAL',
    });
    durable = await lifecycle.checkpoint({
      missionId: mission.id,
      expectedRevision: durable.revision,
      checkpointId: randomUUID(),
      summary: 'Live server checkpoint ready.',
      evidenceRefs: ['server-v21:checkpoint'],
    });
    durable = await lifecycle.acceptDirective({
      missionId: mission.id,
      basedOnRevision: durable.revision,
      directiveId: randomUUID(),
      directive: 'Resume through the live owner route.',
    });
    expect(durable).toMatchObject({ state: 'WAITING_FOR_SUPERVISOR', revision: 6 });

    const ownerAccessSecret = 'v21-owner-access-secret-'.padEnd(48, 'x');
    handle = await startRuntimeServer({
      identity: {
        runtimeId: randomUUID(), instanceId: randomUUID(), pid: process.pid,
        startedAt: '2026-09-08T15:00:00.000Z', platform: 'darwin', version: '0.0.0',
      },
      state,
      capabilities: {} as CapabilityService,
      missionBroker: broker,
      missionLifecycle: lifecycle,
      health: () => ({
        status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
        uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1,
        agentExecutorType: 'local-development-executor', productionModelConnected: false, apiUrl: '', mcpUrl: '',
      }),
      doctor: async () => ({ status: 'pass', checks: [] }),
      isShuttingDown: () => false,
      controlSecret: 'v21-control-secret-that-is-private',
      ownerAccessSecret,
      requestShutdown: () => undefined,
    }, 0);

    const unauthenticatedLifecycle = await fetch(`${handle.apiUrl}/missions/${mission.id}/lifecycle`);
    expect(unauthenticatedLifecycle.status).toBe(403);

    const fullMcp = await rpc(handle.apiUrl, '/mcp', ownerAccessSecret, 'tools/list', 1);
    expect(fullMcp.status).toBe(200);
    const fullBody = await fullMcp.json() as { result: { tools: Array<{ name: string }> } };
    expect(fullBody.result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'mission_start', 'mission_checkpoint', 'mission_resume', 'mission_cancel', 'mission_complete', 'mission_evidence',
    ]));

    const proMcp = await rpc(handle.apiUrl, '/mcp-pro', ownerAccessSecret, 'tools/list', 2);
    expect(proMcp.status).toBe(200);
    const proBody = await proMcp.json() as { result: { tools: Array<{ name: string }> } };
    expect(proBody.result.tools.map((tool) => tool.name)).toEqual([
      'list_projects', 'project_info', 'git_status', 'file_read', 'search',
    ]);

    const missions = await fetch(`${handle.apiUrl}/missions`, { headers: ownerHeaders(ownerAccessSecret) });
    expect(missions.status).toBe(200);
    expect(await missions.json()).toMatchObject({
      missions: [{ id: mission.id, lifecycle: { missionId: mission.id, state: 'WAITING_FOR_SUPERVISOR', revision: 6 } }],
    });

    const lifecycleResponse = await fetch(`${handle.apiUrl}/missions/${mission.id}/lifecycle`, { headers: ownerHeaders(ownerAccessSecret) });
    expect(lifecycleResponse.status).toBe(200);
    expect(await lifecycleResponse.json()).toMatchObject({
      missionId: mission.id,
      projectId: project.id,
      state: 'WAITING_FOR_SUPERVISOR',
      revision: 6,
      checkpoints: [expect.objectContaining({ summary: 'Live server checkpoint ready.' })],
      directives: [expect.objectContaining({ directive: 'Resume through the live owner route.', status: 'ACCEPTED' })],
    });

    const resumed = await lifecycleMutation(handle.apiUrl, ownerAccessSecret, mission.id, 'resume', 6);
    expect(resumed).toMatchObject({ missionId: mission.id, state: 'RUNNING', revision: 8 });
    const cancelled = await lifecycleMutation(handle.apiUrl, ownerAccessSecret, mission.id, 'cancel', 8);
    expect(cancelled).toMatchObject({ missionId: mission.id, state: 'CANCELLED', revision: 10 });

    const evidenceId = randomUUID();
    const evidenceResponse = await fetch(`${handle.apiUrl}/missions/${mission.id}/lifecycle/evidence`, {
      method: 'POST',
      headers: { ...ownerHeaders(ownerAccessSecret), 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 10,
        evidence: {
          id: evidenceId,
          kind: 'OBSERVATION',
          label: 'Live evidence route',
          summary: 'Owner-authenticated evidence was durably appended.',
          reference: 'server-v21:evidence',
          data: { accepted: true },
        },
      }),
    });
    expect(evidenceResponse.status).toBe(200);
    expect(await evidenceResponse.json()).toMatchObject({
      missionId: mission.id,
      state: 'CANCELLED',
      revision: 11,
      evidence: [expect.objectContaining({ id: evidenceId, label: 'Live evidence route' })],
    });

    const finalLifecycle = await fetch(`${handle.apiUrl}/missions/${mission.id}/lifecycle`, { headers: ownerHeaders(ownerAccessSecret) });
    expect(await finalLifecycle.json()).toMatchObject({
      missionId: mission.id,
      state: 'CANCELLED',
      revision: 11,
      evidence: [expect.objectContaining({ id: evidenceId, summary: 'Owner-authenticated evidence was durably appended.' })],
    });
  });
});

async function rpc(apiUrl: string, pathname: string, ownerAccessSecret: string, method: string, id: number): Promise<Response> {
  return fetch(`${apiUrl}${pathname}`, {
    method: 'POST',
    headers: {
      ...ownerHeaders(ownerAccessSecret),
      'content-type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      'Mcp-Method': method,
      'x-iris-client-id': 'live-v21-test',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method }),
  });
}

async function lifecycleMutation(
  apiUrl: string,
  ownerAccessSecret: string,
  missionId: string,
  action: 'resume' | 'cancel',
  expectedRevision: number,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiUrl}/missions/${missionId}/lifecycle/${action}`, {
    method: 'POST',
    headers: { ...ownerHeaders(ownerAccessSecret), 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision, requestId: randomUUID() }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

function ownerHeaders(ownerAccessSecret: string): Record<string, string> {
  return { authorization: `Bearer ${ownerAccessSecret}` };
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
