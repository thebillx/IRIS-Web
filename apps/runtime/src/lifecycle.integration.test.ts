import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeRuntimeAuthority } from './authority.js';
import { runtimeChildEnvironment, runtimeStatus, startRuntime, stopRuntime } from './lifecycle.js';
import { MCP_PROTOCOL_VERSION } from './mcp.js';
import { loadOrCreateRuntimeId, readEndpoint, readOwnerAccessSecret, readRuntimeControl, writeEndpoint, writeRuntimeControl } from './persistence.js';
import { node24Path } from './node-runtime.js';

const roots: string[] = [];
let occupiedServer: Server | undefined;
let ownerAccessToken = '';

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

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (ownerAccessToken.length > 0) headers.set('authorization', `Bearer ${ownerAccessToken}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

describe('runtime lifecycle integration', () => {
  it('passes only the bounded local environment required by the child runtime', () => {
    const environment = runtimeChildEnvironment('/private/tmp/iris-runtime-test', 43110, {
      PATH: node24Path(), HOME: '/Users/test', TMPDIR: '/private/tmp', LANG: 'en_US.UTF-8',
      NODE_OPTIONS: '--require /tmp/untrusted.js', CLOUD_TOKEN: 'secret-value',
      IRIS_AGENT_EXECUTOR: 'openai', OPENAI_API_KEY: 'openai-test-secret', IRIS_OPENAI_MODEL: 'gpt-test-model',
    });
    expect(environment).toMatchObject({
      PATH: node24Path(), HOME: '/Users/test', TMPDIR: '/private/tmp', LANG: 'en_US.UTF-8',
      IRIS_RUNTIME_DATA_ROOT: '/private/tmp/iris-runtime-test', IRIS_RUNTIME_PORT: '43110',
      IRIS_AGENT_EXECUTOR: 'openai', OPENAI_API_KEY: 'openai-test-secret', IRIS_OPENAI_MODEL: 'gpt-test-model',
    });
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.CLOUD_TOKEN).toBeUndefined();

    const developmentEnvironment = runtimeChildEnvironment('/private/tmp/iris-runtime-test', 43110, {
      PATH: node24Path(),
      IRIS_AGENT_EXECUTOR: 'development', OPENAI_API_KEY: 'must-not-reach-child', IRIS_OPENAI_MODEL: 'must-not-reach-child',
    });
    expect(developmentEnvironment.IRIS_AGENT_EXECUTOR).toBe('development');
    expect(developmentEnvironment.OPENAI_API_KEY).toBeUndefined();
    expect(developmentEnvironment.IRIS_OPENAI_MODEL).toBeUndefined();
  });

  it('recovers a matching stale schema-v1 authority and endpoint that predates runtime control metadata', async () => {
    const dataRoot = await temp('iris-lifecycle-v1-stale-');
    const canonicalRoot = await canonicalDataRoot(dataRoot);
    const runtimeId = await loadOrCreateRuntimeId(canonicalRoot);
    const stale = {
      runtimeId,
      instanceId: randomUUID(),
      pid: 2_147_483_647,
      startedAt: '2026-09-01T00:00:00.000Z',
      platform: 'darwin' as const,
      version: '0.0.0' as const,
    };
    const authorityRoot = path.join(canonicalRoot, 'authority');
    await mkdir(authorityRoot, { mode: 0o700 });
    await writeFile(path.join(authorityRoot, 'owner.lock'), `${JSON.stringify({ schemaVersion: 1, identity: stale })}\n`, { mode: 0o600 });
    await writeEndpoint(canonicalRoot, {
      schemaVersion: 1,
      runtimeId: stale.runtimeId,
      instanceId: stale.instanceId,
      pid: stale.pid,
      startedAt: stale.startedAt,
      apiUrl: 'http://127.0.0.1:43119/',
      mcpUrl: 'http://127.0.0.1:43119/mcp',
    });

    await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'stale', reason: 'STALE_AUTHORITY' });
    const recovered = await startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 15_000 });
    expect(recovered.state).toBe('running');
    expect(recovered.endpoint?.runtimeId).toBe(runtimeId);
    expect(recovered.endpoint?.instanceId).not.toBe(stale.instanceId);
    await stopRuntime(dataRoot, 15_000);
  }, 30_000);

  it('keeps a live schema-v1 authority without process-instance evidence fail-closed even with matching endpoint metadata', async () => {
    const dataRoot = await temp('iris-lifecycle-v1-live-');
    const canonicalRoot = await canonicalDataRoot(dataRoot);
    const runtimeId = await loadOrCreateRuntimeId(canonicalRoot);
    const live = {
      runtimeId,
      instanceId: randomUUID(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      platform: 'darwin' as const,
      version: '0.0.0' as const,
    };
    const authorityRoot = path.join(canonicalRoot, 'authority');
    await mkdir(authorityRoot, { mode: 0o700 });
    await writeFile(path.join(authorityRoot, 'owner.lock'), `${JSON.stringify({ schemaVersion: 1, identity: live })}\n`, { mode: 0o600 });
    await writeEndpoint(canonicalRoot, {
      schemaVersion: 1,
      runtimeId: live.runtimeId,
      instanceId: live.instanceId,
      pid: live.pid,
      startedAt: live.startedAt,
      apiUrl: 'http://127.0.0.1:43120/',
      mcpUrl: 'http://127.0.0.1:43120/mcp',
    });

    await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'indeterminate' });
    await expect(startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 2_000 })).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
  });

  it('proves one daemon, safe port fallback, multi-session isolation, STOP_COMPLETE, persistence, and immediate restart', async () => {
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
    expect(new URL(first.endpoint.apiUrl).port).not.toBe(String(occupiedAddress.port));
    expect(first.health?.authority).toBe('owned');
    const firstRuntimeId = first.endpoint.runtimeId;
    const firstInstanceId = first.endpoint.instanceId;
    const firstPid = first.endpoint.pid;

    const canonicalRoot = await canonicalDataRoot(dataRoot);
    ownerAccessToken = await readOwnerAccessSecret(canonicalRoot) ?? '';
    if (ownerAccessToken.length === 0) throw new Error('Expected private owner access credential');
    const control = await readRuntimeControl(canonicalRoot);
    if (control === null) throw new Error('Expected private runtime control metadata');
    await rm(path.join(canonicalRoot, 'control.json'));
    await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'indeterminate' });
    await writeRuntimeControl(canonicalRoot, control);
    await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'running' });

    const attachedAgain = await startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 15_000 });
    expect(attachedAgain.endpoint?.instanceId).toBe(firstInstanceId);
    expect(attachedAgain.endpoint?.apiUrl).toBe(first.endpoint.apiUrl);

    const projectA = await registerExternalProject(first.endpoint.apiUrl, 'A', projectAPath);
    const projectB = await registerExternalProject(first.endpoint.apiUrl, 'B', projectBPath);
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
    const executedA = await json<{ executionState: string; interactions: Array<{ kind: string; text: string }> }>(`${first.endpoint.apiUrl}/sessions/${sessionA.id}/instructions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-iris-client-id': 'client-a' },
      body: JSON.stringify({ submissionId: 'lifecycle-interaction-a', instruction: 'Prove local interaction continuity' }),
    });
    expect(executedA.executionState).toBe('READY');
    expect(executedA.interactions.map((event) => event.kind)).toEqual(['user', 'assistant']);
    expect(executedA.interactions[0]?.text).toBe('Prove local interaction continuity');

    const clientASessions = await json<{ sessions: Array<{ id: string; interactions: Array<{ kind: string }> }> }>(`${first.endpoint.apiUrl}/sessions`, {
      headers: { 'x-iris-client-id': 'client-a' },
    });
    expect(clientASessions.sessions.map((session) => session.id)).toEqual([sessionA.id]);
    expect(clientASessions.sessions[0]?.interactions.map((event) => event.kind)).toEqual(['user', 'assistant']);

    const reattachedWithSessions = await startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 15_000 });
    expect(reattachedWithSessions.endpoint?.instanceId).toBe(firstInstanceId);
    const clientASessionsAfterReconnect = await json<{ sessions: Array<{ id: string; interactions: Array<{ kind: string }> }> }>(`${first.endpoint.apiUrl}/sessions`, {
      headers: { 'x-iris-client-id': 'client-a' },
    });
    expect(clientASessionsAfterReconnect.sessions.map((session) => session.id)).toEqual([sessionA.id]);
    expect(clientASessionsAfterReconnect.sessions[0]?.interactions.map((event) => event.kind)).toEqual(['user', 'assistant']);

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

    const crossClient = await fetch(`${first.endpoint.apiUrl}/sessions/${sessionA.id}`, { headers: { authorization: `Bearer ${ownerAccessToken}`, 'x-iris-client-id': 'client-b' } });
    expect(crossClient.status).toBe(403);

    const projects = await json<{ defaultProjectId: string | null }>(`${first.endpoint.apiUrl}/projects`);
    expect(projects.defaultProjectId).toBe(projectA.id);
    const health = await json<{ connectedClients: number; connectedSessions: number }>(`${first.endpoint.apiUrl}/health`);
    expect(health).toMatchObject({ connectedClients: 2, connectedSessions: 2 });
    const doctor = await json<{ status: string }>(`${first.endpoint.apiUrl}/doctor`);
    expect(doctor.status).toBe('pass');

    const mcp = await json<{ result: { tools: Array<{ name: string }> } }>(first.endpoint.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        'Mcp-Method': 'tools/list',
        authorization: `Bearer ${ownerAccessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.result.tools.map((tool) => tool.name)).toEqual([
      'runtime_status', 'list_projects', 'project_info', 'git_status', 'search', 'mission_list', 'session_open', 'session_get', 'session_close', 'workspace_select', 'mission_list_waiting_supervisor', 'mission_get', 'mission_events', 'mission_directive', 'mission_orchestrator_handoff', 'mission_create', 'mission_state_set', 'mission_task_create', 'mission_task_state_set', 'mission_action_prepare', 'mission_supervisor_gate_set', 'project_test_run', 'project_validation_run', 'git_local', 'remote_publish', 'file_read', 'file_write', 'file_delete', 'directory_create', 'directory_delete',
      'mission_start', 'mission_checkpoint', 'mission_resume', 'mission_cancel', 'mission_complete', 'mission_evidence',
    ]);

    const stopped = await stopRuntime(dataRoot, 15_000);
    expect(stopped.state).toBe('stopped');
    expect(await readEndpoint(await canonicalDataRoot(dataRoot))).toBeNull();
    expect(await probeRuntimeAuthority(await canonicalDataRoot(dataRoot))).toEqual({ state: 'unowned' });
    expect(pidExists(firstPid)).toBe(false);

    const second = await startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 15_000 });
    expect(second.state).toBe('running');
    expect(second.endpoint?.runtimeId).toBe(firstRuntimeId);
    expect(second.endpoint?.instanceId).not.toBe(firstInstanceId);
    if (second.endpoint === null) return;
    const persisted = await json<{ projects: Array<{ id: string }>; defaultProjectId: string | null }>(`${second.endpoint.apiUrl}/projects`);
    expect(persisted.projects.map((project) => project.id)).toEqual([projectA.id, projectB.id]);
    expect(persisted.defaultProjectId).toBe(projectA.id);
    const restartedSessions = await json<{ sessions: Array<{ id: string }> }>(`${second.endpoint.apiUrl}/sessions`, {
      headers: { 'x-iris-client-id': 'client-a' },
    });
    expect(restartedSessions.sessions).toEqual([]);
    await stopRuntime(dataRoot, 15_000);
  }, 45_000);
});

async function registerExternalProject(apiUrl: string, name: string, rootPath: string): Promise<{ id: string }> {
  const response = await fetch(`${apiUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerAccessToken}` },
    body: JSON.stringify({ name, rootPath }),
  });
  expect(response.status).toBe(409);
  const pending = await response.json() as { approval: { id: string } };
  const before = await json<{ projects: Array<{ rootPath: string }> }>(`${apiUrl}/projects`);
  expect(before.projects.some((project) => project.rootPath === rootPath)).toBe(false);
  return json<{ id: string }>(`${apiUrl}/approvals/${encodeURIComponent(pending.approval.id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'ALLOW_ONCE' }),
  });
}

async function canonicalDataRoot(dataRoot: string): Promise<string> {
  const { resolveRuntimeDataRoot, RUNTIME_DATA_ENV } = await import('./data-root.js');
  return resolveRuntimeDataRoot({ ...process.env, [RUNTIME_DATA_ENV]: dataRoot });
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { return !(typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'); }
}
