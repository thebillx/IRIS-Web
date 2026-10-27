import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectActivationSourceIdentity } from './activation-source-identity.js';
import { probeRuntimeAuthority } from './authority.js';
import { bindConnectorRuntime, initializeConnectorRegistry } from './connector-registry.js';
import { runtimeChildEnvironment, runtimeStatus, startRuntime, stopRuntime } from './lifecycle.js';
import { loadOrCreateMachineId } from './machine-identity.js';
import { MCP_PROTOCOL_VERSION } from './mcp.js';
import { loadOrCreateRuntimeId, readEndpoint, readOwnerAccessSecret, readRuntimeControl, writeEndpoint, writeRuntimeControl } from './persistence.js';
import { node24Path } from './node-runtime.js';

const roots: string[] = [];
const managedRuntimeRoots = new Set<string>();
const sourceRoot = path.resolve(import.meta.dirname, '../../..');
let occupiedServer: Server | undefined;
let ownerAccessToken = '';

afterEach(async () => {
  for (const dataRoot of managedRuntimeRoots) {
    if ((await runtimeStatus(dataRoot)).state === 'running') await stopRuntime(dataRoot, 15_000);
    if ((await runtimeStatus(dataRoot)).state !== 'stopped') throw new Error('Fixture Runtime outcome is unresolved; preserve its data root');
    managedRuntimeRoots.delete(dataRoot);
  }
  if (occupiedServer?.listening) await new Promise<void>((resolve, reject) => occupiedServer!.close((error) => error ? reject(error) : resolve()));
  occupiedServer = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function fixtureCommand(command: string, args: string[], cwd: string, timeout = 60_000): Promise<string> {
  const result = await exec(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

async function sourceManifest(root: string) {
  const [head, tree, status, activation] = await Promise.all([
    fixtureCommand('git', ['rev-parse', 'HEAD'], root),
    fixtureCommand('git', ['rev-parse', 'HEAD^{tree}'], root),
    fixtureCommand('git', ['status', '--porcelain', '--untracked-files=no'], root),
    inspectActivationSourceIdentity(root),
  ]);
  return { head: head.trim(), tree: tree.trim(), trackedStatus: status.trim(), activation };
}

async function syntheticRelease(baseCommit: string, sourceMarker: 'SOURCE_A' | 'SOURCE_B', store: string) {
  const container = await temp(`iris-r09-${sourceMarker.toLowerCase()}-`);
  const release = path.join(container, 'source');
  await fixtureCommand('git', ['clone', '--shared', '--no-checkout', sourceRoot, release], sourceRoot, 120_000);
  await fixtureCommand('git', ['checkout', '--detach', baseCommit], release);
  const entrypoint = path.join(release, 'apps/runtime/src/main.ts');
  const original = await readFile(entrypoint, 'utf8');
  const markerPrelude = [
    "import { appendFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "import { startDaemon } from './daemon.js';",
    'const r09MarkerRoot = process.env.IRIS_RUNTIME_DATA_ROOT;',
    "if (r09MarkerRoot === undefined) throw new Error('R09 fixture data root is missing');",
    `appendFileSync(path.join(r09MarkerRoot, 'r09-source-marker'), ${JSON.stringify(sourceMarker + '\n')});`,
  ].join('\n');
  const instrumented = original.replace("import { startDaemon } from './daemon.js';", markerPrelude);
  if (instrumented === original) throw new Error('Synthetic source marker insertion point was not found');
  await writeFile(entrypoint, instrumented);
  await fixtureCommand('git', ['add', '--', 'apps/runtime/src/main.ts'], release);
  await fixtureCommand('git', [
    '-c', 'user.name=IRIS Disposable Test',
    '-c', 'user.email=iris-disposable@example.invalid',
    'commit', '-m', `R09 ${sourceMarker} immutable executable fixture`,
  ], release);
  const syntheticHead = (await fixtureCommand('git', ['rev-parse', 'HEAD'], release)).trim();
  if ((await fixtureCommand('git', ['rev-parse', 'HEAD^'], release)).trim() !== baseCommit) {
    throw new Error(`${sourceMarker} synthetic source parent changed`);
  }
  await fixtureCommand('pnpm', [
    'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', store,
  ], release, 300_000);
  const manifest = await sourceManifest(release);
  if (manifest.head !== syntheticHead || manifest.trackedStatus.length !== 0) {
    throw new Error(`${sourceMarker} source failed immutable manifest attestation`);
  }
  return { path: release, head: syntheticHead, baseCommit, parent: baseCommit, manifest };
}

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (ownerAccessToken.length > 0) headers.set('authorization', `Bearer ${ownerAccessToken}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

describe('runtime lifecycle integration', () => {
  it('passes only the bounded local environment required by the child runtime', () => {
    const environment = runtimeChildEnvironment('/private/tmp/iris-runtime-test', 43110, {
      PATH: node24Path(), HOME: '/Users/test', TMPDIR: '/private/tmp', LANG: 'en_US.UTF-8',
      NODE_OPTIONS: '--require /tmp/untrusted.js', CLOUD_TOKEN: 'secret-value',
      IRIS_PROTECTED_REFERENCE_ROOT: '/private/tmp/protected-reference',
      IRIS_AGENT_EXECUTOR: 'openai', OPENAI_API_KEY: 'openai-test-secret', IRIS_OPENAI_MODEL: 'gpt-test-model',
    });
    expect(environment).toMatchObject({
      PATH: node24Path(), HOME: '/Users/test', TMPDIR: '/private/tmp', LANG: 'en_US.UTF-8',
      IRIS_RUNTIME_DATA_ROOT: '/private/tmp/iris-runtime-test', IRIS_RUNTIME_PORT: '43110',
      IRIS_PROTECTED_REFERENCE_ROOT: '/private/tmp/protected-reference',
      IRIS_AGENT_EXECUTOR: 'openai', OPENAI_API_KEY: 'openai-test-secret', IRIS_OPENAI_MODEL: 'gpt-test-model',
    });
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.CLOUD_TOKEN).toBeUndefined();
    expect(runtimeChildEnvironment('/private/tmp/iris-runtime-test', undefined, {}, undefined, 'startup-id').IRIS_SUPERVISOR_STARTUP_ID).toBe('startup-id');

    const explicitlyConfigured = runtimeChildEnvironment('/private/tmp/iris-runtime-test', 43110, {
      PATH: node24Path(), IRIS_PROTECTED_REFERENCE_ROOT: '/private/tmp/inherited-reference',
    }, '/private/tmp/explicit-owner-reference');
    expect(explicitlyConfigured.IRIS_PROTECTED_REFERENCE_ROOT).toBe('/private/tmp/explicit-owner-reference');

    const developmentEnvironment = runtimeChildEnvironment('/private/tmp/iris-runtime-test', 43110, {
      PATH: node24Path(),
      IRIS_AGENT_EXECUTOR: 'development', OPENAI_API_KEY: 'must-not-reach-child', IRIS_OPENAI_MODEL: 'must-not-reach-child',
    });
    expect(developmentEnvironment.IRIS_AGENT_EXECUTOR).toBe('development');
    expect(developmentEnvironment.OPENAI_API_KEY).toBeUndefined();
    expect(developmentEnvironment.IRIS_OPENAI_MODEL).toBeUndefined();
  });

  it('rejects a stale expected activation source identity before spawning a runtime', async () => {
    const dataRoot = await temp('iris-lifecycle-launch-attestation-');
    const identityBoundStart = startRuntime as unknown as (options: {
      readonly dataRoot: string;
      readonly preferredPort: number;
      readonly startupDeadlineMs: number;
      readonly sourceRoot: string;
      readonly expectedSourceIdentity: {
        readonly head: string;
        readonly candidateFingerprint: string;
        readonly trackedModifiedCount: number;
        readonly fingerprintAlgorithm: 'sha256:sorted-tracked-path-content-v1';
      };
    }) => ReturnType<typeof startRuntime>;

    try {
      await expect(identityBoundStart({
        dataRoot,
        preferredPort: 0,
        startupDeadlineMs: 15_000,
        sourceRoot,
        expectedSourceIdentity: {
          head: 'f'.repeat(40),
          candidateFingerprint: 'e'.repeat(64),
          trackedModifiedCount: 0,
          fingerprintAlgorithm: 'sha256:sorted-tracked-path-content-v1',
        },
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'stopped' });
    } finally {
      const observed = await runtimeStatus(dataRoot);
      if (observed.state === 'running') await stopRuntime(dataRoot, 15_000);
    }
  }, 30_000);

  it('starts the verified source after rejecting a stale launch identity and tears it down cleanly', async () => {
    const dataRoot = await temp('iris-lifecycle-source-fallback-');
    managedRuntimeRoots.add(dataRoot);
    const actualIdentity = await inspectActivationSourceIdentity(sourceRoot);
    const staleIdentity = { ...actualIdentity, candidateFingerprint: '0'.repeat(64) };

    try {
      await expect(startRuntime({
        dataRoot,
        preferredPort: 0,
        startupDeadlineMs: 15_000,
        sourceRoot,
        expectedSourceIdentity: staleIdentity,
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'stopped' });
      await expect(readEndpoint(dataRoot)).resolves.toBeNull();
      await expect(readRuntimeControl(dataRoot)).resolves.toBeNull();

      const started = await startRuntime({
        dataRoot,
        preferredPort: 0,
        startupDeadlineMs: 15_000,
        sourceRoot,
        expectedSourceIdentity: actualIdentity,
      });
      expect(started.state).toBe('running');
      expect(started.endpoint).not.toBeNull();
      expect(started.health?.authority).toBe('owned');

      const stopped = await stopRuntime(dataRoot, 15_000);
      expect(stopped.state).toBe('stopped');
      expect(await probeRuntimeAuthority(dataRoot)).toEqual({ state: 'unowned' });
    } finally {
      if ((await runtimeStatus(dataRoot)).state === 'running') await stopRuntime(dataRoot, 15_000);
    }
  }, 45_000);


  it('selects a distinct attested executable only after source A fails health and preserves a fallback abort', async () => {
    const dataRootA = await temp('iris-r09-runtime-source-a-data-');
    const dataRootB = await temp('iris-r09-runtime-source-b-data-');
    managedRuntimeRoots.add(dataRootA);
    managedRuntimeRoots.add(dataRootB);
    const store = process.env.IRIS_R09_PNPM_STORE ?? path.join(await temp('iris-r09-pnpm-store-'), 'store');
    await mkdir(store, { recursive: true, mode: 0o700 });
    const evidenceDirectory = process.env.IRIS_R09_EVIDENCE_DIR ?? await temp('iris-r09-evidence-');
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    const evidencePath = path.join(evidenceDirectory, 'r09-two-source-fallback.json');
    const receipt: Record<string, unknown> = {
      schemaVersion: 1,
      scenario: 'synthetic-two-source-executable-fallback',
      sourceA: null,
      sourceB: null,
      health: [],
      executableWitnesses: [],
      cleanup: [],
      outcome: 'IN_PROGRESS',
    };
    let releaseA: Awaited<ReturnType<typeof syntheticRelease>> | undefined;
    let releaseB: Awaited<ReturnType<typeof syntheticRelease>> | undefined;
    let assertionFailed = false;
    let unresolvedCleanup = false;
    try {
      const baselineA = 'dee5eee8682c9f929e5c41dec00ad76c78d1c5b8';
      const baselineB = '0aea216efe662395fc6789ef11ec7592887408ed';
      releaseA = await syntheticRelease(baselineA, 'SOURCE_A', store);
      releaseB = await syntheticRelease(baselineB, 'SOURCE_B', store);
      expect(releaseA.head).not.toBe(releaseB.head);
      expect(releaseA.manifest.activation.candidateFingerprint).not.toBe(releaseB.manifest.activation.candidateFingerprint);
      receipt.sourceA = { path: releaseA.path, head: releaseA.head, parent: releaseA.parent, baseCommit: releaseA.baseCommit, manifest: releaseA.manifest };
      receipt.sourceB = { path: releaseB.path, head: releaseB.head, parent: releaseB.parent, baseCommit: releaseB.baseCommit, manifest: releaseB.manifest };

      const canonicalA = await canonicalDataRoot(dataRootA);
      const runtimeIdA = await loadOrCreateRuntimeId(canonicalA);
      const machineIdA = await loadOrCreateMachineId(canonicalA);
      await initializeConnectorRegistry(canonicalA, {
        fullTunnelId: `tunnel_${'a'.repeat(32)}`,
        proTunnelId: `tunnel_${'b'.repeat(32)}`,
      });
      await bindConnectorRuntime(canonicalA, runtimeIdA, machineIdA);
      const startedAReady = await startRuntime({
        dataRoot: dataRootA, preferredPort: 0, startupDeadlineMs: 20_000,
        sourceRoot: releaseA.path, expectedSourceIdentity: releaseA.manifest.activation,
      });
      expect(startedAReady.state).toBe('running');
      expect(startedAReady.endpoint).toMatchObject({ runtimeId: runtimeIdA, machineId: machineIdA });
      expect(startedAReady.health).toMatchObject({
        status: 'ready', identityState: 'COHERENT', authority: 'owned',
        runtimeId: startedAReady.endpoint?.runtimeId,
        instanceId: startedAReady.endpoint?.instanceId,
        pid: startedAReady.endpoint?.pid,
        apiUrl: startedAReady.endpoint?.apiUrl,
        mcpUrl: startedAReady.endpoint?.mcpUrl,
        agentExecutorType: 'development',
        machineId: machineIdA,
      });
      const readyMarkerA = await readFile(path.join(canonicalA, 'r09-source-marker'), 'utf8');
      expect(readyMarkerA).toBe('SOURCE_A\\n');
      (receipt.executableWitnesses as unknown[]).push({ source: 'A', phase: 'ready', marker: readyMarkerA, head: releaseA.head });
      (receipt.health as unknown[]).push({
        phase: 'A-ready',
        state: startedAReady.state,
        status: startedAReady.health?.status,
        identityState: startedAReady.health?.identityState,
        runtimeId: startedAReady.endpoint?.runtimeId,
        instanceId: startedAReady.endpoint?.instanceId,
      });
      const stoppedAReady = await stopRuntime(dataRootA, 15_000);
      expect(stoppedAReady.state).toBe('stopped');
      await expect(probeRuntimeAuthority(canonicalA)).resolves.toEqual({ state: 'unowned' });
      (receipt.cleanup as unknown[]).push({ source: 'A-ready', state: 'STOP_COMPLETE', authority: 'unowned' });

      // Inject synthetic identity drift only after the healthy A cold-start completed.
      await bindConnectorRuntime(canonicalA, randomUUID(), machineIdA);
      const startedAFailed = await startRuntime({
        dataRoot: dataRootA, preferredPort: 0, startupDeadlineMs: 20_000,
        sourceRoot: releaseA.path, expectedSourceIdentity: releaseA.manifest.activation,
      });
      expect(startedAFailed.state).toBe('running');
      expect(startedAFailed.endpoint).not.toBeNull();
      expect(startedAFailed.health).toMatchObject({
        status: 'failed', identityState: 'SPLIT', authority: 'owned',
        runtimeId: startedAFailed.endpoint?.runtimeId,
        instanceId: startedAFailed.endpoint?.instanceId,
        pid: startedAFailed.endpoint?.pid,
        apiUrl: startedAFailed.endpoint?.apiUrl,
        mcpUrl: startedAFailed.endpoint?.mcpUrl,
        agentExecutorType: 'development',
      });
      const markerAAfterFailure = await readFile(path.join(canonicalA, 'r09-source-marker'), 'utf8');
      expect(markerAAfterFailure).toBe('SOURCE_A\\nSOURCE_A\\n');
      (receipt.executableWitnesses as unknown[]).push({
        source: 'A', phase: 'controlled-failure', marker: markerAAfterFailure, head: releaseA.head,
      });
      (receipt.health as unknown[]).push({
        phase: 'A-controlled-health-failure',
        state: startedAFailed.state,
        status: startedAFailed.health?.status,
        identityState: startedAFailed.health?.identityState,
        runtimeId: startedAFailed.endpoint?.runtimeId,
        instanceId: startedAFailed.endpoint?.instanceId,
      });
      const stoppedAFailed = await stopRuntime(dataRootA, 15_000);
      expect(stoppedAFailed.state).toBe('stopped');
      await expect(probeRuntimeAuthority(canonicalA)).resolves.toEqual({ state: 'unowned' });
      (receipt.cleanup as unknown[]).push({ source: 'A-failed', state: 'STOP_COMPLETE', authority: 'unowned' });

      const canonicalB = await canonicalDataRoot(dataRootB);
      const runtimeIdB = await loadOrCreateRuntimeId(canonicalB);
      const machineIdB = await loadOrCreateMachineId(canonicalB);
      await initializeConnectorRegistry(canonicalB, {
        fullTunnelId: `tunnel_${'c'.repeat(32)}`,
        proTunnelId: `tunnel_${'d'.repeat(32)}`,
      });
      await bindConnectorRuntime(canonicalB, runtimeIdB, machineIdB);
      const abortEvidence = path.join(canonicalB, 'r09-fallback-abort-evidence.json');
      await writeFile(abortEvidence, '{"scenario":"stale-source-attestation","preserve":true}\n', { mode: 0o600 });
      const staleB = { ...releaseB.manifest.activation, candidateFingerprint: '0'.repeat(64) };
      await expect(startRuntime({
        dataRoot: dataRootB, preferredPort: 0, startupDeadlineMs: 20_000,
        sourceRoot: releaseB.path, expectedSourceIdentity: staleB,
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(runtimeStatus(dataRootB)).resolves.toMatchObject({ state: 'stopped' });
      await expect(readEndpoint(dataRootB)).resolves.toBeNull();
      await expect(readRuntimeControl(dataRootB)).resolves.toBeNull();
      await expect(readFile(abortEvidence, 'utf8')).resolves.toContain('"preserve":true');
      await expect(readFile(path.join(canonicalB, 'r09-source-marker'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      (receipt.cleanup as unknown[]).push({ source: 'B-aborted-attestation', state: 'NOT_STARTED', evidencePreserved: true });

      const selectedB = await startRuntime({
        dataRoot: dataRootB, preferredPort: 0, startupDeadlineMs: 20_000,
        sourceRoot: releaseB.path, expectedSourceIdentity: releaseB.manifest.activation,
      });
      expect(selectedB.state).toBe('running');
      expect(selectedB.endpoint).not.toBeNull();
      expect(selectedB.health).toMatchObject({
        status: 'ready',
        identityState: 'COHERENT',
        authority: 'owned',
        agentExecutorType: 'development',
        runtimeId: selectedB.endpoint?.runtimeId,
        instanceId: selectedB.endpoint?.instanceId,
        pid: selectedB.endpoint?.pid,
        apiUrl: selectedB.endpoint?.apiUrl,
        mcpUrl: selectedB.endpoint?.mcpUrl,
        machineId: machineIdB,
      });
      const markerB = await readFile(path.join(canonicalB, 'r09-source-marker'), 'utf8');
      expect(markerB).toBe('SOURCE_B\n');
      (receipt.executableWitnesses as unknown[]).push({ source: 'B', marker: markerB, head: releaseB.head });
      (receipt.health as unknown[]).push({
        phase: 'B-fallback-ready',
        state: selectedB.state,
        status: selectedB.health?.status,
        identityState: selectedB.health?.identityState,
        runtimeId: selectedB.endpoint?.runtimeId,
        instanceId: selectedB.endpoint?.instanceId,
        pid: selectedB.endpoint?.pid,
        apiUrl: selectedB.endpoint?.apiUrl,
        mcpUrl: selectedB.endpoint?.mcpUrl,
        machineId: machineIdB,
      });
      const stoppedB = await stopRuntime(dataRootB, 15_000);
      expect(stoppedB.state).toBe('stopped');
      await expect(probeRuntimeAuthority(canonicalB)).resolves.toEqual({ state: 'unowned' });
      (receipt.cleanup as unknown[]).push({ source: 'B', state: 'STOP_COMPLETE', authority: 'unowned' });

      const afterA = await sourceManifest(releaseA.path);
      const afterB = await sourceManifest(releaseB.path);
      receipt.sourceA = { before: receipt.sourceA, after: afterA };
      receipt.sourceB = { before: receipt.sourceB, after: afterB };
      expect(afterA).toEqual(releaseA.manifest);
      expect(afterB).toEqual(releaseB.manifest);
      receipt.selection = 'Harness selected B after A returned failed health; no product auto-fallback API is claimed';
      receipt.outcome = 'PASS';
    } catch (error) {
      assertionFailed = true;
      receipt.outcome = 'FAIL';
      receipt.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      for (const [label, dataRoot] of [['A', dataRootA], ['B', dataRootB]] as const) {
        try {
          const status = await runtimeStatus(dataRoot);
          if (status.state === 'running') {
            const stopped = await stopRuntime(dataRoot, 15_000);
            (receipt.cleanup as unknown[]).push({ source: label, state: stopped.state, phase: 'finally' });
          }
          const finalStatus = await runtimeStatus(dataRoot);
          if (finalStatus.state === 'stopped') managedRuntimeRoots.delete(dataRoot);
          else {
            unresolvedCleanup = true;
            (receipt.cleanup as unknown[]).push({ source: label, state: finalStatus.state, reason: finalStatus.reason ?? 'unknown', dataPreserved: true });
          }
        } catch (cleanupError) {
          unresolvedCleanup = true;
          (receipt.cleanup as unknown[]).push({
            source: label,
            state: 'UNRESOLVED',
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            dataPreserved: true,
          });
        }
      }
      if (releaseA !== undefined) receipt.sourceA = { initial: releaseA.manifest, after: await sourceManifest(releaseA.path).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })) };
      if (releaseB !== undefined) receipt.sourceB = { initial: releaseB.manifest, after: await sourceManifest(releaseB.path).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })) };
      if (unresolvedCleanup && !assertionFailed) {
        receipt.outcome = 'UNRESOLVED_CLEANUP';
        receipt.error = 'Synthetic fallback cleanup is unresolved; preserve fixture data and diagnostics';
      }
      await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      if (unresolvedCleanup && !assertionFailed) throw new Error('Synthetic fallback cleanup is unresolved; preserve fixture data and diagnostics');
    }
  }, 480_000);

  it('rejects an identity-valid but unhydrated activation candidate before runtime spawn', async () => {
    const dataRoot = await temp('iris-lifecycle-unhydrated-');
    const candidate = await temp('iris-lifecycle-unhydrated-source-');
    await mkdir(path.join(candidate, 'apps', 'runtime', 'src'), { recursive: true });
    await mkdir(path.join(candidate, 'apps', 'web', 'src'), { recursive: true });
    await mkdir(path.join(candidate, 'packages', 'domain', 'src'), { recursive: true });
    await writeFile(path.join(candidate, 'apps', 'runtime', 'src', 'main.ts'), 'export const runtime = true;\n');
    await writeFile(path.join(candidate, 'apps', 'web', 'src', 'App.tsx'), 'export const App = () => null;\n');
    await writeFile(path.join(candidate, 'packages', 'domain', 'package.json'), '{"name":"@iris/domain","exports":{".":"./src/index.ts"}}\n');
    await writeFile(path.join(candidate, 'packages', 'domain', 'src', 'index.ts'), 'export const domain = true;\n');
    const run = promisify(execFile);
    await run('git', ['init', '-b', 'fixture'], { cwd: candidate, encoding: 'utf8', timeout: 10_000 });
    await run('git', ['add', '--', 'apps/runtime/src/main.ts', 'apps/web/src/App.tsx', 'packages/domain/package.json', 'packages/domain/src/index.ts'], {
      cwd: candidate, encoding: 'utf8', timeout: 10_000,
    });
    await run('git', [
      '-c', 'user.name=IRIS Test',
      '-c', 'user.email=iris-test@example.invalid',
      'commit', '-m', 'unhydrated activation fixture',
    ], { cwd: candidate, encoding: 'utf8', timeout: 10_000 });
    const expectedSourceIdentity = await inspectActivationSourceIdentity(candidate);

    await expect(startRuntime({
      dataRoot,
      preferredPort: 0,
      startupDeadlineMs: 15_000,
      sourceRoot: candidate,
      expectedSourceIdentity,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'stopped' });
    await expect(readEndpoint(dataRoot)).resolves.toBeNull();
    await expect(readRuntimeControl(dataRoot)).resolves.toBeNull();
  }, 30_000);

  it('recovers a matching stale schema-v1 authority and endpoint that predates runtime control metadata', async () => {
    const dataRoot = await temp('iris-lifecycle-v1-stale-');
    const canonicalRoot = await canonicalDataRoot(dataRoot);
    const runtimeId = await loadOrCreateRuntimeId(canonicalRoot);
    const stale = {
      runtimeId,
      instanceId: randomUUID(),
      pid: 2_147_483_647,
      startedAt: '2026-09-01T00:00:00.000Z',
      platform: 'darwin' as const,
      version: '0.0.0' as const,
    };
    const authorityRoot = path.join(canonicalRoot, 'authority');
    await mkdir(authorityRoot, { mode: 0o700 });
    await writeFile(path.join(authorityRoot, 'owner.lock'), `${JSON.stringify({ schemaVersion: 1, identity: stale })}\n`, { mode: 0o600 });
    await writeEndpoint(canonicalRoot, {
      schemaVersion: 1,
      runtimeId: stale.runtimeId,
      instanceId: stale.instanceId,
      pid: stale.pid,
      startedAt: stale.startedAt,
      apiUrl: 'http://127.0.0.1:43119/',
      mcpUrl: 'http://127.0.0.1:43119/mcp',
    });

    await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'stale', reason: 'STALE_AUTHORITY' });
    const recovered = await startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 15_000 });
    expect(recovered.state).toBe('running');
    expect(recovered.endpoint?.runtimeId).toBe(runtimeId);
    expect(recovered.endpoint?.instanceId).not.toBe(stale.instanceId);
    await stopRuntime(dataRoot, 15_000);
  }, 30_000);

  it('keeps a live schema-v1 authority without process-instance evidence fail-closed even with matching endpoint metadata', async () => {
    const dataRoot = await temp('iris-lifecycle-v1-live-');
    const canonicalRoot = await canonicalDataRoot(dataRoot);
    const runtimeId = await loadOrCreateRuntimeId(canonicalRoot);
    const live = {
      runtimeId,
      instanceId: randomUUID(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      platform: 'darwin' as const,
      version: '0.0.0' as const,
    };
    const authorityRoot = path.join(canonicalRoot, 'authority');
    await mkdir(authorityRoot, { mode: 0o700 });
    await writeFile(path.join(authorityRoot, 'owner.lock'), `${JSON.stringify({ schemaVersion: 1, identity: live })}\n`, { mode: 0o600 });
    await writeEndpoint(canonicalRoot, {
      schemaVersion: 1,
      runtimeId: live.runtimeId,
      instanceId: live.instanceId,
      pid: live.pid,
      startedAt: live.startedAt,
      apiUrl: 'http://127.0.0.1:43120/',
      mcpUrl: 'http://127.0.0.1:43120/mcp',
    });

    await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'indeterminate' });
    await expect(startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 2_000 })).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
  });

  it('keeps an identity-valid SPLIT daemon observable for bounded recovery without widening readiness', async () => {
    const dataRoot = await temp('iris-lifecycle-split-observable-');
    const canonicalRoot = await canonicalDataRoot(dataRoot);
    const runtimeId = await loadOrCreateRuntimeId(canonicalRoot);
    const machineId = await loadOrCreateMachineId(canonicalRoot);
    await initializeConnectorRegistry(canonicalRoot, {
      fullTunnelId: `tunnel_${'a'.repeat(32)}`,
      proTunnelId: `tunnel_${'b'.repeat(32)}`,
    });
    await bindConnectorRuntime(canonicalRoot, randomUUID(), machineId);

    const started = await startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 15_000 });
    expect(started.state).toBe('running');
    expect(started.endpoint?.runtimeId).toBe(runtimeId);
    expect(started.health).toMatchObject({ status: 'failed', identityState: 'SPLIT', identityCode: 'SPLIT_IDENTITY' });

    const observed = await runtimeStatus(dataRoot);
    expect(observed).toMatchObject({
      state: 'running',
      endpoint: { runtimeId, instanceId: started.endpoint?.instanceId },
      health: { status: 'failed', identityState: 'SPLIT', identityCode: 'SPLIT_IDENTITY' },
    });

    const stopped = await stopRuntime(dataRoot, 15_000);
    expect(stopped.state).toBe('stopped');
    expect(await probeRuntimeAuthority(canonicalRoot)).toEqual({ state: 'unowned' });
  }, 30_000);

  it('proves one daemon, safe port fallback, multi-session isolation, STOP_COMPLETE, persistence, and immediate restart', async () => {
    const dataRoot = await temp('iris-lifecycle-data-');
    managedRuntimeRoots.add(dataRoot);
    const projectAPath = await temp('iris-lifecycle-project-a-');
    const projectBPath = await temp('iris-lifecycle-project-b-');

    occupiedServer = createServer((_request, response) => response.end('occupied'));
    await new Promise<void>((resolve) => occupiedServer!.listen(0, '127.0.0.1', resolve));
    const occupiedAddress = occupiedServer.address();
    if (typeof occupiedAddress !== 'object' || occupiedAddress === null) throw new Error('Expected occupied TCP port');

    const first = await startRuntime({ dataRoot, preferredPort: occupiedAddress.port, startupDeadlineMs: 15_000 });
    expect(first.state).toBe('running');
    expect(first.endpoint).not.toBeNull();
    if (first.endpoint === null) return;
    expect(new URL(first.endpoint.apiUrl).port).not.toBe(String(occupiedAddress.port));
    expect(first.health?.authority).toBe('owned');
    const firstRuntimeId = first.endpoint.runtimeId;
    const firstInstanceId = first.endpoint.instanceId;
    const firstPid = first.endpoint.pid;

    const canonicalRoot = await canonicalDataRoot(dataRoot);
    ownerAccessToken = await readOwnerAccessSecret(canonicalRoot) ?? '';
    if (ownerAccessToken.length === 0) throw new Error('Expected private owner access credential');
    const control = await readRuntimeControl(canonicalRoot);
    if (control === null) throw new Error('Expected private runtime control metadata');
    await rm(path.join(canonicalRoot, 'control.json'));
    await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'indeterminate' });
    await writeRuntimeControl(canonicalRoot, control);
    await expect(runtimeStatus(dataRoot)).resolves.toMatchObject({ state: 'running' });

    const attachedAgain = await startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 15_000 });
    expect(attachedAgain.endpoint?.instanceId).toBe(firstInstanceId);
    expect(attachedAgain.endpoint?.apiUrl).toBe(first.endpoint.apiUrl);

    const projectA = await registerExternalProject(first.endpoint.apiUrl, 'A', projectAPath);
    const projectB = await registerExternalProject(first.endpoint.apiUrl, 'B', projectBPath);
    await json(`${first.endpoint.apiUrl}/projects/default`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: projectA.id }),
    });

    const sessionA = await json<{ id: string; currentProjectId: string | null }>(`${first.endpoint.apiUrl}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'client-a' }),
    });
    const sessionB = await json<{ id: string; currentProjectId: string | null }>(`${first.endpoint.apiUrl}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'client-b' }),
    });
    const executedA = await json<{ executionState: string; interactions: Array<{ kind: string; text: string }> }>(`${first.endpoint.apiUrl}/sessions/${sessionA.id}/instructions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-iris-client-id': 'client-a' },
      body: JSON.stringify({ submissionId: 'lifecycle-interaction-a', instruction: 'Prove local interaction continuity' }),
    });
    expect(executedA.executionState).toBe('READY');
    expect(executedA.interactions.map((event) => event.kind)).toEqual(['user', 'assistant']);
    expect(executedA.interactions[0]?.text).toBe('Prove local interaction continuity');

    const clientASessions = await json<{ sessions: Array<{ id: string; interactions: Array<{ kind: string }> }> }>(`${first.endpoint.apiUrl}/sessions`, {
      headers: { 'x-iris-client-id': 'client-a' },
    });
    expect(clientASessions.sessions.map((session) => session.id)).toEqual([sessionA.id]);
    expect(clientASessions.sessions[0]?.interactions.map((event) => event.kind)).toEqual(['user', 'assistant']);

    const reattachedWithSessions = await startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 15_000 });
    expect(reattachedWithSessions.endpoint?.instanceId).toBe(firstInstanceId);
    const clientASessionsAfterReconnect = await json<{ sessions: Array<{ id: string; interactions: Array<{ kind: string }> }> }>(`${first.endpoint.apiUrl}/sessions`, {
      headers: { 'x-iris-client-id': 'client-a' },
    });
    expect(clientASessionsAfterReconnect.sessions.map((session) => session.id)).toEqual([sessionA.id]);
    expect(clientASessionsAfterReconnect.sessions[0]?.interactions.map((event) => event.kind)).toEqual(['user', 'assistant']);

    const updatedA = await json<{ currentProjectId: string | null }>(`${first.endpoint.apiUrl}/sessions/${sessionA.id}/current-project`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-iris-client-id': 'client-a' },
      body: JSON.stringify({ projectId: projectB.id }),
    });
    const unchangedB = await json<{ currentProjectId: string | null }>(`${first.endpoint.apiUrl}/sessions/${sessionB.id}`, {
      headers: { 'x-iris-client-id': 'client-b' },
    });
    expect(updatedA.currentProjectId).toBe(projectB.id);
    expect(unchangedB.currentProjectId).toBeNull();

    const crossClient = await fetch(`${first.endpoint.apiUrl}/sessions/${sessionA.id}`, { headers: { authorization: `Bearer ${ownerAccessToken}`, 'x-iris-client-id': 'client-b' } });
    expect(crossClient.status).toBe(403);

    const projects = await json<{ defaultProjectId: string | null }>(`${first.endpoint.apiUrl}/projects`);
    expect(projects.defaultProjectId).toBe(projectA.id);
    const health = await json<{ connectedClients: number; connectedSessions: number }>(`${first.endpoint.apiUrl}/health`);
    expect(health).toMatchObject({ connectedClients: 2, connectedSessions: 2 });
    const doctor = await json<{ status: string }>(`${first.endpoint.apiUrl}/doctor`);
    expect(doctor.status).toBe('pass');

    const mcp = await json<{ result: { tools: Array<{ name: string }> } }>(first.endpoint.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        'Mcp-Method': 'tools/list',
        authorization: `Bearer ${ownerAccessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.result.tools.map((tool) => tool.name)).toEqual([
      'runtime_status', 'list_projects', 'project_info', 'git_status', 'search', 'ado_discovery', 'ado_workitem_read', 'ado_hierarchy_read', 'ado_context_search', 'ado_backlog_list', 'mission_list', 'session_open', 'session_get', 'session_close', 'session_resume', 'session_detach', 'workspace_select', 'mission_list_waiting_supervisor', 'mission_get', 'mission_events', 'mission_directive', 'mission_orchestrator_handoff', 'mission_create', 'mission_state_set', 'mission_task_create', 'mission_task_state_set', 'mission_action_prepare', 'mission_delegation_issue', 'mission_delegation_revoke', 'owner_approval_resolve', 'mission_supervisor_gate_set', 'project_test_run', 'project_validation_run', 'project_validation_discover', 'project_validation_start', 'project_validation_job', 'git_local', 'remote_publish', 'file_read', 'file_write', 'file_edit', 'file_delete', 'directory_create', 'directory_delete',
      'mission_start', 'mission_checkpoint', 'mission_resume', 'mission_rebind', 'mission_cancel', 'mission_complete', 'mission_evidence', 'workspace', 'fs', 'artifact', 'shell', 'job', 'git', 'code_review', 'security_audit', 'catalog_identity',
    ]);

    const stopped = await stopRuntime(dataRoot, 15_000);
    expect(stopped.state).toBe('stopped');
    expect(await readEndpoint(await canonicalDataRoot(dataRoot))).toBeNull();
    expect(await probeRuntimeAuthority(await canonicalDataRoot(dataRoot))).toEqual({ state: 'unowned' });
    expect(pidExists(firstPid)).toBe(false);

    const second = await startRuntime({ dataRoot, preferredPort: 0, startupDeadlineMs: 15_000 });
    expect(second.state).toBe('running');
    expect(second.endpoint?.runtimeId).toBe(firstRuntimeId);
    expect(second.endpoint?.instanceId).not.toBe(firstInstanceId);
    if (second.endpoint === null) return;
    const persisted = await json<{ projects: Array<{ id: string }>; defaultProjectId: string | null }>(`${second.endpoint.apiUrl}/projects`);
    expect(persisted.projects.map((project) => project.id)).toEqual([projectA.id, projectB.id]);
    expect(persisted.defaultProjectId).toBe(projectA.id);
    const restartedSessions = await json<{ sessions: Array<{ id: string }> }>(`${second.endpoint.apiUrl}/sessions`, {
      headers: { 'x-iris-client-id': 'client-a' },
    });
    expect(restartedSessions.sessions).toEqual([]);
    await stopRuntime(dataRoot, 15_000);
  }, 45_000);
});

async function registerExternalProject(apiUrl: string, name: string, rootPath: string): Promise<{ id: string }> {
  const response = await fetch(`${apiUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerAccessToken}` },
    body: JSON.stringify({ name, rootPath }),
  });
  expect(response.status).toBe(409);
  const pending = await response.json() as { approval: { id: string } };
  const before = await json<{ projects: Array<{ rootPath: string }> }>(`${apiUrl}/projects`);
  expect(before.projects.some((project) => project.rootPath === rootPath)).toBe(false);
  return json<{ id: string }>(`${apiUrl}/approvals/${encodeURIComponent(pending.approval.id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'ALLOW_ONCE' }),
  });
}

async function canonicalDataRoot(dataRoot: string): Promise<string> {
  const { resolveRuntimeDataRoot, RUNTIME_DATA_ENV } = await import('./data-root.js');
  return resolveRuntimeDataRoot({ ...process.env, [RUNTIME_DATA_ENV]: dataRoot });
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { return !(typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'); }
}
