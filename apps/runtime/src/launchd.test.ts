import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installLaunchAgent,
  issueLaunchAgentSourceApproval,
  LAUNCH_AGENT_LABEL,
  launchAgentStatus,
  launchdPaths,
  migrateLaunchAgentSource,
  reconcileMalformedLegacyApproval,
  reconcileLaunchAgentSourceApproval,
  renderLaunchAgent,
  resolveReviewedRuntimeEntrypoints,
  stopLaunchAgentForMigration,
  uninstallLaunchAgent,
  type LaunchdDependencies,
} from './launchd.js';
import { canonicalNodeRuntime, node24Path } from './node-runtime.js';
import { issueRecoveryAuthorizationPolicy, readRecoveryAuthorizationPolicy } from './recovery-policy.js';
import { promisify } from 'node:util';

const roots: string[] = [];
const sourceRoot = path.resolve(import.meta.dirname, '../../..');
const controlScript = path.join(sourceRoot, 'apps/runtime/src/control.ts');
const uid = process.getuid!();
const exec = promisify(execFile);

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface FakeLaunchd {
  dependencies: LaunchdDependencies;
  readonly calls: string[];
  loaded: boolean;
  disabled: boolean;
  disabledOutput: 'normal' | 'missing' | 'duplicate' | 'malformed';
  guiAvailable: boolean;
  bootstrap: 'success' | 'failure' | 'unknown-success';
  bootout: 'success' | 'failure' | 'unknown-success';
  enable: 'success' | 'failure' | 'unknown-success';
  disable: 'success' | 'failure' | 'unknown-success';
  queryError: Error | null;
  afterBootstrap: (() => Promise<void>) | null;
  beforeProcessObservation: ((count: number) => void) | null;
  processObservationCount: number;
  readonly live: {
    pid: number;
    processStartMarker: string;
    label: string;
    registeredPlist: string;
    executable: string;
    arguments: string[];
    workingDirectory: string;
    dataRoot: string;
  };
}

function fakeLaunchd(homeDirectory: string, dataRoot: string, executable: string): FakeLaunchd {
  const fake: FakeLaunchd = {
    calls: [],
    loaded: false,
    disabled: false,
    disabledOutput: 'normal',
    guiAvailable: true,
    bootstrap: 'success',
    bootout: 'success',
    enable: 'success',
    disable: 'success',
    queryError: null,
    afterBootstrap: null,
    beforeProcessObservation: null,
    processObservationCount: 0,
    live: {
      pid: 4242,
      processStartMarker: '1:000001',
      label: LAUNCH_AGENT_LABEL,
      registeredPlist: launchdPaths(dataRoot, homeDirectory).registeredPlist,
      executable,
      arguments: [executable, controlScript, 'supervisor'],
      workingDirectory: sourceRoot,
      dataRoot,
    },
    dependencies: {},
  };
  fake.dependencies = {
    homeDirectory,
    uid,
    observeProcessStart: (pid) => {
      fake.processObservationCount += 1;
      fake.beforeProcessObservation?.(fake.processObservationCount);
      return pid === fake.live.pid ? { state: 'live', marker: fake.live.processStartMarker } : { state: 'dead' };
    },
    observeProcessExecutable: (pid) => pid === fake.live.pid ? fake.live.executable : null,
    launchctl: async (argumentsList) => {
      fake.calls.push(argumentsList.join(' '));
      const [command, target] = argumentsList;
      if (command === 'print' && target === `gui/${uid}`) {
        if (!fake.guiAvailable) throw new Error('domain unavailable');
        return { stdout: `gui/${uid}` };
      }
      if (command === 'print' && target === `gui/${uid}/${LAUNCH_AGENT_LABEL}`) {
        if (fake.queryError !== null) throw fake.queryError;
        if (!fake.loaded) throw missingServiceError();
        return { stdout: renderLiveService(fake) };
      }
      if (command === 'print-disabled') {
        const entries = fake.disabledOutput === 'missing'
          ? ['\t"com.example.other" => enabled']
          : fake.disabledOutput === 'duplicate'
            ? [`\t"${LAUNCH_AGENT_LABEL}" => ${fake.disabled ? 'disabled' : 'enabled'}`, `\t"${LAUNCH_AGENT_LABEL}" => ${fake.disabled ? 'disabled' : 'enabled'}`]
            : fake.disabledOutput === 'malformed'
              ? [`\t"${LAUNCH_AGENT_LABEL}" = ${fake.disabled ? 'disabled' : 'enabled'}`]
              : [`\t"${LAUNCH_AGENT_LABEL}" => ${fake.disabled ? 'disabled' : 'enabled'}`];
        return { stdout: ['disabled services = {', ...entries, '}'].join('\n') };
      }
      if (command === 'enable') {
        if (fake.enable === 'failure') throw new Error('enable failed');
        fake.disabled = false;
        if (fake.enable === 'unknown-success') throw new Error('enable response lost');
        return { stdout: '' };
      }
      if (command === 'disable') {
        if (fake.disable === 'failure') throw new Error('disable failed');
        fake.disabled = true;
        if (fake.disable === 'unknown-success') throw new Error('disable response lost');
        return { stdout: '' };
      }
      if (command === 'bootstrap') {
        if (fake.bootstrap === 'failure') throw new Error('bootstrap failed');
        fake.loaded = true;
        await fake.afterBootstrap?.();
        if (fake.bootstrap === 'unknown-success') throw new Error('bootstrap response lost');
        return { stdout: '' };
      }
      if (command === 'bootout') {
        if (fake.bootout === 'failure') throw new Error('bootout failed');
        fake.loaded = false;
        if (fake.bootout === 'unknown-success') throw new Error('bootout response lost');
        return { stdout: '' };
      }
      throw new Error(`unexpected launchctl call: ${argumentsList.join(' ')}`);
    },
  };
  return fake;
}

function missingServiceError(): Error {
  return Object.assign(new Error('service unavailable'), {
    code: 113,
    stdout: '',
    stderr: `Bad request.\nCould not find service "${LAUNCH_AGENT_LABEL}" in domain for user gui: ${uid}`,
  });
}

function renderLiveService(fake: FakeLaunchd): string {
  return [
    `gui/${uid}/${fake.live.label} = {`,
    `\tpid = ${fake.live.pid}`,
    `\tpath = ${fake.live.registeredPlist}`,
    `\tprogram = ${fake.live.executable}`,
    '\targuments = {',
    ...fake.live.arguments.map((argument) => `\t\t${argument}`),
    '\t}',
    `\tworking directory = ${fake.live.workingDirectory}`,
    '\tenvironment = {',
    `\t\tIRIS_RUNTIME_DATA_ROOT => ${fake.live.dataRoot}`,
    '\t}',
    '}',
  ].join('\n');
}

async function fixture(): Promise<{ readonly dataRoot: string; readonly home: string; readonly fake: FakeLaunchd }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-launchd-test-')));
  roots.push(root);
  const dataRoot = path.join(root, 'data');
  const home = path.join(root, 'home');
  await mkdir(dataRoot, { mode: 0o700 });
  await writeFile(path.join(dataRoot, 'owner-access.json'), `${JSON.stringify({ schemaVersion: 1, secret: 'A'.repeat(43) })}\n`, { mode: 0o600 });
  await mkdir(path.join(home, 'Library'), { recursive: true, mode: 0o700 });
  return { dataRoot, home, fake: fakeLaunchd(home, dataRoot, await realpath(canonicalNodeRuntime().path)) };
}

async function approve(subject: Awaited<ReturnType<typeof fixture>>, target: Awaited<ReturnType<typeof reviewedSource>>, requestId: string) {
  return issueLaunchAgentSourceApproval({
    dataRoot: subject.dataRoot,
    sourceRoot: target.root,
    controlScript: target.controlScript,
    executable: canonicalNodeRuntime().path,
    executableArguments: target.executableArguments,
    sourceSha: target.sourceSha,
    sourceTree: target.sourceTree,
    requestId,
  }, subject.fake.dependencies);
}

const preparedBootstrap = new WeakMap<object, Promise<{
  readonly target: Awaited<ReturnType<typeof reviewedSource>>;
  readonly authorization: { readonly recoveryPolicyId: string; readonly requestId: string; readonly sourceSha: string; readonly sourceTree: string };
}>>();

