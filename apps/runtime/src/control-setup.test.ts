import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, test } from 'node:test';
import { persistControlPlaneApiKey } from './credentials.js';

const exec = promisify(execFile);
const roots: string[] = [];
const sourceRoot = path.resolve(import.meta.dirname, '../../..');
const fullTunnelId = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const proTunnelId = 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function runSetup(dataRoot: string, ...args: string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return exec(process.execPath, ['scripts/iris.mjs', 'setup', '--json', '--runtime-data-root', dataRoot, ...args], {
    cwd: sourceRoot,
    env: { ...process.env, IRIS_STACK_CLI: '1' },
    maxBuffer: 2 * 1024 * 1024,
  });
}

test('setup reports missing credentials without creating registry state', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-setup-missing-'));
  roots.push(dataRoot);
  const result = JSON.parse((await runSetup(dataRoot, '--full-tunnel-id', fullTunnelId, '--pro-tunnel-id', proTunnelId)).stdout) as { status: string; credentials: { controlPlaneApiKeyPresent: boolean } };
  assert.equal(result.status, 'NEEDS_CREDENTIALS');
  assert.equal(result.credentials.controlPlaneApiKeyPresent, false);
  await assert.rejects(stat(path.join(dataRoot, 'connector-registry.json')), { code: 'ENOENT' });
});

test('setup persists one machine binding and repeats without replacing it', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-setup-persist-'));
  roots.push(dataRoot);
  await persistControlPlaneApiKey(dataRoot, 'fixture-control-plane-key-1234567890');
  const first = JSON.parse((await runSetup(dataRoot, '--full-tunnel-id', fullTunnelId, '--pro-tunnel-id', proTunnelId)).stdout) as { status: string; repeated: boolean; machineId: string };
  const before = await readFile(path.join(dataRoot, 'connector-registry.json'), 'utf8');
  const second = JSON.parse((await runSetup(dataRoot, '--full-tunnel-id', fullTunnelId, '--pro-tunnel-id', proTunnelId)).stdout) as { status: string; repeated: boolean; machineId: string };
  assert.equal(first.status, 'READY_TO_START');
  assert.equal(first.repeated, false);
  assert.equal(second.repeated, true);
  assert.equal(second.machineId, first.machineId);
  assert.equal(await readFile(path.join(dataRoot, 'connector-registry.json'), 'utf8'), before);
});

test('setup keeps two disposable installations isolated and rejects binding replacement', async () => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-setup-a-'));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-setup-b-'));
  roots.push(firstRoot, secondRoot);
  await Promise.all([
    persistControlPlaneApiKey(firstRoot, 'fixture-control-plane-key-a-123456'),
    persistControlPlaneApiKey(secondRoot, 'fixture-control-plane-key-b-123456'),
  ]);
  const [first, second] = await Promise.all([
    runSetup(firstRoot, '--full-tunnel-id', fullTunnelId, '--pro-tunnel-id', proTunnelId),
    runSetup(secondRoot, '--full-tunnel-id', proTunnelId, '--pro-tunnel-id', fullTunnelId),
  ]);
  const firstSetup = JSON.parse(first.stdout) as { machineId: string };
  const secondSetup = JSON.parse(second.stdout) as { machineId: string };
  assert.notEqual(firstSetup.machineId, secondSetup.machineId);
  const before = await readFile(path.join(firstRoot, 'connector-registry.json'), 'utf8');
  await assert.rejects(runSetup(firstRoot, '--full-tunnel-id', proTunnelId, '--pro-tunnel-id', fullTunnelId));
  assert.equal(await readFile(path.join(firstRoot, 'connector-registry.json'), 'utf8'), before);
});

test('setup serializes same-root first-run binding publication', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-setup-race-'));
  roots.push(dataRoot);
  await persistControlPlaneApiKey(dataRoot, 'fixture-control-plane-key-race-123456');
  const otherFullTunnelId = 'tunnel_cccccccccccccccccccccccccccccccc';
  const otherProTunnelId = 'tunnel_dddddddddddddddddddddddddddddddd';
  const first = runSetup(dataRoot, '--full-tunnel-id', fullTunnelId, '--pro-tunnel-id', proTunnelId);
  const second = runSetup(dataRoot, '--full-tunnel-id', otherFullTunnelId, '--pro-tunnel-id', otherProTunnelId);
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const registry = await readFile(path.join(dataRoot, 'connector-registry.json'), 'utf8');
  const firstWon = registry.includes(fullTunnelId) && registry.includes(proTunnelId);
  const secondWon = registry.includes(otherFullTunnelId) && registry.includes(otherProTunnelId);
  assert.equal(firstWon || secondWon, true);
  assert.equal(firstWon && secondWon, false);
});

test('setup fails closed when a stale operation lock requires reconciliation', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-setup-stale-lock-'));
  roots.push(dataRoot);
  await persistControlPlaneApiKey(dataRoot, 'fixture-control-plane-key-stale-123456');
  await mkdir(path.join(dataRoot, 'supervisor'), { recursive: true });
  await writeFile(path.join(dataRoot, 'supervisor', 'operation.lock'), JSON.stringify({ schemaVersion: 1, pid: 999999, startedAt: new Date(0).toISOString(), operation: 'crashed-setup', processStartMarker: '1:000000' }));
  const results = await Promise.allSettled([
    runSetup(dataRoot, '--full-tunnel-id', fullTunnelId, '--pro-tunnel-id', proTunnelId),
    runSetup(dataRoot, '--full-tunnel-id', 'tunnel_cccccccccccccccccccccccccccccccc', '--pro-tunnel-id', 'tunnel_dddddddddddddddddddddddddddddddd'),
  ]);
  assert.equal(results.every((result) => result.status === 'rejected'), true);
  await assert.rejects(stat(path.join(dataRoot, 'connector-registry.json')), { code: 'ENOENT' });
});
