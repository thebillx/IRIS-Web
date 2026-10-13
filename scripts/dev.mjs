import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { node24Environment, node24TsxArgs, resolveCanonicalNode } from './node24.mjs';

const runtimeRoot = path.resolve('apps/runtime');
const node = resolveCanonicalNode();
const webExecutable = path.resolve('apps/web/node_modules/.bin/vite');
let runtime;
let web;
let webStarting = false;
let stopping = false;
let shutdownPromise;
let webUrlPrinted = false;

function stopChild(child) {
  if (child === undefined || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

function shutdown(code = 0) {
  if (shutdownPromise !== undefined) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    await Promise.all([stopChild(web), stopChild(runtime)]);
    process.exitCode = code;
  })();
  return shutdownPromise;
}

async function startWeb(runtimeUrl) {
  if (web !== undefined || webStarting || stopping) return;
  webStarting = true;
  if (stopping) return;
  const ownerToken = process.env.IRIS_OWNER_ACCESS_TOKEN?.trim();
  const webEnvironment = node24Environment(process.env, { IRIS_RUNTIME_URL: runtimeUrl });
  delete webEnvironment.IRIS_OWNER_ACCESS_TOKEN;
  if (ownerToken !== undefined && /^[A-Za-z0-9_-]{40,128}$/.test(ownerToken)) webEnvironment.IRIS_OWNER_ACCESS_SECRET = ownerToken;
  web = spawn(webExecutable, ['--host', '127.0.0.1'], {
    cwd: path.resolve('apps/web'),
    stdio: ['inherit', 'pipe', 'inherit'],
    env: webEnvironment,
  });
  web.stdout.setEncoding('utf8');
  web.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    if (webUrlPrinted) return;
    const match = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(chunk);
    if (match?.[1] !== undefined) {
      webUrlPrinted = true;
      process.stdout.write(`IRIS_WEB_URL=${match[1]}\n`);
    }
  });
  web.once('exit', (code) => {
    if (!stopping) void shutdown(code ?? 1);
  });
}

runtime = spawn(node.path, node24TsxArgs(path.join(runtimeRoot, 'src', 'main.ts')), {
  cwd: runtimeRoot,
  stdio: ['inherit', 'pipe', 'inherit'],
  env: node24Environment(),
});

let buffer = '';
runtime.stdout.setEncoding('utf8');
runtime.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('IRIS_RUNTIME_URL=') || web !== undefined || webStarting || stopping) continue;
    const runtimeUrl = line.slice('IRIS_RUNTIME_URL='.length).trim();
    void startWeb(runtimeUrl).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      void shutdown(1);
    });
  }
});
runtime.once('exit', (code) => {
  if (!stopping) void shutdown(code ?? 1);
});
process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });
