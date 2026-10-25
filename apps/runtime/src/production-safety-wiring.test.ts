import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { RepositoryId, WorkspaceId } from '@iris/domain';
import { ProductionSafetyController, createRuntimeBackup, restoreRuntimeBackup, type SafetyWriterName, withSafetyWriterAdmission } from './production-safety.js';
import { createRuntimeWriterVerifier, runtimeWriterBindings } from './production-safety-wiring.js';
import { observeProcessStart } from './macos-safety.js';
import { FoundationStateStore } from './persistence.js';
import { MissionLedgerStore } from './mission-store.js';
import { RuntimeState } from './state.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { createSupervisor } from './supervisor.js';
import { DurableMissionLifecycleStore } from './durable-mission-store.js';
import { DurableMissionLifecycleService } from './durable-mission-service.js';

const roots: string[] = [];
const writers = Object.keys(runtimeWriterBindings()) as SafetyWriterName[];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test('R09 quiesce preserves lease accounting when a real logical mission is running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-observed-activity-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  const projectRoot = path.join(root, 'project');
  await mkdir(dataRoot, { mode: 0o700 });
  await mkdir(projectRoot, { mode: 0o700 });
  const identity = { runtimeId: randomUUID(), instanceId: randomUUID(), dataRoot };
  const verifier = createRuntimeWriterVerifier(dataRoot);
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret: 'r09-owner', writerVerifier: verifier });
  for (const writer of writers) await controller.registerWriter(writer);
  const state = new RuntimeState(new FoundationStateStore(dataRoot, controller), undefined, new MissionLedgerStore(dataRoot, controller));
  const project = await state.registerProject('Safety regression', projectRoot);
  const session = state.createSession('r09-client');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const mission = await state.createMission(session.clientId, session.id, 'Observed logical activity', 'CHATGPT');
  const store = new DurableMissionLifecycleStore(dataRoot, controller);
  const lifecycle = new DurableMissionLifecycleService(state, store);
  const created = await lifecycle.ensureMission(mission.id);
  const running = await lifecycle.start({ missionId: mission.id, expectedRevision: created.revision, requestId: randomUUID(), workerType: 'IRIS_LOGICAL' });
  assert.equal(running.state, 'RUNNING');
  await store.write(await store.read());
  assert.equal((await store.read()).records[0]!.state, 'RUNNING');
  const before = await controller.inspect();
  assert.equal(before.writers['mission-lifecycle']!.inFlight, 0);
  assert.equal((await controller.quiesce('r09-owner')).state, 'BLOCKED');
  const blocked = await controller.inspect();
  assert.deepEqual(blocked.writers['mission-lifecycle'], before.writers['mission-lifecycle']);
  const reopened = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret: 'r09-owner', writerVerifier: verifier });
  await assert.rejects(reopened.recover('r09-owner', {}), { code: 'PRECONDITION_FAILED' });
  assert.equal((await reopened.inspect()).state, 'BLOCKED');
});

test('R09 malformed logical activity and unknown runner directories deny admission without publishing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-unknown-activity-'));
  roots.push(root);
  await chmod(root, 0o700);
  const identity = { runtimeId: randomUUID(), instanceId: randomUUID(), dataRoot: root };
  const controller = await ProductionSafetyController.open({ dataRoot: root, identity, ownerAccessSecret: 'r09-owner', writerVerifier: createRuntimeWriterVerifier(root) });
  for (const writer of writers) await controller.registerWriter(writer);
  for (const [writer, filename] of [['mission-lifecycle', 'mission-lifecycle.json'], ['multi-worker', 'multi-worker-orchestration.json'], ['security-audit', 'security-audit-engine.json']] as const) {
    await writeFile(path.join(root, filename), JSON.stringify({ state: 'RUNNING' }), { mode: 0o600 });
    const before = await readFile(path.join(root, 'production-safety.json'), 'utf8');
    await assert.rejects(controller.beginMutation(writer), { code: 'PRECONDITION_FAILED' });
    assert.equal(await readFile(path.join(root, 'production-safety.json'), 'utf8'), before);
  }
  await mkdir(path.join(root, 'vnext-job-runtime'), { mode: 0o700 });
  await mkdir(path.join(root, 'vnext-job-runtime', randomUUID()), { mode: 0o700 });
  const before = await readFile(path.join(root, 'production-safety.json'), 'utf8');
  await assert.rejects(controller.beginMutation('external-runners'), { code: 'PRECONDITION_FAILED' });
  assert.equal(await readFile(path.join(root, 'production-safety.json'), 'utf8'), before);
});

