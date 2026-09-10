import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindConnectorRuntime, initializeConnectorRegistry } from './connector-registry.js';
import { credentialPaths, loadOrCreateTunnelServiceSecret, persistControlPlaneApiKey, readTunnelServiceSecret } from './credentials.js';
import { startDaemon } from './daemon.js';
import { fullMcpToolNames } from './mcp-v21.js';
import { loadOrCreateRuntimeId, writeEndpoint } from './persistence.js';
import { createSupervisor } from './supervisor.js';
import { runtimeStatus } from './lifecycle.js';

const roots: string[] = [];
const sourceRoot = path.resolve(import.meta.dirname, '../../..');
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('IRIS supervisor', () => {
  it('reports missing migration state without creating files during status', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-status-'));
    roots.push(dataRoot);
    const supervisor = await createSupervisor({ dataRoot, sourceRoot: '/Users/example/iris' });
    const status = await supervisor.status();
    expect(status.state).toBe('FAILED');
    expect(status.localRuntime.code).toBe('MIGRATION_REQUIRED');
    await expect(import('node:fs/promises').then(({ access }) => access(path.join(dataRoot, 'supervisor')))).rejects.toThrow();
  });

  it('proves authenticated local discovery and exact profile catalogs for FULL and PRO', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-local-'));
    roots.push(dataRoot);
    await initializeConnectorRegistry(dataRoot, { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    await bindConnectorRuntime(dataRoot, await loadOrCreateRuntimeId(dataRoot));
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const daemon = await startDaemon({ dataRoot, preferredPort: 0 });
    try {
      const supervisor = await createSupervisor({ dataRoot, sourceRoot: '/Users/example/iris' });
      const readiness = await supervisor.localReadiness();
      expect(readiness.status).toMatchObject({ state: 'READY', code: 'READY' });
      expect(readiness.connectors.map((connector) => connector.expectedToolCount)).toEqual([fullMcpToolNames().length, 5]);
      expect(readiness.catalogs.map((catalog) => catalog.state)).toEqual(['ACTIVE', 'ACTIVE']);
      expect(readiness.catalogs.map((catalog) => catalog.live?.catalogHash)).toEqual(readiness.catalogs.map((catalog) => catalog.source.catalogHash));
      expect((await supervisor.catalogStatus()).state).toBe('ACTIVE');
      const serviceSecret = await readTunnelServiceSecret(dataRoot);
      expect(serviceSecret).not.toBeNull();
      const controlRoute = await fetch(`${daemon.apiUrl}/projects`, { headers: { authorization: `Bearer ${serviceSecret!}` } });
      expect(controlRoute.status).toBe(403);
      expect(credentialPaths(dataRoot).controlPlaneApiKey).toContain('credentials');
    } finally {
      await daemon.close();
    }
  });

  it('owns an idempotent runtime, web process, and two tunnel processes and stops only those records', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-up-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-fake-'));
    roots.push(dataRoot, fakeRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: 50_801,
      proHealthPort: 50_802,
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = path.join(fakeRoot, 'tunnel-client-fake.mjs');
    await writeFile(fakeTunnel, `#!/usr/bin/env node
if (process.argv[2] === 'health' && process.argv.includes('--require-control-plane-poll')) { process.exit(1); }
if (process.argv[2] === 'health') { process.stdout.write(JSON.stringify({ result: 'ok', healthz: { ok: true, status: 200 }, readyz: { ok: true, status: 200 } })); process.exit(0); }
process.on('SIGTERM', () => process.exit(0));
setInterval(() => undefined, 1000);
`);
    await chmod(fakeTunnel, 0o700);
    const webPort = await freePort();
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort });
    const first = await supervisor.up();
    expect(first.localRuntime.state).toBe('READY');
    expect(first.tunnel.state).toBe('READY');
    expect(first.endToEnd.state).toBe('UNKNOWN');
    const managedProfile = await readFile(path.join(dataRoot, 'tunnel-profiles', 'iris-full.yaml'), 'utf8');
    expect(managedProfile).toContain('file:');
    expect(managedProfile).not.toContain('control-plane-credential-for-test-only-12345');
    expect(managedProfile).not.toContain('Bearer ');
    const second = await supervisor.up();
    expect(second.localRuntime.state).toBe('READY');
    expect((await supervisor.catalogStatus()).state).toBe('ACTIVE');
    expect(second.connectors.map((connector) => connector.label)).toEqual(['IRIS FULL', 'IRIS PRO']);
    const stopped = await supervisor.down();
    expect(stopped.runtime.state).toBe('FAILED');
  });

  it('reconciles a trusted stale catalog before boot without reporting persistence failure', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-catalog-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-catalog-fake-'));
    roots.push(dataRoot, fakeRoot);
    const created = await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: 50_805,
      proHealthPort: 50_806,
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort: await freePort() });
    const first = await supervisor.up();
    const before = await runtimeStatus(dataRoot);
    if (before.endpoint === null) throw new Error('missing runtime before catalog migration');

    const registryPath = path.join(dataRoot, 'connector-registry.json');
    const old = JSON.parse(await readFile(registryPath, 'utf8')) as { schemaVersion: number; connectors: Array<Record<string, unknown>> };
    await writeFile(registryPath, JSON.stringify({
      ...old,
      schemaVersion: 1,
      connectors: old.connectors.map((connector) => {
      const stale: Record<string, unknown> = { ...connector, expectedToolNames: ['removed_tool'] };
        delete stale.catalogFingerprint;
        delete stale.deploymentEpoch;
        return stale;
      }),
    }), { mode: 0o600 });

    const second = await supervisor.up();
    const after = await runtimeStatus(dataRoot);
    if (after.endpoint === null) throw new Error('missing runtime after catalog migration');
    expect(second.localRuntime.state).toBe('READY');
    expect(after.endpoint.instanceId).not.toBe(before.endpoint.instanceId);
    expect(after.endpoint.pid).not.toBe(before.endpoint.pid);
    const reconciled = JSON.parse(await readFile(registryPath, 'utf8')) as {
      schemaVersion: number;
      deploymentEpoch: number;
      connectors: Array<{ readonly expectedToolNames: string[]; readonly catalogFingerprint: string; readonly tunnelId: string }>;
    };
    expect(reconciled.schemaVersion).toBe(2);
    expect(reconciled.deploymentEpoch).toBeGreaterThan(created.deploymentEpoch);
    expect(reconciled.connectors[0]?.expectedToolNames).toEqual(fullMcpToolNames());
    expect(reconciled.connectors.map((connector) => connector.tunnelId)).toEqual([
      'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    expect(first.registryPresent).toBe(true);
    await supervisor.down();
  }, 30_000);

  it('recycles an owned tunnel when readiness fails without touching other owned components', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-rollback-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-rollback-fake-'));
    roots.push(dataRoot, fakeRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: 50_811,
      proHealthPort: 50_812,
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const failureMarker = path.join(fakeRoot, 'fail-health');
    const fakeTunnel = path.join(fakeRoot, 'tunnel-client-fake.mjs');
    await writeFile(fakeTunnel, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
if (process.argv[2] === 'health') {
  if (existsSync(${JSON.stringify(failureMarker)})) process.exit(1);
  process.stdout.write(JSON.stringify({ result: 'ok', healthz: { ok: true, status: 200 }, readyz: { ok: true, status: 200 } }));
  process.exit(0);
}
process.on('SIGTERM', () => process.exit(0));
setInterval(() => undefined, 1000);
`);
    await chmod(fakeTunnel, 0o700);
    const webPort = await freePort();
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort });
    await supervisor.up();
    await writeFile(failureMarker, 'fail');
    await expect(supervisor.up()).rejects.toThrow('Tunnel health and readiness were not proven before the deadline');
    const state = JSON.parse(await readFile(path.join(dataRoot, 'supervisor', 'state.json'), 'utf8')) as {
      readonly runtime: unknown;
      readonly web: unknown;
      readonly tunnels: { readonly full: unknown; readonly pro: unknown };
    };
    expect(state.runtime).not.toBeNull();
    expect(state.web).not.toBeNull();
    expect(state.tunnels.full).toBeNull();
    expect(state.tunnels.pro).not.toBeNull();
    await rm(failureMarker, { force: true });
    expect((await supervisor.up()).state).toBe('DEGRADED');
    await supervisor.down();
  }, 30_000);

  it('automatically replaces a crashed owned runtime before restoring both connector profiles', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-recovery-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-recovery-fake-'));
    roots.push(dataRoot, fakeRoot);
    await initializeConnectorRegistry(dataRoot, { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fullHealthPort: 50_821, proHealthPort: 50_822 });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort: await freePort() });
    await supervisor.up();
    const before = await runtimeStatus(dataRoot);
    if (before.endpoint === null) throw new Error('missing runtime before crash');
    process.kill(before.endpoint.pid, 'SIGKILL');
    await waitForProcessGone(before.endpoint.pid);

    await (supervisor as unknown as { monitorOnceUnlocked(): Promise<void> }).monitorOnceUnlocked();
    const after = await runtimeStatus(dataRoot);
    if (after.endpoint === null || after.state !== 'running') throw new Error('runtime did not recover');
    expect(after.endpoint.pid).not.toBe(before.endpoint.pid);
    expect(after.endpoint.instanceId).not.toBe(before.endpoint.instanceId);
    const status = await supervisor.status();
    expect(status.localRuntime).toMatchObject({ state: 'READY', code: 'READY' });
    expect(status.tunnel).toMatchObject({ state: 'READY', code: 'READY' });
    await supervisor.down();
  }, 30_000);

  it('does not kill a PID reused by a foreign process', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-foreign-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-foreign-fake-'));
    roots.push(dataRoot, fakeRoot);
    await initializeConnectorRegistry(dataRoot, { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fullHealthPort: 50_831, proHealthPort: 50_832 });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort: await freePort() });
    await supervisor.up();
    const statePath = path.join(dataRoot, 'supervisor', 'state.json');
    const originalState = await readFile(statePath, 'utf8');
    const state = JSON.parse(originalState) as { runtime: Record<string, unknown> };
    state.runtime.pid = process.pid;
    state.runtime.startedAt = new Date().toISOString();
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    await expect(supervisor.up()).rejects.toThrow('Runtime endpoint does not match supervisor ownership metadata');
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    await writeFile(statePath, originalState, { mode: 0o600 });
    await supervisor.down();
  });

  it('classifies an endpoint whose recorded process is gone as stale metadata', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-stale-endpoint-'));
    roots.push(dataRoot);
    const runtimeId = randomUUID();
    const instanceId = randomUUID();
    await writeEndpoint(dataRoot, {
      schemaVersion: 1,
      runtimeId,
      instanceId,
      pid: 2_147_483_647,
      apiUrl: 'http://127.0.0.1:43110',
      mcpUrl: 'http://127.0.0.1:43110/mcp',
      startedAt: new Date().toISOString(),
    });
    await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'stale', reason: 'STALE_METADATA' });
  });

  it('replaces an owned runtime on restart with a new process and instance identity', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-restart-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-restart-fake-'));
    roots.push(dataRoot, fakeRoot);
    await initializeConnectorRegistry(dataRoot, { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fullHealthPort: 50_841, proHealthPort: 50_842 });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort: await freePort() });
    await supervisor.up();
    const before = await runtimeStatus(dataRoot);
    if (before.endpoint === null) throw new Error('missing runtime before restart');
    const reused = await supervisor.up();
    const reusedRuntime = await runtimeStatus(dataRoot);
    expect(reusedRuntime.endpoint).toMatchObject({ pid: before.endpoint.pid, instanceId: before.endpoint.instanceId });
    expect(reused.localRuntime).toMatchObject({ state: 'READY' });
    const restarted = await supervisor.restart();
    const after = await runtimeStatus(dataRoot);
    if (after.endpoint === null) throw new Error('missing runtime after restart');
    expect(after.endpoint.pid).not.toBe(before.endpoint.pid);
    expect(after.endpoint.instanceId).not.toBe(before.endpoint.instanceId);
    expect(restarted.localRuntime).toMatchObject({ state: 'READY' });
    expect(restarted.tunnel).toMatchObject({ state: 'READY' });
    await supervisor.down();
  }, 30_000);

  it('serializes concurrent up operations without starting a duplicate runtime', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-concurrent-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-concurrent-fake-'));
    roots.push(dataRoot, fakeRoot);
    await initializeConnectorRegistry(dataRoot, { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fullHealthPort: 50_851, proHealthPort: 50_852 });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort: await freePort() });
    const results = await Promise.allSettled([supervisor.up(), supervisor.up()]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof supervisor.up>>> => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'SUPERVISOR_BUSY' });
    const state = JSON.parse(await readFile(path.join(dataRoot, 'supervisor', 'state.json'), 'utf8')) as { runtime: { pid: number } | null };
    expect(state.runtime).not.toBeNull();
    expect((await runtimeStatus(dataRoot)).endpoint?.pid).toBe(state.runtime?.pid);
    await supervisor.down();
  }, 30_000);

  it('enters durable recovery-required state at the bounded restart budget', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-budget-'));
    roots.push(dataRoot);
    await initializeConnectorRegistry(dataRoot, { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const windowStartedAt = new Date().toISOString();
    await mkdir(path.join(dataRoot, 'supervisor'), { mode: 0o700 });
    await writeFile(path.join(dataRoot, 'supervisor', 'state.json'), JSON.stringify({
      schemaVersion: 2,
      supervisorId: 'test-supervisor',
      updatedAt: windowStartedAt,
      runtime: null,
      web: null,
      tunnels: { full: null, pro: null },
      recovery: { attempts: 3, terminal: false, lastFailureCode: 'RUNTIME_NOT_RUNNING', nextAttemptAt: null, windowStartedAt },
    }), { mode: 0o600 });
    const supervisor = await createSupervisor({ dataRoot, sourceRoot: '/Users/example/iris' });
    await (supervisor as unknown as { monitorOnceUnlocked(): Promise<void> }).monitorOnceUnlocked();
    const state = JSON.parse(await readFile(path.join(dataRoot, 'supervisor', 'state.json'), 'utf8')) as { recovery: { attempts: number; terminal: boolean; lastFailureCode: string } };
    expect(state.recovery).toMatchObject({ attempts: 3, terminal: true, lastFailureCode: 'RECOVERY_REQUIRED' });
  });
});

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Could not reserve a test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function fakeTunnelClient(fakeRoot: string): Promise<string> {
  const filename = path.join(fakeRoot, 'tunnel-client-fake.mjs');
  await writeFile(filename, `#!/usr/bin/env node
if (process.argv[2] === 'health') { process.stdout.write(JSON.stringify({ result: 'ok', healthz: { ok: true, status: 200 }, readyz: { ok: true, status: 200 } })); process.exit(0); }
process.on('SIGTERM', () => process.exit(0));
setInterval(() => undefined, 1000);
`);
  await chmod(filename, 0o700);
  return filename;
}

async function waitForProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} did not stop`);
}
