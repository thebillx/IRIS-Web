import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { deriveCapabilityEffects } from './capability-effects.js';
import { CapabilityService, type CapabilityOutcome } from './capability-service.js';
import { GovernedGitEngine } from './governed-git-engine.js';
import { catalogToolNames } from './mcp-catalog.js';
import { executePhase4GroupedTool, phase4GroupedToolDefinitions } from './mcp-phase4.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { pushCurrentFeatureBranch, runProjectGitLocal } from './project-git.js';
import { ProjectValidationJobManager } from './project-test.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { RuntimeState } from './state.js';

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('IRIS vNext Phase 4 governed Git and worktree authorization', () => {
  it('exposes one FULL-only grouped git surface with typed operations and no raw execution escape hatch', async () => {
    const fixture = await serviceFixture();
    const definitions = phase4GroupedToolDefinitions();
    expect(definitions.map((tool) => tool.name)).toEqual(['git']);
    expect(catalogToolNames('FULL')).toHaveLength(49);
    expect(catalogToolNames('FULL')).toEqual(expect.arrayContaining(['git_status','git_local','remote_publish','workspace','fs','artifact','shell','job','git']));
    expect(catalogToolNames('PRO')).toEqual(['list_projects','project_info','git_status','file_read','search']);

    const schema = definitions[0]?.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toEqual(expect.arrayContaining(['command','argv','url','force','refspec','delete']));
    const operation = schema.properties.operation as { enum: readonly string[] };
    expect(operation.enum).toEqual([
      'status','head','diff','log','show','cat_file','merge_base','ancestry','refs','branch_list','worktree_list',
      'branch_create','worktree_add','worktree_remove','add','commit','fetch','push',
    ]);

    const request = new Request('http://127.0.0.1/mcp', { headers: { 'x-iris-client-id': fixture.session.clientId } });
    const head = executedValue<Record<string, unknown>>(await executePhase4GroupedTool('git', {
      operation: 'head', sessionId: fixture.session.id, projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId,
      expectedEffects: ['READ','EXECUTE'],
    }, request, fixture.service, fixture.state));
    expect(head.head).toBe(fixture.baseline);
    await expect(executePhase4GroupedTool('git', {
      operation: 'head', sessionId: fixture.session.id, projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId,
      command: 'git status', expectedEffects: ['READ','EXECUTE'],
    }, request, fixture.service, fixture.state)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('AC-FARM-001 + AC-FARM-002 provides bounded object reads, merge-base, ancestry, refs/log/show and non-checkout branch creation', async () => {
    const fixture = await serviceFixture();
    const repoId = await repositoryId(fixture);

    const commit = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'git.cat_file', operation: 'cat_file', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, object: fixture.baseline, expectedEffects: ['READ','EXECUTE'],
    }));
    expect(commit).toMatchObject({ objectType: 'commit', size: expect.any(Number), contentTruncated: false });
    expect(String(commit.content)).toContain('tree ');

    const large = path.join(fixture.projectRoot, 'large-object.bin');
    await writeFile(large, Buffer.alloc(96 * 1024, 65));
    const blob = (await git(fixture.projectRoot, ['hash-object', '-w', 'large-object.bin'])).stdout.trim();
    const blobRead = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'git.cat_file', operation: 'cat_file', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, object: blob, expectedEffects: ['READ','EXECUTE'],
    }));
    expect(blobRead).toMatchObject({ objectType: 'blob', content: null, binaryOrBlobContentOmitted: true });

    await git(fixture.projectRoot, ['branch', 'left', fixture.baseline]);
    await git(fixture.projectRoot, ['switch', 'left']);
    await writeFile(path.join(fixture.projectRoot, 'left.txt'), 'left\n');
    await git(fixture.projectRoot, ['add', '--', 'left.txt']);
    await git(fixture.projectRoot, ['commit', '-m', 'left']);
    const left = (await git(fixture.projectRoot, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(fixture.projectRoot, ['switch', 'main']);
    await git(fixture.projectRoot, ['branch', 'right', fixture.baseline]);
    await git(fixture.projectRoot, ['switch', 'right']);
    await writeFile(path.join(fixture.projectRoot, 'right.txt'), 'right\n');
    await git(fixture.projectRoot, ['add', '--', 'right.txt']);
    await git(fixture.projectRoot, ['commit', '-m', 'right']);
    const right = (await git(fixture.projectRoot, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(fixture.projectRoot, ['switch', 'main']);

    const mergeBase = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'git.merge_base', operation: 'merge_base', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, left, right, expectedEffects: ['READ','EXECUTE'],
    }));
    expect(mergeBase.mergeBase).toBe(fixture.baseline);
    const yes = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'git.ancestry', operation: 'ancestry', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, ancestor: fixture.baseline, descendant: left, expectedEffects: ['READ','EXECUTE'],
    }));
    const no = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'git.ancestry', operation: 'ancestry', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, ancestor: left, descendant: right, expectedEffects: ['READ','EXECUTE'],
    }));
    expect(yes.isAncestor).toBe(true);
    expect(no.isAncestor).toBe(false);

    expect((await fixture.service.execute({
      capabilityId: 'git.log', operation: 'log', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, ref: 'HEAD', maxCount: 5, expectedEffects: ['READ','EXECUTE'],
    })).status).toBe('executed');
    expect((await fixture.service.execute({
      capabilityId: 'git.show', operation: 'show', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, ref: 'HEAD', expectedEffects: ['READ','EXECUTE'],
    })).status).toBe('executed');
    expect((await fixture.service.execute({
      capabilityId: 'git.refs', operation: 'refs', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, maxEntries: 20, expectedEffects: ['READ','EXECUTE'],
    })).status).toBe('executed');
    expect((await fixture.service.execute({
      capabilityId: 'git.branch_list', operation: 'branch_list', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, maxEntries: 20, expectedEffects: ['READ','EXECUTE'],
    })).status).toBe('executed');
    expect((await fixture.service.execute({
      capabilityId: 'git.worktree_list', operation: 'worktree_list', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, expectedEffects: ['READ','EXECUTE'],
    })).status).toBe('executed');

    const branch = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'git.branch_create', operation: 'branch_create', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, repositoryId: repoId,
      branchName: 'feature/created', baseRef: fixture.baseline, expectedEffects: ['READ','WRITE','EXECUTE'],
    }));
    expect(branch).toMatchObject({ branch: 'feature/created', baseCommit: fixture.baseline });
    expect((await git(fixture.projectRoot, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe('main');
  });

  it('AC-FARM-003 + AC-FARM-004 + AC-SEC-007 authorizes only a verified linked WORKTREE and preserves dirty PRIMARY bytes/status exactly', async () => {
    const fixture = await serviceFixture();
    const repoId = await repositoryId(fixture);
    await writeFile(path.join(fixture.projectRoot, 'owned.txt'), 'owner dirty bytes\n');
    await writeFile(path.join(fixture.projectRoot, 'owner-untracked.txt'), 'owner untracked bytes\n');
    const beforeBytes = await readFile(path.join(fixture.projectRoot, 'owned.txt'));
    const beforeUntracked = await readFile(path.join(fixture.projectRoot, 'owner-untracked.txt'));
    const beforeStatus = (await git(fixture.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;

    const destination = path.join(path.dirname(fixture.projectRoot), `${path.basename(fixture.projectRoot)}-isolated`);
    const created = executedValue<{ workspace: { workspaceId: string; role: string; physicalRoot: string; repositoryId: string; lifecycleState: string } }>(await fixture.service.execute({
      capabilityId: 'git.worktree_add', operation: 'worktree_add', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, repositoryId: repoId,
      branchName: 'feature/isolated', baseRef: fixture.baseline, destinationPath: destination, expectedEffects: ['READ','WRITE','EXECUTE'],
    }));
    expect(created.workspace).toMatchObject({ role: 'WORKTREE', physicalRoot: destination, repositoryId: repoId, lifecycleState: 'ACTIVE' });
    expect((await lstat(path.join(destination, '.git'))).isFile()).toBe(true);

    const read = executedValue<{ text: string }>(await fixture.service.execute({
      capabilityId: 'fs.read', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: created.workspace.workspaceId, path: 'owned.txt', mode: 'TEXT', expectedEffects: ['READ'],
    }));
    expect(read.text).toBe('base\n');
    expect(await readFile(path.join(fixture.projectRoot, 'owned.txt'))).toEqual(beforeBytes);
    expect(await readFile(path.join(fixture.projectRoot, 'owner-untracked.txt'))).toEqual(beforeUntracked);
    expect((await git(fixture.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout).toBe(beforeStatus);

    const sibling = path.join(path.dirname(fixture.projectRoot), `${path.basename(fixture.projectRoot)}-unrelated`);
    await mkdir(sibling);
    const workspaces = await fixture.resources.listWorkspaces(fixture.project.id);
    expect(workspaces.filter((workspace) => workspace.role === 'WORKTREE')).toHaveLength(1);
    expect(workspaces.some((workspace) => workspace.physicalRoot === sibling)).toBe(false);
    await expect(fixture.service.execute({
      capabilityId: 'fs.stat', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: randomUUID(), path: '.', expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

    await expect(fixture.service.execute({
      capabilityId: 'git.worktree_add', operation: 'worktree_add', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, repositoryId: repoId,
      branchName: 'feature/isolated', baseRef: fixture.baseline, destinationPath: destination, expectedEffects: ['READ','WRITE','EXECUTE'],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await fixture.resources.listWorkspaces(fixture.project.id)).filter((workspace) => workspace.role === 'WORKTREE')).toHaveLength(1);
  });

  it('AC-FARM-005 rejects a forged WORKTREE whose .git indirection changes to a foreign common-directory identity', async () => {
    const fixture = await serviceFixture();
    const repoId = await repositoryId(fixture);
    const destination = path.join(path.dirname(fixture.projectRoot), `${path.basename(fixture.projectRoot)}-forged`);
    const created = executedValue<{ workspace: { workspaceId: string } }>(await fixture.service.execute({
      capabilityId: 'git.worktree_add', operation: 'worktree_add', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, repositoryId: repoId,
      branchName: 'feature/forged', baseRef: fixture.baseline, destinationPath: destination, expectedEffects: ['READ','WRITE','EXECUTE'],
    }));

    const foreign = path.join(path.dirname(fixture.projectRoot), `${path.basename(fixture.projectRoot)}-foreign`);
    await mkdir(foreign);
    await git(foreign, ['init', '-b', 'main']);
    const fakeAdmin = path.join(foreign, '.git', 'worktrees', 'forged');
    await mkdir(fakeAdmin, { recursive: true });
    await writeFile(path.join(fakeAdmin, 'commondir'), '../..\n');
    await writeFile(path.join(destination, '.git'), `gitdir: ${fakeAdmin}\n`);

    await expect(fixture.service.execute({
      capabilityId: 'git.status', operation: 'status', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: created.workspace.workspaceId, repositoryId: repoId, expectedEffects: ['READ','EXECUTE'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('fails closed for worktree destination aliases/existing paths and for dirty, PRIMARY, or unknown worktree removal', async () => {
    const fixture = await serviceFixture();
    const repoId = await repositoryId(fixture);
    const parent = path.dirname(fixture.projectRoot);
    const outsideParent = await temp('iris-phase4-outside-');
    const aliasDestination = path.join(parent, `${path.basename(fixture.projectRoot)}-alias`);
    await symlink(outsideParent, aliasDestination);
    await expect(fixture.service.execute({
      capabilityId: 'git.worktree_add', operation: 'worktree_add', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, repositoryId: repoId,
      branchName: 'feature/alias', baseRef: fixture.baseline, destinationPath: aliasDestination, expectedEffects: ['READ','WRITE','EXECUTE'],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const nestedParent = path.join(parent, 'nested');
    await mkdir(nestedParent);
    await expect(fixture.service.execute({
      capabilityId: 'git.worktree_add', operation: 'worktree_add', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, repositoryId: repoId,
      branchName: 'feature/nested', baseRef: fixture.baseline,
      destinationPath: path.join(nestedParent, `${path.basename(fixture.projectRoot)}-nested`), expectedEffects: ['READ','WRITE','EXECUTE'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const destination = path.join(parent, `${path.basename(fixture.projectRoot)}-remove`);
    const created = executedValue<{ workspace: { workspaceId: string } }>(await fixture.service.execute({
      capabilityId: 'git.worktree_add', operation: 'worktree_add', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, repositoryId: repoId,
      branchName: 'feature/remove', baseRef: fixture.baseline, destinationPath: destination, expectedEffects: ['READ','WRITE','EXECUTE'],
    }));
    await writeFile(path.join(destination, 'dirty.txt'), 'dirty\n');
    await expect(fixture.service.execute({
      capabilityId: 'git.worktree_remove', operation: 'worktree_remove', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: created.workspace.workspaceId, repositoryId: repoId,
      expectedEffects: ['READ','WRITE','EXECUTE','DESTRUCTIVE'],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await fixture.resources.getWorkspace(fixture.project.id, created.workspace.workspaceId)).lifecycleState).toBe('ACTIVE');

    await expect(fixture.service.execute({
      capabilityId: 'git.worktree_remove', operation: 'worktree_remove', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, repositoryId: repoId,
      expectedEffects: ['READ','WRITE','EXECUTE','DESTRUCTIVE'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(fixture.service.execute({
      capabilityId: 'git.worktree_remove', operation: 'worktree_remove', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: randomUUID(), repositoryId: repoId,
      expectedEffects: ['READ','WRITE','EXECUTE','DESTRUCTIVE'],
    })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

    await rm(path.join(destination, 'dirty.txt'));
    const removed = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'git.worktree_remove', operation: 'worktree_remove', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: created.workspace.workspaceId, repositoryId: repoId,
      expectedEffects: ['READ','WRITE','EXECUTE','DESTRUCTIVE'],
    }));
    expect(removed).toMatchObject({ removed: true, lifecycleState: 'DELETED' });
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('AC-FARM-006 derives NETWORK server-side, fetches configured remotes only, preserves working-tree state, and redacts credential-like failure diagnostics', async () => {
    const fixture = await serviceFixture();
    const repoId = await repositoryId(fixture);
    expect(deriveCapabilityEffects('git.fetch')).toEqual(['READ','WRITE','EXECUTE','NETWORK']);
    const beforeBytes = await readFile(path.join(fixture.projectRoot, 'owned.txt'));
    const beforeBranch = (await git(fixture.projectRoot, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
    const beforeStatus = (await git(fixture.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;

    const fetched = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'git.fetch', operation: 'fetch', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, repositoryId: repoId, remote: 'origin',
      expectedEffects: ['READ','WRITE','EXECUTE','NETWORK'],
    }));
    expect(fetched).toMatchObject({ operation: 'fetch', remote: 'origin', network: true, prune: false });
    expect(await readFile(path.join(fixture.projectRoot, 'owned.txt'))).toEqual(beforeBytes);
    expect((await git(fixture.projectRoot, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe(beforeBranch);
    expect((await git(fixture.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout).toBe(beforeStatus);

    await expect(fixture.service.execute({
      capabilityId: 'git.fetch', operation: 'fetch', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, repositoryId: repoId, remote: 'missing',
      expectedEffects: ['READ','WRITE','EXECUTE','NETWORK'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await git(fixture.projectRoot, ['remote', 'add', 'secret-remote', path.join(fixture.sourceRoot, 'token=SUPERSECRET')]);
    let failure = '';
    try {
      await fixture.service.execute({
        capabilityId: 'git.fetch', operation: 'fetch', clientId: fixture.session.clientId, sessionId: fixture.session.id,
        projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, repositoryId: repoId, remote: 'secret-remote',
        expectedEffects: ['READ','WRITE','EXECUTE','NETWORK'],
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).not.toContain('SUPERSECRET');
    const audits = await fixture.audit.recent(50);
    expect(JSON.stringify(audits)).not.toContain('SUPERSECRET');
  });

  it('AC-FARM-007 keeps safe push verified and preserves legacy git_local/remote_publish compatibility while protected/force/delete forms stay unavailable', async () => {
    const fixture = await serviceFixture();
    const identity = await fixture.engine.inspectRepository(fixture.project.id, fixture.primary.workspaceId);
    expect(deriveCapabilityEffects('git.push')).toEqual(['READ','WRITE','EXECUTE','NETWORK']);

    await git(fixture.projectRoot, ['switch', '-c', 'feature/push']);
    await writeFile(path.join(fixture.projectRoot, 'push.txt'), 'push\n');
    await git(fixture.projectRoot, ['add', '--', 'push.txt']);
    await git(fixture.projectRoot, ['commit', '-m', 'push']);
    const pushed = await fixture.engine.execute({ operation: 'push', projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId,
      repositoryId: identity.repositoryId, remote: 'origin', branch: 'feature/push' });
    expect(pushed).toMatchObject({ operation: 'push', remote: 'origin', branch: 'feature/push', verified: true, force: false, delete: false });
    expect(pushed.localHead).toBe(pushed.remoteHead);

    await git(fixture.projectRoot, ['switch', 'main']);
    await expect(fixture.engine.execute({ operation: 'push', projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId,
      repositoryId: identity.repositoryId, remote: 'origin', branch: 'main' })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const legacyHead = await runProjectGitLocal(fixture.projectRoot, { operation: 'head' });
    expect(legacyHead.head).toBe(fixture.baseline);
    await git(fixture.projectRoot, ['switch', '-c', 'feature/legacy']);
    const legacyPush = await pushCurrentFeatureBranch(fixture.projectRoot);
    expect(legacyPush).toMatchObject({ branch: 'feature/legacy', remote: 'origin', verified: true });
    expect(legacyPush.localHead).toBe(legacyPush.remoteHead);

    const schema = phase4GroupedToolDefinitions()[0]?.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty('force');
    expect(schema.properties).not.toHaveProperty('delete');
    expect(schema.properties).not.toHaveProperty('refspec');
  });
});

async function serviceFixture() {
  const sourceRoot = await realpath(await temp('iris-phase4-source-'));
  const dataRoot = await realpath(await temp('iris-phase4-data-'));
  const legacyRoot = await realpath(await temp('iris-phase4-legacy-'));
  const projectRoot = path.join(sourceRoot, 'agriscope');
  const remoteRoot = path.join(sourceRoot, 'origin.git');
  await mkdir(projectRoot);
  await mkdir(remoteRoot);
  await git(projectRoot, ['init', '-b', 'main']);
  await git(projectRoot, ['config', 'user.name', 'IRIS Phase4']);
  await git(projectRoot, ['config', 'user.email', 'iris-phase4@example.invalid']);
  await writeFile(path.join(projectRoot, 'owned.txt'), 'base\n');
  await git(projectRoot, ['add', '--', 'owned.txt']);
  await git(projectRoot, ['commit', '-m', 'base']);
  const baseline = (await git(projectRoot, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(remoteRoot, ['init', '--bare']);
  await git(projectRoot, ['remote', 'add', 'origin', remoteRoot]);
  await git(projectRoot, ['push', '-u', 'origin', 'main']);

  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Phase4 AgriScope', projectRoot);
  const session = state.createSession('phase4-client', 'phase4-agent', 'security');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, legacyRoot);
  const audit = new PermissionAuditStore(dataRoot);
  const resources = new VNextResourceRegistry(state, dataRoot);
  const service = new CapabilityService(state, policy, audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1,
    agentExecutorType: 'local-development-executor', productionModelConnected: false,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }), new ProjectValidationJobManager(dataRoot), resources);
  const primary = await resources.primaryWorkspace(project.id);
  const engine = new GovernedGitEngine(resources);
  return { sourceRoot, dataRoot, legacyRoot, projectRoot, remoteRoot, state, project, session, settings, audit, resources, service, primary, engine, baseline };
}

async function repositoryId(fixture: Awaited<ReturnType<typeof serviceFixture>>): Promise<string> {
  const head = executedValue<Record<string, unknown>>(await fixture.service.execute({
    capabilityId: 'git.head', operation: 'head', clientId: fixture.session.clientId, sessionId: fixture.session.id,
    projectId: fixture.project.id, workspaceId: fixture.primary.workspaceId, expectedEffects: ['READ','EXECUTE'],
  }));
  return String(head.repositoryId);
}

function executedValue<T>(outcome: CapabilityOutcome): T {
  if (outcome.status !== 'executed') throw new Error(`Expected executed outcome, received ${outcome.status}`);
  return outcome.value as T;
}

async function git(cwd: string, args: readonly string[]) {
  return exec('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
