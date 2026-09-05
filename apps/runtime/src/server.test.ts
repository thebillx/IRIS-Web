import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeError, type RuntimeIdentity } from '@iris/domain';
import type { AgentExecutor } from './agent-executor.js';
import type { CapabilityService } from './capability-service.js';
import type { MissionBrokerService } from './mission-broker.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';
import { LOOPBACK_ADDRESS, requireLoopbackAddress, startRuntimeServer, type RuntimeServerContext, type RuntimeServerHandle } from './server.js';

let handle: RuntimeServerHandle | undefined;
const roots: string[] = [];
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const identity: RuntimeIdentity = {
  runtimeId: randomUUID(),
  instanceId: randomUUID(),
  pid: process.pid,
  startedAt: '2026-09-04T00:00:00.000Z',
  platform: 'darwin',
  version: '0.0.0',
};

describe('runtime listener safety', () => {
  it('accepts only the IPv4 loopback address', () => {
    expect(requireLoopbackAddress(LOOPBACK_ADDRESS)).toBe(LOOPBACK_ADDRESS);
    expect(() => requireLoopbackAddress('0.0.0.0')).toThrow();
    expect(() => requireLoopbackAddress('192.168.1.10')).toThrow();
    expect(() => requireLoopbackAddress('localhost')).toThrow();
  });

  it('serves health from a loopback listener and rejects a non-loopback browser origin', async () => {
    handle = await startRuntimeServer({
      identity,
      state: {} as RuntimeState,
      capabilities: {} as CapabilityService,
      missionBroker: {} as MissionBrokerService,
      health: () => ({
        status: 'ready',
        version: '0.0.0',
        platform: 'darwin',
        runtimeId: identity.runtimeId,
        instanceId: identity.instanceId,
        pid: identity.pid,
        uptimeMs: 1,
        authority: 'owned',
        connectedClients: 0,
        connectedSessions: 0,
        agentExecutorType: 'local-development-executor',
        productionModelConnected: false,
        apiUrl: '',
        mcpUrl: '',
      }),
      doctor: async () => ({ status: 'pass', checks: [] }),
      isShuttingDown: () => false,
      controlSecret: 'test-control-secret-that-is-not-public',
      ownerAccessSecret: 'test-owner-access-secret-that-is-not-public',
      requestShutdown: () => undefined,
    }, 0);
    expect(handle.apiUrl.startsWith(`http://${LOOPBACK_ADDRESS}:`)).toBe(true);
    const response = await fetch(`${handle.apiUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ready', runtimeId: identity.runtimeId, instanceId: identity.instanceId });

    const rejected = await fetch(`${handle.apiUrl}/health`, { headers: { origin: 'https://example.test' } });
    expect(rejected.status).toBe(403);
  });

  it('returns only a product-safe agent execution failure payload', async () => {
    const ownerAccessSecret = 'test-owner-access-secret-that-is-not-public';
    const sensitiveDiagnostic = 'provider failed api_key=secret internal_path=/private/example';
    const executor: AgentExecutor = {
      descriptor: { type: 'other', productionModelConnected: false },
      execute: async () => {
        throw new RuntimeError('AGENT_EXECUTION_FAILED', sensitiveDiagnostic);
      },
    };
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-server-executor-sanitize-'));
    roots.push(dataRoot);
    const state = new RuntimeState(new FoundationStateStore(dataRoot), executor);
    const session = state.createSession('client-a');
    const capabilities = {
      execute: async () => ({
        status: 'executed',
        value: await state.submitInstruction(session.id, session.clientId, 'submission-a', 'Fail safely'),
      }),
    } as unknown as CapabilityService;
    handle = await startRuntimeServer({
      identity,
      state: {} as RuntimeState,
      capabilities,
      missionBroker: {} as MissionBrokerService,
      health: () => ({
        status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: identity.runtimeId, instanceId: identity.instanceId,
        pid: identity.pid, uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1,
        agentExecutorType: 'local-development-executor', productionModelConnected: false, apiUrl: '', mcpUrl: '',
      }),
      doctor: async () => ({ status: 'pass', checks: [] }),
      isShuttingDown: () => false,
      controlSecret: 'test-control-secret-that-is-not-public',
      ownerAccessSecret,
      requestShutdown: () => undefined,
    }, 0);

    const response = await fetch(`${handle.apiUrl}/sessions/${session.id}/instructions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ownerAccessSecret}`,
        'x-iris-client-id': 'client-a',
      },
      body: JSON.stringify({ submissionId: 'submission-a', instruction: 'Fail safely' }),
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('AGENT_EXECUTION_FAILED');
    expect(body).toContain('Agent execution failed');
    expect(body).not.toContain('api_key=secret');
    expect(body).not.toContain('/private/example');
    expect(body).not.toContain(sensitiveDiagnostic);
  });

  it('keeps runtime control secret private and requires the exact instance-bound credential for shutdown', async () => {
    let shutdownRequested = false;
    const controlSecret = 'test-control-secret-that-is-not-public';
    const context: RuntimeServerContext = {
      identity,
      state: {} as RuntimeState,
      capabilities: {} as CapabilityService,
      missionBroker: {} as MissionBrokerService,
      health: () => ({
        status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: identity.runtimeId, instanceId: identity.instanceId,
        pid: identity.pid, uptimeMs: 1, authority: 'owned', connectedClients: 0, connectedSessions: 0,
        agentExecutorType: 'local-development-executor', productionModelConnected: false, apiUrl: '', mcpUrl: '',
      }),
      doctor: async () => ({ status: 'pass', checks: [] }),
      isShuttingDown: () => false,
      controlSecret,
      ownerAccessSecret: 'test-owner-access-secret-that-is-not-public',
      requestShutdown: () => { shutdownRequested = true; },
    };
    handle = await startRuntimeServer(context, 0);

    const status = await fetch(`${handle.apiUrl}/status`);
    expect(await status.text()).not.toContain(controlSecret);

    const body = JSON.stringify({ runtimeId: identity.runtimeId, instanceId: identity.instanceId });
    const denied = await fetch(`${handle.apiUrl}/control/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-secret' }, body,
    });
    expect(denied.status).toBe(403);
    expect(shutdownRequested).toBe(false);

    const accepted = await fetch(`${handle.apiUrl}/control/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${controlSecret}` }, body,
    });
    expect(accepted.status).toBe(202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shutdownRequested).toBe(true);
  });
});
