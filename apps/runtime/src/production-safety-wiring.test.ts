import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ProductionSafetyController, createRuntimeBackup, restoreRuntimeBackup, type SafetyWriterName } from './production-safety.js';
import { createRuntimeWriterVerifier, runtimeWriterBindings } from './production-safety-wiring.js';

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