async function prepareBootstrap(subject: Awaited<ReturnType<typeof fixture>>) {
  const existing = preparedBootstrap.get(subject);
  if (existing !== undefined) return existing;
  const pending = (async () => {
    const target = await reviewedSource(subject);
    const paths = launchdPaths(subject.dataRoot, subject.home);
    const executable = await realpath(canonicalNodeRuntime().path);
    const entrypoints = await resolveReviewedRuntimeEntrypoints(target.root + '/apps/runtime');
    const executableArguments = ['--require', entrypoints.preflight, '--import', pathToFileURL(entrypoints.loader).href];
    subject.fake.live.executable = executable;
    subject.fake.live.arguments = [executable, ...executableArguments, target.controlScript, 'supervisor'];
    subject.fake.live.workingDirectory = target.root;
    const machineIdPath = path.join(subject.dataRoot, 'machine-id.json');
    let machineId: string;
    try { machineId = JSON.parse(await readFile(machineIdPath, 'utf8')).machineId as string; }
    catch {
      machineId = randomUUID();
      await writeFile(machineIdPath, `${JSON.stringify({ schemaVersion: 1, machineId })}\n`, { mode: 0o600 });
    }
    let metadataRaw: string;
    try { metadataRaw = await readFile(paths.metadata, 'utf8'); }
    catch {
      const plist = renderLaunchAgent(subject.dataRoot, executable, target.controlScript, executableArguments);
      metadataRaw = `${JSON.stringify({
        schemaVersion: 3,
        label: LAUNCH_AGENT_LABEL,
        domain: `gui/${uid}`,
        dataRoot: subject.dataRoot,
        sourceRoot: target.root,
        executable,
        controlScript: target.controlScript,
        executableArguments,
        plist: paths.plist,
        registeredPlist: paths.registeredPlist,
        plistSha256: createHash('sha256').update(plist).digest('hex'),
        state: 'PREPARED',
        disabledBeforeInstall: subject.fake.disabled,
        disabledStateBeforeInstall: subject.fake.disabledOutput === 'missing' ? 'NO_EXPLICIT_OVERRIDE' : subject.fake.disabled ? 'EXPLICIT_DISABLED' : 'EXPLICIT_ENABLED',
        unresolvedReason: null,
      }, null, 2)}\n`;
      await mkdir(paths.directory, { recursive: true, mode: 0o700 });
      await writeFile(paths.plist, plist, { mode: 0o600 });
      await writeFile(paths.metadata, metadataRaw, { mode: 0o600 });
    }
    const legacyMetadata = (() => { try { return JSON.parse(metadataRaw).schemaVersion === 1; } catch { return false; } })();
    try { await readFile(paths.sourceBindingMigration, 'utf8'); }
    catch {
      if (legacyMetadata) return { target, authorization: { recoveryPolicyId: '', requestId: randomUUID(), sourceSha: target.sourceSha, sourceTree: target.sourceTree } };
      let plistRaw: string;
      try { plistRaw = await readFile(paths.plist, 'utf8'); }
      catch { plistRaw = renderLaunchAgent(subject.dataRoot, executable, target.controlScript, executableArguments); await mkdir(paths.directory, { recursive: true, mode: 0o700 }); await writeFile(paths.plist, plistRaw, { mode: 0o600 }); }
      const migration = {
        schemaVersion: 1,
        transactionId: randomUUID(),
        requestId: randomUUID(),
        state: 'COMMITTED',
        label: LAUNCH_AGENT_LABEL,
        domain: `gui/${uid}`,
        dataRoot: subject.dataRoot,
        beforeMetadataSha256: createHash('sha256').update(metadataRaw).digest('hex'),
        beforePlistSha256: createHash('sha256').update(plistRaw).digest('hex'),
        legacyMetadataRaw: metadataRaw,
        targetSourceRoot: target.root,
        targetControlScript: target.controlScript,
        targetExecutable: executable,
        targetExecutableArguments: executableArguments,
        runtimePreflightSha256: createHash('sha256').update(await readFile(entrypoints.preflight)).digest('hex'),
        runtimeLoaderSha256: createHash('sha256').update(await readFile(entrypoints.loader)).digest('hex'),
        targetSourceSha: target.sourceSha,
        targetSourceTree: target.sourceTree,
        approvalId: randomUUID(),
      };
      await writeFile(paths.sourceBindingMigration, `${JSON.stringify(migration, null, 2)}\n`, { mode: 0o600 });
    }
    return { target, authorization: { recoveryPolicyId: '', requestId: randomUUID(), sourceSha: target.sourceSha, sourceTree: target.sourceTree } };
  })();
  preparedBootstrap.set(subject, pending);
  return pending;
}

async function install(subject: Awaited<ReturnType<typeof fixture>>) {
  const prepared = await prepareBootstrap(subject);
  const entrypoints = await resolveReviewedRuntimeEntrypoints(path.join(prepared.target.root, 'apps', 'runtime'));
  const executable = await realpath(canonicalNodeRuntime().path);
  const executableArguments = ['--require', entrypoints.preflight, '--import', pathToFileURL(entrypoints.loader).href];
  const authorization = await issueBootstrapAuthorization(subject, prepared, executable, executableArguments);
  return installLaunchAgent(subject.dataRoot, executable, prepared.target.controlScript, executableArguments, undefined, subject.fake.dependencies, authorization);
}

