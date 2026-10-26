import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRuntimeDataRoot, RUNTIME_DATA_ENV } from './data-root.js';
import { startRuntime, stopRuntime, runtimeStatus } from './lifecycle.js';
import { readOwnerAccessSecret } from './persistence.js';
import { readControlPlaneApiKey } from './credentials.js';
import { createSupervisor } from './supervisor.js';
import { issueInitialLaunchAgentPolicy, reconcileInitialLaunchAgentInstall, installLaunchAgent, issueLaunchAgentSourceApproval, launchAgentStatus, migrateLaunchAgentSource, reconcileLaunchAgentSourceApproval, reconcileMalformedLegacyApproval, reconcileStoppedLaunchAgent, resolveReviewedRuntimeEntrypoints, stopLaunchAgentForMigration, uninstallLaunchAgent, recordLoadedNoPidRecovery } from './launchd.js';
import { assertSupportedNodeVersion, canonicalNodeRuntime } from './node-runtime.js';
import { issueRecoveryAuthorizationPolicy, readRecoveryAuthorizationPolicy, reconcileRecoveryPolicyLock, reconcileRecoveryPolicyOperation, revokeRecoveryAuthorizationPolicy } from './recovery-policy.js';
import { readMachineId } from './machine-identity.js';
import { formatSetupOutput, guidedSetup, type GuidedSetupOptions } from './setup.js';

const command = process.argv[2];
const legacyRuntimeControl = process.env.IRIS_STACK_CLI !== '1';

