import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSupervisorStateFile, writeSupervisorStateFile, unresolvedStartup, validStartupOperations, startupStates, type StartupOperation } from './supervisor-startup.js';

const { identity } = vi.hoisted(() => ({ identity: vi.fn(() => ({ state: 'live', marker: '123:456' })) }));
vi.mock('./macos-safety.js', async () => ({ ...await vi.importActual<typeof import('./macos-safety.js')>('./macos-safety.js'), observeProcessStart: identity }));
import { createSupervisor } from './supervisor.js';

const roots: string[] = [];
afterEach(async () => { identity.mockReturnValue({ state: 'live', marker: '123:456' }); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const value = await mkdtemp(path.join(os.tmpdir(), 'iris-startup-contract-')); roots.push(value); return value; }
function operation(): StartupOperation {
  return { version: 1, id: randomUUID(), transactionId: randomUUID(), component: 'web', state: 'SPAWNING', supervisorPid: 42, supervisorStartMarker: '123:456', sourceRoot: '/private/tmp/source', dataRoot: '/private/tmp/data', executable: '/usr/bin/true', profilePath: null, configurationDigest: 'a'.repeat(64), pid: null, processStartMarker: null, processExecutable: null, failureCode: null };
}
interface Internals {
  readState(): Promise<Record<string, unknown> & { startupOperations: StartupOperation[] }>;
  writeState(state: unknown, replace?: boolean): Promise<void>;
  prepareStartup(component: string, executable: string, source: string, profile: null, environment: Record<string, string>): Promise<string>;
  assertStartupReconciled(): Promise<void>;
  updateStartup(id: string, phase: string, observation?: Record<string, unknown>): Promise<void>;
}
async function supervisorFixture() {
  const dataRoot = await root();
  await mkdir(path.join(dataRoot, 'supervisor'), { mode: 0o700 });
  const supervisor = await createSupervisor({ dataRoot, sourceRoot: dataRoot });
  return { dataRoot, supervisor, internal: supervisor as unknown as Internals };
}

describe('Supervisor durable startup contract', () => {
  it('bounds operations, rejects malformed records and never treats PID alone as ownership', () => {
    expect(validStartupOperations([operation()])).toBe(true);
    for (const state of ['OWNERSHIP_VERIFIED', 'RUNNING'] as const) expect(validStartupOperations([{ ...operation(), state, pid: 42 }])).toBe(false);
    expect(validStartupOperations(Array.from({ length: 39 }, operation))).toBe(false);
    expect(validStartupOperations([{ ...operation(), configurationDigest: 'raw-secret' }])).toBe(false);
    expect(validStartupOperations([{ ...operation(), historicalOwnership: { version: 1, sourceSchemaVersion: 3, method: 'RUNTIME_AUTHORITY_ENDPOINT', historicalRecordDigest: 'b'.repeat(64), listenerPorts: [43_110] } }])).toBe(true);
    expect(validStartupOperations([{ ...operation(), historicalOwnership: { version: 1, sourceSchemaVersion: 4, method: 'RUNTIME_AUTHORITY_ENDPOINT', historicalRecordDigest: 'b'.repeat(64), listenerPorts: [43_110] } }])).toBe(false);
    const duplicate = operation(); expect(validStartupOperations([duplicate, duplicate])).toBe(false);
  });
  it.each(startupStates)('classifies %s without promoting ambiguous ownership', (state) => {
    expect(unresolvedStartup({ ...operation(), state })).toBe(!['RUNNING', 'STOPPED', 'SPAWN_FAILED'].includes(state));
  });
  it('writes PREPARED and SPAWNING before a caller may create an OS child', async () => {
    const { dataRoot, internal } = await supervisorFixture();
    const id = await internal.prepareStartup('web', process.execPath, dataRoot, null, { SYNTHETIC_TOKEN: 'never-persist-this' });
    const state = await internal.readState();
    expect(state.schemaVersion).toBe(4);
    expect(state.startupOperations).toHaveLength(1);
    expect(state.startupOperations[0]).toMatchObject({ id, state: 'SPAWNING', supervisorPid: process.pid, supervisorStartMarker: '123:456', pid: null });
    expect(await readFile(path.join(dataRoot, 'supervisor/state.json'), 'utf8')).not.toContain('never-persist-this');
    await expect(internal.prepareStartup('web', process.execPath, dataRoot, null, {})).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
  });
  it.each(['SPAWNING', 'OWNERSHIP_UNVERIFIED', 'CLEANUP_PENDING', 'CLEANUP_FAILED', 'RECONCILIATION_REQUIRED'] as const)('blocks restart and duplicate spawning from %s', async (state) => {
    const { internal, dataRoot } = await supervisorFixture();
    await internal.writeState({ ...await internal.readState(), startupOperations: [{ ...operation(), state, sourceRoot: dataRoot, dataRoot }] }, true);
    await expect(internal.assertStartupReconciled()).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    expect((await internal.readState()).startupOperations[0]?.state).toBe('RECONCILIATION_REQUIRED');
  });
  it('rejects future schema, malformed state and downgrade carrying unresolved ownership', async () => {
    const { dataRoot, internal } = await supervisorFixture();
    const state = await internal.readState();
    const filename = path.join(dataRoot, 'supervisor/state.json');
    for (const value of [{ ...state, schemaVersion: 5 }, { ...state, schemaVersion: 3, startupOperations: [operation()] }, { schemaVersion: 4 }]) {
      await writeSupervisorStateFile(filename, value);
      await expect(internal.readState()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    }
  });
  it.each([1, 2, 3])('reads historical schema %s without migrating on inspection', async (schemaVersion) => {
    const { dataRoot, internal } = await supervisorFixture();
    const state = { ...await internal.readState() } as Record<string, unknown>;
    delete state.startupOperations;
    const filename = path.join(dataRoot, 'supervisor/state.json');
    await writeSupervisorStateFile(filename, { ...state, schemaVersion });
    const before = await readFile(filename);
    expect((await internal.readState()).startupOperations).toEqual([]);
    expect(await readFile(filename)).toEqual(before);
  });
  it('preserves operations when a caller writes an older component snapshot', async () => {
    const { internal } = await supervisorFixture();
    const old = await internal.readState();
    await internal.writeState({ ...old, startupOperations: [operation()] }, true);
    await internal.writeState(old);
    expect((await internal.readState()).startupOperations).toHaveLength(1);
  });
  it('returns deliberately without relaunching children only with durable failure evidence', async () => {
    const { internal, supervisor } = await supervisorFixture();
    await internal.writeState({ ...await internal.readState(), startupOperations: [operation()] }, true);
    const before = await internal.readState();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try { await supervisor.runSupervisorDaemon(); } finally { consoleSpy.mockRestore(); }
    expect((await internal.readState()).startupOperations).toEqual(before.startupOperations);
  });
});

describe('Supervisor private state persistence', () => {
  it('defaults only missing files, rejects symlinks, unsafe modes, directories and oversized files', async () => {
    const directory = await root(); const filename = path.join(directory, 'state.json');
    expect(await readSupervisorStateFile(filename)).toBeNull();
    await writeSupervisorStateFile(filename, { safe: true });
    expect(JSON.parse((await readSupervisorStateFile(filename))!)).toEqual({ safe: true });
    await chmod(filename, 0o644);
    await expect(readSupervisorStateFile(filename)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await rm(filename); await symlink('/dev/null', filename);
    await expect(readSupervisorStateFile(filename)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await rm(filename); await mkdir(filename);
    await expect(readSupervisorStateFile(filename)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await rm(filename, { recursive: true }); await writeFile(filename, 'a'.repeat(1_048_577), { mode: 0o600 });
    await expect(readSupervisorStateFile(filename)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });
  it('rejects oversized writes without replacing existing durable state', async () => {
    const directory = await root(); const filename = path.join(directory, 'state.json');
    await writeSupervisorStateFile(filename, { safe: true });
    await expect(writeSupervisorStateFile(filename, 'a'.repeat(1_048_577))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    expect(JSON.parse((await readSupervisorStateFile(filename))!)).toEqual({ safe: true });
  });
});
