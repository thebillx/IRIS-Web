import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { RepositoryId, WorkspaceId } from '@iris/domain';
import { ProductionSafetyController, createRuntimeBackup, restoreRuntimeBackup, type SafetyWriterName, withSafetyWriterAdmission } from './production-safety.js';
import { createRuntimeWriterVerifier, runtimeWriterBindings } from './production-safety-wiring.js';
import { FoundationStateStore } from './persistence.js';
import { MissionLedgerStore } from './mission-store.js';
import { RuntimeState } from './state.js';
import { VNextResourceRegistry } from './resource-registry.js';

const roots: string[] = [];
const writers = Object.keys(runtimeWriterBindings()) as SafetyWriterName[];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test('R09 real writer wiring fences all 13 stores and supports disposable backup/restore', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-wiring-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  await mkdir(dataRoot, { mode: 0o700 });
  const identity = { runtimeId: 'r09-wiring-runtime', instanceId: 'r09-wiring-instance', dataRoot };
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret: 'r09-owner', writerVerifier: createRuntimeWriterVerifier(dataRoot) });
  for (const writer of writers) await controller.registerWriter(writer);
  await writeFile(path.join(dataRoot, 'state.json'), '{"schemaVersion":1,"projects":[],"defaultProjectId":null}\n', { mode: 0o600 });
  await controller.quiesce('r09-owner');
  const backup = path.join(root, 'backup');
  const checkpoint = path.join(root, 'checkpoint.json');
  await writeFile(checkpoint, 'checkpoint\n', { mode: 0o600 });
  await createRuntimeBackup({ controller, ownerAccessToken: 'r09-owner', destination: backup, checkpointFile: checkpoint });
  const restored = path.join(root, 'restored');
  const restoredCheckpoint = path.join(root, 'restored-checkpoint.json');
  await restoreRuntimeBackup({ controller, ownerAccessToken: 'r09-owner', backupRoot: backup, destination: restored, disposable: true, checkpointFile: restoredCheckpoint });
  const readiness = await controller.readiness();
  assert.equal(readiness.status, 'READY_FOR_OWNER_WINDOW');
  assert.match(await readFile(path.join(restored, 'state.json'), 'utf8'), /defaultProjectId/);
});

test('R09 real writer wiring rejects malformed stores and active runner evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-wiring-negative-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  await mkdir(dataRoot, { mode: 0o700 });
  const identity = { runtimeId: 'r09-wiring-runtime', instanceId: 'r09-wiring-instance', dataRoot };
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret: 'r09-owner', writerVerifier: createRuntimeWriterVerifier(dataRoot) });
  await writeFile(path.join(dataRoot, 'permissions.json'), '{not-json}\n', { mode: 0o600 });
  await assert.rejects(controller.registerWriter('permission-store'), { code: 'PRECONDITION_FAILED' });
  await rm(path.join(dataRoot, 'permissions.json'));
  for (const writer of writers) {
    if (writer !== 'external-runners') await controller.registerWriter(writer);
  }
  await writeFile(path.join(dataRoot, 'vnext-jobs.json'), '{"schemaVersion":1,"jobs":[{"state":"RUNNING"}]}\n', { mode: 0o600 });
  await assert.rejects(controller.registerWriter('external-runners'), { code: 'PRECONDITION_FAILED' });
  assert.throws(() => controller.registerWriter('not-a-real-writer'), { code: 'INVALID_REQUEST' });
});

test('R09 shared admission rejects Supervisor and detached-runner writes after quiescence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-admission-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  await mkdir(dataRoot, { mode: 0o700 });
  const identity = { runtimeId: 'r09-admission-runtime', instanceId: 'r09-admission-instance', dataRoot };
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret: 'r09-owner', writerVerifier: createRuntimeWriterVerifier(dataRoot) });
  for (const writer of writers) await controller.registerWriter(writer);
  await withSafetyWriterAdmission(dataRoot, 'supervisor', async () => undefined);
  await controller.quiesce('r09-owner');
  await assert.rejects(withSafetyWriterAdmission(dataRoot, 'supervisor', async () => undefined), { code: 'PRECONDITION_FAILED' });
  await assert.rejects(controller.runMutation('external-runners', async () => undefined), { code: 'PRECONDITION_FAILED' });
});

