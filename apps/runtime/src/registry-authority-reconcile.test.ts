import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService, type CapabilityOutcome } from './capability-service.js';
import { activeDurableJobWorkspaceReferences } from './durable-job-manager.js';
import { classifyCwdInspectionFailure, GovernedGitEngine } from './governed-git-engine.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { observeProcessStart } from './macos-safety.js';
import { RuntimeState } from './state.js';

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-registry-authority-')));
  roots.push(root);
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'state');
  await mkdir(projectRoot); await mkdir(dataRoot, { mode: 0o700 });
  await git(projectRoot, ['init', '-b', 'main']);
  await writeFile(path.join(projectRoot, 'tracked.txt'), 'base');
  await git(projectRoot, ['add', 'tracked.txt']);
  await git(projectRoot, ['-c', 'user.name=IRIS Test', '-c', 'user.email=iris@example.invalid', 'commit', '-m', 'base']);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Recovery', projectRoot);
  const resources = new VNextResourceRegistry(state, dataRoot);
  const engine = new GovernedGitEngine(resources, async () => ({ jobs: [], orchestration: [], processes: [] }));
  const primary = await resources.primaryWorkspace(project.id);
  const current = await engine.inspectRepository(project.id, primary.workspaceId);
  await resources.ensureRepository({ repositoryId: current.repositoryId, projectId: project.id,
    primaryWorkspaceId: primary.workspaceId, commonGitDir: current.commonGitDir,
    commonGitDirDevice: current.commonGitDirDevice, commonGitDirInode: current.commonGitDirInode });

  const registered = [];
  for (let index = 0; index < 7; index += 1) {
    const physicalRoot = path.join(root, `registered-${index}`);
    await git(projectRoot, ['worktree', 'add', '-b', `registered-${index}`, physicalRoot]);
    registered.push(await resources.authorizeWorktree({ projectId: project.id, repositoryId: current.repositoryId,
      physicalRoot, createdByAction: null }));
  }
  const filename = path.join(dataRoot, 'vnext-resources.json');
  const document = JSON.parse(await readFile(filename, 'utf8'));
  const stale = Array.from({ length: 20 }, (_, index) => ({
    workspaceId: randomUUID(), projectId: project.id, repositoryId: current.repositoryId,
    physicalRoot: path.join(root, `missing-${index}`), role: 'WORKTREE', authorizationSource: 'OWNER_APPROVAL',
    createdByAction: null, lifecycleState: 'ACTIVE', createdAt: new Date(0).toISOString(),
  }));
  document.workspaces.push(...stale);
  const previousDevice = String(BigInt(current.commonGitDirDevice) + 2n);
  const previousRepositoryId = repositoryId(project.id, previousDevice, current.commonGitDirInode);
  document.repositories[0].commonGitDirDevice = previousDevice;
  document.repositories[0].repositoryId = previousRepositoryId;
  for (const workspace of document.workspaces) workspace.repositoryId = previousRepositoryId;
  await writeFile(filename, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });

  const imported = [];
  for (let index = 0; index < 6; index += 1) {
    const physicalRoot = path.join(root, `existing-${index}`);
    await git(projectRoot, ['worktree', 'add', '-b', `existing-${index}`, physicalRoot]);
    const gitDir = (await git(physicalRoot, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    const rootStat = await lstat(physicalRoot, { bigint: true });
    const adminStat = await lstat(gitDir, { bigint: true });
    imported.push({ workspaceId: randomUUID(), physicalRoot,
      head: (await git(physicalRoot, ['rev-parse', 'HEAD'])).stdout.trim(),
      tree: (await git(physicalRoot, ['rev-parse', 'HEAD^{tree}'])).stdout.trim(),
      ref: (await git(physicalRoot, ['rev-parse', '--symbolic-full-name', 'HEAD'])).stdout.trim(),
      rootDevice: rootStat.dev.toString(), rootInode: rootStat.ino.toString(),
      gitAdminDevice: adminStat.dev.toString(), gitAdminInode: adminStat.ino.toString(),
      disposition: (index === 5 ? 'PRESERVE_UNTIL_RECOVERY_HANDOFF' : 'RETIRE_AFTER_EVIDENCE') as
        'PRESERVE_UNTIL_RECOVERY_HANDOFF' | 'RETIRE_AFTER_EVIDENCE',
      authorizedAt: new Date(1_700_000_000_000).toISOString() });
  }
  const expectedWorktrees = await Promise.all([
    { workspaceId: primary.workspaceId, physicalRoot: projectRoot },
    ...registered.map((entry) => ({ workspaceId: entry.workspaceId, physicalRoot: entry.physicalRoot })),
    ...imported,
  ].map(async (entry) => ({ workspaceId: entry.workspaceId,
    head: (await git(entry.physicalRoot, ['rev-parse', 'HEAD'])).stdout.trim(),
    tree: (await git(entry.physicalRoot, ['rev-parse', 'HEAD^{tree}'])).stdout.trim(),
    ref: (await git(entry.physicalRoot, ['rev-parse', '--symbolic-full-name', 'HEAD'])).stdout.trim() })));
  const before = await readFile(filename, 'utf8');
  const operation = { capabilityId: 'repository.reconcile' as const, projectId: project.id,
    previousRepositoryId, previousDevice, expectedRepositoryId: current.repositoryId,
    expectedHead: expectedWorktrees[0]!.head, expectedTree: expectedWorktrees[0]!.tree, expectedWorktrees,
    registryTransaction: { requestId: randomUUID(), expectedBeforeSha256: createHash('sha256').update(before).digest('hex'),
      staleWorkspaceIds: stale.map((entry) => entry.workspaceId), existingWorktrees: imported } };
  const settings = new PermissionSettingsStore(dataRoot); await settings.initialize();
  const audit = new PermissionAuditStore(dataRoot);
  const service = new CapabilityService(state,
    new PermissionPolicyEngine(state, settings, root, dataRoot, path.join(root, 'protected')),
    audit, () => { throw new Error('not needed'); }, undefined, resources);
  return { root, projectRoot, dataRoot, filename, project, state, resources, engine, primary, current, stale, imported, operation, service, audit };
}

describe('transactional protected registry authority reconciliation', () => {
  it('terminalizes 20 missing records, governs six worktrees, and reconciles seven registered roots atomically', async () => {
    const f = await fixture();
    const beforePaths = await Promise.all(f.imported.map(async (entry) => realpath(entry.physicalRoot)));
    const pending = await f.service.execute(f.operation);
    expect(pending.status).toBe('owner_required');
    await expect(lstat(path.join(f.dataRoot, 'vnext-registry-mutation.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (pending.status === 'owner_required') {
      expect(pending.approval.exactAction).toContain(f.imported[0]!.physicalRoot);
      expect(pending.approval.exactAction).toContain('RETIRE_AFTER_EVIDENCE');
    }
    const id = approval(pending);
    const result = await f.service.resolveApproval(id, 'ALLOW_ONCE');
    expect(result).toMatchObject({ status: 'executed', value: { changed: true,
      registryTransaction: { requestId: f.operation.registryTransaction.requestId } } });
    const document = JSON.parse(await readFile(f.filename, 'utf8'));
    expect(f.stale.every((stale) => document.workspaces.find((entry: { workspaceId: string }) => entry.workspaceId === stale.workspaceId)?.lifecycleState === 'DELETED')).toBe(true);
    expect(document.workspaces.find((entry: { workspaceId: string }) => entry.workspaceId === f.imported[5]!.workspaceId)?.lifecycleState).toBe('ACTIVE');
    expect(f.imported.slice(0, 5).every((item) => !document.workspaces.some((entry: { workspaceId: string }) => entry.workspaceId === item.workspaceId))).toBe(true);
    expect(document.repositories[0].repositoryId).toBe(f.current.repositoryId);
    expect(await Promise.all(f.imported.map(async (entry) => realpath(entry.physicalRoot)))).toEqual(beforePaths);
    const journal = JSON.parse(await readFile(path.join(f.dataRoot, 'vnext-registry-reconciliation.json'), 'utf8'));
    expect(journal.transactions).toContainEqual(expect.objectContaining({ requestId: f.operation.registryTransaction.requestId, state: 'COMMITTED',
      existingWorktreeDispositions: f.imported.map((entry) => ({ workspaceId: entry.workspaceId, disposition: entry.disposition })) }));
    expect(await readFile(path.join(f.dataRoot, `registry-reconciliation-${f.operation.registryTransaction.requestId}.before.json`), 'utf8')).toBeTruthy();
    const unrelated = await f.resources.createScratch(f.project.id);
    const retry = await f.service.execute({ ...f.operation, clientId: 'retry-client', sessionId: randomUUID() });
    expect(await f.service.resolveApproval(approval(retry), 'ALLOW_ONCE')).toMatchObject({ status: 'executed' });
    const retried = JSON.parse(await readFile(f.filename, 'utf8'));
    expect(retried.workspaces).toContainEqual(expect.objectContaining({ workspaceId: unrelated.workspaceId, lifecycleState: 'ACTIVE' }));
    expect(retried.workspaces.filter((entry: { workspaceId: string }) =>
      f.imported.some((item) => item.workspaceId === entry.workspaceId))).toHaveLength(1);
  }, 120_000);

  it('binds duplicate request IDs and stale approvals to exact evidence', async () => {
    const f = await fixture();
    const pending = await f.service.execute(f.operation);
    const id = approval(pending);
    await writeFile(path.join(f.projectRoot, 'owner.txt'), 'changed evidence');
    expect(await f.service.resolveApproval(id, 'ALLOW_ONCE')).toMatchObject({ status: 'denied' });
    const changed = { ...f.operation, expectedHead: '0'.repeat(40) };
    await expect(f.service.execute(changed)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  }, 120_000);

  it('rejects active references before owner approval and does not alter registry bytes', async () => {
    const f = await fixture();
    const before = await readFile(f.filename, 'utf8');
    const blocked = new GovernedGitEngine(f.resources, async () => { throw new Error('active reference'); });
    await expect(blocked.reconcileRepository(f.operation)).rejects.toThrow('active reference');
    expect(await readFile(f.filename, 'utf8')).toBe(before);
  }, 120_000);

  it('rejects an authentic active durable-job reference without touching registry bytes', async () => {
    const f = await fixture();
    const before = await readFile(f.filename, 'utf8');
    await writeFile(path.join(f.dataRoot, 'vnext-jobs.json'), JSON.stringify({ schemaVersion: 1, jobs: [{
      jobId: randomUUID(), workspaceId: f.stale[0]!.workspaceId, state: 'RUNNING',
    }] }), { mode: 0o600 });
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    expect(await readFile(f.filename, 'utf8')).toBe(before);
  }, 120_000);

  it('uses the canonical 200-job capacity and fails closed on diagnostic lsof errors', () => {
    const workspaceId = randomUUID();
    const jobs = Array.from({ length: 200 }, (_, index) => ({
      jobId: randomUUID(), workspaceId: index === 199 ? workspaceId : randomUUID(),
      state: index === 199 ? 'RUNNING' : 'SUCCEEDED',
    }));
    expect(activeDurableJobWorkspaceReferences({ schemaVersion: 1, jobs }, new Set([workspaceId]))).toEqual([jobs[199]!.jobId]);
    expect(() => classifyCwdInspectionFailure({ code: 1, stdout: '', stderr: 'permission denied' }))
      .toThrow('Process CWD ownership could not be inspected');
    expect(classifyCwdInspectionFailure({ code: 1, stdout: '', stderr: '' })).toEqual({ stdout: '', stderr: '' });
  });

  it('rejects a live process whose current directory is a removed stale root', async () => {
    const f = await fixture();
    const heldRoot = f.stale[0]!.physicalRoot;
    await mkdir(heldRoot);
    const child = spawn('/bin/sleep', ['30'], { cwd: heldRoot, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    try {
      await rm(heldRoot, { recursive: true });
      await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  }, 120_000);

  it('fails closed for active mission references and malformed durable reference stores', async () => {
    const f = await fixture();
    const session = f.state.createSession('registry-reference-client');
    await f.state.setSessionCurrentProject(session.id, session.clientId, f.project.id);
    await f.state.createMission(session.clientId, session.id, 'Active registry-bound mission');
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await writeFile(path.join(f.dataRoot, 'missions.json'), JSON.stringify({ schemaVersion: 1, missions: [] }), { mode: 0o600 });
    const now = new Date().toISOString();
    await writeFile(path.join(f.dataRoot, 'mission-lifecycle.json'), JSON.stringify({ schemaVersion: 1, records: [{
      missionId: randomUUID(), projectId: f.project.id, title: 'Active lifecycle', goal: 'Hold authority', state: 'RUNNING',
      revision: 1, workerBinding: null, checkpoints: [], directives: [], evidence: [], operations: [], createdAt: now, updatedAt: now,
    }] }), { mode: 0o600 });
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await rm(path.join(f.dataRoot, 'mission-lifecycle.json'));
    await writeFile(path.join(f.dataRoot, 'vnext-jobs.json'), JSON.stringify({ schemaVersion: 1, jobs: {} }), { mode: 0o600 });
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await rm(path.join(f.dataRoot, 'vnext-jobs.json'));
    await writeFile(path.join(f.dataRoot, 'multi-worker-orchestration.json'), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
    await expect(f.service.execute(f.operation)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  }, 120_000);

  it('reconciles interrupted APPLYING and post-publication unknown outcomes before retry', async () => {
    const f = await fixture();
    const first = await f.service.execute(f.operation);
    await f.service.resolveApproval(approval(first), 'ALLOW_ONCE');
    const journalPath = path.join(f.dataRoot, 'vnext-registry-reconciliation.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    const before = JSON.parse(await readFile(path.join(f.dataRoot,
      `registry-reconciliation-${f.operation.registryTransaction.requestId}.before.json`), 'utf8'));
    const stale = new Set<string>(f.operation.registryTransaction.staleWorkspaceIds);
    const applying = { ...before, workspaces: before.workspaces.map((entry: { workspaceId: string }) => stale.has(entry.workspaceId)
      ? { ...entry, lifecycleState: 'DELETING' } : entry) };
    journal.transactions[0].state = 'APPLYING';
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    await writeFile(f.filename, `${JSON.stringify(applying, null, 2)}\n`, { mode: 0o600 });
    const interrupted = await f.service.execute(f.operation);
    await f.service.resolveApproval(approval(interrupted), 'ALLOW_ONCE');
    expect(JSON.parse(await readFile(journalPath, 'utf8')).transactions[0].state).toBe('COMMITTED');
    const committed = await readFile(f.filename, 'utf8');
    const uncertain = JSON.parse(await readFile(journalPath, 'utf8'));
    uncertain.transactions[0].state = 'RECONCILIATION_REQUIRED';
    await writeFile(journalPath, `${JSON.stringify(uncertain, null, 2)}\n`, { mode: 0o600 });
    const postPublish = await f.service.execute(f.operation);
    await f.service.resolveApproval(approval(postPublish), 'ALLOW_ONCE');
    expect(await readFile(f.filename, 'utf8')).toBe(committed);
    expect(JSON.parse(await readFile(journalPath, 'utf8')).transactions[0].state).toBe('COMMITTED');
  }, 180_000);

  it('rejects exact imported-worktree identity drift and concurrent registry changes', async () => {
    const f = await fixture();
    const drifted = { ...f.operation, registryTransaction: { ...f.operation.registryTransaction,
      existingWorktrees: f.operation.registryTransaction.existingWorktrees.map((entry, index) => index === 0
        ? { ...entry, rootInode: String(BigInt(entry.rootInode) + 1n) } : entry) } };
    await expect(f.service.execute(drifted)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    const pending = await f.service.execute(f.operation);
    const current = JSON.parse(await readFile(f.filename, 'utf8'));
    current.artifacts.push({ artifactId: randomUUID(), projectId: f.project.id, workspaceId: f.primary.workspaceId,
      physicalPath: path.join(f.projectRoot, 'tracked.txt'), producerJobId: null, producerActionId: null,
      mime: 'text/plain', artifactType: 'evidence', size: 4, sha256: createHash('sha256').update('base').digest('hex'),
      sensitivity: 'INTERNAL', createdAt: new Date().toISOString(), retentionPolicy: 'MANUAL' });
    await writeFile(f.filename, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    await expect(f.service.resolveApproval(approval(pending), 'ALLOW_ONCE')).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  }, 120_000);

  it('rejects overlapping roots and disagreement between the two exact worktree manifests', async () => {
    const f = await fixture();
    const overlap = { ...f.operation, registryTransaction: { ...f.operation.registryTransaction,
      existingWorktrees: f.operation.registryTransaction.existingWorktrees.map((entry, index) => index === 0
        ? { ...entry, physicalRoot: f.projectRoot } : entry) } };
    await expect(f.service.execute(overlap)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    const disagreement = { ...f.operation, registryTransaction: { ...f.operation.registryTransaction,
      existingWorktrees: f.operation.registryTransaction.existingWorktrees.map((entry, index) => index === 0
        ? { ...entry, head: 'f'.repeat(40) } : entry) } };
    await expect(f.service.execute(disagreement)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  }, 120_000);

  it('rejects existing-worktree IDs and roots that collide with primary or persisted authority', async () => {
    const f = await fixture();
    const primaryId = f.primary.workspaceId;
    const registeredId = f.operation.expectedWorktrees.find((entry) => entry.workspaceId !== primaryId)!.workspaceId;
    const preservePrimary = { ...f.operation, registryTransaction: { ...f.operation.registryTransaction,
      existingWorktrees: f.operation.registryTransaction.existingWorktrees.map((entry, index) => index === 0
        ? { ...entry, workspaceId: primaryId, disposition: 'PRESERVE_UNTIL_RECOVERY_HANDOFF' as const } : entry) } };
    await expect(f.service.execute(preservePrimary)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    const retireRegistered = { ...f.operation, registryTransaction: { ...f.operation.registryTransaction,
      existingWorktrees: f.operation.registryTransaction.existingWorktrees.map((entry, index) => index === 0
        ? { ...entry, workspaceId: registeredId, disposition: 'RETIRE_AFTER_EVIDENCE' as const } : entry) } };
    await expect(f.service.execute(retireRegistered)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    const reusedHistoricalRoot = { ...f.operation, registryTransaction: { ...f.operation.registryTransaction,
      existingWorktrees: f.operation.registryTransaction.existingWorktrees.map((entry, index) => index === 0
        ? { ...entry, physicalRoot: f.stale[0]!.physicalRoot } : entry) } };
    await expect(f.service.execute(reusedHistoricalRoot)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    const document = JSON.parse(await readFile(f.filename, 'utf8'));
    const registeredRoot = document.workspaces.find((entry: { workspaceId: string; physicalRoot: string }) =>
      f.operation.expectedWorktrees.some((expected) => expected.workspaceId === entry.workspaceId))!.physicalRoot;
    const nestedSameProject = { ...f.operation, registryTransaction: { ...f.operation.registryTransaction,
      existingWorktrees: f.operation.registryTransaction.existingWorktrees.map((entry, index) => index === 0
        ? { ...entry, physicalRoot: path.join(registeredRoot, 'nested') } : entry) } };
    await expect(f.service.execute(nestedSameProject)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const foreignRoot = path.join(f.root, 'foreign-workspace');
    await mkdir(foreignRoot);
    document.workspaces.push({ workspaceId: randomUUID(), projectId: randomUUID(), repositoryId: randomUUID(),
      physicalRoot: foreignRoot, role: 'WORKTREE', authorizationSource: 'OWNER_APPROVAL', createdByAction: null,
      lifecycleState: 'ACTIVE', createdAt: new Date().toISOString() });
    const foreignBytes = `${JSON.stringify(document, null, 2)}\n`;
    await writeFile(f.filename, foreignBytes, { mode: 0o600 });
    const nestedForeign = { ...f.operation, registryTransaction: { ...f.operation.registryTransaction,
      expectedBeforeSha256: createHash('sha256').update(foreignBytes).digest('hex'),
      existingWorktrees: f.operation.registryTransaction.existingWorktrees.map((entry, index) => index === 0
        ? { ...entry, physicalRoot: path.join(foreignRoot, 'nested') } : entry) } };
    await expect(f.service.execute(nestedForeign)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  }, 120_000);

  it('ignores an incomplete unpublished lock temporary and publishes a complete final lock atomically', async () => {
    const f = await fixture();
    const temporary = path.join(f.dataRoot, 'vnext-registry-mutation.lock.interrupted.tmp');
    await writeFile(temporary, '{', { mode: 0o600 });
    const pending = await f.service.execute(f.operation);
    expect(await readFile(temporary, 'utf8')).toBe('{');
    await f.service.resolveApproval(approval(pending), 'ALLOW_ONCE');
    await expect(lstat(path.join(f.dataRoot, 'vnext-registry-mutation.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(temporary, 'utf8')).toBe('{');
  }, 120_000);

  it('fences ordinary writers while a transaction is unresolved and reconciles a dead cross-process lock', async () => {
    const f = await fixture();
    const pending = await f.service.execute(f.operation);
    await f.service.resolveApproval(approval(pending), 'ALLOW_ONCE');
    const journalPath = path.join(f.dataRoot, 'vnext-registry-reconciliation.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.transactions[0].state = 'RECONCILIATION_REQUIRED';
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    const second = new VNextResourceRegistry(f.state, f.dataRoot);
    await expect(second.ensureRepository({ repositoryId: f.current.repositoryId, projectId: f.project.id,
      primaryWorkspaceId: f.primary.workspaceId, commonGitDir: f.current.commonGitDir,
      commonGitDirDevice: f.current.commonGitDirDevice, commonGitDirInode: f.current.commonGitDirInode }))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    const owner = observeProcessStart(process.pid);
    expect(owner.state).toBe('live');
    if (owner.state !== 'live') throw new Error('Current process identity unavailable');
    await writeFile(path.join(f.dataRoot, 'vnext-registry-mutation.lock'), `${JSON.stringify({ schemaVersion: 1,
      lockId: randomUUID(), pid: process.pid, processStartMarker: owner.marker, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await expect(second.ensureRepository({ repositoryId: f.current.repositoryId, projectId: f.project.id,
      primaryWorkspaceId: f.primary.workspaceId, commonGitDir: f.current.commonGitDir,
      commonGitDirDevice: f.current.commonGitDirDevice, commonGitDirInode: f.current.commonGitDirInode }))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    const deadLock = `${JSON.stringify({ schemaVersion: 1,
      lockId: randomUUID(), pid: 999_999, processStartMarker: '1:000001', createdAt: new Date().toISOString() }, null, 2)}\n`;
    await writeFile(path.join(f.dataRoot, 'vnext-registry-mutation.lock'), deadLock, { mode: 0o600 });
    const retry = await f.service.execute({ ...f.operation, clientId: 'new-owner-client', sessionId: randomUUID() });
    expect(await readFile(path.join(f.dataRoot, 'vnext-registry-mutation.lock'), 'utf8')).toBe(deadLock);
    await f.service.resolveApproval(approval(retry), 'ALLOW_ONCE');
    await expect(lstat(path.join(f.dataRoot, 'vnext-registry-mutation.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(journalPath, 'utf8')).transactions[0].state).toBe('COMMITTED');
  }, 120_000);
});

function approval(outcome: CapabilityOutcome): string {
  expect(outcome.status).toBe('owner_required');
  if (outcome.status !== 'owner_required') throw new Error('Expected owner approval');
  return outcome.approval.id;
}

function repositoryId(project: string, device: string, inode: string): string {
  const chars = createHash('sha256').update(`iris-repository:${project}:${device}:${inode}`).digest('hex').slice(0, 32).split('');
  chars[12] = '5'; chars[16] = '89ab'[parseInt(chars[16]!, 16) % 4]!;
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function git(cwd: string, args: readonly string[]) {
  return exec('/usr/bin/git', ['--no-optional-locks', ...args], {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}
