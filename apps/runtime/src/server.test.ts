import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createRuntimeServer, LOOPBACK_ADDRESS, requireLoopbackAddress } from './server.js';

let server: Server | undefined;
afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe('runtime listener safety', () => {
  it('accepts only the IPv4 loopback address', () => {
    expect(requireLoopbackAddress(LOOPBACK_ADDRESS)).toBe(LOOPBACK_ADDRESS);
    expect(() => requireLoopbackAddress('0.0.0.0')).toThrow();
    expect(() => requireLoopbackAddress('192.168.1.10')).toThrow();
    expect(() => requireLoopbackAddress('localhost')).toThrow();
  });

  it('serves health from a loopback listener', async () => {
    server = createRuntimeServer();
    await new Promise<void>((resolve) => server!.listen(0, LOOPBACK_ADDRESS, resolve));
    const bound = server.address();
    if (typeof bound !== 'object' || bound === null) throw new Error('Expected TCP listener');
    const response = await fetch(`http://${LOOPBACK_ADDRESS}:${bound.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', version: '0.0.0', platform: 'darwin' });
  });
});
