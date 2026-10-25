import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { createSupervisor, type Supervisor } from './supervisor.js';
import { guidedSetup } from './setup.js';
import { readConnectorRegistry, type ConnectorSeed } from './connector-registry.js';
import { persistControlPlaneApiKey } from './credentials.js';
import { canonicalNodeRuntime } from './node-runtime.js';
import { machineIdentityPath } from './machine-identity.js';
import { runtimeStatus } from './lifecycle.js';
import { readRecoveryAuthorizationPolicy } from './recovery-policy.js';
import { installLaunchAgent, issueInitialLaunchAgentPolicy, launchdPaths, LAUNCH_AGENT_LABEL, readInitialLaunchAgentEnrollmentState, resolveReviewedRuntimeEntrypoints, type InitialLaunchAgentEnrollmentState, type LaunchdDependencies } from './launchd.js';
import { startSupervisorNativeControlServer, type SupervisorNativeControlHandle } from './supervisor-native-control.js';
import type { KeepAwakeProvider, KeepAwakeProviderSession } from './keep-awake.js';

// Only OS installation and port allocation are adapted; signed readers and registry writes remain real.
const adapters = vi.hoisted(() => ({ launchd: undefined as LaunchdDependencies | undefined, healthPort: undefined as number | undefined }));
vi.mock('./launchd.js', async (original) => {
  const actual = await original<typeof import('./launchd.js')>();
  return { ...actual, readInitialLaunchAgentEnrollmentState: (root: string, dependencies?: LaunchdDependencies) => actual.readInitialLaunchAgentEnrollmentState(root, dependencies ?? adapters.launchd) };
});
vi.mock('./connector-registry.js', async (original) => {
  const actual = await original<typeof import('./connector-registry.js')>();
  return { ...actual, initializeConnectorRegistry: (root: string, seed: ConnectorSeed) => actual.initializeConnectorRegistry(root, { ...seed, ...(adapters.healthPort === undefined ? {} : { fullHealthPort: adapters.healthPort }) }) };
});

const exec = promisify(execFile);
const fixtures: Array<{ root: string; dataRoot: string; supervisor?: Supervisor; native?: SupervisorNativeControlHandle }> = [];
type CommittedEnrollment = Extract<InitialLaunchAgentEnrollmentState, { state: 'COMMITTED' }>;
type InternalSupervisor = { nativeControlActive: boolean; restoreEnrolledControlTransport(enrollment: CommittedEnrollment): Promise<void> };
type StateEvidence = { runtime: { pid: number } | null; tunnels: { full: { pid: number; profileDigest: string; runtimeId: null; instanceId: null } | null; pro: unknown }; startupOperations: Array<{ component: string; state: string; pid: number | null }> };

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    try {
      if (fixture.supervisor !== undefined) await fixture.supervisor.down();
      expect((await runtimeStatus(fixture.dataRoot)).state).toBe('stopped');
      if (fixture.supervisor !== undefined) (fixture.supervisor as unknown as InternalSupervisor).nativeControlActive = false;
      await fixture.native?.close();
      delete fixture.native;
      await rm(fixture.root, { recursive: true, force: true });
    } finally {
      if (fixture.supervisor !== undefined) (fixture.supervisor as unknown as InternalSupervisor).nativeControlActive = false;
      await fixture.native?.close();
      adapters.launchd = undefined;
      adapters.healthPort = undefined;
      vi.unstubAllEnvs();
    }
  }
});

