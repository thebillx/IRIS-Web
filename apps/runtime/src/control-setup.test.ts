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
const tunnelId = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function runSetup(dataRoot: string, ...args: string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return exec(process.execPath, ['scripts/iris.mjs', 'setup', ...args], {
    cwd: sourceRoot,
    env: { ...process.env, IRIS_RUNTIME_DATA_ROOT: dataRoot },
    maxBuffer: 2 * 1024 * 1024,
  });
}

test('guided setup reports missing credentials without creating registry state', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-guided-setup-missing-'));
  roots.push(dataRoot);
  const result = JSON.parse((await runSetup(dataRoot, '--tunnel-id', tunnelId)).stdout) as { status: string; credentials: { controlPlaneApiKeyPresent: boolean } };
  assert.equal(result.status, 'NEEDS_CREDENTIALS');
  assert.equal(result.credentials.controlPlaneApiKeyPresent, false);
  await assert.rejects(stat(path.join(dataRoot, 'connector-registry.json')), { code: 'ENOENT' });
});

test('guided setup initializes one connector and repeats without mutation', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-guided-setup-ready-'));
  roots.push(dataRoot);
  await persistControlPlaneApiKey(dataRoot, 'fixture-control-plane-key-123456');
  const first = JSON.parse((await runSetup(dataRoot, '--tunnel-id', tunnelId)).stdout) as { status: string; repeated: boolean; connector: { label: string; mcpPath: string }; machineId: string };
  assert.equal(first.status, 'READY_TO_START');
  assert.equal(first.repeated, false);
  assert.deepEqual(first.connector, { label: 'IRIS', mcpPath: '/mcp', tunnelId });
  assert.match(first.machineId, /^[0-9a-f-]{36}$/);
  const registryBefore = await readFile(path.join(dataRoot, 'connector-registry.json'), 'utf8');
  const second = JSON.parse((await runSetup(dataRoot, '--tunnel-id', tunnelId)).stdout) as { status: string; repeated: boolean };
  assert.equal(second.status, 'READY_TO_START');
  assert.equal(second.repeated, true);
  assert.equal(await readFile(path.join(dataRoot, 'connector-registry.json'), 'utf8'), registryBefore);
});

test('guided setup rejects a different tunnel on an existing installation', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-guided-setup-conflict-'));
  roots.push(dataRoot);
  await persistControlPlaneApiKey(dataRoot, 'fixture-control-plane-key-123456');
  await runSetup(dataRoot, '--tunnel-id', tunnelId);
  await assert.rejects(runSetup(dataRoot, '--tunnel-id', 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), (error: unknown) => error instanceof Error && 'stderr' in error && String((error as { readonly stderr?: unknown }).stderr).includes('IRIS_COMMAND_FAILED'));
});

test('two disposable installations keep machine, tunnel and registry state independent', async () => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-guided-setup-machine-a-'));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-guided-setup-machine-b-'));
  roots.push(firstRoot, secondRoot);
  await Promise.all([
    persistControlPlaneApiKey(firstRoot, 'fixture-control-plane-key-a-123456'),
    persistControlPlaneApiKey(secondRoot, 'fixture-control-plane-key-b-123456'),
  ]);
  const [first, second] = await Promise.all([
    runSetup(firstRoot, '--tunnel-id', tunnelId),
    runSetup(secondRoot, '--tunnel-id', 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  ]);
  const firstSetup = JSON.parse(first.stdout) as { machineId: string; connector: { tunnelId: string } };
  const secondSetup = JSON.parse(second.stdout) as { machineId: string; connector: { tunnelId: string } };
  assert.notEqual(firstSetup.machineId, secondSetup.machineId);
  assert.equal(firstSetup.connector.tunnelId, tunnelId);
  assert.equal(secondSetup.connector.tunnelId, 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.notEqual(path.resolve(firstRoot), path.resolve(secondRoot));
  assert.notDeepEqual(await readFile(path.join(firstRoot, 'connector-registry.json'), 'utf8'), await readFile(path.join(secondRoot, 'connector-registry.json'), 'utf8'));
});
