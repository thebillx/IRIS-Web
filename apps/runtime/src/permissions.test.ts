import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('permission policy engine', () => {
  it('FULL_LOCAL_OWNER auto-allows known LOW/MODERATE operations inside the live session project', async () => {
    const fixture = await policyFixture();
    const existing = path.join(fixture.projectRoot, 'existing.txt');
    await writeFile(existing, 'hello');

    await expect(fixture.engine.evaluate(fixture.request('file.read', existing))).resolves.toMatchObject({ decision: 'ALLOW_AUTO', projectId: fixture.project.id });
    await expect(fixture.engine.evaluate(fixture.request('file.write', path.join(fixture.projectRoot, 'new.txt')))).resolves.toMatchObject({ decision: 'ALLOW_AUTO' });
    await expect(fixture.engine.evaluate(fixture.request('file.delete', existing))).resolves.toMatchObject({ decision: 'ALLOW_AUTO' });
    await expect(fixture.engine.evaluate({ capabilityId: 'session.instruction.submit', clientId: fixture.session.clientId, sessionId: fixture.session.id }))
      .resolves.toMatchObject({ decision: 'ALLOW_AUTO', sessionId: fixture.session.id });
  });

  it('fails closed for outside-root, traversal, symlink escape, and session mismatch', async () => {
    const fixture = await policyFixture();
    const outside = await temp('iris-policy-outside-');
    const outsideFile = path.join(outside, 'outside.txt');
    await writeFile(outsideFile, 'outside');
    await symlink(outside, path.join(fixture.projectRoot, 'escape'));
    const hardlinkAlias = path.join(fixture.projectRoot, 'hardlink.txt');
    await link(outsideFile, hardlinkAlias);

    await expect(fixture.engine.evaluate(fixture.request('file.write', outsideFile))).resolves.toMatchObject({ decision: 'DENY' });
    await expect(fixture.engine.evaluate(fixture.request('file.write', path.join(fixture.projectRoot, '..', path.basename(outside), 'bad.txt')))).resolves.toMatchObject({ decision: 'DENY' });
    await expect(fixture.engine.evaluate(fixture.request('file.write', path.join(fixture.projectRoot, 'escape', 'bad.txt')))).resolves.toMatchObject({ decision: 'DENY' });
    await expect(fixture.engine.evaluate(fixture.request('file.read', hardlinkAlias))).resolves.toMatchObject({ decision: 'DENY' });
    await expect(fixture.engine.evaluate(fixture.request('file.write', hardlinkAlias))).resolves.toMatchObject({ decision: 'DENY' });
    await expect(fixture.engine.evaluate(fixture.request('file.delete', hardlinkAlias))).resolves.toMatchObject({ decision: 'DENY' });
    await expect(fixture.engine.evaluate({ ...fixture.request('file.write', path.join(fixture.projectRoot, 'bad.txt')), clientId: 'other-client' })).resolves.toMatchObject({ decision: 'DENY' });
    await expect(fixture.engine.evaluate({ capabilityId: 'session.instruction.submit', clientId: 'other-client', sessionId: fixture.session.id }))
      .resolves.toMatchObject({ decision: 'DENY' });
  });

  it('denies legacy mutation, requires owner for external authority expansion and system actions, and denies unknown capability', async () => {
    const fixture = await policyFixture();
    await expect(fixture.engine.evaluate({ capabilityId: 'project.register', targetPath: fixture.legacyRoot })).resolves.toMatchObject({ decision: 'DENY' });

    const external = await temp('iris-policy-external-project-');
    await expect(fixture.engine.evaluate({ capabilityId: 'project.register', targetPath: external })).resolves.toMatchObject({ decision: 'OWNER_REQUIRED' });
    await expect(fixture.engine.evaluate({ capabilityId: 'system.sudo' })).resolves.toMatchObject({ decision: 'OWNER_REQUIRED', riskClass: 'SYSTEM' });
    await expect(fixture.engine.evaluate({ capabilityId: 'not.registered' })).resolves.toMatchObject({ decision: 'DENY' });
  });

  it('auto-allows project registration inside the canonical owner source root', async () => {
    const fixture = await policyFixture();
    const nested = path.join(fixture.sourceRoot, 'new-project');
    await mkdir(nested);
    await expect(fixture.engine.evaluate({ capabilityId: 'project.register', targetPath: nested })).resolves.toMatchObject({ decision: 'ALLOW_AUTO', target: nested });
  });

  it('keeps mode changes owner-required even while FULL_LOCAL_OWNER is active', async () => {
    const fixture = await policyFixture();
    await expect(fixture.engine.evaluate({ capabilityId: 'policy.mode.set' })).resolves.toMatchObject({ decision: 'OWNER_REQUIRED', riskClass: 'HIGH' });
    const settings = await fixture.settings.initialize();
    expect(settings.mode).toBe('FULL_LOCAL_OWNER');
  });

  it('fails closed if persisted permission settings disappear after initialization', async () => {
    const fixture = await policyFixture();
    await rm(path.join(fixture.dataRoot, 'permissions.json'));
    await expect(fixture.engine.evaluate(fixture.request('file.write', path.join(fixture.projectRoot, 'blocked.txt'))))
      .rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });
});

async function policyFixture() {
  const sourceRoot = await realpath(await temp('iris-policy-source-'));
  const dataRoot = await realpath(await temp('iris-policy-data-'));
  const legacyRoot = await realpath(await temp('iris-policy-legacy-'));
  const projectRoot = path.join(sourceRoot, 'project');
  await mkdir(projectRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Project', projectRoot);
  const session = state.createSession('client-a');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const engine = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, legacyRoot);
  return {
    sourceRoot,
    dataRoot,
    legacyRoot,
    projectRoot,
    project,
    session,
    settings,
    engine,
    request: (capabilityId: string, targetPath: string) => ({
      capabilityId,
      clientId: session.clientId,
      sessionId: session.id,
      projectId: project.id,
      targetPath,
    }),
  };
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
