import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { buildChildEnvironment, inspectAcceptanceEnvironment, parseAcceptanceArgs, verifyAcceptanceTunnelStartup, verifyGeneratedPortBindings } from './iris-acceptance.mjs';

const roots = [];
const sourceRoot = path.resolve(import.meta.dirname, '..');
const TEST_PORTS = {
  runtime: 46_110,
  supervisorAdmin: 46_111,
  supervisorControl: 46_112,
  supervisorTunnelHealth: 46_113,
  fullTunnelHealth: 46_114,
  proTunnelHealth: 46_115,
  web: 46_116,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('acceptance isolation preflight', () => {
  it('accepts one complete isolated port set and rejects partial or protected sets', async () => {
    const spec = Object.entries(TEST_PORTS).map(([name, port]) => `${name}=${port}`).join(',');
    assert.deepEqual(parseAcceptanceArgs(['--runtime-data-root', '/tmp/root', '--protected-root', '/tmp/live', '--ports', spec, '--', 'status']).ports, TEST_PORTS);
    assert.throws(() => parseAcceptanceArgs(['--runtime-data-root', '/tmp/root', '--protected-root', '/tmp/live', '--ports', 'runtime=46110', '--', 'status']), (error) => error.code === 'ACCEPTANCE_PORTS_INVALID');
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions('/tmp/root', ['status']), ports: { ...TEST_PORTS, web: 5173 } }), (error) => error.code === 'ACCEPTANCE_PORT_PROTECTED');
  });

  it('requires explicit ports for every acceptance command', async () => {
    const root = await fixtureRoot();
    const options = baseOptions(root, ['status']);
    delete options.ports;
    await assert.rejects(inspectAcceptanceEnvironment(options), (error) => error.code === 'ACCEPTANCE_PORTS_REQUIRED');
    const preflight = baseOptions(root, ['preflight']);
    delete preflight.ports;
    await assert.rejects(inspectAcceptanceEnvironment(preflight), (error) => error.code === 'ACCEPTANCE_PORTS_REQUIRED');
  });

  it('propagates isolated ports to acceptance child processes', () => {
    const child = buildChildEnvironment('/private/tmp/acceptance', {}, TEST_PORTS);
    assert.equal(child.IRIS_RUNTIME_PORT, String(TEST_PORTS.runtime));
    assert.equal(child.IRIS_SUPERVISOR_ADMIN_PORT, String(TEST_PORTS.supervisorAdmin));
    assert.equal(child.IRIS_SUPERVISOR_CONTROL_PORT, String(TEST_PORTS.supervisorControl));
    assert.equal(child.IRIS_WEB_PORT, String(TEST_PORTS.web));
  });

  it('rejects generated registry and profile port mismatches', async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, 'tunnel-profiles'), { mode: 0o700 });
    await writeFile(path.join(root, 'connector-registry.json'), JSON.stringify({ connectors: [{ connectorId: 'iris-full', healthPort: 43113 }], admin: null }));
    await assert.rejects(verifyGeneratedPortBindings(root, TEST_PORTS), (error) => error.code === 'ACCEPTANCE_PORT_BINDING_MISMATCH');
    const profileRoot = await fixtureRoot();
    await mkdir(path.join(profileRoot, 'tunnel-profiles'), { mode: 0o700 });
    await writeFile(path.join(profileRoot, 'tunnel-profiles', 'iris-full.yaml'), 'listen_addr: 127.0.0.1:46114\nurl: http://127.0.0.1:43110/mcp\n');
    await assert.rejects(verifyGeneratedPortBindings(profileRoot, TEST_PORTS), (error) => error.code === 'ACCEPTANCE_PORT_BINDING_MISMATCH');
  });

  it('requires an explicit root and never resolves the default root', () => {
    assert.throws(() => parseAcceptanceArgs(['--protected-root', '/tmp/live', '--', 'status']), (error) => error.code === 'ACCEPTANCE_USAGE');
  });

  it('requires the explicit preflight before a command can create guard state', async () => {
    const root = await fixtureRoot();
    await assert.rejects(inspectAcceptanceEnvironment(baseOptions(root, ['status'])), (error) => error.code === 'ACCEPTANCE_PREFLIGHT_REQUIRED');
    assert.deepEqual(await readdir(root), []);
  });

  it('binds every command to one explicit session root', async () => {
    const root = await fixtureRoot();
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    const options = baseOptions(root, ['status']);
    const report = await inspectAcceptanceEnvironment(options);
    assert.equal(report.dataRoot, await realpath(root));
    assert.equal((await readFile(path.join(root, '.iris-acceptance-identity.json'), 'utf8')).includes('"head"'), true);
  });

  it('persists and rechecks the physical acceptance root identity', async () => {
    const root = await fixtureRoot();
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    const marker = JSON.parse(await readFile(path.join(root, '.iris-acceptance-identity.json'), 'utf8'));
    assert.equal(marker.rootIdentity.canonicalPath, await realpath(root));
    assert.equal(typeof marker.rootIdentity.device, 'number');
    assert.equal(typeof marker.rootIdentity.inode, 'number');
    assert.equal(typeof marker.rootIdentity.ownerUid, 'number');
    assert.equal(marker.rootIdentity.mode, 0o700);
    const repeated = await inspectAcceptanceEnvironment(baseOptions(root, ['status']));
    assert.deepEqual(repeated.rootIdentity, marker.rootIdentity);
  });

  it('blocks replacement, symlink substitution and unsafe permissions', async () => {
    const replacementRoot = await fixtureRoot();
    const root = await fixtureRoot();
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    const marker = await readFile(path.join(root, '.iris-acceptance-identity.json'));
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o700);
    await writeFile(path.join(root, '.iris-acceptance-identity.json'), marker, { mode: 0o600 });
    await assert.rejects(inspectAcceptanceEnvironment(baseOptions(root, ['status'])), (error) => error.code === 'ACCEPTANCE_IDENTITY_CHANGED');

    const symlinkRoot = await fixtureRoot();
    const target = await fixtureRoot();
    await inspectAcceptanceEnvironment(baseOptions(symlinkRoot, ['preflight']));
    await rm(symlinkRoot, { recursive: true, force: true });
    await symlink(target, symlinkRoot);
    await assert.rejects(inspectAcceptanceEnvironment(baseOptions(symlinkRoot, ['status'])), (error) => error.code === 'ACCEPTANCE_ROOT_INVALID');

    await inspectAcceptanceEnvironment(baseOptions(replacementRoot, ['preflight']));
    await chmod(replacementRoot, 0o755);
    await assert.rejects(inspectAcceptanceEnvironment(baseOptions(replacementRoot, ['status'])), (error) => error.code === 'ACCEPTANCE_ROOT_INVALID');
  });

  it('rejects switching roots inside one acceptance session', async () => {
    const root = await fixtureRoot();
    const other = await fixtureRoot();
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions(other, ['status']), environment: { IRIS_ACCEPTANCE_ROOT: root } }), (error) => error.code === 'ACCEPTANCE_ROOT_MISMATCH');
  });

  it('rejects protected and source-overlapping roots before mutation', async () => {
    const root = await fixtureRoot();
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions(root, ['status']), protectedRoots: [root] }), (error) => error.code === 'ACCEPTANCE_ROOT_PROTECTED');
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions(root, ['status']), sourceRoot: root, protectedRoots: ['/tmp/live'] }), (error) => error.code === 'ACCEPTANCE_ROOT_SOURCE_OVERLAP');
  });

  it('rejects an existing root without an acceptance identity', async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, 'unknown-state.json'), '{}');
    await assert.rejects(inspectAcceptanceEnvironment(baseOptions(root, ['status'])), (error) => error.code === 'ACCEPTANCE_ROOT_REUSED');
  });

  it('keeps two isolated roots independent', async () => {
    const first = await fixtureRoot();
    const second = await fixtureRoot();
    await inspectAcceptanceEnvironment(baseOptions(first, ['preflight']));
    await inspectAcceptanceEnvironment(baseOptions(second, ['preflight']));
    const firstReport = await inspectAcceptanceEnvironment(baseOptions(first, ['status']));
    const secondReport = await inspectAcceptanceEnvironment(baseOptions(second, ['status']));
    assert.notEqual(firstReport.dataRoot, secondReport.dataRoot);
    assert.notEqual((await readFile(path.join(first, '.iris-acceptance-identity.json'), 'utf8')), (await readFile(path.join(second, '.iris-acceptance-identity.json'), 'utf8')));
  });

  it('rejects a tunnel identity claimed by a protected fixture', async () => {
    const root = await fixtureRoot();
    const protectedRoot = await fixtureRoot();
    await writeFile(path.join(protectedRoot, 'connector-registry.json'), JSON.stringify({ connectors: [{ tunnelId: 'tunnel_0123456789abcdef0123456789abcdef' }], admin: null }));
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions(root, ['setup', '--tunnel-id', 'tunnel_0123456789abcdef0123456789abcdef']), protectedRoots: [protectedRoot] }), (error) => error.code === 'ACCEPTANCE_TUNNEL_CONFLICT');
  });

  it('distinguishes missing, valid, malformed and unreadable tunnel evidence', async () => {
    const root = await fixtureRoot();
    const protectedRoot = await fixtureRoot();
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    const command = ['setup', '--tunnel-id', 'tunnel_0123456789abcdef0123456789abcdef'];
    const missing = await inspectAcceptanceEnvironment({ ...baseOptions(root, command), protectedRoots: [protectedRoot] });
    assert.equal(missing.tunnelIdentity, 'UNVERIFIED');

    await writeFile(path.join(protectedRoot, 'connector-registry.json'), JSON.stringify({ connectors: [], admin: null }));
    const valid = await inspectAcceptanceEnvironment({ ...baseOptions(root, command), protectedRoots: [protectedRoot] });
    assert.equal(valid.tunnelIdentity, 'UNVERIFIED');

    await writeFile(path.join(protectedRoot, 'connector-registry.json'), '{malformed');
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions(root, command), protectedRoots: [protectedRoot] }), (error) => error.code === 'ACCEPTANCE_TUNNEL_EVIDENCE_INVALID');

    const protectedRegistry = path.join(await realpath(protectedRoot), 'connector-registry.json');
    for (const code of ['EACCES', 'EIO']) {
      await assert.rejects(inspectAcceptanceEnvironment({
        ...baseOptions(root, command),
        protectedRoots: [protectedRoot],
        readTextFile: async (filename, encoding) => {
          if (filename === protectedRegistry) throw Object.assign(new Error('fixture read failure'), { code });
          return readFile(filename, encoding);
        },
      }), (error) => error.code === 'ACCEPTANCE_TUNNEL_EVIDENCE_UNAVAILABLE');
    }
  });

  it('rejects a controlled port conflict without adopting the process', async () => {
    const root = await fixtureRoot();
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions(root, ['preflight']), probePort: async (port) => port === TEST_PORTS.runtime }), (error) => error.code === 'ACCEPTANCE_PORT_CONFLICT');
    assert.deepEqual(await readdir(root), []);
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions(root, ['up']), probePort: async (port) => port === TEST_PORTS.runtime }), (error) => error.code === 'ACCEPTANCE_PORT_CONFLICT');
  });

  it('blocks LaunchAgent install and uninstall for parallel acceptance', async () => {
    const root = await fixtureRoot();
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    await assert.rejects(inspectAcceptanceEnvironment(baseOptions(root, ['launchd', 'install'])), (error) => error.code === 'ACCEPTANCE_LAUNCHD_BLOCKED');
    await assert.rejects(inspectAcceptanceEnvironment(baseOptions(root, ['launchd', 'uninstall'])), (error) => error.code === 'ACCEPTANCE_LAUNCHD_BLOCKED');
  });

  it('propagates the explicit root and rejects unverified remote startup', async () => {
    const root = await fixtureRoot();
    const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions(root, ['up', '--tunnel-id', tunnelId]), probePort: async () => false }), (error) => error.code === 'ACCEPTANCE_TUNNEL_UNVERIFIED');
    const report = await inspectAcceptanceEnvironment({ ...baseOptions(root, ['status']), environment: { IRIS_ACCEPTANCE_ROOT: root } });
    assert.equal(report.dataRoot, await realpath(root));
  });

  it('authorizes remote startup before the Supervisor has a provider PID', async () => {
    const root = await fixtureRoot();
    const evidence = path.join(root, 'tunnel-evidence.json');
    const profilePath = path.join(root, 'tunnel-profiles', 'iris-full.yaml');
    const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
    const machineId = '11111111-1111-4111-8111-111111111111';
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    await mkdir(path.join(root, 'tunnel-profiles'), { mode: 0o700 });
    await mkdir(path.join(root, 'credentials'), { mode: 0o700 });
    await writeFile(profilePath, `control_plane:\n  tunnel_id: "${tunnelId}"\nhealth:\n  listen_addr: 127.0.0.1:${TEST_PORTS.fullTunnelHealth}\nmcp:\n  server_urls:\n    - url: http://127.0.0.1:${TEST_PORTS.runtime}/mcp\n`, { mode: 0o600 });
    await writeFile(path.join(root, 'credentials', 'control-plane-api-key'), 'fixture-key\n', { mode: 0o600 });
    await writeFile(evidence, `${JSON.stringify({
      schemaVersion: 2,
      phase: 'PREPARED',
      environment: 'non-production',
      provider: 'tunnel-client',
      machineId,
      sourceRoot,
      tunnelId,
      credentialPath: path.join(await realpath(root), 'credentials', 'control-plane-api-key'),
      binding: { connectorId: 'iris-full', machineId, tunnelId, profilePath },
    })}\n`, { mode: 0o600 });
    await writeFile(path.join(root, 'connector-registry.json'), JSON.stringify({ connectors: [{ connectorId: 'iris-full', label: 'IRIS', mode: 'FULL', runtime: 'iris-local-runtime', mcpProfile: 'FULL', mcpPath: '/mcp', healthPort: TEST_PORTS.fullTunnelHealth, managedProfilePath: profilePath, tunnelId, machineId }], admin: null }), { mode: 0o600 });
    const report = await inspectAcceptanceEnvironment({
      ...baseOptions(root, ['up', '--tunnel-id', tunnelId]),
      environment: { IRIS_ACCEPTANCE_ROOT: root, IRIS_ACCEPTANCE_TUNNEL_EVIDENCE: evidence },
      machineName: 'fixture-machine',
      probePort: async () => false,
    });
    assert.equal(report.tunnelIdentity, 'AUTHORIZED');
  });

  it('rejects startup authorization that chooses an unrelated profile path', async () => {
    const root = await fixtureRoot();
    const evidence = path.join(root, 'tunnel-evidence.json');
    const profilePath = path.join(root, 'tunnel-profiles', 'iris-full.yaml');
    const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
    const machineId = '11111111-1111-4111-8111-111111111111';
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    await mkdir(path.join(root, 'tunnel-profiles'), { mode: 0o700 });
    await mkdir(path.join(root, 'credentials'), { mode: 0o700 });
    await writeFile(profilePath, `control_plane:\n  tunnel_id: "${tunnelId}"\nhealth:\n  listen_addr: 127.0.0.1:${TEST_PORTS.fullTunnelHealth}\nmcp:\n  server_urls:\n    - url: http://127.0.0.1:${TEST_PORTS.runtime}/mcp\n`, { mode: 0o600 });
    await writeFile(path.join(root, 'credentials', 'control-plane-api-key'), 'fixture-key\n', { mode: 0o600 });
    await writeFile(path.join(root, 'connector-registry.json'), JSON.stringify({ connectors: [{ connectorId: 'iris-full', label: 'IRIS', mode: 'FULL', runtime: 'iris-local-runtime', mcpProfile: 'FULL', mcpPath: '/mcp', healthPort: TEST_PORTS.fullTunnelHealth, managedProfilePath: profilePath, tunnelId, machineId }], admin: null }), { mode: 0o600 });
    const baseEvidence = {
      schemaVersion: 2, phase: 'PREPARED', environment: 'non-production', provider: 'tunnel-client', machineId, sourceRoot,
      tunnelId, credentialPath: path.join(await realpath(root), 'credentials', 'control-plane-api-key'),
      binding: { connectorId: 'iris-full', machineId, tunnelId, profilePath },
    };
    await writeFile(evidence, `${JSON.stringify({ ...baseEvidence, binding: { ...baseEvidence.binding, profilePath: '/usr/bin/node' } })}\n`, { mode: 0o600 });
    const options = {
      ...baseOptions(root, ['up', '--tunnel-id', tunnelId]),
      environment: { IRIS_ACCEPTANCE_ROOT: root, IRIS_ACCEPTANCE_TUNNEL_EVIDENCE: evidence },
      machineName: 'fixture-machine',
      probePort: async () => false,
    };
    await assert.rejects(inspectAcceptanceEnvironment(options), (error) => error.code === 'ACCEPTANCE_TUNNEL_AUTHORIZATION_INVALID');
    await writeFile(evidence, `${JSON.stringify(baseEvidence)}\n`, { mode: 0o600 });
    const report = await inspectAcceptanceEnvironment(options);
    assert.equal(report.tunnelIdentity, 'AUTHORIZED');
  });

  it('rejects remote startup evidence when the acceptance registry is missing', async () => {
    const root = await fixtureRoot();
    const evidence = path.join(root, 'tunnel-evidence.json');
    const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
    const machineId = '11111111-1111-4111-8111-111111111111';
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    const profilePath = path.join(root, 'tunnel-profiles', 'iris-full.yaml');
    await writeFile(evidence, `${JSON.stringify({
      schemaVersion: 1,
      environment: 'non-production',
      provider: 'tunnel-client',
      machineId,
      sourceRoot,
      tunnelId,
      pid: 4242,
      executablePath: '/usr/local/bin/fixture-provider',
      processStartMarker: 'Sun Oct 11 01:00:00 2026',
      binding: { connectorId: 'iris-full', machineId, tunnelId, profilePath },
    })}\n`, { mode: 0o600 });
    await assert.rejects(inspectAcceptanceEnvironment({
      ...baseOptions(root, ['up', '--tunnel-id', tunnelId]),
      environment: { IRIS_ACCEPTANCE_ROOT: root, IRIS_ACCEPTANCE_TUNNEL_EVIDENCE: evidence },
      machineName: 'fixture-machine',
      isPidAlive: async (pid) => pid === 4242,
      inspectProcess: async (pid) => pid === 4242 ? { uid: process.getuid(), executable: '/usr/local/bin/fixture-provider', command: 'fixture-provider --profile /tmp/fixture-profile.yaml', processStartMarker: 'Sun Oct 11 01:00:00 2026' } : null,
      probePort: async () => false,
    }), (error) => error.code === 'ACCEPTANCE_TUNNEL_BINDING_UNVERIFIED');
    await writeFile(path.join(root, 'connector-registry.json'), JSON.stringify({ connectors: [{ connectorId: 'iris-full', label: 'IRIS', mode: 'FULL', runtime: 'iris-local-runtime', mcpProfile: 'FULL', mcpPath: '/mcp', healthPort: 43113, managedProfilePath: profilePath, tunnelId: 'tunnel_fedcba9876543210fedcba9876543210', machineId: 'fixture-machine' }], admin: null }), { mode: 0o600 });
    await assert.rejects(inspectAcceptanceEnvironment({
      ...baseOptions(root, ['up', '--tunnel-id', tunnelId]),
      environment: { IRIS_ACCEPTANCE_ROOT: root, IRIS_ACCEPTANCE_TUNNEL_EVIDENCE: evidence },
      machineName: 'fixture-machine',
      isPidAlive: async (pid) => pid === 4242,
      inspectProcess: async (pid) => pid === 4242 ? { uid: process.getuid(), executable: '/usr/local/bin/fixture-provider', command: 'fixture-provider --profile /tmp/fixture-profile.yaml', processStartMarker: 'Sun Oct 11 01:00:00 2026' } : null,
      probePort: async () => false,
    }), (error) => error.code === 'ACCEPTANCE_TUNNEL_BINDING_UNVERIFIED');
  });

  it('accepts only a Supervisor-persisted provider after startup verification', async () => {
    const fixture = await startupFixture();
    const canonicalProfilePath = await realpath(fixture.profilePath);
    await writeFile(path.join(fixture.root, 'supervisor', 'state.json'), JSON.stringify({
      schemaVersion: 3,
      supervisorId: 'fixture-supervisor',
      updatedAt: new Date().toISOString(),
      workloadSourceRoot: sourceRoot,
      workloadDesiredState: 'ON',
      stackDesiredState: 'UP',
      runtime: { component: 'runtime', pid: 4100, startedAt: new Date().toISOString(), executable: '/usr/local/bin/node', profilePath: null, tunnelId: null, marker: sourceRoot, runtimeId: 'runtime-fixture', instanceId: 'instance-fixture', processStartTimeMs: 1_700_000_000_000, workingDirectory: sourceRoot },
      web: null,
      admin: null,
      adminTunnel: null,
      tunnels: { full: { component: 'tunnel-full', pid: 4242, startedAt: new Date().toISOString(), executable: '/usr/local/bin/tunnel-client', profilePath: canonicalProfilePath, tunnelId: fixture.tunnelId, marker: 'tunnel-client', runtimeId: 'runtime-fixture', instanceId: 'instance-fixture', deploymentEpoch: 1, processStartTimeMs: 1_700_000_000_000, workingDirectory: sourceRoot }, pro: null },
      recovery: { attempts: 0, terminal: false, lastFailureCode: null, nextAttemptAt: null, windowStartedAt: null },
    }), { mode: 0o600 });
    const probed = [];
    const result = await verifyAcceptanceTunnelStartup({
      filename: fixture.evidence,
      tunnelId: fixture.tunnelId,
      dataRoot: fixture.root,
      sourceRoot,
      ports: TEST_PORTS,
      isPidAlive: async (pid) => pid === 4242,
      inspectProcess: async (pid) => pid === 4242 ? {
        uid: process.getuid(), executable: '/usr/local/bin/tunnel-client', command: `tunnel-client --profile ${canonicalProfilePath}`,
        processStartMarker: 'Sun Nov 12 22:13:20 2023', processStartTimeMs: 1_700_000_000_000,
      } : null,
      probePort: async (port) => { probed.push(port); return true; },
      probeProviderReady: async () => true,
      probeAuthenticatedEndpoint: async () => true,
    });
    assert.equal(result.state, 'READY');
    assert.equal(result.pid, 4242);
    assert.equal(probed.includes(TEST_PORTS.supervisorTunnelHealth), false);
    assert.deepEqual(probed.sort((a, b) => a - b), [TEST_PORTS.runtime, TEST_PORTS.supervisorAdmin, TEST_PORTS.supervisorControl, TEST_PORTS.fullTunnelHealth, TEST_PORTS.web].sort((a, b) => a - b));
  });

  it('requires every listener owned by the verified unified topology', async () => {
    const fixture = await startupFixture();
    const listenerKeys = ['runtime', 'supervisorAdmin', 'supervisorControl', 'fullTunnelHealth', 'web'];
    for (const key of listenerKeys) {
      await assert.rejects(verifyAcceptanceTunnelStartup({
        filename: fixture.evidence, tunnelId: fixture.tunnelId, dataRoot: fixture.root, sourceRoot, ports: TEST_PORTS,
        isPidAlive: async (pid) => pid === 4242,
        inspectProcess: async () => ({ uid: process.getuid(), executable: '/usr/local/bin/tunnel-client', command: `tunnel-client --profile ${fixture.profilePath}`, processStartMarker: 'Sun Nov 12 22:13:20 2023', processStartTimeMs: 1_700_000_000_000 }),
        probePort: async (port) => port !== TEST_PORTS[key], probeProviderReady: async () => true, probeAuthenticatedEndpoint: async () => true,
      }), (error) => error.code === 'ACCEPTANCE_STARTUP_UNVERIFIED');
    }
  });

  it('blocks contradictory unified registry and Supervisor state', async () => {
    const fixture = await startupFixture();
    const registryFile = path.join(fixture.root, 'connector-registry.json');
    const registry = JSON.parse(await readFile(registryFile, 'utf8'));
    registry.admin = {
      connectorId: 'iris-admin', label: 'IRIS ADMIN', mode: 'ADMIN', tunnelId: 'tunnel_abcdefabcdefabcdefabcdefabcdefab',
      managedProfilePath: path.join(fixture.root, 'tunnel-profiles', 'iris-admin.yaml'), machineId: '11111111-1111-4111-8111-111111111111', leaseGeneration: 1,
    };
    await writeFile(registryFile, JSON.stringify(registry));
    await assert.rejects(verifyAcceptanceTunnelStartup({
      filename: fixture.evidence, tunnelId: fixture.tunnelId, dataRoot: fixture.root, sourceRoot, ports: TEST_PORTS,
      isPidAlive: async () => true, inspectProcess: async () => ({ uid: process.getuid(), executable: '/usr/local/bin/tunnel-client', command: `tunnel-client --profile ${fixture.profilePath}`, processStartMarker: 'Sun Nov 12 22:13:20 2023', processStartTimeMs: 1_700_000_000_000 }),
      probePort: async () => true, probeProviderReady: async () => true, probeAuthenticatedEndpoint: async () => true,
    }), (error) => error.code === 'ACCEPTANCE_STARTUP_UNVERIFIED');
  });

  it('requires PRO and ADMIN health only for owned legacy topology', async () => {
    const fixture = await startupFixture();
    const registryFile = path.join(fixture.root, 'connector-registry.json');
    const registry = JSON.parse(await readFile(registryFile, 'utf8'));
    registry.connectors.push({
      connectorId: 'iris-pro', label: 'IRIS PRO', mode: 'PRO', tunnelId: 'tunnel_abcdefabcdefabcdefabcdefabcdefab',
      runtime: 'iris-local-runtime', mcpProfile: 'READ_ONLY', mcpPath: '/mcp-pro', healthPort: TEST_PORTS.proTunnelHealth,
      managedProfilePath: path.join(fixture.root, 'tunnel-profiles', 'iris-pro.yaml'), machineId: '11111111-1111-4111-8111-111111111111', runtimeId: 'runtime-fixture', deploymentEpoch: 1, leaseGeneration: 1,
    });
    registry.admin = {
      connectorId: 'iris-admin', label: 'IRIS ADMIN', mode: 'ADMIN', tunnelId: 'tunnel_fedcbafedcbafedcbafedcbafedcbafe',
      managedProfilePath: path.join(fixture.root, 'tunnel-profiles', 'iris-admin.yaml'), machineId: '11111111-1111-4111-8111-111111111111', leaseGeneration: 1,
    };
    await writeFile(registryFile, JSON.stringify(registry));
    const stateFile = path.join(fixture.root, 'supervisor', 'state.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}'));
    state.schemaVersion = 3; state.supervisorId = 'fixture-supervisor'; state.updatedAt = new Date().toISOString(); state.workloadSourceRoot = sourceRoot; state.workloadDesiredState = 'ON'; state.stackDesiredState = 'UP';
    state.runtime = { component: 'runtime', pid: 4100, executable: '/usr/local/bin/node', profilePath: null, tunnelId: null, runtimeId: 'runtime-fixture', instanceId: 'instance-fixture', processStartTimeMs: 1_700_000_000_000, workingDirectory: sourceRoot };
    state.admin = null; state.web = null; state.adminTunnel = { component: 'tunnel-admin', pid: 4343, executable: '/usr/local/bin/tunnel-client', profilePath: path.join(fixture.root, 'tunnel-profiles', 'iris-admin.yaml'), tunnelId: registry.admin.tunnelId, runtimeId: null, instanceId: null, processStartTimeMs: 1_700_000_000_000, workingDirectory: sourceRoot };
    state.tunnels = { full: { component: 'tunnel-full', pid: 4242, executable: '/usr/local/bin/tunnel-client', profilePath: await realpath(fixture.profilePath), tunnelId: fixture.tunnelId, runtimeId: 'runtime-fixture', instanceId: 'instance-fixture', deploymentEpoch: 1, processStartTimeMs: 1_700_000_000_000, workingDirectory: sourceRoot }, pro: { component: 'tunnel-pro', pid: 4344, executable: '/usr/local/bin/tunnel-client', profilePath: path.join(fixture.root, 'tunnel-profiles', 'iris-pro.yaml'), tunnelId: registry.connectors[1].tunnelId, runtimeId: 'runtime-fixture', instanceId: 'instance-fixture', deploymentEpoch: 1, processStartTimeMs: 1_700_000_000_000, workingDirectory: sourceRoot } };
    state.recovery = { attempts: 0, terminal: false, lastFailureCode: null, nextAttemptAt: null, windowStartedAt: null };
    await mkdir(path.join(fixture.root, 'supervisor'), { recursive: true });
    await writeFile(stateFile, JSON.stringify(state));
    const probed = [];
    const canonicalFullProfile = await realpath(fixture.profilePath);
    const result = await verifyAcceptanceTunnelStartup({
      filename: fixture.evidence, tunnelId: fixture.tunnelId, dataRoot: fixture.root, sourceRoot, ports: TEST_PORTS,
      isPidAlive: async (pid) => [4242, 4343, 4344].includes(pid),
      inspectProcess: async (pid) => ({ uid: process.getuid(), executable: '/usr/local/bin/tunnel-client', command: `tunnel-client --profile ${pid === 4242 ? canonicalFullProfile : pid === 4343 ? registry.admin.managedProfilePath : registry.connectors[1].managedProfilePath}`, processStartMarker: 'Sun Nov 12 22:13:20 2023', processStartTimeMs: 1_700_000_000_000 }),
      probePort: async (port) => { probed.push(port); return true; }, probeProviderReady: async () => true, probeAuthenticatedEndpoint: async () => true,
    });
    assert.equal(result.state, 'READY');
    assert.equal(probed.includes(TEST_PORTS.supervisorTunnelHealth), true);
    assert.equal(probed.includes(TEST_PORTS.proTunnelHealth), true);
  });

  it('keeps startup blocked when the persisted provider identity or readiness is uncertain', async () => {
    const fixture = await startupFixture();
    const canonicalProfilePath = await realpath(fixture.profilePath);
    await writeFile(path.join(fixture.root, 'supervisor', 'state.json'), JSON.stringify({
      schemaVersion: 3,
      supervisorId: 'fixture-supervisor', updatedAt: new Date().toISOString(), workloadSourceRoot: sourceRoot,
      workloadDesiredState: 'ON', stackDesiredState: 'UP',
      runtime: { component: 'runtime', pid: 4100, startedAt: new Date().toISOString(), executable: '/usr/local/bin/node', profilePath: null, tunnelId: null, marker: sourceRoot, runtimeId: 'runtime-fixture', instanceId: 'instance-fixture', processStartTimeMs: 1_700_000_000_000, workingDirectory: sourceRoot },
      web: null, admin: null, adminTunnel: null,
      tunnels: { full: { component: 'tunnel-full', pid: 4242, startedAt: new Date().toISOString(), executable: '/usr/local/bin/tunnel-client', profilePath: canonicalProfilePath, tunnelId: fixture.tunnelId, marker: 'tunnel-client', runtimeId: 'runtime-fixture', instanceId: 'instance-fixture', deploymentEpoch: 1, processStartTimeMs: 1_700_000_000_000, workingDirectory: sourceRoot }, pro: null },
      recovery: { attempts: 0, terminal: false, lastFailureCode: null, nextAttemptAt: null, windowStartedAt: null },
    }), { mode: 0o600 });
    await assert.rejects(verifyAcceptanceTunnelStartup({
      filename: fixture.evidence, tunnelId: fixture.tunnelId, dataRoot: fixture.root, sourceRoot, ports: TEST_PORTS,
      isPidAlive: async () => true,
      inspectProcess: async () => ({ uid: process.getuid(), executable: '/usr/local/bin/fixture-provider', command: `fixture-provider --profile ${canonicalProfilePath}`, processStartMarker: 'Sun Nov 12 22:13:20 2023', processStartTimeMs: 1_700_000_000_000 }),
      probePort: async () => true, probeProviderReady: async () => false, probeAuthenticatedEndpoint: async () => true,
    }), (error) => error.code === 'ACCEPTANCE_TUNNEL_PROCESS_MISMATCH');
  });

  it('rejects connector mutation and unsupported commands before child execution', async () => {
    const root = await fixtureRoot();
    const protectedRoot = await fixtureRoot();
    const protectedFile = path.join(protectedRoot, 'protected-state.json');
    await writeFile(protectedFile, 'fixture-protected-bytes\n');
    assert.equal((await runWrapper(root, [protectedRoot], ['preflight'])).code, 0);
    const before = await readFile(protectedFile);
    for (const command of [
      ['connectors', 'init', 'tunnel_0123456789abcdef0123456789abcdef'],
      ['connectors', 'admin-bind', 'tunnel_0123456789abcdef0123456789abcdef'],
      ['credentials', 'rotate-tunnel'],
      ['catalog', 'reload'],
      ['unknown-command'],
    ]) {
      const result = await runWrapper(root, [protectedRoot], command);
      assert.equal(result.code, 1, command.join(' '));
      assert.match(result.stderr, /ACCEPTANCE_COMMAND_UNSUPPORTED/);
    }
    assert.deepEqual(await readFile(protectedFile), before);
  });

  it('rejects nested root overrides at the actual wrapper-to-child boundary', async () => {
    const root = await fixtureRoot();
    const protectedRoot = await fixtureRoot();
    const otherRoot = await fixtureRoot();
    const protectedFile = path.join(protectedRoot, 'protected-state.json');
    await writeFile(protectedFile, 'fixture-protected-bytes\n');
    assert.equal((await runWrapper(root, [protectedRoot], ['preflight'])).code, 0);
    const before = await readFile(protectedFile);
    for (const command of [
      ['setup', '--tunnel-id', 'tunnel_0123456789abcdef0123456789abcdef', '--runtime-data-root', protectedRoot],
      ['setup', '--tunnel-id', 'tunnel_0123456789abcdef0123456789abcdef', '--protected-reference-root', otherRoot],
      ['setup', '--tunnel-id', 'tunnel_0123456789abcdef0123456789abcdef', '--unknown'],
    ]) {
      const result = await runWrapper(root, [protectedRoot], command);
      assert.equal(result.code, 1, command.join(' '));
      assert.match(result.stderr, /ACCEPTANCE_COMMAND_UNSUPPORTED/);
    }
    assert.deepEqual(await readFile(protectedFile), before);
  });

  it('allows setup and read-only status through the child boundary with the accepted root', async () => {
    const root = await fixtureRoot();
    const protectedRoot = await fixtureRoot();
    assert.equal((await runWrapper(root, [protectedRoot], ['preflight'])).code, 0);
    const setup = await runWrapper(root, [protectedRoot], ['setup', '--tunnel-id', 'tunnel_0123456789abcdef0123456789abcdef', '--json']);
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /NEEDS_CREDENTIALS|READY_TO_START|IRIS_SETUP=/);
    const status = await runWrapper(root, [protectedRoot], ['status']);
    assert.equal(status.code, 0, status.stderr);
  });

  it('rejects production credential profiles and documentation keeps the wrapper mandatory', async () => {
    const root = await fixtureRoot();
    const profileRoot = await fixtureRoot();
    const profile = path.join(profileRoot, 'profile.yaml');
    await writeFile(profile, 'control_plane:\n  api_key: "fixture-only-credential-1234567890"\n', { mode: 0o600 });
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    const report = await inspectAcceptanceEnvironment({ ...baseOptions(root, ['credentials', 'migrate', profile]), protectedRoots: ['/tmp/live'] });
    assert.equal(report.dataRoot, await realpath(root));
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions(root, ['credentials', 'migrate', profile]), protectedRoots: [profileRoot] }), (error) => error.code === 'ACCEPTANCE_PROFILE_PROTECTED');
  });

  it('guards the acceptance documentation against unscoped lifecycle commands', async () => {
    const plan = await readFile(path.join(sourceRoot, 'docs', 'acceptance', 'OWNER_ACCEPTANCE_PLAN.md'), 'utf8');
    const installation = await readFile(path.join(sourceRoot, 'docs', 'INSTALLATION.md'), 'utf8');
    assert.match(plan, /scripts\/iris-acceptance\.mjs/);
    assert.match(plan, /iris_acceptance credentials migrate/);
    assert.match(plan, /iris_acceptance status/);
    assert.doesNotMatch(plan, /node scripts\/iris\.mjs credentials migrate[\s\S]*node scripts\/iris\.mjs up/);
    assert.match(installation, /acceptance-only wrapper/);
  });

  it('propagates the explicit identity through the runtime control wrapper', async () => {
    const root = await fixtureRoot();
    const child = buildChildEnvironment(await realpath(root), { IRIS_RUNTIME_DATA_ROOT: '/wrong', IRIS_PROTECTED_REFERENCE_ROOT: '/wrong-reference', OTHER: 'kept' });
    assert.equal(child.IRIS_RUNTIME_DATA_ROOT, await realpath(root));
    assert.equal(child.IRIS_ACCEPTANCE_ROOT, await realpath(root));
    assert.equal(child.IRIS_PROTECTED_REFERENCE_ROOT, undefined);
    assert.equal(child.OTHER, 'kept');
    assert.match(await readFile(path.join(sourceRoot, 'scripts', 'iris.mjs'), 'utf8'), /node24Environment\(\{ \.\.\.process\.env/);
  });
});

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-acceptance-'));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