test('R09 quiescence prevents registry lock and before-image artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-registry-fence-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  const projectRoot = path.join(root, 'project');
  await mkdir(dataRoot, { mode: 0o700 });
  await mkdir(projectRoot, { mode: 0o700 });
  const identity = { runtimeId: 'r09-registry-runtime', instanceId: 'r09-registry-instance', dataRoot };
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret: 'r09-owner', writerVerifier: createRuntimeWriterVerifier(dataRoot) });
  for (const writer of writers) await controller.registerWriter(writer);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Registry', projectRoot);
  const safety = { runMutation: <T>(writer: SafetyWriterName, operation: () => Promise<T>) => controller.runMutation(writer, operation) };
  const resources = new VNextResourceRegistry(state, dataRoot, safety);
  await controller.quiesce('r09-owner');
  await assert.rejects(resources.ensureRepository({
    repositoryId: '8f0d5f0a-7e62-4d4a-b87a-e86eebf1b3c7' as RepositoryId, projectId: project.id,
    primaryWorkspaceId: '00000000-0000-5000-8000-000000000000' as WorkspaceId, commonGitDir: dataRoot,
    commonGitDirDevice: '1', commonGitDirInode: '1',
  }), { code: 'PRECONDITION_FAILED' });
  await assert.rejects(resources.reconcileRepository({
    projectId: project.id, previousRepositoryId: '8f0d5f0a-7e62-4d4a-b87a-e86eebf1b3c7', previousDevice: '1',
    expectedRepositoryId: '8f0d5f0a-7e62-4d4a-b87a-e86eebf1b3c7', expectedHead: 'a'.repeat(40), expectedTree: 'b'.repeat(40),
    expectedWorktrees: [{ workspaceId: '00000000-0000-5000-8000-000000000000', head: 'a'.repeat(40), tree: 'b'.repeat(40), ref: 'refs/heads/main' }],
    registryTransaction: { requestId: 'd9d244a1-9b21-4d7c-a5ec-1cc9f1236a1f', expectedBeforeSha256: 'c'.repeat(64), staleWorkspaceIds: ['00000000-0000-5000-8000-000000000000'], existingWorktrees: [] },
  }, async () => ({ identity: {} as never, evidence: {} })), { code: 'PRECONDITION_FAILED' });
  await assert.rejects(lstat(path.join(dataRoot, 'vnext-registry-mutation.lock')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(dataRoot, 'registry-reconciliation-d9d244a1-9b21-4d7c-a5ec-1cc9f1236a1f.before.json')), { code: 'ENOENT' });
});

test('R09 quiescence prevents mission archive directory creation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-mission-fence-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  const projectRoot = path.join(root, 'project');
  await mkdir(dataRoot, { mode: 0o700 });
  await mkdir(projectRoot, { mode: 0o700 });
  const identity = { runtimeId: 'r09-mission-runtime', instanceId: 'r09-mission-instance', dataRoot };
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret: 'r09-owner', writerVerifier: createRuntimeWriterVerifier(dataRoot) });
  for (const writer of writers) await controller.registerWriter(writer);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Mission', projectRoot);
  const session = state.createSession('r09-client');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const mission = await state.createMission(session.clientId, session.id, 'Archive', 'CHATGPT');
  const completed = await state.setMissionState(mission.id, session.clientId, session.id, 'COMPLETED');
  const safety = { runMutation: <T>(writer: SafetyWriterName, operation: () => Promise<T>) => controller.runMutation(writer, operation) };
  const store = new MissionLedgerStore(dataRoot, safety);
  await controller.quiesce('r09-owner');
  await assert.rejects(store.archiveForCapacity(completed), { code: 'PRECONDITION_FAILED' });
  await assert.rejects(lstat(path.join(dataRoot, 'mission-archive')), { code: 'ENOENT' });
});
