import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeError } from '@iris/domain';
import type { ProcessStartObservation } from './macos-safety.js';
import { writeSupervisorStateFile, type StartupOperation, type StartupState } from './supervisor-startup.js';

const mocks = vi.hoisted(() => ({
  observe: vi.fn(), status: vi.fn(), start: vi.fn(), stop: vi.fn(), native: vi.fn(), admin: vi.fn(),
  actualObserve: null as null | ((pid: number) => ProcessStartObservation),
}));
vi.mock('./macos-safety.js', async () => {
  const actual = await vi.importActual<typeof import('./macos-safety.js')>('./macos-safety.js');
  mocks.actualObserve = actual.observeProcessStart;
  return { ...actual, observeProcessStart: mocks.observe };
});
vi.mock('./lifecycle.js', async () => ({ ...await vi.importActual<typeof import('./lifecycle.js')>('./lifecycle.js'), runtimeStatus: mocks.status, startRuntime: mocks.start, stopRuntime: mocks.stop }));
vi.mock('./supervisor-native-control.js', async () => ({ ...await vi.importActual<typeof import('./supervisor-native-control.js')>('./supervisor-native-control.js'), startSupervisorNativeControlServer: mocks.native }));
vi.mock('./supervisor-admin.js', async () => ({ ...await vi.importActual<typeof import('./supervisor-admin.js')>('./supervisor-admin.js'), callSupervisorAdminTool: mocks.admin }));

import { createSupervisor, supervisorAdminChildEnvironment, supervisorNativeOwnerIdentityIsStableForTest, type Supervisor } from './supervisor.js';
import { initializeConnectorRegistry, bindConnectorRuntime, readConnectorRegistry } from './connector-registry.js';
import { loadOrCreateTunnelServiceSecret } from './credentials.js';
import { loadOrCreateRuntimeId, writeEndpoint } from './persistence.js';
import { canonicalNodeRuntime, node24Environment } from './node-runtime.js';
import { confirmChildSpawn, DefiniteSpawnFailure } from './spawn-outcome.js';

interface ChildRecord {
  component: 'runtime' | 'admin' | 'web' | 'tunnel-full' | 'tunnel-pro' | 'tunnel-admin';
  pid: number; startedAt: string; executable: string; marker: string; profilePath: string | null; tunnelId: string | null;
  processStartMarker?: string | null; processExecutable?: string | null; processStartTimeMs?: number | null; workingDirectory?: string | null;
  runtimeId?: string | null; instanceId?: string | null; deploymentEpoch?: number | null; profileDigest?: string | null; environmentDigest?: string | null;
  listenerPorts?: readonly number[];
}
interface State {
  schemaVersion: number; startupOperations: StartupOperation[];
  runtime: ChildRecord | null; web: ChildRecord | null; admin: ChildRecord | null; adminTunnel: ChildRecord | null;
  tunnels: { full: ChildRecord | null; pro: ChildRecord | null };
  recovery: { terminal: boolean; lastFailureCode: string | null };
  [key: string]: unknown;
}
interface Internals {
  readState(): Promise<State>; writeState(state: State, replace?: boolean): Promise<void>;
  updateStartup(id: string, phase: StartupState, values?: Partial<StartupOperation>): Promise<void>;
  spawnManaged(component: ChildRecord['component'], executable: string, args: string[], cwd: string, env: Record<string, string>, profile: string | null, logs: string, marker: string): Promise<ChildRecord>;
  startupTransaction<T>(work: () => Promise<T>): Promise<T>;
  cleanupStartupOperation(operation: StartupOperation): Promise<void>;
  cleanupStartupOperations(operations: StartupOperation[]): Promise<void>;
  finishStartupTransaction(): Promise<void>;
  ensureAdmin(state: State, started: string[]): Promise<State>;
  probeTargetCatalogManifest(root: string): Promise<unknown>;
  prepareStartup(component: string, executable: string, source: string, profile: string | null, environment: Record<string, string>, root?: string, id?: string): Promise<string>;
}
interface Fixture { root: string; supervisor: Supervisor; internal: Internals; backups: StartupOperation[]; ports: number[] }
const fixtures: Fixture[] = [];
const stopped = { state: 'stopped', endpoint: null, health: null };
const sourceRoot = path.resolve(import.meta.dirname, '../../..');

beforeEach(() => {
  mocks.observe.mockImplementation((pid: number) => mocks.actualObserve!(pid));
  mocks.status.mockReset().mockResolvedValue(stopped);
  mocks.start.mockReset(); mocks.stop.mockReset().mockResolvedValue(stopped);
  mocks.native.mockReset().mockRejectedValue(new Error('synthetic bind failure'));
  mocks.admin.mockReset().mockResolvedValue({ structuredContent: { readiness: 'READY', fullCatalogId: 'synthetic-catalog' }, isError: false });
});
afterEach(async () => {
  vi.restoreAllMocks();
  mocks.observe.mockImplementation((pid: number) => mocks.actualObserve!(pid));
  for (const f of fixtures.splice(0)) {
    // Restore only the test's original, independently measured ownership evidence.
    const state = await f.internal.readState();
    for (const op of state.startupOperations) if (op.ownedProcess != null && !f.backups.some((backup) => backup.id === op.id)) f.backups.push(op);
    if (f.backups.length > 0) {
      await f.internal.writeState({ ...state, startupOperations: f.backups }, true);
      await f.internal.cleanupStartupOperations(f.backups);
    }
    for (const op of state.startupOperations) if (op.pid !== null) await gone(op.pid);
    await rm(f.root, { recursive: true, force: true });
  }
});
async function freePorts(count = 4): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) {
    const server = createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!(port >= 43110 && port <= 43113) && !(port >= 46710 && port <= 46716)) ports.add(port);
  }
  return [...ports];
}
async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-failure-stop-boundary-')));
  const ports = await freePorts();
  const supervisor = await createSupervisor({ dataRoot: root, sourceRoot, webPort: ports[0]!, adminPort: ports[1]!, supervisorControlPort: ports[2]!, adminTunnelHealthPort: ports[3]! });
  for (const directory of ['supervisor', 'logs']) await mkdir(path.join(root, directory), { mode: 0o700 });
  const f = { root, ports, supervisor, internal: supervisor as unknown as Internals, backups: [] };
  fixtures.push(f); return f;
}
async function child(f: Fixture, component: 'web' | 'admin' | 'tunnel-admin' = 'web'): Promise<ChildRecord> {
  const record = await f.internal.spawnManaged(component, canonicalNodeRuntime().path,
    ['-e', 'setTimeout(()=>process.exit(0),4000);setInterval(()=>{},1000)', 'failure-stop-test-child'], sourceRoot, {}, null, path.join(f.root, 'logs'), 'failure-stop-test-child');
  const op = (await f.internal.readState()).startupOperations.find((op) => op.pid === record.pid)!;
  f.backups.push(op); return record;
}
async function publish(f: Fixture, record: ChildRecord): Promise<void> {
  const state = await f.internal.readState(); await f.internal.writeState({ ...state, [record.component]: record });
}
async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (mocks.actualObserve!(pid).state === 'dead') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Disposable child did not exit by its fixture deadline');
}

