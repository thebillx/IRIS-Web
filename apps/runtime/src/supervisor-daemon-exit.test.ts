import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateTunnelServiceSecret } from './credentials.js';
import { canonicalNodeRuntime, node24Environment } from './node-runtime.js';
import { renderLaunchAgent } from './launchd.js';

const exec = promisify(execFile);
const roots: string[] = [];
const sourceRoot = path.resolve(import.meta.dirname, '../../..');
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-exit-status-'))); roots.push(root);
  await mkdir(path.join(root, 'supervisor'), { mode: 0o700 });
  await loadOrCreateTunnelServiceSecret(root);
  const ports = new Set<number>();
  while (ports.size < 3) {
    const server = createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!(port >= 43110 && port <= 43113) && !(port >= 46710 && port <= 46716)) ports.add(port);
  }
  return { root, ports: [...ports] };
}
async function program(root: string, ports: number[], body: string) {
  const script = `
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
const [root, source, ...ports] = process.argv.slice(1);
const { createSupervisor } = await import(pathToFileURL(source + '/apps/runtime/src/supervisor.ts').href);
${body}
`;
  return exec(canonicalNodeRuntime().path, ['--import', path.join(sourceRoot, 'apps/runtime/node_modules/tsx/dist/loader.mjs'), '--input-type=module', '--eval', script, root, sourceRoot, ...ports.map(String)], {
    cwd: sourceRoot, timeout: 10000,
    env: node24Environment({ HOME: os.homedir(), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8' }),
  });
}

describe('Supervisor actual exit status under SuccessfulExit:false KeepAlive', () => {
  it('returns OS exit zero only after a real bind failure is durable; relaunch does not spawn', async () => {
    const { root, ports } = await fixture();
    const result = await program(root, ports, `
const occupied = createServer();
await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
const occupiedPort = occupied.address().port;
const supervisor = await createSupervisor({ dataRoot: root, sourceRoot: source, supervisorControlPort: occupiedPort, adminPort: Number(ports[0]), adminTunnelHealthPort: Number(ports[1]), webPort: Number(ports[2]) });
try { await supervisor.runSupervisorDaemon(); } finally { await new Promise(resolve => occupied.close(resolve)); }
const first = JSON.parse(await readFile(root + '/supervisor/state.json', 'utf8'));
await supervisor.runSupervisorDaemon();
const second = JSON.parse(await readFile(root + '/supervisor/state.json', 'utf8'));
if (!first.recovery.terminal || first.recovery.lastFailureCode !== 'SUPERVISOR_NOT_RUNNING' || second.runtime !== null || second.startupOperations.length !== 0) process.exitCode = 2;
else console.log(JSON.stringify({ terminal: true, repeatedLaunchBlocked: true, children: 0 }));
`);
    expect(JSON.parse(result.stdout)).toEqual({ terminal: true, repeatedLaunchBlocked: true, children: 0 });
    expect(result.stderr).toContain('durable failure requires owner reconciliation');
    expect(result.stdout).not.toContain('READY');
    expect(renderLaunchAgent(root, canonicalNodeRuntime().path, path.join(sourceRoot, 'apps/runtime/src/control.ts'))).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
  }, 15000);
  it('preserves a failed OS exit when durable state cannot be read', async () => {
    const { root, ports } = await fixture();
    await writeFile(path.join(root, 'supervisor/state.json'), 'malformed synthetic state', { mode: 0o600 });
    await expect(program(root, ports, `
try {
 const supervisor = await createSupervisor({ dataRoot: root, sourceRoot: source, supervisorControlPort: Number(ports[0]), adminPort: Number(ports[1]), adminTunnelHealthPort: Number(ports[2]) });
 await supervisor.runSupervisorDaemon();
} catch { console.error('EXPECTED_DURABILITY_FAILURE'); process.exitCode = 1; }
`)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('EXPECTED_DURABILITY_FAILURE') });
  }, 15000);
});
