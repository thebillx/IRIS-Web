import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createServer as createViteServer } from 'vite';
import { managedRuntimeProxy } from '../vite.config';

it('routes actual Vite HTTP requests to the current instance and keeps Control reachable while workload is OFF', async () => {
  const servers: Server[] = [];
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-web-routing-'));
  const token = 'fixture-owner-routing-token';
  const runtimeId = randomUUID();
  let mutationCount = 0;
  const listen = async (server: Server) => {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Fixture listener unavailable');
    return `http://127.0.0.1:${address.port}`;
  };
  const runtime = async () => {
    const instanceId = randomUUID();
    const origin = await listen(createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}` || req.headers['x-iris-runtime-id'] !== runtimeId || req.headers['x-iris-instance-id'] !== instanceId) { res.writeHead(403).end(); return; }
      if (req.method === 'POST') { mutationCount++; req.socket.destroy(); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ instanceId }));
    }));
    return { origin, instanceId };
  };
  const first = await runtime(); const second = await runtime();
  let current: typeof first | null = first;
  const supervisor = await listen(createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    let body = ''; req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const rpc = JSON.parse(body) as { id: string };
      const endpoint = current === null ? null : { schemaVersion: 1, runtimeId, instanceId: current.instanceId, pid: process.pid, startedAt: new Date().toISOString(), apiUrl: current.origin, mcpUrl: `${current.origin}/mcp` };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { isError: false, structuredContent: { state: current === null ? 'stopped' : 'running', endpoint, health: endpoint === null ? null : { ...endpoint, authority: 'owned', status: 'ready' } } } }));
    });
  }));
  const vite = await createViteServer({ configFile: false, root, logLevel: 'silent', optimizeDeps: { noDiscovery: true }, server: { host: '127.0.0.1', port: 0, proxy: {
    '/projects': managedRuntimeProxy(supervisor),
    '/control/mcp': { target: supervisor, rewrite: () => '/mcp' },
  } } });
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (address == null || typeof address === 'string') throw new Error('Vite listener unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: `Bearer ${token}` };
    expect(await (await fetch(`${origin}/projects`, { headers })).json()).toEqual({ instanceId: first.instanceId });
    current = second;
    expect(await (await fetch(`${origin}/projects`, { headers })).json()).toEqual({ instanceId: second.instanceId });
    const lost = await fetch(`${origin}/projects`, { method: 'POST', headers, body: '{}' });
    expect(lost.status).toBe(502); expect(mutationCount).toBe(1);
    current = null;
    expect((await fetch(`${origin}/projects`, { headers })).status).toBe(503);
    const control = await fetch(`${origin}/control/mcp`, { method: 'POST', headers, body: JSON.stringify({ id: 'control' }) });
    expect(await control.json()).toMatchObject({ result: { structuredContent: { state: 'stopped' } } });
    expect(mutationCount).toBe(1);
  } finally {
    await vite.close();
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    await rm(root, { recursive: true, force: true });
  }
});
