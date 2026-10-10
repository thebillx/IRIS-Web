import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readEndpoint, readOwnerAccessSecret } from './persistence.js';
import { createRuntimeBackup, ProductionSafetyController, restoreRuntimeBackup, verifyRuntimeBackup, type SafetyIdentity, type WriterObservation } from './production-safety.js';

const TOKEN_ENV = 'IRIS_OWNER_ACCESS_TOKEN';

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  if (command === undefined || !['inspect', 'quiesce', 'recover', 'unfence', 'backup', 'verify', 'restore', 'readiness'].includes(command)) throw new Error('Usage: <inspect|quiesce|recover|unfence|backup|verify|restore|readiness> --data-root <absolute-path>');
  const args = parseArgs(argv.slice(1));
  const dataRoot = args.get('data-root');
  if (dataRoot === undefined || !path.isAbsolute(dataRoot)) throw new Error('--data-root must be an absolute path');
  const identity = await loadIdentity(dataRoot);
  const ownerAccessSecret = await readOwnerAccessSecret(dataRoot);
  if (ownerAccessSecret === null) throw new Error('Owner access credential is unavailable');
  const controller = await ProductionSafetyController.open({ dataRoot, identity, ownerAccessSecret });
  const token = process.env[TOKEN_ENV];
  const observations = parseObservations(args);
  let result: unknown;
  if (command === 'inspect') result = await controller.inspect();
  else if (command === 'readiness') result = await controller.readiness();
  else if (command === 'verify') {
    const backup = args.get('backup');
    if (backup === undefined) throw new Error('--backup is required for verify');
    result = await verifyRuntimeBackup(backup);
  }
  else {
    if (token === undefined || token.length === 0) throw new Error(`${TOKEN_ENV} is required`);
    if (command === 'quiesce') result = await controller.quiesce(token, observations);
    else if (command === 'recover') result = await controller.recover(token, observations);
    else if (command === 'unfence') result = await controller.unfence(token);
    else if (command === 'backup') {
      const destination = args.get('destination');
      if (destination === undefined) throw new Error('--destination is required for backup');
      result = await createRuntimeBackup({ controller, ownerAccessToken: token, destination });
    } else {
      const backupRoot = args.get('backup');
      const destination = args.get('destination');
      if (backupRoot === undefined || destination === undefined || args.get('disposable') !== 'true') throw new Error('restore requires --backup, --destination, and --disposable true');
      result = await restoreRuntimeBackup({ controller, ownerAccessToken: token, backupRoot, destination, disposable: true });
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

function parseObservations(args: Map<string, string>): Readonly<Record<string, WriterObservation>> {
  const raw = args.get('writer');
  if (raw === undefined) return {};
  const observations: Record<string, WriterObservation> = {};
  for (const item of raw.split(',')) {
    const equal = item.indexOf('=');
    if (equal < 1) throw new Error('--writer must be name=IDLE or name=UNKNOWN; separate writers with commas');
    const state = item.slice(equal + 1) as WriterObservation['state'];
    if (!['IDLE', 'ACTIVE', 'UNKNOWN'].includes(state)) throw new Error('--writer state is invalid');
    observations[item.slice(0, equal)] = { state };
  }
  return observations;
}

async function loadIdentity(dataRoot: string): Promise<SafetyIdentity> {
  const endpoint = await readEndpoint(dataRoot);
  if (endpoint !== null) return { runtimeId: endpoint.runtimeId, instanceId: endpoint.instanceId, dataRoot: path.resolve(dataRoot) };
  const document = JSON.parse(await readFile(path.join(dataRoot, 'production-safety.json'), 'utf8')) as { identity?: SafetyIdentity };
  if (document.identity === undefined) throw new Error('Runtime endpoint and safety identity are unavailable');
  return { ...document.identity, dataRoot: path.resolve(dataRoot) };
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
