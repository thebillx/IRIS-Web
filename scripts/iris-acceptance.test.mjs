import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    const child = buildChildEnvironment(await realpath(root), { IRIS_RUNTIME_DATA_ROOT: '/wrong', OTHER: 'kept' });
    assert.equal(child.IRIS_RUNTIME_DATA_ROOT, await realpath(root));
    assert.equal(child.IRIS_ACCEPTANCE_ROOT, await realpath(root));
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
