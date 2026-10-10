import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    expect((await controller.quiesce(token, { 'external-runners': { state: 'IDLE' } })).state).toBe('BLOCKED');
    const writers = ['mission-state', 'mission-broker', 'durable-jobs', 'supervisor'];
    for (const writer of writers) await controller.registerWriter(writer);
    await controller.recover(token, { 'external-runners': { state: 'IDLE' } });
    const lease = await controller.beginMutation('runtime-state');
    const blocked = await controller.quiesce(token, { 'external-runners': { state: 'IDLE' } });
    expect(blocked.state).toBe('BLOCKED');
    await lease.release();
    await expect(controller.beginMutation('runtime-state')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await controller.recover(token, { 'external-runners': { state: 'IDLE' } });
    const fenced = await controller.quiesce(token, { 'external-runners': { state: 'IDLE' } });
    expect(fenced.state).toBe('QUIESCED');
    await expect(controller.beginMutation('runtime-state')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await controller.unfence(token);
    await (await controller.beginMutation('runtime-state')).release();
  });

  it('requires the current owner identity and detects interrupted quiescence on reopen', async () => {
    const fixtureData = await dataFixture();
    const first = await ProductionSafetyController.open({ dataRoot: fixtureData.dataRoot, identity: fixtureData.identity, ownerAccessSecret: fixtureData.token });
    for (const writer of ['runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'supervisor']) await first.registerWriter(writer);
    await expect(first.quiesce('wrong-token', { 'external-runners': { state: 'IDLE' } })).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    const lease = await first.beginMutation('runtime-state');
    const blocked = await first.quiesce(fixtureData.token, { 'external-runners': { state: 'IDLE' } });
    expect(blocked.state).toBe('BLOCKED');
    await lease.release();
    const reopened = await ProductionSafetyController.open({ dataRoot: fixtureData.dataRoot, identity: { ...fixtureData.identity, instanceId: 'different-instance' }, ownerAccessSecret: fixtureData.token });
    expect((await reopened.inspect()).state).toBe('RECOVERY_REQUIRED');
    await expect(reopened.quiesce(fixtureData.token, { 'external-runners': { state: 'IDLE' } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('blocks an integrated runtime writer while the owner fence is quiesced', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of ['runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'supervisor']) await controller.registerWriter(writer);
    await controller.quiesce(token, { 'external-runners': { state: 'IDLE' } });
    const state = new RuntimeState(new FoundationStateStore(dataRoot), undefined, undefined, controller);
    await expect(state.registerProject('blocked', root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('creates an integrity-checked backup and restores only to a disposable destination', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of ['runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'supervisor']) await controller.registerWriter(writer);
    await writeFile(path.join(dataRoot, 'state.json'), '{"schemaVersion":1}\n', { mode: 0o600 });
    await mkdir(path.join(dataRoot, 'nested'), { mode: 0o700 });
    await writeFile(path.join(dataRoot, 'nested', 'jobs.json'), '{"jobs":[]}\n', { mode: 0o600 });
    await controller.quiesce(token, { 'external-runners': { state: 'IDLE' } });
    const backupRoot = path.join(root, 'backup');
    const manifest = await createRuntimeBackup({ controller, ownerAccessToken: token, destination: backupRoot });
    expect(manifest.files.map((file) => file.path)).toContain('state.json');
    expect((await verifyRuntimeBackup(backupRoot)).backupId).toBe(manifest.backupId);
    await writeFile(path.join(backupRoot, 'unexpected.txt'), 'tamper\n', { mode: 0o600 });
    await expect(verifyRuntimeBackup(backupRoot)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await rm(path.join(backupRoot, 'unexpected.txt'));
    const restored = path.join(root, 'restored');
    await restoreRuntimeBackup({ controller, ownerAccessToken: token, backupRoot, destination: restored, disposable: true });
    expect(await readFile(path.join(restored, 'nested', 'jobs.json'), 'utf8')).toContain('jobs');
    expect((await controller.readiness()).status).toBe('READY_FOR_OWNER_WINDOW');
    await expect(restoreRuntimeBackup({ controller, ownerAccessToken: token, backupRoot, destination: restored, disposable: true })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses symlinks and source-overlapping destinations', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of ['runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'supervisor']) await controller.registerWriter(writer);
    await writeFile(path.join(dataRoot, 'state.json'), 'safe\n', { mode: 0o600 });
    await symlink(path.join(dataRoot, 'state.json'), path.join(dataRoot, 'alias.json'));
    await controller.quiesce(token, { 'external-runners': { state: 'IDLE' } });
    await expect(createRuntimeBackup({ controller, ownerAccessToken: token, destination: path.join(root, 'backup') })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await rm(path.join(dataRoot, 'alias.json'));
    await expect(createRuntimeBackup({ controller, ownerAccessToken: token, destination: path.join(dataRoot, 'nested-backup') })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

async function fixture(): Promise<{ root: string; dataRoot: string; controller: ProductionSafetyController; token: string }> {
  const data = await dataFixture();
  const controller = await ProductionSafetyController.open({ dataRoot: data.dataRoot, identity: data.identity, ownerAccessSecret: data.token });
  return { ...data, controller };
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
