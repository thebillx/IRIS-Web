import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRuntimeDataRoot, RUNTIME_DATA_ENV } from './data-root.js';
import { startRuntime, stopRuntime, runtimeStatus } from './lifecycle.js';
import { readOwnerAccessSecret } from './persistence.js';
import { inspectCredentialStatus, loadOrCreateTunnelServiceSecret } from './credentials.js';
import { createSupervisor } from './supervisor.js';
import { installLaunchAgent, launchAgentLoaded, launchdPaths, uninstallLaunchAgent } from './launchd.js';
import { assertSupportedNodeVersion, canonicalNodeRuntime } from './node-runtime.js';

const command = process.argv[2];
const legacyRuntimeControl = process.env.IRIS_STACK_CLI !== '1';

try {
  assertSupportedNodeVersion();
  const setupOptions = command === 'setup' ? parseSetupOptions(process.argv.slice(3)) : null;
  const launchdInstallOptions = command === 'launchd' && process.argv[3] === 'install'
    ? parseLaunchdInstallOptions(process.argv.slice(4))
    : null;
  const configuredDataRoot = setupOptions?.runtimeDataRoot ?? launchdInstallOptions?.runtimeDataRoot;
  const dataRoot = configuredDataRoot === undefined
    ? await resolveRuntimeDataRoot()
    : await resolveRuntimeDataRoot({ ...process.env, [RUNTIME_DATA_ENV]: configuredDataRoot });
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
    const supervisor = await createSupervisor({
      dataRoot,
      ...(setupOptions?.protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: setupOptions.protectedReferenceRoot }),
    });
    if (command === 'setup') {
      const result = await guidedSetup(supervisor, dataRoot, setupOptions!);
      process.stdout.write(setupOptions!.json ? `${JSON.stringify(result, null, 2)}\n` : formatSetupOutput(result));
    } else if (command === 'connectors' && process.argv[3] === 'init') {
      const tunnelId = process.argv[4];
      if (tunnelId === undefined || process.argv.length !== 5) throw new Error('Usage: iris connectors init <tunnel-id>');
      const registry = await supervisor.initializeUnified(tunnelId);
      process.stdout.write(`${JSON.stringify({ label: 'IRIS', tunnelId, mcpPath: '/mcp', deploymentEpoch: registry.deploymentEpoch }, null, 2)}\n`);
    } else if (command === 'up') {
      printStatus(await supervisor.up());
    } else if (command === 'workload-on') {
      printStatus(await supervisor.workloadOn());
    } else if (command === 'workload-off') {
      printStatus(await supervisor.workloadOff());
    } else if (command === 'workload-restart') {
      printStatus(await supervisor.workloadRestart());
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
      process.stderr.write('Usage: iris <setup --tunnel-id <registered-tunnel-id>|up|workload-on|workload-off|workload-restart|down|restart|status|doctor|connectors|connectors admin-bind <tunnel-id>|catalog status|catalog reload|logs|adopt-runtime|runtime-reconcile|supervisor|credentials|launchd>\n');
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

interface SetupOptions {
  readonly tunnelId: string;
  readonly runtimeDataRoot?: string;
  readonly protectedReferenceRoot?: string;
  readonly start: boolean;
  readonly json: boolean;
}

function parseSetupOptions(argumentsList: readonly string[]): SetupOptions {
  let tunnelId: string | undefined;
  let runtimeDataRoot: string | undefined;
  let protectedReferenceRoot: string | undefined;
  let start = false;
  let json = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const name = argumentsList[index];
    if (name === '--start') {
      if (start) throw new Error('Usage: iris setup --tunnel-id <registered-tunnel-id> [--start] [--json] [--runtime-data-root <directory>] [--protected-reference-root <directory>]');
      start = true;
      continue;
    }
    if (name === '--json') {
      if (json) throw new Error('Usage: iris setup --tunnel-id <registered-tunnel-id> [--start] [--json] [--runtime-data-root <directory>] [--protected-reference-root <directory>]');
      json = true;
      continue;
    }
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0) throw new Error('Usage: iris setup --tunnel-id <registered-tunnel-id> [--start] [--json] [--runtime-data-root <directory>] [--protected-reference-root <directory>]');
    if (name === '--tunnel-id' && tunnelId === undefined) tunnelId = value;
    else if (name === '--runtime-data-root' && runtimeDataRoot === undefined) runtimeDataRoot = value;
    else if (name === '--protected-reference-root' && protectedReferenceRoot === undefined) protectedReferenceRoot = value;
    else throw new Error('Usage: iris setup --tunnel-id <registered-tunnel-id> [--start] [--json] [--runtime-data-root <directory>] [--protected-reference-root <directory>]');
    index += 1;
  }
  if (tunnelId === undefined) throw new Error('Usage: iris setup --tunnel-id <registered-tunnel-id> [--start] [--json] [--runtime-data-root <directory>] [--protected-reference-root <directory>]');
  return { tunnelId, ...(runtimeDataRoot === undefined ? {} : { runtimeDataRoot }), ...(protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot }), start, json };
}

