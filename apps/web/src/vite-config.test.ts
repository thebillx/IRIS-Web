import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProxyOptions, UserConfig } from 'vite';
import config, { managedRuntimeProxy } from '../vite.config.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('Vite runtime proxy', () => {
  it.each(['https://example.com', 'http://user:secret@127.0.0.1:43112', 'http://127.0.0.1:43112/other'])('rejects a non-local or credential-bearing control target %s', async (target) => {
    vi.stubEnv('IRIS_SUPERVISOR_URL', target);
    vi.resetModules();
    await expect(import('../vite.config.js')).rejects.toThrow('local HTTP Supervisor origin');
  });
  it('routes Owner MCP controls to the persistent Supervisor independently of workload routes', () => {
    const proxy = (config as UserConfig).server!.proxy!;
    const control = proxy['/control/mcp'] as ProxyOptions;
    expect(control.target).toBe(process.env.IRIS_SUPERVISOR_URL ?? 'http://127.0.0.1:43112');
    expect(control.rewrite!('/control/mcp')).toBe('/mcp');
    expect(control.rewrite!('/control/mcp?trace=1')).toBe('/mcp?trace=1');
    expect(proxy['/health']).toBe(process.env.IRIS_RUNTIME_URL ?? 'http://127.0.0.1:43110');
  });
  it('proxies mission routes to the runtime', () => {
    expect(config).toMatchObject({
      server: {
        proxy: {
          '/missions': expect.any(String),
        },
      },
    });
  });
});

class FixtureResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  headersSent = false;
  statusCode = 200;
  body = '';
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  end(body = '') { this.body = body; this.writableEnded = true; this.emit('finish'); return this; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}

function proxyRequest(authorization: unknown = `Bearer ${'a'.repeat(43)}`, url = '/sessions') {
  return Object.assign(new EventEmitter(), { headers: { authorization }, url, method: 'POST', aborted: false }) as unknown as IncomingMessage;
}

const runtimeId = '11111111-1111-4111-8111-111111111111';
const instanceId = '22222222-2222-4222-8222-222222222222';
function runningStatus(port: number) {
  const apiUrl = `http://127.0.0.1:${port}`;
  const endpoint = { schemaVersion: 1, runtimeId, instanceId, pid: 123, apiUrl, mcpUrl: `${apiUrl}/mcp`, startedAt: '2026-10-25T10:00:00.000Z' };
  return { state: 'running', endpoint, health: { ...endpoint, status: 'ready', authority: 'owned' } };
}

function stubDiscovery(reply: (authorization: string) => unknown | Promise<unknown>) {
  return vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    expect(String(input)).toBe('http://127.0.0.1:43112/mcp');
    expect(init.redirect).toBe('error');
    const body = JSON.parse(String(init.body));
    expect(body.params).toEqual({ name: 'runtime_status', arguments: {} });
    const result = await reply(new Headers(init.headers).get('authorization')!);
    return result instanceof Response ? result : Response.json({ jsonrpc: '2.0', id: body.id, result: { isError: false, structuredContent: result } });
  }));
}

function fixtureProxy(onForward?: (request: IncomingMessage, response: FixtureResponse, options: Record<string, unknown>, reject: () => void) => void) {
  const options = managedRuntimeProxy('http://127.0.0.1:43112');
  const forwarded: Array<{ request: IncomingMessage; options: Record<string, unknown> }> = [];
  const web = vi.fn((request: IncomingMessage, response: FixtureResponse, target: Record<string, unknown>, reject: () => void) => {
    forwarded.push({ request, options: target });
    if (onForward === undefined) response.end('forwarded');
    else onForward(request, response, target, reject);
  });
  options.configure!({ web } as unknown as Parameters<NonNullable<ProxyOptions['configure']>>[0], options);
  const run = async (request = proxyRequest()) => {
    const response = new FixtureResponse();
    const handled = await options.bypass!(request, response as unknown as ServerResponse, options);
    expect(handled).toBe(request.url);
    expect(response.writableEnded || response.destroyed).toBe(true);
    return response;
  };
  return { run, forwarded, options };
}

