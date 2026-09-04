import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const runtimeExecutable = path.resolve('apps/runtime/node_modules/.bin/tsx');
const webExecutable = path.resolve('apps/web/node_modules/.bin/vite');
let runtime;
let web;
let stopping = false;
let shutdownPromise;

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

runtime = spawn(runtimeExecutable, ['src/main.ts'], {
  cwd: path.resolve('apps/runtime'),
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
    if (!line.startsWith('IRIS_RUNTIME_URL=') || web !== undefined || stopping) continue;
    const runtimeUrl = line.slice('IRIS_RUNTIME_URL='.length).trim();
    web = spawn(webExecutable, ['--host', '127.0.0.1'], {
      cwd: path.resolve('apps/web'),
      stdio: 'inherit',
      env: { ...process.env, IRIS_RUNTIME_URL: runtimeUrl },
    });
    web.once('exit', (code) => {
      if (!stopping) void shutdown(code ?? 1);
    });
  }
});
runtime.once('exit', (code) => {
  if (!stopping) void shutdown(code ?? 1);
});
process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });
