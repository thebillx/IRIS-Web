import { resolveRuntimeDataRoot } from './data-root.js';
import { startSupervisorAdminServer } from './supervisor-admin.js';

const port = Number(process.env.IRIS_SUPERVISOR_ADMIN_PORT ?? '43111');
if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error('IRIS_SUPERVISOR_ADMIN_PORT is invalid');

const dataRoot = await resolveRuntimeDataRoot();
const server = await startSupervisorAdminServer(dataRoot, port);
let stopping = false;
const stop = () => { stopping = true; };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  while (!stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await server.close();
}