test('R09 idle observations never release a held lease and external admissions do not overlap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-held-lease-'));
  roots.push(root);
  await chmod(root, 0o700);
  const identity = { runtimeId: randomUUID(), instanceId: randomUUID(), dataRoot: root };
  const controller = await ProductionSafetyController.open({ dataRoot: root, identity, ownerAccessSecret: 'r09-owner', writerVerifier: createRuntimeWriterVerifier(root) });
  for (const writer of writers) await controller.registerWriter(writer);
  const lease = await controller.beginMutation('external-runners');
  const before = (await controller.inspect()).writers['external-runners'];
  await assert.rejects(controller.beginMutation('external-runners'), { code: 'SUPERVISOR_BUSY' });
  await assert.rejects(controller.quiesce('r09-owner', { 'external-runners': { state: 'IDLE' } }), { code: 'PRECONDITION_FAILED' });
  assert.equal((await controller.quiesce('r09-owner')).state, 'BLOCKED');
  await assert.rejects(controller.recover('r09-owner', {}), { code: 'PRECONDITION_FAILED' });
  assert.deepEqual((await controller.inspect()).writers['external-runners'], before);
  await lease.release();
  assert.equal((await controller.recover('r09-owner', {})).state, 'ACTIVE');
});

test('R09 lifecycle archival admits before directory creation and keeps immutable archives', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-lifecycle-archive-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  const projectRoot = path.join(root, 'project');
  await mkdir(dataRoot, { mode: 0o700 });
  await mkdir(projectRoot, { mode: 0o700 });
  const identity = { runtimeId: randomUUID(), instanceId: randomUUID(), dataRoot };
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret: 'r09-owner', writerVerifier: createRuntimeWriterVerifier(dataRoot) });
  for (const writer of writers) await controller.registerWriter(writer);
  const state = new RuntimeState(new FoundationStateStore(dataRoot, controller), undefined, new MissionLedgerStore(dataRoot, controller));
  const project = await state.registerProject('Archive', projectRoot);
  const session = state.createSession('r09-client');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const mission = await state.createMission(session.clientId, session.id, 'Archive', 'CHATGPT');
  const store = new DurableMissionLifecycleStore(dataRoot, controller);
  const lifecycle = new DurableMissionLifecycleService(state, store);
  const created = await lifecycle.ensureMission(mission.id);
  await controller.quiesce('r09-owner');
  await assert.rejects(store.archiveForCapacity(created), { code: 'PRECONDITION_FAILED' });
  await assert.rejects(lstat(path.join(dataRoot, 'mission-lifecycle-archive')), { code: 'ENOENT' });
  await controller.unfence('r09-owner');
  await store.archiveForCapacity(created);
  const filename = path.join(dataRoot, 'mission-lifecycle-archive', `${mission.id}.json`);
  const bytes = await readFile(filename);
  await store.archiveForCapacity(created);
  assert.deepEqual(await readFile(filename), bytes);
  await assert.rejects(store.archiveForCapacity({ ...created, title: 'conflicting content' }), { code: 'PRECONDITION_FAILED' });
  await controller.quiesce('r09-owner');
  await assert.rejects(store.archiveForCapacity(created), { code: 'PRECONDITION_FAILED' });
  assert.deepEqual(await readFile(filename), bytes);
});

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

