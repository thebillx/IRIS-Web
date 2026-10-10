import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { buildChildEnvironment, inspectAcceptanceEnvironment, parseAcceptanceArgs } from './iris-acceptance.mjs';

const roots = [];
const sourceRoot = path.resolve(import.meta.dirname, '..');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('acceptance isolation preflight', () => {
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
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions(root, ['up']), probePort: async (port) => port === 43110 }), (error) => error.code === 'ACCEPTANCE_PORT_CONFLICT');
  });

  it('blocks LaunchAgent install and uninstall for parallel acceptance', async () => {
    const root = await fixtureRoot();
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    await assert.rejects(inspectAcceptanceEnvironment(baseOptions(root, ['launchd', 'install'])), (error) => error.code === 'ACCEPTANCE_LAUNCHD_BLOCKED');
    await assert.rejects(inspectAcceptanceEnvironment(baseOptions(root, ['launchd', 'uninstall'])), (error) => error.code === 'ACCEPTANCE_LAUNCHD_BLOCKED');
  });

  it('propagates the explicit root and rejects unverified remote startup', async () => {
    const root = await fixtureRoot();
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    await assert.rejects(inspectAcceptanceEnvironment({ ...baseOptions(root, ['up']), probePort: async () => false }), (error) => error.code === 'ACCEPTANCE_TUNNEL_UNVERIFIED');
    const report = await inspectAcceptanceEnvironment({ ...baseOptions(root, ['status']), environment: { IRIS_ACCEPTANCE_ROOT: root } });
    assert.equal(report.dataRoot, await realpath(root));
  });

  it('allows remote startup only with independently checked non-production tunnel evidence', async () => {
    const root = await fixtureRoot();
    const evidence = path.join(root, 'tunnel-evidence.json');
    const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    await writeFile(evidence, `${JSON.stringify({
      schemaVersion: 1,
      environment: 'non-production',
      provider: 'fixture-provider',
      machineId: 'fixture-machine',
      sourceRoot,
      tunnelId,
      pid: 4242,
      executablePath: '/usr/local/bin/fixture-provider',
      processStartMarker: 'Sun Oct 11 01:00:00 2026',
      binding: { tunnelId, profilePath: '/tmp/fixture-profile.yaml' },
    })}\n`, { mode: 0o600 });
    await writeFile(path.join(root, 'connector-registry.json'), JSON.stringify({ connectors: [], admin: { tunnelId } }), { mode: 0o600 });
    const report = await inspectAcceptanceEnvironment({
      ...baseOptions(root, ['up']),
      environment: { IRIS_ACCEPTANCE_ROOT: root, IRIS_ACCEPTANCE_TUNNEL_EVIDENCE: evidence },
      machineName: 'fixture-machine',
      isPidAlive: async (pid) => pid === 4242,
      inspectProcess: async (pid) => pid === 4242 ? { uid: process.getuid(), executable: '/usr/local/bin/fixture-provider', command: 'fixture-provider --profile /tmp/fixture-profile.yaml', processStartMarker: 'Sun Oct 11 01:00:00 2026' } : null,
      probePort: async () => false,
    });
    assert.equal(report.tunnelIdentity, 'VERIFIED');
  });

  it('rejects remote startup evidence when the acceptance registry is missing', async () => {
    const root = await fixtureRoot();
    const evidence = path.join(root, 'tunnel-evidence.json');
    const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
    await inspectAcceptanceEnvironment(baseOptions(root, ['preflight']));
    await writeFile(evidence, `${JSON.stringify({
      schemaVersion: 1,
      environment: 'non-production',
      provider: 'fixture-provider',
      machineId: 'fixture-machine',
      sourceRoot,
      tunnelId,
      pid: 4242,
      executablePath: '/usr/local/bin/fixture-provider',
      processStartMarker: 'Sun Oct 11 01:00:00 2026',
      binding: { tunnelId, profilePath: '/tmp/fixture-profile.yaml' },
    })}\n`, { mode: 0o600 });
    await assert.rejects(inspectAcceptanceEnvironment({
      ...baseOptions(root, ['up']),
      environment: { IRIS_ACCEPTANCE_ROOT: root, IRIS_ACCEPTANCE_TUNNEL_EVIDENCE: evidence },
      machineName: 'fixture-machine',
      isPidAlive: async (pid) => pid === 4242,
      inspectProcess: async (pid) => pid === 4242 ? { uid: process.getuid(), executable: '/usr/local/bin/fixture-provider', command: 'fixture-provider --profile /tmp/fixture-profile.yaml', processStartMarker: 'Sun Oct 11 01:00:00 2026' } : null,
      probePort: async () => false,
    }), (error) => error.code === 'ACCEPTANCE_TUNNEL_BINDING_UNVERIFIED');
    await writeFile(path.join(root, 'connector-registry.json'), JSON.stringify({ connectors: [], admin: { tunnelId: 'tunnel_fedcba9876543210fedcba9876543210' } }), { mode: 0o600 });
    await assert.rejects(inspectAcceptanceEnvironment({
      ...baseOptions(root, ['up']),
      environment: { IRIS_ACCEPTANCE_ROOT: root, IRIS_ACCEPTANCE_TUNNEL_EVIDENCE: evidence },
      machineName: 'fixture-machine',
      isPidAlive: async (pid) => pid === 4242,
      inspectProcess: async (pid) => pid === 4242 ? { uid: process.getuid(), executable: '/usr/local/bin/fixture-provider', command: 'fixture-provider --profile /tmp/fixture-profile.yaml', processStartMarker: 'Sun Oct 11 01:00:00 2026' } : null,
      probePort: async () => false,
    }), (error) => error.code === 'ACCEPTANCE_TUNNEL_BINDING_UNVERIFIED');
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

function baseOptions(root, command) {
  return {
    runtimeDataRoot: root,
    protectedRoots: ['/tmp/iris-live-fixture'],
    sourceRoot,
    command,
    environment: { IRIS_ACCEPTANCE_ROOT: root },
  };
}

function runWrapper(root, protectedRoots, command) {
  const argumentsList = [path.join(sourceRoot, 'scripts', 'iris-acceptance.mjs'), '--runtime-data-root', root];
  for (const protectedRoot of protectedRoots) argumentsList.push('--protected-root', protectedRoot);
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
