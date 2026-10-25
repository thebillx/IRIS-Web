import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { readOwnerAccessSecret, readRuntimeIdentity } from './persistence.js';
import { probeRuntimeAuthority } from './authority.js';
import { createRuntimeBackup, ProductionSafetyController, restoreRuntimeBackup, verifyRuntimeBackup, type SafetyIdentity } from './production-safety.js';
import { createRuntimeWriterVerifier } from './production-safety-wiring.js';

const TOKEN_ENV = 'IRIS_OWNER_ACCESS_TOKEN';

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  if (command === undefined || !['inspect', 'quiesce', 'recover', 'unfence', 'backup', 'verify', 'restore', 'readiness', 'reconcile-reservation'].includes(command)) throw new Error('Usage: <inspect|quiesce|recover|unfence|backup|verify|restore|readiness|reconcile-reservation> --data-root <absolute-path>');
  const args = parseArgs(argv.slice(1));
  const dataRoot = args.get('data-root');
  if (dataRoot === undefined || !path.isAbsolute(dataRoot)) throw new Error('--data-root must be an absolute path');
  if (args.has('writer')) throw new Error('--writer assertions are not authoritative and are no longer accepted');
  if (command === 'inspect' || command === 'readiness') {
    const controller = await ProductionSafetyController.openReadOnly({ dataRoot, ...(command === 'readiness' ? { writerVerifier: createRuntimeWriterVerifier(dataRoot) } : {}) });
    const result = controller === null
      ? command === 'inspect'
        ? { status: 'NOT_INITIALIZED', fence: null }
        : { status: 'BLOCKED', reasons: ['production safety state is not initialized'], fence: null }
      : command === 'inspect' ? await controller.inspect() : await controller.readiness();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'verify') {
    const backup = args.get('backup');
    if (backup === undefined) throw new Error('--backup is required for verify');
    process.stdout.write(`${JSON.stringify(await verifyRuntimeBackup(backup), null, 2)}\n`);
    return;
  }
  const identity = await loadIdentity(dataRoot, command === 'recover');
  const ownerAccessSecret = await readOwnerAccessSecret(dataRoot);
  if (ownerAccessSecret === null) throw new Error('Owner access credential is unavailable');
  const token = process.env[TOKEN_ENV];
  if (token === undefined || token.length === 0) throw new Error(`${TOKEN_ENV} is required`);
  const supplied = Buffer.from(token);
  const expected = Buffer.from(ownerAccessSecret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new RuntimeError('CONTROL_DENIED', 'Owner authorization is invalid');
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret, writerVerifier: createRuntimeWriterVerifier(dataRoot) });
  let result: unknown;
  {
    if (command === 'quiesce') result = await controller.quiesce(token);
    else if (command === 'recover') result = await controller.recover(token, {});
    else if (command === 'unfence') result = await controller.unfence(token);
    else if (command === 'reconcile-reservation') {
      const reservationId = args.get('reservation-id');
      const reason = args.get('reason');
      if (reservationId === undefined || reason === undefined) throw new Error('reconcile-reservation requires --reservation-id and --reason');
      result = await controller.reconcileReservation(token, reservationId, reason).then(() => controller.inspect());
    }
    else if (command === 'backup') {
      const destination = args.get('destination');
      if (destination === undefined) throw new Error('--destination is required for backup');
      const checkpointFile = args.get('checkpoint-file');
      result = await createRuntimeBackup({ controller, ownerAccessToken: token, destination, ...(checkpointFile === undefined ? {} : { checkpointFile }) });
    } else {
      const backupRoot = args.get('backup');
      const destination = args.get('destination');
      if (backupRoot === undefined || destination === undefined || args.get('disposable') !== 'true') throw new Error('restore requires --backup, --destination, and --disposable true');
      const checkpointFile = args.get('checkpoint-file');
      result = await restoreRuntimeBackup({ controller, ownerAccessToken: token, backupRoot, destination, disposable: true, ...(checkpointFile === undefined ? {} : { checkpointFile }) });
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith('--')) throw new Error(`Unknown argument ${item}`);
    const equal = item.indexOf('=');
    if (equal > 2) result.set(item.slice(2, equal), item.slice(equal + 1));
    else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${item} requires a value`);
      result.set(item.slice(2), value);
      index += 1;
    }
  }
  return result;
}

async function loadIdentity(dataRoot: string, requireStopped: boolean): Promise<SafetyIdentity> {
  const controller = await ProductionSafetyController.openReadOnly({ dataRoot });
  if (controller === null) throw new RuntimeError('PRECONDITION_FAILED', 'Production safety state is not initialized');
  const identity = controller.snapshot().identity;
  const runtimeId = await readRuntimeIdentity(dataRoot);
  if (runtimeId === null || identity.runtimeId !== runtimeId || identity.dataRoot !== path.resolve(dataRoot)) throw new RuntimeError('AUTHORITY_CHANGED', 'Persisted runtime and safety identity disagree');
  const authority = await probeRuntimeAuthority(dataRoot);
  if (authority.state === 'indeterminate') throw new RuntimeError('AUTHORITY_INDETERMINATE', authority.reason);
  if (authority.state !== 'unowned' && (authority.identity.runtimeId !== runtimeId || authority.identity.instanceId !== identity.instanceId)) throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime authority does not match the safety identity');
  if (requireStopped && authority.state === 'live') throw new RuntimeError('PRECONDITION_FAILED', 'Recovery requires the Runtime owner to be stopped');
  return identity;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
