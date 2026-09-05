import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon } from './daemon.js';
import { readOwnerAccessSecret } from './persistence.js';

const cleanup: string[] = [];
let ownerAccessToken = '';
afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('FULL_LOCAL_OWNER real local permission flow', () => {
  it('auto-executes project file work, audits decisions, denies outside/legacy scope, and restarts cleanly', async () => {
    const sourceRoot = await realpath(path.resolve(import.meta.dirname, '../../..'));
    const projectRoot = await mkdtemp(path.join(sourceRoot, '.iris-permission-smoke-'));
    cleanup.push(projectRoot);
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-permission-smoke-data-'));
    cleanup.push(dataRoot);
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-permission-smoke-outside-'));
    cleanup.push(outsideRoot);

    const daemon = await startDaemon({ dataRoot, preferredPort: 0 });
    ownerAccessToken = await readOwnerAccessSecret(dataRoot) ?? '';
    expect(ownerAccessToken).toMatch(/^[A-Za-z0-9_-]{40,128}$/);
    const api = daemon.apiUrl;
    try {
      const permissions = await requestJson<{ mode: string }>(`${api}/permissions`);
      expect(permissions.mode).toBe('FULL_LOCAL_OWNER');

      const session = await requestJson<{ id: string; clientId: string }>(`${api}/sessions`, {
        method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ clientId: 'smoke-client', agentId: 'agent-owner-smoke', agentRole: 'owner' }),
      });
      const project = await requestJson<{ id: string }>(`${api}/projects`, {
        method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'Smoke Project', rootPath: projectRoot }),
      });
      await requestJson(`${api}/sessions/${session.id}/current-project`, {
        method: 'PUT', headers: jsonHeaders({ 'x-iris-client-id': session.clientId }), body: JSON.stringify({ projectId: project.id }),
      });

      const target = path.join(projectRoot, 'owner-mode.txt');
      await capability(api, session, project.id, 'file/write', { targetPath: target, content: 'created' });
      await expect(readFile(target, 'utf8')).resolves.toBe('created');
      await capability(api, session, project.id, 'file/write', { targetPath: target, content: 'edited' });
      await expect(readFile(target, 'utf8')).resolves.toBe('edited');
      await capability(api, session, project.id, 'file/delete', { targetPath: target });
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });

      const audit = await requestJson<{ events: Array<{ capabilityId: string; agentId: string | null; decision: string; result: string }> }>(`${api}/permissions/audit?limit=50`);
      expect(audit.events.some((event) => event.capabilityId === 'file.write'
        && event.agentId === 'agent-owner-smoke'
        && event.decision === 'ALLOW_AUTO'
        && event.result === 'SUCCESS')).toBe(true);
      expect(JSON.stringify(audit)).not.toContain('created');
      expect(JSON.stringify(audit)).not.toContain('edited');

      const outsideTarget = path.join(outsideRoot, 'blocked.txt');
      const outside = await fetch(`${api}/capabilities/file/write`, {
        method: 'POST', headers: jsonHeaders({ 'x-iris-client-id': session.clientId, 'x-iris-session-id': session.id }),
        body: JSON.stringify({ projectId: project.id, targetPath: outsideTarget, content: 'blocked' }),
      });
      expect(outside.status).toBe(403);
      await expect(access(outsideTarget)).rejects.toMatchObject({ code: 'ENOENT' });

      const legacy = await fetch(`${api}/projects`, {
        method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'Legacy Reference', rootPath: '/Users/bill/iris-native-runtime' }),
      });
      expect([400, 403]).toContain(legacy.status);
      const projectsAfter = await requestJson<{ projects: Array<{ rootPath: string }> }>(`${api}/projects`);
      expect(projectsAfter.projects.some((entry) => entry.rootPath === '/Users/bill/iris-native-runtime')).toBe(false);
    } finally {
      await daemon.close();
    }

    const restarted = await startDaemon({ dataRoot, preferredPort: 0 });
    try {
      expect(restarted.identity.runtimeId).toBe(daemon.identity.runtimeId);
      expect(restarted.identity.instanceId).not.toBe(daemon.identity.instanceId);
      const projects = await requestJson<{ projects: Array<{ rootPath: string }> }>(`${restarted.apiUrl}/projects`);
      expect(projects.projects.some((entry) => entry.rootPath === projectRoot)).toBe(true);
    } finally {
      await restarted.close();
    }
  }, 30_000);
});

async function capability(
  api: string,
  session: { id: string; clientId: string },
  projectId: string,
  route: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return requestJson(`${api}/capabilities/${route}`, {
    method: 'POST',
    headers: jsonHeaders({ 'x-iris-client-id': session.clientId, 'x-iris-session-id': session.id }),
    body: JSON.stringify({ projectId, ...body }),
  });
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${ownerAccessToken}`, ...extra };
}

async function requestJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (ownerAccessToken.length > 0) headers.set('authorization', `Bearer ${ownerAccessToken}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
