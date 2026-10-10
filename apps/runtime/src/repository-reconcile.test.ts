import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService, type CapabilityOutcome } from './capability-service.js';
import { GovernedGitEngine } from './governed-git-engine.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { RuntimeState } from './state.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(rename).mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(linked = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-repository-reconcile-')));
  roots.push(root);
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'state');
  await mkdir(projectRoot);
  await mkdir(dataRoot, { mode: 0o700 });
  await git(projectRoot, ['init', '-b', 'main']);
  await git(projectRoot, ['-c', 'user.name=IRIS Test', '-c', 'user.email=iris@example.invalid', 'commit', '--allow-empty', '-m', 'base']);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Recovery', projectRoot);
  const resources = new VNextResourceRegistry(state, dataRoot);
  const engine = new GovernedGitEngine(resources);
  const primary = await resources.primaryWorkspace(project.id);
  const identity = await engine.inspectRepository(project.id, primary.workspaceId);
  const current = await resources.ensureRepository({
    repositoryId: identity.repositoryId, projectId: project.id, primaryWorkspaceId: primary.workspaceId,
    commonGitDir: identity.commonGitDir, commonGitDirDevice: identity.commonGitDirDevice,
    commonGitDirInode: identity.commonGitDirInode,
  });
  const linkedRoot = path.join(root, 'linked');
  if (linked) {
    await git(projectRoot, ['worktree', 'add', '-b', 'feature', linkedRoot]);
    await resources.authorizeWorktree({ projectId: project.id, repositoryId: current.repositoryId,
      physicalRoot: linkedRoot, createdByAction: null });
  }
  const filename = path.join(dataRoot, 'vnext-resources.json');
  const document = JSON.parse(await readFile(filename, 'utf8'));
  const previousDevice = String(BigInt(current.commonGitDirDevice) + 2n);
  const previousRepositoryId = repositoryId(project.id, previousDevice, current.commonGitDirInode);
  document.repositories[0].commonGitDirDevice = previousDevice;
  document.repositories[0].repositoryId = previousRepositoryId;
  for (const workspace of document.workspaces) workspace.repositoryId = previousRepositoryId;
  // Simulate a pre-remount binding only in disposable state; host metadata is never changed.
  await writeFile(filename, JSON.stringify(document), { mode: 0o600 });
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const audit = new PermissionAuditStore(dataRoot);
  const service = new CapabilityService(state,
    new PermissionPolicyEngine(state, settings, root, dataRoot, path.join(root, 'protected')),
    audit, () => { throw new Error('Recovery does not need runtime health'); }, undefined, resources);
  const input = { projectId: project.id, previousRepositoryId, previousDevice,
    expectedRepositoryId: current.repositoryId };
  const operation = { capabilityId: 'repository.reconcile' as const, ...input };
  return { root, projectRoot, dataRoot, linkedRoot, filename, state, project, resources, engine,
    primary, current, input, operation, service, audit };
}

