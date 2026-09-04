import { startDaemon } from './daemon.js';

const daemon = await startDaemon();
process.stdout.write(`IRIS_RUNTIME_URL=${daemon.apiUrl}\nIRIS_MCP_URL=${daemon.mcpUrl}\n`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  try { await daemon.close(); process.exitCode = 0; }
  catch (error) { process.stderr.write(`IRIS shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
};

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
