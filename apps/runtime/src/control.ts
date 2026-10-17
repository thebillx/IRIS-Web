import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRuntimeDataRoot, RUNTIME_DATA_ENV } from './data-root.js';
import { startRuntime, stopRuntime, runtimeStatus } from './lifecycle.js';
import { readOwnerAccessSecret } from './persistence.js';
import { createSupervisor } from './supervisor.js';
import { installLaunchAgent, issueLaunchAgentSourceApproval, launchAgentStatus, migrateLaunchAgentSource, uninstallLaunchAgent } from './launchd.js';
import { assertSupportedNodeVersion, canonicalNodeRuntime } from './node-runtime.js';

const command = process.argv[2];
const legacyRuntimeControl = process.env.IRIS_STACK_CLI !== '1';

try {
  assertSupportedNodeVersion();
  const launchdInstallOptions = command === 'launchd' && process.argv[3] === 'install'
    ? parseLaunchdInstallOptions(process.argv.slice(4))
    : null;
  const dataRoot = launchdInstallOptions?.runtimeDataRoot === undefined
    ? await resolveRuntimeDataRoot()
    : await resolveRuntimeDataRoot({ ...process.env, [RUNTIME_DATA_ENV]: launchdInstallOptions.runtimeDataRoot });
  if (legacyRuntimeControl && command === 'start') {
    process.stdout.write(`${JSON.stringify(await startRuntime({ dataRoot }), null, 2)}\n`);
  } else if (legacyRuntimeControl && command === 'status') {
    process.stdout.write(`${JSON.stringify(await runtimeStatus(dataRoot), null, 2)}\n`);
  } else if (legacyRuntimeControl && command === 'stop') {
    process.stdout.write(`${JSON.stringify(await stopRuntime(dataRoot), null, 2)}\n`);
  } else if (legacyRuntimeControl && command === 'owner-token') {
    const secret = await readOwnerAccessSecret(dataRoot);
    if (secret === null) throw new Error('IRIS owner access credential is not initialized');
    process.stdout.write(`${secret}\n`);
  } else {
    const supervisor = await createSupervisor({ dataRoot });
    if (command === 'up') {
      printStatus(await supervisor.up());
    } else if (command === 'down') {
      printStatus(await supervisor.down());
    } else if (command === 'restart') {
      printStatus(await supervisor.restart());
    } else if (command === 'status') {
      printStatus(await supervisor.status());
    } else if (command === 'doctor') {
      process.stdout.write(`${JSON.stringify(await supervisor.doctor(), null, 2)}\n`);
    } else if (command === 'connectors' && process.argv[3] === 'admin-bind') {
      const tunnelId = process.argv[4];
      if (tunnelId === undefined) throw new Error('Usage: iris connectors admin-bind <dedicated-admin-tunnel-id>');
      process.stdout.write(`${JSON.stringify(await supervisor.bindAdminTunnel(tunnelId), null, 2)}\n`);
    } else if (command === 'connectors') {
      process.stdout.write(`${JSON.stringify(await supervisor.connectors(), null, 2)}\n`);
    } else if (command === 'catalog' && process.argv[3] === 'status') {
      process.stdout.write(`${JSON.stringify(await supervisor.catalogStatus(), null, 2)}\n`);
    } else if (command === 'catalog' && process.argv[3] === 'reload') {
      printStatus(await supervisor.catalogReload());
    } else if (command === 'logs') {
      process.stdout.write(`${await supervisor.logs()}\n`);
    } else if (command === 'adopt-runtime') {
      printStatus(await supervisor.adoptRuntime());
    } else if (command === 'startup-reconcile') {
      await supervisor.reconcileStartup();
      process.stdout.write('IRIS_STARTUP_RECONCILED=YES\n');
    } else if (command === 'runtime-reconcile') {
      process.stdout.write(`${JSON.stringify(await supervisor.runtimeReconcile(), null, 2)}\n`);
    } else if (command === 'supervisor') {
      await supervisor.runSupervisorDaemon();
    } else if (command === 'credentials' && process.argv[3] === 'migrate') {
      const profile = process.argv[4];
      if (profile === undefined) throw new Error('Usage: iris credentials migrate <profile-path-or-name>');
      process.stdout.write(`${JSON.stringify(await supervisor.migrateCredentials(profile), null, 2)}\n`);
    } else if (command === 'credentials' && process.argv[3] === 'rotate-tunnel') {
      process.stdout.write(`${JSON.stringify(await supervisor.rotateTunnelCredential(), null, 2)}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'install') {
      const runtimeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const tsxDirectory = path.join(runtimeDirectory, 'node_modules', 'tsx', 'dist');
      const executable = canonicalNodeRuntime().path;
      const script = path.join(runtimeDirectory, 'src', 'control.ts');
      const executableArguments = ['--require', path.join(tsxDirectory, 'preflight.cjs'), '--import', pathToFileURL(path.join(tsxDirectory, 'loader.mjs')).href];
      const protectedReferenceRoot = launchdInstallOptions?.protectedReferenceRoot ?? process.env.IRIS_PROTECTED_REFERENCE_ROOT?.trim();
      process.stdout.write(`${JSON.stringify(await installLaunchAgent(dataRoot, executable, script, executableArguments, protectedReferenceRoot), null, 2)}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'migrate-source') {
      const migration = parseLaunchdSourceMigrationOptions(process.argv.slice(4));
      const runtimeDirectory = path.join(migration.sourceRoot, 'apps', 'runtime');
      const tsxDirectory = path.join(runtimeDirectory, 'node_modules', 'tsx', 'dist');
      process.stdout.write(`${JSON.stringify(await migrateLaunchAgentSource({
        dataRoot,
        sourceRoot: migration.sourceRoot,
        controlScript: migration.controlScript,
        executable: migration.executable,
        executableArguments: ['--require', path.join(tsxDirectory, 'preflight.cjs'), '--import', pathToFileURL(path.join(tsxDirectory, 'loader.mjs')).href],
        sourceSha: migration.sourceSha,
        sourceTree: migration.sourceTree,
        approvalId: migration.approvalId,
        requestId: migration.requestId,
        ...(migration.protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: migration.protectedReferenceRoot }),
      }), null, 2)}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'authorize-migrate-source') {
      const approval = parseLaunchdSourceApprovalOptions(process.argv.slice(4));
      const runtimeDirectory = path.join(approval.sourceRoot, 'apps', 'runtime');
      const tsxDirectory = path.join(runtimeDirectory, 'node_modules', 'tsx', 'dist');
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type APPROVE IRIS MIGRATION to issue the one-time local authorization: ');
        if (confirmation.trim() !== 'APPROVE IRIS MIGRATION') throw new Error('Owner migration authorization was not confirmed');
      } finally {
        prompt.close();
      }
      const issued = await issueLaunchAgentSourceApproval({
        ...approval,
        dataRoot,
        executableArguments: ['--require', path.join(tsxDirectory, 'preflight.cjs'), '--import', pathToFileURL(path.join(tsxDirectory, 'loader.mjs')).href],
      });
      process.stdout.write(`${JSON.stringify({ approvalId: issued.approvalId, requestId: issued.requestId, state: issued.state })}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'uninstall') {
      await uninstallLaunchAgent(dataRoot);
      process.stdout.write('IRIS_LAUNCHD=UNINSTALLED\n');
    } else if (command === 'launchd' && process.argv[3] === 'status') {
      process.stdout.write(`${JSON.stringify(await launchAgentStatus(dataRoot), null, 2)}\n`);
    } else {
      process.stderr.write('Usage: iris <up|down|restart|status|doctor|connectors|connectors admin-bind <tunnel-id>|catalog status|catalog reload|logs|adopt-runtime|runtime-reconcile|startup-reconcile|supervisor|credentials|launchd>\n');
      process.exitCode = 2;
    }
  }
} catch (error) {
  const code = error instanceof Error && 'code' in error ? String((error as { readonly code?: unknown }).code ?? 'IRIS_COMMAND_FAILED') : 'IRIS_COMMAND_FAILED';
  const message = error instanceof Error ? error.message : 'IRIS command failed';
  process.stderr.write(`IRIS_COMMAND_FAILED code=${code} message=${message}\n`);
  process.exitCode = 1;
}

interface LaunchdInstallOptions {
  runtimeDataRoot?: string;
  protectedReferenceRoot?: string;
}

interface LaunchdSourceMigrationOptions {
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly approvalId: string;
  readonly requestId: string;
  readonly protectedReferenceRoot?: string;
}

const LAUNCHD_INSTALL_USAGE = 'Usage: iris launchd install [--runtime-data-root <external-directory>] [--protected-reference-root <existing-directory>]';

function parseLaunchdInstallOptions(argumentsList: readonly string[]): LaunchdInstallOptions {
  if (argumentsList.length % 2 !== 0) throw new Error(LAUNCHD_INSTALL_USAGE);
  const parsed: LaunchdInstallOptions = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0) throw new Error(LAUNCHD_INSTALL_USAGE);
    if (name === '--runtime-data-root') {
      if (parsed.runtimeDataRoot !== undefined) throw new Error(LAUNCHD_INSTALL_USAGE);
      parsed.runtimeDataRoot = value;
    } else if (name === '--protected-reference-root') {
      if (parsed.protectedReferenceRoot !== undefined) throw new Error(LAUNCHD_INSTALL_USAGE);
      parsed.protectedReferenceRoot = value;
    } else {
      throw new Error(LAUNCHD_INSTALL_USAGE);
    }
  }
  return parsed;
}