it('enrolls a fresh setup and restores one control-only transport with actual local health before any Runtime starts', async () => {
  vi.stubEnv('IRIS_AGENT_EXECUTOR', 'development');
  const sourceRoot = await realpath(process.env.IRIS_LOGIN_FIXTURE_SOURCE_ROOT ?? path.resolve(import.meta.dirname, '../../..'));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-blocker-login-')));
  const dataRoot = path.join(root, 'data');
  const home = path.join(root, 'home');
  const protectedReferenceRoot = path.join(root, 'protected-reference');
  for (const directory of [dataRoot, home, protectedReferenceRoot]) await mkdir(directory, { mode: 0o700 });
  const fixture: (typeof fixtures)[number] = { root, dataRoot }; fixtures.push(fixture);
  adapters.healthPort = await freePort();
  const nativePort = await freePort();
  const executable = await realpath(canonicalNodeRuntime().path);
  const controlScript = path.join(sourceRoot, 'apps/runtime/src/control.ts');
  const entrypoints = await resolveReviewedRuntimeEntrypoints(path.join(sourceRoot, 'apps/runtime'));
  const executableArguments = ['--require', entrypoints.preflight, '--import', pathToFileURL(entrypoints.loader).href];
  const launchd = fakeLaunchd(home, dataRoot, sourceRoot, executable, controlScript, executableArguments);
  adapters.launchd = launchd.dependencies;
  const tunnelExecutable = await writeLocalTunnelClient(root);
  const awake = new FixtureKeepAwake();
  const owner = `fixture-owner-${randomUUID()}`;
  await persistControlPlaneApiKey(dataRoot, owner);
  const supervisor = await createSupervisor({ dataRoot, sourceRoot, protectedReferenceRoot, tunnelClientPath: tunnelExecutable, supervisorControlPort: nativePort, webPort: await freePort(), adminPort: await freePort(), adminTunnelHealthPort: await freePort(), keepAwakeProvider: awake });
  fixture.supervisor = supervisor;

  const setup = await guidedSetup(supervisor, dataRoot, { unifiedTunnelId: `tunnel_${'d'.repeat(32)}`, start: false, json: true });
  expect(setup).toMatchObject({ status: 'READY_TO_START', repeated: false, adminTunnelId: null });
  const registry = (await readConnectorRegistry(dataRoot))!;
  expect(registry.connectors).toHaveLength(1);
  expect(registry.admin).toBeNull();
  expect(registry.connectors[0]).toMatchObject({ connectorId: 'iris-full', label: 'IRIS', healthPort: adapters.healthPort });
  const paths = launchdPaths(dataRoot, home);
  await expect(readFile(paths.metadata)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(dataRoot, 'owner-access.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await runtimeStatus(dataRoot)).state).toBe('stopped');
  const sourceSha = (await exec('/usr/bin/git', ['-C', sourceRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  const sourceTree = (await exec('/usr/bin/git', ['-C', sourceRoot, 'rev-parse', 'HEAD^{tree}'])).stdout.trim();
  const policy = await issueInitialLaunchAgentPolicy({ dataRoot, sourceRoot, executable, controlScript, executableArguments, sourceSha, sourceTree, protectedReferenceRoot, tunnelExecutable, expiresAt: new Date(Date.now() + 120_000).toISOString() }, `Bearer ${owner}`, launchd.dependencies);
  expect(policy).toMatchObject({ beforeMetadataSha256: null, beforePlistSha256: null, initialInstall: { kind: 'ABSENT', startup: 'CONTROL_ONLY' } });
  await installLaunchAgent(dataRoot, executable, controlScript, executableArguments, protectedReferenceRoot, launchd.dependencies, { recoveryPolicyId: policy.policyId, requestId: randomUUID(), sourceSha, sourceTree });
  expect(launchd.calls.filter((call) => call[0] === 'bootstrap')).toHaveLength(1);
  expect((await readRecoveryAuthorizationPolicy(dataRoot))?.operations[0]?.state).toBe('COMMITTED');
  await expect(readFile(paths.sourceBindingMigration)).rejects.toMatchObject({ code: 'ENOENT' });
  const enrolled = await readInitialLaunchAgentEnrollmentState(dataRoot);
  expect(enrolled.state).toBe('COMMITTED');
  if (enrolled.state !== 'COMMITTED') throw new Error('Real signed installation did not commit');

  const operations = {
    supervisorStatus: () => supervisor.supervisorNativeStatus(), supervisorDoctor: () => supervisor.doctor(),
    runtimeStatus: () => supervisor.runtimeStatus(), runtimeOn: () => supervisor.runtimeOn(), runtimeOff: () => supervisor.runtimeOff(),
    keepAwakeStatus: () => supervisor.keepAwakeStatus(), setKeepAwakePreference: (enabled: boolean) => supervisor.setKeepAwakePreference(enabled),
    adminStatus: () => supervisor.adminNativeStatus(), runtimeReconcile: () => supervisor.runtimeReconcile(),
    adminRecycle: (input: Parameters<Supervisor['adminRecycle']>[0]) => supervisor.adminRecycle(input),
    adminTunnelRecycle: (input: Parameters<Supervisor['adminTunnelRecycle']>[0]) => supervisor.adminTunnelRecycle(input),
    adminToolCall: (name: string, args: Record<string, unknown>) => supervisor.adminToolCall(name, args),
  };
  const native = await startSupervisorNativeControlServer(dataRoot, nativePort, operations);
  fixture.native = native;
  await expect((await fetch(native.healthUrl, { headers: { authorization: `Bearer ${owner}` } })).json()).resolves.toMatchObject({ ok: true, pid: process.pid });
  const internal = supervisor as unknown as InternalSupervisor;
  internal.nativeControlActive = true;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch(native.mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
    expect(body.result.isError, name).toBe(false);
    return body.result.structuredContent;
  };
  await expect(call('keep_awake_set', { enabled: true })).resolves.toMatchObject({ preferenceEnabled: true, requested: true, observed: 'ACTIVE' });
  const preferenceBefore = await readFile(path.join(dataRoot, 'keep-awake.json'), 'utf8');

  // This exercises the real private restoration flow, not macOS login or runDaemon signal handling.
  await internal.restoreEnrolledControlTransport(enrolled);
  const first = await stateEvidence(dataRoot);
  expect(first.runtime).toBeNull();
  expect((await runtimeStatus(dataRoot)).state).toBe('stopped');
  expect(first.tunnels.full).toMatchObject({ runtimeId: null, instanceId: null });
  expect(first.tunnels.pro).toBeNull();
  expect(first.startupOperations.filter((operation) => operation.component === 'tunnel-full' && operation.state === 'RUNNING')).toHaveLength(1);
  const tunnelPid = first.tunnels.full!.pid;
  expect((await fetch(`http://127.0.0.1:${adapters.healthPort}/readyz`)).status).toBe(200);
  const profile = await readFile(registry.connectors[0]!.managedProfilePath, 'utf8');
  expect(profile).toContain(`http://127.0.0.1:${nativePort}/mcp`);
  await expect(call('supervisor_status')).resolves.toMatchObject({ supervisorProcessId: process.pid, workloadState: 'stopped' });
  await internal.restoreEnrolledControlTransport(enrolled);
  expect((await stateEvidence(dataRoot)).tunnels.full!.pid).toBe(tunnelPid);
  expect((await stateEvidence(dataRoot)).startupOperations.filter((operation) => operation.component === 'tunnel-full' && operation.state === 'RUNNING')).toHaveLength(1);

  const identityPath = machineIdentityPath(dataRoot);
  const originalIdentity = await readFile(identityPath, 'utf8');
  try {
    await writeFile(identityPath, JSON.stringify({ schemaVersion: 1, machineId: randomUUID() }), { mode: 0o600 });
    await expect(internal.restoreEnrolledControlTransport(enrolled)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    expect((await stateEvidence(dataRoot)).tunnels.full!.pid).toBe(tunnelPid);
  } finally { await writeFile(identityPath, originalIdentity, { mode: 0o600 }); }

  await expect(call('runtime_on')).resolves.toMatchObject({ state: 'RUNNING', workloadOnly: true });
  expect((await stateEvidence(dataRoot)).tunnels.full!.pid).toBe(tunnelPid);
  await expect(call('runtime_off')).resolves.toMatchObject({ state: 'STOPPED', workloadOnly: true });
  expect((await stateEvidence(dataRoot)).tunnels.full!.pid).toBe(tunnelPid);
  expect((await stateEvidence(dataRoot)).runtime).toBeNull();
  await internal.restoreEnrolledControlTransport(enrolled);
  expect((await stateEvidence(dataRoot)).tunnels.full!.pid).toBe(tunnelPid);
  expect(await readFile(path.join(dataRoot, 'keep-awake.json'), 'utf8')).toBe(preferenceBefore);
  await expect(call('keep_awake_status')).resolves.toMatchObject({ preferenceEnabled: true, requested: true, observed: 'ACTIVE' });
  expect((await fetch(`http://127.0.0.1:${adapters.healthPort}/readyz`)).status).toBe(200);
  expect((await readConnectorRegistry(dataRoot))?.connectors).toHaveLength(1);
}, 120_000);

async function stateEvidence(root: string): Promise<StateEvidence> { return JSON.parse(await readFile(path.join(root, 'supervisor/state.json'), 'utf8')) as StateEvidence; }

function fakeLaunchd(homeDirectory: string, dataRoot: string, sourceRoot: string, executable: string, controlScript: string, argumentsList: string[]) {
  const uid = process.getuid!();
  const calls: string[][] = [];
  let loaded = false;
  const dependencies: LaunchdDependencies = {
    homeDirectory, uid,
    observeProcessStart: (pid) => pid === 4242 ? { state: 'live', marker: '1:000001' } : { state: 'dead' },
    observeProcessExecutable: (pid) => pid === 4242 ? executable : null,
    launchctl: async (args) => {
      calls.push([...args]);
      if (args[0] === 'print' && args[1] === `gui/${uid}`) return { stdout: `gui/${uid}` };
      if (args[0] === 'print-disabled') return { stdout: `disabled services = {\n"${LAUNCH_AGENT_LABEL}" => enabled\n}` };
      if (args[0] === 'enable') return { stdout: '' };
      if (args[0] === 'bootstrap') { loaded = true; return { stdout: '' }; }
      if (args[0] === 'print' && args[1] === `gui/${uid}/${LAUNCH_AGENT_LABEL}`) {
        if (!loaded) throw Object.assign(new Error('absent'), { code: 113, stdout: '', stderr: `Bad request.\nCould not find service "${LAUNCH_AGENT_LABEL}" in domain for user gui: ${uid}` });
        return { stdout: [`gui/${uid}/${LAUNCH_AGENT_LABEL} = {`, '\tpid = 4242', `\tpath = ${launchdPaths(dataRoot, homeDirectory).registeredPlist}`, `\tprogram = ${executable}`, '\targuments = {', ...[executable, ...argumentsList, controlScript, 'supervisor'].map((argument) => `\t\t${argument}`), '\t}', `\tworking directory = ${sourceRoot}`, '\tenvironment = {', `\t\tIRIS_RUNTIME_DATA_ROOT => ${dataRoot}`, '\t}', '}'].join('\n') };
      }
      throw new Error(`Unexpected fake launchctl operation: ${args[0]}`);
    },
  };
  return { dependencies, calls };
}

class FixtureKeepAwake implements KeepAwakeProvider {
  readonly id = 'blocker-login-fixture';
  private active: string | null = null;
  async probe() { return { supported: true }; }
  async start(): Promise<KeepAwakeProviderSession> { this.active = randomUUID(); return { providerSessionId: this.active }; }
  async stop(session: KeepAwakeProviderSession) { if (this.active !== session.providerSessionId) throw new Error('Wrong fixture lease'); this.active = null; }
  async observe(session: KeepAwakeProviderSession) { return this.active === session.providerSessionId; }
}

async function writeLocalTunnelClient(root: string): Promise<string> {
  const executable = path.join(root, 'tunnel-client-login-fixture.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] === 'health') {
  const origin = 'http://127.0.0.1:' + option('--port');
  const healthz = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(800) }).then(r => ({ ok: r.ok }));
  const readyz = await fetch(origin + '/readyz', { signal: AbortSignal.timeout(800) }).then(r => ({ ok: r.ok }));
  console.log(JSON.stringify({ result: healthz.ok && readyz.ok ? 'ok' : 'error', healthz, readyz }));
} else if (args[0] === 'run') {
  const profile = readFileSync(option('--profile-file'), 'utf8');
  const port = Number(profile.match(/listen_addr:.*127\\.0\\.0\\.1:(\\d+)/)?.[1]);
  const target = JSON.parse(profile.match(/^\\s+url:\\s*(.+)$/m)?.[1] ?? 'null');
  const authorization = JSON.parse(profile.match(/^\\s+Authorization:\\s*(.+)$/m)?.[1] ?? 'null');
  if (!Number.isInteger(port) || port <= 0 || !/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/mcp$/.test(target) || !authorization?.startsWith('file:')) throw new Error('Invalid local fixture profile');
  const secret = readFileSync(authorization.slice(5), 'utf8').trim();
  const server = createServer(async (request, response) => {
    if (request.url === '/healthz') { response.writeHead(200); response.end(); return; }
    if (request.url !== '/readyz') { response.writeHead(404); response.end(); return; }
    try {
      const upstream = await fetch(target, { method: 'POST', headers: { authorization: secret, 'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), signal: AbortSignal.timeout(500) });
      const result = await upstream.json();
      response.writeHead(upstream.ok && result.id === 1 && result.result ? 200 : 503); response.end();
    } catch { response.writeHead(503); response.end(); }
  });
  server.listen(port, '127.0.0.1');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} else throw new Error('Unsupported fixture command');
`, { mode: 0o700 });
  return executable;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Fixture listener address is unavailable');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
