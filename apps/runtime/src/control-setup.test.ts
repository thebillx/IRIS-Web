import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
