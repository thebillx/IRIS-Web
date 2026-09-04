import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeIdentity } from '@iris/domain';
import type { RuntimeState } from './state.js';
import { LOOPBACK_ADDRESS, requireLoopbackAddress, startRuntimeServer, type RuntimeServerHandle } from './server.js';

let handle: RuntimeServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
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
    }, 0);
    expect(handle.apiUrl.startsWith(`http://${LOOPBACK_ADDRESS}:`)).toBe(true);
    const response = await fetch(`${handle.apiUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ready', runtimeId: identity.runtimeId, instanceId: identity.instanceId });

    const rejected = await fetch(`${handle.apiUrl}/health`, { headers: { origin: 'https://example.test' } });
    expect(rejected.status).toBe(403);
  });
});
