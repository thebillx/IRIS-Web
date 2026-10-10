import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductionSafetyController, createRuntimeBackup, restoreRuntimeBackup, verifyRuntimeBackup, type TrustedWriterVerification, type TrustedWriterVerifier } from './production-safety.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('production safety foundation', () => {
  it('fails closed on unknown writers and fences new mutations after quiescence', async () => {
    const { controller, token } = await fixture();
    await registerWriter(controller, 'runtime-state');
    expect((await controller.quiesce(token)).state).toBe('BLOCKED');
    const writers = requiredWriters.filter((writer) => writer !== 'runtime-state');
    await controller.recover(token, await verifiedObservations(controller, writers));
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
    const first = await ProductionSafetyController.open({ dataRoot: fixtureData.dataRoot, identity: fixtureData.identity, ownerAccessSecret: fixtureData.token, writerVerifier: createTrustedWriterVerifier() });
    for (const writer of ['runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'supervisor']) await registerWriter(first, writer);
    await expect(first.quiesce('wrong-token')).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    const lease = await first.beginMutation('runtime-state');
    const blocked = await first.quiesce(fixtureData.token);
    expect(blocked.state).toBe('BLOCKED');
    await lease.release();
    const reopened = await ProductionSafetyController.open({ dataRoot: fixtureData.dataRoot, identity: { ...fixtureData.identity, instanceId: 'different-instance' }, ownerAccessSecret: fixtureData.token });
    expect((await reopened.inspect()).state).toBe('RECOVERY_REQUIRED');
    await expect(reopened.quiesce(fixtureData.token, { 'external-runners': { state: 'IDLE' } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('does not clear an outstanding lease during startup with a new instance', async () => {
    const fixtureData = await dataFixture();
    const first = await ProductionSafetyController.open({ dataRoot: fixtureData.dataRoot, identity: fixtureData.identity, ownerAccessSecret: fixtureData.token });
    await registerWriter(first, 'runtime-state');
    await first.beginMutation('runtime-state');
    const reopened = await ProductionSafetyController.open({ dataRoot: fixtureData.dataRoot, identity: { ...fixtureData.identity, instanceId: 'restart-instance' }, ownerAccessSecret: fixtureData.token });
    expect((await reopened.inspect()).state).toBe('RECOVERY_REQUIRED');
    expect((await reopened.inspect()).writers['runtime-state']?.inFlight).toBe(1);
    await expect(registerWriter(reopened, 'runtime-state')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('blocks an integrated runtime writer while the owner fence is quiesced', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of ['runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'supervisor']) await registerWriter(controller, writer);
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    await controller.quiesce(token);
    const state = new RuntimeState(new FoundationStateStore(dataRoot), undefined, undefined, controller);
    await expect(state.registerProject('blocked', root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('fences durable session publication during quiescence and recovery', async () => {
    const { controller, token, dataRoot } = await fixture();
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    const state = new RuntimeState(new FoundationStateStore(dataRoot), undefined, undefined, controller);
    const session = await state.createSessionDurable('fenced-client', 'fenced-agent', 'owner');
    await controller.quiesce(token);

    await expect(state.createSessionDurable('blocked-client', 'blocked-agent', 'owner')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(state.submitInstruction(session.id, session.clientId, 'blocked-submission', 'must not publish')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const filename = path.join(dataRoot, 'sessions.json');
    const document = JSON.parse(await readFile(filename, 'utf8')) as { sessions: Array<{ snapshot: Record<string, unknown> }> };
    document.sessions[0]!.snapshot.executionState = 'WORKING';
    await writeFile(filename, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    const recovered = new RuntimeState(new FoundationStateStore(dataRoot), undefined, undefined, controller);
    await expect(recovered.reconcileSessionPersistence()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(JSON.parse(await readFile(filename, 'utf8')) as unknown).toMatchObject({ sessions: [{ snapshot: { executionState: 'WORKING' } }] });
  });

  it('creates an integrity-checked backup and restores only to a disposable destination', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of requiredWriters) await registerWriter(controller, writer);
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
    const readOnly = await ProductionSafetyController.openReadOnly({ dataRoot });
    expect(readOnly).not.toBeNull();
    expect((await readOnly!.readiness()).status).toBe('BLOCKED');
    await controller.unfence(token);
    expect((await controller.readiness()).status).toBe('BLOCKED');
    await expect(restoreRuntimeBackup({ controller, ownerAccessToken: token, backupRoot, destination: restored, disposable: true })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses symlinks and source-overlapping destinations', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    await writeFile(path.join(dataRoot, 'state.json'), 'safe\n', { mode: 0o600 });
    await symlink(path.join(dataRoot, 'state.json'), path.join(dataRoot, 'alias.json'));
    await controller.quiesce(token);
    await expect(createRuntimeBackup({ controller, ownerAccessToken: token, destination: path.join(root, 'backup') })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await rm(path.join(dataRoot, 'alias.json'));
    await expect(createRuntimeBackup({ controller, ownerAccessToken: token, destination: path.join(dataRoot, 'nested-backup') })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('isolates disposable restore destinations and checkpoint targets', async () => {
    const live = await readyBackupFixture();
    await expect(restoreRuntimeBackup({ controller: live.controller, ownerAccessToken: live.token, backupRoot: live.backup, destination: live.dataRoot, disposable: true, checkpointFile: path.join(live.root, 'live-checkpoint.json') })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const backupOverlap = await readyBackupFixture();
    await expect(restoreRuntimeBackup({ controller: backupOverlap.controller, ownerAccessToken: backupOverlap.token, backupRoot: backupOverlap.backup, destination: path.join(backupOverlap.backup, 'child'), disposable: true, checkpointFile: path.join(backupOverlap.root, 'child-checkpoint.json') })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const checkpointOverlap = await readyBackupFixture();
    await expect(restoreRuntimeBackup({ controller: checkpointOverlap.controller, ownerAccessToken: checkpointOverlap.token, backupRoot: checkpointOverlap.backup, destination: path.join(checkpointOverlap.root, 'restored'), disposable: true, checkpointFile: path.join(checkpointOverlap.dataRoot, 'checkpoint-target.json') })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const symlinked = await readyBackupFixture();
    await symlink(symlinked.root, path.join(symlinked.root, 'alias-parent'));
    await expect(restoreRuntimeBackup({ controller: symlinked.controller, ownerAccessToken: symlinked.token, backupRoot: symlinked.backup, destination: path.join(symlinked.root, 'alias-parent', 'restored'), disposable: true, checkpointFile: path.join(symlinked.root, 'alias-checkpoint.json') })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('keeps a winning lock when an independent contender is rejected', async () => {
    const { controller, dataRoot } = await fixture();
    const child = startChild(dataRoot, 'lock');
    await child.ready;
    await expect(registerWriter(controller, 'runtime-state')).rejects.toMatchObject({ code: 'SUPERVISOR_BUSY' });
    await expect(readFile(path.join(dataRoot, 'production-safety.lock'))).resolves.toBeTruthy();
    child.process.stdin!.end('\n');
    await child.exit;
  });

  it('preserves concurrent lease accounting across independent Node processes', async () => {
    const { controller, dataRoot } = await fixture();
    await registerWriter(controller, 'runtime-state');
    const child = startChild(dataRoot, 'lease');
    await child.ready;
    const parentLease = await controller.beginMutation('runtime-state');
    expect((await controller.inspect()).writers['runtime-state']?.inFlight).toBe(2);
    await expect(controller.quiesce('owner-token-for-test', { 'runtime-state': { state: 'IDLE', inFlight: 0 } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
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
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    await controller.quiesce(token);
    const reservation = await controller.reserveBackup(token, path.join(path.dirname((await controller.inspect()).identity.dataRoot), 'reserved-backup'));
    await expect(controller.unfence(token)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await controller.inspect()).reservation?.id).toBe(reservation.id);
    await controller.failReservation(token, reservation.id, 'test failure');
    await expect(controller.recover(token, {})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('holds a trusted maintenance fence across backup publication and fails closed when it becomes stale', async () => {
    const verifier = createTrustedWriterVerifier();
    const { controller, token, root } = await fixture(true, verifier);
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    await controller.quiesce(token);
    verifier.fenceAvailable = false;
    await expect(controller.reserveBackup(token, path.join(root, 'no-fence-backup'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    verifier.fenceAvailable = true;
    const reservation = await controller.reserveBackup(token, path.join(root, 'held-backup'));
    expect(verifier.activeFences.size).toBe(1);
    await expect(controller.beginMutation('runtime-state')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    verifier.state = 'ACTIVE';
    await expect(controller.completeBackup(token, reservation.id, {
      backupId: 'unpublished',
      destination: reservation.fence.reservation!.destination,
      manifestDigest: 'digest',
      sourceIdentity: reservation.fence.identity,
      fenceEpoch: reservation.fence.fenceEpoch,
      checkpointDigest: null,
      verifiedAt: new Date().toISOString(),
    })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    expect((await controller.inspect()).reservation?.id).toBe(reservation.id);
    expect(verifier.activeFences.size).toBe(1);
    verifier.state = 'IDLE';
    await controller.failReservation(token, reservation.id, 'test cleanup');
    expect(verifier.activeFences.size).toBe(0);
  });

  it('does not let observations erase an active lease during quiesce or recovery', async () => {
    const { controller, token } = await fixture();
    await registerWriter(controller, 'runtime-state');
    const lease = await controller.beginMutation('runtime-state');
    await expect(controller.quiesce(token, { 'runtime-state': { state: 'IDLE', inFlight: 0 } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await controller.inspect()).writers['runtime-state']?.inFlight).toBe(1);
    const blocked = await controller.quiesce(token);
    expect(blocked.state).toBe('BLOCKED');
    await expect(controller.recover(token, { 'runtime-state': { state: 'IDLE', inFlight: 0 } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await controller.inspect()).writers['runtime-state']?.inFlight).toBe(1);
    await lease.release();
  });

  it('requires verified registration and preserves fenced writer state', async () => {
    const { controller } = await untrustedFixture();
    await expect(controller.registerWriter('external-runners')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const trusted = await fixture();
    await registerWriter(trusted.controller, 'external-runners');
    const before = (await trusted.controller.inspect()).generation;
    await registerWriter(trusted.controller, 'external-runners');
    expect((await trusted.controller.inspect()).generation).toBe(before);
    await trusted.controller.quiesce(trusted.token);
    await expect(registerWriter(trusted.controller, 'external-runners', 'ACTIVE')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(() => controller.registerWriter('unexpected-writer', 'UNKNOWN')).toThrow('not supported');
  });

  it('rejects self-generated writer identity observations without a trusted verifier', async () => {
    const { controller, token } = await untrustedFixture();
    const snapshot = await controller.inspect();
    const fabricated = { state: 'IDLE' as const, inFlight: 0 as const, verified: true, runtimeId: snapshot.identity.runtimeId, instanceId: snapshot.identity.instanceId, fenceEpoch: snapshot.fenceEpoch };
    await expect(controller.quiesce(token, { 'external-runners': fabricated })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await controller.inspect()).writers['external-runners']?.state).toBe('UNKNOWN');
  });

  it('rejects registration from an independent process while backup is reserved', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    await controller.quiesce(token);
    const reservation = await controller.reserveBackup(token, path.join(root, 'cross-process-backup'));
    const child = startChild(dataRoot, 'registration');
    await child.ready;
    await expect(registerWriter(controller, 'runtime-state')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await controller.inspect()).reservation?.id).toBe(reservation.id);
    child.process.stdin!.end('\n');
    await child.exit;
    await controller.failReservation(token, reservation.id, 'test cleanup');
  });

  it('requires a trusted current writer proof for backup and restore reservations', async () => {
    const live = await readyBackupFixture();
    const unverified = await ProductionSafetyController.open({ dataRoot: live.dataRoot, identity: live.identity, ownerAccessSecret: live.token });
    const before = await unverified.inspect();
    await expect(unverified.reserveBackup(live.token, path.join(live.root, 'unverified-backup'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(unverified.reserveRestore(live.token, path.join(live.root, 'unverified-restore'), null)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await unverified.inspect()).generation).toBe(before.generation);
  });

  it('rejects unavailable, stale, or conflicting verifier evidence for reservations', async () => {
    const unavailableVerifier = createTrustedWriterVerifier();
    const unavailable = await fixture(true, unavailableVerifier);
    for (const writer of requiredWriters) await registerWriter(unavailable.controller, writer);
    await unavailable.controller.quiesce(unavailable.token);
    unavailableVerifier.available = false;
    await expect(unavailable.controller.reserveBackup(unavailable.token, path.join(unavailable.root, 'unavailable-backup'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    unavailableVerifier.available = true;
    unavailableVerifier.fail = true;
    await expect(unavailable.controller.reserveBackup(unavailable.token, path.join(unavailable.root, 'failed-backup'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const staleVerifier = createTrustedWriterVerifier();
    const stale = await fixture(true, staleVerifier);
    for (const writer of requiredWriters) await registerWriter(stale.controller, writer);
    await stale.controller.quiesce(stale.token);
    staleVerifier.generationOffset = 1;
    await expect(stale.controller.reserveBackup(stale.token, path.join(stale.root, 'stale-backup'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const conflictingVerifier = createTrustedWriterVerifier();
    const conflicting = await fixture(true, conflictingVerifier);
    for (const writer of requiredWriters) await registerWriter(conflicting.controller, writer);
    await conflicting.controller.quiesce(conflicting.token);
    conflictingVerifier.runtimeIdOverride = 'different-runtime';
    await expect(conflicting.controller.reserveBackup(conflicting.token, path.join(conflicting.root, 'conflicting-backup'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('binds restore evidence to the current backup', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    await writeFile(path.join(dataRoot, 'state.json'), 'safe\n', { mode: 0o600 });
    const checkpointFile = path.join(root, 'task-checkpoint.json');
    await writeFile(checkpointFile, '{"revision":1}\n', { mode: 0o600 });
    await controller.quiesce(token);
    const backupA = path.join(root, 'backup-a');
    await createRuntimeBackup({ controller, ownerAccessToken: token, destination: backupA, checkpointFile });
    const backupB = path.join(root, 'backup-b');
    await createRuntimeBackup({ controller, ownerAccessToken: token, destination: backupB, checkpointFile });
    await expect(restoreRuntimeBackup({ controller, ownerAccessToken: token, backupRoot: backupA, destination: path.join(root, 'restored-a'), disposable: true, checkpointFile: path.join(root, 'restored-a-checkpoint.json') })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await controller.inspect()).state).toBe('BLOCKED');
    expect((await controller.readiness()).status).toBe('BLOCKED');
  });

  it('excludes transient safety locks from backup manifests', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    await writeFile(path.join(dataRoot, 'state.json'), 'safe\n', { mode: 0o600 });
    await controller.quiesce(token);
    const backup = await createRuntimeBackup({ controller, ownerAccessToken: token, destination: path.join(root, 'backup') });
    expect(backup.files.map((file) => file.path)).not.toContain('production-safety.lock');
    await writeFile(path.join(root, 'backup', 'production-safety.lock'), 'transient\n', { mode: 0o600 });
    await expect(verifyRuntimeBackup(path.join(root, 'backup'))).resolves.toMatchObject({ backupId: backup.backupId });
  });

  it('rechecks writer inventory before readiness', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    await writeFile(path.join(dataRoot, 'state.json'), 'safe\n', { mode: 0o600 });
    const checkpointFile = path.join(root, 'task-checkpoint.json');
    await writeFile(checkpointFile, '{"revision":1}\n', { mode: 0o600 });
    await controller.quiesce(token);
    await createRuntimeBackup({ controller, ownerAccessToken: token, destination: path.join(root, 'backup'), checkpointFile });
    await restoreRuntimeBackup({ controller, ownerAccessToken: token, backupRoot: path.join(root, 'backup'), destination: path.join(root, 'restored'), disposable: true, checkpointFile: path.join(root, 'restored-checkpoint.json') });
    expect((await controller.readiness()).status).toBe('READY_FOR_OWNER_WINDOW');
    const filename = path.join(dataRoot, 'production-safety.json');
    const document = JSON.parse(await readFile(filename, 'utf8')) as { writers: Record<string, { state: string; ownerInstanceId: string | null }> };
    document.writers['external-runners'] = { ...document.writers['external-runners']!, state: 'UNKNOWN', ownerInstanceId: null };
    await writeFile(filename, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    expect((await controller.readiness()).status).toBe('BLOCKED');
  });

  it('freshly verifies external writers before claiming quiescence', async () => {
    const verified = createTrustedWriterVerifier();
    const { controller, token } = await fixture(true, verified);
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    verified.state = 'ACTIVE';
    const blocked = await controller.quiesce(token);
    expect(blocked.state).toBe('BLOCKED');
    expect(blocked.blockedReason).toContain('fresh verification');
  });

  it('rechecks external writers when quiesce is called again after a fence', async () => {
    const verified = createTrustedWriterVerifier();
    const { controller, token } = await fixture(true, verified);
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    expect((await controller.quiesce(token)).state).toBe('QUIESCED');
    verified.state = 'ACTIVE';
    const blocked = await controller.quiesce(token);
    expect(blocked.state).toBe('BLOCKED');
    expect(blocked.blockedReason).toContain('fresh verification');
  });

  it('persists external activity separately from controller lease accounting', async () => {
    const verified = createTrustedWriterVerifier();
    const { controller, token } = await fixture(true, verified);
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    verified.state = 'ACTIVE';
    verified.inFlight = 1;
    const blocked = await controller.quiesce(token, { 'external-runners': { state: 'ACTIVE', inFlight: 1 } });
    expect(blocked.state).toBe('BLOCKED');
    const record = (await controller.inspect()).writers['external-runners'];
    expect(record).toMatchObject({ state: 'ACTIVE', inFlight: 0, observedState: 'ACTIVE', observedInFlight: 1, leaseIds: [] });
    await expect(controller.inspect()).resolves.toMatchObject({ state: 'BLOCKED' });
  });

  it('blocks readiness when verified backup or restored checkpoint changes', async () => {
    const { controller, token, dataRoot, root } = await fixture();
    for (const writer of requiredWriters) await registerWriter(controller, writer);
    await writeFile(path.join(dataRoot, 'state.json'), 'safe\n', { mode: 0o600 });
    const checkpointFile = path.join(root, 'task-checkpoint.json');
    const restoredCheckpoint = path.join(root, 'restored-checkpoint.json');
    await writeFile(checkpointFile, '{"revision":1}\n', { mode: 0o600 });
    await controller.quiesce(token);
    const backup = path.join(root, 'backup');
    await createRuntimeBackup({ controller, ownerAccessToken: token, destination: backup, checkpointFile });
    await restoreRuntimeBackup({ controller, ownerAccessToken: token, backupRoot: backup, destination: path.join(root, 'restored'), disposable: true, checkpointFile: restoredCheckpoint });
    expect((await controller.readiness()).status).toBe('READY_FOR_OWNER_WINDOW');
    await writeFile(restoredCheckpoint, 'tampered\n', { mode: 0o600 });
    expect((await controller.readiness()).status).toBe('BLOCKED');
    await writeFile(restoredCheckpoint, '{"revision":1}\n', { mode: 0o600 });
    const manifestFile = path.join(backup, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { createdAt: string };
    manifest.createdAt = `${manifest.createdAt}-tampered`;
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    expect((await controller.readiness()).status).toBe('BLOCKED');
  });

  it('keeps a mutation lease retryable after lock contention', async () => {
    const { controller, dataRoot } = await fixture();
    await registerWriter(controller, 'runtime-state');
    const lease = await controller.beginMutation('runtime-state');
    await controller.registerWriter('runtime-state', 'ACTIVE');
    expect((await controller.inspect()).writers['runtime-state']?.inFlight).toBe(1);
    const child = startChild(dataRoot, 'lock');
    await child.ready;
    await expect(lease.release()).rejects.toMatchObject({ code: 'SUPERVISOR_BUSY' });
    expect((await controller.inspect()).writers['runtime-state']?.inFlight).toBe(1);
    child.process.stdin!.end('\n');
    await child.exit;
    await lease.release();
    await lease.release();
    expect((await controller.inspect()).writers['runtime-state']?.inFlight).toBe(0);
  });
});

type TestWriterVerifier = TrustedWriterVerifier & { available: boolean; fail: boolean; generationOffset: number; runtimeIdOverride?: string; state: 'IDLE' | 'ACTIVE'; inFlight: number; fenceAvailable: boolean; fenceCount: number; activeFences: Set<string> };

function createTrustedWriterVerifier(): TestWriterVerifier {
  const verifier: TestWriterVerifier = {
    available: true,
    fail: false,
    generationOffset: 0,
    state: 'IDLE' as 'IDLE' | 'ACTIVE',
    inFlight: 0,
    fenceAvailable: true,
    fenceCount: 0,
    activeFences: new Set(),
    verify: async (_writer: Parameters<TrustedWriterVerifier['verify']>[0], identity: Parameters<TrustedWriterVerifier['verify']>[1], context: Parameters<TrustedWriterVerifier['verify']>[2]): Promise<TrustedWriterVerification | null> => {
      if (!verifier.available) return null;
      if (verifier.fail) throw new Error('test verifier unavailable');
      return {
        state: verifier.state,
        inFlight: verifier.inFlight,
        runtimeId: verifier.runtimeIdOverride ?? identity.runtimeId,
        instanceId: identity.instanceId,
        dataRoot: identity.dataRoot,
        fenceEpoch: context.fenceEpoch,
        generation: context.generation + verifier.generationOffset,
      };
    },
    acquireMaintenanceFence: async () => {
      if (!verifier.fenceAvailable || !verifier.available || verifier.fail) return null;
      const fenceId = `test-fence-${verifier.fenceCount += 1}`;
      verifier.activeFences.add(fenceId);
      return {
        fenceId,
        revalidate: async () => verifier.activeFences.has(fenceId) && verifier.available && !verifier.fail && verifier.state === 'IDLE' && verifier.inFlight === 0,
        release: async () => { verifier.activeFences.delete(fenceId); },
      };
    },
  };
  return verifier;
}

async function fixture(trusted = true, verifier?: TestWriterVerifier): Promise<{ root: string; dataRoot: string; controller: ProductionSafetyController; token: string; identity: { runtimeId: string; instanceId: string; dataRoot: string } }> {
  const data = await dataFixture();
  const writerVerifier = trusted ? (verifier ?? createTrustedWriterVerifier()) : undefined;
  const controller = await ProductionSafetyController.open({ dataRoot: data.dataRoot, identity: data.identity, ownerAccessSecret: data.token, ...(writerVerifier === undefined ? {} : { writerVerifier }) });
  return { ...data, controller };
}

async function untrustedFixture(): Promise<{ root: string; dataRoot: string; controller: ProductionSafetyController; token: string }> {
  return fixture(false);
}

async function registerWriter(controller: ProductionSafetyController, writer: string, state: 'IDLE' | 'ACTIVE' | 'UNKNOWN' = 'IDLE'): Promise<void> {
  await controller.registerWriter(writer, state);
}

async function verifiedObservations(_controller: ProductionSafetyController, writers: readonly string[]): Promise<Record<string, { state: 'IDLE'; inFlight: 0 }>> {
  return Object.fromEntries(writers.map((writer) => [writer, {
    state: 'IDLE' as const,
    inFlight: 0 as const,
  }]));
}

async function readyBackupFixture(): Promise<{ root: string; dataRoot: string; token: string; identity: { runtimeId: string; instanceId: string; dataRoot: string }; controller: ProductionSafetyController; backup: string }> {
  const data = await fixture();
  for (const writer of requiredWriters) await registerWriter(data.controller, writer);
  await writeFile(path.join(data.dataRoot, 'state.json'), 'safe\n', { mode: 0o600 });
  await data.controller.quiesce(data.token);
  const backup = path.join(data.root, 'backup');
  await createRuntimeBackup({ controller: data.controller, ownerAccessToken: data.token, destination: backup });
  return { ...data, backup };
}

const requiredWriters = [
  'runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'mission-lifecycle',
  'multi-worker', 'security-audit', 'resource-registry', 'permission-store', 'permission-audit',
  'activation', 'supervisor', 'external-runners',
] as const;

function startChild(dataRoot: string, mode: 'lock' | 'lease' | 'reservation' | 'registration', destination?: string): { readonly process: ChildProcess; readonly ready: Promise<void>; readonly exit: Promise<void> } {
  const root = path.resolve(import.meta.dirname, '../../..');
  const tsxDirectory = path.join(root, 'apps', 'runtime', 'node_modules', 'tsx', 'dist');
  const child = spawn(process.execPath, ['--require', path.join(tsxDirectory, 'preflight.cjs'), '--import', path.join(tsxDirectory, 'loader.mjs'), path.resolve(import.meta.dirname, 'production-safety-process-child.ts'), dataRoot, mode, destination ?? ''], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
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