test('Supervisor writer registration rejects an unrelated active operation lock', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-supervisor-lock-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  await mkdir(path.join(dataRoot, 'supervisor'), { recursive: true, mode: 0o700 });
  const observed = observeProcessStart(process.pid);
  assert.equal(observed.state, 'live');
  await writeFile(path.join(dataRoot, 'supervisor', 'operation.lock'), JSON.stringify({ schemaVersion: 1, pid: process.pid, operation: 'admin-tunnel-start-control-only', processStartMarker: observed.marker }), { mode: 0o600 });
  const controller = await ProductionSafetyController.open({
    dataRoot,
    identity: { runtimeId: 'r09-supervisor-runtime', instanceId: 'r09-supervisor-instance', dataRoot },
    ownerAccessSecret: 'r09-owner',
    writerVerifier: createRuntimeWriterVerifier(dataRoot),
  });
  await assert.rejects(controller.registerWriter('supervisor'), { code: 'PRECONDITION_FAILED' });
});

for (const operation of ['runtime-on', 'runtime-restart']) test(`Supervisor writer registration accepts only the matching ${operation} startup operation`, { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-supervisor-startup-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  await mkdir(path.join(dataRoot, 'supervisor'), { recursive: true, mode: 0o700 });
  const observed = observeProcessStart(process.pid);
  assert.equal(observed.state, 'live');
  const startupId = randomUUID();
  await writeFile(path.join(dataRoot, 'supervisor', 'state.json'), JSON.stringify({ startupOperations: [{ id: startupId, component: 'runtime', state: 'SPAWNING', dataRoot, supervisorPid: process.pid, supervisorStartMarker: observed.marker, pid: null }] }), { mode: 0o600 });
  await writeFile(path.join(dataRoot, 'supervisor', 'operation.lock'), JSON.stringify({ schemaVersion: 1, pid: process.pid, operation, processStartMarker: observed.marker }), { mode: 0o600 });
  const controller = await ProductionSafetyController.open({
    dataRoot,
    identity: { runtimeId: 'r09-supervisor-runtime', instanceId: 'r09-supervisor-instance', dataRoot },
    ownerAccessSecret: 'r09-owner',
    writerVerifier: createRuntimeWriterVerifier(dataRoot, startupId),
  });
  const unrelated = await ProductionSafetyController.open({ dataRoot, identity: { runtimeId: 'r09-supervisor-runtime', instanceId: 'r09-supervisor-instance', dataRoot }, ownerAccessSecret: 'r09-owner', writerVerifier: createRuntimeWriterVerifier(dataRoot, randomUUID()) });
  await assert.rejects(unrelated.registerWriter('supervisor'), { code: 'PRECONDITION_FAILED' });
  await controller.registerWriter('supervisor');
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
  await assert.rejects(
    withSafetyWriterAdmission(dataRoot, 'supervisor', async () => undefined, { runtimeId: 'stale-runtime', instanceId: identity.instanceId }),
    { code: 'AUTHORITY_CHANGED' },
  );
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

test('R09 default Supervisor construction rejects a rolled runtime identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-r09-supervisor-identity-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  await mkdir(dataRoot, { mode: 0o700 });
  const identity = { runtimeId: 'r09-supervisor-runtime', instanceId: 'r09-supervisor-instance', dataRoot };
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret: 'r09-owner', writerVerifier: createRuntimeWriterVerifier(dataRoot) });
  for (const writer of writers) await controller.registerWriter(writer);
  const supervisor = await createSupervisor({ dataRoot, sourceRoot: root, safetyAdmission: true });
  await ProductionSafetyController.open({
    dataRoot,
    identity: { ...identity, instanceId: 'r09-supervisor-next-instance' },
    ownerAccessSecret: 'r09-owner',
    writerVerifier: createRuntimeWriterVerifier(dataRoot),
  });
  await assert.rejects(supervisor.down(), { code: 'AUTHORITY_CHANGED' });
});
