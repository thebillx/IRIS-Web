import { access, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionAuditStore, auditFileContains } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { secureProjectFileRead, secureProjectFileWrite } from './macos-safety.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('capability execution and owner approval', () => {
  it('auto-executes project-scoped writes/deletes under FULL_LOCAL_OWNER and audits without file contents', async () => {
    const fixture = await serviceFixture();
    const target = path.join(fixture.projectRoot, 'auto.txt');
    const secretContent = 'SECRET_VALUE_NOT_FOR_AUDIT';

    const write = await fixture.service.execute({
      capabilityId: 'file.write', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: target, content: secretContent,
    });
    expect(write.status).toBe('executed');
    await expect(readFile(target, 'utf8')).resolves.toBe(secretContent);
    expect(await auditFileContains(fixture.dataRoot, secretContent)).toBe(false);

    const events = await fixture.audit.recent(10);
    expect(events.some((event) => event.capabilityId === 'file.write'
      && event.agentId === 'agent-implementer'
      && event.decision === 'ALLOW_AUTO'
      && event.result === 'SUCCESS')).toBe(true);

    const deletion = await fixture.service.execute({
      capabilityId: 'file.delete', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: target,
    });
    expect(deletion.status).toBe('executed');
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('executes nothing while owner approval is pending, then applies one exact allow-once decision', async () => {
    const fixture = await serviceFixture();
    await fixture.settings.setMode('ASK_EVERY_TIME');
    const target = path.join(fixture.projectRoot, 'pending.txt');
    const content = 'pending-body';

    const pending = await fixture.service.execute({
      capabilityId: 'file.write', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: target, content,
    });
    expect(pending.status).toBe('owner_required');
    if (pending.status !== 'owner_required') return;
    expect(pending.approval.exactAction).toContain('sha256=');
    expect(pending.approval.exactAction).not.toContain(content);
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });

    const approved = await fixture.service.resolveApproval(pending.approval.id, 'ALLOW_ONCE');
    expect(approved.status).toBe('executed');
    await expect(readFile(target, 'utf8')).resolves.toBe(content);
    await expect(fixture.service.resolveApproval(pending.approval.id, 'ALLOW_ONCE')).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
  });

  it.each([
    ['ALLOW_ONCE', 'ALLOW_ONCE', true],
    ['ALLOW_ONCE', 'DENY', true],
    ['DENY', 'ALLOW_ONCE', false],
    ['DENY', 'DENY', false],
  ] as const)('resolves concurrent %s/%s approval attempts at most once', async (firstChoice, secondChoice, mutationExpected) => {
    const fixture = await serviceFixture();
    await fixture.settings.setMode('ASK_EVERY_TIME');
    const target = path.join(fixture.projectRoot, 'concurrent.txt');
    const pending = await fixture.service.execute({
      capabilityId: 'file.write', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: target, content: 'single-mutation',
    });
    if (pending.status !== 'owner_required') throw new Error('Expected pending owner approval');

    const resolutions = await Promise.allSettled([
      fixture.service.resolveApproval(pending.approval.id, firstChoice),
      fixture.service.resolveApproval(pending.approval.id, secondChoice),
    ]);
    expect(resolutions[0]).toMatchObject({ status: 'fulfilled' });
    expect(resolutions[1]).toMatchObject({ status: 'rejected', reason: { code: 'APPROVAL_NOT_FOUND' } });
    if (resolutions[0]!.status !== 'fulfilled') return;
    expect(resolutions[0].value.status).toBe(mutationExpected ? 'executed' : 'denied');

    if (mutationExpected) await expect(readFile(target, 'utf8')).resolves.toBe('single-mutation');
    else await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });

    const events = await fixture.audit.recent(100);
    expect(events.filter((event) => event.capabilityId === 'file.write' && event.result === 'SUCCESS')).toHaveLength(mutationExpected ? 1 : 0);
  });

  it('denial executes nothing and an owner project override applies only to the matching project capability', async () => {
    const fixture = await serviceFixture();
    await fixture.settings.setMode('ASK_EVERY_TIME');
    const deniedTarget = path.join(fixture.projectRoot, 'denied.txt');
    const denied = await fixture.service.execute({
      capabilityId: 'file.write', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: deniedTarget, content: 'nope',
    });
    if (denied.status !== 'owner_required') throw new Error('Expected pending owner approval');
    await expect(fixture.service.resolveApproval(denied.approval.id, 'DENY')).resolves.toMatchObject({ status: 'denied' });
    await expect(access(deniedTarget)).rejects.toMatchObject({ code: 'ENOENT' });

    const firstTarget = path.join(fixture.projectRoot, 'override-a.txt');
    const first = await fixture.service.execute({
      capabilityId: 'file.write', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: firstTarget, content: 'a',
    });
    if (first.status !== 'owner_required') throw new Error('Expected pending owner approval');
    expect(first.approval.canAlwaysAllowProject).toBe(true);
    await expect(fixture.service.resolveApproval(first.approval.id, 'ALWAYS_ALLOW_PROJECT')).resolves.toMatchObject({ status: 'executed' });

    const second = await fixture.service.execute({
      capabilityId: 'file.write', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: path.join(fixture.projectRoot, 'override-b.txt'), content: 'b',
    });
    expect(second.status).toBe('executed');
  });

  it('registers the canonical project root approved by policy even if the submitted symlink alias is rebound before execution', async () => {
    const fixture = await serviceFixture();
    const approvedRoot = path.join(fixture.sourceRoot, 'approved-root');
    const reboundRoot = await temp('iris-capability-registration-rebound-');
    const alias = path.join(fixture.sourceRoot, 'registration-alias');
    await mkdir(approvedRoot);
    await symlink(approvedRoot, alias);

    const originalAppend = fixture.audit.append.bind(fixture.audit);
    let rebound = false;
    vi.spyOn(fixture.audit, 'append').mockImplementation(async (record, result) => {
      const event = await originalAppend(record, result);
      if (!rebound && record.capabilityId === 'project.register' && result === 'DECISION') {
        rebound = true;
        await rm(alias);
        await symlink(reboundRoot, alias);
      }
      return event;
    });

    const outcome = await fixture.service.execute({ capabilityId: 'project.register', name: 'Canonical Root', rootPath: alias });
    expect(outcome.status).toBe('executed');
    const projects = await fixture.state.listProjects();
    expect(projects.some((project) => project.name === 'Canonical Root' && project.rootPath === approvedRoot)).toBe(true);
    expect(projects.some((project) => project.rootPath === reboundRoot)).toBe(false);
  });

  it('fails closed if the already-authorized canonical project root is rebound before registration executes', async () => {
    const fixture = await serviceFixture();
    const approvedRoot = path.join(fixture.sourceRoot, 'approved-rebind-root');
    const reboundRoot = await temp('iris-capability-approved-root-rebound-');
    await mkdir(approvedRoot);

    const originalAppend = fixture.audit.append.bind(fixture.audit);
    let rebound = false;
    vi.spyOn(fixture.audit, 'append').mockImplementation(async (record, result) => {
      const event = await originalAppend(record, result);
      if (!rebound && record.capabilityId === 'project.register' && result === 'DECISION') {
        rebound = true;
        await rm(approvedRoot, { recursive: true });
        await symlink(reboundRoot, approvedRoot);
      }
      return event;
    });

    await expect(fixture.service.execute({ capabilityId: 'project.register', name: 'Must Stay Canonical', rootPath: approvedRoot }))
      .rejects.toMatchObject({ code: 'INVALID_PROJECT_PATH' });
    const projects = await fixture.state.listProjects();
    expect(projects.some((project) => project.name === 'Must Stay Canonical')).toBe(false);
    expect(projects.some((project) => project.rootPath === reboundRoot)).toBe(false);
  });

  it('denies hard-linked project aliases before read, write, or delete can reach the outside inode', async () => {
    const fixture = await serviceFixture();
    const outside = await temp('iris-capability-hardlink-outside-');
    const outsideFile = path.join(outside, 'outside.txt');
    const alias = path.join(fixture.projectRoot, 'alias.txt');
    await writeFile(outsideFile, 'outside-authority');
    await link(outsideFile, alias);

    const read = await fixture.service.execute({
      capabilityId: 'file.read', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: alias,
    });
    const write = await fixture.service.execute({
      capabilityId: 'file.write', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: alias, content: 'must-not-write',
    });
    const deletion = await fixture.service.execute({
      capabilityId: 'file.delete', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: alias,
    });

    expect(read.status).toBe('denied');
    expect(write.status).toBe('denied');
    expect(deletion.status).toBe('denied');
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside-authority');
    await expect(readFile(alias, 'utf8')).resolves.toBe('outside-authority');
  });

  it('keeps file execution anchored to project dirfds when the target parent is a symlink at execution time', async () => {
    const fixture = await serviceFixture();
    const outside = await temp('iris-capability-dirfd-outside-');
    await writeFile(path.join(outside, 'existing.txt'), 'outside');
    const escape = path.join(fixture.projectRoot, 'runtime-escape');
    await symlink(outside, escape);

    await expect(secureProjectFileRead(fixture.projectRoot, path.join(escape, 'existing.txt'))).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(secureProjectFileWrite(fixture.projectRoot, path.join(escape, 'new.txt'), 'blocked')).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(readFile(path.join(outside, 'existing.txt'), 'utf8')).resolves.toBe('outside');
    await expect(access(path.join(outside, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revalidates physical scope after approval is requested and refuses a later symlink escape', async () => {
    const fixture = await serviceFixture();
    await fixture.settings.setMode('ASK_EVERY_TIME');
    const parent = path.join(fixture.projectRoot, 'parent');
    await mkdir(parent);
    const target = path.join(parent, 'later.txt');
    const pending = await fixture.service.execute({
      capabilityId: 'file.write', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: target, content: 'blocked',
    });
    if (pending.status !== 'owner_required') throw new Error('Expected pending owner approval');

    const outside = await temp('iris-capability-outside-');
    await rm(parent, { recursive: true });
    await import('node:fs/promises').then(({ symlink }) => symlink(outside, parent));

    const result = await fixture.service.resolveApproval(pending.approval.id, 'ALLOW_ONCE');
    expect(result.status).toBe('denied');
    await expect(access(path.join(outside, 'later.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function serviceFixture() {
  const sourceRoot = await realpath(await temp('iris-capability-source-'));
  const dataRoot = await realpath(await temp('iris-capability-data-'));
  const legacyRoot = await realpath(await temp('iris-capability-legacy-'));
  const projectRoot = path.join(sourceRoot, 'project');
  await mkdir(projectRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Project', projectRoot);
  const session = state.createSession('client-a', 'agent-implementer', 'implementer');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, legacyRoot);
  const audit = new PermissionAuditStore(dataRoot);
  const service = new CapabilityService(state, policy, audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: state.listClients().length, connectedSessions: state.listSessions().length,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }));
  return { sourceRoot, dataRoot, legacyRoot, projectRoot, state, project, session, settings, policy, audit, service };
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
