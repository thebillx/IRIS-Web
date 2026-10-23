import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ProductionSafetyController, createRuntimeBackup, restoreRuntimeBackup, verifyRuntimeBackup, type TrustedWriterVerifier } from './production-safety.js';

const roots: string[] = [];
const writers = [
  'runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'mission-lifecycle',
  'multi-worker', 'security-audit', 'resource-registry', 'permission-store', 'permission-audit',
  'activation', 'supervisor', 'external-runners',
] as const;

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test('M74 unknown writer inventory fails closed until every writer is admitted', async () => {
  const fixture = await createFixture();
  for (const writer of writers.slice(0, -1)) await fixture.controller.registerWriter(writer);
  const blocked = await fixture.controller.quiesce(fixture.token);
  assert.equal(blocked.state, 'BLOCKED');
  await fixture.controller.recover(fixture.token, { 'external-runners': { state: 'IDLE' } });
  const fenced = await fixture.controller.quiesce(fixture.token);
  assert.equal(fenced.state, 'QUIESCED');
  await assert.rejects(fixture.controller.beginMutation('runtime-state'), { code: 'PRECONDITION_FAILED' });
});

test('M74 owner fence rejects incorrect identity and preserves restart recovery evidence', async () => {
  const fixture = await createFixture();
  for (const writer of writers) await fixture.controller.registerWriter(writer);
  await assert.rejects(fixture.controller.quiesce('wrong-owner'), { code: 'CONTROL_DENIED' });
  const lease = await fixture.controller.beginMutation('runtime-state');
  const reopened = await ProductionSafetyController.open({
    dataRoot: fixture.dataRoot,
    identity: { ...fixture.identity, instanceId: 'restart-instance' },
    ownerAccessSecret: fixture.token,
    writerVerifier: fixture.verifier,
  });
  assert.equal((await reopened.inspect()).state, 'RECOVERY_REQUIRED');
  assert.equal((await reopened.inspect()).writers['runtime-state']?.inFlight, 1);
  await lease.release();
});

test('M74 backup publication and disposable restore are integrity checked', async () => {
  const fixture = await createFixture();
  for (const writer of writers) await fixture.controller.registerWriter(writer);
  await writeFile(path.join(fixture.dataRoot, 'state.json'), '{"schemaVersion":1}\n', { mode: 0o600 });
  await mkdir(path.join(fixture.dataRoot, 'nested'), { mode: 0o700 });
  await writeFile(path.join(fixture.dataRoot, 'nested', 'jobs.json'), '{"jobs":[]}\n', { mode: 0o600 });
  const checkpoint = path.join(fixture.root, 'checkpoint.json');
  await writeFile(checkpoint, '{"revision":1}\n', { mode: 0o600 });
  await fixture.controller.quiesce(fixture.token);
  const backup = path.join(fixture.root, 'backup');
  const manifest = await createRuntimeBackup({ controller: fixture.controller, ownerAccessToken: fixture.token, destination: backup, checkpointFile: checkpoint });
  assert.equal((await verifyRuntimeBackup(backup)).backupId, manifest.backupId);
  await writeFile(path.join(backup, 'unexpected.txt'), 'tamper\n', { mode: 0o600 });
  await assert.rejects(verifyRuntimeBackup(backup), { code: 'PERSISTENCE_FAILURE' });
  await rm(path.join(backup, 'unexpected.txt'));
  const restored = path.join(fixture.root, 'restored');
  const restoredCheckpoint = path.join(fixture.root, 'restored-checkpoint.json');
  await restoreRuntimeBackup({ controller: fixture.controller, ownerAccessToken: fixture.token, backupRoot: backup, destination: restored, disposable: true, checkpointFile: restoredCheckpoint });
  assert.match(await readFile(path.join(restored, 'nested', 'jobs.json'), 'utf8'), /jobs/);
  assert.match(await readFile(restoredCheckpoint, 'utf8'), /revision/);
  assert.equal((await fixture.controller.readiness()).status, 'READY_FOR_OWNER_WINDOW');
  await assert.rejects(restoreRuntimeBackup({ controller: fixture.controller, ownerAccessToken: fixture.token, backupRoot: backup, destination: fixture.dataRoot, disposable: true }), { code: 'PRECONDITION_FAILED' });
});

