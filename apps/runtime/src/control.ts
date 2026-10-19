import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRuntimeDataRoot, RUNTIME_DATA_ENV } from './data-root.js';
import { startRuntime, stopRuntime, runtimeStatus } from './lifecycle.js';
import { readOwnerAccessSecret } from './persistence.js';
import { createSupervisor } from './supervisor.js';
import { installLaunchAgent, issueLaunchAgentSourceApproval, launchAgentStatus, migrateLaunchAgentSource, reconcileLaunchAgentSourceApproval, reconcileMalformedLegacyApproval, resolveReviewedRuntimeEntrypoints, stopLaunchAgentForMigration, uninstallLaunchAgent } from './launchd.js';
import { assertSupportedNodeVersion, canonicalNodeRuntime } from './node-runtime.js';
import { issueRecoveryAuthorizationPolicy, readRecoveryAuthorizationPolicy, reconcileRecoveryPolicyLock, reconcileRecoveryPolicyOperation, revokeRecoveryAuthorizationPolicy } from './recovery-policy.js';
import { readMachineId } from './machine-identity.js';

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
    if (command === 'recovery-policy' && process.argv[3] === 'issue') {
      const policy = parseRecoveryPolicyIssueOptions(process.argv.slice(4));
      const machineId = policy.allowedOperations.includes('SUPERVISOR_BOOTSTRAP') ? await readMachineId(dataRoot) : null;
      if (policy.allowedOperations.includes('SUPERVISOR_BOOTSTRAP') && machineId === null) throw new Error('Supervisor bootstrap policy requires an existing protected machine identity');
      const effectiveScope = { ...policy, dataRoot, ...(machineId === null ? {} : { machineId }) };
      process.stdout.write(`RECOVERY_POLICY_SCOPE=${JSON.stringify(effectiveScope)}\n`);
      const prompt = createInterface({ input, output });
      try {
        const confirmationPhrase = policy.supersedesPolicyId === undefined
          ? 'AUTHORIZE IRIS RECOVERY POLICY'
          : 'AUTHORIZE IRIS RECOVERY POLICY ROLLOVER';
        const confirmation = await prompt.question(`Type ${confirmationPhrase} to enroll the bounded recovery policy: `);
        if (confirmation.trim() !== confirmationPhrase) throw new Error('Owner recovery policy authorization was not confirmed');
      } finally { prompt.close(); }
      process.stdout.write(`${JSON.stringify(await issueRecoveryAuthorizationPolicy({ ...policy, sourceBindings: [{ sourceSha: policy.sourceSha, sourceTree: policy.sourceTree, sourceRoot: policy.sourceRoot, controlScript: policy.controlScript, executable: policy.executable, ...(policy.executableSha256 === undefined ? {} : { executableSha256: policy.executableSha256 }), executableArguments: policy.executableArguments, runtimePreflightSha256: policy.runtimePreflightSha256, runtimeLoaderSha256: policy.runtimeLoaderSha256 }], dataRoot, ...(machineId === null ? {} : { machineId }) }), null, 2)}\n`);
    } else if (command === 'recovery-policy' && process.argv[3] === 'status') {
      process.stdout.write(`${JSON.stringify(await readRecoveryAuthorizationPolicy(dataRoot), null, 2)}\n`);
    } else if (command === 'recovery-policy' && process.argv[3] === 'reconcile') {
      const recovery = parseRecoveryPolicyOperationOptions(process.argv.slice(4));
      process.stdout.write(`${JSON.stringify(await reconcileRecoveryPolicyOperation({ ...recovery, dataRoot }), null, 2)}\n`);
    } else if (command === 'recovery-policy' && process.argv[3] === 'reconcile-lock') {
      const lock = parseRecoveryPolicyLockOptions(process.argv.slice(4));
      await reconcileRecoveryPolicyLock(dataRoot, lock.lockId, lock.pid, lock.processStartMarker);
      process.stdout.write('RECOVERY_POLICY_LOCK_RECONCILED=YES\n');
    } else if (command === 'recovery-policy' && process.argv[3] === 'revoke') {
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type REVOKE IRIS RECOVERY POLICY to revoke the bounded recovery policy: ');
        if (confirmation.trim() !== 'REVOKE IRIS RECOVERY POLICY') throw new Error('Owner recovery policy revocation was not confirmed');
      } finally { prompt.close(); }
      process.stdout.write(`${JSON.stringify(await revokeRecoveryAuthorizationPolicy(dataRoot), null, 2)}\n`);
    } else if (command === 'up') {
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
      const tsx = await resolveReviewedRuntimeEntrypoints(runtimeDirectory);
      const executable = canonicalNodeRuntime().path;
      const script = path.join(runtimeDirectory, 'src', 'control.ts');
      const executableArguments = ['--require', tsx.preflight, '--import', pathToFileURL(tsx.loader).href];
      const protectedReferenceRoot = launchdInstallOptions?.protectedReferenceRoot ?? process.env.IRIS_PROTECTED_REFERENCE_ROOT?.trim();
      process.stdout.write(`${JSON.stringify(await installLaunchAgent(dataRoot, executable, script, executableArguments, protectedReferenceRoot, {}, {
        recoveryPolicyId: launchdInstallOptions!.recoveryPolicyId,
        requestId: launchdInstallOptions!.requestId,
        sourceSha: launchdInstallOptions!.sourceSha,
        sourceTree: launchdInstallOptions!.sourceTree,
      }), null, 2)}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'migrate-source') {
      const migration = parseLaunchdSourceMigrationOptions(process.argv.slice(4));
      const runtimeDirectory = path.join(migration.sourceRoot, 'apps', 'runtime');
      const tsx = await resolveReviewedRuntimeEntrypoints(runtimeDirectory);
      process.stdout.write(`${JSON.stringify(await migrateLaunchAgentSource({
        dataRoot,
        sourceRoot: migration.sourceRoot,
        controlScript: migration.controlScript,
        executable: migration.executable,
        executableArguments: ['--require', tsx.preflight, '--import', pathToFileURL(tsx.loader).href],
        sourceSha: migration.sourceSha,
        sourceTree: migration.sourceTree,
        approvalId: migration.approvalId,
        requestId: migration.requestId,
        ...(migration.protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: migration.protectedReferenceRoot }),
        ...(migration.recoveryPolicyId === undefined ? {} : { recoveryPolicyId: migration.recoveryPolicyId }),
      }), null, 2)}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'stop-for-migration') {
      const stop = parseLaunchdStopForMigrationOptions(process.argv.slice(4));
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type STOP IRIS SUPERVISOR FOR MIGRATION to authorize the identity-bound stop: ');
        if (confirmation.trim() !== 'STOP IRIS SUPERVISOR FOR MIGRATION') throw new Error('Owner Supervisor stop authorization was not confirmed');
      } finally {
        prompt.close();
      }
      process.stdout.write(`${JSON.stringify(await stopLaunchAgentForMigration({ ...stop, dataRoot }, {}), null, 2)}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'authorize-migrate-source') {
      const approval = parseLaunchdSourceApprovalOptions(process.argv.slice(4));
      const runtimeDirectory = path.join(approval.sourceRoot, 'apps', 'runtime');
      const tsx = await resolveReviewedRuntimeEntrypoints(runtimeDirectory);
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
        executableArguments: ['--require', tsx.preflight, '--import', pathToFileURL(tsx.loader).href],
      });
      process.stdout.write(`${JSON.stringify({ approvalId: issued.approvalId, requestId: issued.requestId, state: issued.state })}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'reconcile-migrate-approval') {
      const reconciliation = parseLaunchdSourceApprovalReconciliationOptions(process.argv.slice(4));
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type RECONCILE IRIS MIGRATION APPROVAL to revoke the stale one-time authorization: ');
        if (confirmation.trim() !== 'RECONCILE IRIS MIGRATION APPROVAL') throw new Error('Owner approval reconciliation was not confirmed');
      } finally {
        prompt.close();
      }
      const reconciled = await reconcileLaunchAgentSourceApproval({ ...reconciliation, dataRoot });
      process.stdout.write(`${JSON.stringify({ approvalId: reconciled.approvalId, requestId: reconciled.requestId, sourceSha: reconciled.sourceSha, sourceTree: reconciled.sourceTree, state: reconciled.state })}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'reconcile-malformed-approval') {
      const recovery = parseMalformedApprovalRecoveryOptions(process.argv.slice(4));
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type RECONCILE MALFORMED IRIS APPROVAL to retire the malformed legacy authorization: ');
        if (confirmation.trim() !== 'RECONCILE MALFORMED IRIS APPROVAL') throw new Error('Malformed approval reconciliation was not confirmed');
      } finally {
        prompt.close();
      }
      const reconciled = await reconcileMalformedLegacyApproval({ ...recovery, dataRoot }, {});
      process.stdout.write(`${JSON.stringify({ transactionId: reconciled.transactionId, recoveryRequestId: reconciled.recoveryRequestId, approvalId: reconciled.approvalId, requestId: reconciled.requestId, state: reconciled.state })}\n`);
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
  recoveryPolicyId: string;
  requestId: string;
  sourceSha: string;
  sourceTree: string;
}

interface LaunchdSourceMigrationOptions {
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly executableSha256?: string | undefined;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly approvalId: string;
  readonly requestId: string;
  readonly protectedReferenceRoot?: string | undefined;
  readonly recoveryPolicyId?: string;
}

interface LaunchdSourceApprovalReconciliationOptions {
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly requestId: string;
}

interface MalformedApprovalRecoveryOptions {
  readonly approvalId: string;
  readonly requestId: string;
  readonly approvalSha256: string;
  readonly recoveryRequestId: string;
}

interface RecoveryPolicyIssueOptions {
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
  readonly allowedOperations: readonly ('MIGRATION_APPROVAL' | 'SOURCE_MIGRATION' | 'SUPERVISOR_BOOTSTRAP')[];
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly executableSha256?: string | undefined;
  readonly executableArguments: readonly string[];
  readonly runtimePreflightSha256: string;
  readonly runtimeLoaderSha256: string;
  readonly maxOperationCount: number;
  readonly expiresAt: string;
  readonly protectedReferenceRoot?: string | undefined;
  readonly supersedesPolicyId?: string | undefined;
}

interface RecoveryPolicyOperationOptions {
  readonly policyId: string;
  readonly operation: 'MIGRATION_APPROVAL' | 'SOURCE_MIGRATION' | 'SUPERVISOR_BOOTSTRAP';
  readonly requestId: string;
  readonly transactionId: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly sourceRoot: string;
  readonly controlScript: string;
  readonly executable: string;
  readonly executableSha256?: string;
  readonly executableArguments: readonly string[];
  readonly runtimePreflightSha256: string;
  readonly runtimeLoaderSha256: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
  readonly protectedReferenceRoot?: string | undefined;
  readonly machineId?: string;
}

interface RecoveryPolicyLockOptions {
  readonly lockId: string;
  readonly pid: number;
  readonly processStartMarker: string;
}

function parseRecoveryPolicyIssueOptions(argumentsList: readonly string[]): RecoveryPolicyIssueOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0 || name === undefined || !name.startsWith('--') || values.has(name)) throw new Error(RECOVERY_POLICY_USAGE);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(RECOVERY_POLICY_USAGE);
    return value;
  };
  const allowed = new Set(['--source-sha', '--source-tree', '--source-root', '--control-script', '--executable', '--executable-sha256', '--executable-arguments', '--runtime-preflight-sha256', '--runtime-loader-sha256', '--before-metadata-sha256', '--before-plist-sha256', '--allowed-operations', '--max-operations', '--expires-at', '--protected-reference-root', '--supersedes-policy-id']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(RECOVERY_POLICY_USAGE);
  const maxOperationCount = Number(required('--max-operations'));
  if (!Number.isInteger(maxOperationCount)) throw new Error(RECOVERY_POLICY_USAGE);
  return {
    sourceSha: required('--source-sha'),
    sourceTree: required('--source-tree'),
    beforeMetadataSha256: required('--before-metadata-sha256'),
    beforePlistSha256: required('--before-plist-sha256'),
    allowedOperations: required('--allowed-operations').split(',').map((value) => value.trim()) as RecoveryPolicyIssueOptions['allowedOperations'],
    sourceRoot: required('--source-root'),
    controlScript: required('--control-script'),
    executable: required('--executable'),
    ...(values.get('--executable-sha256') === undefined ? {} : { executableSha256: values.get('--executable-sha256') }),
    executableArguments: JSON.parse(required('--executable-arguments')) as string[],
    runtimePreflightSha256: required('--runtime-preflight-sha256'),
    runtimeLoaderSha256: required('--runtime-loader-sha256'),
    maxOperationCount,
    expiresAt: required('--expires-at'),
    ...(values.get('--protected-reference-root') === undefined ? {} : { protectedReferenceRoot: values.get('--protected-reference-root') }),
    ...(values.get('--supersedes-policy-id') === undefined ? {} : { supersedesPolicyId: values.get('--supersedes-policy-id') }),
  };
}

function parseRecoveryPolicyOperationOptions(argumentsList: readonly string[]): RecoveryPolicyOperationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0 || name === undefined || !name.startsWith('--') || values.has(name)) throw new Error(RECOVERY_POLICY_OPERATION_USAGE);
    values.set(name, value);
  }
  const required = (name: string): string => { const value = values.get(name); if (value === undefined) throw new Error(RECOVERY_POLICY_OPERATION_USAGE); return value; };
  const allowed = new Set(['--policy-id', '--operation', '--request-id', '--transaction-id', '--source-sha', '--source-tree', '--source-root', '--control-script', '--executable', '--executable-sha256', '--executable-arguments', '--runtime-preflight-sha256', '--runtime-loader-sha256', '--before-metadata-sha256', '--before-plist-sha256', '--protected-reference-root', '--machine-id']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(RECOVERY_POLICY_OPERATION_USAGE);
  const operation = required('--operation');
  if (operation !== 'MIGRATION_APPROVAL' && operation !== 'SOURCE_MIGRATION' && operation !== 'SUPERVISOR_BOOTSTRAP') throw new Error(RECOVERY_POLICY_OPERATION_USAGE);
  const executableSha256 = values.get('--executable-sha256');
  const machineId = values.get('--machine-id');
  if (operation === 'SUPERVISOR_BOOTSTRAP' && (executableSha256 === undefined || machineId === undefined)) throw new Error(RECOVERY_POLICY_OPERATION_USAGE);
  return { policyId: required('--policy-id'), operation, requestId: required('--request-id'), transactionId: required('--transaction-id'), sourceSha: required('--source-sha'), sourceTree: required('--source-tree'), sourceRoot: required('--source-root'), controlScript: required('--control-script'), executable: required('--executable'), ...(executableSha256 === undefined ? {} : { executableSha256 }), executableArguments: JSON.parse(required('--executable-arguments')) as string[], runtimePreflightSha256: required('--runtime-preflight-sha256'), runtimeLoaderSha256: required('--runtime-loader-sha256'), beforeMetadataSha256: required('--before-metadata-sha256'), beforePlistSha256: required('--before-plist-sha256'), ...(values.get('--protected-reference-root') === undefined ? {} : { protectedReferenceRoot: values.get('--protected-reference-root') }), ...(machineId === undefined ? {} : { machineId }) };
}

function parseRecoveryPolicyLockOptions(argumentsList: readonly string[]): RecoveryPolicyLockOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0 || name === undefined || !name.startsWith('--') || values.has(name)) throw new Error(RECOVERY_POLICY_LOCK_USAGE);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(RECOVERY_POLICY_LOCK_USAGE);
    return value;
  };
  const allowed = new Set(['--lock-id', '--pid', '--process-start-marker']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(RECOVERY_POLICY_LOCK_USAGE);
  const pid = Number(required('--pid'));
  if (!Number.isSafeInteger(pid)) throw new Error(RECOVERY_POLICY_LOCK_USAGE);
  return { lockId: required('--lock-id'), pid, processStartMarker: required('--process-start-marker') };
}

const LAUNCHD_INSTALL_USAGE = 'Usage: iris launchd install --recovery-policy-id <uuid> --request-id <uuid> --source-sha <commit> --source-tree <tree> [--runtime-data-root <external-directory>] [--protected-reference-root <existing-directory>]';

function parseLaunchdInstallOptions(argumentsList: readonly string[]): LaunchdInstallOptions {
  if (argumentsList.length % 2 !== 0) throw new Error(LAUNCHD_INSTALL_USAGE);
  const parsed: Partial<LaunchdInstallOptions> = {};
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
    } else if (name === '--recovery-policy-id') {
      if (parsed.recoveryPolicyId !== undefined) throw new Error(LAUNCHD_INSTALL_USAGE);
      parsed.recoveryPolicyId = value;
    } else if (name === '--request-id') {
      if (parsed.requestId !== undefined) throw new Error(LAUNCHD_INSTALL_USAGE);
      parsed.requestId = value;
    } else if (name === '--source-sha') {
      if (parsed.sourceSha !== undefined) throw new Error(LAUNCHD_INSTALL_USAGE);
      parsed.sourceSha = value;
    } else if (name === '--source-tree') {
      if (parsed.sourceTree !== undefined) throw new Error(LAUNCHD_INSTALL_USAGE);
      parsed.sourceTree = value;
    } else {
      throw new Error(LAUNCHD_INSTALL_USAGE);
    }
  }
  if (parsed.recoveryPolicyId === undefined || parsed.requestId === undefined || parsed.sourceSha === undefined || parsed.sourceTree === undefined) throw new Error(LAUNCHD_INSTALL_USAGE);
  return parsed as LaunchdInstallOptions;
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
  const allowed = new Set(['--source-root', '--control-script', '--executable', '--source-sha', '--source-tree', '--approval-id', '--request-id', '--protected-reference-root', '--recovery-policy-id']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(LAUNCHD_SOURCE_MIGRATION_USAGE);
  const protectedReferenceRoot = values.get('--protected-reference-root');
  const recoveryPolicyId = values.get('--recovery-policy-id');
  return {
    sourceRoot: required('--source-root'),
    controlScript: required('--control-script'),
    executable: required('--executable'),
    sourceSha: required('--source-sha'),
    sourceTree: required('--source-tree'),
    approvalId: required('--approval-id'),
    requestId: required('--request-id'),
    ...(protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot }),
    ...(recoveryPolicyId === undefined ? {} : { recoveryPolicyId }),
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
  readonly recoveryPolicyId?: string;
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
  const allowed = new Set(['--source-root', '--control-script', '--executable', '--source-sha', '--source-tree', '--request-id', '--protected-reference-root', '--recovery-policy-id']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(LAUNCHD_SOURCE_APPROVAL_USAGE);
  const protectedReferenceRoot = values.get('--protected-reference-root');
  const recoveryPolicyId = values.get('--recovery-policy-id');
  return {
    sourceRoot: required('--source-root'),
    controlScript: required('--control-script'),
    executable: required('--executable'),
    sourceSha: required('--source-sha'),
    sourceTree: required('--source-tree'),
    requestId: required('--request-id'),
    ...(protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot }),
    ...(recoveryPolicyId === undefined ? {} : { recoveryPolicyId }),
  };
}

function parseLaunchdSourceApprovalReconciliationOptions(argumentsList: readonly string[]): LaunchdSourceApprovalReconciliationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0 || name === undefined || !name.startsWith('--') || values.has(name)) throw new Error(LAUNCHD_SOURCE_APPROVAL_RECONCILIATION_USAGE);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(LAUNCHD_SOURCE_APPROVAL_RECONCILIATION_USAGE);
    return value;
  };
  const allowed = new Set(['--source-sha', '--source-tree', '--request-id']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(LAUNCHD_SOURCE_APPROVAL_RECONCILIATION_USAGE);
  return { sourceSha: required('--source-sha'), sourceTree: required('--source-tree'), requestId: required('--request-id') };
}

function parseMalformedApprovalRecoveryOptions(argumentsList: readonly string[]): MalformedApprovalRecoveryOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0 || name === undefined || !name.startsWith('--') || values.has(name)) throw new Error(MALFORMED_APPROVAL_RECOVERY_USAGE);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(MALFORMED_APPROVAL_RECOVERY_USAGE);
    return value;
  };
  const allowed = new Set(['--approval-id', '--request-id', '--approval-sha256', '--recovery-request-id']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(MALFORMED_APPROVAL_RECOVERY_USAGE);
  return {
    approvalId: required('--approval-id'),
    requestId: required('--request-id'),
    approvalSha256: required('--approval-sha256'),
    recoveryRequestId: required('--recovery-request-id'),
  };
}

const LAUNCHD_SOURCE_MIGRATION_USAGE = 'Usage: iris launchd migrate-source --source-root <directory> --control-script <file> --executable <file> --source-sha <commit> --source-tree <tree> --approval-id <uuid> --request-id <uuid> [--protected-reference-root <directory>]';
const LAUNCHD_SOURCE_STOP_USAGE = 'Usage: iris launchd stop-for-migration --source-root <directory> --before-metadata-sha256 <digest> --before-plist-sha256 <digest>';
const LAUNCHD_SOURCE_APPROVAL_USAGE = 'Usage: iris launchd authorize-migrate-source --source-root <directory> --control-script <file> --executable <file> --source-sha <commit> --source-tree <tree> --request-id <uuid> [--protected-reference-root <directory>]';
const LAUNCHD_SOURCE_APPROVAL_RECONCILIATION_USAGE = 'Usage: iris launchd reconcile-migrate-approval --source-sha <commit> --source-tree <tree> --request-id <uuid>';
const MALFORMED_APPROVAL_RECOVERY_USAGE = 'Usage: iris launchd reconcile-malformed-approval --approval-id <uuid> --request-id <uuid> --approval-sha256 <digest> --recovery-request-id <uuid>';
const RECOVERY_POLICY_USAGE = 'Usage: iris recovery-policy issue --source-sha <commit> --source-tree <tree> --source-root <directory> --control-script <file> --executable <file> [--executable-sha256 <digest>] --executable-arguments <json-array> --runtime-preflight-sha256 <digest> --runtime-loader-sha256 <digest> --before-metadata-sha256 <digest> --before-plist-sha256 <digest> --allowed-operations <comma-separated> --max-operations <count> --expires-at <ISO> [--protected-reference-root <directory>] [--supersedes-policy-id <uuid>]';
const RECOVERY_POLICY_OPERATION_USAGE = 'Usage: iris recovery-policy reconcile --policy-id <uuid> --operation <MIGRATION_APPROVAL|SOURCE_MIGRATION|SUPERVISOR_BOOTSTRAP> --request-id <uuid> --transaction-id <uuid> --source-sha <commit> --source-tree <tree> --source-root <directory> --control-script <file> --executable <file> [--executable-sha256 <digest>] --executable-arguments <json-array> --runtime-preflight-sha256 <digest> --runtime-loader-sha256 <digest> --before-metadata-sha256 <digest> --before-plist-sha256 <digest> [--protected-reference-root <directory>] [--machine-id <uuid>]';
const RECOVERY_POLICY_LOCK_USAGE = 'Usage: iris recovery-policy reconcile-lock --lock-id <uuid> --pid <pid> --process-start-marker <marker>';

function parseLaunchdStopForMigrationOptions(argumentsList: readonly string[]): { readonly sourceRoot: string; readonly beforeMetadataSha256: string; readonly beforePlistSha256: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0 || name === undefined || !name.startsWith('--') || values.has(name)) throw new Error(LAUNCHD_SOURCE_STOP_USAGE);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(LAUNCHD_SOURCE_STOP_USAGE);
    return value;
  };
  const allowed = new Set(['--source-root', '--before-metadata-sha256', '--before-plist-sha256']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(LAUNCHD_SOURCE_STOP_USAGE);
  return { sourceRoot: required('--source-root'), beforeMetadataSha256: required('--before-metadata-sha256'), beforePlistSha256: required('--before-plist-sha256') };
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