async function startupFixture() {
  const root = await fixtureRoot();
  const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
  const machineId = '11111111-1111-4111-8111-111111111111';
  const profilePath = path.join(root, 'tunnel-profiles', 'iris-full.yaml');
  const evidence = path.join(root, 'tunnel-evidence.json');
  await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
  await mkdir(path.join(root, 'tunnel-profiles'), { mode: 0o700 });
  await mkdir(path.join(root, 'credentials'), { mode: 0o700 });
  await mkdir(path.join(root, 'supervisor'), { mode: 0o700 });
  await writeFile(profilePath, `control_plane:\n  tunnel_id: "${tunnelId}"\nhealth:\n  listen_addr: 127.0.0.1:${TEST_PORTS.fullTunnelHealth}\nmcp:\n  server_urls:\n    - url: http://127.0.0.1:${TEST_PORTS.runtime}/mcp\n`, { mode: 0o600 });
  await writeFile(path.join(root, 'credentials', 'control-plane-api-key'), 'fixture-key\n', { mode: 0o600 });
  await writeFile(path.join(root, 'connector-registry.json'), JSON.stringify({
    schemaVersion: 3, deploymentEpoch: 1, updatedAt: new Date().toISOString(),
    connectors: [{ connectorId: 'iris-full', label: 'IRIS', mode: 'FULL', runtime: 'iris-local-runtime', mcpProfile: 'FULL', mcpPath: '/mcp', healthPort: TEST_PORTS.fullTunnelHealth, managedProfilePath: profilePath, tunnelId, machineId, runtimeId: 'runtime-fixture', deploymentEpoch: 1, leaseGeneration: 1 }], admin: null,
  }), { mode: 0o600 });
  await writeFile(evidence, `${JSON.stringify({
    schemaVersion: 2, phase: 'PREPARED', environment: 'non-production', provider: 'tunnel-client', machineId, sourceRoot, tunnelId,
    credentialPath: path.join(await realpath(root), 'credentials', 'control-plane-api-key'),
    binding: { connectorId: 'iris-full', machineId, tunnelId, profilePath },
  })}\n`, { mode: 0o600 });
  return { root, tunnelId, profilePath, evidence };
}

function baseOptions(root, command) {
  return {
    runtimeDataRoot: root,
    protectedRoots: ['/tmp/iris-live-fixture'],
    sourceRoot,
    ports: TEST_PORTS,
    command,
    environment: { IRIS_ACCEPTANCE_ROOT: root },
  };
}

function runWrapper(root, protectedRoots, command) {
  const argumentsList = [path.join(sourceRoot, 'scripts', 'iris-acceptance.mjs'), '--runtime-data-root', root];
  for (const protectedRoot of protectedRoots) argumentsList.push('--protected-root', protectedRoot);
  argumentsList.push('--ports', Object.entries(TEST_PORTS).map(([name, port]) => `${name}=${port}`).join(','));
  argumentsList.push('--', ...command);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: sourceRoot,
      env: { ...process.env, IRIS_ACCEPTANCE_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
