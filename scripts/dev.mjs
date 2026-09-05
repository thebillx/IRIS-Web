import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const runtimeRoot = path.resolve('apps/runtime');
const runtimeExecutable = path.resolve('apps/runtime/node_modules/.bin/tsx');
const webExecutable = path.resolve('apps/web/node_modules/.bin/vite');
let runtime;
let web;
let webStarting = false;
let stopping = false;
let shutdownPromise;
let ownerUrlPrinted = false;

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

async function readOwnerToken() {
  const child = spawn(runtimeExecutable, ['src/control.ts', 'owner-token'], {
    cwd: runtimeRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) throw new Error(`Could not read IRIS owner access credential: ${stderr.trim()}`);
  const token = stdout.trim();
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) throw new Error('IRIS owner access credential is invalid');
  return token;
}

async function startWeb(runtimeUrl) {
  if (web !== undefined || webStarting || stopping) return;
  webStarting = true;
  const ownerToken = await readOwnerToken();
  if (stopping) return;
  web = spawn(webExecutable, ['--host', '127.0.0.1'], {
    cwd: path.resolve('apps/web'),
    stdio: ['inherit', 'pipe', 'inherit'],
    env: { ...process.env, IRIS_RUNTIME_URL: runtimeUrl },
  });
  web.stdout.setEncoding('utf8');
  web.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    if (ownerUrlPrinted) return;
    const match = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(chunk);
    if (match?.[1] !== undefined) {
      ownerUrlPrinted = true;
      process.stdout.write(`IRIS_OWNER_URL=${match[1]}#owner=${encodeURIComponent(ownerToken)}\n`);
    }
  });
  web.once('exit', (code) => {
    if (!stopping) void shutdown(code ?? 1);
  });
}

runtime = spawn(runtimeExecutable, ['src/main.ts'], {
  cwd: runtimeRoot,
  stdio: ['inherit', 'pipe', 'inherit'],
  env: { ...process.env },
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