function repositoryId(project: string, device: string, inode: string) {
  const chars = createHash('sha256').update(`iris-repository:${project}:${device}:${inode}`).digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = '89ab'[parseInt(chars[16]!, 16) % 4]!;
  const h = chars.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function git(cwd: string, args: string[]) {
  return exec('/usr/bin/git', ['--no-optional-locks', ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}

function approval(outcome: CapabilityOutcome) {
  expect(outcome.status).toBe('owner_required');
  if (outcome.status !== 'owner_required') throw new Error('Expected exact owner approval');
  expect(outcome.approval.canAlwaysAllowProject).toBe(false);
  return outcome.approval.id;
}

function value(outcome: CapabilityOutcome) {
  expect(outcome.status).toBe('executed');
  if (outcome.status !== 'executed') throw new Error('Expected execution');
  return outcome.value as { changed: boolean; repositoryId: string };
}

describe('owner-authorized repository device reconciliation', () => {
  it('fails governed Git on device mismatch and changes nothing before explicit owner approval', async () => {
    const f = await fixture();
    const before = await readFile(f.filename, 'utf8');
    await expect(f.engine.execute({ operation: 'head', projectId: f.project.id, workspaceId: f.primary.workspaceId })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    approval(await f.service.execute(f.operation));
    expect(await readFile(f.filename, 'utf8')).toBe(before);
  });

  it('atomically preserves project/workspace IDs and owner files, then enables governed Git', async () => {
    const f = await fixture(true);
    await writeFile(path.join(f.linkedRoot, 'owner-work.txt'), 'preserve me');
    const before = await f.resources.listWorkspaces(f.project.id);
    const id = approval(await f.service.execute(f.operation));
    expect(value(await f.service.resolveApproval(id, 'ALLOW_ONCE'))).toMatchObject({ changed: true, repositoryId: f.current.repositoryId });
    const after = await f.resources.listWorkspaces(f.project.id);
    expect(after).toEqual(before.map((w) => ({ ...w, repositoryId: f.current.repositoryId })));
    expect(await f.state.listProjects()).toEqual([f.project]);
    for (const workspace of after) {
      expect(await f.engine.execute({ operation: 'head', projectId: f.project.id, workspaceId: workspace.workspaceId })).toHaveProperty('head');
      expect(await f.engine.execute({ operation: 'status', projectId: f.project.id, workspaceId: workspace.workspaceId })).toHaveProperty('stdout');
    }
    expect(await readFile(path.join(f.linkedRoot, 'owner-work.txt'), 'utf8')).toBe('preserve me');
    expect(await f.audit.recent()).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: 'repository.reconcile', decision: 'ALLOW_ONCE', result: 'SUCCESS' }),
      expect.objectContaining({ capabilityId: 'repository.reconcile', result: 'PENDING',
        reason: expect.stringContaining(`${f.input.previousRepositoryId} -> ${f.current.repositoryId}`) }),
    ]));
  });

  it('is idempotent for repeated and concurrent identical approvals without duplicate registrations', async () => {
    const f = await fixture(true);
    const first = approval(await f.service.execute(f.operation));
    const second = approval(await f.service.execute(f.operation));
    const results = await Promise.all([first, second].map((id) => f.service.resolveApproval(id, 'ALLOW_ONCE')));
    expect(results.map((r) => value(r).changed).sort()).toEqual([false, true]);
    const before = await readFile(f.filename, 'utf8');
    const retry = approval(await f.service.execute(f.operation));
    expect(value(await f.service.resolveApproval(retry, 'ALLOW_ONCE')).changed).toBe(false);
    expect(await readFile(f.filename, 'utf8')).toBe(before);
  }, 15_000);

  it('does not mutate on owner denial and rejects a persistent approval override', async () => {
    const f = await fixture();
    const before = await readFile(f.filename, 'utf8');
    const denied = approval(await f.service.execute(f.operation));
    expect(await f.service.resolveApproval(denied, 'DENY')).toMatchObject({ status: 'denied' });
    const persistent = approval(await f.service.execute(f.operation));
    await expect(f.service.resolveApproval(persistent, 'ALWAYS_ALLOW_PROJECT')).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    expect(await readFile(f.filename, 'utf8')).toBe(before);
  });

  it('rejects a different Git repository at the same path', async () => {
    const f = await fixture();
    await rename(path.join(f.projectRoot, '.git'), path.join(f.root, 'old-git'));
    await git(f.projectRoot, ['init', '-b', 'main']);
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rejects workspace root symlink substitution', async () => {
    const f = await fixture();
    const moved = path.join(f.root, 'moved');
    await rename(f.projectRoot, moved);
    await symlink(moved, f.projectRoot);
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rejects Git metadata symlink substitution', async () => {
    const f = await fixture();
    const moved = path.join(f.root, 'moved-git');
    await rename(path.join(f.projectRoot, '.git'), moved);
    await symlink(moved, path.join(f.projectRoot, '.git'));
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rejects a linked worktree with an inconsistent administration backlink', async () => {
    const f = await fixture(true);
    const gitDir = (await git(f.linkedRoot, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    await writeFile(path.join(gitDir, 'gitdir'), path.join(f.root, 'wrong', '.git'));
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rejects a worktree separately registered to another project', async () => {
    const f = await fixture(true);
    await f.state.registerProject('Conflicting project', f.linkedRoot);
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('leaves the old document intact on atomic publication failure, then safely retries', async () => {
    const f = await fixture(true);
    const before = await readFile(f.filename, 'utf8');
    const id = approval(await f.service.execute(f.operation));
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('injected publication failure'), { code: 'EIO' }));
    await expect(f.service.resolveApproval(id, 'ALLOW_ONCE')).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    expect(await readFile(f.filename, 'utf8')).toBe(before);
    const retry = approval(await f.service.execute(f.operation));
    expect(value(await f.service.resolveApproval(retry, 'ALLOW_ONCE')).changed).toBe(true);
  });

  it('verifies an unknown outcome after publication instead of replaying the mutation', async () => {
    const f = await fixture();
    const id = approval(await f.service.execute(f.operation));
    const append = f.audit.append.bind(f.audit);
    const spy = vi.spyOn(f.audit, 'append').mockImplementation(async (record, result) => {
      if (result === 'SUCCESS') throw new Error('lost success acknowledgment');
      return append(record, result);
    });
    await expect(f.service.resolveApproval(id, 'ALLOW_ONCE')).rejects.toThrow('lost success acknowledgment');
    expect(await f.engine.execute({ operation: 'head', projectId: f.project.id, workspaceId: f.primary.workspaceId })).toHaveProperty('head');
    spy.mockRestore();
    const before = await readFile(f.filename, 'utf8');
    const retry = approval(await f.service.execute(f.operation));
    expect(value(await f.service.resolveApproval(retry, 'ALLOW_ONCE')).changed).toBe(false);
    expect(await readFile(f.filename, 'utf8')).toBe(before);
  });

  it('preserves unrelated repository bindings byte-for-byte', async () => {
    const f = await fixture();
    const otherRoot = path.join(f.root, 'other');
    await mkdir(otherRoot);
    await git(otherRoot, ['init', '-b', 'main']);
    const otherProject = await f.state.registerProject('Other', otherRoot);
    const workspace = await f.resources.primaryWorkspace(otherProject.id);
    const identity = await f.engine.inspectRepository(otherProject.id, workspace.workspaceId);
    const other = await f.resources.ensureRepository({ ...identity, primaryWorkspaceId: workspace.workspaceId });
    const id = approval(await f.service.execute(f.operation));
    value(await f.service.resolveApproval(id, 'ALLOW_ONCE'));
    expect(await f.resources.findRepository(otherProject.id, other.repositoryId)).toEqual(other);
  });

  it('rejects evidence changes after approval was requested', async () => {
    const f = await fixture();
    const id = approval(await f.service.execute(f.operation));
    await git(f.projectRoot, ['switch', '-c', 'changed-branch']);
    expect(await f.service.resolveApproval(id, 'ALLOW_ONCE')).toMatchObject({ status: 'denied' });
    await expect(f.engine.inspectRepository(f.project.id, f.primary.workspaceId)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('invalidates approval when an untracked file changes but its status does not', async () => {
    const f = await fixture();
    const ownerFile = path.join(f.projectRoot, 'owner.txt');
    await writeFile(ownerFile, 'first bytes');
    const before = (await git(f.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
    const id = approval(await f.service.execute(f.operation));
    await writeFile(ownerFile, 'second bytes');
    expect((await git(f.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout).toBe(before);
    expect(await f.service.resolveApproval(id, 'ALLOW_ONCE')).toMatchObject({ status: 'denied' });
  });

  it('invalidates approval when staged content changes but its status does not', async () => {
    const f = await fixture();
    const trackedFile = path.join(f.projectRoot, 'tracked.txt');
    await writeFile(trackedFile, 'base bytes');
    await git(f.projectRoot, ['add', 'tracked.txt']);
    await git(f.projectRoot, ['-c', 'user.name=IRIS Test', '-c', 'user.email=iris@example.invalid', 'commit', '-m', 'tracked fixture']);
    await writeFile(trackedFile, 'first staged bytes');
    await git(f.projectRoot, ['add', 'tracked.txt']);
    const before = (await git(f.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
    const id = approval(await f.service.execute(f.operation));
    await writeFile(trackedFile, 'second staged bytes');
    await git(f.projectRoot, ['add', 'tracked.txt']);
    expect((await git(f.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout).toBe(before);
    expect(await f.service.resolveApproval(id, 'ALLOW_ONCE')).toMatchObject({ status: 'denied' });
  });

  it('invalidates approval when unstaged content changes but its status does not', async () => {
    const f = await fixture();
    const trackedFile = path.join(f.projectRoot, 'tracked.txt');
    await writeFile(trackedFile, 'base bytes');
    await git(f.projectRoot, ['add', 'tracked.txt']);
    await git(f.projectRoot, ['-c', 'user.name=IRIS Test', '-c', 'user.email=iris@example.invalid', 'commit', '-m', 'tracked fixture']);
    await writeFile(trackedFile, 'first unstaged bytes');
    const before = (await git(f.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
    const id = approval(await f.service.execute(f.operation));
    await writeFile(trackedFile, 'second unstaged bytes');
    expect((await git(f.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout).toBe(before);
    expect(await f.service.resolveApproval(id, 'ALLOW_ONCE')).toMatchObject({ status: 'denied' });
  });

  it('fails closed when untracked evidence exceeds the bounded size', async () => {
    const f = await fixture();
    await writeFile(path.join(f.projectRoot, 'oversized.bin'), Buffer.alloc(8 * 1024 * 1024 + 1, 7));
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rechecks the approved fingerprint at publication', async () => {
    const f = await fixture();
    const plan = await f.engine.reconcileRepository(f.input);
    await writeFile(path.join(f.projectRoot, 'owner.txt'), 'new work');
    await expect(f.engine.reconcileRepository(f.input, plan.fingerprint)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rejects Git locks, unknown worktrees and inconsistent previous identities', async () => {
    const f = await fixture();
    const lock = path.join(f.current.commonGitDir, 'index.lock');
    await writeFile(lock, 'held');
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await rm(lock);
    await expect(f.service.execute({ ...f.operation, previousDevice: '999' })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await git(f.projectRoot, ['worktree', 'add', '-b', 'unregistered', path.join(f.root, 'unregistered')]);
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rejects a common-directory identity claimed by another registration', async () => {
    const f = await fixture();
    const otherRoot = path.join(f.root, 'other');
    await mkdir(otherRoot);
    const otherProject = await f.state.registerProject('Other', otherRoot);
    const document = JSON.parse(await readFile(f.filename, 'utf8'));
    document.repositories.push({ ...f.current, projectId: otherProject.id,
      primaryWorkspaceId: (await f.resources.primaryWorkspace(otherProject.id)).workspaceId });
    await writeFile(f.filename, JSON.stringify(document), { mode: 0o600 });
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rejects a directory created after the stored registration time', async () => {
    const f = await fixture();
    const document = JSON.parse(await readFile(f.filename, 'utf8'));
    const metadata = await lstat(f.current.commonGitDir);
    document.repositories[0].createdAt = new Date(metadata.birthtimeMs - 1000).toISOString();
    await writeFile(f.filename, JSON.stringify(document), { mode: 0o600 });
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });
});
