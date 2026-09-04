import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeIdentity } from '@iris/domain';
import type { RuntimeState } from './state.js';
import {
  LOOPBACK_ADDRESS,
  requireLoopbackAddress,
  startRuntimeServer,
  type RuntimeServerContext,
  type RuntimeServerHandle,
} from './server.js';

let handle: RuntimeServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const identity: RuntimeIdentity = {
  runtimeId: 'runtime-test',
  instanceId: 'instance-test',
  pid: process.pid,
  startedAt: '2026-09-04T00:00:00.000Z',
  platform: 'darwin',
  version: '0.0.0',
};

function context(overrides: Partial<RuntimeServerContext> = {}): RuntimeServerContext {
  return {
    identity,
    state: {} as RuntimeState,
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
      apiUrl: '',
      mcpUrl: '',
    }),
    doctor: async () => ({ status: 'pass', checks: [] }),
    isShuttingDown: () => false,
    controlToken: 'test-control-token-that-is-long-enough',
    requestShutdown: () => undefined,
    ...overrides,
  };
}

describe('runtime listener safety', () => {
  it('accepts only the IPv4 loopback address', () => {
    expect(requireLoopbackAddress(LOOPBACK_ADDRESS)).toBe(LOOPBACK_ADDRESS);
    expect(() => requireLoopbackAddress('0.0.0.0')).toThrow();
    expect(() => requireLoopbackAddress('192.168.1.10')).toThrow();
    expect(() => requireLoopbackAddress('localhost')).toThrow();
  });

  it('serves health from a loopback listener', async () => {
    handle = await startRuntimeServer(context(), 0);
    expect(handle.apiUrl.startsWith(`http://${LOOPBACK_ADDRESS}:`)).toBe(true);
    const response = await fetch(`${handle.apiUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ready',
      runtimeId: 'runtime-test',
      instanceId: 'instance-test',
    });
  });

  it('requires an instance-bound control token before requesting shutdown', async () => {
    const requestShutdown = vi.fn();
    handle = await startRuntimeServer(context({ requestShutdown }), 0);
    const body = JSON.stringify({ runtimeId: identity.runtimeId, instanceId: identity.instanceId });

    const denied = await fetch(`${handle.apiUrl}/control/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
      body,
    });
    expect(denied.status).toBe(403);
    expect(requestShutdown).not.toHaveBeenCalled();

    const accepted = await fetch(`${handle.apiUrl}/control/stop`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-control-token-that-is-long-enough',
      },
      body,
    });
    expect(accepted.status).toBe(202);
    await vi.waitFor(() => expect(requestShutdown).toHaveBeenCalledOnce());
  });

  it('rejects non-loopback browser origins', async () => {
    handle = await startRuntimeServer(context(), 0);
    const response = await fetch(`${handle.apiUrl}/health`, { headers: { origin: 'https://example.com' } });
    expect(response.status).toBe(403);
  });
});
