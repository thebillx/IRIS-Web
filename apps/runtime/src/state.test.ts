import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('machine and session state scopes', () => {
  it('keeps default project machine-shared and current project session-scoped', async () => {
    const dataRoot = await temp('iris-state-data-');
    const projectAPath = await temp('iris-project-a-');
    const projectBPath = await temp('iris-project-b-');
    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    const projectA = await state.registerProject('A', projectAPath);
    const projectB = await state.registerProject('B', projectBPath);
    await state.setDefaultProject(projectA.id);

    const sessionA = state.createSession('client-a');
    const sessionB = state.createSession('client-b');
    await state.setSessionCurrentProject(sessionA.id, 'client-a', projectB.id);

    expect(await state.getDefaultProjectId()).toBe(projectA.id);
    expect(state.getSession(sessionA.id).currentProjectId).toBe(projectB.id);
    expect(state.getSession(sessionB.id).currentProjectId).toBeNull();
    expect(state.listClients()).toHaveLength(2);
    expect(state.listSessions()).toHaveLength(2);
  });

  it('rejects session operations attributed to a different client', async () => {
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-state-data-')));
    const session = state.createSession('client-a');
    expect(() => state.getSessionForClient(session.id, 'client-b')).toThrowError(expect.objectContaining({ code: 'CONTROL_DENIED' }));
    await expect(state.setSessionCurrentProject(session.id, 'client-b', null))
      .rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  });

  it('serializes concurrent machine-state mutations without losing projects', async () => {
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-state-data-')));
    const projectPaths = await Promise.all(Array.from({ length: 8 }, (_, index) => temp(`iris-project-${index}-`)));
    await Promise.all(projectPaths.map((rootPath, index) => state.registerProject(`Project ${index}`, rootPath)));
    expect(await state.listProjects()).toHaveLength(projectPaths.length);
  });

  it('registers only explicit existing absolute non-root directories and canonicalizes paths', async () => {
    const dataRoot = await temp('iris-state-data-');
    const projectPath = await temp('iris-project-');
    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    const project = await state.registerProject('Project', projectPath);
    expect(path.isAbsolute(project.rootPath)).toBe(true);
    await expect(state.registerProject('Bad', 'relative/path')).rejects.toMatchObject({ code: 'INVALID_PROJECT_PATH' });
    await expect(state.registerProject('Bad', path.join(projectPath, 'missing'))).rejects.toMatchObject({ code: 'INVALID_PROJECT_PATH' });
    await expect(state.registerProject('Root', path.parse(projectPath).root)).rejects.toMatchObject({ code: 'INVALID_PROJECT_PATH' });
  });
});