function parseLaunchdSourceMigrationOptions(argumentsList: readonly string[]): LaunchdSourceMigrationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0 || name === undefined || !name.startsWith('--') || values.has(name)) throw new Error(LAUNCHD_SOURCE_MIGRATION_USAGE);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(LAUNCHD_SOURCE_MIGRATION_USAGE);
    return value;
  };
  const allowed = new Set(['--source-root', '--control-script', '--executable', '--source-sha', '--source-tree', '--approval-id', '--request-id', '--protected-reference-root']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(LAUNCHD_SOURCE_MIGRATION_USAGE);
  const protectedReferenceRoot = values.get('--protected-reference-root');
  return {
    sourceRoot: required('--source-root'),
    controlScript: required('--control-script'),
    executable: required('--executable'),
    sourceSha: required('--source-sha'),
    sourceTree: required('--source-tree'),
    approvalId: required('--approval-id'),
    requestId: required('--request-id'),
    ...(protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot }),
  };
}

interface LaunchdSourceApprovalOptions {
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly requestId: string;
  readonly protectedReferenceRoot?: string;
}

function parseLaunchdSourceApprovalOptions(argumentsList: readonly string[]): LaunchdSourceApprovalOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0 || name === undefined || !name.startsWith('--') || values.has(name)) throw new Error(LAUNCHD_SOURCE_APPROVAL_USAGE);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(LAUNCHD_SOURCE_APPROVAL_USAGE);
    return value;
  };
  const allowed = new Set(['--source-root', '--control-script', '--executable', '--source-sha', '--source-tree', '--request-id', '--protected-reference-root']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(LAUNCHD_SOURCE_APPROVAL_USAGE);
  const protectedReferenceRoot = values.get('--protected-reference-root');
  return {
    sourceRoot: required('--source-root'),
    controlScript: required('--control-script'),
    executable: required('--executable'),
    sourceSha: required('--source-sha'),
    sourceTree: required('--source-tree'),
    requestId: required('--request-id'),
    ...(protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot }),
  };
}

