import { resolveRuntimeDataRoot } from './data-root.js';
import { startRuntime, stopRuntime, runtimeStatus } from './lifecycle.js';

const command = process.argv[2];
const dataRoot = await resolveRuntimeDataRoot();

if (command === 'start') {
  const status = await startRuntime({ dataRoot });
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
} else if (command === 'status') {
  process.stdout.write(`${JSON.stringify(await runtimeStatus(dataRoot), null, 2)}\n`);
} else if (command === 'stop') {
  process.stdout.write(`${JSON.stringify(await stopRuntime(dataRoot), null, 2)}\n`);
} else {
  process.stderr.write('Usage: pnpm --filter @iris/runtime runtime <start|status|stop>\n');
  process.exitCode = 2;
}
