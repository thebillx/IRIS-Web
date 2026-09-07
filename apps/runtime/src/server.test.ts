import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
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

  it('publishes only OAuth discovery metadata without owner access', async () => {
    const ownerAccessSecret = 'test-owner-access-secret-that-is-not-public';
    const controlSecret = 'test-control-secret-that-is-not-public';
    handle = await startRuntimeServer({
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
      ownerAccessSecret,
      requestShutdown: () => undefined,
    }, 0);

    const protectedResourceResponse = await fetch(`${handle.apiUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(protectedResourceResponse.status).toBe(200);
    const protectedResource = await protectedResourceResponse.json();
    expect(protectedResource).toMatchObject({
      resource: `${handle.apiUrl}/mcp`,
      authorization_servers: [handle.apiUrl],
      scopes_supported: ['read', 'write'],
    });

    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp-pro',
    ]) {
      const response = await fetch(`${handle.apiUrl}${path}`);
      expect(response.status).toBe(404);
      expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(0);
    }

    const authorizationServerResponse = await fetch(`${handle.apiUrl}/.well-known/oauth-authorization-server`);
    expect(authorizationServerResponse.status).toBe(200);
    expect(await authorizationServerResponse.json()).toMatchObject({
      issuer: handle.apiUrl,
      authorization_endpoint: `${handle.apiUrl}/authorize`,
      token_endpoint: `${handle.apiUrl}/token`,
      registration_endpoint: `${handle.apiUrl}/register`,
    });

    const publicMetadata = `${await (await fetch(`${handle.apiUrl}/.well-known/oauth-protected-resource/mcp`)).text()}${await (await fetch(`${handle.apiUrl}/.well-known/oauth-authorization-server`)).text()}`;
    expect(publicMetadata).not.toContain(ownerAccessSecret);
    expect(publicMetadata).not.toContain(controlSecret);

    const unauthenticatedMcp = await fetch(`${handle.apiUrl}/mcp`);
    expect(unauthenticatedMcp.status).toBe(401);
    expect(unauthenticatedMcp.headers.get('www-authenticate')).toBe('Bearer');
    const unauthenticatedMcpPro = await fetch(`${handle.apiUrl}/mcp-pro`);
    expect(unauthenticatedMcpPro.status).toBe(401);
    expect(unauthenticatedMcpPro.headers.get('www-authenticate')).toBe('Bearer');
    expect((await fetch(`${handle.apiUrl}/projects`)).status).toBe(403);
    expect((await fetch(`${handle.apiUrl}/missions`)).status).toBe(403);
    expect((await fetch(`${handle.apiUrl}/capabilities/file/read`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetPath: 'README.md' }),
    })).status).toBe(403);
    expect((await fetch(`${handle.apiUrl}/readyz`)).status).toBe(403);
  });

  it('scopes bearer challenges to MCP owner authentication and preserves post-auth denials', async () => {
    const ownerAccessSecret = 'test-owner-access-secret-that-is-not-public';
    const capabilities = {
      execute: async () => ({ status: 'denied', reason: 'Policy denied the requested capability' }),
    } as unknown as CapabilityService;
    handle = await startRuntimeServer({
      identity,
      state: {} as RuntimeState,
      capabilities,
      missionBroker: {} as MissionBrokerService,
      health: () => ({
        status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: identity.runtimeId, instanceId: identity.instanceId,
        pid: identity.pid, uptimeMs: 1, authority: 'owned', connectedClients: 0, connectedSessions: 0,
        agentExecutorType: 'local-development-executor', productionModelConnected: false, apiUrl: '', mcpUrl: '',
      }),
      doctor: async () => ({ status: 'pass', checks: [] }),
      isShuttingDown: () => false,
      controlSecret: 'test-control-secret-that-is-not-public',
      ownerAccessSecret,
      requestShutdown: () => undefined,
    }, 0);

    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
    } as const;
    const unauthenticated = await fetch(`${handle.apiUrl}/mcp`, request);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer');

    const invalid = await fetch(`${handle.apiUrl}/mcp`, {
      ...request, headers: { ...request.headers, authorization: 'Bearer invalid-owner-secret' },
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('www-authenticate')).toBe('Bearer');

    const discovered = await fetch(`${handle.apiUrl}/mcp`, {
      ...request, headers: { ...request.headers, authorization: `Bearer ${ownerAccessSecret}` },
    });
    expect(discovered.status).toBe(200);
    expect(await discovered.json()).toMatchObject({ result: { protocolVersion: '2026-07-28' } });

    const proUnauthenticated = await fetch(`${handle.apiUrl}/mcp-pro`, request);
    expect(proUnauthenticated.status).toBe(401);
    const proDiscovered = await fetch(`${handle.apiUrl}/mcp-pro`, {
      ...request, headers: { ...request.headers, authorization: `Bearer ${ownerAccessSecret}` },
    });
    expect(proDiscovered.status).toBe(200);
    expect(await proDiscovered.json()).toMatchObject({ result: { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } });
    const proListed = await fetch(`${handle.apiUrl}/mcp-pro`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: `Bearer ${ownerAccessSecret}`,
        'MCP-Protocol-Version': '2026-07-28', 'x-iris-client-id': 'chatgpt-pro',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(proListed.status).toBe(200);
    expect((await proListed.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual([
      'list_projects', 'project_info', 'git_status', 'file_read', 'search',
    ]);

    const policyDenied = await fetch(`${handle.apiUrl}/capabilities/file/read`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ownerAccessSecret}`,
        'x-iris-client-id': 'client-a',
        'x-iris-session-id': 'session-a',
      },
      body: JSON.stringify({ targetPath: '/tmp/denied' }),
    });
    expect(policyDenied.status).toBe(403);
    expect(policyDenied.headers.get('www-authenticate')).toBeNull();

    const invalidHostStatus = await requestStatus(handle.port, '/mcp', {
      authorization: `Bearer ${ownerAccessSecret}`,
      host: 'example.test',
    });
    expect(invalidHostStatus).toBe(403);
    const invalidOrigin = await fetch(`${handle.apiUrl}/mcp`, {
      ...request, headers: { ...request.headers, authorization: `Bearer ${ownerAccessSecret}`, origin: 'https://example.test' },
    });
    expect(invalidOrigin.status).toBe(403);
    const crossSite = await fetch(`${handle.apiUrl}/mcp`, {
      ...request, headers: { ...request.headers, authorization: `Bearer ${ownerAccessSecret}`, 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
  });

  it('rejects Hermes mission MCP requests without the mission-scoped bridge credential', async () => {
    const ownerAccessSecret = 'test-owner-access-secret-that-is-not-public';
    handle = await startRuntimeServer({
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
      controlSecret: 'test-control-secret-that-is-not-public',
      ownerAccessSecret,
      requestShutdown: () => undefined,
    }, 0);
    const missionId = randomUUID();
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    } as const;
    expect((await fetch(`${handle.apiUrl}/hermes-mcp/${missionId}`, init)).status).toBe(403);
    expect((await fetch(`${handle.apiUrl}/hermes-mcp/${missionId}`, {
      ...init, headers: { ...init.headers, authorization: 'Bearer wrong-mission-token' },
    })).status).toBe(403);
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

function requestStatus(port: number, pathname: string, headers: Record<string, string>): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: LOOPBACK_ADDRESS, port, path: pathname, headers }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}