try {
  assertSupportedNodeVersion();
  const launchdInstallOptions = command === 'launchd' && ['install', 'reconcile-install'].includes(process.argv[3] ?? '')
    ? parseLaunchdInstallOptions(process.argv.slice(4))
    : null;
  const setupOptions = command === 'setup' ? parseSetupOptions(process.argv.slice(3)) : null;
  const initialInstallOptions = command === 'launchd' && process.argv[3] === 'authorize-install' ? parseInitialInstallOptions(process.argv.slice(4)) : null;
  const configuredDataRoot = setupOptions?.runtimeDataRoot ?? launchdInstallOptions?.runtimeDataRoot ?? initialInstallOptions?.runtimeDataRoot;
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
    const supervisor = await createSupervisor({ dataRoot, ...(setupOptions?.protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot: setupOptions.protectedReferenceRoot }) });
    if (command === 'setup') {
      const result = await guidedSetup(supervisor, dataRoot, setupOptions!);
      process.stdout.write(setupOptions!.json ? `${JSON.stringify(result, null, 2)}\n` : formatSetupOutput(result));
    } else if (command === 'recovery-policy' && process.argv[3] === 'issue') {
      const policy = parseRecoveryPolicyIssueOptions(process.argv.slice(4));
      const machineBound = policy.allowedOperations.some((operation) => operation === 'SUPERVISOR_BOOTSTRAP' || operation === 'ADMIN_TUNNEL_START' || operation === 'SUPERVISOR_NO_PID_RECOVERY');
      const machineId = machineBound ? await readMachineId(dataRoot) : null;
      if (machineBound && machineId === null) throw new Error('Protected Supervisor recovery policy requires an existing machine identity');
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
    } else if (command === 'recovery-policy' && process.argv[3] === 'resolve-failed-admin-tunnel') {
      const recovery = parseRecoveryPolicyOperationOptions(process.argv.slice(4));
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type RECONCILE FAILED IRIS ADMIN TUNNEL START to close the verified failed operation: ');
        if (confirmation.trim() !== 'RECONCILE FAILED IRIS ADMIN TUNNEL START') throw new Error('Owner failed-operation reconciliation was not confirmed');
      } finally { prompt.close(); }
      if (recovery.startupTransactionId === undefined) throw new Error('Usage: recovery-policy resolve-failed-admin-tunnel requires --startup-transaction-id');
      process.stdout.write(`${JSON.stringify(await supervisor.reconcileFailedControlOnlyAdminTunnel({ ...recovery, startupTransactionId: recovery.startupTransactionId, dataRoot }), null, 2)}\n`);
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
    } else if (command === 'lifecycle-grant' && process.argv[3] === 'issue') {
      const grant = parseLifecycleGrantIssueOptions(process.argv.slice(4));
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type AUTHORIZE IRIS RUNTIME LIFECYCLE GRANT to issue the bounded runtime lifecycle grant: ');
        if (confirmation.trim() !== 'AUTHORIZE IRIS RUNTIME LIFECYCLE GRANT') throw new Error('Owner runtime lifecycle grant authorization was not confirmed');
      } finally { prompt.close(); }
      process.stdout.write(`${JSON.stringify(await supervisor.issueRuntimeLifecycleGrant(grant), null, 2)}\n`);
    } else if (command === 'lifecycle-grant' && process.argv[3] === 'status') {
      const { LifecycleGrantStore } = await import('./lifecycle-grant.js');
      process.stdout.write(`${JSON.stringify(await new LifecycleGrantStore(dataRoot).read(), null, 2)}\n`);
    } else if (command === 'lifecycle-grant' && process.argv[3] === 'revoke') {
      const grantId = process.argv[4];
      if (grantId === undefined) throw new Error('Usage: iris lifecycle-grant revoke <grant-id>');
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type REVOKE IRIS RUNTIME LIFECYCLE GRANT to revoke the bounded runtime lifecycle grant: ');
        if (confirmation.trim() !== 'REVOKE IRIS RUNTIME LIFECYCLE GRANT') throw new Error('Owner runtime lifecycle grant revocation was not confirmed');
      } finally { prompt.close(); }
      process.stdout.write(`${JSON.stringify(await supervisor.revokeRuntimeLifecycleGrant(grantId), null, 2)}\n`);
    } else if (command === 'lifecycle-grant' && process.argv[3] === 'reconcile') {
      const reconciliation = parseLifecycleGrantReconciliationOptions(process.argv.slice(4));
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type RECONCILE IRIS RUNTIME LIFECYCLE GRANT to close the verified operation: ');
        if (confirmation.trim() !== 'RECONCILE IRIS RUNTIME LIFECYCLE GRANT') throw new Error('Owner runtime lifecycle grant reconciliation was not confirmed');
      } finally { prompt.close(); }
      process.stdout.write(`${JSON.stringify(await supervisor.reconcileRuntimeLifecycleGrant(reconciliation.grantId, reconciliation.operationId), null, 2)}\n`);
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
    } else if (command === 'launchd' && process.argv[3] === 'authorize-install') {
      if (!input.isTTY || !output.isTTY) throw new Error('Initial installation requires an interactive Owner-local Terminal');
      const runtimeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const sourceRoot = path.resolve(runtimeDirectory, '../..');
      const tsx = await resolveReviewedRuntimeEntrypoints(runtimeDirectory);
      const ownerSecret = await readControlPlaneApiKey(dataRoot);
      if (ownerSecret === null) throw new Error('Initial installation requires the existing local Owner credential');
      const scope = { ...initialInstallOptions!, dataRoot, sourceRoot, controlScript: path.join(runtimeDirectory, 'src/control.ts'), executable: canonicalNodeRuntime().path,
        executableArguments: ['--require', tsx.preflight, '--import', pathToFileURL(tsx.loader).href] };
      process.stdout.write(`INITIAL_INSTALL_SCOPE=${JSON.stringify(scope)}\n`);
      const prompt = createInterface({ input, output });
      try {
        if ((await prompt.question('Type AUTHORIZE IRIS INITIAL INSTALL to enroll control-only login restoration: ')).trim() !== 'AUTHORIZE IRIS INITIAL INSTALL') throw new Error('Owner initial installation was not confirmed');
      } finally { prompt.close(); }
      process.stdout.write(`${JSON.stringify(await issueInitialLaunchAgentPolicy(scope, `Bearer ${ownerSecret}`), null, 2)}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'reconcile-install') {
      if (!input.isTTY || !output.isTTY) throw new Error('Initial installation reconciliation requires an interactive Owner-local Terminal');
      const ownerSecret = await readControlPlaneApiKey(dataRoot);
      if (ownerSecret === null) throw new Error('Initial installation reconciliation requires the existing local Owner credential');
      const prompt = createInterface({ input, output });
      try {
        if ((await prompt.question('Type RECONCILE IRIS INITIAL INSTALL to settle the verified installation: ')).trim() !== 'RECONCILE IRIS INITIAL INSTALL') throw new Error('Owner initial installation reconciliation was not confirmed');
      } finally { prompt.close(); }
      process.stdout.write(`${JSON.stringify(await reconcileInitialLaunchAgentInstall(dataRoot, launchdInstallOptions!, `Bearer ${ownerSecret}`), null, 2)}\n`);
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
    } else if (command === 'launchd' && process.argv[3] === 'record-no-pid-recovery') {
      const recovery = parseNoPidRecoveryOptions(process.argv.slice(4));
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type RECORD IRIS LOADED NO-PID RECOVERY to durably record this unresolved observation: ');
        if (confirmation.trim() !== 'RECORD IRIS LOADED NO-PID RECOVERY') throw new Error('Owner no-PID recovery record was not confirmed');
      } finally { prompt.close(); }
      process.stdout.write(`${JSON.stringify(await recordLoadedNoPidRecovery({ ...recovery, dataRoot }, {}), null, 2)}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'reconcile-stop') {
      const reconciliation = parseLaunchdStopReconciliationOptions(process.argv.slice(4));
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type RECONCILE IRIS SUPERVISOR STOP to finalize the verified-absent stop: ');
        if (confirmation.trim() !== 'RECONCILE IRIS SUPERVISOR STOP') throw new Error('Owner Supervisor stop reconciliation was not confirmed');
      } finally {
        prompt.close();
      }
      process.stdout.write(`${JSON.stringify(await reconcileStoppedLaunchAgent({ ...reconciliation, dataRoot }, {}), null, 2)}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'start-admin-tunnel') {
      const start = parseLaunchdAdminTunnelStartOptions(process.argv.slice(4));
      process.stdout.write(`${JSON.stringify(await supervisor.startControlOnlyAdminTunnel(start), null, 2)}\n`);
    } else if (command === 'launchd' && process.argv[3] === 'reconcile-admin-tunnel') {
      const reconciliation = parseLaunchdAdminTunnelReconciliationOptions(process.argv.slice(4));
      const prompt = createInterface({ input, output });
      try {
        const confirmation = await prompt.question('Type RECONCILE IRIS ADMIN TUNNEL START to finalize the verified running tunnel: ');
        if (confirmation.trim() !== 'RECONCILE IRIS ADMIN TUNNEL START') throw new Error('Owner ADMIN tunnel reconciliation was not confirmed');
      } finally {
        prompt.close();
      }
      process.stdout.write(`${JSON.stringify(await supervisor.reconcileControlOnlyAdminTunnel(reconciliation), null, 2)}\n`);
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
      process.stderr.write('Usage: iris <setup --full-tunnel-id <id> --pro-tunnel-id <id>|up|down|restart|status|doctor|connectors|catalog|logs|adopt-runtime|runtime-reconcile|startup-reconcile|supervisor|credentials|lifecycle-grant|launchd>\n');
      process.exitCode = 2;
    }
  }
} catch (error) {
  const code = error instanceof Error && 'code' in error ? String((error as { readonly code?: unknown }).code ?? 'IRIS_COMMAND_FAILED') : 'IRIS_COMMAND_FAILED';
  const message = error instanceof Error ? error.message : 'IRIS command failed';
  process.stderr.write(`IRIS_COMMAND_FAILED code=${code} message=${message}\n`);
  process.exitCode = 1;
}

interface SetupCliOptions extends GuidedSetupOptions {
  readonly runtimeDataRoot?: string;
  readonly protectedReferenceRoot?: string;
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
  readonly allowedOperations: readonly ('MIGRATION_APPROVAL' | 'SOURCE_MIGRATION' | 'SUPERVISOR_BOOTSTRAP' | 'ADMIN_TUNNEL_START' | 'SUPERVISOR_NO_PID_RECOVERY')[];
  readonly recordedSourceRoot?: string;
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
  readonly operation: 'MIGRATION_APPROVAL' | 'SOURCE_MIGRATION' | 'SUPERVISOR_BOOTSTRAP' | 'ADMIN_TUNNEL_START' | 'SUPERVISOR_NO_PID_RECOVERY';
  readonly requestId: string;
  readonly transactionId: string;
  readonly startupTransactionId: string | undefined;
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
  readonly recordedSourceRoot?: string;
  readonly protectedReferenceRoot?: string | undefined;
  readonly machineId?: string;
}

interface RecoveryPolicyLockOptions {
  readonly lockId: string;
  readonly pid: number;
  readonly processStartMarker: string;
}

interface LifecycleGrantIssueOptions {
  readonly requestId: string;
  readonly allowedOperations: readonly ('runtime_on' | 'runtime_off')[];
  readonly expiresAt: string;
  readonly maxOperationCount: number;
}

interface LifecycleGrantReconciliationOptions {
  readonly grantId: string;
  readonly operationId: string;
}

function parseLifecycleGrantIssueOptions(argumentsList: readonly string[]): LifecycleGrantIssueOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (name === undefined || value === undefined || value.length === 0 || !name.startsWith('--') || values.has(name)) throw new Error('Usage: iris lifecycle-grant issue --request-id <uuid> --operations <runtime_on,runtime_off> --expires-at <ISO-8601> --max-operations <n>');
    values.set(name, value);
  }
  const required = (name: string): string => values.get(name) ?? (() => { throw new Error('Usage: iris lifecycle-grant issue --request-id <uuid> --operations <runtime_on,runtime_off> --expires-at <ISO-8601> --max-operations <n>'); })();
  const allowed = new Set(['--request-id', '--operations', '--expires-at', '--max-operations']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error('Usage: iris lifecycle-grant issue --request-id <uuid> --operations <runtime_on,runtime_off> --expires-at <ISO-8601> --max-operations <n>');
  const operations = required('--operations').split(',').map((value) => value.trim()) as LifecycleGrantIssueOptions['allowedOperations'];
  const maxOperationCount = Number(required('--max-operations'));
  if (!Number.isSafeInteger(maxOperationCount)) throw new Error('Lifecycle grant max operations must be an integer');
  return { requestId: required('--request-id'), allowedOperations: operations, expiresAt: required('--expires-at'), maxOperationCount };
}

function parseLifecycleGrantReconciliationOptions(argumentsList: readonly string[]): LifecycleGrantReconciliationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (name === undefined || value === undefined || value.length === 0 || !name.startsWith('--') || values.has(name)) throw new Error('Usage: iris lifecycle-grant reconcile --grant-id <uuid> --operation-id <id>');
    values.set(name, value);
  }
  const grantId = values.get('--grant-id');
  const operationId = values.get('--operation-id');
  if (grantId === undefined || operationId === undefined || [...values.keys()].some((name) => !new Set(['--grant-id', '--operation-id']).has(name))) throw new Error('Usage: iris lifecycle-grant reconcile --grant-id <uuid> --operation-id <id>');
  return { grantId, operationId };
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
  const allowed = new Set(['--source-sha', '--source-tree', '--source-root', '--control-script', '--executable', '--executable-sha256', '--executable-arguments', '--runtime-preflight-sha256', '--runtime-loader-sha256', '--before-metadata-sha256', '--before-plist-sha256', '--recorded-source-root', '--allowed-operations', '--max-operations', '--expires-at', '--protected-reference-root', '--supersedes-policy-id']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(RECOVERY_POLICY_USAGE);
  const maxOperationCount = Number(required('--max-operations'));
  if (!Number.isInteger(maxOperationCount)) throw new Error(RECOVERY_POLICY_USAGE);
  const allowedOperations = required('--allowed-operations').split(',').map((value) => value.trim()) as RecoveryPolicyIssueOptions['allowedOperations'];
  const recordedSourceRoot = values.get('--recorded-source-root');
  if (allowedOperations.includes('SUPERVISOR_NO_PID_RECOVERY') !== (recordedSourceRoot !== undefined)) throw new Error(RECOVERY_POLICY_USAGE);
  return {
    sourceSha: required('--source-sha'),
    sourceTree: required('--source-tree'),
    beforeMetadataSha256: required('--before-metadata-sha256'),
    beforePlistSha256: required('--before-plist-sha256'),
    allowedOperations,
    ...(recordedSourceRoot === undefined ? {} : { recordedSourceRoot }),
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
  const allowed = new Set(['--policy-id', '--operation', '--request-id', '--transaction-id', '--startup-transaction-id', '--source-sha', '--source-tree', '--source-root', '--control-script', '--executable', '--executable-sha256', '--executable-arguments', '--runtime-preflight-sha256', '--runtime-loader-sha256', '--before-metadata-sha256', '--before-plist-sha256', '--recorded-source-root', '--protected-reference-root', '--machine-id']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(RECOVERY_POLICY_OPERATION_USAGE);
  const operation = required('--operation');
  if (operation !== 'MIGRATION_APPROVAL' && operation !== 'SOURCE_MIGRATION' && operation !== 'SUPERVISOR_BOOTSTRAP' && operation !== 'ADMIN_TUNNEL_START' && operation !== 'SUPERVISOR_NO_PID_RECOVERY') throw new Error(RECOVERY_POLICY_OPERATION_USAGE);
  const executableSha256 = values.get('--executable-sha256');
  const machineId = values.get('--machine-id');
  if ((operation === 'SUPERVISOR_BOOTSTRAP' || operation === 'ADMIN_TUNNEL_START' || operation === 'SUPERVISOR_NO_PID_RECOVERY') && (executableSha256 === undefined || machineId === undefined)) throw new Error(RECOVERY_POLICY_OPERATION_USAGE);
  const recordedSourceRoot = values.get('--recorded-source-root');
  if (operation === 'SUPERVISOR_NO_PID_RECOVERY' !== (recordedSourceRoot !== undefined)) throw new Error(RECOVERY_POLICY_OPERATION_USAGE);
  return { policyId: required('--policy-id'), operation, requestId: required('--request-id'), transactionId: required('--transaction-id'), startupTransactionId: values.get('--startup-transaction-id'), sourceSha: required('--source-sha'), sourceTree: required('--source-tree'), sourceRoot: required('--source-root'), controlScript: required('--control-script'), executable: required('--executable'), ...(executableSha256 === undefined ? {} : { executableSha256 }), executableArguments: JSON.parse(required('--executable-arguments')) as string[], runtimePreflightSha256: required('--runtime-preflight-sha256'), runtimeLoaderSha256: required('--runtime-loader-sha256'), beforeMetadataSha256: required('--before-metadata-sha256'), beforePlistSha256: required('--before-plist-sha256'), ...(recordedSourceRoot === undefined ? {} : { recordedSourceRoot }), ...(values.get('--protected-reference-root') === undefined ? {} : { protectedReferenceRoot: values.get('--protected-reference-root') }), ...(machineId === undefined ? {} : { machineId }) };
}

function parseNoPidRecoveryOptions(argumentsList: readonly string[]): { readonly recoveryPolicyId: string; readonly requestId: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (name === undefined || value === undefined || value.length === 0 || values.has(name)) throw new Error(NO_PID_RECOVERY_USAGE);
    values.set(name, value);
  }
  if ([...values.keys()].some((name) => name !== '--recovery-policy-id' && name !== '--request-id')) throw new Error(NO_PID_RECOVERY_USAGE);
  const recoveryPolicyId = values.get('--recovery-policy-id');
  const requestId = values.get('--request-id');
  if (recoveryPolicyId === undefined || requestId === undefined) throw new Error(NO_PID_RECOVERY_USAGE);
  return { recoveryPolicyId, requestId };
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
const SETUP_USAGE = 'Usage: iris setup --one-tunnel-id <id> | --full-tunnel-id <id> --pro-tunnel-id <id> [--admin-tunnel-id <id>] [--start] [--json] [--runtime-data-root <directory>] [--protected-reference-root <directory>]';

function parseSetupOptions(argumentsList: readonly string[]): SetupCliOptions {
  let unifiedTunnelId: string | undefined;
  let fullTunnelId: string | undefined;
  let proTunnelId: string | undefined;
  let adminTunnelId: string | undefined;
  let runtimeDataRoot: string | undefined;
  let protectedReferenceRoot: string | undefined;
  let start = false;
  let json = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const name = argumentsList[index];
    if (name === '--start' || name === '--json') {
      if (name === '--start' ? start : json) throw new Error(SETUP_USAGE);
      if (name === '--start') start = true; else json = true;
      continue;
    }
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0) throw new Error(SETUP_USAGE);
    if (name === '--one-tunnel-id' && unifiedTunnelId === undefined) unifiedTunnelId = value;
    else if (name === '--full-tunnel-id' && fullTunnelId === undefined) fullTunnelId = value;
    else if (name === '--pro-tunnel-id' && proTunnelId === undefined) proTunnelId = value;
    else if (name === '--admin-tunnel-id' && adminTunnelId === undefined) adminTunnelId = value;
    else if (name === '--runtime-data-root' && runtimeDataRoot === undefined) runtimeDataRoot = value;
    else if (name === '--protected-reference-root' && protectedReferenceRoot === undefined) protectedReferenceRoot = value;
    else throw new Error(SETUP_USAGE);
    index += 1;
  }
  if (unifiedTunnelId !== undefined && (fullTunnelId !== undefined || proTunnelId !== undefined || adminTunnelId !== undefined)) throw new Error(SETUP_USAGE);
  if ((fullTunnelId === undefined) !== (proTunnelId === undefined)) throw new Error(SETUP_USAGE);
  return { ...(unifiedTunnelId === undefined ? {} : { unifiedTunnelId }), ...(fullTunnelId === undefined ? {} : { fullTunnelId }), ...(proTunnelId === undefined ? {} : { proTunnelId }), ...(adminTunnelId === undefined ? {} : { adminTunnelId }), ...(runtimeDataRoot === undefined ? {} : { runtimeDataRoot }), ...(protectedReferenceRoot === undefined ? {} : { protectedReferenceRoot }), start, json };
}

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
const LAUNCHD_SOURCE_STOP_RECONCILIATION_USAGE = 'Usage: iris launchd reconcile-stop --source-root <directory> --before-metadata-sha256 <digest> --before-plist-sha256 <digest>';
const LAUNCHD_ADMIN_TUNNEL_START_USAGE = 'Usage: iris launchd start-admin-tunnel --recovery-policy-id <uuid> --request-id <uuid> --source-sha <commit> --source-tree <tree> --before-metadata-sha256 <digest> --before-plist-sha256 <digest>';
const LAUNCHD_ADMIN_TUNNEL_RECONCILIATION_USAGE = 'Usage: iris launchd reconcile-admin-tunnel --recovery-policy-id <uuid> --request-id <uuid> --transaction-id <uuid> --source-sha <commit> --source-tree <tree> --before-metadata-sha256 <digest> --before-plist-sha256 <digest> --pid <pid> --process-start-marker <marker> --tunnel-id <id> --profile-digest <digest>';
const LAUNCHD_SOURCE_APPROVAL_USAGE = 'Usage: iris launchd authorize-migrate-source --source-root <directory> --control-script <file> --executable <file> --source-sha <commit> --source-tree <tree> --request-id <uuid> [--protected-reference-root <directory>]';
const LAUNCHD_SOURCE_APPROVAL_RECONCILIATION_USAGE = 'Usage: iris launchd reconcile-migrate-approval --source-sha <commit> --source-tree <tree> --request-id <uuid>';
const MALFORMED_APPROVAL_RECOVERY_USAGE = 'Usage: iris launchd reconcile-malformed-approval --approval-id <uuid> --request-id <uuid> --approval-sha256 <digest> --recovery-request-id <uuid>';
const RECOVERY_POLICY_USAGE = 'Usage: iris recovery-policy issue --source-sha <commit> --source-tree <tree> --source-root <directory> --control-script <file> --executable <file> [--executable-sha256 <digest>] --executable-arguments <json-array> --runtime-preflight-sha256 <digest> --runtime-loader-sha256 <digest> --before-metadata-sha256 <digest> --before-plist-sha256 <digest> [--recorded-source-root <missing historical directory>] --allowed-operations <comma-separated> --max-operations <count> --expires-at <ISO> [--protected-reference-root <directory>] [--supersedes-policy-id <uuid>]';
const RECOVERY_POLICY_OPERATION_USAGE = 'Usage: iris recovery-policy reconcile --policy-id <uuid> --operation <MIGRATION_APPROVAL|SOURCE_MIGRATION|SUPERVISOR_BOOTSTRAP|ADMIN_TUNNEL_START|SUPERVISOR_NO_PID_RECOVERY> --request-id <uuid> --transaction-id <uuid> --source-sha <commit> --source-tree <tree> --source-root <directory> --control-script <file> --executable <file> [--executable-sha256 <digest>] --executable-arguments <json-array> --runtime-preflight-sha256 <digest> --runtime-loader-sha256 <digest> --before-metadata-sha256 <digest> --before-plist-sha256 <digest> [--protected-reference-root <directory>] [--machine-id <uuid>]';
const NO_PID_RECOVERY_USAGE = 'Usage: iris launchd record-no-pid-recovery --recovery-policy-id <uuid> --request-id <uuid>';
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

function parseLaunchdStopReconciliationOptions(argumentsList: readonly string[]): { readonly sourceRoot: string; readonly beforeMetadataSha256: string; readonly beforePlistSha256: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0 || name === undefined || !name.startsWith('--') || values.has(name)) throw new Error(LAUNCHD_SOURCE_STOP_RECONCILIATION_USAGE);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(LAUNCHD_SOURCE_STOP_RECONCILIATION_USAGE);
    return value;
  };
  const allowed = new Set(['--source-root', '--before-metadata-sha256', '--before-plist-sha256']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(LAUNCHD_SOURCE_STOP_RECONCILIATION_USAGE);
  return { sourceRoot: required('--source-root'), beforeMetadataSha256: required('--before-metadata-sha256'), beforePlistSha256: required('--before-plist-sha256') };
}

function parseLaunchdAdminTunnelStartOptions(argumentsList: readonly string[]): {
  readonly recoveryPolicyId: string;
  readonly requestId: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0 || name === undefined || !name.startsWith('--') || values.has(name)) throw new Error(LAUNCHD_ADMIN_TUNNEL_START_USAGE);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(LAUNCHD_ADMIN_TUNNEL_START_USAGE);
    return value;
  };
  const allowed = new Set(['--recovery-policy-id', '--request-id', '--source-sha', '--source-tree', '--before-metadata-sha256', '--before-plist-sha256']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(LAUNCHD_ADMIN_TUNNEL_START_USAGE);
  return {
    recoveryPolicyId: required('--recovery-policy-id'),
    requestId: required('--request-id'),
    sourceSha: required('--source-sha'),
    sourceTree: required('--source-tree'),
    beforeMetadataSha256: required('--before-metadata-sha256'),
    beforePlistSha256: required('--before-plist-sha256'),
  };
}

function parseLaunchdAdminTunnelReconciliationOptions(argumentsList: readonly string[]): {
  readonly recoveryPolicyId: string;
  readonly requestId: string;
  readonly transactionId: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly beforeMetadataSha256: string;
  readonly beforePlistSha256: string;
  readonly pid: number;
  readonly processStartMarker: string;
  readonly tunnelId: string;
  readonly profileDigest: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0 || name === undefined || !name.startsWith('--') || values.has(name)) throw new Error(LAUNCHD_ADMIN_TUNNEL_RECONCILIATION_USAGE);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(LAUNCHD_ADMIN_TUNNEL_RECONCILIATION_USAGE);
    return value;
  };
  const allowed = new Set(['--recovery-policy-id', '--request-id', '--transaction-id', '--source-sha', '--source-tree', '--before-metadata-sha256', '--before-plist-sha256', '--pid', '--process-start-marker', '--tunnel-id', '--profile-digest']);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error(LAUNCHD_ADMIN_TUNNEL_RECONCILIATION_USAGE);
  const pid = Number(required('--pid'));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(LAUNCHD_ADMIN_TUNNEL_RECONCILIATION_USAGE);
  return {
    recoveryPolicyId: required('--recovery-policy-id'),
    requestId: required('--request-id'),
    transactionId: required('--transaction-id'),
    sourceSha: required('--source-sha'),
    sourceTree: required('--source-tree'),
    beforeMetadataSha256: required('--before-metadata-sha256'),
    beforePlistSha256: required('--before-plist-sha256'),
    pid,
    processStartMarker: required('--process-start-marker'),
    tunnelId: required('--tunnel-id'),
    profileDigest: required('--profile-digest'),
  };
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

function parseInitialInstallOptions(args: readonly string[]): { sourceSha: string; sourceTree: string; tunnelExecutable: string; expiresAt: string; runtimeDataRoot?: string; protectedReferenceRoot?: string; supersedesPolicyId?: string } {
  const allowed = new Set(['--source-sha', '--source-tree', '--tunnel-executable', '--expires-at', '--runtime-data-root', '--protected-reference-root', '--supersedes-policy-id']);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1]?.trim();
    if (name === undefined || !allowed.has(name) || values.has(name) || !value) throw new Error('Usage: iris launchd authorize-install --source-sha <sha> --source-tree <tree> --tunnel-executable <absolute-file> --expires-at <ISO> [--runtime-data-root <directory>]');
    values.set(name, value);
  }
  const required = (name: string) => { const value = values.get(name); if (value === undefined) throw new Error(`Missing ${name}`); return value; };
  return { sourceSha: required('--source-sha'), sourceTree: required('--source-tree'), tunnelExecutable: required('--tunnel-executable'), expiresAt: required('--expires-at'),
    ...(values.has('--runtime-data-root') ? { runtimeDataRoot: values.get('--runtime-data-root')! } : {}),
    ...(values.has('--protected-reference-root') ? { protectedReferenceRoot: values.get('--protected-reference-root')! } : {}),
    ...(values.has('--supersedes-policy-id') ? { supersedesPolicyId: values.get('--supersedes-policy-id')! } : {}) };
}