async function guidedSetup(supervisor: Awaited<ReturnType<typeof createSupervisor>>, dataRoot: string, options: SetupOptions): Promise<Record<string, unknown>> {
  if (process.platform !== 'darwin') throw new Error('IRIS setup is supported on macOS only');
  const credentials = await inspectCredentialStatus(dataRoot);
  const safeCredentials = {
    controlPlaneApiKeyPresent: credentials.controlPlaneApiKeyPresent,
    tunnelServicePresent: credentials.tunnelServicePresent,
    tunnelServiceGeneration: credentials.tunnelServiceGeneration,
    legacyMigrationRequired: credentials.legacy.migrationRequired,
  };
  if (!credentials.controlPlaneApiKeyPresent) {
    return {
      status: 'NEEDS_CREDENTIALS',
      credentials: safeCredentials,
      next: ['node scripts/iris.mjs credentials migrate <existing-profile-path>', `node scripts/iris.mjs setup --tunnel-id ${options.tunnelId}`],
      message: 'Provide the existing tunnel credential through the explicit migration command; no registry or runtime state was created.',
    };
  }
  let registry;
  let repeated = false;
  try {
    registry = await supervisor.initializeUnified(options.tunnelId);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error as { readonly code?: unknown }).code !== 'PRECONDITION_FAILED') throw error;
    const existing = await supervisor.connectors();
    if (existing.connectors.length !== 1 || existing.connectors[0]?.label !== 'IRIS' || existing.connectors[0].tunnelId !== options.tunnelId || existing.admin !== null) throw error;
    registry = existing;
    repeated = true;
  }
  await loadOrCreateTunnelServiceSecret(dataRoot);
  const configuredCredentials = await inspectCredentialStatus(dataRoot);
  const status = options.start ? await supervisor.up() : await supervisor.status();
  return {
    status: options.start ? (status.state === 'READY' ? 'READY' : 'NEEDS_ATTENTION') : 'READY_TO_START',
    repeated,
    machineId: registry.connectors[0]?.machineId ?? null,
    connector: { label: 'IRIS', tunnelId: options.tunnelId, mcpPath: '/mcp' },
    credentials: {
      controlPlaneApiKeyPresent: configuredCredentials.controlPlaneApiKeyPresent,
      tunnelServicePresent: configuredCredentials.tunnelServicePresent,
      tunnelServiceGeneration: configuredCredentials.tunnelServiceGeneration,
      legacyMigrationRequired: configuredCredentials.legacy.migrationRequired,
    },
    local: { stack: status.state, runtime: status.runtime, tunnel: status.tunnel, controlPlane: status.controlPlane },
    next: options.start ? ['node scripts/iris.mjs doctor', 'node scripts/iris.mjs launchd install'] : ['node scripts/iris.mjs up', 'node scripts/iris.mjs doctor', 'node scripts/iris.mjs launchd install'],
    message: 'Remote tunnel provisioning and ChatGPT connector selection remain owner-verifiable steps; this command does not claim either occurred.',
  };
}

function formatSetupOutput(result: Record<string, unknown>): string {
  const credentials = result.credentials as { controlPlaneApiKeyPresent?: boolean; tunnelServicePresent?: boolean } | undefined;
  const connector = result.connector as { tunnelId?: string } | undefined;
  const next = Array.isArray(result.next) ? result.next.filter((value): value is string => typeof value === 'string') : [];
  const local = result.local as { stack?: string } | undefined;
  const localRuntime = result.status === 'READY' ? 'Online' : result.status === 'NEEDS_ATTENTION' ? 'Needs Attention' : result.status === 'READY_TO_START' ? 'Offline (run iris up)' : 'Action Required';
  const credentialStatus = credentials?.controlPlaneApiKeyPresent && credentials.tunnelServicePresent ? 'Ready' : 'Action Required';
  const tunnelStatus = connector?.tunnelId === undefined ? 'Action Required' : 'Configured';
  const nextAction = next.length === 0 ? 'Inspect the setup result and ask the owner for the next authorized action.' : next.join(' → ');
  return [
    `IRIS_SETUP=${String(result.status ?? 'NEEDS_ATTENTION')}`,
    'Prerequisites  Ready (macOS, Node.js 24)',
    `Credentials    ${credentialStatus}`,
    `Tunnel         ${tunnelStatus}`,
    `Local Runtime  ${localRuntime}${local?.stack === undefined ? '' : ` [${local.stack}]`}`,
    'ChatGPT        Not Verified',
    `Next Action    ${nextAction}`,
    typeof result.message === 'string' ? `Details        ${result.message}` : '',
    '',
  ].filter((line) => line.length > 0).join('\n');
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
  if (status.connectors.length === 1 && status.connectors[0]?.label === 'IRIS') {
    const available = [status.runtime, status.web, status.tunnel, status.controlPlane, status.localRuntime].every((part) => part.state === 'READY');
    const label = status.runtime.code === 'RUNTIME_NOT_RUNNING' ? 'Offline' : available ? 'Online' : 'Needs Attention';
    process.stdout.write(`IRIS=${label}\n`);
    return;
  }
  process.stdout.write(`IRIS_STACK=${status.state}\n`);
  process.stdout.write(`Runtime        ${status.runtime.state}\n`);
  process.stdout.write(`Web            ${status.web.state}\n`);
  process.stdout.write(`Tunnel         ${status.tunnel.state}\n`);
  process.stdout.write(`Control Plane  ${status.controlPlane.state}\n`);
  for (const connector of status.connectors) process.stdout.write(`${connector.label.padEnd(14)}${connector.state}\n`);
  process.stdout.write(`ChatGPT E2E    ${status.endToEnd.state}\n`);
}
