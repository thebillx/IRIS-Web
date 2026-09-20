import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectActivationSourceIdentity } from './activation-source-identity.js';
import { bindConnectorRuntime, initializeConnectorRegistry, readConnectorRegistry, type ConnectorBinding } from './connector-registry.js';
import { credentialPaths, loadOrCreateTunnelServiceSecret, persistControlPlaneApiKey, readTunnelServiceSecret } from './credentials.js';
import { startDaemon } from './daemon.js';
import { catalogIdentityAtVersion } from './mcp-catalog.js';
import { fullMcpToolNames } from './mcp-v21.js';
import { loadOrCreateRuntimeId, writeEndpoint } from './persistence.js';
import { catalogProfileStatusWithoutAuthoritativeIdentity, createSupervisor, supervisorAdminChildEnvironment } from './supervisor.js';
import { startSupervisorNativeControlServer } from './supervisor-native-control.js';
import { MCP_PROTOCOL_VERSION, proMcpToolDefinitions } from './mcp.js';
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

  it('does not misclassify a stopped runtime as an MCP authentication failure', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-stopped-'));
    roots.push(dataRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const supervisor = await createSupervisor({ dataRoot, sourceRoot: '/Users/example/iris' });

    expect((await supervisor.localReadiness()).status.code).toBe('RUNTIME_NOT_RUNNING');
    expect((await supervisor.status()).localRuntime.code).toBe('RUNTIME_NOT_RUNNING');
    expect((await supervisor.doctor()).CODE).toBe('RUNTIME_NOT_RUNNING');
  });

  it('propagates the protected reference root into the persistent admin child environment', () => {
    expect(supervisorAdminChildEnvironment('/private/tmp/iris-data', 43_111, '/Users/example/iris')).toEqual({
      IRIS_RUNTIME_DATA_ROOT: '/private/tmp/iris-data',
      IRIS_SUPERVISOR_ADMIN_PORT: '43111',
      IRIS_PROTECTED_REFERENCE_ROOT: '/Users/example/iris',
    });
    expect(supervisorAdminChildEnvironment('/private/tmp/iris-data', 43_111)).toEqual({
      IRIS_RUNTIME_DATA_ROOT: '/private/tmp/iris-data',
      IRIS_SUPERVISOR_ADMIN_PORT: '43111',
    });
  });

  it('does not fabricate a PRO catalog identity in cross-source compatibility mode', () => {
    const names = ['list_projects', 'project_info', 'git_status', 'file_read', 'search'];
    const binding: ConnectorBinding = {
      connectorId: 'iris-pro',
      label: 'IRIS PRO',
      mode: 'PRO',
      tunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      runtime: 'iris-local-runtime',
      mcpProfile: 'READ_ONLY',
      mcpPath: '/mcp-pro',
      expectedToolNames: names,
      catalogFingerprint: 'a'.repeat(64),
      catalogHash: `sha256:${'b'.repeat(64)}`,
      healthPort: 8081,
      managedProfilePath: '/private/tmp/iris-pro.yaml',
      machineId: null,
      runtimeId: 'runtime',
      deploymentEpoch: 20,
      leaseGeneration: 1,
    };
    const source = {
      identity: {
        profile: 'PRO' as const,
        catalogVersion: '2.3.0' as const,
        catalogHash: binding.catalogHash,
        toolCount: names.length,
      },
      names,
    };

    expect(catalogProfileStatusWithoutAuthoritativeIdentity(binding, source, names, true)).toMatchObject({
      live: null,
      liveToolCount: 5,
      state: 'UNKNOWN',
    });
    expect(catalogProfileStatusWithoutAuthoritativeIdentity(binding, source, names.slice(0, -1), true)).toMatchObject({
      live: null,
      liveToolCount: 4,
      state: 'STALE_RUNTIME',
    });
  });

  it('labels cross-source catalog diagnostics and does not recommend reload without authoritative runtime identity', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-cross-source-status-'));
    roots.push(dataRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    const supervisorDirectory = path.join(dataRoot, 'supervisor');
    await mkdir(supervisorDirectory, { recursive: true });
    await writeFile(path.join(supervisorDirectory, 'state.json'), JSON.stringify({
      schemaVersion: 3,
      supervisorId: 'cross-source-fixture',
      updatedAt: new Date().toISOString(),
      workloadSourceRoot: '/Users/example/older-workload',
      runtime: null,
      web: null,
      admin: null,
      adminTunnel: null,
      tunnels: { full: null, pro: null },
      recovery: {
        attempts: 0,
        terminal: false,
        lastFailureCode: null,
        nextAttemptAt: null,
        windowStartedAt: null,
      },
    }));

    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot: '/Users/example/new-control-source',
    });
    const status = await supervisor.catalogStatus();

    expect(status.sourceMode).toBe('BOUND_WORKLOAD_COMPATIBILITY');
    expect(status.state).toBe('UNKNOWN');
    expect(status.recommendedAction).toBe('USE_CONTROLLED_ACTIVATION_BEFORE_CATALOG_RELOAD');
    expect(status.pro.live).toBeNull();
    expect(status.pro.liveToolCount).toBeNull();
    await expect(supervisor.catalogReload()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('keeps authenticated cross-source workload transport operable but degraded until catalog identity is authoritative', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-cross-source-readiness-'));
    roots.push(dataRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    await bindConnectorRuntime(dataRoot, await loadOrCreateRuntimeId(dataRoot));
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const daemon = await startDaemon({ dataRoot, preferredPort: 0 });
    try {
      const supervisorDirectory = path.join(dataRoot, 'supervisor');
      await mkdir(supervisorDirectory, { recursive: true });
      await writeFile(path.join(supervisorDirectory, 'state.json'), JSON.stringify({
        schemaVersion: 3,
        supervisorId: 'cross-source-readiness-fixture',
        updatedAt: new Date().toISOString(),
        workloadSourceRoot: '/Users/example/older-workload',
        runtime: null,
        web: null,
        admin: null,
        adminTunnel: null,
        tunnels: { full: null, pro: null },
        recovery: {
          attempts: 0,
          terminal: false,
          lastFailureCode: null,
          nextAttemptAt: null,
          windowStartedAt: null,
        },
      }));

      const supervisor = await createSupervisor({
        dataRoot,
        sourceRoot: '/Users/example/new-control-source',
      });
      const readiness = await supervisor.localReadiness();

      expect(readiness.status).toMatchObject({
        state: 'DEGRADED',
        code: 'CATALOG_IDENTITY_UNVERIFIED',
      });
      expect(readiness.connectors.map((connector) => connector.state)).toEqual(['READY', 'UNKNOWN']);
      expect(readiness.connectors[1]).toMatchObject({ code: 'CATALOG_IDENTITY_UNVERIFIED' });
      expect(readiness.catalogs.map((catalog) => catalog.state)).toEqual(['ACTIVE', 'UNKNOWN']);
      expect(readiness.catalogs[1]?.live).toBeNull();
      expect(readiness.catalogs[1]?.liveToolCount).toBe(5);
    } finally {
      await daemon.close();
    }
  });

  it('keeps supervisor up operable in cross-source degraded mode without replacing the healthy workload', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-cross-source-up-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-cross-source-up-fake-'));
    roots.push(dataRoot, fakeRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: await freePort(),
      proHealthPort: await freePort(),
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const webPort = await freePort();
    const adminPort = await freePort();
    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot,
      tunnelClientPath: fakeTunnel,
      webPort,
      adminPort,
    });

    try {
      const baseline = await supervisor.up();
      expect(baseline.localRuntime.state).toBe('READY');
      const statePath = path.join(dataRoot, 'supervisor', 'state.json');
      const before = JSON.parse(await readFile(statePath, 'utf8')) as {
        workloadSourceRoot: string;
        runtime: { pid: number } | null;
        web: { pid: number } | null;
        tunnels: { full: { pid: number } | null; pro: { pid: number } | null };
      };
      await writeFile(statePath, JSON.stringify({
        ...before,
        workloadSourceRoot: '/Users/example/older-workload',
      }), { mode: 0o600 });

      const transition = await supervisor.up();
      expect(transition.localRuntime).toMatchObject({
        state: 'DEGRADED',
        code: 'CATALOG_IDENTITY_UNVERIFIED',
      });
      expect(transition.state).toBe('DEGRADED');
      expect(transition.connectors.map((connector) => connector.state)).toEqual(['READY', 'UNKNOWN']);
      expect(transition.connectors[1]).toMatchObject({ code: 'CATALOG_IDENTITY_UNVERIFIED' });

      const after = JSON.parse(await readFile(statePath, 'utf8')) as {
        workloadSourceRoot: string;
        runtime: { pid: number } | null;
        web: { pid: number } | null;
        tunnels: { full: { pid: number } | null; pro: { pid: number } | null };
      };
      expect(after.workloadSourceRoot).toBe('/Users/example/older-workload');
      expect(after.runtime?.pid).toBe(before.runtime?.pid);
      expect(after.web?.pid).toBe(before.web?.pid);
      expect(after.tunnels.full?.pid).toBe(before.tunnels.full?.pid);
      expect(after.tunnels.pro?.pid).toBe(before.tunnels.pro?.pid);

      await writeFile(statePath, JSON.stringify({
        ...after,
        recovery: {
          attempts: 3,
          terminal: false,
          lastFailureCode: 'RUNTIME_NOT_RUNNING',
          nextAttemptAt: null,
          windowStartedAt: new Date().toISOString(),
        },
      }), { mode: 0o600 });
      await (supervisor as unknown as { monitorOnceUnlocked(): Promise<void> }).monitorOnceUnlocked();
      const monitored = JSON.parse(await readFile(statePath, 'utf8')) as {
        runtime: { pid: number } | null;
        web: { pid: number } | null;
        tunnels: { full: { pid: number } | null; pro: { pid: number } | null };
        recovery: { attempts: number; terminal: boolean; lastFailureCode: string | null };
      };
      expect(monitored.recovery).toMatchObject({
        attempts: 3,
        terminal: false,
        lastFailureCode: 'RUNTIME_NOT_RUNNING',
      });
      expect(monitored.runtime?.pid).toBe(before.runtime?.pid);
      expect(monitored.web?.pid).toBe(before.web?.pid);
      expect(monitored.tunnels.full?.pid).toBe(before.tunnels.full?.pid);
      expect(monitored.tunnels.pro?.pid).toBe(before.tunnels.pro?.pid);
    } finally {
      await supervisor.down().catch(() => undefined);
    }
  }, 60_000);

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
      const catalogStatus = await supervisor.catalogStatus();
      expect(catalogStatus.state).toBe('ACTIVE');
      expect(catalogStatus.sourceMode).toBe('STRICT_CONTROL_SOURCE');
      expect(catalogStatus.recommendedAction).toBe('NONE');
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
      adminTunnelId: 'tunnel_cccccccccccccccccccccccccccccccc',
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
    const adminPort = await freePort();
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort, adminPort });
    const first = await supervisor.up();
    expect(first.localRuntime.state).toBe('READY');
    expect(first.tunnel.state).toBe('READY');
    expect(first.controlPlane.state).toBe('READY');
    expect(first.endToEnd.state).toBe('UNKNOWN');
    const fullProfile = await readFile(path.join(dataRoot, 'tunnel-profiles', 'iris-full.yaml'), 'utf8');
    const proProfile = await readFile(path.join(dataRoot, 'tunnel-profiles', 'iris-pro.yaml'), 'utf8');
    const adminProfile = await readFile(path.join(dataRoot, 'tunnel-profiles', 'iris-admin.yaml'), 'utf8');
    expect(fullProfile).toContain('file:');
    expect(fullProfile).not.toContain('control-plane-credential-for-test-only-12345');
    expect(fullProfile).not.toContain('Bearer ');
    expect(fullProfile).not.toContain('channel: admin');
    expect(proProfile).not.toContain('channel: admin');
    expect(adminProfile).toContain('channel: admin');
    expect(adminProfile).not.toContain('channel: main');
    expect(adminProfile).toContain('tunnel_cccccccccccccccccccccccccccccccc');
    expect(adminProfile).not.toContain(`http://127.0.0.1:${adminPort}/mcp`);
    expect(adminProfile).not.toContain('x-iris-runtime-id');
    expect(adminProfile).not.toContain('x-iris-deployment-epoch');
    const statePath = path.join(dataRoot, 'supervisor', 'state.json');
    const beforeState = JSON.parse(await readFile(statePath, 'utf8')) as {
      readonly runtime: { readonly pid: number } | null;
      readonly admin: { readonly pid: number } | null;
      readonly tunnels: {
        readonly full: { readonly pid: number; readonly profileDigest?: string | null } | null;
        readonly pro: { readonly pid: number; readonly profileDigest?: string | null } | null;
      };
    };
    expect(beforeState.admin).not.toBeNull();
    expect(beforeState.tunnels.full?.profileDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(beforeState.tunnels.pro?.profileDigest).toMatch(/^[0-9a-f]{64}$/);
    const second = await supervisor.up();
    expect(second.localRuntime.state).toBe('READY');
    expect(second.controlPlane.state).toBe('READY');
    const afterState = JSON.parse(await readFile(statePath, 'utf8')) as typeof beforeState;
    expect(afterState.runtime?.pid).toBe(beforeState.runtime?.pid);
    expect(afterState.admin?.pid).toBe(beforeState.admin?.pid);
    expect(afterState.tunnels.full?.pid).toBe(beforeState.tunnels.full?.pid);
    expect(afterState.tunnels.pro?.pid).toBe(beforeState.tunnels.pro?.pid);
    expect(afterState.tunnels.full?.profileDigest).toBe(beforeState.tunnels.full?.profileDigest);
    expect(afterState.tunnels.pro?.profileDigest).toBe(beforeState.tunnels.pro?.profileDigest);
    expect((await supervisor.catalogStatus()).state).toBe('ACTIVE');
    expect(second.connectors.map((connector) => connector.label)).toEqual(['IRIS FULL', 'IRIS PRO']);

    const staleDigestState = {
      ...afterState,
      tunnels: {
        ...afterState.tunnels,
        full: afterState.tunnels.full === null ? null : { ...afterState.tunnels.full, profileDigest: '0'.repeat(64) },
      },
    };
    await writeFile(statePath, JSON.stringify(staleDigestState), { mode: 0o600 });
    const third = await supervisor.up();
    expect(third.controlPlane.state).toBe('READY');
    const recycledState = JSON.parse(await readFile(statePath, 'utf8')) as typeof beforeState;
    expect(recycledState.runtime?.pid).toBe(afterState.runtime?.pid);
    expect(recycledState.admin?.pid).toBe(afterState.admin?.pid);
    expect(recycledState.tunnels.full?.pid).not.toBe(afterState.tunnels.full?.pid);
    expect(recycledState.tunnels.pro?.pid).toBe(afterState.tunnels.pro?.pid);
    expect(recycledState.tunnels.full?.profileDigest).toBe(beforeState.tunnels.full?.profileDigest);
    expect(recycledState.tunnels.pro?.profileDigest).toBe(afterState.tunnels.pro?.profileDigest);

    const stopped = await supervisor.down();
    expect(stopped.runtime.state).toBe('FAILED');
  }, 30_000);

  it('isolates admin/workload tunnel digests and recycles only the admin child', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-isolated-admin-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-isolated-admin-fake-'));
    roots.push(dataRoot, fakeRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      adminTunnelId: 'tunnel_cccccccccccccccccccccccccccccccc',
      fullHealthPort: 50_803,
      proHealthPort: 50_804,
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const adminPort = await freePort();
    const nativePort = await freePort();
    const adminTunnelHealthPort = await freePort();
    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot,
      protectedReferenceRoot: sourceRoot,
      tunnelClientPath: fakeTunnel,
      webPort: await freePort(),
      adminPort,
      supervisorControlPort: nativePort,
      adminTunnelHealthPort,
    });
    const native = await startSupervisorNativeControlServer(dataRoot, nativePort, {
      supervisorStatus: () => supervisor.supervisorNativeStatus(),
      adminStatus: () => supervisor.adminNativeStatus(),
      adminRecycle: (input) => supervisor.adminRecycle(input),
      adminToolCall: (name, args) => supervisor.adminToolCall(name, args),
    });
    try {
      (supervisor as unknown as { nativeControlActive: boolean }).nativeControlActive = true;
      const first = await supervisor.up();
      expect(first.controlPlane.state).toBe('READY');
      const secret = await readTunnelServiceSecret(dataRoot);
      if (secret === null) throw new Error('missing native supervisor test secret');
      const nativeStatus = await nativeToolCall(native.mcpUrl, secret, 'supervisor_status', {});
      expect(nativeStatus).toMatchObject({
        supervisorControlOwner: 'OUTER_SUPERVISOR_DAEMON',
        readiness: 'READY',
        controlSourceRoot: sourceRoot,
        protectedReferenceRoot: sourceRoot,
        adminChildWorkingDirectory: sourceRoot,
        adminSourceCoherent: true,
        adminEnvironmentCoherent: true,
      });
      expect(nativeStatus.adminChildEnvironmentDigest).toMatch(/^[0-9a-f]{64}$/);
      const nativeAdminStatus = await nativeToolCall(native.mcpUrl, secret, 'admin_status', {});
      expect(nativeAdminStatus).toMatchObject({
        adminChildWorkingDirectory: sourceRoot,
        protectedReferenceRoot: sourceRoot,
        adminSourceCoherent: true,
        adminEnvironmentCoherent: true,
        activationStatusAvailable: true,
        activationPrepareAvailable: true,
        activationApplyAvailable: true,
        activationConfirmAvailable: true,
        activationRollbackAvailable: true,
      });
      expect(nativeAdminStatus.adminChildEnvironmentDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(nativeAdminStatus.expectedAdminEnvironmentDigest).toBe(nativeAdminStatus.adminChildEnvironmentDigest);
      const statePath = path.join(dataRoot, 'supervisor', 'state.json');
      type State = {
        readonly runtime: { readonly pid: number } | null;
        readonly web: { readonly pid: number } | null;
        readonly admin: {
          readonly pid: number;
          readonly processStartTimeMs?: number | null;
          readonly startedAt: string;
          readonly workingDirectory?: string | null;
          readonly environmentDigest?: string | null;
        } | null;
        readonly adminTunnel: { readonly pid: number; readonly tunnelId?: string | null; readonly profileDigest?: string | null } | null;
        readonly tunnels: {
          readonly full: { readonly pid: number; readonly tunnelId?: string | null; readonly profileDigest?: string | null } | null;
          readonly pro: { readonly pid: number; readonly profileDigest?: string | null } | null;
        };
      };
      const before = JSON.parse(await readFile(statePath, 'utf8')) as State;
      expect(before.adminTunnel?.profileDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(before.tunnels.full?.profileDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(before.adminTunnel?.tunnelId).toBe('tunnel_cccccccccccccccccccccccccccccccc');
      expect(before.tunnels.full?.tunnelId).toBe('tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(before.adminTunnel?.tunnelId).not.toBe(before.tunnels.full?.tunnelId);
      expect(before.adminTunnel?.pid).not.toBe(before.tunnels.full?.pid);

      await writeFile(statePath, JSON.stringify({
        ...before,
        adminTunnel: before.adminTunnel === null ? null : { ...before.adminTunnel, profileDigest: '0'.repeat(64) },
      }), { mode: 0o600 });
      await supervisor.up();
      const afterAdminDigest = JSON.parse(await readFile(statePath, 'utf8')) as State;
      expect(afterAdminDigest.adminTunnel?.pid).not.toBe(before.adminTunnel?.pid);
      expect(afterAdminDigest.tunnels.full?.pid).toBe(before.tunnels.full?.pid);
      expect(afterAdminDigest.tunnels.pro?.pid).toBe(before.tunnels.pro?.pid);
      expect(afterAdminDigest.runtime?.pid).toBe(before.runtime?.pid);
      expect(afterAdminDigest.admin?.pid).toBe(before.admin?.pid);

      await writeFile(statePath, JSON.stringify({
        ...afterAdminDigest,
        tunnels: {
          ...afterAdminDigest.tunnels,
          full: afterAdminDigest.tunnels.full === null ? null : { ...afterAdminDigest.tunnels.full, profileDigest: '0'.repeat(64) },
        },
      }), { mode: 0o600 });
      await supervisor.up();
      const afterWorkloadDigest = JSON.parse(await readFile(statePath, 'utf8')) as State;
      expect(afterWorkloadDigest.tunnels.full?.pid).not.toBe(afterAdminDigest.tunnels.full?.pid);
      expect(afterWorkloadDigest.adminTunnel?.pid).toBe(afterAdminDigest.adminTunnel?.pid);
      expect(afterWorkloadDigest.tunnels.pro?.pid).toBe(afterAdminDigest.tunnels.pro?.pid);
      expect(afterWorkloadDigest.runtime?.pid).toBe(afterAdminDigest.runtime?.pid);
      expect(afterWorkloadDigest.admin?.pid).toBe(afterAdminDigest.admin?.pid);

      await writeFile(statePath, JSON.stringify({
        ...afterWorkloadDigest,
        admin: afterWorkloadDigest.admin === null ? null : {
          ...afterWorkloadDigest.admin,
          workingDirectory: '/Users/example/older-control-source',
        },
      }), { mode: 0o600 });

      const staleAdminStatus = await supervisor.adminNativeStatus();
      expect(staleAdminStatus).toMatchObject({
        adminSourceCoherent: false,
        readiness: 'DEGRADED',
      });
      const staleSupervisorStatus = await supervisor.supervisorNativeStatus();
      expect(staleSupervisorStatus).toMatchObject({
        adminSourceCoherent: false,
        readiness: 'DEGRADED',
      });

      const readableActivation = await supervisor.adminToolCall('activation_status', {});
      expect(readableActivation.isError).toBe(false);
      const rollbackRecovery = await supervisor.adminToolCall('activation_rollback', { transactionId: randomUUID() });
      expect(rollbackRecovery.isError).toBe(true);
      await expect(supervisor.adminToolCall('activation_prepare', {}))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

      if (typeof staleSupervisorStatus.adminChildIdentity !== 'string'
        || typeof staleSupervisorStatus.adminProfileDigest !== 'string') {
        throw new Error('missing stale admin recycle preconditions');
      }
      const recycle = await nativeToolCall(native.mcpUrl, secret, 'admin_recycle', {
        expectedAdminIdentity: staleSupervisorStatus.adminChildIdentity,
        expectedAdminProfileDigest: staleSupervisorStatus.adminProfileDigest,
      });
      expect(recycle).toMatchObject({
        adminIdentityChanged: true,
        adminSourceCoherent: true,
        adminEnvironmentCoherent: true,
        adminRouteReady: true,
        workloadRuntimeIdUnchanged: true,
        workloadInstanceIdUnchanged: true,
        workloadCatalogIdUnchanged: true,
        workloadDeploymentEpochUnchanged: true,
        workloadTunnelUnchanged: true,
        webUnchanged: true,
      });
      const activationSmoke = await nativeToolCall(native.mcpUrl, secret, 'activation_status', {});
      expect(activationSmoke.activeTransactionId).toBeNull();
      const afterRecycle = JSON.parse(await readFile(statePath, 'utf8')) as State;
      expect(afterRecycle.admin?.pid).not.toBe(afterWorkloadDigest.admin?.pid);
      expect(afterRecycle.adminTunnel?.pid).toBe(afterWorkloadDigest.adminTunnel?.pid);
      expect(afterRecycle.tunnels.full?.pid).toBe(afterWorkloadDigest.tunnels.full?.pid);
      expect(afterRecycle.tunnels.pro?.pid).toBe(afterWorkloadDigest.tunnels.pro?.pid);
      expect(afterRecycle.runtime?.pid).toBe(afterWorkloadDigest.runtime?.pid);
      expect(afterRecycle.web?.pid).toBe(afterWorkloadDigest.web?.pid);

      const concurrent = await Promise.allSettled([supervisor.adminRecycle(), supervisor.adminRecycle()]);
      expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = concurrent.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: 'SUPERVISOR_BUSY' });
      const afterConcurrent = JSON.parse(await readFile(statePath, 'utf8')) as State;
      expect(afterConcurrent.adminTunnel?.pid).toBe(afterRecycle.adminTunnel?.pid);
      expect(afterConcurrent.tunnels.full?.pid).toBe(afterRecycle.tunnels.full?.pid);
      expect(afterConcurrent.tunnels.pro?.pid).toBe(afterRecycle.tunnels.pro?.pid);
      expect(afterConcurrent.runtime?.pid).toBe(afterRecycle.runtime?.pid);
      expect(afterConcurrent.web?.pid).toBe(afterRecycle.web?.pid);
      expect((await fetch(native.healthUrl, { headers: { authorization: `Bearer ${await readTunnelServiceSecret(dataRoot)}` } })).status).toBe(200);
    } finally {
      (supervisor as unknown as { nativeControlActive: boolean }).nativeControlActive = false;
      await supervisor.down();
      await native.close();
    }
  }, 30_000);

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
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort: await freePort(), adminPort: await freePort() });
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
      connectors: Array<{
        readonly expectedToolNames: string[];
        readonly catalogFingerprint: string;
        readonly tunnelId: string;
        readonly machineId: string | null;
        readonly leaseGeneration: number;
      }>;
    };
    expect(reconciled.schemaVersion).toBe(3);
    expect(reconciled.deploymentEpoch).toBeGreaterThan(created.deploymentEpoch);
    expect(reconciled.connectors[0]?.expectedToolNames).toEqual(fullMcpToolNames());
    expect(reconciled.connectors.every((connector) => typeof connector.machineId === 'string' && connector.leaseGeneration > 0)).toBe(true);
    expect(reconciled.connectors.map((connector) => connector.tunnelId)).toEqual([
      'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    expect(first.registryPresent).toBe(true);
    await supervisor.down();
  }, 30_000);

  it('rejects candidate catalog drift before disturbing a healthy baseline workload', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-preflight-reject-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-preflight-reject-fake-'));
    roots.push(dataRoot, fakeRoot);
    const alternateRoot = await alternateCatalogSource(fakeRoot);
    const alternateCatalogPath = path.join(alternateRoot, 'apps', 'runtime', 'src', 'mcp-catalog.ts');
    const alternateCatalog = await readFile(alternateCatalogPath, 'utf8');
    const proSearchEntry = "  entry('search', 'READ_ONLY', 'project.search', '2.0.0', 'PRO'),\n";
    if (!alternateCatalog.includes(proSearchEntry)) throw new Error('alternate PRO catalog fixture marker not found');
    await writeFile(alternateCatalogPath, alternateCatalog.replace(proSearchEntry, ''));

    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: await freePort(),
      proHealthPort: await freePort(),
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot,
      tunnelClientPath: fakeTunnel,
      webPort: await freePort(),
      adminPort: await freePort(),
    });

    try {
      const baseline = await supervisor.up();
      expect(baseline.localRuntime.state).toBe('READY');
      expect(baseline.tunnel.state).toBe('READY');
      expect(baseline.controlPlane.state).toBe('READY');
      const beforeRuntime = await runtimeStatus(dataRoot);
      const beforeRegistry = await readConnectorRegistry(dataRoot);
      if (beforeRuntime.state !== 'running' || beforeRuntime.endpoint === null || beforeRegistry === null) {
        throw new Error('baseline runtime or connector registry is not ready');
      }

      await expect(supervisor.replaceWorkloadSourceRoot(alternateRoot)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

      const afterRuntime = await runtimeStatus(dataRoot);
      const afterRegistry = await readConnectorRegistry(dataRoot);
      const afterStatus = await supervisor.status();
      expect(afterRuntime.state).toBe('running');
      expect(afterRuntime.endpoint?.instanceId).toBe(beforeRuntime.endpoint.instanceId);
      expect(afterRuntime.endpoint?.pid).toBe(beforeRuntime.endpoint.pid);
      expect(afterStatus.localRuntime.state).toBe('READY');
      expect(afterStatus.tunnel.state).toBe('READY');
      expect(afterStatus.controlPlane.state).toBe('READY');
      expect((await supervisor.workloadBinding()).sourceRoot).toBe(sourceRoot);
      expect(afterRegistry?.deploymentEpoch).toBe(beforeRegistry.deploymentEpoch);
      expect(afterRegistry?.connectors.map((connector) => [connector.expectedToolNames, connector.catalogHash])).toEqual(
        beforeRegistry.connectors.map((connector) => [connector.expectedToolNames, connector.catalogHash]),
      );
    } finally {
      await supervisor.down().catch(() => undefined);
    }
  }, 60_000);

  it('rejects a stale activation source identity before candidate preflight can disturb the healthy baseline', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-source-identity-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-source-identity-fake-'));
    roots.push(dataRoot, fakeRoot);
    const alternateRoot = await alternateCatalogSource(fakeRoot);
    await initializeActivationIdentityRepo(alternateRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: await freePort(),
      proHealthPort: await freePort(),
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot,
      tunnelClientPath: fakeTunnel,
      webPort: await freePort(),
      adminPort: await freePort(),
    });

    try {
      const baseline = await supervisor.up();
      expect(baseline.localRuntime.state).toBe('READY');
      const beforeRuntime = await runtimeStatus(dataRoot);
      const beforeRegistry = await readConnectorRegistry(dataRoot);
      if (beforeRuntime.state !== 'running' || beforeRuntime.endpoint === null || beforeRegistry === null) {
        throw new Error('baseline runtime or connector registry is not ready');
      }

      const replaceIdentityBound = supervisor.replaceWorkloadSourceRoot.bind(supervisor) as unknown as (
        sourceRoot: string,
        sourceIdentity: {
          readonly head: string;
          readonly candidateFingerprint: string;
          readonly trackedModifiedCount: number;
          readonly fingerprintAlgorithm: 'sha256:sorted-tracked-path-content-v1';
        },
      ) => Promise<unknown>;
      await expect(replaceIdentityBound(alternateRoot, {
        head: 'f'.repeat(40),
        candidateFingerprint: 'e'.repeat(64),
        trackedModifiedCount: 0,
        fingerprintAlgorithm: 'sha256:sorted-tracked-path-content-v1',
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

      const afterRuntime = await runtimeStatus(dataRoot);
      const afterRegistry = await readConnectorRegistry(dataRoot);
      expect(afterRuntime.state).toBe('running');
      expect(afterRuntime.endpoint?.instanceId).toBe(beforeRuntime.endpoint.instanceId);
      expect(afterRuntime.endpoint?.pid).toBe(beforeRuntime.endpoint.pid);
      expect((await supervisor.workloadBinding()).sourceRoot).toBe(sourceRoot);
      expect(afterRegistry?.deploymentEpoch).toBe(beforeRegistry.deploymentEpoch);
    } finally {
      await supervisor.down().catch(() => undefined);
    }
  }, 60_000);

  it('rejects a candidate whose runtime dependencies disappear after identity inspection without disturbing the baseline', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-dependency-race-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-dependency-race-fake-'));
    roots.push(dataRoot, fakeRoot);
    const alternateRoot = await alternateCatalogSource(fakeRoot);
    await initializeActivationIdentityRepo(alternateRoot);
    const expectedIdentity = await inspectActivationSourceIdentity(alternateRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: await freePort(),
      proHealthPort: await freePort(),
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot,
      tunnelClientPath: fakeTunnel,
      webPort: await freePort(),
      adminPort: await freePort(),
    });

    try {
      const baseline = await supervisor.up();
      expect(baseline.localRuntime.state).toBe('READY');
      const beforeRuntime = await runtimeStatus(dataRoot);
      const beforeRegistry = await readConnectorRegistry(dataRoot);
      if (beforeRuntime.state !== 'running' || beforeRuntime.endpoint === null || beforeRegistry === null) {
        throw new Error('baseline runtime or connector registry is not ready');
      }

      await rm(path.join(alternateRoot, 'apps', 'web', 'node_modules', '.bin', 'vite'));

      await expect(supervisor.replaceWorkloadSourceRoot(alternateRoot, expectedIdentity))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

      const afterRuntime = await runtimeStatus(dataRoot);
      const afterRegistry = await readConnectorRegistry(dataRoot);
      expect(afterRuntime.state).toBe('running');
      expect(afterRuntime.endpoint?.instanceId).toBe(beforeRuntime.endpoint.instanceId);
      expect(afterRuntime.endpoint?.pid).toBe(beforeRuntime.endpoint.pid);
      expect((await supervisor.workloadBinding()).sourceRoot).toBe(sourceRoot);
      expect(afterRegistry?.deploymentEpoch).toBe(beforeRegistry.deploymentEpoch);
    } finally {
      await supervisor.down().catch(() => undefined);
    }
  }, 60_000);

  it('rejects a candidate that changes after catalog preflight but before cutover while preserving the baseline', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-source-race-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-source-race-fake-'));
    roots.push(dataRoot, fakeRoot);
    const alternateRoot = await alternateCatalogSource(fakeRoot);
    await initializeActivationIdentityRepo(alternateRoot);
    const expectedIdentity = await inspectActivationSourceIdentity(alternateRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: await freePort(),
      proHealthPort: await freePort(),
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot,
      tunnelClientPath: fakeTunnel,
      webPort: await freePort(),
      adminPort: await freePort(),
    });

    try {
      const baseline = await supervisor.up();
      expect(baseline.localRuntime.state).toBe('READY');
      const beforeRuntime = await runtimeStatus(dataRoot);
      const beforeRegistry = await readConnectorRegistry(dataRoot);
      if (beforeRuntime.state !== 'running' || beforeRuntime.endpoint === null || beforeRegistry === null) {
        throw new Error('baseline runtime or connector registry is not ready');
      }

      const mutable = supervisor as unknown as {
        probeTargetCatalogManifest(sourceRoot: string): Promise<unknown>;
      };
      const originalProbe = mutable.probeTargetCatalogManifest.bind(supervisor);
      mutable.probeTargetCatalogManifest = async (candidateRoot: string): Promise<unknown> => {
        const manifest = await originalProbe(candidateRoot);
        const catalogPath = path.join(candidateRoot, 'apps', 'runtime', 'src', 'mcp-catalog.ts');
        await writeFile(catalogPath, (await readFile(catalogPath, 'utf8')) + '\n// R4 mutation after successful preflight\n');
        return manifest;
      };

      await expect(supervisor.replaceWorkloadSourceRoot(alternateRoot, expectedIdentity))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

      const afterRuntime = await runtimeStatus(dataRoot);
      const afterRegistry = await readConnectorRegistry(dataRoot);
      expect(afterRuntime.state).toBe('running');
      expect(afterRuntime.endpoint?.instanceId).toBe(beforeRuntime.endpoint.instanceId);
      expect(afterRuntime.endpoint?.pid).toBe(beforeRuntime.endpoint.pid);
      expect((await supervisor.workloadBinding()).sourceRoot).toBe(sourceRoot);
      expect(afterRegistry?.deploymentEpoch).toBe(beforeRegistry.deploymentEpoch);
    } finally {
      await supervisor.down().catch(() => undefined);
    }
  }, 60_000);

  it('rejects source drift after cutover begins and restores the baseline explicitly', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-launch-attestation-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-launch-attestation-fake-'));
    roots.push(dataRoot, fakeRoot);
    const alternateRoot = await alternateCatalogSource(fakeRoot);
    await initializeActivationIdentityRepo(alternateRoot);
    const expectedIdentity = await inspectActivationSourceIdentity(alternateRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: await freePort(),
      proHealthPort: await freePort(),
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot,
      tunnelClientPath: fakeTunnel,
      webPort: await freePort(),
      adminPort: await freePort(),
    });

    try {
      const baseline = await supervisor.up();
      expect(baseline.localRuntime.state).toBe('READY');
      const beforeRuntime = await runtimeStatus(dataRoot);
      if (beforeRuntime.state !== 'running' || beforeRuntime.endpoint === null) throw new Error('baseline runtime is not ready');

      const mutable = supervisor as unknown as { stopTunnel(record: unknown): Promise<void> };
      const originalStopTunnel = mutable.stopTunnel.bind(supervisor);
      let sourceDriftInjected = false;
      mutable.stopTunnel = async (record: unknown): Promise<void> => {
        if (!sourceDriftInjected) {
          sourceDriftInjected = true;
          const catalogPath = path.join(alternateRoot, 'apps', 'runtime', 'src', 'mcp-catalog.ts');
          await writeFile(catalogPath, (await readFile(catalogPath, 'utf8')) + '\n// R5 source drift after final pre-cutover check\n');
        }
        await originalStopTunnel(record);
      };

      await expect(supervisor.replaceWorkloadSourceRoot(alternateRoot, expectedIdentity))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

      expect(sourceDriftInjected).toBe(true);
      expect((await runtimeStatus(dataRoot)).state).toBe('stopped');
      expect((await supervisor.workloadBinding()).sourceRoot).toBe(alternateRoot);

      const restored = await supervisor.replaceWorkloadSourceRoot(sourceRoot);
      expect(restored.localRuntime.state).toBe('READY');
      expect(restored.tunnel.state).toBe('READY');
      expect(restored.controlPlane.state).toBe('READY');
      expect((await supervisor.workloadBinding()).sourceRoot).toBe(sourceRoot);
      const afterRuntime = await runtimeStatus(dataRoot);
      expect(afterRuntime.state).toBe('running');
      expect(afterRuntime.endpoint?.instanceId).not.toBe(beforeRuntime.endpoint.instanceId);
    } finally {
      await supervisor.down().catch(() => undefined);
    }
  }, 60_000);

  it('forces an identity-bound same-source activation to replace the workload and advance deployment epoch', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-same-source-activation-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-same-source-activation-fake-'));
    roots.push(dataRoot, fakeRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: await freePort(),
      proHealthPort: await freePort(),
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot,
      tunnelClientPath: fakeTunnel,
      webPort: await freePort(),
      adminPort: await freePort(),
    });

    try {
      const baseline = await supervisor.up();
      expect(baseline.localRuntime.state).toBe('READY');
      const beforeRuntime = await runtimeStatus(dataRoot);
      const beforeRegistry = await readConnectorRegistry(dataRoot);
      if (beforeRuntime.state !== 'running' || beforeRuntime.endpoint === null || beforeRegistry === null) {
        throw new Error('same-source baseline is not ready');
      }

      const expectedIdentity = await inspectActivationSourceIdentity(sourceRoot);
      const activated = await supervisor.replaceWorkloadSourceRoot(sourceRoot, expectedIdentity);
      expect(activated.localRuntime.state).toBe('READY');
      expect(activated.tunnel.state).toBe('READY');
      expect(activated.controlPlane.state).toBe('READY');
      expect((await supervisor.workloadBinding()).sourceRoot).toBe(sourceRoot);

      const afterRuntime = await runtimeStatus(dataRoot);
      const afterRegistry = await readConnectorRegistry(dataRoot);
      expect(afterRuntime.state).toBe('running');
      expect(afterRuntime.endpoint?.instanceId).not.toBe(beforeRuntime.endpoint.instanceId);
      expect(afterRuntime.endpoint?.pid).not.toBe(beforeRuntime.endpoint.pid);
      expect(afterRegistry?.deploymentEpoch).toBe(beforeRegistry.deploymentEpoch + 1);
    } finally {
      await supervisor.down().catch(() => undefined);
    }
  }, 60_000);

  it('derives the target PRO manifest hash from the authoritative candidate catalog version', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-version-bound-probe-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-version-bound-probe-fake-'));
    roots.push(dataRoot, fakeRoot);
    const candidateRoot = await alternateCatalogSource(fakeRoot);
    const candidateCatalogPath = path.join(candidateRoot, 'apps', 'runtime', 'src', 'mcp-catalog.ts');
    const candidateCatalog = await readFile(candidateCatalogPath, 'utf8');
    const currentVersion = "export const MCP_CATALOG_VERSION = '2.4.0' as const;";
    if (!candidateCatalog.includes(currentVersion)) throw new Error('candidate catalog version marker not found');
    await writeFile(candidateCatalogPath, candidateCatalog.replace(
      currentVersion,
      "export const MCP_CATALOG_VERSION = '2.3.0' as const;",
    ));

    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: await freePort(),
      proHealthPort: await freePort(),
    });
    await bindConnectorRuntime(dataRoot, await loadOrCreateRuntimeId(dataRoot));
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const baseline = await startDaemon({ dataRoot, preferredPort: 0 });
    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot,
      webPort: await freePort(),
      adminPort: await freePort(),
    });
    const probe = supervisor as unknown as {
      probeTargetCatalogManifest(sourceRoot: string): Promise<{
        readonly full: { readonly expectedToolNames: readonly string[]; readonly catalogHash: string };
        readonly pro: { readonly expectedToolNames: readonly string[]; readonly catalogHash: string };
      }>;
    };

    try {
      const manifest = await probe.probeTargetCatalogManifest(candidateRoot);
      const expectedV23 = catalogIdentityAtVersion('PRO', proMcpToolDefinitions(), '2.3.0');
      const currentV24 = catalogIdentityAtVersion('PRO', proMcpToolDefinitions(), '2.4.0');

      expect(manifest.pro.expectedToolNames).toEqual([
        'list_projects', 'project_info', 'git_status', 'file_read', 'search',
      ]);
      expect(manifest.pro.catalogHash).toBe(expectedV23.catalogHash);
      expect(manifest.pro.catalogHash).not.toBe(currentV24.catalogHash);
      expect(manifest.full.catalogHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await baseline.close();
    }
  }, 60_000);

  it('rejects a target that changes a PRO input schema while preserving the same five tool names', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-pro-schema-drift-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-pro-schema-drift-fake-'));
    roots.push(dataRoot, fakeRoot);
    const candidateRoot = await alternateCatalogSource(fakeRoot);
    const mcpPath = path.join(candidateRoot, 'apps', 'runtime', 'src', 'mcp.ts');
    const mcp = await readFile(mcpPath, 'utf8');
    const marker = "search: { name: 'search', description: 'Search text in an explicitly selected registered project.', inputSchema: { type: 'object', required: ['projectId', 'query'], properties: { ...projectId, query: { type: 'string', minLength: 1, maxLength: 500 } }, additionalProperties: false } },";
    if (!mcp.includes(marker)) throw new Error('candidate PRO schema marker not found');
    await writeFile(mcpPath, mcp.replace(marker, marker.replace('maxLength: 500', 'maxLength: 499')));

    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: await freePort(),
      proHealthPort: await freePort(),
    });
    await bindConnectorRuntime(dataRoot, await loadOrCreateRuntimeId(dataRoot));
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const baseline = await startDaemon({ dataRoot, preferredPort: 0 });
    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot,
      webPort: await freePort(),
      adminPort: await freePort(),
    });
    const probe = supervisor as unknown as {
      probeTargetCatalogManifest(sourceRoot: string): Promise<unknown>;
    };

    try {
      await expect(probe.probeTargetCatalogManifest(candidateRoot))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    } finally {
      await baseline.close();
    }
  }, 60_000);

  it('hands off an intentional FULL catalog transition A -> B -> A while preserving workload ownership', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-cross-catalog-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-cross-catalog-fake-'));
    roots.push(dataRoot, fakeRoot);
    const alternateRoot = await alternateCatalogSource(fakeRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: 50_807,
      proHealthPort: 50_808,
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({
      dataRoot,
      sourceRoot,
      tunnelClientPath: fakeTunnel,
      webPort: await freePort(),
      adminPort: await freePort(),
    });

    const ownership = (registry: NonNullable<Awaited<ReturnType<typeof readConnectorRegistry>>>) => registry.connectors.map((connector) => ({
      tunnelId: connector.tunnelId,
      machineId: connector.machineId,
      runtimeId: connector.runtimeId,
      leaseGeneration: connector.leaseGeneration,
    }));

    try {
      const initial = await supervisor.up();
      expect(initial.localRuntime.state).toBe('READY');
      expect(initial.tunnel.state).toBe('READY');
      expect(initial.controlPlane.state).toBe('READY');
      const before = await readConnectorRegistry(dataRoot);
      if (before === null) throw new Error('missing baseline connector registry');
      const beforeFull = before.connectors.find((connector) => connector.mode === 'FULL');
      const beforePro = before.connectors.find((connector) => connector.mode === 'PRO');
      if (beforeFull === undefined || beforePro === undefined) throw new Error('missing baseline catalog bindings');
      const beforeOwnership = ownership(before);

      const switched = await supervisor.replaceWorkloadSourceRoot(alternateRoot);
      expect(switched.localRuntime).toMatchObject({ state: 'DEGRADED', code: 'CATALOG_IDENTITY_UNVERIFIED' });
      expect(switched.tunnel.state).toBe('READY');
      expect(switched.controlPlane.state).toBe('READY');
      expect((await supervisor.workloadBinding()).sourceRoot).toBe(alternateRoot);
      expect(await supervisor.catalogStatus()).toMatchObject({
        state: 'UNKNOWN',
        sourceMode: 'BOUND_WORKLOAD_COMPATIBILITY',
        recommendedAction: 'USE_CONTROLLED_ACTIVATION_BEFORE_CATALOG_RELOAD',
      });
      const afterB = await readConnectorRegistry(dataRoot);
      if (afterB === null) throw new Error('missing alternate connector registry');
      const afterBFull = afterB.connectors.find((connector) => connector.mode === 'FULL');
      const afterBPro = afterB.connectors.find((connector) => connector.mode === 'PRO');
      if (afterBFull === undefined || afterBPro === undefined) throw new Error('missing alternate catalog bindings');
      expect(afterB.deploymentEpoch).toBe(before.deploymentEpoch + 1);
      expect(afterBFull.expectedToolNames).toContain('synthetic_phase5_tool');
      expect(afterBFull.catalogHash).not.toBe(beforeFull.catalogHash);
      expect(afterBPro.expectedToolNames).toEqual(beforePro.expectedToolNames);
      expect(afterBPro.catalogHash).toBe(beforePro.catalogHash);
      expect(ownership(afterB)).toEqual(beforeOwnership);

      const restored = await supervisor.replaceWorkloadSourceRoot(sourceRoot);
      expect(restored.localRuntime.state).toBe('READY');
      expect(restored.tunnel.state).toBe('READY');
      expect(restored.controlPlane.state).toBe('READY');
      expect((await supervisor.workloadBinding()).sourceRoot).toBe(sourceRoot);
      expect((await supervisor.catalogStatus()).state).toBe('ACTIVE');
      const afterA = await readConnectorRegistry(dataRoot);
      if (afterA === null) throw new Error('missing restored connector registry');
      const afterAFull = afterA.connectors.find((connector) => connector.mode === 'FULL');
      const afterAPro = afterA.connectors.find((connector) => connector.mode === 'PRO');
      if (afterAFull === undefined || afterAPro === undefined) throw new Error('missing restored catalog bindings');
      expect(afterA.deploymentEpoch).toBe(afterB.deploymentEpoch + 1);
      expect(afterAFull.expectedToolNames).toEqual(beforeFull.expectedToolNames);
      expect(afterAFull.catalogHash).toBe(beforeFull.catalogHash);
      expect(afterAPro.expectedToolNames).toEqual(beforePro.expectedToolNames);
      expect(afterAPro.catalogHash).toBe(beforePro.catalogHash);
      expect(ownership(afterA)).toEqual(beforeOwnership);
    } finally {
      await supervisor.down().catch(() => undefined);
    }
  }, 60_000);

  it('keeps the outer control plane alive during a concurrent cross-catalog handoff', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-dual-handoff-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-dual-handoff-fake-'));
    roots.push(dataRoot, fakeRoot);
    const alternateRoot = await alternateCatalogSource(fakeRoot);
    await initializeConnectorRegistry(dataRoot, {
      fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fullHealthPort: await freePort(),
      proHealthPort: await freePort(),
    });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const options = {
      dataRoot,
      sourceRoot,
      protectedReferenceRoot: sourceRoot,
      tunnelClientPath: fakeTunnel,
      webPort: await freePort(),
      adminPort: await freePort(),
      supervisorControlPort: await freePort(),
      adminTunnelHealthPort: await freePort(),
    };
    const outer = await createSupervisor(options);
    const activator = await createSupervisor(options);
    await outer.bindAdminTunnel('tunnel_cccccccccccccccccccccccccccccccc');
    const native = await startSupervisorNativeControlServer(dataRoot, options.supervisorControlPort, {
      supervisorStatus: () => outer.supervisorNativeStatus(),
      adminStatus: () => outer.adminNativeStatus(),
      adminRecycle: (input) => outer.adminRecycle(input),
      adminToolCall: (name, args) => outer.adminToolCall(name, args),
    });
    (outer as unknown as { nativeControlActive: boolean }).nativeControlActive = true;

    try {
      const baseline = await outer.up();
      expect(baseline.localRuntime.state).toBe('READY');
      expect(baseline.tunnel.state).toBe('READY');
      expect(baseline.controlPlane.state).toBe('READY');

      const switching = activator.replaceWorkloadSourceRoot(alternateRoot);
      const lockPath = path.join(dataRoot, 'supervisor', 'operation.lock');
      let observedOperation: string | null = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const content = await readFile(lockPath, 'utf8').catch(() => null);
        if (content !== null) {
          try {
            const parsed = JSON.parse(content) as { readonly operation?: unknown };
            if (parsed.operation === 'replace-workload-source') {
              observedOperation = parsed.operation;
              break;
            }
          } catch {
            // The writer may still be publishing the bounded lock record.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedOperation).toBe('replace-workload-source');

      await expect((outer as unknown as {
        automaticRecoveryTick(): Promise<void>;
      }).automaticRecoveryTick()).resolves.toBeUndefined();

      const switched = await switching;
      expect(switched.localRuntime).toMatchObject({ state: 'DEGRADED', code: 'CATALOG_IDENTITY_UNVERIFIED' });
      expect(switched.tunnel.state).toBe('READY');
      expect(switched.controlPlane.state).toBe('READY');
      expect((await activator.workloadBinding()).sourceRoot).toBe(alternateRoot);
      expect(await activator.catalogStatus()).toMatchObject({
        state: 'UNKNOWN',
        sourceMode: 'BOUND_WORKLOAD_COMPATIBILITY',
        recommendedAction: 'USE_CONTROLLED_ACTIVATION_BEFORE_CATALOG_RELOAD',
      });
      const outerStatus = await outer.supervisorNativeStatus();
      expect(outerStatus.readiness).toBe('READY');
      expect(outerStatus.workloadCatalogId).toBe(
        (await readConnectorRegistry(dataRoot))?.connectors.find((connector) => connector.mode === 'FULL')?.catalogHash,
      );
    } finally {
      (outer as unknown as { nativeControlActive: boolean }).nativeControlActive = false;
      await outer.down().catch(() => undefined);
      await native.close();
    }
  }, 60_000);

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
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort, adminPort: await freePort() });
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
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort: await freePort(), adminPort: await freePort() });
    await supervisor.up();
    const supervisorStatePath = path.join(dataRoot, 'supervisor', 'state.json');
    const beforeSupervisorState = JSON.parse(await readFile(supervisorStatePath, 'utf8')) as { readonly admin: { readonly pid: number } | null };
    expect(beforeSupervisorState.admin).not.toBeNull();
    const before = await runtimeStatus(dataRoot);
    if (before.endpoint === null) throw new Error('missing runtime before crash');
    process.kill(before.endpoint.pid, 'SIGKILL');
    await waitForProcessGone(before.endpoint.pid);

    await (supervisor as unknown as { monitorOnceUnlocked(): Promise<void> }).monitorOnceUnlocked();
    const after = await runtimeStatus(dataRoot);
    if (after.endpoint === null || after.state !== 'running') throw new Error('runtime did not recover');
    expect(after.endpoint.pid).not.toBe(before.endpoint.pid);
    expect(after.endpoint.instanceId).not.toBe(before.endpoint.instanceId);
    const afterSupervisorState = JSON.parse(await readFile(supervisorStatePath, 'utf8')) as typeof beforeSupervisorState;
    expect(afterSupervisorState.admin?.pid).toBe(beforeSupervisorState.admin?.pid);
    const status = await supervisor.status();
    expect(status.localRuntime).toMatchObject({ state: 'READY', code: 'READY' });
    expect(status.tunnel).toMatchObject({ state: 'READY', code: 'READY' });
    expect(status.controlPlane).toMatchObject({ state: 'READY', code: 'READY' });
    await supervisor.down();
  }, 30_000);

  it('allows only the verified admin child to self-probe readiness', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-admin-self-probe-'));
    roots.push(dataRoot);
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const secret = await readTunnelServiceSecret(dataRoot);
    if (secret === null) throw new Error('missing admin self-probe test secret');
    const adminPort = await freePort();
    const { createServer } = await import('node:http');
    const server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${secret}` || request.url !== '/healthz') {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, owner: 'PERSISTENT_SUPERVISOR_OR_CONTROL_PLANE' }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(adminPort, '127.0.0.1', () => resolve());
    });
    try {
      const supervisor = await createSupervisor({ dataRoot, sourceRoot, adminPort });
      const selfRecord = {
        component: 'admin',
        pid: process.pid,
        startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        executable: process.execPath,
        profilePath: null,
        tunnelId: null,
        marker: path.basename(process.execPath),
      };
      const internals = supervisor as unknown as {
        probeAdmin(record: unknown): Promise<{ readonly state: string; readonly code: string }>;
        probeWeb(record: unknown): Promise<{ readonly state: string; readonly code: string }>;
      };
      await expect(internals.probeAdmin(selfRecord)).resolves.toMatchObject({ state: 'READY', code: 'READY' });
      await expect(internals.probeWeb({ ...selfRecord, component: 'web' })).resolves.toMatchObject({
        state: 'FAILED', code: 'PROCESS_OWNERSHIP_AMBIGUOUS',
      });
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('does not kill a PID reused by a foreign process', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-foreign-'));
    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-foreign-fake-'));
    roots.push(dataRoot, fakeRoot);
    await initializeConnectorRegistry(dataRoot, { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fullHealthPort: 50_831, proHealthPort: 50_832 });
    await persistControlPlaneApiKey(dataRoot, 'control-plane-credential-for-test-only-12345');
    await loadOrCreateTunnelServiceSecret(dataRoot);
    const fakeTunnel = await fakeTunnelClient(fakeRoot);
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort: await freePort(), adminPort: await freePort() });
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
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort: await freePort(), adminPort: await freePort() });
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
    const supervisor = await createSupervisor({ dataRoot, sourceRoot, tunnelClientPath: fakeTunnel, webPort: await freePort(), adminPort: await freePort() });
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

  it('keeps automatic recovery alive while another supervisor operation owns the lock', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-monitor-contention-'));
    roots.push(dataRoot);
    await mkdir(path.join(dataRoot, 'supervisor'), { recursive: true, mode: 0o700 });
    const holder = await createSupervisor({ dataRoot, sourceRoot });
    const monitor = await createSupervisor({ dataRoot, sourceRoot });
    let releaseHold: (() => void) | undefined;
    const hold = (holder as unknown as {
      withOperationLock<T>(operation: string, work: () => Promise<T>): Promise<T>;
    }).withOperationLock('replace-workload-source', async () => {
      await new Promise<void>((resolve) => { releaseHold = resolve; });
    });
    for (let attempt = 0; attempt < 100 && releaseHold === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (releaseHold === undefined) throw new Error('operation lock holder did not start');

    try {
      await expect((monitor as unknown as {
        automaticRecoveryTick(): Promise<void>;
      }).automaticRecoveryTick()).resolves.toBeUndefined();
    } finally {
      releaseHold();
      await hold;
    }
  });

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

async function alternateCatalogSource(fakeRoot: string): Promise<string> {
  const alternateRoot = path.join(fakeRoot, 'alternate-source');
  const alternateRuntime = path.join(alternateRoot, 'apps', 'runtime');
  await mkdir(alternateRuntime, { recursive: true });
  await cp(path.join(sourceRoot, 'apps', 'runtime', 'src'), path.join(alternateRuntime, 'src'), { recursive: true });
  await cp(path.join(sourceRoot, 'apps', 'runtime', 'package.json'), path.join(alternateRuntime, 'package.json'));
  await cp(path.join(sourceRoot, 'apps', 'runtime', 'macos-safety-helper.py'), path.join(alternateRuntime, 'macos-safety-helper.py'));

  const runtimeNodeModules = path.join(alternateRuntime, 'node_modules');
  const tsxSource = await realpath(path.join(sourceRoot, 'apps', 'runtime', 'node_modules', 'tsx'));
  await mkdir(runtimeNodeModules, { recursive: true });
  await cp(tsxSource, path.join(runtimeNodeModules, 'tsx'), { recursive: true });
  const esbuildSource = await realpath(path.join(path.dirname(tsxSource), 'esbuild'));
  await cp(esbuildSource, path.join(runtimeNodeModules, 'esbuild'), { recursive: true });
  const esbuildPlatformPackage = process.arch === 'arm64' ? '@esbuild/darwin-arm64' : '@esbuild/darwin-x64';
  const esbuildPlatformSource = await realpath(path.join(path.dirname(esbuildSource), ...esbuildPlatformPackage.split('/')));
  const esbuildPlatformDestination = path.join(runtimeNodeModules, ...esbuildPlatformPackage.split('/'));
  await mkdir(path.dirname(esbuildPlatformDestination), { recursive: true });
  await cp(esbuildPlatformSource, esbuildPlatformDestination, { recursive: true });

  const domainRoot = path.join(alternateRoot, 'packages', 'domain');
  await mkdir(path.dirname(domainRoot), { recursive: true });
  await cp(path.join(sourceRoot, 'packages', 'domain'), domainRoot, { recursive: true });
  const runtimeScope = path.join(runtimeNodeModules, '@iris');
  await mkdir(runtimeScope, { recursive: true });
  await symlink(domainRoot, path.join(runtimeScope, 'domain'), 'dir');

  const alternateWeb = path.join(alternateRoot, 'apps', 'web');
  const viteBin = path.join(alternateWeb, 'node_modules', '.bin');
  await mkdir(viteBin, { recursive: true });
  await cp(path.join(sourceRoot, 'apps', 'web', 'package.json'), path.join(alternateWeb, 'package.json'));
  const fakeVite = path.join(alternateWeb, 'fake-vite.cjs');
  await writeFile(fakeVite, `#!/usr/bin/env node
const { createServer } = require('node:http');
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = Number(portIndex >= 0 ? args[portIndex + 1] : '5173');
const server = createServer((_request, response) => {
  response.statusCode = 200;
  response.end('IRIS test web');
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  await chmod(fakeVite, 0o700);
  await symlink(path.relative(viteBin, fakeVite), path.join(viteBin, 'vite'));
  for (const packageName of ['vite', '@vitejs/plugin-react', 'react', 'react-dom']) {
    const packageRoot = path.join(alternateWeb, 'node_modules', ...packageName.split('/'));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: packageName }) + '\n');
  }

  const catalogPath = path.join(alternateRuntime, 'src', 'mcp-catalog.ts');
  const catalog = await readFile(catalogPath, 'utf8');
  const catalogMarker = "  entry('catalog_identity', 'READ_ONLY', null, '2.3.0'),";
  if (!catalog.includes(catalogMarker)) throw new Error('alternate catalog fixture marker not found');
  await writeFile(catalogPath, catalog.replace(
    catalogMarker,
    "  entry('synthetic_phase5_tool', 'READ_ONLY', null, 'test-cross-catalog'),\n" + catalogMarker,
  ));

  const v21Path = path.join(alternateRuntime, 'src', 'mcp-v21.ts');
  let v21 = await readFile(v21Path, 'utf8');
  const definitionsMarker = "export function fullMcpToolDefinitionsV21(): readonly Record<string, unknown>[] {\n  return augmentV21ToolDefinitions(fullMcpToolDefinitions()).filter(isRecord);\n}";
  if (!v21.includes(definitionsMarker)) throw new Error('alternate definition fixture marker not found');
  v21 = v21.replace(definitionsMarker, "export function fullMcpToolDefinitionsV21(): readonly Record<string, unknown>[] {\n  return withSyntheticTestTool(augmentV21ToolDefinitions(fullMcpToolDefinitions()).filter(isRecord));\n}");
  const listMarker = "    ...payload,\n    result: { ...payload.result, tools: augmentV21ToolDefinitions(payload.result.tools) },\n  });";
  if (!v21.includes(listMarker)) throw new Error('alternate tool-list fixture marker not found');
  v21 = v21.replace(listMarker, "    ...payload,\n    result: { ...payload.result, tools: withSyntheticTestTool(augmentV21ToolDefinitions(payload.result.tools).filter(isRecord)) },\n  });");
  const helperMarker = "function jsonRpcResult(id: string | number | null, result: unknown): Response {";
  if (!v21.includes(helperMarker)) throw new Error('alternate helper fixture marker not found');
  v21 = v21.replace(helperMarker, `function withSyntheticTestTool(definitions: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {\n  const synthetic = {\n    name: 'synthetic_phase5_tool',\n    description: 'Synthetic cross-catalog transition test tool.',\n    inputSchema: { type: 'object', properties: {}, additionalProperties: false },\n  };\n  const index = definitions.findIndex((definition) => definition.name === 'catalog_identity');\n  return index < 0 ? [...definitions, synthetic] : [...definitions.slice(0, index), synthetic, ...definitions.slice(index)];\n}\n\n${helperMarker}`);
  await writeFile(v21Path, v21);
  return await realpath(alternateRoot);
}

