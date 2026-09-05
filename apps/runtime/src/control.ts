import { resolveRuntimeDataRoot } from './data-root.js';
import { startRuntime, stopRuntime, runtimeStatus } from './lifecycle.js';
import { readOwnerAccessSecret } from './persistence.js';

const command = process.argv[2];
const dataRoot = await resolveRuntimeDataRoot();

if (command === 'start') {
  const status = await startRuntime({ dataRoot });
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
} else if (command === 'status') {
  process.stdout.write(`${JSON.stringify(await runtimeStatus(dataRoot), null, 2)}\n`);
} else if (command === 'stop') {
  process.stdout.write(`${JSON.stringify(await stopRuntime(dataRoot), null, 2)}\n`);
} else if (command === 'owner-token') {
  const secret = await readOwnerAccessSecret(dataRoot);
  if (secret === null) throw new Error('IRIS owner access credential is not initialized');
  process.stdout.write(`${secret}\n`);
} else {
  process.stderr.write('Usage: pnpm --filter @iris/runtime runtime <start|status|stop|owner-token>\n');
  process.exitCode = 2;
}
