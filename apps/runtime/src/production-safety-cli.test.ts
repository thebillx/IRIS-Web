import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { acquireRuntimeAuthority } from './authority.js';
import { DurableMissionLifecycleStore } from './durable-mission-store.js';
import { DurableMissionLifecycleService } from './durable-mission-service.js';
import { MissionBrokerStore } from './mission-broker.js';
import { MissionLedgerStore } from './mission-store.js';
import { MultiWorkerStore } from './multi-worker/store.js';
import { PermissionSettingsStore } from './permission-store.js';
import { FoundationStateStore, loadOrCreateOwnerAccessSecret, loadOrCreateRuntimeId } from './persistence.js';
import { ProductionSafetyController, type SafetyWriterName } from './production-safety.js';
import { createRuntimeWriterVerifier, runtimeWriterBindings } from './production-safety-wiring.js';
import { SecurityAuditStore } from './security-audit/store.js';
import { RuntimeState } from './state.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test('safety CLI recovers a stopped idle rollover from trusted stores without writer assertions', async () => {
  const f = await fixture();
  await f.controller.quiesce(f.token);
  const identity = { runtimeId: f.identity.runtimeId, instanceId: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), platform: 'darwin' as const, version: '0.0.0' as const };
  const authority = await acquireRuntimeAuthority(f.dataRoot, identity);
  const replacement = await ProductionSafetyController.open({ dataRoot: f.dataRoot, identity, ownerAccessSecret: f.token, writerVerifier: createRuntimeWriterVerifier(f.dataRoot) });
  try {
    assert.equal((await replacement.inspect()).state, 'RECOVERY_REQUIRED');
    const before = await readFile(f.safetyFile);
    const live = await cli('recover', f);
    assert.equal(live.code, 1);
    assert.match(live.stderr, /owner to be stopped/);
    assert.deepEqual(await readFile(f.safetyFile), before);
  } finally { await authority.release(); }
  const recovered = await cli('recover', f);
  assert.equal(recovered.code, 0, recovered.stderr);
  const snapshot = await replacement.inspect();
  assert.equal(snapshot.state, 'ACTIVE');
  for (const writer of Object.values(snapshot.writers)) {
    assert.equal(writer.ownerInstanceId, identity.instanceId);
    assert.equal(writer.inFlight, 0);
    assert.deepEqual(writer.leaseIds, []);
  }
  const before = await readFile(f.safetyFile);
  const repeated = await cli('recover', f);
  assert.equal(repeated.code, 1);
  assert.deepEqual(await readFile(f.safetyFile), before);
});

test('safety CLI refuses recovery with leases, reservations, conflicting authority or owner identity', async () => {
  const f = await fixture();
  const lease = await f.controller.beginMutation('runtime-state');
  await f.controller.quiesce(f.token);
  const held = await readFile(f.safetyFile);
  assert.equal((await cli('recover', f)).code, 1);
  assert.deepEqual(await readFile(f.safetyFile), held);
  await lease.release();
  assert.equal((await cli('recover', f)).code, 0);
  await f.controller.quiesce(f.token);
  const reservation = await f.controller.reserveBackup(f.token, path.join(f.root, 'interrupted-backup'));
  await f.controller.failReservation(f.token, reservation.id, 'disposable interruption');
  const reserved = await readFile(f.safetyFile);
  assert.equal((await cli('recover', f)).code, 1);
  assert.deepEqual(await readFile(f.safetyFile), reserved);
  assert.equal((await cli('reconcile-reservation', f, ['--reservation-id', reservation.id, '--reason', 'disposable destination and staging are absent'])).code, 0);
  const before = await readFile(f.safetyFile);
  assert.equal((await cli('recover', { ...f, token: 'wrong-owner' })).code, 1);
  assert.deepEqual(await readFile(f.safetyFile), before);
  const foreign = { runtimeId: randomUUID(), instanceId: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), platform: 'darwin' as const, version: '0.0.0' as const };
  const authority = await acquireRuntimeAuthority(f.dataRoot, foreign);
  try {
    const conflict = await cli('recover', f);
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /authority does not match/);
    assert.deepEqual(await readFile(f.safetyFile), before);
  } finally { await authority.release(); }
  await writeFile(path.join(f.dataRoot, 'runtime-id.json'), `${JSON.stringify({ schemaVersion: 1, runtimeId: randomUUID() })}\n`, { mode: 0o600 });
  const mismatch = await cli('recover', f);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /runtime and safety identity disagree/);
  assert.deepEqual(await readFile(f.safetyFile), before);
});

