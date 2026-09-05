import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('runtime machine, client, and session state', () => {
  it('keeps default project machine-shared and current project session-scoped', async () => {
    const dataRoot = await temp('iris-state-data-');
    const firstRoot = await temp('iris-state-project-a-');
    const secondRoot = await temp('iris-state-project-b-');
    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    const firstProject = await state.registerProject('First', firstRoot);
    const secondProject = await state.registerProject('Second', secondRoot);
    await state.setDefaultProject(firstProject.id);

    const firstSession = state.createSession('client-a');
    const secondSession = state.createSession('client-b');
    await state.setSessionCurrentProject(firstSession.id, 'client-a', firstProject.id);
    await state.setSessionCurrentProject(secondSession.id, 'client-b', secondProject.id);

    expect(await state.getDefaultProjectId()).toBe(firstProject.id);
    expect(state.getSessionForClient(firstSession.id, 'client-a').currentProjectId).toBe(firstProject.id);
    expect(state.getSessionForClient(secondSession.id, 'client-b').currentProjectId).toBe(secondProject.id);
    expect(state.listClients()).toHaveLength(2);
  });

  it('supports concurrent agent roles on one daemon without sharing session identity', async () => {
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-agent-state-')));
    const roles = ['planner', 'implementer', 'reviewer', 'security', 'explorer'] as const;
    const sessions = roles.map((role) => state.createSession(`client-${role}`, `agent-${role}`, role));

    expect(new Set(sessions.map((session) => session.agentId))).toEqual(new Set(roles.map((role) => `agent-${role}`)));
    expect(new Set(sessions.map((session) => session.agentRole))).toEqual(new Set(roles));
    expect(new Set(sessions.map((session) => session.id)).size).toBe(roles.length);
    expect(state.listClients()).toHaveLength(roles.length);
  });

  it('lists only sessions owned by the requesting client so reconnect can resume without cross-client leakage', async () => {
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-state-data-')));
    const first = state.createSession('client-a', 'owner-web', 'owner');
    const second = state.createSession('client-a', 'owner-web', 'owner');
    state.createSession('client-b', 'other-web', 'owner');

    expect(state.listSessionsForClient('client-a').map((session) => session.id)).toEqual([first.id, second.id]);
    expect(state.listSessionsForClient('client-b')).toHaveLength(1);
  });

  it('prevents one client from operating another client session', async () => {
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-state-data-')));
    const session = state.createSession('client-a');
    expect(() => state.getSessionForClient(session.id, 'client-b')).toThrowError(expect.objectContaining({ code: 'CONTROL_DENIED' }));
    await expect(state.setSessionCurrentProject(session.id, 'client-b', null)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  });

  it('registers canonical existing non-root directories only and never scans implicitly', async () => {
    const dataRoot = await temp('iris-state-data-');
    const projectRoot = await temp('iris-state-project-');
    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    await expect(state.registerProject('Project', 'relative/path')).rejects.toMatchObject({ code: 'INVALID_PROJECT_PATH' });
    await expect(state.registerProject('Root', path.parse(projectRoot).root)).rejects.toMatchObject({ code: 'INVALID_PROJECT_PATH' });
    const project = await state.registerProject('Project', projectRoot);
    expect((await state.listProjects()).map((entry) => entry.id)).toEqual([project.id]);
    expect((await state.registerProject('Duplicate name ignored', projectRoot)).id).toBe(project.id);
  });

  it('serializes concurrent machine-shared registry mutations without lost updates', async () => {
    const dataRoot = await temp('iris-state-data-');
    const firstRoot = await temp('iris-concurrent-project-a-');
    const secondRoot = await temp('iris-concurrent-project-b-');
    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    const [first, second] = await Promise.all([
      state.registerProject('First', firstRoot),
      state.registerProject('Second', secondRoot),
    ]);
    expect(new Set((await state.listProjects()).map((project) => project.id))).toEqual(new Set([first.id, second.id]));
  });
});

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
