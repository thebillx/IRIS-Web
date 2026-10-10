import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ProductionSafetyController } from './production-safety.js';
import { observeProcessStart } from './macos-safety.js';

const [dataRoot, mode] = process.argv.slice(2);
if (dataRoot === undefined || mode === undefined) throw new Error('data root and mode are required');

if (mode === 'lock') {
  const filename = path.join(dataRoot, 'production-safety.lock');
  const processStart = observeProcessStart(process.pid);
  if (processStart.state !== 'live') throw new Error('child process identity is unavailable');
  await writeFile(filename, `${JSON.stringify({ pid: process.pid, processStartMarker: processStart.marker })}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write('READY\n');
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  await rm(filename, { force: true });
} else {
  const controller = await ProductionSafetyController.open({
    dataRoot,
    identity: { runtimeId: 'runtime-test', instanceId: 'instance-test', dataRoot: path.resolve(dataRoot) },
    ownerAccessSecret: 'owner-token-for-test',
  });
  const lease = await controller.beginMutation('runtime-state');
  process.stdout.write('READY\n');
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  await lease.release();
}
