import { createServer, type Server } from 'node:http';
import type { RuntimeHealth } from '@iris/domain';

export const LOOPBACK_ADDRESS = '127.0.0.1' as const;

export function requireLoopbackAddress(address: string): typeof LOOPBACK_ADDRESS {
  if (address !== LOOPBACK_ADDRESS) {
    throw new Error(`IRIS runtime must bind to ${LOOPBACK_ADDRESS}`);
  }
  return LOOPBACK_ADDRESS;
}

export function createRuntimeServer(): Server {
  return createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }

    const health: RuntimeHealth = { status: 'ready', version: '0.0.0', platform: 'darwin' };
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(health));
  });
}