test('safety CLI readiness verifies a real disposable backup and restore without rewriting state', async () => {
  const f = await fixture();
  const checkpoint = path.join(f.root, 'task-checkpoint.json');
  const restoredCheckpoint = path.join(f.root, 'restored-checkpoint.json');
  const backup = path.join(f.root, 'backup');
  const restored = path.join(f.root, 'restored');
  await writeFile(checkpoint, JSON.stringify({ projectId: f.projectId, nextAction: 'verify restored evidence' }), { mode: 0o600 });
  for (const [command, args] of [
    ['quiesce', []],
    ['backup', ['--destination', backup, '--checkpoint-file', checkpoint]],
    ['verify', ['--backup', backup]],
    ['restore', ['--backup', backup, '--destination', restored, '--disposable', 'true', '--checkpoint-file', restoredCheckpoint]],
  ] as const) {
    const result = await cli(command, f, args);
    assert.equal(result.code, 0, result.stderr);
  }
  const before = await readFile(f.safetyFile);
  const ready = await cli('readiness', f);
  assert.equal(ready.code, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).status, 'READY_FOR_OWNER_WINDOW');
  assert.deepEqual(await readFile(f.safetyFile), before);
  assert.deepEqual(await readFile(restoredCheckpoint), await readFile(checkpoint));
  assert.match(await readFile(path.join(restored, 'state.json'), 'utf8'), new RegExp(f.projectId));
  await writeFile(restoredCheckpoint, 'changed checkpoint\n', { mode: 0o600 });
  const changed = await cli('readiness', f);
  assert.equal(JSON.parse(changed.stdout).status, 'BLOCKED');
  assert.deepEqual(await readFile(f.safetyFile), before);
  const unknown = await cli('readiness', { ...f, dataRoot: path.join(f.root, 'absent-safety') });
  assert.equal(unknown.code, 1);
  await mkdir(path.join(f.root, 'absent-safety'), { mode: 0o700 });
  const missing = await cli('readiness', { ...f, dataRoot: path.join(f.root, 'absent-safety') });
  assert.equal(JSON.parse(missing.stdout).status, 'BLOCKED');
  await assert.rejects(readFile(path.join(f.root, 'absent-safety', 'production-safety.json')), { code: 'ENOENT' });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-safety-cli-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  const projectRoot = path.join(root, 'project');
  await mkdir(dataRoot, { mode: 0o700 });
  await mkdir(projectRoot, { mode: 0o700 });
  const identity = { runtimeId: await loadOrCreateRuntimeId(dataRoot), instanceId: randomUUID(), dataRoot };
  const token = await loadOrCreateOwnerAccessSecret(dataRoot);
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret: token, writerVerifier: createRuntimeWriterVerifier(dataRoot) });
  for (const writer of Object.keys(runtimeWriterBindings()) as SafetyWriterName[]) await controller.registerWriter(writer);
  const state = new RuntimeState(new FoundationStateStore(dataRoot, controller), undefined, new MissionLedgerStore(dataRoot, controller));
  const project = await state.registerProject('CLI evidence', projectRoot);
  const session = state.createSession('safety-cli');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const mission = await state.createMission(session.clientId, session.id, 'Retained mission', 'CHATGPT');
  const lifecycle = new DurableMissionLifecycleService(state, new DurableMissionLifecycleStore(dataRoot, controller));
  await lifecycle.ensureMission(mission.id);
  const broker = new MissionBrokerStore(dataRoot, controller);
  await broker.write(await broker.read());
  const permissions = new PermissionSettingsStore(dataRoot, controller);
  await permissions.initialize();
  await permissions.setMode('FULL_LOCAL_OWNER');
  const multiWorker = new MultiWorkerStore(dataRoot, controller);
  const multi = await multiWorker.read();
  await multiWorker.write({ ...multi, generation: multi.generation + 1 }, multi.generation);
  const securityAudit = new SecurityAuditStore(dataRoot, controller);
  const security = await securityAudit.read();
  await securityAudit.write({ ...security, generation: security.generation + 1 }, security.generation);
  return { root, dataRoot, identity, token, controller, projectId: project.id, safetyFile: path.join(dataRoot, 'production-safety.json') };
}

async function cli(command: string, fixture: { dataRoot: string; token: string }, args: readonly string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, IRIS_OWNER_ACCESS_TOKEN: fixture.token };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  try {
    const result = await execFileAsync(process.execPath, [
      '--require', path.resolve(import.meta.dirname, '../node_modules/tsx/dist/preflight.cjs'),
      '--import', pathToFileURL(path.resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs')).href,
      path.join(import.meta.dirname, 'production-safety-cli.ts'), command, '--data-root', fixture.dataRoot, ...args,
    ], { env, timeout: 15_000 });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? result.message };
  }
}