const LAUNCHD_SOURCE_MIGRATION_USAGE = 'Usage: iris launchd migrate-source --source-root <directory> --control-script <file> --executable <file> --source-sha <commit> --source-tree <tree> --approval-id <uuid> --request-id <uuid> [--protected-reference-root <directory>]';
const LAUNCHD_SOURCE_APPROVAL_USAGE = 'Usage: iris launchd authorize-migrate-source --source-root <directory> --control-script <file> --executable <file> --source-sha <commit> --source-tree <tree> --request-id <uuid> [--protected-reference-root <directory>]';

function printStatus(status: Awaited<ReturnType<Awaited<ReturnType<typeof createSupervisor>>['status']>>): void {
  process.stdout.write(`IRIS_STACK=${status.state}\n`);
  process.stdout.write(`Runtime        ${status.runtime.state}\n`);
  process.stdout.write(`Web            ${status.web.state}\n`);
  process.stdout.write(`Tunnel         ${status.tunnel.state}\n`);
  process.stdout.write(`Control Plane  ${status.controlPlane.state}\n`);
  for (const connector of status.connectors) process.stdout.write(`${connector.label.padEnd(14)}${connector.state}\n`);
  process.stdout.write(`ChatGPT E2E    ${status.endToEnd.state}\n`);
}
