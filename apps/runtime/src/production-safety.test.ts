import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductionSafetyController, createRuntimeBackup, restoreRuntimeBackup, verifyRuntimeBackup } from './production-safety.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('production safety foundation', () => {
  it('fails closed on unknown writers and fences new mutations after quiescence', async () => {
    const { controller, token } = await fixture();
    await controller.registerWriter('runtime-state');
    expect((await controller.quiesce(token)).state).toBe('BLOCKED');
    const writers = requiredWriters.filter((writer) => writer !== 'runtime-state');
    for (const writer of writers) await controller.registerWriter(writer);
    await controller.recover(token, {});
    const lease = await controller.beginMutation('runtime-state');
    const blocked = await controller.quiesce(token);
    expect(blocked.state).toBe('BLOCKED');
    await lease.release();
    await expect(controller.beginMutation('runtime-state')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await controller.recover(token, {});
    const fenced = await controller.quiesce(token);
    expect(fenced.state).toBe('QUIESCED');
    await expect(controller.beginMutation('runtime-state')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await controller.unfence(token);
    await (await controller.beginMutation('runtime-state')).release();
  });

  it('requires the current owner identity and detects interrupted quiescence on reopen', async () => {
    const fixtureData = await dataFixture();
    const first = await ProductionSafetyController.open({ dataRoot: fixtureData.dataRoot, identity: fixtureData.identity, ownerAccessSecret: fixtureData.token });
    for (const writer of ['runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'supervisor']) await first.registerWriter(writer);
    await expect(first.quiesce('wrong-token')).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    const lease = await first.beginMutation('runtime-state');
    const blocked = await first.quiesce(fixtureData.token);
    expect(blocked.state).toBe('BLOCKED');
    await lease.release();
    const reopened = await ProductionSafetyController.open({ dataRoot: fixtureData.dataRoot, identity: { ...fixtureData.identity, instanceId: 'different-instance' }, ownerAccessSecret: fixtureData.token });
    expect((await reopened.inspect()).state).toBe('RECOVERY_REQUIRED');
    await expect(reopened.quiesce(fixtureData.token, { 'external-runners': { state: 'IDLE' } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('blocks an integrated runtime writer while the owner fence is quiesced', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of ['runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'supervisor']) await controller.registerWriter(writer);
    for (const writer of requiredWriters) await controller.registerWriter(writer);
    await controller.quiesce(token);
    const state = new RuntimeState(new FoundationStateStore(dataRoot), undefined, undefined, controller);
    await expect(state.registerProject('blocked', root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('creates an integrity-checked backup and restores only to a disposable destination', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of requiredWriters) await controller.registerWriter(writer);
    await writeFile(path.join(dataRoot, 'state.json'), '{"schemaVersion":1}\n', { mode: 0o600 });
    await mkdir(path.join(dataRoot, 'nested'), { mode: 0o700 });
    await writeFile(path.join(dataRoot, 'nested', 'jobs.json'), '{"jobs":[]}\n', { mode: 0o600 });
    const checkpointFile = path.join(root, 'task-checkpoint.json');
    await writeFile(checkpointFile, '{"revision":1}\n', { mode: 0o600 });
    await controller.quiesce(token);
    expect((await controller.readiness()).status).toBe('BLOCKED');
    const backupRoot = path.join(root, 'backup');
    const manifest = await createRuntimeBackup({ controller, ownerAccessToken: token, destination: backupRoot, checkpointFile });
    expect(manifest.files.map((file) => file.path)).toContain('state.json');
    expect((await verifyRuntimeBackup(backupRoot)).backupId).toBe(manifest.backupId);
    await writeFile(path.join(backupRoot, 'unexpected.txt'), 'tamper\n', { mode: 0o600 });
    await expect(verifyRuntimeBackup(backupRoot)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await rm(path.join(backupRoot, 'unexpected.txt'));
    const restored = path.join(root, 'restored');
    const restoredCheckpoint = path.join(root, 'restored-task-checkpoint.json');
    await restoreRuntimeBackup({ controller, ownerAccessToken: token, backupRoot, destination: restored, disposable: true, checkpointFile: restoredCheckpoint });
    expect(await readFile(path.join(restored, 'nested', 'jobs.json'), 'utf8')).toContain('jobs');
    expect(await readFile(restoredCheckpoint, 'utf8')).toContain('revision');
    expect((await controller.readiness()).status).toBe('READY_FOR_OWNER_WINDOW');
    await expect(restoreRuntimeBackup({ controller, ownerAccessToken: token, backupRoot, destination: restored, disposable: true })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses symlinks and source-overlapping destinations', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of requiredWriters) await controller.registerWriter(writer);
    await writeFile(path.join(dataRoot, 'state.json'), 'safe\n', { mode: 0o600 });
    await symlink(path.join(dataRoot, 'state.json'), path.join(dataRoot, 'alias.json'));
    await controller.quiesce(token);
    await expect(createRuntimeBackup({ controller, ownerAccessToken: token, destination: path.join(root, 'backup') })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await rm(path.join(dataRoot, 'alias.json'));
    await expect(createRuntimeBackup({ controller, ownerAccessToken: token, destination: path.join(dataRoot, 'nested-backup') })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('keeps a winning lock when an independent contender is rejected', async () => {
    const { controller, dataRoot } = await fixture();
    const child = startChild(dataRoot, 'lock');
    await child.ready;
    await expect(controller.registerWriter('contender')).rejects.toMatchObject({ code: 'SUPERVISOR_BUSY' });
    await expect(readFile(path.join(dataRoot, 'production-safety.lock'))).resolves.toBeTruthy();
    child.process.stdin!.end('\n');
    await child.exit;
  });

  it('preserves concurrent lease accounting across independent Node processes', async () => {
    const { controller, dataRoot } = await fixture();
    await controller.registerWriter('runtime-state');
    const child = startChild(dataRoot, 'lease');
    await child.ready;
    const parentLease = await controller.beginMutation('runtime-state');
    expect((await controller.inspect()).writers['runtime-state']?.inFlight).toBe(2);
    await parentLease.release();
    expect((await controller.inspect()).writers['runtime-state']?.inFlight).toBe(1);
    child.process.stdin!.end('\n');
    await child.exit;
    expect((await controller.inspect()).writers['runtime-state']?.inFlight).toBe(0);
  });

  it('keeps inspection observational and rejects unverified writer labels', async () => {
    const data = await dataFixture();
    await expect(ProductionSafetyController.openReadOnly({ dataRoot: data.dataRoot })).resolves.toBeNull();
    await expect(stat(path.join(data.dataRoot, 'production-safety.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const controller = await ProductionSafetyController.open({ dataRoot: data.dataRoot, identity: data.identity, ownerAccessSecret: data.token });
    const before = (await controller.inspect()).generation;
    await expect(controller.quiesce(data.token, { 'external-runners': { state: 'IDLE' } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await controller.inspect()).generation).toBe(before);
  });

  it('holds a durable reservation until backup publication is explicitly completed', async () => {
    const { controller, token } = await fixture();
    for (const writer of requiredWriters) await controller.registerWriter(writer);
    await controller.quiesce(token);
    const reservation = await controller.reserveBackup(token, path.join(path.dirname((await controller.inspect()).identity.dataRoot), 'reserved-backup'));
    await expect(controller.unfence(token)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await controller.inspect()).reservation?.id).toBe(reservation.id);
    await controller.failReservation(token, reservation.id, 'test failure');
    await expect(controller.recover(token, {})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

async function fixture(): Promise<{ root: string; dataRoot: string; controller: ProductionSafetyController; token: string }> {
  const data = await dataFixture();
  const controller = await ProductionSafetyController.open({ dataRoot: data.dataRoot, identity: data.identity, ownerAccessSecret: data.token });
  return { ...data, controller };
}

const requiredWriters = [
  'runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'mission-lifecycle',
  'multi-worker', 'security-audit', 'resource-registry', 'permission-store', 'permission-audit',
  'activation', 'supervisor', 'external-runners',
] as const;

function startChild(dataRoot: string, mode: 'lock' | 'lease'): { readonly process: ChildProcess; readonly ready: Promise<void>; readonly exit: Promise<void> } {
  const root = path.resolve(import.meta.dirname, '../../..');
  const tsxDirectory = path.join(root, 'apps', 'runtime', 'node_modules', 'tsx', 'dist');
  const child = spawn(process.execPath, ['--require', path.join(tsxDirectory, 'preflight.cjs'), '--import', path.join(tsxDirectory, 'loader.mjs'), path.resolve(import.meta.dirname, 'production-safety-process-child.ts'), dataRoot, mode], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('READY\n')) resolve();
    });
    child.once('error', reject);
    const timer = setTimeout(() => reject(new Error(`safety child did not become ready: ${output}`)), 3000);
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('exit', (code) => { clearTimeout(timer); if (code !== 0 && !output.includes('READY\n')) reject(new Error(`safety child exited ${code}: ${output}`)); });
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`safety child exited ${code}: ${output}`)));
  });
  return { process: child, ready, exit };
}

async function dataFixture(): Promise<{ root: string; dataRoot: string; identity: { runtimeId: string; instanceId: string; dataRoot: string }; token: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-safety-test-'));
  roots.push(root);
  await chmod(root, 0o700);
  const dataRoot = path.join(root, 'runtime');
  await mkdir(dataRoot, { mode: 0o700 });
  const token = 'owner-token-for-test';
  return { root, dataRoot, token, identity: { runtimeId: 'runtime-test', instanceId: 'instance-test', dataRoot } };
}