test('M74 rejects symlinked data and overlapping backup destinations', async () => {
  const fixture = await createFixture();
  for (const writer of writers) await fixture.controller.registerWriter(writer);
  await writeFile(path.join(fixture.dataRoot, 'state.json'), 'safe\n', { mode: 0o600 });
  await symlink(path.join(fixture.dataRoot, 'state.json'), path.join(fixture.dataRoot, 'alias.json'));
  await fixture.controller.quiesce(fixture.token);
  await assert.rejects(createRuntimeBackup({ controller: fixture.controller, ownerAccessToken: fixture.token, destination: path.join(fixture.root, 'backup') }), { code: 'PERSISTENCE_FAILURE' });
  await rm(path.join(fixture.dataRoot, 'alias.json'));
  await assert.rejects(createRuntimeBackup({ controller: fixture.controller, ownerAccessToken: fixture.token, destination: path.join(fixture.dataRoot, 'nested-backup') }), { code: 'PRECONDITION_FAILED' });
});

test('M74 failed reservation remains durable and blocks recovery until reconciled', async () => {
  const fixture = await createFixture();
  for (const writer of writers) await fixture.controller.registerWriter(writer);
  await fixture.controller.quiesce(fixture.token);
  const reservation = await fixture.controller.reserveBackup(fixture.token, path.join(fixture.root, 'backup'));
  await fixture.controller.failReservation(fixture.token, reservation.id, 'injected publication failure');
  const snapshot = await fixture.controller.inspect();
  assert.equal(snapshot.reservation?.status, 'FAILED');
  await assert.rejects(fixture.controller.recover(fixture.token, {}), { code: 'PRECONDITION_FAILED' });
});

test('M74 readiness freshly verifies non-instrumented writers before owner window', async () => {
  let drift = false;
  const fixture = await createFixture(() => drift);
  for (const writer of writers) await fixture.controller.registerWriter(writer);
  await writeFile(path.join(fixture.dataRoot, 'state.json'), 'safe\n', { mode: 0o600 });
  const checkpoint = path.join(fixture.root, 'checkpoint.json');
  await writeFile(checkpoint, 'checkpoint\n', { mode: 0o600 });
  await fixture.controller.quiesce(fixture.token);
  await createRuntimeBackup({ controller: fixture.controller, ownerAccessToken: fixture.token, destination: path.join(fixture.root, 'backup'), checkpointFile: checkpoint });
  const restored = path.join(fixture.root, 'restored');
  await restoreRuntimeBackup({ controller: fixture.controller, ownerAccessToken: fixture.token, backupRoot: path.join(fixture.root, 'backup'), destination: restored, disposable: true, checkpointFile: path.join(fixture.root, 'restored-checkpoint.json') });
  drift = true;
  const readiness = await fixture.controller.readiness();
  assert.equal(readiness.status, 'BLOCKED');
  assert.match(readiness.reasons.join('; '), /writer mission-lifecycle could not be freshly verified|changed during readiness/);
});

async function createFixture(drift?: () => boolean): Promise<{
  readonly root: string;
  readonly dataRoot: string;
  readonly token: string;
  readonly identity: { readonly runtimeId: string; readonly instanceId: string; readonly dataRoot: string };
  readonly verifier: TrustedWriterVerifier;
  readonly controller: ProductionSafetyController;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-m74-safety-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  await mkdir(dataRoot, { mode: 0o700 });
  const token = 'owner-token-for-m74-test';
  const identity = { runtimeId: 'runtime-m74-test', instanceId: 'instance-m74-test', dataRoot };
  const verifier: TrustedWriterVerifier = {
    verify: async (writer, currentIdentity, context) => ({
      state: drift?.() && writer === 'mission-lifecycle' ? 'ACTIVE' : 'IDLE', inFlight: 0, runtimeId: currentIdentity.runtimeId, instanceId: currentIdentity.instanceId,
      dataRoot: currentIdentity.dataRoot, fenceEpoch: context.fenceEpoch, generation: context.generation,
    }),
  };
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret: token, writerVerifier: verifier });
  return { root, dataRoot, token, identity, verifier, controller };
}