async function initializeActivationIdentityRepo(root: string): Promise<void> {
  const run = promisify(execFile);
  await writeFile(path.join(root, '.gitignore'), 'apps/runtime/node_modules/\napps/web/node_modules/\npackages/domain/node_modules/\n');
  await run('git', ['init', '-b', 'r4-fixture'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  await run('git', ['add', '--', '.gitignore', 'apps/runtime/src', 'apps/runtime/package.json', 'apps/runtime/macos-safety-helper.py', 'apps/web/package.json', 'apps/web/fake-vite.cjs', 'packages/domain'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  await run('git', [
    '-c', 'user.name=IRIS Test',
    '-c', 'user.email=iris-test@example.invalid',
    'commit', '-m', 'R4 source identity fixture',
  ], { cwd: root, encoding: 'utf8', timeout: 10_000 });
}

async function nativeToolCall(url: string, secret: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      'Mcp-Name': name,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as unknown;
  if (!isRecord(body) || !isRecord(body.result) || body.result.isError === true || !isRecord(body.result.structuredContent)) {
    throw new Error(`native supervisor tool ${name} failed`);
  }
  return body.result.structuredContent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
if (process.argv[2] === 'run' && process.argv.some((arg) => arg.endsWith('/iris-admin.yaml')) && !process.argv.includes('--embedded-mcp-stub')) { process.stderr.write('main channel is required\\n'); process.exit(1); }
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