// Scenario IDs correspond to the Owner's original 16-scenario matrix.
describe('Supervisor production failure boundaries', () => {
  it('finalizes a verified control-only tunnel startup before reporting success', async () => {
    const f = await fixture();
    const record = await child(f, 'tunnel-admin');
    const state = await f.internal.readState();
    const operation = state.startupOperations.find((candidate) => candidate.pid === record.pid)!;
    await f.internal.writeState({ ...state, adminTunnel: record, startupOperations: [{ ...operation, state: 'OWNERSHIP_VERIFIED' }] }, true);
    await f.internal.finishStartupTransaction();
    expect((await f.internal.readState()).startupOperations.find((candidate) => candidate.id === operation.id)?.state).toBe('RUNNING');
  });

  it('S01 proves a real OS pre-PID rejection is SPAWN_FAILED, not an unknown child', async () => {
    const f = await fixture(); const filename = path.join(f.root, 'not-executable');
    await writeFile(filename, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    await expect(f.internal.startupTransaction(() => f.internal.spawnManaged('web', filename, [], sourceRoot, {}, null, path.join(f.root, 'logs'), 'not-executable'))).rejects.toMatchObject({ code: 'SUPERVISOR_NOT_RUNNING' });
    expect((await f.internal.readState()).startupOperations[0]).toMatchObject({ state: 'SPAWN_FAILED', pid: null });
    await expect(f.supervisor.reconcileStartup()).resolves.toBeUndefined();
  });
  it('S02 preserves an actually spawned child when identity observation is unavailable', async () => {
    const f = await fixture();
    mocks.observe.mockImplementation((pid: number) => pid === process.pid ? mocks.actualObserve!(pid) : { state: 'indeterminate' });
    await expect(child(f)).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    const op = (await f.internal.readState()).startupOperations[0]!;
    expect(op).toMatchObject({ state: 'RECONCILIATION_REQUIRED', processStartMarker: null }); expect(op.pid).not.toBeNull();
    await expect(f.supervisor.reconcileStartup()).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    mocks.observe.mockImplementation((pid: number) => mocks.actualObserve!(pid));
    await gone(op.pid!); await f.supervisor.reconcileStartup();
    expect((await f.internal.readState()).startupOperations[0]?.state).toBe('STOPPED');
  }, 10000);
  it('S03 cleans a measured child when ownership publication fails', async () => {
    const f = await fixture(); const original = f.internal.updateStartup.bind(f.internal);
    vi.spyOn(f.internal, 'updateStartup').mockImplementation(async (id, phase, values) => {
      if (phase === 'OWNERSHIP_VERIFIED') throw new RuntimeError('PERSISTENCE_FAILURE', 'synthetic ownership write failure');
      return original(id, phase, values);
    });
    await expect(f.internal.startupTransaction(() => child(f))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    const op = (await f.internal.readState()).startupOperations[0]!;
    expect(op.state).toBe('STOPPED'); await gone(op.pid!);
  });
  it('S04 restart before ownership publication retains a live unverified child without adoption', async () => {
    const f = await fixture(); const record = await child(f);
    const state = await f.internal.readState();
    await f.internal.writeState({ ...state, startupOperations: state.startupOperations.map((op) => ({ ...op, state: 'SPAWNING', ownedProcess: null })) }, true);
    const replacement = await createSupervisor({ dataRoot: f.root, sourceRoot, webPort: f.ports[0]!, adminPort: f.ports[1]!, supervisorControlPort: f.ports[2]!, adminTunnelHealthPort: f.ports[3]! });
    await expect(replacement.reconcileStartup()).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    expect(mocks.actualObserve!(record.pid).state).toBe('live');
    expect((await f.internal.readState()).startupOperations[0]?.state).toBe('RECONCILIATION_REQUIRED');
  });
  it('S05 reconciles a child that exits during observation without signaling another process', async () => {
    const f = await fixture(); const record = await child(f); await gone(record.pid);
    await f.supervisor.reconcileStartup();
    expect((await f.internal.readState()).startupOperations[0]?.state).toBe('STOPPED');
  }, 10000);
  it('S05b a real child exits during initial identity measurement', async () => {
    const f = await fixture();
    await expect(f.internal.spawnManaged('web', canonicalNodeRuntime().path, ['-e', 'process.exit(0)', 'failure-stop-test-child'], sourceRoot, {}, null, path.join(f.root, 'logs'), 'failure-stop-test-child')).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    const operation = (await f.internal.readState()).startupOperations[0]!;
    expect(operation.pid).not.toBeNull(); await gone(operation.pid!);
    await f.supervisor.reconcileStartup(); expect((await f.internal.readState()).startupOperations[0]?.state).toBe('STOPPED');
  });
  it('S06 PID reuse never signals the new identity', async () => {
    const f = await fixture(); const record = await child(f);
    mocks.observe.mockImplementation((pid: number) => pid === record.pid ? { state: 'live', marker: '999999:123456' } : mocks.actualObserve!(pid));
    const signals = vi.spyOn(process, 'kill'); await f.supervisor.reconcileStartup();
    expect(signals.mock.calls.some(([pid, signal]) => pid === record.pid && signal === 'SIGTERM')).toBe(false);
    expect((await f.internal.readState()).startupOperations[0]?.state).toBe('STOPPED');
  });
  it('S07 executable mismatch remains unresolved and is never terminated', async () => {
    const f = await fixture(); const record = await child(f); const state = await f.internal.readState();
    await f.internal.writeState({ ...state, startupOperations: state.startupOperations.map((op) => ({ ...op, ownedProcess: { ...record, processExecutable: '/usr/bin/false' } })) }, true);
    const fresh = await createSupervisor({ dataRoot: f.root, sourceRoot, webPort: f.ports[0]!, adminPort: f.ports[1]!, supervisorControlPort: f.ports[2]!, adminTunnelHealthPort: f.ports[3]! });
    await expect(fresh.reconcileStartup()).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    expect(mocks.actualObserve!(record.pid).state).toBe('live');
  });
  it('S08 complete rollback stops every verified child and durably records STOPPED', async () => {
    const f = await fixture();
    await expect(f.internal.startupTransaction(async () => { await publish(f, await child(f)); await publish(f, await child(f, 'admin')); throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'synthetic after-spawn failure'); })).rejects.toMatchObject({ code: 'SUPERVISOR_NOT_RUNNING' });
    const state = await f.internal.readState(); expect(state.startupOperations.map((op) => op.state)).toEqual(['STOPPED', 'STOPPED']);
    expect(state.web).toBeNull(); expect(state.admin).toBeNull();
    for (const op of state.startupOperations) await gone(op.pid!);
  });
  it('S09 partial rollback continues independent cleanup and exposes CLEANUP_FAILED', async () => {
    const f = await fixture(); const cleanup = f.internal.cleanupStartupOperation.bind(f.internal);
    vi.spyOn(f.internal, 'cleanupStartupOperation').mockImplementation(async (op) => {
      if (op.component === 'admin') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'synthetic cleanup failure');
      await cleanup(op);
    });
    await expect(f.internal.startupTransaction(async () => { await child(f); await child(f, 'admin'); throw new Error('synthetic failure'); })).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    const state = await f.internal.readState(); expect(state.startupOperations.map((op) => op.state)).toEqual(['STOPPED', 'CLEANUP_FAILED']);
    expect(state.recovery.terminal).toBe(true);
  });
  it('S10 native bind failure is durable, sanitized, and prevents repeated KeepAlive startup', async () => {
    const f = await fixture(); const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.native.mockRejectedValue(new Error('password=synthetic-do-not-log'));
    await expect(f.supervisor.runSupervisorDaemon()).resolves.toBeUndefined();
    expect((await f.internal.readState()).recovery).toMatchObject({ terminal: true, lastFailureCode: 'SUPERVISOR_NOT_RUNNING' });
    await f.supervisor.runSupervisorDaemon(); expect(mocks.native).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(f.root, 'supervisor/state.json'), 'utf8')).not.toContain('synthetic-do-not-log');
    expect(log.mock.calls.flat().join(' ')).not.toContain('synthetic-do-not-log');
  });
  it('does not overwrite workload state when a native-control listener has ambiguous ownership', async () => {
    const f = await fixture();
    const state = await f.internal.readState();
    await f.internal.writeState(state, true);
    const filename = path.join(f.root, 'supervisor/state.json');
    const before = await readFile(filename);
    let requests = 0;
    let receivedAuthorization = false;
    const occupied = createHttpServer((request, response) => {
      requests += 1;
      receivedAuthorization ||= request.headers.authorization !== undefined;
      response.statusCode = 401;
      response.end();
    });
    await new Promise<void>((resolve) => occupied.listen(f.ports[2]!, '127.0.0.1', resolve));
    mocks.native.mockRejectedValue(Object.assign(new Error('synthetic occupied port'), { code: 'EADDRINUSE' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(f.supervisor.runSupervisorDaemon()).resolves.toBeUndefined();
      expect(await readFile(filename)).toEqual(before);
      expect(log.mock.calls.flat().join(' ')).toContain('ownership is ambiguous');
      expect(requests).toBe(0);
      expect(receivedAuthorization).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });
  it('accepts an identity-bound built Supervisor incumbent after pre-authentication OS proof', async () => {
    const f = await fixture();
    const state = await f.internal.readState();
    await f.internal.writeState(state, true);
    const filename = path.join(f.root, 'supervisor/state.json');
    const before = await readFile(filename);
    const secret = await loadOrCreateTunnelServiceSecret(f.root);
    const incumbentSourceRoot = path.join(f.root, 'built-incumbent');
    const builtDirectory = path.join(incumbentSourceRoot, 'apps/runtime/dist');
    await mkdir(builtDirectory, { recursive: true, mode: 0o700 });
    const controlEntrypoint = path.join(builtDirectory, 'control.js');
    await writeFile(controlEntrypoint, `
const { createServer } = require('node:http');
const server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.IRIS_TEST_SECRET) { response.statusCode = 401; response.end(); return; }
  response.setHeader('content-type', 'application/json');
  if (request.url === '/healthz') { response.end(JSON.stringify({ ok: true, owner: 'OUTER_SUPERVISOR_DAEMON', pid: process.pid })); return; }
  response.end(JSON.stringify({ jsonrpc: '2.0', id: 'synthetic', result: { isError: false, structuredContent: {
    supervisorProcessId: process.pid, controlSourceRoot: process.env.IRIS_TEST_SOURCE,
    controlDataRoot: process.env.IRIS_TEST_ROOT, workloadRuntimeId: null, workloadInstanceId: null,
  } } }));
});
server.listen(Number(process.env.IRIS_TEST_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, { mode: 0o600 });
    const child = spawn(canonicalNodeRuntime().path, [controlEntrypoint, 'supervisor'], {
      cwd: incumbentSourceRoot,
      env: node24Environment(
        { HOME: process.env.HOME ?? os.homedir(), TMPDIR: process.env.TMPDIR ?? os.tmpdir(), LANG: process.env.LANG ?? 'en_US.UTF-8' },
        {
          IRIS_TEST_SECRET: secret,
          IRIS_TEST_PORT: String(f.ports[2]!),
          IRIS_TEST_SOURCE: incumbentSourceRoot,
          IRIS_TEST_ROOT: f.root,
        },
      ),
      stdio: 'ignore',
    });
    if (child.pid === undefined) throw new Error('built Supervisor incumbent did not start');
    const incumbentSupervisor = await createSupervisor({
      dataRoot: f.root, sourceRoot: incumbentSourceRoot,
      webPort: f.ports[0]!, adminPort: f.ports[1]!, supervisorControlPort: f.ports[2]!, adminTunnelHealthPort: f.ports[3]!,
    });
    mocks.native.mockRejectedValue(Object.assign(new Error('synthetic occupied port'), { code: 'EADDRINUSE' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${f.ports[2]!}/healthz`, {
        headers: { authorization: `Bearer ${secret}` },
      })).status).toBe(200));
      await expect(incumbentSupervisor.runSupervisorDaemon()).resolves.toBeUndefined();
      expect(await readFile(filename)).toEqual(before);
      expect(log.mock.calls.flat().join(' ')).toContain('already running');
    } finally {
      process.kill(child.pid, 'SIGTERM');
      await gone(child.pid);
    }
  }, 10_000);
  it.each(['listener owner', 'process birth/PID reuse', 'executable', 'argv', 'valid argv mode', 'environment evidence'] as const)(
    'fails closed when native Supervisor %s identity changes after authentication',
    (changedIdentity) => {
      const builtEntrypoint = path.join(sourceRoot, 'apps/runtime/dist/control.js');
      const trustedArguments = [canonicalNodeRuntime().path, builtEntrypoint, 'supervisor'];
      const sourceEntrypoint = path.join(sourceRoot, 'apps/runtime/src/control.ts');
      const sourceLoader = path.join(sourceRoot, 'apps/runtime/node_modules/tsx/dist');
      const trustedSourceArguments = [
        canonicalNodeRuntime().path,
        '--require', path.join(sourceLoader, 'preflight.cjs'),
        '--import', pathToFileURL(path.join(sourceLoader, 'loader.mjs')).href,
        sourceEntrypoint,
        'supervisor',
      ];
      const initial = {
        listenerPid: 41_101,
        processStartMarker: '1:000001',
        canonicalExecutable: canonicalNodeRuntime().path,
        arguments: trustedArguments,
        unsafeEnvironmentVariables: [] as string[],
      };
      const confirmed = {
        listenerPid: changedIdentity === 'listener owner' ? 41_102 : initial.listenerPid,
        processStartMarker: changedIdentity === 'process birth/PID reuse' ? '2:000002' : initial.processStartMarker,
        canonicalExecutable: changedIdentity === 'executable' ? '/usr/bin/false' : initial.canonicalExecutable,
        arguments: changedIdentity === 'argv'
            ? [canonicalNodeRuntime().path, '-e', 'void 0', builtEntrypoint, 'supervisor']
            : changedIdentity === 'valid argv mode' ? trustedSourceArguments : trustedArguments,
        unsafeEnvironmentVariables: changedIdentity === 'environment evidence' ? ['NODE_OPTIONS'] : [],
      };
      const before = structuredClone({ initial, confirmed });
      expect(supervisorNativeOwnerIdentityIsStableForTest(initial, confirmed)).toBe(false);
      expect({ initial, confirmed }).toEqual(before);
    },
  );
  it('rejects a credential-bearing eval listener that appends trusted entrypoint arguments', async () => {
    const f = await fixture();
    const state = await f.internal.readState();
    await f.internal.writeState(state, true);
    const filename = path.join(f.root, 'supervisor/state.json');
    const before = await readFile(filename);
    const secret = await loadOrCreateTunnelServiceSecret(f.root);
    const controlEntrypoint = path.join(sourceRoot, 'apps/runtime/src/control.ts');
    const script = `
const { createServer } = require('node:http');
const server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.IRIS_TEST_SECRET) { response.statusCode = 401; response.end(); return; }
  response.setHeader('content-type', 'application/json');
  if (request.url === '/healthz') { response.end(JSON.stringify({ ok: true, owner: 'OUTER_SUPERVISOR_DAEMON', pid: process.pid })); return; }
  response.end(JSON.stringify({ jsonrpc: '2.0', id: 'synthetic', result: { isError: false, structuredContent: {
    supervisorProcessId: process.pid,
    controlSourceRoot: process.env.IRIS_TEST_SOURCE,
    controlDataRoot: process.env.IRIS_TEST_ROOT,
    workloadRuntimeId: null,
    workloadInstanceId: null,
  } } }));
});
server.listen(Number(process.env.IRIS_TEST_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
    const child = spawn(canonicalNodeRuntime().path, ['-e', script, controlEntrypoint, 'supervisor'], {
      env: { ...process.env, IRIS_TEST_SECRET: secret, IRIS_TEST_PORT: String(f.ports[2]!), IRIS_TEST_SOURCE: sourceRoot, IRIS_TEST_ROOT: f.root },
      stdio: 'ignore',
    });
    if (child.pid === undefined) throw new Error('identity-bound fixture child did not start');
    const childPid = child.pid;
    mocks.native.mockRejectedValue(Object.assign(new Error('synthetic occupied port'), { code: 'EADDRINUSE' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${f.ports[2]!}/healthz`, {
        headers: { authorization: `Bearer ${secret}` },
      })).status).toBe(200));
      await expect(f.supervisor.runSupervisorDaemon()).resolves.toBeUndefined();
      expect(await readFile(filename)).toEqual(before);
      expect(log.mock.calls.flat().join(' ')).toContain('ownership is ambiguous');
      expect(mocks.actualObserve!(childPid).state).toBe('live');
    } finally {
      process.kill(childPid, 'SIGTERM');
      await gone(childPid);
    }
  }, 10_000);
  it('rejects trusted Supervisor argv when NODE_OPTIONS injects the listener implementation', async () => {
    const f = await fixture();
    const state = await f.internal.readState();
    await f.internal.writeState(state, true);
    const filename = path.join(f.root, 'supervisor/state.json');
    const before = await readFile(filename);
    const secret = await loadOrCreateTunnelServiceSecret(f.root);
    const spoofSourceRoot = path.join(f.root, 'spoof-source');
    const builtDirectory = path.join(spoofSourceRoot, 'apps/runtime/dist');
    await mkdir(builtDirectory, { recursive: true, mode: 0o700 });
    const controlEntrypoint = path.join(builtDirectory, 'control.js');
    const preload = path.join(spoofSourceRoot, 'preload.cjs');
    await writeFile(controlEntrypoint, "setInterval(() => undefined, 1000); process.on('SIGTERM', () => process.exit(0));\n", { mode: 0o600 });
    await writeFile(preload, `
const { createServer } = require('node:http');
createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.IRIS_TEST_SECRET) { response.statusCode = 401; response.end(); return; }
  response.setHeader('content-type', 'application/json');
  if (request.url === '/healthz') { response.end(JSON.stringify({ ok: true, owner: 'OUTER_SUPERVISOR_DAEMON', pid: process.pid })); return; }
  response.end(JSON.stringify({ jsonrpc: '2.0', id: 'synthetic', result: { isError: false, structuredContent: {
    supervisorProcessId: process.pid, controlSourceRoot: process.env.IRIS_TEST_SOURCE,
    controlDataRoot: process.env.IRIS_TEST_ROOT, workloadRuntimeId: null, workloadInstanceId: null,
  } } }));
}).listen(Number(process.env.IRIS_TEST_PORT), '127.0.0.1');
`, { mode: 0o600 });
    const child = spawn(canonicalNodeRuntime().path, [controlEntrypoint, 'supervisor'], {
      cwd: spoofSourceRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${preload}`,
        IRIS_TEST_SECRET: secret,
        IRIS_TEST_PORT: String(f.ports[2]!),
        IRIS_TEST_SOURCE: spoofSourceRoot,
        IRIS_TEST_ROOT: f.root,
      },
      stdio: 'ignore',
    });
    if (child.pid === undefined) throw new Error('NODE_OPTIONS fixture child did not start');
    const spoofSupervisor = await createSupervisor({
      dataRoot: f.root, sourceRoot: spoofSourceRoot,
      webPort: f.ports[0]!, adminPort: f.ports[1]!, supervisorControlPort: f.ports[2]!, adminTunnelHealthPort: f.ports[3]!,
    });
    mocks.native.mockRejectedValue(Object.assign(new Error('synthetic occupied port'), { code: 'EADDRINUSE' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${f.ports[2]!}/healthz`, {
        headers: { authorization: `Bearer ${secret}` },
      })).status).toBe(200));
      await expect(spoofSupervisor.runSupervisorDaemon()).resolves.toBeUndefined();
      expect(await readFile(filename)).toEqual(before);
      expect(log.mock.calls.flat().join(' ')).toContain('ownership is ambiguous');
      expect(mocks.actualObserve!(child.pid).state).toBe('live');
    } finally {
      process.kill(child.pid, 'SIGTERM');
      await gone(child.pid);
    }
  }, 10_000);
  it('rejects trusted source-mode Supervisor argv when TSX_TSCONFIG_PATH is present', async () => {
    const f = await fixture();
    const state = await f.internal.readState();
    await f.internal.writeState(state, true);
    const filename = path.join(f.root, 'supervisor/state.json');
    const before = await readFile(filename);
    const secret = await loadOrCreateTunnelServiceSecret(f.root);
    const spoofSourceRoot = path.join(f.root, 'tsx-source');
    const sourceDirectory = path.join(spoofSourceRoot, 'apps/runtime/src');
    const loaderDirectory = path.join(spoofSourceRoot, 'apps/runtime/node_modules/tsx/dist');
    await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(loaderDirectory), { recursive: true, mode: 0o700 });
    await symlink(path.join(sourceRoot, 'apps/runtime/node_modules/tsx/dist'), loaderDirectory, 'dir');
    const controlEntrypoint = path.join(sourceDirectory, 'control.ts');
    const tsconfig = path.join(spoofSourceRoot, 'tsconfig.json');
    await writeFile(tsconfig, '{"compilerOptions":{"module":"ESNext"}}\n', { mode: 0o600 });
    await writeFile(controlEntrypoint, `
import { createServer } from 'node:http';
const server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.IRIS_TEST_SECRET) { response.statusCode = 401; response.end(); return; }
  response.setHeader('content-type', 'application/json');
  if (request.url === '/healthz') { response.end(JSON.stringify({ ok: true, owner: 'OUTER_SUPERVISOR_DAEMON', pid: process.pid })); return; }
  response.end(JSON.stringify({ jsonrpc: '2.0', id: 'synthetic', result: { isError: false, structuredContent: {
    supervisorProcessId: process.pid, controlSourceRoot: process.env.IRIS_TEST_SOURCE,
    controlDataRoot: process.env.IRIS_TEST_ROOT, workloadRuntimeId: null, workloadInstanceId: null,
  } } }));
});
server.listen(Number(process.env.IRIS_TEST_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, { mode: 0o600 });
    const child = spawn(canonicalNodeRuntime().path, [
      '--require', path.join(loaderDirectory, 'preflight.cjs'),
      '--import', pathToFileURL(path.join(loaderDirectory, 'loader.mjs')).href,
      controlEntrypoint, 'supervisor',
    ], {
      cwd: spoofSourceRoot,
      env: node24Environment(
        { HOME: process.env.HOME ?? os.homedir(), TMPDIR: process.env.TMPDIR ?? os.tmpdir(), LANG: process.env.LANG ?? 'en_US.UTF-8' },
        {
          TSX_TSCONFIG_PATH: tsconfig,
          IRIS_TEST_SECRET: secret,
          IRIS_TEST_PORT: String(f.ports[2]!),
          IRIS_TEST_SOURCE: spoofSourceRoot,
          IRIS_TEST_ROOT: f.root,
        },
      ),
      stdio: 'ignore',
    });
    if (child.pid === undefined) throw new Error('TSX_TSCONFIG_PATH fixture child did not start');
    const spoofSupervisor = await createSupervisor({
      dataRoot: f.root, sourceRoot: spoofSourceRoot,
      webPort: f.ports[0]!, adminPort: f.ports[1]!, supervisorControlPort: f.ports[2]!, adminTunnelHealthPort: f.ports[3]!,
    });
    mocks.native.mockRejectedValue(Object.assign(new Error('synthetic occupied port'), { code: 'EADDRINUSE' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${f.ports[2]!}/healthz`, {
        headers: { authorization: `Bearer ${secret}` },
      })).status).toBe(200));
      await expect(spoofSupervisor.runSupervisorDaemon()).resolves.toBeUndefined();
      expect(await readFile(filename)).toEqual(before);
      expect(log.mock.calls.flat().join(' ')).toContain('ownership is ambiguous');
      expect(mocks.actualObserve!(child.pid).state).toBe('live');
    } finally {
      process.kill(child.pid, 'SIGTERM');
      await gone(child.pid);
    }
  }, 10_000);
  it('rejects an authenticated endpoint that claims another valid same-source PID', async () => {
    const f = await fixture();
    const state = await f.internal.readState();
    await f.internal.writeState(state, true);
    const filename = path.join(f.root, 'supervisor/state.json');
    const before = await readFile(filename);
    const secret = await loadOrCreateTunnelServiceSecret(f.root);
    const controlEntrypoint = path.join(sourceRoot, 'apps/runtime/src/control.ts');
    const decoy = spawn(canonicalNodeRuntime().path, ['-e', 'setInterval(() => undefined, 1000)', controlEntrypoint, 'supervisor'], { stdio: 'ignore' });
    if (decoy.pid === undefined) throw new Error('same-source decoy did not start');
    const script = `
const { createServer } = require('node:http');
const server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.IRIS_TEST_SECRET) { response.statusCode = 401; response.end(); return; }
  response.setHeader('content-type', 'application/json');
  const claimed = Number(process.env.IRIS_TEST_CLAIMED_PID);
  if (request.url === '/healthz') { response.end(JSON.stringify({ ok: true, owner: 'OUTER_SUPERVISOR_DAEMON', pid: claimed })); return; }
  response.end(JSON.stringify({ jsonrpc: '2.0', id: 'synthetic', result: { isError: false, structuredContent: {
    supervisorProcessId: claimed,
    controlSourceRoot: process.env.IRIS_TEST_SOURCE,
    controlDataRoot: process.env.IRIS_TEST_ROOT,
    workloadRuntimeId: null,
    workloadInstanceId: null,
  } } }));
});
server.listen(Number(process.env.IRIS_TEST_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
    const listener = spawn(canonicalNodeRuntime().path, ['-e', script, controlEntrypoint, 'supervisor'], {
      env: { ...process.env, IRIS_TEST_SECRET: secret, IRIS_TEST_PORT: String(f.ports[2]!), IRIS_TEST_CLAIMED_PID: String(decoy.pid), IRIS_TEST_SOURCE: sourceRoot, IRIS_TEST_ROOT: f.root },
      stdio: 'ignore',
    });
    if (listener.pid === undefined) throw new Error('spoofing listener did not start');
    mocks.native.mockRejectedValue(Object.assign(new Error('synthetic occupied port'), { code: 'EADDRINUSE' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${f.ports[2]!}/healthz`, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(200));
      await expect(f.supervisor.runSupervisorDaemon()).resolves.toBeUndefined();
      expect(await readFile(filename)).toEqual(before);
      expect(log.mock.calls.flat().join(' ')).toContain('ownership is ambiguous');
      expect(mocks.actualObserve!(listener.pid).state).toBe('live');
      expect(mocks.actualObserve!(decoy.pid).state).toBe('live');
    } finally {
      process.kill(listener.pid, 'SIGTERM');
      process.kill(decoy.pid, 'SIGTERM');
      await Promise.all([gone(listener.pid), gone(decoy.pid)]);
    }
  }, 10_000);
  it.each([1, 2, 3])('preserves historical schema %s byte-for-byte when native control fails before authority', async (schemaVersion) => {
    const f = await fixture();
    const historical = { ...await f.internal.readState() } as Record<string, unknown>;
    delete historical.startupOperations;
    const filename = path.join(f.root, 'supervisor/state.json');
    await writeSupervisorStateFile(filename, { ...historical, schemaVersion });
    const before = await readFile(filename);
    mocks.native.mockRejectedValue(new Error('synthetic pre-authority failure'));
    await expect(f.supervisor.runSupervisorDaemon()).resolves.toBeUndefined();
    expect(await readFile(filename)).toEqual(before);
  });
  it('starts and stops only native Supervisor control without activating workload children', async () => {
    const f = await fixture();
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.native.mockResolvedValue({ port: f.ports[2]!, mcpUrl: 'http://127.0.0.1/mcp', healthUrl: 'http://127.0.0.1/healthz', close });
    const stateFile = path.join(f.root, 'supervisor/state.json');
    const before = await readFile(stateFile).catch(() => null);
    const up = vi.spyOn(f.supervisor, 'up');
    const down = vi.spyOn(f.supervisor, 'down');

    const running = f.supervisor.runSupervisorDaemon();
    await vi.waitFor(() => expect(mocks.native).toHaveBeenCalledOnce());
    const operations = mocks.native.mock.calls[0]?.[2] as { supervisorStatus(): Promise<Record<string, unknown>> };
    expect(await operations.supervisorStatus()).toMatchObject({
      supervisorControlOwner: 'OUTER_SUPERVISOR_DAEMON',
      readiness: 'DEGRADED',
      workloadRuntimeId: null,
      adminChildIdentity: null,
    });
    expect(mocks.admin).not.toHaveBeenCalled();
    process.emit('SIGTERM', 'SIGTERM');
    await running;

    expect(up).not.toHaveBeenCalled();
    expect(down).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(await readFile(stateFile).catch(() => null)).toEqual(before);
  }, 10_000);
  it('S11 a new supervisor reconciles an incomplete verified intent from durable ownership', async () => {
    const f = await fixture(); const record = await child(f);
    const replacement = await createSupervisor({ dataRoot: f.root, sourceRoot, webPort: f.ports[0]!, adminPort: f.ports[1]!, supervisorControlPort: f.ports[2]!, adminTunnelHealthPort: f.ports[3]! });
    await replacement.reconcileStartup(); await gone(record.pid);
    expect((await f.internal.readState()).startupOperations[0]?.state).toBe('STOPPED');
  });
  it('S12 unknown no-PID spawn blocks duplicate creation; PREPARED can reconcile safely', async () => {
    const f = await fixture(); const state = await f.internal.readState();
    const supervisorIdentity = mocks.actualObserve!(process.pid); if (supervisorIdentity.state !== 'live') throw new Error('test supervisor identity unavailable');
    const op: StartupOperation = { version: 1, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', transactionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', component: 'web', state: 'SPAWNING', supervisorPid: process.pid, supervisorStartMarker: supervisorIdentity.marker, sourceRoot, dataRoot: f.root, executable: canonicalNodeRuntime().path, profilePath: null, configurationDigest: 'a'.repeat(64), pid: null, processStartMarker: null, processExecutable: null, failureCode: null };
    await f.internal.writeState({ ...state, startupOperations: [op] }, true);
    await expect(f.internal.startupTransaction(() => child(f))).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    expect((await f.internal.readState()).startupOperations).toHaveLength(1);
    await f.internal.writeState({ ...state, startupOperations: [{ ...op, state: 'PREPARED' }] }, true);
    await f.supervisor.reconcileStartup(); expect((await f.internal.readState()).startupOperations[0]?.state).toBe('STOPPED');
  });
  it('rejects a launch result with no OS proof as ambiguous, never SPAWN_FAILED', async () => {
    const fake = new (await import('node:events')).EventEmitter() as ChildProcess;
    const confirmed = confirmChildSpawn(fake);
    fake.emit('error', Object.assign(new Error('synthetic ambiguous result'), { code: 'EUNKNOWN' }));
    await expect(confirmed).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    await expect(confirmed).rejects.not.toBeInstanceOf(DefiniteSpawnFailure);
  });
  it('rejects failed durability instead of returning a deliberate successful daemon exit', async () => {
    const f = await fixture(); const original = f.internal.writeState.bind(f.internal);
    vi.spyOn(f.internal, 'writeState').mockImplementation(async (state, replace) => {
      if (state.recovery.terminal) throw new RuntimeError('PERSISTENCE_FAILURE', 'synthetic durable failure');
      return original(state, replace);
    });
    await expect(f.supervisor.runSupervisorDaemon()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });
  it('failure-stop cleans a verified child even when another operation remains unknown', async () => {
    const f = await fixture(); const record = await child(f); await publish(f, record);
    const state = await f.internal.readState(); const known = state.startupOperations[0]!;
    const unknown = { ...known, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', component: 'admin', pid: null, processStartMarker: null, processExecutable: null, ownedProcess: null, state: 'SPAWNING' as const };
    await f.internal.writeState({ ...state, startupOperations: [known, unknown] }, true);
    await expect(f.supervisor.down()).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    await gone(record.pid); expect((await f.internal.readState()).startupOperations.find((op) => op.id === known.id)?.state).toBe('STOPPED');
  });
  it('refuses cleanup when the durable data-root binding differs', async () => {
    const f = await fixture(); const record = await child(f); const state = await f.internal.readState();
    await f.internal.writeState({ ...state, startupOperations: state.startupOperations.map((op) => ({ ...op, dataRoot: sourceRoot })) }, true);
    await expect(f.supervisor.reconcileStartup()).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    expect(mocks.actualObserve!(record.pid).state).toBe('live');
  });
  it('does not mutate a historical live child when ownership-journal migration cannot persist', async () => {
    const f = await fixture(); const record = await child(f, 'admin'); const state = await f.internal.readState();
    const original = state.startupOperations[0]!;
    await publish(f, record);
    const historical = { ...await f.internal.readState() } as Record<string, unknown>;
    delete historical.startupOperations;
    await writeSupervisorStateFile(path.join(f.root, 'supervisor/state.json'), { ...historical, schemaVersion: 3 });
    const write = f.internal.writeState.bind(f.internal);
    const failed = vi.spyOn(f.internal, 'writeState').mockRejectedValue(new RuntimeError('PERSISTENCE_FAILURE', 'synthetic migration write failure'));
    await expect(f.supervisor.down()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    expect(mocks.actualObserve!(record.pid).state).toBe('live');
    failed.mockRestore();
    await write({ ...state, web: record, startupOperations: [{ ...original, state: 'RUNNING' }] }, true);
  });
  it('fails closed when a persisted spawn-time listener is still owned after child exit', async () => {
    const f = await fixture(); const record = await child(f); const state = await f.internal.readState(); const port = f.ports[0]!;
    const boundRecord = { ...record, listenerPorts: [port] };
    const operation = { ...state.startupOperations[0]!, ownedProcess: boundRecord };
    await f.internal.writeState({ ...state, web: boundRecord, startupOperations: [operation] }, true);
    const server = createServer(); await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const replacement = await createSupervisor({ dataRoot: f.root, sourceRoot, webPort: port, adminPort: f.ports[1]!, supervisorControlPort: f.ports[2]!, adminTunnelHealthPort: f.ports[3]! });
    const internal = replacement as unknown as Internals;
    try {
      await expect(internal.cleanupStartupOperations([operation])).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
      await gone(record.pid);
      expect(server.listening).toBe(true);
      expect((await internal.readState()).startupOperations[0]?.state).toBe('RECONCILIATION_REQUIRED');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

async function adminFixture(): Promise<Fixture> {
  const f = await fixture();
  await initializeConnectorRegistry(f.root, { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: `tunnel_${'b'.repeat(32)}` });
  await bindConnectorRuntime(f.root, await loadOrCreateRuntimeId(f.root));
  await loadOrCreateTunnelServiceSecret(f.root);
  const state = await f.internal.ensureAdmin(await f.internal.readState(), []);
  await f.internal.finishStartupTransaction();
  if (state.admin === null) throw new Error('Synthetic Admin did not start');
  const initial = (await f.internal.readState()).startupOperations.find((op) => op.pid === state.admin!.pid)!;
  f.backups.push(initial);
  mocks.status.mockResolvedValue({ state: 'running', endpoint: { runtimeId: 'synthetic-runtime', instanceId: 'synthetic-instance', pid: process.pid, startedAt: new Date().toISOString(), apiUrl: 'http://127.0.0.1:1', mcpUrl: 'http://127.0.0.1:1/mcp' }, health: null });
  return f;
}

describe('F-R1-01 public Admin recycle boundaries', () => {
  it('does not probe a Runtime API listener owned by a different process', async () => {
    const f = await fixture();
    const originalState = await f.internal.readState();
    const port = (await freePorts(1))[0]!;
    const record = await f.internal.spawnManaged(
      'runtime', canonicalNodeRuntime().path,
      ['-e', 'setTimeout(()=>process.exit(0),10000);setInterval(()=>{},1000)', sourceRoot],
      sourceRoot, {}, null, path.join(f.root, 'logs'), sourceRoot,
    );
    await f.internal.finishStartupTransaction();
    const state = await f.internal.readState();
    const operation = state.startupOperations.find((candidate) => candidate.pid === record.pid)!;
    const runtimeId = randomUUID();
    const instanceId = randomUUID();
    const boundRecord = { ...record, runtimeId, instanceId, listenerPorts: [port] };
    const boundOperation = { ...operation, ownedProcess: boundRecord };
    await f.internal.writeState({ ...state, runtime: boundRecord, startupOperations: [boundOperation] }, true);
    await writeEndpoint(f.root, {
      schemaVersion: 1, runtimeId, instanceId, pid: record.pid, startedAt: record.startedAt,
      apiUrl: `http://127.0.0.1:${port}`, mcpUrl: `http://127.0.0.1:${port}/mcp`,
    });
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(port, '127.0.0.1', resolve));
    mocks.status.mockResolvedValue({
      state: 'running',
      endpoint: { schemaVersion: 1, runtimeId, instanceId, pid: record.pid, startedAt: record.startedAt, apiUrl: `http://127.0.0.1:${port}`, mcpUrl: `http://127.0.0.1:${port}/mcp` },
      health: null,
    });
    try {
      await expect(f.supervisor.supervisorNativeStatus()).resolves.toMatchObject({
        readiness: 'DEGRADED',
        runtimeListenerOwnershipVerified: false,
      });
      expect(mocks.status).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      if (mocks.actualObserve!(record.pid).state === 'live') process.kill(record.pid, 'SIGTERM');
      await gone(record.pid);
      await f.internal.writeState(originalState, true);
    }
  }, 15_000);

  it('does not trust Admin tunnel health from a listener owned by a different process', async () => {
    const f = await fixture();
    const port = f.ports[3]!;
    const record = await f.internal.spawnManaged(
      'tunnel-admin', canonicalNodeRuntime().path,
      ['-e', 'setTimeout(()=>process.exit(0),10000);setInterval(()=>{},1000)', 'admin-tunnel-listener-owner-test'],
      sourceRoot, {}, null, path.join(f.root, 'logs'), sourceRoot,
    );
    await f.internal.finishStartupTransaction();
    const state = await f.internal.readState();
    const operation = state.startupOperations.find((candidate) => candidate.pid === record.pid)!;
    const boundRecord = { ...record, listenerPorts: [port] };
    const boundOperation = { ...operation, ownedProcess: boundRecord };
    f.backups.push(boundOperation);
    await f.internal.writeState({ ...state, adminTunnel: boundRecord, startupOperations: [boundOperation] }, true);
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(port, '127.0.0.1', resolve));
    try {
      await expect(f.supervisor.supervisorNativeStatus()).resolves.toMatchObject({
        readiness: 'DEGRADED',
        adminTunnelOwnershipVerified: true,
        adminTunnelListenerOwnershipVerified: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  }, 15_000);

  it('reports authority change when cleanup intent becomes durable during the Admin probe', async () => {
    const f = await adminFixture();
    const original = await f.internal.readState();
    let probeEnteredResolve!: () => void;
    let probeRelease!: (value: { structuredContent: Record<string, unknown>; isError: false }) => void;
    const probeEntered = new Promise<void>((resolve) => { probeEnteredResolve = resolve; });
    const probeResult = new Promise<{ structuredContent: Record<string, unknown>; isError: false }>((resolve) => { probeRelease = resolve; });
    mocks.admin.mockImplementation(async () => {
      probeEnteredResolve();
      return probeResult;
    });

    const statusPromise = f.supervisor.supervisorNativeStatus();
    await probeEntered;
    await f.internal.writeState({
      ...original,
      startupOperations: original.startupOperations.map((operation) => operation.component === 'admin' && operation.state === 'RUNNING'
        ? { ...operation, state: 'CLEANUP_PENDING' as const }
        : operation),
    }, true);
    probeRelease({ structuredContent: { readiness: 'READY', fullCatalogId: 'synthetic-catalog' }, isError: false });
    try {
      await expect(statusPromise).resolves.toMatchObject({
        readiness: 'DEGRADED',
        readinessCode: 'AUTHORITY_CHANGED',
        authoritySnapshotCoherent: false,
      });
    } finally {
      await f.internal.writeState(original, true);
    }
  }, 15_000);

  it('does not accept authenticated Admin readiness from a listener owned by another process', async () => {
    const f = await adminFixture();
    const original = await f.internal.readState();
    const alternatePort = (await freePorts(1))[0]!;
    const entrypoint = path.join(sourceRoot, 'apps/runtime/src/supervisor-admin-main.ts');
    const loaderRoot = path.join(sourceRoot, 'apps/runtime/node_modules/tsx/dist');
    const alternate = spawn(canonicalNodeRuntime().path, [
      '--require', path.join(loaderRoot, 'preflight.cjs'), '--import', pathToFileURL(path.join(loaderRoot, 'loader.mjs')).href, entrypoint,
    ], {
      cwd: sourceRoot,
      env: node24Environment(
        { HOME: process.env.HOME ?? os.homedir(), TMPDIR: process.env.TMPDIR ?? os.tmpdir(), LANG: process.env.LANG ?? 'en_US.UTF-8' },
        supervisorAdminChildEnvironment(f.root, alternatePort),
      ),
      stdio: 'ignore',
    });
    if (alternate.pid === undefined) throw new Error('alternate Admin fixture did not start');
    try {
      const secret = await loadOrCreateTunnelServiceSecret(f.root);
      await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${alternatePort}/healthz`, {
        headers: { authorization: `Bearer ${secret}` },
      })).status).toBe(200));
      const identity = mocks.actualObserve!(alternate.pid);
      if (identity.state !== 'live' || original.admin === null) throw new Error('alternate Admin identity is unavailable');
      await f.internal.writeState({
        ...original,
        admin: {
          ...original.admin, pid: alternate.pid, startedAt: new Date().toISOString(),
          processStartMarker: identity.marker, processExecutable: await realpath(canonicalNodeRuntime().path), processStartTimeMs: null,
        },
      }, true);

      const status = await f.supervisor.supervisorNativeStatus();
      expect(status).toMatchObject({
        readiness: 'DEGRADED',
        adminSourceCoherent: false,
        adminListenerOwnershipVerified: false,
        adminAuthenticated: false,
      });
      expect(mocks.admin).not.toHaveBeenCalled();
      await expect(f.supervisor.adminNativeStatus()).resolves.toMatchObject({
        readiness: 'DEGRADED',
        adminListenerOwnershipVerified: false,
        adminOwnershipVerified: false,
      });
      expect(mocks.admin).not.toHaveBeenCalled();
    } finally {
      await f.internal.writeState(original, true);
      process.kill(alternate.pid, 'SIGTERM');
      await gone(alternate.pid);
    }
  }, 15_000);

  it('success uses a new transaction and durably finishes old/new ownership', async () => {
    const f = await adminFixture(); const before = await f.internal.readState();
    const result = await f.supervisor.adminRecycle(); const after = await f.internal.readState();
    expect(result).toMatchObject({ adminIdentityChanged: true, adminRouteReady: true });
    expect(after.admin?.pid).not.toBe(before.admin?.pid);
    expect(after.startupOperations.filter((op) => op.state === 'RUNNING')).toHaveLength(1);
    expect(after.startupOperations.find((op) => op.state === 'RUNNING')?.transactionId).not.toBe(before.startupOperations[0]?.transactionId);
    expect(after.startupOperations.filter((op) => op.pid === before.admin?.pid).every((op) => op.state === 'STOPPED')).toBe(true);
  }, 15000);
  it('retires through durable ownership when the published working directory is stale', async () => {
    const f = await adminFixture(); const before = await f.internal.readState();
    await f.internal.writeState({ ...before, admin: { ...before.admin!, workingDirectory: '/missing/stale-admin-source' } });
    await expect(f.supervisor.adminRecycle()).resolves.toMatchObject({ adminIdentityChanged: true });
    const after = await f.internal.readState();
    expect(after.admin?.pid).not.toBe(before.admin?.pid);
    expect(after.startupOperations.filter((op) => op.pid === before.admin?.pid).every((op) => op.state === 'STOPPED')).toBe(true);
  }, 15000);
  it('retires through durable ownership when published deployment metadata is stale', async () => {
    const f = await adminFixture(); const before = await f.internal.readState();
    await f.internal.writeState({
      ...before,
      admin: {
        ...before.admin!, tunnelId: 'stale-tunnel', runtimeId: 'stale-runtime', instanceId: 'stale-instance',
        deploymentEpoch: 999, profileDigest: '0'.repeat(64), environmentDigest: 'f'.repeat(64),
      },
    });
    await expect(f.supervisor.adminRecycle()).resolves.toMatchObject({ adminIdentityChanged: true });
    const after = await f.internal.readState();
    expect(after.admin?.pid).not.toBe(before.admin?.pid);
    expect(after.startupOperations.filter((op) => op.pid === before.admin?.pid).every((op) => op.state === 'STOPPED')).toBe(true);
  }, 15000);
  it.each(['missing', 'duplicate', 'instance', 'profile', 'birth', 'source', 'transaction'] as const)('rejects %s durable authority without stopping the old child', async (kind) => {
    const f = await adminFixture(); const before = await f.internal.readState(); const original = before.startupOperations[0]!;
    let operations = before.startupOperations;
    if (kind === 'missing') operations = [];
    else if (kind === 'duplicate') operations = [...operations, { ...original, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }];
    else operations = operations.map((op) => kind === 'birth' ? { ...op, processStartMarker: '1:1' }
      : kind === 'source' ? { ...op, sourceRoot: f.root }
      : kind === 'transaction' ? { ...op, transactionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }
      : { ...op, ownedProcess: { ...(op.ownedProcess as object), ...(kind === 'instance' ? { instanceId: 'conflicting-instance' } : { profilePath: '/wrong-profile' }) } });
    await f.internal.writeState({ ...before, startupOperations: operations }, true);
    if (kind === 'transaction') {
      // A different valid historic transaction remains authoritative; a transaction cannot be inferred from the published record.
      await expect(f.supervisor.adminRecycle()).resolves.toMatchObject({ adminIdentityChanged: true });
    } else {
      await expect(f.supervisor.adminRecycle()).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
      expect(mocks.actualObserve!(before.admin!.pid).state).toBe('live');
    }
  }, 15000);
  it('a rejected precondition does not stop the existing child', async () => {
    const f = await adminFixture(); const before = await f.internal.readState();
    await expect(f.supervisor.adminRecycle({ expectedAdminIdentity: 'stale-synthetic-identity' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await f.internal.readState()).admin?.pid).toBe(before.admin?.pid);
    expect(mocks.actualObserve!(before.admin!.pid).state).toBe('live');
  }, 15000);
  it('a failed retirement-intent write prevents old-child mutation', async () => {
    const f = await adminFixture(); const before = await f.internal.readState(); const write = f.internal.writeState.bind(f.internal);
    vi.spyOn(f.internal, 'writeState').mockImplementation(async (state, replace) => {
      if (state.startupOperations.some((op) => op.state === 'CLEANUP_PENDING')) throw new RuntimeError('PERSISTENCE_FAILURE', 'synthetic intent failure');
      return write(state, replace);
    });
    await expect(f.supervisor.adminRecycle()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    expect(mocks.actualObserve!(before.admin!.pid).state).toBe('live');
  }, 15000);
  it('an actual post-spawn anchor failure rolls back the replacement', async () => {
    const f = await adminFixture();
    mocks.admin.mockResolvedValueOnce({ structuredContent: { readiness: 'READY', fullCatalogId: 'before' }, isError: false })
      .mockResolvedValueOnce({ structuredContent: { readiness: 'READY', fullCatalogId: 'after' }, isError: false });
    await expect(f.supervisor.adminRecycle()).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    const state = await f.internal.readState(); expect(state.admin).toBeNull();
    expect(state.startupOperations.every((op) => op.state === 'STOPPED')).toBe(true);
  }, 15000);
  it('recycle rollback failure remains durable and observable', async () => {
    const f = await adminFixture(); const cleanup = f.internal.cleanupStartupOperation.bind(f.internal);
    vi.spyOn(f.internal, 'cleanupStartupOperation').mockImplementation(async (op) => {
      if (op.state === 'OWNERSHIP_VERIFIED') throw new RuntimeError('SUPERVISOR_NOT_RUNNING', 'synthetic replacement cleanup failure');
      return cleanup(op);
    });
    mocks.admin.mockResolvedValueOnce({ structuredContent: { fullCatalogId: 'before' }, isError: false })
      .mockResolvedValueOnce({ structuredContent: { fullCatalogId: 'after' }, isError: false });
    await expect(f.supervisor.adminRecycle()).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    const state = await f.internal.readState(); expect(state.startupOperations.some((op) => op.state === 'CLEANUP_FAILED')).toBe(true);
    expect(state.recovery.terminal).toBe(true);
  }, 15000);
});

describe('F-R1-05 catalog probe interruption', () => {
  it('records the private probe root before spawn and reconciles an interrupted unknown child after exit', async () => {
    const f = await fixture();
    await initializeConnectorRegistry(f.root, { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: `tunnel_${'b'.repeat(32)}` });
    await bindConnectorRuntime(f.root, await loadOrCreateRuntimeId(f.root));
    const registry = (await readConnectorRegistry(f.root))!;
    const full = registry.connectors.find((binding) => binding.mode === 'FULL')!;
    vi.spyOn(f.supervisor, 'catalogStatus').mockResolvedValue({ full: { live: { catalogHash: full.catalogHash, toolCount: full.expectedToolNames.length } } } as Awaited<ReturnType<Supervisor['catalogStatus']>>);
    let spawned: ChildProcess | undefined;
    mocks.start.mockImplementation(async (options: { dataRoot: string; onSpawn: (pid: number) => Promise<void> }) => {
      const op = (await f.internal.readState()).startupOperations.find((op) => op.component === 'runtime-probe')!;
      expect(op).toMatchObject({ state: 'SPAWNING', pid: null, dataRoot: options.dataRoot });
      expect(options.dataRoot).toBe(path.join(f.root, 'supervisor/probes', op.id));
      spawned = spawn(canonicalNodeRuntime().path, ['-e', 'setTimeout(()=>process.exit(0),1200)', sourceRoot], { detached: true, stdio: 'ignore' });
      const pid = await confirmChildSpawn(spawned); spawned.unref(); await options.onSpawn(pid);
      throw new Error('synthetic interruption before ownership publication');
    });
    await expect(f.internal.probeTargetCatalogManifest(sourceRoot)).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
    const op = (await f.internal.readState()).startupOperations.find((op) => op.component === 'runtime-probe')!;
    expect(op.state).toBe('RECONCILIATION_REQUIRED'); expect(op.pid).toBe(spawned?.pid);
    await gone(op.pid!); await f.supervisor.reconcileStartup();
    expect((await f.internal.readState()).startupOperations.find((entry) => entry.id === op.id)?.state).toBe('STOPPED');
  }, 10000);
});

describe('OS executable identity through a trusted launcher', () => {
  it('waits for env-to-Node exec using an unchanged birth identity, not argv0 resolution', async () => {
    const f = await fixture();
    await initializeConnectorRegistry(f.root, { fullTunnelId: `tunnel_${'a'.repeat(32)}`, proTunnelId: `tunnel_${'b'.repeat(32)}`, fullHealthPort: f.ports[0]!, proHealthPort: f.ports[1]! });
    const executable = path.join(f.root, 'fake-node-launcher');
    await writeFile(executable, "#!/usr/bin/env node\nsetTimeout(()=>process.exit(0),4000);setInterval(()=>{},1000);\n", { mode: 0o700 });
    const record = await f.internal.spawnManaged('tunnel-full', executable, [], sourceRoot, {}, null, path.join(f.root, 'logs'), 'fake-node-launcher');
    const operation = (await f.internal.readState()).startupOperations.find((op) => op.pid === record.pid)!;
    f.backups.push(operation);
    expect(operation).toMatchObject({ state: 'OWNERSHIP_VERIFIED', expectedProcessExecutable: await realpath(canonicalNodeRuntime().path), processExecutable: await realpath(canonicalNodeRuntime().path) });
    expect(operation.processStartMarker).toBe(record.processStartMarker);
    await f.supervisor.reconcileStartup(); await gone(record.pid);
  });
  it('does not reconcile another still-live supervisor owner', async () => {
    const f = await fixture(); const record = await child(f); const state = await f.internal.readState();
    await f.internal.writeState({ ...state, startupOperations: state.startupOperations.map((op) => ({ ...op, supervisorPid: record.pid, supervisorStartMarker: record.processStartMarker! })) }, true);
    await expect(f.supervisor.reconcileStartup()).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    expect(mocks.actualObserve!(record.pid).state).toBe('live');
  });
});