async function issueBootstrapAuthorization(
  subject: Awaited<ReturnType<typeof fixture>>,
  prepared: Awaited<ReturnType<typeof prepareBootstrap>>,
  executable: string,
  executableArguments: readonly string[],
) {
  const paths = launchdPaths(subject.dataRoot, subject.home);
  const entrypoints = await resolveReviewedRuntimeEntrypoints(path.join(prepared.target.root, 'apps', 'runtime'));
  const machineId = JSON.parse(await readFile(path.join(subject.dataRoot, 'machine-id.json'), 'utf8')).machineId as string;
  const metadataRaw = await readFile(paths.metadata, 'utf8');
  const plistRaw = await readFile(paths.plist, 'utf8');
  const policy = await issueRecoveryAuthorizationPolicy({
      dataRoot: subject.dataRoot,
      sourceBindings: [{ sourceSha: prepared.target.sourceSha, sourceTree: prepared.target.sourceTree, sourceRoot: prepared.target.root, controlScript: prepared.target.controlScript, executable, executableSha256: createHash('sha256').update(await readFile(executable)).digest('hex'), executableArguments, runtimePreflightSha256: createHash('sha256').update(await readFile(entrypoints.preflight)).digest('hex'), runtimeLoaderSha256: createHash('sha256').update(await readFile(entrypoints.loader)).digest('hex') }],
      beforeMetadataSha256: createHash('sha256').update(metadataRaw).digest('hex'),
      beforePlistSha256: createHash('sha256').update(plistRaw).digest('hex'),
      allowedOperations: ['SUPERVISOR_BOOTSTRAP'],
      machineId,
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).catch(async (error) => {
      const existing = await readRecoveryAuthorizationPolicy(subject.dataRoot);
      if (!subject.fake.loaded || existing === null || existing.state !== 'ISSUED') throw error;
      return existing;
    });
  return {
    recoveryPolicyId: policy.policyId,
    requestId: randomUUID(),
    sourceSha: prepared.target.sourceSha,
    sourceTree: prepared.target.sourceTree,
  } as const;
}

async function writeLegacyLaunchAgent(subject: Awaited<ReturnType<typeof fixture>>): Promise<{ readonly metadata: string; readonly plist: string }> {
  const paths = launchdPaths(subject.dataRoot, subject.home);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const plist = renderLaunchAgent(subject.dataRoot, canonicalNodeRuntime().path, controlScript);
  const metadata = `${JSON.stringify({
    schemaVersion: 1,
    label: LAUNCH_AGENT_LABEL,
    executable: canonicalNodeRuntime().path,
    controlScript,
    executableArguments: [],
    plist: paths.plist,
  }, null, 2)}\n`;
  await writeFile(paths.plist, plist, { mode: 0o600 });
  await writeFile(paths.metadata, metadata, { mode: 0o600 });
  return { metadata, plist };
}

async function reviewedSource(subject: Awaited<ReturnType<typeof fixture>>, name = 'reviewed-control-source'): Promise<{
  readonly root: string;
  readonly controlScript: string;
  readonly executableArguments: readonly string[];
  readonly sourceSha: string;
  readonly sourceTree: string;
}> {
  const root = path.join(path.dirname(subject.dataRoot), name);
  const runtime = path.join(root, 'apps', 'runtime');
  const controlScript = path.join(runtime, 'src', 'control.ts');
  const packageRoot = path.join(root, 'node_modules', '.pnpm', 'tsx@4.23.13', 'node_modules', 'tsx');
  const tsx = path.join(packageRoot, 'dist');
  await mkdir(path.dirname(controlScript), { recursive: true, mode: 0o700 });
  await mkdir(tsx, { recursive: true, mode: 0o700 });
  await mkdir(path.join(runtime, 'node_modules'), { recursive: true, mode: 0o700 });
  await symlink('../../../node_modules/.pnpm/tsx@4.23.13/node_modules/tsx', path.join(runtime, 'node_modules', 'tsx'));
  await writeFile(controlScript, 'export {};\n', { mode: 0o600 });
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n', { mode: 0o600 });
  await writeFile(path.join(tsx, 'preflight.cjs'), 'module.exports = {};\n', { mode: 0o600 });
  await writeFile(path.join(tsx, 'loader.mjs'), 'export {};\n', { mode: 0o600 });
  await exec('/usr/bin/git', ['init', '-b', 'main'], { cwd: root });
  await exec('/usr/bin/git', ['config', 'user.email', 'iris-test@example.invalid'], { cwd: root });
  await exec('/usr/bin/git', ['config', 'user.name', 'IRIS test'], { cwd: root });
  await exec('/usr/bin/git', ['add', '--', '.'], { cwd: root });
  await exec('/usr/bin/git', ['commit', '-m', 'reviewed control source'], { cwd: root });
  const sourceSha = (await exec('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const sourceTree = (await exec('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { cwd: root })).stdout.trim();
  roots.push(root);
  return {
    root,
    controlScript,
    executableArguments: ['--require', path.join(tsx, 'preflight.cjs'), '--import', `file://${path.join(tsx, 'loader.mjs')}`],
    sourceSha,
    sourceTree,
  };
}

describe('IRIS LaunchAgent artifact', () => {
  it('resolves the pnpm tsx link only within the reviewed source dependency tree', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-runtime-entrypoints-')));
    roots.push(root);
    const runtime = path.join(root, 'apps', 'runtime');
    const packageRoot = path.join(root, 'node_modules', '.pnpm', 'tsx@4.23.13', 'node_modules', 'tsx');
    await mkdir(path.join(runtime, 'node_modules'), { recursive: true, mode: 0o755 });
    await mkdir(path.join(packageRoot, 'dist'), { recursive: true, mode: 0o755 });
    await writeFile(path.join(packageRoot, 'dist', 'preflight.cjs'), 'module.exports = {}\n', { mode: 0o755 });
    await writeFile(path.join(packageRoot, 'dist', 'loader.mjs'), 'export {}\n', { mode: 0o755 });
    await symlink('../../../node_modules/.pnpm/tsx@4.23.13/node_modules/tsx', path.join(runtime, 'node_modules', 'tsx'));

    const resolved = await resolveReviewedRuntimeEntrypoints(runtime);
    expect(resolved.preflight).toBe(path.join(packageRoot, 'dist', 'preflight.cjs'));
    expect(resolved.loader).toBe(path.join(packageRoot, 'dist', 'loader.mjs'));
  });

  it('rejects a tsx dependency link that escapes the reviewed source', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-runtime-entrypoints-')));
    roots.push(root);
    const runtime = path.join(root, 'apps', 'runtime');
    const outside = path.join(root, 'outside-tsx');
    await mkdir(path.join(runtime, 'node_modules'), { recursive: true, mode: 0o755 });
    await mkdir(path.join(outside, 'dist'), { recursive: true, mode: 0o755 });
    await writeFile(path.join(outside, 'dist', 'preflight.cjs'), 'module.exports = {}\n', { mode: 0o755 });
    await writeFile(path.join(outside, 'dist', 'loader.mjs'), 'export {}\n', { mode: 0o755 });
    await symlink(outside, path.join(runtime, 'node_modules', 'tsx'));

    await expect(resolveReviewedRuntimeEntrypoints(runtime)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('rejects an entrypoint file substituted through a symlink', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-runtime-entrypoints-')));
    roots.push(root);
    const runtime = path.join(root, 'apps', 'runtime');
    const packageRoot = path.join(root, 'node_modules', '.pnpm', 'tsx@4.23.13', 'node_modules', 'tsx');
    const outside = path.join(root, 'outside-entrypoint.cjs');
    await mkdir(path.join(runtime, 'node_modules'), { recursive: true, mode: 0o755 });
    await mkdir(path.join(packageRoot, 'dist'), { recursive: true, mode: 0o755 });
    await writeFile(outside, 'module.exports = {}\n', { mode: 0o755 });
    await symlink('../../../node_modules/.pnpm/tsx@4.23.13/node_modules/tsx', path.join(runtime, 'node_modules', 'tsx'));
    await symlink(outside, path.join(packageRoot, 'dist', 'preflight.cjs'));
    await writeFile(path.join(packageRoot, 'dist', 'loader.mjs'), 'export {}\n', { mode: 0o755 });

    await expect(resolveReviewedRuntimeEntrypoints(runtime)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('rejects writable intermediate pnpm dependency directories', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-runtime-entrypoints-')));
    roots.push(root);
    const runtime = path.join(root, 'apps', 'runtime');
    const pnpmRoot = path.join(root, 'node_modules', '.pnpm');
    const packageRoot = path.join(pnpmRoot, 'tsx@4.23.13', 'node_modules', 'tsx');
    await mkdir(path.join(runtime, 'node_modules'), { recursive: true, mode: 0o755 });
    await mkdir(path.join(packageRoot, 'dist'), { recursive: true, mode: 0o755 });
    await writeFile(path.join(packageRoot, 'dist', 'preflight.cjs'), 'module.exports = {}\n', { mode: 0o755 });
    await writeFile(path.join(packageRoot, 'dist', 'loader.mjs'), 'export {}\n', { mode: 0o755 });
    await symlink('../../../node_modules/.pnpm/tsx@4.23.13/node_modules/tsx', path.join(runtime, 'node_modules', 'tsx'));
    await chmod(pnpmRoot, 0o777);

    await expect(resolveReviewedRuntimeEntrypoints(runtime)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('contains only non-secret process configuration and exact source/data bindings', () => {
    const node = canonicalNodeRuntime();
    const dataRoot = '/Users/example/Library/Application Support/IRIS';
    const script = '/Users/example/iris/apps/runtime/dist/control.js';
    const withoutProtectedRoot = renderLaunchAgent(dataRoot, node.path, script);
    expect(withoutProtectedRoot).not.toContain('IRIS_PROTECTED_REFERENCE_ROOT');

    const plist = renderLaunchAgent(dataRoot, node.path, script, [], '/Users/example/iris-native-runtime');
    expect(plist).toContain(`<key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain('<string>supervisor</string>');
    expect(plist).toContain(`<key>WorkingDirectory</key><string>/Users/example/iris</string>`);
    expect(plist).toContain(`<key>IRIS_RUNTIME_DATA_ROOT</key><string>${dataRoot}</string>`);
    expect(plist).toContain(`${node24Path(node.path)}`);
    expect(plist).toContain('<key>IRIS_PROTECTED_REFERENCE_ROOT</key><string>/Users/example/iris-native-runtime</string>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(plist).not.toContain('/.hermes/node/bin');
    expect(plist).not.toContain('Authorization');
    expect(plist).not.toContain('api_key');
    expect(plist).not.toContain('Bearer');
  });

  it('publishes a private user LaunchAgent and rejects replay without a fresh operation', async () => {
    const subject = await fixture();
    const paths = await install(subject);
    expect(paths.registeredPlist).toBe(path.join(subject.home, 'Library/LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`));
    expect(await readFile(paths.registeredPlist, 'utf8')).toBe(await readFile(paths.plist, 'utf8'));
    expect((await lstat(paths.registeredPlist)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.plist)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.metadata)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({
      schemaVersion: 3,
      state: 'READY',
      dataRoot: subject.dataRoot,
      sourceRoot: (await prepareBootstrap(subject)).target.root,
      registeredPlist: paths.registeredPlist,
    });
    expect(await launchAgentStatus(subject.dataRoot, subject.fake.dependencies)).toMatchObject({ loaded: true, disabled: false, disabledState: 'EXPLICIT_ENABLED', registered: true });
    await expect(install(subject)).rejects.toThrow(/before-image|operation limit|unresolved operation/);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(1);
  });

  it('refuses conflicting plists, symlinks, and unsafe ownership', async () => {
    const conflict = await fixture();
    conflict.fake.disabled = true;
    const conflictPaths = launchdPaths(conflict.dataRoot, conflict.home);
    await mkdir(conflictPaths.registrationDirectory, { recursive: true, mode: 0o700 });
    await writeFile(conflictPaths.registeredPlist, 'foreign service', { mode: 0o600 });
    await expect(install(conflict)).rejects.toThrow(/conflicts with the requested installation|unexpected registered LaunchAgent/);
    expect(conflict.fake.disabled).toBe(true);
    expect(conflict.fake.calls.some((call) => call.startsWith('enable '))).toBe(false);

    const linked = await fixture();
    const linkedPaths = launchdPaths(linked.dataRoot, linked.home);
    await mkdir(linkedPaths.registrationDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(linked.home, 'foreign.plist');
    await writeFile(target, 'foreign', { mode: 0o600 });
    await symlink(target, linkedPaths.registeredPlist);
    await expect(install(linked)).rejects.toThrow(/not a physical file|unexpected registered LaunchAgent/);

    const wrongOwner = await fixture();
    await expect(installLaunchAgent(wrongOwner.dataRoot, canonicalNodeRuntime().path, controlScript, [], undefined, {
      ...wrongOwner.fake.dependencies,
      uid: uid + 1,
    })).rejects.toThrow(/ownership or permissions are unsafe|explicit recovery policy authorization/);
  });

  it('requires a GUI domain and explicitly reconciles disabled state', async () => {
    const missing = await fixture();
    missing.fake.guiAvailable = false;
    await expect(install(missing)).rejects.toThrow(/launchd domain is unavailable/);

    const disabled = await fixture();
    disabled.fake.disabled = true;
    await install(disabled);
    expect(disabled.fake.calls).toContain(`enable gui/${uid}/${LAUNCH_AGENT_LABEL}`);
    expect(disabled.fake.disabled).toBe(false);
    disabled.fake.disabled = true;
    await expect(install(disabled)).rejects.toThrow(/before-image|operation limit|unresolved operation/);
    expect(disabled.fake.disabled).toBe(true);
    await uninstallLaunchAgent(disabled.dataRoot, disabled.fake.dependencies);
    expect(disabled.fake.disabled).toBe(true);

    const enableFailure = await fixture();
    enableFailure.fake.disabled = true;
    enableFailure.fake.enable = 'failure';
    await expect(install(enableFailure)).rejects.toThrow(/Could not install/);
    expect(enableFailure.fake.disabled).toBe(true);
    expect(JSON.parse(await readFile(launchdPaths(enableFailure.dataRoot, enableFailure.home).metadata, 'utf8'))).toMatchObject({ state: 'PREPARED' });
    await expect(lstat(launchdPaths(enableFailure.dataRoot, enableFailure.home).registeredPlist)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('parses real print-disabled structure and distinguishes no override from invalid state', async () => {
    const noOverride = await fixture();
    noOverride.fake.disabledOutput = 'missing';
    await expect(install(noOverride)).resolves.toMatchObject({ registeredPlist: expect.stringContaining(LAUNCH_AGENT_LABEL) });
    expect(noOverride.fake.calls.some((call) => call.startsWith('enable '))).toBe(false);
    await expect(launchAgentStatus(noOverride.dataRoot, noOverride.fake.dependencies)).resolves.toMatchObject({ disabled: false, disabledState: 'NO_EXPLICIT_OVERRIDE' });
    await expect(uninstallLaunchAgent(noOverride.dataRoot, noOverride.fake.dependencies)).resolves.toBeUndefined();
    expect(noOverride.fake.calls.some((call) => call.startsWith('disable '))).toBe(false);

    for (const disabledOutput of ['duplicate', 'malformed'] as const) {
      const subject = await fixture();
      subject.fake.disabledOutput = disabledOutput;
      await expect(install(subject)).rejects.toThrow(/disabled state.+unknown|requires reconciliation/);
      expect(subject.fake.calls.some((call) => call.startsWith('enable ') || call.startsWith('disable ') || call.startsWith('bootstrap '))).toBe(false);
    }

    const transaction = await fixture();
    transaction.fake.disabled = true;
    transaction.fake.enable = 'unknown-success';
    await expect(install(transaction)).resolves.toMatchObject({ registeredPlist: expect.stringContaining(LAUNCH_AGENT_LABEL) });
    expect(transaction.fake.disabled).toBe(false);
    transaction.fake.disable = 'unknown-success';
    await expect(uninstallLaunchAgent(transaction.dataRoot, transaction.fake.dependencies)).resolves.toBeUndefined();
    expect(transaction.fake.disabled).toBe(true);
  });

  it('rejects schema-1 installation until migration is completed separately and preserves legacy evidence', async () => {
    const subject = await fixture();
    subject.fake.disabled = true;
    const legacy = await writeLegacyLaunchAgent(subject);
    await expect(install(subject)).rejects.toThrow(/committed source migration/);
    const paths = launchdPaths(subject.dataRoot, subject.home);
    expect(await readFile(paths.metadata, 'utf8')).toBe(legacy.metadata);
    expect(await readFile(paths.plist, 'utf8')).toBe(legacy.plist);
    expect(subject.fake.calls.some((call) => call.startsWith('bootstrap '))).toBe(false);
    expect(subject.fake.calls.some((call) => call.startsWith('enable '))).toBe(false);
  });

  it('migrates a stopped legacy source binding without bootstrapping and journals exact provenance', async () => {
    const subject = await fixture();
    const legacy = await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    const result = await migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: approval.approvalId,
      requestId,
    }, subject.fake.dependencies);
    const paths = launchdPaths(subject.dataRoot, subject.home);
    expect(result.state).toBe('COMMITTED');
    expect(subject.fake.calls.some((call) => call.startsWith('bootstrap '))).toBe(false);
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({
      schemaVersion: 3,
      state: 'PREPARED',
      sourceRoot: target.root,
      controlScript: target.controlScript,
      legacyMigration: { fromSchemaVersion: 1, observedState: 'ABSENT' },
    });
    expect(JSON.parse(await readFile(paths.sourceBindingMigration, 'utf8'))).toMatchObject({
      state: 'COMMITTED',
      targetSourceSha: target.sourceSha,
      targetSourceTree: target.sourceTree,
      legacyMetadataRaw: legacy.metadata,
    });
    expect(await readFile(paths.plist, 'utf8')).toContain(target.controlScript);
    await expect(lstat(paths.registeredPlist)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: approval.approvalId,
      requestId,
    }, subject.fake.dependencies)).resolves.toMatchObject({ state: 'COMMITTED', transactionId: result.transactionId });
    expect(subject.fake.calls.some((call) => call.startsWith('bootstrap '))).toBe(false);
    await writeFile(paths.plist, `${await readFile(paths.plist, 'utf8')}\n`, { mode: 0o600 });
    await expect(migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: approval.approvalId,
      requestId,
    }, subject.fake.dependencies)).rejects.toThrow(/target plist no longer matches/);
  });

  it('supersedes a committed schema-3 source binding without losing migration history', async () => {
    const subject = await fixture();
    await prepareBootstrap(subject);
    const next = await reviewedSource(subject, 'next-reviewed-control-source');
    const paths = launchdPaths(subject.dataRoot, subject.home);
    const previousMigration = await readFile(paths.sourceBindingMigration, 'utf8');
    const requestId = randomUUID();
    const approval = await approve(subject, next, requestId);
    const result = await migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: next.root,
      controlScript: next.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: next.executableArguments,
      sourceSha: next.sourceSha,
      sourceTree: next.sourceTree,
      approvalId: approval.approvalId,
      requestId,
    }, subject.fake.dependencies);
    expect(result.state).toBe('COMMITTED');
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({ schemaVersion: 3, sourceRoot: next.root, controlScript: next.controlScript });
    expect(JSON.parse(await readFile(paths.sourceBindingMigration, 'utf8'))).toMatchObject({ state: 'COMMITTED', targetSourceSha: next.sourceSha, targetSourceTree: next.sourceTree });
    expect((JSON.parse(await readFile(paths.sourceBindingMigrationHistory, 'utf8')) as Array<{ raw: string }>).some((entry) => entry.raw === previousMigration)).toBe(true);
    expect(subject.fake.calls.some((call) => call.startsWith('bootstrap '))).toBe(false);
  });

  it('requires and commits a distinct source-bound Supervisor bootstrap policy after migration', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const migrationRequestId = randomUUID();
    const approval = await approve(subject, target, migrationRequestId);
    await migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: approval.approvalId,
      requestId: migrationRequestId,
    }, subject.fake.dependencies);
    subject.fake.live.arguments = [subject.fake.live.executable, ...target.executableArguments, target.controlScript, 'supervisor'];
    subject.fake.live.executable = await realpath(canonicalNodeRuntime().path);
    subject.fake.live.workingDirectory = target.root;
    const paths = launchdPaths(subject.dataRoot, subject.home);
    const machineId = randomUUID();
    await writeFile(path.join(subject.dataRoot, 'machine-id.json'), `${JSON.stringify({ schemaVersion: 1, machineId })}\n`, { mode: 0o600 });
    const metadataRaw = await readFile(paths.metadata, 'utf8');
    const plistRaw = await readFile(paths.plist, 'utf8');
    const preflight = target.executableArguments[1]!;
    const loader = new URL(target.executableArguments[3]!).pathname;
    const bootstrapPolicy = await issueRecoveryAuthorizationPolicy({
      dataRoot: subject.dataRoot,
      sourceBindings: [{
        sourceSha: target.sourceSha,
        sourceTree: target.sourceTree,
        sourceRoot: target.root,
        controlScript: target.controlScript,
        executable: await realpath(canonicalNodeRuntime().path),
        executableSha256: createHash('sha256').update(await readFile(await realpath(canonicalNodeRuntime().path))).digest('hex'),
        executableArguments: target.executableArguments,
        runtimePreflightSha256: createHash('sha256').update(await readFile(preflight)).digest('hex'),
        runtimeLoaderSha256: createHash('sha256').update(await readFile(loader)).digest('hex'),
      }],
      beforeMetadataSha256: createHash('sha256').update(metadataRaw).digest('hex'),
      beforePlistSha256: createHash('sha256').update(plistRaw).digest('hex'),
      allowedOperations: ['SUPERVISOR_BOOTSTRAP'],
      machineId,
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await installLaunchAgent(subject.dataRoot, canonicalNodeRuntime().path, target.controlScript, target.executableArguments, undefined, subject.fake.dependencies, {
      recoveryPolicyId: bootstrapPolicy.policyId,
      requestId: randomUUID(),
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
    });
    const policy = await readRecoveryAuthorizationPolicy(subject.dataRoot);
    expect(policy?.operations).toHaveLength(1);
    expect(policy?.operations[0]).toMatchObject({ operation: 'SUPERVISOR_BOOTSTRAP', state: 'COMMITTED' });
  });

  it('rejects Supervisor installation without an explicit bootstrap authorization', async () => {
    const subject = await fixture();
    await expect(installLaunchAgent(subject.dataRoot, canonicalNodeRuntime().path, controlScript, [], undefined, subject.fake.dependencies))
      .rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    expect(subject.fake.calls).toHaveLength(0);
  });

  it('completes a policy-bound approval and migration with one request identity', async () => {
    const subject = await fixture();
    const legacy = await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const reviewedExecutable = await realpath(canonicalNodeRuntime().path);
    const preflightSha = createHash('sha256').update(await readFile(target.executableArguments[1]!)).digest('hex');
    const loaderSha = createHash('sha256').update(await readFile(target.executableArguments[3]!.slice('file://'.length))).digest('hex');
    const policy = await issueRecoveryAuthorizationPolicy({
      dataRoot: subject.dataRoot,
      sourceBindings: [{ sourceSha: target.sourceSha, sourceTree: target.sourceTree, sourceRoot: target.root, controlScript: target.controlScript, executable: reviewedExecutable, executableArguments: target.executableArguments, runtimePreflightSha256: preflightSha, runtimeLoaderSha256: loaderSha }],
      beforeMetadataSha256: createHash('sha256').update(legacy.metadata).digest('hex'),
      beforePlistSha256: createHash('sha256').update(legacy.plist).digest('hex'),
      allowedOperations: ['MIGRATION_APPROVAL', 'SOURCE_MIGRATION'],
      maxOperationCount: 2,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const requestId = randomUUID();
    const approval = await issueLaunchAgentSourceApproval({ dataRoot: subject.dataRoot, sourceRoot: target.root, controlScript: target.controlScript, executable: reviewedExecutable, executableArguments: target.executableArguments, sourceSha: target.sourceSha, sourceTree: target.sourceTree, requestId, recoveryPolicyId: policy.policyId }, subject.fake.dependencies);
    const result = await migrateLaunchAgentSource({ dataRoot: subject.dataRoot, sourceRoot: target.root, controlScript: target.controlScript, executable: reviewedExecutable, executableArguments: target.executableArguments, sourceSha: target.sourceSha, sourceTree: target.sourceTree, approvalId: approval.approvalId, requestId, recoveryPolicyId: policy.policyId }, subject.fake.dependencies);
    expect(result.state).toBe('COMMITTED');
  });

  it('requires an untampered owner-secret-bound approval before publication', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    const paths = launchdPaths(subject.dataRoot, subject.home);
    const tampered = JSON.parse(await readFile(paths.sourceBindingApproval, 'utf8')) as Record<string, unknown>;
    tampered.sourceTree = '0'.repeat(40);
    await writeFile(paths.sourceBindingApproval, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    await expect(migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: approval.approvalId,
      requestId,
    }, subject.fake.dependencies)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    expect(await readFile(paths.metadata, 'utf8')).toContain('"schemaVersion": 1');
    expect(await readFile(paths.plist, 'utf8')).toContain(subject.dataRoot);
  });

  it('reconciles a stale approval and archives it before issuing a new source-bound approval', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const firstTarget = await reviewedSource(subject);
    const firstRequestId = randomUUID();
    const first = await approve(subject, firstTarget, firstRequestId);
    const reconciled = await reconcileLaunchAgentSourceApproval({
      dataRoot: subject.dataRoot,
      requestId: firstRequestId,
      sourceSha: firstTarget.sourceSha,
      sourceTree: firstTarget.sourceTree,
    }, subject.fake.dependencies);
    expect(reconciled).toMatchObject({ approvalId: first.approvalId, state: 'RECONCILIATION_REQUIRED' });
    const second = await approve(subject, firstTarget, randomUUID());
    expect(second).toMatchObject({ state: 'ISSUED', sourceSha: firstTarget.sourceSha, sourceTree: firstTarget.sourceTree });
    const history = JSON.parse(await readFile(launchdPaths(subject.dataRoot, subject.home).sourceBindingApprovalHistory, 'utf8')) as Array<{ record: { readonly approvalId: string; readonly state: string } }>;
    expect(history).toHaveLength(1);
    expect(history[0]?.record).toMatchObject({ approvalId: first.approvalId, state: 'RECONCILIATION_REQUIRED' });
  });

  it('refuses approval reconciliation when protected before-images changed or the signature is invalid', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    const paths = launchdPaths(subject.dataRoot, subject.home);
    await writeFile(paths.metadata, `${await readFile(paths.metadata, 'utf8')}\n`, { mode: 0o600 });
    await expect(reconcileLaunchAgentSourceApproval({ dataRoot: subject.dataRoot, requestId, sourceSha: target.sourceSha, sourceTree: target.sourceTree }, subject.fake.dependencies)).rejects.toMatchObject({ code: 'SUPERVISOR_NOT_RUNNING' });
    await writeFile(paths.metadata, (await writeLegacyLaunchAgent(subject)).metadata, { mode: 0o600 });
    const tampered = JSON.parse(await readFile(paths.sourceBindingApproval, 'utf8')) as Record<string, unknown>;
    tampered.signature = '0'.repeat(64);
    await writeFile(paths.sourceBindingApproval, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    await expect(reconcileLaunchAgentSourceApproval({ dataRoot: subject.dataRoot, requestId, sourceSha: target.sourceSha, sourceTree: target.sourceTree }, subject.fake.dependencies)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    expect(JSON.parse(await readFile(paths.sourceBindingApproval, 'utf8'))).toMatchObject({ approvalId: approval.approvalId, state: 'ISSUED' });
  });

  it('does not reconcile an approval already consumed by migration', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    await migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: approval.approvalId,
      requestId,
    }, subject.fake.dependencies);
    await expect(reconcileLaunchAgentSourceApproval({ dataRoot: subject.dataRoot, requestId, sourceSha: target.sourceSha, sourceTree: target.sourceTree }, subject.fake.dependencies)).rejects.toMatchObject({ code: 'SUPERVISOR_NOT_RUNNING' });
  });

  it('fails closed when approval history contains a conflicting same-id entry', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    await reconcileLaunchAgentSourceApproval({ dataRoot: subject.dataRoot, requestId, sourceSha: target.sourceSha, sourceTree: target.sourceTree }, subject.fake.dependencies);
    const paths = launchdPaths(subject.dataRoot, subject.home);
    await writeFile(paths.sourceBindingApprovalHistory, `${JSON.stringify([{ record: { approvalId: approval.approvalId } }])}\n`, { mode: 0o600 });
    await expect(approve(subject, target, randomUUID())).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    expect(JSON.parse(await readFile(paths.sourceBindingApproval, 'utf8'))).toMatchObject({ approvalId: approval.approvalId, state: 'RECONCILIATION_REQUIRED' });
  });

  it('does not return a legacy schema-1 approval as reusable authorization', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const approval = await approve(subject, target, randomUUID());
    const paths = launchdPaths(subject.dataRoot, subject.home);
    const legacy = { ...approval, schemaVersion: 1 as const, signature: '' };
    const legacyPayload = JSON.stringify({
      schemaVersion: legacy.schemaVersion,
      approvalId: legacy.approvalId,
      dataRoot: legacy.dataRoot,
      sourceRoot: legacy.sourceRoot,
      controlScript: legacy.controlScript,
      executable: legacy.executable,
      executableArguments: legacy.executableArguments,
      sourceSha: legacy.sourceSha,
      sourceTree: legacy.sourceTree,
      requestId: legacy.requestId,
      protectedReferenceRoot: legacy.protectedReferenceRoot ?? null,
      label: legacy.label,
      domain: legacy.domain,
      beforeMetadataSha256: legacy.beforeMetadataSha256,
      beforePlistSha256: legacy.beforePlistSha256,
      runtimePreflightSha256: legacy.runtimePreflightSha256,
      runtimeLoaderSha256: legacy.runtimeLoaderSha256,
    });
    const signedLegacy = { ...legacy, signature: createHmac('sha256', 'A'.repeat(43)).update(legacyPayload).digest('hex') };
    await writeFile(paths.sourceBindingApproval, `${JSON.stringify(signedLegacy)}\n`, { mode: 0o600 });
    await expect(approve(subject, target, approval.requestId)).rejects.toMatchObject({ code: 'SUPERVISOR_NOT_RUNNING' });
  });

  it('retires an authenticated malformed schema-1 approval without granting migration authority', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    const paths = launchdPaths(subject.dataRoot, subject.home);
    const legacy = { ...approval, schemaVersion: 1 as const, sourceSha: `${approval.sourceSha}3`, signature: '' };
    const legacyPayload = JSON.stringify({
      schemaVersion: legacy.schemaVersion,
      approvalId: legacy.approvalId,
      dataRoot: legacy.dataRoot,
      sourceRoot: legacy.sourceRoot,
      controlScript: legacy.controlScript,
      executable: legacy.executable,
      executableArguments: legacy.executableArguments,
      sourceSha: legacy.sourceSha,
      sourceTree: legacy.sourceTree,
      requestId: legacy.requestId,
      protectedReferenceRoot: legacy.protectedReferenceRoot ?? null,
      label: legacy.label,
      domain: legacy.domain,
      beforeMetadataSha256: legacy.beforeMetadataSha256,
      beforePlistSha256: legacy.beforePlistSha256,
      runtimePreflightSha256: legacy.runtimePreflightSha256,
      runtimeLoaderSha256: legacy.runtimeLoaderSha256,
    });
    const signedLegacy = { ...legacy, signature: createHmac('sha256', 'A'.repeat(43)).update(legacyPayload).digest('hex') };
    const raw = `${JSON.stringify(signedLegacy)}\n`;
    await writeFile(paths.sourceBindingApproval, raw, { mode: 0o600 });
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1, state: 'ISSUED', approvalId: approval.approvalId, requestId });
    const recoveryRequestId = randomUUID();
    const originalApprovalSha256 = createHash('sha256').update(raw).digest('hex');
    const syncCalls = { count: 0 };
    const dependencies = {
      ...subject.fake.dependencies,
      syncDirectory: async () => {
        syncCalls.count += 1;
        if (syncCalls.count === 3) throw new Error('directory sync lost after approval rename');
      },
    };
    const recovered = await reconcileMalformedLegacyApproval({
      dataRoot: subject.dataRoot,
      approvalId: approval.approvalId,
      requestId,
      approvalSha256: originalApprovalSha256,
      recoveryRequestId,
    }, dependencies);
    expect(recovered).toMatchObject({ state: 'COMMITTED', approvalId: approval.approvalId, recoveryRequestId });
    expect(JSON.parse(await readFile(paths.sourceBindingApproval, 'utf8'))).toMatchObject({ state: 'RECONCILIATION_REQUIRED', sourceSha: legacy.sourceSha });
    expect(JSON.parse(await readFile(paths.sourceBindingApprovalRecovery, 'utf8'))).toMatchObject({ state: 'COMMITTED', originalApprovalRaw: raw });
    const replay = await reconcileMalformedLegacyApproval({
      dataRoot: subject.dataRoot,
      approvalId: approval.approvalId,
      requestId,
      approvalSha256: originalApprovalSha256,
      recoveryRequestId,
    }, dependencies);
    expect(replay.transactionId).toBe(recovered.transactionId);
    const interrupted = JSON.parse(await readFile(paths.sourceBindingApprovalRecovery, 'utf8')) as Record<string, unknown>;
    interrupted.state = 'APPLYING';
    await writeFile(paths.sourceBindingApprovalRecovery, `${JSON.stringify(interrupted, null, 2)}\n`, { mode: 0o600 });
    const resumed = await reconcileMalformedLegacyApproval({
      dataRoot: subject.dataRoot,
      approvalId: approval.approvalId,
      requestId,
      approvalSha256: originalApprovalSha256,
      recoveryRequestId,
    }, dependencies);
    expect(resumed).toMatchObject({ state: 'COMMITTED', transactionId: recovered.transactionId });
  });

  it('rejects malformed approval recovery when bytes or authentication do not match', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    const paths = launchdPaths(subject.dataRoot, subject.home);
    const legacy = { ...approval, schemaVersion: 1 as const, sourceSha: `${approval.sourceSha}3`, signature: '0'.repeat(64) };
    const raw = `${JSON.stringify(legacy)}\n`;
    await writeFile(paths.sourceBindingApproval, raw, { mode: 0o600 });
    await expect(reconcileMalformedLegacyApproval({
      dataRoot: subject.dataRoot,
      approvalId: approval.approvalId,
      requestId,
      approvalSha256: createHash('sha256').update(raw).digest('hex'),
      recoveryRequestId: randomUUID(),
    }, subject.fake.dependencies)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    expect(await readFile(paths.sourceBindingApproval, 'utf8')).toBe(raw);
  });

  it('preserves an unknown approval-byte outcome instead of claiming reconciliation', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    const paths = launchdPaths(subject.dataRoot, subject.home);
    const legacy = { ...approval, schemaVersion: 1 as const, sourceSha: `${approval.sourceSha}3`, signature: '' };
    const legacyPayload = JSON.stringify({
      schemaVersion: legacy.schemaVersion,
      approvalId: legacy.approvalId,
      dataRoot: legacy.dataRoot,
      sourceRoot: legacy.sourceRoot,
      controlScript: legacy.controlScript,
      executable: legacy.executable,
      executableArguments: legacy.executableArguments,
      sourceSha: legacy.sourceSha,
      sourceTree: legacy.sourceTree,
      requestId: legacy.requestId,
      protectedReferenceRoot: legacy.protectedReferenceRoot ?? null,
      label: legacy.label,
      domain: legacy.domain,
      beforeMetadataSha256: legacy.beforeMetadataSha256,
      beforePlistSha256: legacy.beforePlistSha256,
      runtimePreflightSha256: legacy.runtimePreflightSha256,
      runtimeLoaderSha256: legacy.runtimeLoaderSha256,
    });
    const raw = `${JSON.stringify({ ...legacy, signature: createHmac('sha256', 'A'.repeat(43)).update(legacyPayload).digest('hex') })}\n`;
    await writeFile(paths.sourceBindingApproval, raw, { mode: 0o600 });
    const originalApprovalSha256 = createHash('sha256').update(raw).digest('hex');
    const recoveryRequestId = randomUUID();
    const syncCalls = { count: 0 };
    const dependencies = {
      ...subject.fake.dependencies,
      syncDirectory: async () => {
        syncCalls.count += 1;
        if (syncCalls.count === 3) {
          await writeFile(paths.sourceBindingApproval, '{"unknown":true}\n', { mode: 0o600 });
          throw new Error('approval rename outcome is unknown');
        }
      },
    };
    await expect(reconcileMalformedLegacyApproval({
      dataRoot: subject.dataRoot,
      approvalId: approval.approvalId,
      requestId,
      approvalSha256: originalApprovalSha256,
      recoveryRequestId,
    }, dependencies)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    expect(await readFile(paths.sourceBindingApproval, 'utf8')).toBe('{"unknown":true}\n');
    expect(JSON.parse(await readFile(paths.sourceBindingApprovalRecovery, 'utf8'))).toMatchObject({ state: 'RECONCILIATION_REQUIRED' });
  });

  it('refuses bootstrap when a committed migration entrypoint changes before install', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    await migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: approval.approvalId,
      requestId,
    }, subject.fake.dependencies);
    preparedBootstrap.set(subject, Promise.resolve({ target, authorization: { recoveryPolicyId: '', requestId: randomUUID(), sourceSha: target.sourceSha, sourceTree: target.sourceTree } }));
    await writeFile(path.join(subject.dataRoot, 'machine-id.json'), `${JSON.stringify({ schemaVersion: 1, machineId: randomUUID() })}\n`, { mode: 0o600 });
    const entrypoints = await resolveReviewedRuntimeEntrypoints(path.join(target.root, 'apps', 'runtime'));
    const executable = await realpath(canonicalNodeRuntime().path);
    const executableArguments = ['--require', entrypoints.preflight, '--import', pathToFileURL(entrypoints.loader).href];
    const authorization = await issueBootstrapAuthorization(subject, { target, authorization: { recoveryPolicyId: '', requestId: randomUUID(), sourceSha: target.sourceSha, sourceTree: target.sourceTree } }, executable, executableArguments);
    await writeFile(target.executableArguments[1]!, 'module.exports = { changed: true };\n', { mode: 0o600 });
    await expect(installLaunchAgent(
      subject.dataRoot,
      canonicalNodeRuntime().path,
      target.controlScript,
      target.executableArguments,
      undefined,
      subject.fake.dependencies,
      authorization,
    )).rejects.toThrow(/Committed source migration runtime entrypoints changed|runtime entrypoints/);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(0);
  });

  it('refuses bootstrap when the committed source tree changes before install', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    await migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: approval.approvalId,
      requestId,
    }, subject.fake.dependencies);
    preparedBootstrap.set(subject, Promise.resolve({ target, authorization: { recoveryPolicyId: '', requestId: randomUUID(), sourceSha: target.sourceSha, sourceTree: target.sourceTree } }));
    await writeFile(path.join(subject.dataRoot, 'machine-id.json'), `${JSON.stringify({ schemaVersion: 1, machineId: randomUUID() })}\n`, { mode: 0o600 });
    const entrypoints = await resolveReviewedRuntimeEntrypoints(path.join(target.root, 'apps', 'runtime'));
    const executable = await realpath(canonicalNodeRuntime().path);
    const executableArguments = ['--require', entrypoints.preflight, '--import', pathToFileURL(entrypoints.loader).href];
    const authorization = await issueBootstrapAuthorization(subject, { target, authorization: { recoveryPolicyId: '', requestId: randomUUID(), sourceSha: target.sourceSha, sourceTree: target.sourceTree } }, executable, executableArguments);
    await writeFile(target.controlScript, 'export const changed = true;\n', { mode: 0o600 });
    await expect(installLaunchAgent(
      subject.dataRoot,
      canonicalNodeRuntime().path,
      target.controlScript,
      target.executableArguments,
      undefined,
      subject.fake.dependencies,
      authorization,
    )).rejects.toThrow(/source identity is not exact and clean|source identity/);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(0);
  });

  it('rejects entrypoint bytes changed after owner approval', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    await writeFile(target.executableArguments[1]!, 'module.exports = { changed: true };\n', { mode: 0o600 });
    await expect(migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: approval.approvalId,
      requestId,
    }, subject.fake.dependencies)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  });

  it('rejects a source migration before publication when the reviewed identity or target entrypoint is wrong', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const paths = launchdPaths(subject.dataRoot, subject.home);
    const beforeMetadata = await readFile(paths.metadata, 'utf8');
    const beforePlist = await readFile(paths.plist, 'utf8');
    await expect(migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: [...target.executableArguments, path.join(target.root, 'missing-entrypoint.mjs')],
      sourceSha: '0'.repeat(40),
      sourceTree: target.sourceTree,
      approvalId: randomUUID(),
      requestId: randomUUID(),
    }, subject.fake.dependencies)).rejects.toThrow(/reviewed control source identity|entrypoint/);
    expect(await readFile(paths.metadata, 'utf8')).toBe(beforeMetadata);
    expect(await readFile(paths.plist, 'utf8')).toBe(beforePlist);
    expect(subject.fake.calls.some((call) => call.startsWith('bootstrap '))).toBe(false);
  });

  it('refuses migration when the same-label service is loaded', async () => {
    const subject = await fixture();
    await writeLegacyLaunchAgent(subject);
    subject.fake.loaded = true;
    const target = await reviewedSource(subject);
    await expect(migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: randomUUID(),
      requestId: randomUUID(),
    }, subject.fake.dependencies)).rejects.toThrow(/must be stopped/);
    expect(subject.fake.calls.some((call) => call.startsWith('bootstrap '))).toBe(false);
  });

  it('refuses concurrent source migration while the lifecycle lock is held', async () => {
    const subject = await fixture();
    const legacy = await writeLegacyLaunchAgent(subject);
    const target = await reviewedSource(subject);
    const paths = launchdPaths(subject.dataRoot, subject.home);
    await writeFile(paths.operationLock, `${JSON.stringify({ schemaVersion: 1, label: LAUNCH_AGENT_LABEL, pid: 1234, requestId: randomUUID() })}\n`, { mode: 0o600 });
    await expect(migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: randomUUID(),
      requestId: randomUUID(),
    }, subject.fake.dependencies)).rejects.toThrow(/lifecycle operation/);
    expect(await readFile(paths.metadata, 'utf8')).toBe(legacy.metadata);
    expect(await readFile(paths.plist, 'utf8')).toBe(legacy.plist);
    expect(subject.fake.calls.some((call) => call.startsWith('bootstrap '))).toBe(false);
  });

  it('reads schema-1 metadata without mutation and requires a separate migration before install rollback', async () => {
    const subject = await fixture();
    const paths = launchdPaths(subject.dataRoot, subject.home);
    const legacy = await writeLegacyLaunchAgent(subject);
    await expect(launchAgentStatus(subject.dataRoot, subject.fake.dependencies)).rejects.toThrow(/authorized install migration/);
    await expect(uninstallLaunchAgent(subject.dataRoot, subject.fake.dependencies)).rejects.toThrow(/authorized install migration/);
    expect(await readFile(paths.metadata, 'utf8')).toBe(legacy.metadata);
    expect(await readFile(paths.plist, 'utf8')).toBe(legacy.plist);

    const target = await reviewedSource(subject);
    preparedBootstrap.set(subject, Promise.resolve({ target, authorization: { recoveryPolicyId: '', requestId: randomUUID(), sourceSha: target.sourceSha, sourceTree: target.sourceTree } }));
    await writeFile(path.join(subject.dataRoot, 'machine-id.json'), `${JSON.stringify({ schemaVersion: 1, machineId: randomUUID() })}\n`, { mode: 0o600 });
    const requestId = randomUUID();
    const approval = await approve(subject, target, requestId);
    await expect(migrateLaunchAgentSource({
      dataRoot: subject.dataRoot,
      sourceRoot: target.root,
      controlScript: target.controlScript,
      executable: canonicalNodeRuntime().path,
      executableArguments: target.executableArguments,
      sourceSha: target.sourceSha,
      sourceTree: target.sourceTree,
      approvalId: approval.approvalId,
      requestId,
    }, subject.fake.dependencies)).resolves.toMatchObject({ state: 'COMMITTED' });

    subject.fake.bootstrap = 'failure';
    await expect(install(subject)).rejects.toThrow(/Could not install|bootstrap failed/);
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({
      schemaVersion: 3,
      state: 'PREPARED',
      legacyMigration: { fromSchemaVersion: 1, observedState: 'ABSENT' },
    });
    expect(subject.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(1);
    subject.fake.bootstrap = 'success';
    await expect(install(subject)).rejects.toThrow(/requires explicit reconciliation/);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(1);
  });

  it('refuses conflicting, live, or unsupported legacy metadata without rewriting it', async () => {
    const conflicting = await fixture();
    const conflictLegacy = await writeLegacyLaunchAgent(conflicting);
    const conflictPaths = launchdPaths(conflicting.dataRoot, conflicting.home);
    const conflictMetadata = JSON.parse(conflictLegacy.metadata);
    conflictMetadata.controlScript = path.join(sourceRoot, 'foreign-control.ts');
    const conflictRaw = `${JSON.stringify(conflictMetadata, null, 2)}\n`;
    await writeFile(conflictPaths.metadata, conflictRaw, { mode: 0o600 });
    await expect(install(conflicting)).rejects.toThrow(/metadata conflicts|committed source migration/);
    expect(await readFile(conflictPaths.metadata, 'utf8')).toBe(conflictRaw);
    expect(conflicting.fake.calls.some((call) => call.startsWith('bootstrap ') || call.startsWith('bootout '))).toBe(false);

    const loaded = await fixture();
    const loadedLegacy = await writeLegacyLaunchAgent(loaded);
    loaded.fake.loaded = true;
    await expect(install(loaded)).rejects.toThrow(/must be stopped|committed source migration/);
    expect(await readFile(launchdPaths(loaded.dataRoot, loaded.home).metadata, 'utf8')).toBe(loadedLegacy.metadata);
    expect(loaded.fake.calls.some((call) => call.startsWith('bootstrap ') || call.startsWith('bootout '))).toBe(false);

    const future = await fixture();
    const futurePaths = launchdPaths(future.dataRoot, future.home);
    await mkdir(futurePaths.directory, { recursive: true, mode: 0o700 });
    await writeFile(futurePaths.metadata, `${JSON.stringify({ schemaVersion: 4 })}\n`, { mode: 0o600 });
    await expect(install(future)).rejects.toThrow(/metadata is invalid/);
    expect(future.fake.calls.some((call) => call.startsWith('bootstrap ') || call.startsWith('bootout '))).toBe(false);
  });

  it('fails a definite bootstrap failure and reconciles an unknown successful outcome without retry', async () => {
    const failed = await fixture();
    failed.fake.bootstrap = 'failure';
    await expect(install(failed)).rejects.toThrow(/Could not install/);
    expect(failed.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(1);
    await expect(lstat(launchdPaths(failed.dataRoot, failed.home).registeredPlist)).rejects.toMatchObject({ code: 'ENOENT' });

    const disabledFailure = await fixture();
    disabledFailure.fake.disabled = true;
    disabledFailure.fake.bootstrap = 'failure';
    await expect(install(disabledFailure)).rejects.toThrow(/Could not install/);
    expect(disabledFailure.fake.disabled).toBe(true);
    expect(disabledFailure.fake.calls).toContain(`disable gui/${uid}/${LAUNCH_AGENT_LABEL}`);

    const unknown = await fixture();
    unknown.fake.bootstrap = 'unknown-success';
    await expect(install(unknown)).resolves.toMatchObject({ registeredPlist: expect.stringContaining(LAUNCH_AGENT_LABEL) });
    expect(unknown.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(1);
  });

  it('rejects replay of a committed bootstrap when re-enabling a disabled service', async () => {
    const subject = await fixture();
    await install(subject);
    subject.fake.disabled = true;
    const enableCalls = subject.fake.calls.filter((call) => call.startsWith('enable ')).length;
    await expect(install(subject)).rejects.toThrow(/operation limit|fresh authorization|unresolved operation|before-image/);
    expect(subject.fake.calls.filter((call) => call.startsWith('enable '))).toHaveLength(enableCalls);
  });

  it('keeps bootstrap unresolved when the process start marker changes before commit', async () => {
    const subject = await fixture();
    subject.fake.beforeProcessObservation = (count) => {
      if (count === 2) subject.fake.live.processStartMarker = '1:000002';
    };
    await expect(install(subject)).rejects.toThrow(/process identity changed|Refusing to unload/);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootout '))).toHaveLength(0);
    expect(JSON.parse(await readFile(launchdPaths(subject.dataRoot, subject.home).metadata, 'utf8'))).toMatchObject({ state: 'RECONCILIATION_REQUIRED' });
  });

  it('keeps bootstrap unresolved when the observed executable changes before commit', async () => {
    const subject = await fixture();
    subject.fake.beforeProcessObservation = (count) => {
      if (count === 2) subject.fake.live.executable = '/usr/bin/false';
    };
    await expect(install(subject)).rejects.toThrow(/executable identity|Refusing to unload/);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootout '))).toHaveLength(0);
    expect(JSON.parse(await readFile(launchdPaths(subject.dataRoot, subject.home).metadata, 'utf8'))).toMatchObject({ state: 'RECONCILIATION_REQUIRED' });
  });

  it('does not adopt a loaded service without its exact durable registration', async () => {
    const subject = await fixture();
    subject.fake.loaded = true;
    await expect(install(subject)).rejects.toThrow(/no durable ownership metadata|registered LaunchAgent changed|identity/);
    expect(subject.fake.calls.some((call) => call.startsWith('bootstrap '))).toBe(false);
  });

  it('treats ambiguous service queries as unknown and preserves durable ownership', async () => {
    const subject = await fixture();
    const paths = await install(subject);
    subject.fake.queryError = Object.assign(new Error('permission denied'), { stderr: 'Permission denied' });
    await expect(uninstallLaunchAgent(subject.dataRoot, subject.fake.dependencies)).rejects.toThrow(/state remained unknown/);
    expect(subject.fake.loaded).toBe(true);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootout '))).toHaveLength(0);
    await expect(lstat(paths.registeredPlist)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(lstat(paths.metadata)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it('classifies absence only from the exact launchd code and label/domain diagnostic', async () => {
    const cases = [
      Object.assign(new Error('permission denied'), {
        code: 113,
        stdout: '',
        stderr: `Could not find service "${LAUNCH_AGENT_LABEL}" in domain for user gui: ${uid}`,
      }),
      Object.assign(new Error('service unavailable'), {
        code: 1,
        stdout: '',
        stderr: `Could not find service "${LAUNCH_AGENT_LABEL}" in domain for user gui: ${uid}`,
      }),
      Object.assign(new Error('service unavailable'), {
        code: 113,
        stdout: 'unexpected',
        stderr: `Could not find service "${LAUNCH_AGENT_LABEL}" in domain for user gui: ${uid}`,
      }),
      Object.assign(new Error('service unavailable'), {
        code: 113,
        stdout: '',
        stderr: `Could not find service "${LAUNCH_AGENT_LABEL}" in domain for user gui: ${uid + 1}`,
      }),
    ];
    for (const queryError of cases) {
      const subject = await fixture();
      subject.fake.queryError = queryError;
      await expect(install(subject)).rejects.toThrow(/state remained unknown/);
      expect(subject.fake.calls.some((call) => call.startsWith('bootstrap ') || call.startsWith('bootout '))).toBe(false);
    }
  });

  it('fails closed for every mismatched live job ownership field', async () => {
    const mutations: Array<(subject: Awaited<ReturnType<typeof fixture>>) => void> = [
      (subject) => { subject.fake.live.label = 'com.example.foreign'; },
      (subject) => { subject.fake.live.registeredPlist = path.join(subject.home, 'Library/LaunchAgents/foreign.plist'); },
      (subject) => { subject.fake.live.executable = '/usr/bin/false'; },
      (subject) => { subject.fake.live.arguments = [...subject.fake.live.arguments, '--foreign']; },
      (subject) => { subject.fake.live.workingDirectory = path.join(sourceRoot, 'foreign'); },
      (subject) => { subject.fake.live.dataRoot = path.join(subject.dataRoot, 'foreign'); },
    ];
    for (const mutate of mutations) {
      const subject = await fixture();
      const paths = await install(subject);
      mutate(subject);
      await expect(install(subject)).rejects.toThrow(/identity|label|before-image/);
      await expect(uninstallLaunchAgent(subject.dataRoot, subject.fake.dependencies)).rejects.toThrow(/identity|label/);
      expect(subject.fake.loaded).toBe(true);
      expect(subject.fake.calls.filter((call) => call.startsWith('bootout '))).toHaveLength(0);
      await expect(lstat(paths.registeredPlist)).resolves.toMatchObject({ mode: expect.any(Number) });
    }
  }, 30_000);

  it('rolls back a positively verified job when post-bootstrap publication verification fails', async () => {
    const subject = await fixture();
    const paths = launchdPaths(subject.dataRoot, subject.home);
    subject.fake.afterBootstrap = async () => {
      await writeFile(paths.registeredPlist, 'changed after bootstrap', { mode: 0o600 });
    };
    await expect(install(subject)).rejects.toThrow(/registration changed during rollback/);
    expect(subject.fake.loaded).toBe(false);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootout '))).toHaveLength(1);
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      unresolvedReason: 'PUBLISHED_STATE_CHANGED',
    });
  });

  it('records an unknown bootstrap observation and reconciles it without another bootstrap', async () => {
    const subject = await fixture();
    const paths = launchdPaths(subject.dataRoot, subject.home);
    subject.fake.afterBootstrap = async () => {
      subject.fake.queryError = Object.assign(new Error('query interrupted'), { stderr: 'I/O failure' });
    };
    await expect(install(subject)).rejects.toThrow(/requires reconciliation|metadata is not in the expected prepared state/);
    expect(subject.fake.loaded).toBe(true);
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      unresolvedReason: 'BOOTSTRAP_OUTCOME_UNKNOWN',
    });
    subject.fake.afterBootstrap = null;
    subject.fake.queryError = null;
    await expect(install(subject)).rejects.toThrow(/requires reconciliation|metadata is not in the expected prepared state/);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(1);
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({ state: 'RECONCILIATION_REQUIRED', unresolvedReason: 'BOOTSTRAP_OUTCOME_UNKNOWN' });
  });

  it('unloads only the recorded service, removes verified artifacts, and repeats safely', async () => {
    const subject = await fixture();
    const paths = await install(subject);
    await uninstallLaunchAgent(subject.dataRoot, subject.fake.dependencies);
    expect(subject.fake.loaded).toBe(false);
    await expect(lstat(paths.registeredPlist)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(paths.plist)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(paths.metadata)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(uninstallLaunchAgent(subject.dataRoot, subject.fake.dependencies)).resolves.toBeUndefined();
    expect(subject.fake.calls.filter((call) => call.startsWith('bootout '))).toHaveLength(1);
  });

  it('stops only a verified Supervisor for source migration and preserves Schema-3 artifacts', async () => {
    const subject = await fixture();
    const paths = await install(subject);
    const metadataRaw = await readFile(paths.metadata, 'utf8');
    const plistRaw = await readFile(paths.plist, 'utf8');
    const migrationRaw = await readFile(paths.sourceBindingMigration, 'utf8');
    const metadata = JSON.parse(metadataRaw) as { sourceRoot: string };
    await expect(stopLaunchAgentForMigration({
      dataRoot: subject.dataRoot,
      sourceRoot: metadata.sourceRoot,
      beforeMetadataSha256: createHash('sha256').update(metadataRaw).digest('hex'),
      beforePlistSha256: createHash('sha256').update(plistRaw).digest('hex'),
    }, subject.fake.dependencies)).resolves.toMatchObject({ state: 'STOPPED', processId: subject.fake.live.pid });
    expect(subject.fake.loaded).toBe(false);
    await expect(lstat(paths.registeredPlist)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(paths.metadata, 'utf8')).toBe(metadataRaw);
    expect(await readFile(paths.plist, 'utf8')).toBe(plistRaw);
    expect(await readFile(paths.sourceBindingMigration, 'utf8')).toBe(migrationRaw);
  });

  it('fails closed without unloading when Supervisor identity or before-images conflict', async () => {
    const subject = await fixture();
    const paths = await install(subject);
    const metadataRaw = await readFile(paths.metadata, 'utf8');
    const plistRaw = await readFile(paths.plist, 'utf8');
    const metadata = JSON.parse(metadataRaw) as { sourceRoot: string };
    await expect(stopLaunchAgentForMigration({
      dataRoot: subject.dataRoot,
      sourceRoot: path.join(metadata.sourceRoot, 'foreign'),
      beforeMetadataSha256: createHash('sha256').update(metadataRaw).digest('hex'),
      beforePlistSha256: createHash('sha256').update(plistRaw).digest('hex'),
    }, subject.fake.dependencies)).rejects.toThrow(/source root|identity/);
    expect(subject.fake.loaded).toBe(true);
    expect(subject.fake.calls.some((call) => call.startsWith('bootout '))).toBe(false);
  });

  it('records an unresolved stop when bootout outcome is unknown', async () => {
    const subject = await fixture();
    const paths = await install(subject);
    const metadataRaw = await readFile(paths.metadata, 'utf8');
    const plistRaw = await readFile(paths.plist, 'utf8');
    const metadata = JSON.parse(metadataRaw) as { sourceRoot: string };
    subject.fake.bootout = 'unknown-success';
    await expect(stopLaunchAgentForMigration({
      dataRoot: subject.dataRoot,
      sourceRoot: metadata.sourceRoot,
      beforeMetadataSha256: createHash('sha256').update(metadataRaw).digest('hex'),
      beforePlistSha256: createHash('sha256').update(plistRaw).digest('hex'),
    }, subject.fake.dependencies)).resolves.toMatchObject({ state: 'STOPPED', processId: subject.fake.live.pid });
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({ schemaVersion: 3, state: 'READY' });
    expect(subject.fake.loaded).toBe(false);
  });

  it('preserves the binding when identity-verified bootout fails', async () => {
    const subject = await fixture();
    const paths = await install(subject);
    const metadataRaw = await readFile(paths.metadata, 'utf8');
    const plistRaw = await readFile(paths.plist, 'utf8');
    const metadata = JSON.parse(metadataRaw) as { sourceRoot: string };
    subject.fake.bootout = 'failure';
    await expect(stopLaunchAgentForMigration({
      dataRoot: subject.dataRoot,
      sourceRoot: metadata.sourceRoot,
      beforeMetadataSha256: createHash('sha256').update(metadataRaw).digest('hex'),
      beforePlistSha256: createHash('sha256').update(plistRaw).digest('hex'),
    }, subject.fake.dependencies)).rejects.toThrow(/verified Supervisor|reconciliation/);
    expect(subject.fake.loaded).toBe(true);
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({ state: 'RECONCILIATION_REQUIRED', unresolvedReason: 'BOOTOUT_OUTCOME_UNKNOWN' });
    await expect(lstat(paths.registeredPlist)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it('preserves a loaded service when its registered plist changed', async () => {
    const subject = await fixture();
    const paths = await install(subject);
    await chmod(paths.registeredPlist, 0o600);
    await writeFile(paths.registeredPlist, 'changed', { mode: 0o600 });
    await expect(uninstallLaunchAgent(subject.dataRoot, subject.fake.dependencies)).rejects.toThrow(/no longer matches/);
    expect(subject.fake.loaded).toBe(true);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootout '))).toHaveLength(0);
  });

  it('reconciles an unknown successful bootout and preserves artifacts after a definite failure', async () => {
    const unknown = await fixture();
    const unknownPaths = await install(unknown);
    unknown.fake.bootout = 'unknown-success';
    await expect(uninstallLaunchAgent(unknown.dataRoot, unknown.fake.dependencies)).resolves.toBeUndefined();
    await expect(lstat(unknownPaths.registeredPlist)).rejects.toMatchObject({ code: 'ENOENT' });

    const failed = await fixture();
    const failedPaths = await install(failed);
    failed.fake.bootout = 'failure';
    await expect(uninstallLaunchAgent(failed.dataRoot, failed.fake.dependencies)).rejects.toThrow(/Could not safely unload/);
    expect(failed.fake.loaded).toBe(true);
    await expect(lstat(failedPaths.registeredPlist)).resolves.toMatchObject({ mode: expect.any(Number) });
  });
});