describe('managed Runtime proxy discovery', () => {
  it('resolves changed Runtime ports for each request without a shared mutable target', async () => {
    let port = 43110;
    stubDiscovery(() => runningStatus(port));
    const proxy = fixtureProxy();
    await proxy.run();
    port = 44221;
    await proxy.run();
    expect(proxy.forwarded.map((call) => call.options.target)).toEqual(['http://127.0.0.1:43110', 'http://127.0.0.1:44221']);
    expect(proxy.options.target).toBeUndefined();
    expect(proxy.forwarded[0]?.options.headers).toEqual({ authorization: `Bearer ${'a'.repeat(43)}`, 'x-iris-runtime-id': runtimeId, 'x-iris-instance-id': instanceId });
  });

  it('isolates concurrent target and credential discovery even when replies arrive out of order', async () => {
    let finishFirst: ((result: unknown) => void) | undefined;
    stubDiscovery((authorization) => authorization === `Bearer ${'a'.repeat(43)}` ? new Promise((resolve) => { finishFirst = resolve; }) : runningStatus(44222));
    const proxy = fixtureProxy();
    const first = proxy.run(proxyRequest());
    const second = proxy.run(proxyRequest(`Bearer ${'b'.repeat(43)}`));
    await second;
    finishFirst!(runningStatus(44221));
    await first;
    expect(proxy.forwarded.map((call) => call.options.target)).toEqual(['http://127.0.0.1:44222', 'http://127.0.0.1:44221']);
    expect(proxy.forwarded.map((call) => (call.options.headers as Record<string, string>).authorization)).toEqual([`Bearer ${'b'.repeat(43)}`, `Bearer ${'a'.repeat(43)}`]);
  });

  it.each(['stopped', 'stale', 'indeterminate'])('never falls back to a previous port when Runtime is %s', async (state) => {
    stubDiscovery(() => ({ ...runningStatus(43110), state }));
    const proxy = fixtureProxy();
    const response = await proxy.run();
    expect(response.statusCode).toBe(503);
    expect(proxy.forwarded).toHaveLength(0);
  });

  it.each(['host', 'path', 'mcp', 'runtime', 'instance', 'pid', 'authority', 'health', 'schema'])('rejects inconsistent or unsafe %s metadata', async (field) => {
    const status = runningStatus(43110);
    if (field === 'host') status.endpoint.apiUrl = 'http://example.com:43110';
    if (field === 'path') status.endpoint.apiUrl = 'http://127.0.0.1:43110/other';
    if (field === 'mcp') status.endpoint.mcpUrl = 'http://127.0.0.1:43111/mcp';
    if (field === 'runtime') status.health.runtimeId = '33333333-3333-4333-8333-333333333333';
    if (field === 'instance') status.health.instanceId = '33333333-3333-4333-8333-333333333333';
    if (field === 'pid') status.health.pid = 456;
    if (field === 'authority') status.health.authority = 'foreign';
    if (field === 'health') status.health.apiUrl = 'http://127.0.0.1:43111';
    if (field === 'schema') status.endpoint.schemaVersion = 2;
    stubDiscovery(() => status);
    const proxy = fixtureProxy();
    const response = await proxy.run();
    expect(response.statusCode).toBe(502);
    expect(response.body).toContain('RUNTIME_IDENTITY_UNVERIFIED');
    expect(proxy.forwarded).toHaveLength(0);
  });

  it.each([undefined, '', 'Basic wrong-scheme', 'Bearer ', `Bearer ${'a'.repeat(513)}`, `Bearer ${'a'.repeat(43)}\n`, ['Bearer duplicate']])('rejects malformed credentials before contacting Supervisor: %s', async (authorization) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const proxy = fixtureProxy();
    const request = proxyRequest(); request.headers.authorization = authorization as string;
    const response = await proxy.run(request);
    expect(response.statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(proxy.forwarded).toHaveLength(0);
  });

  it.each(['unauthorized', 'unavailable', 'malformed', 'oversize', 'tool-error', 'network'])('fails closed and redacts Supervisor %s responses', async (failure) => {
    const secret = 'sensitive-upstream-diagnostic';
    stubDiscovery(() => {
      if (failure === 'network') throw new Error(secret);
      if (failure === 'unauthorized') return new Response(secret, { status: 401 });
      if (failure === 'unavailable') return new Response(secret, { status: 503 });
      if (failure === 'malformed') return new Response('{');
      if (failure === 'oversize') return new Response('x'.repeat(65_537));
      return Response.json({ jsonrpc: '2.0', id: 'wrong', result: { isError: true, structuredContent: { error: secret } } });
    });
    const proxy = fixtureProxy();
    const response = await proxy.run();
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain('a'.repeat(43));
    expect(proxy.forwarded).toHaveLength(0);
  });

  it('streams with a per-request target and reports uncertain forwarding without a retry', async () => {
    stubDiscovery(() => runningStatus(43110));
    const proxy = fixtureProxy((_request, _response, options, reject) => {
      expect(options).toMatchObject({ target: 'http://127.0.0.1:43110', followRedirects: false, proxyTimeout: 60_000, timeout: 60_000 });
      reject();
    });
    const response = await proxy.run();
    expect(response.statusCode).toBe(502);
    expect(response.body).toContain('RUNTIME_REQUEST_OUTCOME_UNKNOWN');
    expect(proxy.forwarded).toHaveLength(1);
  });

  it('selects managed routes only when a Supervisor origin is explicitly configured', async () => {
    vi.stubEnv('IRIS_RUNTIME_URL', 'http://127.0.0.1:49999');
    vi.stubEnv('IRIS_SUPERVISOR_URL', 'http://127.0.0.1:43112'); vi.resetModules();
    const managed = (await import('../vite.config.js')).default as UserConfig;
    expect((managed.server!.proxy!['/sessions'] as ProxyOptions).bypass).toEqual(expect.any(Function));
    expect((managed.server!.proxy!['/sessions'] as ProxyOptions).target).toBeUndefined();
    vi.stubEnv('IRIS_SUPERVISOR_URL', undefined); vi.resetModules();
    const standalone = (await import('../vite.config.js')).default as UserConfig;
    expect(standalone.server!.proxy!['/sessions']).toBe('http://127.0.0.1:49999');
  });
});
