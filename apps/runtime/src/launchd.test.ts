import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installLaunchAgent,
  issueLaunchAgentSourceApproval,
  LAUNCH_AGENT_LABEL,
  launchAgentStatus,
  launchdPaths,
  migrateLaunchAgentSource,
  renderLaunchAgent,
  uninstallLaunchAgent,
  type LaunchdDependencies,
} from './launchd.js';
import { canonicalNodeRuntime, node24Path } from './node-runtime.js';
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
  readonly live: {
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
    live: {
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

async function install(subject: Awaited<ReturnType<typeof fixture>>) {
  return installLaunchAgent(subject.dataRoot, canonicalNodeRuntime().path, controlScript, [], undefined, subject.fake.dependencies);
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

async function reviewedSource(subject: Awaited<ReturnType<typeof fixture>>): Promise<{
  readonly root: string;
  readonly controlScript: string;
  readonly executableArguments: readonly string[];
  readonly sourceSha: string;
  readonly sourceTree: string;
}> {
  const root = path.join(path.dirname(subject.dataRoot), 'reviewed-control-source');
  const runtime = path.join(root, 'apps', 'runtime');
  const controlScript = path.join(runtime, 'src', 'control.ts');
  const tsx = path.join(runtime, 'node_modules', 'tsx', 'dist');
  await mkdir(path.dirname(controlScript), { recursive: true, mode: 0o700 });
  await mkdir(tsx, { recursive: true, mode: 0o700 });
  await writeFile(controlScript, 'export {};\n', { mode: 0o600 });
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

  it('publishes a private user LaunchAgent, registers once, and is idempotent', async () => {
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
      sourceRoot,
      registeredPlist: paths.registeredPlist,
    });
    expect(await launchAgentStatus(subject.dataRoot, subject.fake.dependencies)).toMatchObject({ loaded: true, disabled: false, registered: true });
    await install(subject);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(1);
  });

  it('refuses conflicting plists, symlinks, and unsafe ownership', async () => {
    const conflict = await fixture();
    conflict.fake.disabled = true;
    const conflictPaths = launchdPaths(conflict.dataRoot, conflict.home);
    await mkdir(conflictPaths.registrationDirectory, { recursive: true, mode: 0o700 });
    await writeFile(conflictPaths.registeredPlist, 'foreign service', { mode: 0o600 });
    await expect(install(conflict)).rejects.toThrow(/conflicts with the requested installation/);
    expect(conflict.fake.disabled).toBe(true);
    expect(conflict.fake.calls.some((call) => call.startsWith('enable '))).toBe(false);

    const linked = await fixture();
    const linkedPaths = launchdPaths(linked.dataRoot, linked.home);
    await mkdir(linkedPaths.registrationDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(linked.home, 'foreign.plist');
    await writeFile(target, 'foreign', { mode: 0o600 });
    await symlink(target, linkedPaths.registeredPlist);
    await expect(install(linked)).rejects.toThrow(/not a physical file/);

    const wrongOwner = await fixture();
    await expect(installLaunchAgent(wrongOwner.dataRoot, canonicalNodeRuntime().path, controlScript, [], undefined, {
      ...wrongOwner.fake.dependencies,
      uid: uid + 1,
    })).rejects.toThrow(/ownership or permissions are unsafe/);
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
    await install(disabled);
    expect(disabled.fake.disabled).toBe(false);
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

  it('parses real print-disabled structure and refuses missing, duplicate, or malformed state', async () => {
    for (const disabledOutput of ['missing', 'duplicate', 'malformed'] as const) {
      const subject = await fixture();
      subject.fake.disabledOutput = disabledOutput;
      await expect(install(subject)).rejects.toThrow(/disabled state.+unknown/);
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

  it('migrates an exact stopped schema-1 installation to schema 3 before bootstrap and preserves legacy evidence', async () => {
    const subject = await fixture();
    subject.fake.disabled = true;
    const legacy = await writeLegacyLaunchAgent(subject);
    const paths = await install(subject);
    const metadata = JSON.parse(await readFile(paths.metadata, 'utf8'));
    expect(metadata).toMatchObject({
      schemaVersion: 3,
      state: 'READY',
      disabledBeforeInstall: true,
      legacyMigration: {
        fromSchemaVersion: 1,
        executable: canonicalNodeRuntime().path,
        controlScript,
        plist: paths.plist,
        observedState: 'ABSENT',
        disabledBeforeMigration: true,
      },
    });
    expect(metadata.legacyMigration.metadataSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.legacyMigration.plistSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(paths.metadata, 'utf8')).not.toBe(legacy.metadata);
    expect(await readFile(paths.plist, 'utf8')).toBe(
      renderLaunchAgent(subject.dataRoot, await realpath(canonicalNodeRuntime().path), controlScript),
    );
    expect(subject.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(1);
    await uninstallLaunchAgent(subject.dataRoot, subject.fake.dependencies);
    expect(subject.fake.disabled).toBe(true);
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

  it('reads schema-1 metadata without mutation and resumes a journaled migration after install rollback', async () => {
    const subject = await fixture();
    const paths = launchdPaths(subject.dataRoot, subject.home);
    const legacy = await writeLegacyLaunchAgent(subject);
    await expect(launchAgentStatus(subject.dataRoot, subject.fake.dependencies)).rejects.toThrow(/authorized install migration/);
    await expect(uninstallLaunchAgent(subject.dataRoot, subject.fake.dependencies)).rejects.toThrow(/authorized install migration/);
    expect(await readFile(paths.metadata, 'utf8')).toBe(legacy.metadata);
    expect(await readFile(paths.plist, 'utf8')).toBe(legacy.plist);

    subject.fake.bootstrap = 'failure';
    await expect(install(subject)).rejects.toThrow(/Could not install/);
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({
      schemaVersion: 3,
      state: 'PREPARED',
      legacyMigration: { fromSchemaVersion: 1, observedState: 'ABSENT' },
    });
    expect(subject.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(1);
    subject.fake.bootstrap = 'success';
    await expect(install(subject)).resolves.toEqual(paths);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(2);
  });

  it('refuses conflicting, live, or unsupported legacy metadata without rewriting it', async () => {
    const conflicting = await fixture();
    const conflictLegacy = await writeLegacyLaunchAgent(conflicting);
    const conflictPaths = launchdPaths(conflicting.dataRoot, conflicting.home);
    const conflictMetadata = JSON.parse(conflictLegacy.metadata);
    conflictMetadata.controlScript = path.join(sourceRoot, 'foreign-control.ts');
    const conflictRaw = `${JSON.stringify(conflictMetadata, null, 2)}\n`;
    await writeFile(conflictPaths.metadata, conflictRaw, { mode: 0o600 });
    await expect(install(conflicting)).rejects.toThrow(/metadata conflicts/);
    expect(await readFile(conflictPaths.metadata, 'utf8')).toBe(conflictRaw);
    expect(conflicting.fake.calls.some((call) => call.startsWith('bootstrap ') || call.startsWith('bootout '))).toBe(false);

    const loaded = await fixture();
    const loadedLegacy = await writeLegacyLaunchAgent(loaded);
    loaded.fake.loaded = true;
    await expect(install(loaded)).rejects.toThrow(/must be stopped/);
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

  it('does not adopt a loaded service without its exact durable registration', async () => {
    const subject = await fixture();
    subject.fake.loaded = true;
    await expect(install(subject)).rejects.toThrow(/no durable ownership metadata/);
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
      await expect(install(subject)).rejects.toThrow(/identity|label/);
      await expect(uninstallLaunchAgent(subject.dataRoot, subject.fake.dependencies)).rejects.toThrow(/identity|label/);
      expect(subject.fake.loaded).toBe(true);
      expect(subject.fake.calls.filter((call) => call.startsWith('bootout '))).toHaveLength(0);
      await expect(lstat(paths.registeredPlist)).resolves.toMatchObject({ mode: expect.any(Number) });
    }
  });

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
    await expect(install(subject)).rejects.toThrow(/requires reconciliation/);
    expect(subject.fake.loaded).toBe(true);
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      unresolvedReason: 'BOOTSTRAP_OUTCOME_UNKNOWN',
    });
    subject.fake.afterBootstrap = null;
    subject.fake.queryError = null;
    await expect(install(subject)).resolves.toEqual(paths);
    expect(subject.fake.calls.filter((call) => call.startsWith('bootstrap '))).toHaveLength(1);
    expect(JSON.parse(await readFile(paths.metadata, 'utf8'))).toMatchObject({ state: 'READY', unresolvedReason: null });
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
