#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, realpath, readdir, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const IDENTITY_FILE = '.iris-acceptance-identity.json';
const DEFAULT_DATA_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'IRIS');
const DEFAULT_CREDENTIAL_ROOT = path.join(os.homedir(), '.config', 'tunnel-client');
const PORTS = [
  ['runtime', 43_110],
  ['supervisor-admin', 43_111],
  ['supervisor-control', 43_112],
  ['supervisor-tunnel-health', 43_113],
  ['web', 5_173],
];

export class AcceptanceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseAcceptanceArgs(argumentsList) {
  let runtimeDataRoot;
  const protectedRoots = [];
  let ownerAuthorizedTunnel = false;
  let separator = -1;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const name = argumentsList[index];
    if (name === '--') {
      separator = index;
      break;
    }
    if (name === '--owner-authorized-tunnel') {
      ownerAuthorizedTunnel = true;
      continue;
    }
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0) throw new AcceptanceError('ACCEPTANCE_USAGE', 'Every acceptance command requires --runtime-data-root, --protected-root and -- <iris command>');
    if (name === '--runtime-data-root' && runtimeDataRoot === undefined) runtimeDataRoot = value;
    else if (name === '--protected-root') protectedRoots.push(value);
    else throw new AcceptanceError('ACCEPTANCE_USAGE', 'Every acceptance command requires --runtime-data-root, --protected-root and -- <iris command>');
    index += 1;
  }
  if (separator < 0 || runtimeDataRoot === undefined || protectedRoots.length === 0 || argumentsList.slice(separator + 1).length === 0) {
    throw new AcceptanceError('ACCEPTANCE_USAGE', 'Every acceptance command requires --runtime-data-root, --protected-root and -- <iris command>');
  }
  return { runtimeDataRoot, protectedRoots, ownerAuthorizedTunnel, command: argumentsList.slice(separator + 1) };
}

export async function inspectAcceptanceEnvironment(options) {
  const environment = options.environment ?? process.env;
  const dataRoot = await existingPrivateDirectory(options.runtimeDataRoot, 'ACCEPTANCE_ROOT_INVALID');
  const sourceRoot = await existingDirectory(options.sourceRoot ?? REPO_ROOT, 'ACCEPTANCE_SOURCE_INVALID');
  const sessionRoot = environment.IRIS_ACCEPTANCE_ROOT?.trim();
  if (sessionRoot === undefined || sessionRoot.length === 0) throw new AcceptanceError('ACCEPTANCE_ROOT_ENV_MISSING', 'IRIS_ACCEPTANCE_ROOT must be exported for every acceptance command; refusing the default IRIS data root');
  const sessionCanonical = await existingPrivateDirectory(sessionRoot, 'ACCEPTANCE_ROOT_INVALID');
  if (sessionCanonical !== dataRoot) throw new AcceptanceError('ACCEPTANCE_ROOT_MISMATCH', 'The command root differs from IRIS_ACCEPTANCE_ROOT; keep one acceptance identity for the whole session');

  const protectedInputs = [DEFAULT_DATA_ROOT, DEFAULT_CREDENTIAL_ROOT, sourceRoot, ...options.protectedRoots];
  if (isWithin(sourceRoot, dataRoot) || isWithin(dataRoot, sourceRoot)) {
    throw new AcceptanceError('ACCEPTANCE_ROOT_SOURCE_OVERLAP', 'Acceptance source and data roots must be physically distinct');
  }
  const protectedRoots = [];
  for (const input of protectedInputs) {
    const canonical = await canonicalPath(input);
    if (!protectedRoots.includes(canonical)) protectedRoots.push(canonical);
    if (isWithin(canonical, dataRoot) || isWithin(dataRoot, canonical)) {
      throw new AcceptanceError('ACCEPTANCE_ROOT_PROTECTED', `Acceptance data root overlaps protected path ${canonical}`);
    }
  }
  const git = await gitIdentity(sourceRoot);
  const expectedHead = environment.IRIS_ACCEPTANCE_EXPECTED_HEAD?.trim();
  const expectedBranch = environment.IRIS_ACCEPTANCE_EXPECTED_BRANCH?.trim();
  if (expectedHead !== undefined && expectedHead.length > 0 && git.head !== expectedHead) throw new AcceptanceError('ACCEPTANCE_SOURCE_HEAD_MISMATCH', `Acceptance checkout HEAD is ${git.head}, expected ${expectedHead}`);
  if (expectedBranch !== undefined && expectedBranch.length > 0 && git.branch !== expectedBranch) throw new AcceptanceError('ACCEPTANCE_SOURCE_BRANCH_MISMATCH', `Acceptance checkout branch is ${git.branch}, expected ${expectedBranch}`);
  await bindIdentity(dataRoot, sourceRoot, git);

  const processState = await inspectProcessState(dataRoot, sourceRoot, options.isPidAlive);
  const command = options.command ?? [];
  const commandName = command[0] ?? '';
  if (['install', 'uninstall'].includes(command[1] ?? '') && commandName === 'launchd') {
    throw new AcceptanceError('ACCEPTANCE_LAUNCHD_BLOCKED', 'LaunchAgent install/uninstall is blocked during parallel acceptance; inspect artifacts only in a separately authorized window');
  }
  if (needsFreePorts(command)) {
    const conflicts = await findPortConflicts(options.probePort);
    if (conflicts.length > 0) throw new AcceptanceError('ACCEPTANCE_PORT_CONFLICT', `Acceptance ports are occupied: ${conflicts.map((entry) => `${entry.name}:${entry.port}`).join(', ')}`);
  }

  const requestedTunnelId = commandValue(command, '--tunnel-id');
  const tunnelClaims = requestedTunnelId === null ? [] : await findTunnelClaims(protectedRoots, requestedTunnelId);
  if (tunnelClaims.length > 0) throw new AcceptanceError('ACCEPTANCE_TUNNEL_CONFLICT', `Acceptance tunnel identity is already claimed by protected installation ${tunnelClaims[0]}`);
  if (startsRemoteTunnel(command) && !options.ownerAuthorizedTunnel) {
    throw new AcceptanceError('ACCEPTANCE_TUNNEL_UNVERIFIED', 'Acceptance tunnel ownership is UNVERIFIED; obtain separate owner authorization for a non-production tunnel before starting remote acceptance');
  }

  if (commandName === 'credentials' && command[1] === 'migrate') await validateCredentialProfile(command[2], protectedRoots);
  return {
    sourceRoot,
    dataRoot,
    git,
    protectedRoots,
    processState,
    tunnelIdentity: tunnelClaims.length > 0 ? 'CONFLICT' : 'UNVERIFIED',
    ports: PORTS.map(([name, port]) => ({ name, port })),
  };
}

