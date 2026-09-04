import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeRuntimeAuthority } from './authority.js';
import { startRuntime, stopRuntime } from './lifecycle.js';
import { readEndpoint } from './persistence.js';

const roots: string[] = [];
let occupiedServer: Server | undefined;

afterEach(async () => {
  if (occupiedServer?.listening) await new Promise<void>((resolve, reject) => occupiedServer!.close((error) => error ? reject(error) : resolve()));
  occupiedServer = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

describe('runtime lifecycle integration', () => {
  it('proves one daemon, port fallback, multi-session isolation, STOP_COMPLETE, and immediate restart', async () => {
    const dataRoot = await temp('iris-lifecycle-data-');
    const projectAPath = await temp('iris-lifecycle-project-a-');
    const projectBPath = await temp('iris-lifecycle-project-b-');

    occupiedServer = createServer((_request, response) => response.end('occupied'));
    await new Promise<void>((resolve) => occupiedServer!.listen(0, '127.0.0.1', resolve));
    const occupiedAddress = occupiedServer.address();
    if (typeof occupiedAddress !== 'object' || occupiedAddress === null) throw new Error('Expected occupied TCP port');

    const first = await startRuntime({ dataRoot, preferredPort: occupiedAddress.port, startupDeadlineMs: 15_000 });
    expect(first.state).toBe('running');
    expect(first.endpoint).not.toBeNull();
    if (first.endpoint === null) return;
    expect('controlToken' in first.endpoint).toBe(false);
    expect(new URL(first.endpoint.apiUrl).port).not.toBe(String(occupiedAddress.port));
    expect(first.health?.authority).toBe('owned');
    const firstRuntimeId = first.endpoint.runtimeId;
    const firstInstanceId = first.endpoint.instanceId;
    const firstPid = first.endpoint.pid;

    const projectA = await json<{ id: string }>(`${first.endpoint.apiUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', rootPath: projectAPath }),
    });
    const projectB = await json<{ id: string }>(`${first.endpoint.apiUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'B', rootPath: projectBPath }),
    });
    await json(`${first.endpoint.apiUrl}/projects/default`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: projectA.id }),
    });

    const sessionA = await json<{ id: string; currentProjectId: string | null }>(`${first.endpoint.apiUrl}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'client-a' }),
    });
    const sessionB = await json<{ id: string; currentProjectId: string | null }>(`${first.endpoint.apiUrl}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'client-b' }),
    });
    const updatedA = await json<{ currentProjectId: string | null }>(`${first.endpoint.apiUrl}/sessions/${sessionA.id}/current-project`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-iris-client-id': 'client-a' },
      body: JSON.stringify({ projectId: projectB.id }),
    });
    const unchangedB = await json<{ currentProjectId: string | null }>(`${first.endpoint.apiUrl}/sessions/${sessionB.id}`, {
      headers: { 'x-iris-client-id': 'client-b' },
    });
    expect(updatedA.currentProjectId).toBe(projectB.id);
    expect(unchangedB.currentProjectId).toBeNull();

    const projects = await json<{ defaultProjectId: string | null }>(`${first.endpoint.apiUrl}/projects`);
    expect(projects.defaultProjectId).toBe(projectA.id);
    const health = await json<{ connectedClients: number; connectedSessions: number }>(`${first.endpoint.apiUrl}/health`);
    expect(health).toMatchObject({ connectedClients: 2, connectedSessions: 2 });
    const doctor = await json<{ status: string }>(`${first.endpoint.apiUrl}/doctor`);
    expect(doctor.status).toBe('pass');

    const mcp = await json<{ result: { tools: Array<{ name: string }> } }>(`${first.endpoint.mcpUrl}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.result.tools.map((tool) => tool.name)).toEqual(['runtime_status', 'list_projects']);

    const stopped = await stopRuntime(dataRoot, 15_000);
    expect(stopped.state).toBe('stopped');
    expect(await readEndpoint(dataRoot)).toBeNull();
    expect(await probeRuntimeAuthority(dataRoot)).toEqual({ state: 'unowned' });
    expect(pidExists(firstPid)).toBe(false);

    const second = await startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 15_000 });
    expect(second.state).toBe('running');
    expect(second.endpoint?.runtimeId).toBe(firstRuntimeId);
    expect(second.endpoint?.instanceId).not.toBe(firstInstanceId);
    await stopRuntime(dataRoot, 15_000);
  }, 45_000);
});

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { return !(typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'); }
}
