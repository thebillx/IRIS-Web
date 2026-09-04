import { spawn } from 'node:child_process';
import process from 'node:process';

let runtime;
let web;
let stopping = false;

function stopChild(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill('SIGTERM');
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  stopChild(web);
  stopChild(runtime);
  process.exitCode = code;
}

runtime = spawn('pnpm', ['--filter', '@iris/runtime', 'dev'], {
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
    if (!line.startsWith('IRIS_RUNTIME_URL=')) continue;
    if (web !== undefined) continue;
    const runtimeUrl = line.slice('IRIS_RUNTIME_URL='.length).trim();
    web = spawn('pnpm', ['--filter', '@iris/web', 'dev'], {
      stdio: 'inherit',
      env: { ...process.env, IRIS_RUNTIME_URL: runtimeUrl },
    });
    web.once('exit', (code) => { if (!stopping) shutdown(code ?? 1); });
  }
});
runtime.once('exit', (code) => { if (!stopping) shutdown(code ?? 1); });
process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));