async function main() {
  try {
    const parsed = parseAcceptanceArgs(process.argv.slice(2));
    const report = await inspectAcceptanceEnvironment({ ...parsed, command: parsed.command });
    if (parsed.command[0] === 'preflight') {
      process.stdout.write(`${JSON.stringify({ status: 'PASS', ...report }, null, 2)}\n`);
      return;
    }
    const childEnvironment = buildChildEnvironment(report.dataRoot, process.env);
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'iris.mjs'), ...parsed.command], {
      cwd: REPO_ROOT,
      env: childEnvironment,
      stdio: 'inherit',
    });
    child.once('exit', (code, signal) => {
      if (signal !== null) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    });
  } catch (error) {
    const code = error instanceof AcceptanceError ? error.code : 'ACCEPTANCE_PREFLIGHT_FAILED';
    const message = error instanceof Error ? error.message : 'Acceptance preflight failed';
    process.stderr.write(`IRIS_ACCEPTANCE_BLOCKED code=${code} message=${message}\n`);
    process.exitCode = 1;
  }
}

export function buildChildEnvironment(dataRoot, environment = process.env) {
  return { ...environment, IRIS_RUNTIME_DATA_ROOT: dataRoot, IRIS_ACCEPTANCE_ROOT: dataRoot };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

async function bindIdentity(dataRoot, sourceRoot, git) {
  const filename = path.join(dataRoot, IDENTITY_FILE);
  const current = await readFile(filename, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  const expected = { schemaVersion: 1, dataRoot, sourceRoot, branch: git.branch, head: git.head };
  if (current !== null) {
    let parsed;
    try { parsed = JSON.parse(current); } catch { throw new AcceptanceError('ACCEPTANCE_IDENTITY_INVALID', 'Acceptance identity file is invalid; preserve the root and ask the owner'); }
    if (!sameIdentity(parsed, expected)) throw new AcceptanceError('ACCEPTANCE_IDENTITY_CHANGED', 'Acceptance data-root or source identity changed; stop and preserve the root');
    return;
  }
  const entries = await readdir(dataRoot);
  if (entries.length > 0) throw new AcceptanceError('ACCEPTANCE_ROOT_REUSED', 'Acceptance data root already contains state but no IRIS acceptance identity; choose a new private root');
  const file = `${JSON.stringify({ ...expected, sessionId: randomUUID(), createdAt: new Date().toISOString() }, null, 2)}\n`;
  await writeFile(filename, file, { flag: 'wx', mode: 0o600 });
  await chmod(filename, 0o600);
}

async function inspectProcessState(dataRoot, sourceRoot, isPidAlive = pidExists) {
  const filename = path.join(dataRoot, 'supervisor', 'state.json');
  const content = await readFile(filename, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (content === null) return { state: 'EMPTY', livePids: [] };
  let state;
  try { state = JSON.parse(content); } catch { throw new AcceptanceError('ACCEPTANCE_PROCESS_STATE_INVALID', 'Supervisor state is invalid; do not adopt or delete unknown process state'); }
  if (state.workloadSourceRoot !== undefined && path.resolve(state.workloadSourceRoot) !== sourceRoot) throw new AcceptanceError('ACCEPTANCE_PROCESS_OWNERSHIP_AMBIGUOUS', 'Supervisor state belongs to a different source root');
  const records = [state.runtime, state.web, state.admin, state.adminTunnel, state.tunnels?.full, state.tunnels?.pro].filter(Boolean);
  const livePids = [];
  for (const record of records) if (Number.isSafeInteger(record.pid) && await isPidAlive(record.pid)) livePids.push(record.pid);
  return { state: 'BOUND', livePids };
}

async function validateCredentialProfile(profile, protectedRoots) {
  if (profile === undefined || !path.isAbsolute(profile)) throw new AcceptanceError('ACCEPTANCE_PROFILE_INVALID', 'Credential migration requires an absolute, separately provisioned non-production profile path');
  const canonical = await existingFile(profile, 'ACCEPTANCE_PROFILE_MISSING');
  if (protectedRoots.some((root) => isWithin(root, canonical))) throw new AcceptanceError('ACCEPTANCE_PROFILE_PROTECTED', 'Credential profile is inside a protected production path; use a separately provisioned non-production profile');
  const metadata = await stat(canonical);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new AcceptanceError('ACCEPTANCE_PROFILE_OWNER', 'Credential profile is not owned by the current user');
  if ((metadata.mode & 0o077) !== 0) throw new AcceptanceError('ACCEPTANCE_PROFILE_PRIVATE', 'Credential profile must be private to the current user');
}

async function findTunnelClaims(protectedRoots, tunnelId) {
  const claims = [];
  for (const root of protectedRoots) {
    const filename = path.join(root, 'connector-registry.json');
    const content = await readFile(filename, 'utf8').catch(() => null);
    if (content === null) continue;
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_INVALID', `Protected connector registry is invalid at ${root}`); }
    const registry = parsed?.registry ?? parsed;
    const bindings = [...(registry?.connectors ?? []), registry?.admin].filter(Boolean);
    if (bindings.some((binding) => binding.tunnelId === tunnelId)) claims.push(root);
  }
  return claims;
}

async function findPortConflicts(probe = probePort) {
  const conflicts = [];
  for (const [name, port] of PORTS) if (await probe(port, '127.0.0.1')) conflicts.push({ name, port });
  return conflicts;
}

function needsFreePorts(command) {
  return command[0] === 'up' || command[0] === 'restart' || command[0] === 'supervisor' || (command[0] === 'setup' && command.includes('--start'));
}

function startsRemoteTunnel(command) {
  return needsFreePorts(command) || (command[0] === 'connectors' && command[1] === 'admin-bind');
}

function commandValue(command, flag) {
  const index = command.indexOf(flag);
  return index < 0 ? null : command[index + 1] ?? null;
}

async function existingPrivateDirectory(input, code) {
  const canonical = await existingDirectory(input, code);
  const metadata = await stat(canonical);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new AcceptanceError(code, `Directory ${canonical} is not owned by the current user`);
  if ((metadata.mode & 0o077) !== 0) throw new AcceptanceError(code, `Directory ${canonical} must grant access only to the current user`);
  return canonical;
}

async function existingDirectory(input, code) {
  if (input === undefined || !path.isAbsolute(input)) throw new AcceptanceError(code, 'Acceptance paths must be absolute');
  const metadata = await lstat(input).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) throw new AcceptanceError(code, `Directory ${input} must already exist as a physical directory`);
  return realpath(input);
}

async function existingFile(input, code) {
  const metadata = await lstat(input).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) throw new AcceptanceError(code, `File ${input} must be an existing physical file`);
  return realpath(input);
}

async function canonicalPath(input) {
  if (!path.isAbsolute(input)) throw new AcceptanceError('ACCEPTANCE_PROTECTED_ROOT_INVALID', 'Protected roots must be absolute');
  const absolute = path.resolve(input);
  try { return await realpath(absolute); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(await canonicalPath(parent), path.basename(absolute));
  }
}

async function gitIdentity(sourceRoot) {
  const [head, branch] = await Promise.all([
    execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']).then((result) => result.stdout.trim()),
    execFileAsync('git', ['-C', sourceRoot, 'branch', '--show-current']).then((result) => result.stdout.trim()),
  ]).catch(() => { throw new AcceptanceError('ACCEPTANCE_SOURCE_INVALID', 'Acceptance source is not a readable Git checkout'); });
  if (!/^[a-f0-9]{40}$/.test(head) || branch.length === 0) throw new AcceptanceError('ACCEPTANCE_SOURCE_INVALID', 'Acceptance source must have a named branch and a verified HEAD');
  return { head, branch };
}

async function pidExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function probePort(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(250, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function sameIdentity(actual, expected) {
  return actual?.schemaVersion === expected.schemaVersion
    && actual.dataRoot === expected.dataRoot
    && actual.sourceRoot === expected.sourceRoot
    && actual.branch === expected.branch
    && actual.head === expected.head;
}
