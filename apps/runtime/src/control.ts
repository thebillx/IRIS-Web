import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRuntimeDataRoot, RUNTIME_DATA_ENV } from './data-root.js';
import { startRuntime, stopRuntime, runtimeStatus } from './lifecycle.js';
import { readOwnerAccessSecret } from './persistence.js';
import { createSupervisor } from './supervisor.js';
import { installLaunchAgent, launchAgentLoaded, launchdPaths, uninstallLaunchAgent } from './launchd.js';
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
    } else if (command === 'launchd' && process.argv[3] === 'uninstall') {
      await uninstallLaunchAgent(dataRoot);
      process.stdout.write('IRIS_LAUNCHD=UNINSTALLED\n');
    } else if (command === 'launchd' && process.argv[3] === 'status') {
      process.stdout.write(`${JSON.stringify({ loaded: await launchAgentLoaded(), paths: launchdPaths(dataRoot) }, null, 2)}\n`);
    } else {
      process.stderr.write('Usage: iris <up|down|restart|status|doctor|connectors|connectors admin-bind <tunnel-id>|catalog status|catalog reload|logs|adopt-runtime|runtime-reconcile|supervisor|credentials|launchd>\n');
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

function printStatus(status: Awaited<ReturnType<Awaited<ReturnType<typeof createSupervisor>>['status']>>): void {
  process.stdout.write(`IRIS_STACK=${status.state}\n`);
  process.stdout.write(`Runtime        ${status.runtime.state}\n`);
  process.stdout.write(`Web            ${status.web.state}\n`);
  process.stdout.write(`Tunnel         ${status.tunnel.state}\n`);
  process.stdout.write(`Control Plane  ${status.controlPlane.state}\n`);
  for (const connector of status.connectors) process.stdout.write(`${connector.label.padEnd(14)}${connector.state}\n`);
  process.stdout.write(`ChatGPT E2E    ${status.endToEnd.state}\n`);
}
