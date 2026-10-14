import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import config, { createSupervisorBridge, parseSupervisorBridgeIdentity, validateSupervisorWebRequest } from '../vite.config.js';

describe('Vite runtime proxy', () => {
  it('proxies mission routes to the runtime', () => {
    expect(config).toMatchObject({
      server: {
        proxy: {
          '/missions': expect.any(String),
          '/jobs': expect.any(String),
        },
      },
    });
    expect(config.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'iris-supervisor-owner-bridge' })]));
  });

  it('allows only the five owner workload calls and requires matching MCP headers', () => {
    const request = { method: 'tools/call', params: { name: 'workload_on', arguments: {} } };
    expect(validateSupervisorWebRequest(request, { method: 'tools/call', name: 'workload_on' })).toBeNull();
    expect(validateSupervisorWebRequest({ ...request, params: { name: 'admin_recycle', arguments: {} } }, { method: 'tools/call', name: 'admin_recycle' })).toContain('not available');
    expect(validateSupervisorWebRequest(request, { method: 'tools/call', name: 'workload_off' })).toContain('headers');
    expect(validateSupervisorWebRequest({ method: 'tools/list' }, { method: 'tools/list', name: undefined })).toContain('only tools/call');
  });

  it('parses only a verified current connector identity', () => {
    expect(parseSupervisorBridgeIdentity({ state: 'VERIFIED', runtimeId: 'runtime-a', deploymentEpoch: 4, tunnelBinding: { mode: 'FULL' } }))
      .toEqual({ connectorProfile: 'FULL', runtimeId: 'runtime-a', deploymentEpoch: 4 });
    expect(parseSupervisorBridgeIdentity({ state: 'SOURCE_IDENTITY_UNVERIFIED', runtimeId: 'runtime-a', deploymentEpoch: 4, tunnelBinding: { mode: 'FULL' } })).toBeNull();
    expect(parseSupervisorBridgeIdentity({ state: 'VERIFIED', runtimeId: 'runtime-a', deploymentEpoch: 4, tunnelBinding: { mode: 'ADMIN' } })).toBeNull();
  });

  it('does not inject an owner credential into unauthenticated HTML', () => {
    const bridge = createSupervisorBridge({ IRIS_OWNER_ACCESS_SECRET: 'a'.repeat(48) });
    expect('transformIndexHtml' in bridge).toBe(false);
    expect(JSON.stringify(bridge)).not.toContain('a'.repeat(48));
  });

  it('forwards trusted identity headers from the Supervisor and ignores browser overrides', async () => {
    let forwarded: Record<string, string | string[] | undefined> = {};
    const control = createServer((request, response) => {
      if (request.url === '/identity') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ state: 'VERIFIED', runtimeId: 'runtime-a', deploymentEpoch: 4, tunnelBinding: { mode: 'FULL' } }));
        return;
      }
      forwarded = request.headers;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { workloadState: 'ON' } } }));
    });
    await listen(control);
    const controlAddress = control.address();
    if (typeof controlAddress !== 'object' || controlAddress === null) throw new Error('control server did not bind');
    const handler = await bridgeHandler(`http://127.0.0.1:${controlAddress.port}`);
    const request = await post(handler, {
      authorization: 'Bearer owner-secret',
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': 'workload_on',
      'mcp-protocol-version': '2025-06-18',
      'x-iris-connector-profile': 'PRO',
      'x-iris-deployment-epoch': '999',
      'x-iris-runtime-id': 'browser-controlled',
    });
    expect(request.status).toBe(200);
    expect(forwarded['x-iris-connector-profile']).toBe('FULL');
    expect(forwarded['x-iris-deployment-epoch']).toBe('4');
    expect(forwarded['x-iris-runtime-id']).toBe('runtime-a');
    await close(control);
  });

  it('fails closed when the Supervisor identity is absent', async () => {
    const control = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ state: 'SOURCE_IDENTITY_UNVERIFIED' }));
    });
    await listen(control);
    const address = control.address();
    if (typeof address !== 'object' || address === null) throw new Error('control server did not bind');
    const handler = await bridgeHandler(`http://127.0.0.1:${address.port}`);
    const response = await post(handler, {
      authorization: 'Bearer owner-secret',
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': 'workload_on',
      'mcp-protocol-version': '2025-06-18',
    });
    expect(response.status).toBe(503);
    await close(control);
  });
});

async function bridgeHandler(controlUrl: string): Promise<(request: IncomingMessage, response: ServerResponse, next: () => void) => void> {
  let handler: ((request: IncomingMessage, response: ServerResponse, next: () => void) => void) | undefined;
  createSupervisorBridge({
    IRIS_SUPERVISOR_CONTROL_URL: controlUrl,
    IRIS_OWNER_ACCESS_SECRET: 'owner-secret',
    IRIS_SUPERVISOR_CONTROL_SECRET: 'supervisor-secret',
  }).configureServer({ middlewares: { use: (_path, middleware) => { handler = middleware; } } });
  if (handler === undefined) throw new Error('bridge middleware was not registered');
  return handler;
}

async function post(handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void, headers: Record<string, string>): Promise<Response> {
  const server = createServer((request, response) => {
    request.url = request.url?.replace('/supervisor-control', '') || '/';
    handler(request, response, () => { response.writeHead(404); response.end(); });
  });
  await listen(server);
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('bridge server did not bind');
  const response = await fetch(`http://127.0.0.1:${address.port}/supervisor-control/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workload_on', arguments: {} } }),
  });
  await close(server);
  return response;
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
