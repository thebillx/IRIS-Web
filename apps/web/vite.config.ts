import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const supervisorUrl = process.env.IRIS_SUPERVISOR_URL ?? 'http://127.0.0.1:43112';
const supervisorTarget = new URL(supervisorUrl);
if (supervisorTarget.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(supervisorTarget.hostname) || supervisorTarget.username || supervisorTarget.password || supervisorTarget.pathname !== '/' || supervisorTarget.search || supervisorTarget.hash) throw new Error('Owner controls require a local HTTP Supervisor origin');
const runtimeUrl = process.env.IRIS_RUNTIME_URL ?? 'http://127.0.0.1:43110';
const workloadRoutes = ['/health', '/doctor', '/status', '/projects', '/sessions', '/missions', '/permissions', '/approvals', '/capabilities', '/mcp'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ObjectValue = Record<string, unknown>;
type RuntimeTarget = { origin: string; runtimeId: string; instanceId: string };

class RoutingFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super('Verified Runtime routing is unavailable. No request was retried.'); }
}

function isObject(value: unknown): value is ObjectValue { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function runtimeOrigin(value: unknown): string {
  if (typeof value !== 'string' || !/^http:\/\/(127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(value)) throw new RoutingFailure(502, 'RUNTIME_IDENTITY_UNVERIFIED');
  const url = new URL(value);
  if (url.origin !== value || Number(url.port) < 1 || Number(url.port) > 65_535) throw new RoutingFailure(502, 'RUNTIME_IDENTITY_UNVERIFIED');
  return url.origin;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new RoutingFailure(502, 'SUPERVISOR_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65_536) throw new RoutingFailure(502, 'SUPERVISOR_RESPONSE_INVALID');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => undefined); }
}

async function resolveRuntimeTarget(origin: string, authorization: string, signal: AbortSignal): Promise<RuntimeTarget> {
  const id = randomUUID();
  const response = await fetch(new URL('/mcp', origin).href, {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization, 'content-type': 'application/json', accept: 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'runtime_status' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'runtime_status', arguments: {} } }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw response.status === 401 || response.status === 403 ? new RoutingFailure(401, 'OWNER_ACCESS_REJECTED') : new RoutingFailure(503, 'SUPERVISOR_UNAVAILABLE');
  }
  const body = await boundedJson(response);
  if (!isObject(body) || body.jsonrpc !== '2.0' || body.id !== id || !isObject(body.result) || body.result.isError !== false || !isObject(body.result.structuredContent)) throw new RoutingFailure(502, 'SUPERVISOR_RESPONSE_INVALID');
  const status = body.result.structuredContent;
  if (status.state !== 'running') throw new RoutingFailure(503, status.state === 'stopped' ? 'RUNTIME_NOT_RUNNING' : 'RUNTIME_UNAVAILABLE');
  const endpoint = status.endpoint;
  const health = status.health;
  if (!isObject(endpoint) || !isObject(health)) throw new RoutingFailure(502, 'RUNTIME_IDENTITY_UNVERIFIED');
  const target = runtimeOrigin(endpoint.apiUrl);
  if (endpoint.schemaVersion !== 1 || typeof endpoint.runtimeId !== 'string' || !uuid.test(endpoint.runtimeId) || typeof endpoint.instanceId !== 'string' || !uuid.test(endpoint.instanceId)
    || !Number.isSafeInteger(endpoint.pid) || Number(endpoint.pid) <= 1 || typeof endpoint.startedAt !== 'string' || !Number.isFinite(Date.parse(endpoint.startedAt))
    || endpoint.mcpUrl !== `${target}/mcp` || health.authority !== 'owned' || health.status !== 'ready'
    || health.runtimeId !== endpoint.runtimeId || health.instanceId !== endpoint.instanceId || health.pid !== endpoint.pid || health.apiUrl !== target || health.mcpUrl !== endpoint.mcpUrl) throw new RoutingFailure(502, 'RUNTIME_IDENTITY_UNVERIFIED');
  return { origin: target, runtimeId: endpoint.runtimeId, instanceId: endpoint.instanceId };
}

function failRouting(response: ServerResponse, failure: RoutingFailure): void {
  if (response.writableEnded || response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(failure.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
}

/** Resolves each managed request independently; a previous Runtime port is never a fallback. */
export function managedRuntimeProxy(origin: string): ProxyOptions {
  let proxy: Parameters<NonNullable<ProxyOptions['configure']>>[0] | undefined;
  return {
    configure(server) { proxy = server; },
    async bypass(request, response) {
      if (response === undefined) return false;
      const disconnected = new AbortController();
      const abort = () => disconnected.abort();
      request.once('aborted', abort);
      response.once('close', abort);
      try {
        const authorization = request.headers.authorization;
        if (typeof authorization !== 'string' || authorization.length > 512 || !/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(authorization)) throw new RoutingFailure(401, 'OWNER_ACCESS_REQUIRED');
        const target = await resolveRuntimeTarget(origin, authorization, AbortSignal.any([disconnected.signal, AbortSignal.timeout(5_000)]));
        if (request.aborted || response.destroyed || response.writableEnded) return request.url ?? '/';
        if (proxy === undefined) throw new RoutingFailure(503, 'SUPERVISOR_UNAVAILABLE');
        await new Promise<void>((resolve) => {
          const done = () => { response.off('finish', done); response.off('close', done); resolve(); };
          response.once('finish', done);
          response.once('close', done);
          try {
            proxy!.web(request, response, {
              target: target.origin, changeOrigin: true, followRedirects: false, proxyTimeout: 60_000, timeout: 60_000,
              headers: { authorization, 'x-iris-runtime-id': target.runtimeId, 'x-iris-instance-id': target.instanceId },
            }, () => failRouting(response, new RoutingFailure(502, 'RUNTIME_REQUEST_OUTCOME_UNKNOWN')));
          } catch { failRouting(response, new RoutingFailure(502, 'RUNTIME_REQUEST_OUTCOME_UNKNOWN')); }
        });
      } catch (error) { failRouting(response, error instanceof RoutingFailure ? error : new RoutingFailure(503, 'SUPERVISOR_UNAVAILABLE')); }
      finally { request.off('aborted', abort); response.off('close', abort); }
      // Vite treats a string plus an ended response as handled; its static proxy never runs.
      return request.url ?? '/';
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/control/mcp': { target: supervisorUrl, rewrite: (url) => url.replace(/^\/control\/mcp(?=\?|$)/, '/mcp') },
      // Standalone development has no managed Supervisor contract and keeps its explicit Runtime target.
      ...Object.fromEntries(workloadRoutes.map((route) => [route, process.env.IRIS_SUPERVISOR_URL === undefined ? runtimeUrl : managedRuntimeProxy(supervisorUrl)])),
    },
  },
});
