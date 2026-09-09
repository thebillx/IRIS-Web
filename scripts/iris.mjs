#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const runtimeRoot = path.join(repoRoot, 'apps', 'runtime');
const executable = path.join(runtimeRoot, 'node_modules', '.bin', 'tsx');
const environment = { ...process.env, IRIS_STACK_CLI: '1' };
delete environment.CONTROL_PLANE_API_KEY;
delete environment.IRIS_OWNER_AUTH_HEADER;
const child = spawn(executable, [path.join(runtimeRoot, 'src', 'control.ts'), ...process.argv.slice(2)], {
  cwd: runtimeRoot,
  env: environment,
  stdio: 'inherit',
});
child.once('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
