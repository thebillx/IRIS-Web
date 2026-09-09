#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MINIMUM_NODE_MAJOR = 24;
const repoRoot = path.resolve(import.meta.dirname, '..');
const nodeCandidates = [
  '/opt/homebrew/opt/node@24/bin/node',
  '/usr/local/opt/node@24/bin/node',
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  process.execPath,
];

export function resolveCanonicalNode() {
  for (const candidate of [...new Set(nodeCandidates)]) {
    if (!path.isAbsolute(candidate) || !existsSync(candidate)) continue;
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const major = Number(/^v?(\d+)/.exec(version)?.[1]);
      if (Number.isSafeInteger(major) && major >= MINIMUM_NODE_MAJOR) return { path: path.resolve(candidate), version, major };
    } catch {
      // Continue to the next trusted installation candidate.
    }
  }
  throw new Error(`IRIS requires an installed Node.js >=${MINIMUM_NODE_MAJOR}; no usable canonical executable was found`);
}

export function node24Path(nodePath = resolveCanonicalNode().path) {
  return [...new Set([
    path.dirname(nodePath),
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ])].join(path.delimiter);
}

export function node24Environment(source = process.env, extra = {}) {
  const environment = { ...source, ...extra, PATH: node24Path() };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return environment;
}

export function node24TsxArgs(script, args = []) {
  const tsxDirectory = path.join(repoRoot, 'apps', 'runtime', 'node_modules', 'tsx', 'dist');
  return [
    '--require', path.join(tsxDirectory, 'preflight.cjs'),
    '--import', pathToFileURL(path.join(tsxDirectory, 'loader.mjs')).href,
    path.resolve(script),
    ...args,
  ];
}

async function main() {
  const target = process.argv[2];
  if (target === '--print') {
    process.stdout.write(`${JSON.stringify(resolveCanonicalNode())}\n`);
    return;
  }
  if (target === undefined) throw new Error('Usage: node scripts/node24.mjs [--print|--pnpm|script] [args...]');
  const runtime = resolveCanonicalNode();
  const args = process.argv.slice(3);
  let command = runtime.path;
  let childArgs;
  if (target === '--pnpm') {
    const pnpm = path.join(path.dirname(runtime.path), 'pnpm');
    if (!existsSync(pnpm)) throw new Error(`Node 24 installation has no pnpm executable at ${pnpm}`);
    command = pnpm;
    childArgs = args;
  } else if (target === '--bin') {
    const binary = args.shift();
    if (binary === undefined || !/^[A-Za-z0-9._-]+$/.test(binary)) throw new Error('A bounded local binary name is required');
    command = path.join(repoRoot, 'node_modules', '.bin', binary);
    if (!existsSync(command)) throw new Error(`Required local binary is unavailable at ${command}`);
    childArgs = args;
  } else {
    const script = path.resolve(target);
    childArgs = script.endsWith('.ts') ? node24TsxArgs(script, args) : [script, ...args];
  }
  const child = spawn(command, childArgs, { cwd: process.cwd(), env: node24Environment(), stdio: 'inherit' });
  const result = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  if (result.signal !== null) process.kill(process.pid, result.signal);
  process.exitCode = result.code ?? 1;
}

const invoked = process.argv[1] === undefined ? '' : path.resolve(fileURLToPath(import.meta.url));
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === invoked) {
  try { await main(); }
  catch (error) { process.stderr.write(`IRIS_NODE24_FAILED ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
