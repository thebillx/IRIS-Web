#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, realpath, readdir, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { URL, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const IDENTITY_FILE = '.iris-acceptance-identity.json';
const DEFAULT_DATA_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'IRIS');
const DEFAULT_CREDENTIAL_ROOT = path.join(os.homedir(), '.config', 'tunnel-client');
const PORT_KEYS = ['runtime', 'supervisorAdmin', 'supervisorControl', 'supervisorTunnelHealth', 'fullTunnelHealth', 'proTunnelHealth', 'web'];
const DEFAULT_PORTS = Object.freeze({
  runtime: 43_110,
  supervisorAdmin: 43_111,
  supervisorControl: 43_112,
  supervisorTunnelHealth: 43_113,
  fullTunnelHealth: 8_080,
  proTunnelHealth: 8_081,
  web: 5_173,
});

export class AcceptanceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseAcceptanceArgs(argumentsList) {
  let runtimeDataRoot;
  let ports;
  const protectedRoots = [];
  let separator = -1;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const name = argumentsList[index];
    if (name === '--') {
      separator = index;
      break;
    }
    const value = argumentsList[index + 1]?.trim();
    if (value === undefined || value.length === 0) throw new AcceptanceError('ACCEPTANCE_USAGE', 'Every acceptance command requires --runtime-data-root, --protected-root and -- <iris command>');
    if (name === '--runtime-data-root' && runtimeDataRoot === undefined) runtimeDataRoot = value;
    else if (name === '--ports' && ports === undefined) ports = parsePortSpec(value);
    else if (name === '--protected-root') protectedRoots.push(value);
    else throw new AcceptanceError('ACCEPTANCE_USAGE', 'Every acceptance command requires --runtime-data-root, --protected-root and -- <iris command>');
    index += 1;
  }
  if (separator < 0 || runtimeDataRoot === undefined || protectedRoots.length === 0 || argumentsList.slice(separator + 1).length === 0) {
    throw new AcceptanceError('ACCEPTANCE_USAGE', 'Every acceptance command requires --runtime-data-root, --protected-root and -- <iris command>');
  }
  return { runtimeDataRoot, protectedRoots, ports: ports ?? null, command: argumentsList.slice(separator + 1) };
}

export function validateAcceptanceCommand(command) {
  const [name, ...argumentsList] = command;
  const reject = () => { throw new AcceptanceError('ACCEPTANCE_COMMAND_UNSUPPORTED', 'Acceptance command is not allowlisted; use the documented wrapper workflow'); };
  const requireExact = (count) => { if (argumentsList.length !== count) reject(); };
  const requireValue = (index) => {
    const value = argumentsList[index];
    if (value === undefined || value.length === 0 || value.startsWith('--')) reject();
    return value;
  };
  if (name === 'preflight') {
    requireExact(0);
    return command;
  }
  if (name === 'setup') {
    let tunnelId = false;
    let json = false;
    for (let index = 0; index < argumentsList.length; index += 1) {
      const option = argumentsList[index];
      if (option === '--tunnel-id') {
        if (tunnelId) reject();
        requireValue(index + 1);
        tunnelId = true;
        index += 1;
      } else if (option === '--json') {
        if (json) reject();
        json = true;
      } else {
        reject();
      }
    }
    if (!tunnelId) reject();
    return command;
  }
  if (['up', 'restart', 'supervisor'].includes(name)) {
    let tunnelId = false;
    for (let index = 0; index < argumentsList.length; index += 1) {
      const option = argumentsList[index];
      if (option === '--tunnel-id') {
        if (tunnelId) reject();
        requireValue(index + 1);
        tunnelId = true;
        index += 1;
      } else {
        reject();
      }
    }
    return command;
  }
  if (['down', 'status', 'doctor', 'logs'].includes(name)) {
    requireExact(0);
    return command;
  }
  if (name === 'connectors') {
    if (argumentsList.length === 0) return command;
    reject();
  }
  if (name === 'catalog' && argumentsList.length === 1 && argumentsList[0] === 'status') return command;
  if (name === 'credentials' && argumentsList[0] === 'migrate' && argumentsList.length === 2) {
    requireValue(1);
    return command;
  }
  if (name === 'launchd' && argumentsList.length === 1 && argumentsList[0] === 'status') return command;
  if (name === 'launchd' && argumentsList.length === 1 && ['install', 'uninstall'].includes(argumentsList[0])) return command;
  reject();
}

export async function inspectAcceptanceEnvironment(options) {
  const environment = options.environment ?? process.env;
  const command = options.command ?? [];
  const ports = options.ports ?? parsePortEnvironment(environment.IRIS_ACCEPTANCE_PORTS);
  validateAcceptanceCommand(command);
  if (requiresPortSet(command) && ports === null) throw new AcceptanceError('ACCEPTANCE_PORTS_REQUIRED', 'Acceptance commands require the complete isolated port set; pass --ports before --');
  if (ports !== null) assertSideBySidePorts(ports);
  const dataRoot = await existingPrivateDirectory(options.runtimeDataRoot, 'ACCEPTANCE_ROOT_INVALID');
  const sourceRoot = await existingDirectory(options.sourceRoot ?? REPO_ROOT, 'ACCEPTANCE_SOURCE_INVALID');
  const sessionRoot = environment.IRIS_ACCEPTANCE_ROOT?.trim();
  if (sessionRoot === undefined || sessionRoot.length === 0) throw new AcceptanceError('ACCEPTANCE_ROOT_ENV_MISSING', 'IRIS_ACCEPTANCE_ROOT must be exported for every acceptance command; refusing the default IRIS data root');
  const sessionCanonical = await existingPrivateDirectory(sessionRoot, 'ACCEPTANCE_ROOT_INVALID');
  if (sessionCanonical !== dataRoot) throw new AcceptanceError('ACCEPTANCE_ROOT_MISMATCH', 'The command root differs from IRIS_ACCEPTANCE_ROOT; keep one acceptance identity for the whole session');
  const rootIdentity = await physicalDirectoryIdentity(dataRoot);

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
  if (needsFreePorts(command)) {
    const conflicts = await findPortConflicts(ports, options.probePort);
    if (conflicts.length > 0) throw new AcceptanceError('ACCEPTANCE_PORT_CONFLICT', `Acceptance ports are occupied: ${conflicts.map((entry) => `${entry.name}:${entry.port}`).join(', ')}`);
  }
  await bindIdentity(dataRoot, sourceRoot, git, rootIdentity, command[0] === 'preflight');

  const processState = await inspectProcessState(dataRoot, sourceRoot, options.isPidAlive);
  const commandName = command[0] ?? '';
  if (['install', 'uninstall'].includes(command[1] ?? '') && commandName === 'launchd') {
    throw new AcceptanceError('ACCEPTANCE_LAUNCHD_BLOCKED', 'LaunchAgent install/uninstall is blocked during parallel acceptance; inspect artifacts only in a separately authorized window');
  }
  const requestedTunnelId = commandValue(command, '--tunnel-id');
  const tunnelClaims = requestedTunnelId === null ? [] : await findTunnelClaims(protectedRoots, requestedTunnelId, options.readTextFile);
  if (tunnelClaims.length > 0) throw new AcceptanceError('ACCEPTANCE_TUNNEL_CONFLICT', `Acceptance tunnel identity is already claimed by protected installation ${tunnelClaims[0]}`);
  let tunnelIdentity = tunnelClaims.length > 0 ? 'CONFLICT' : 'UNVERIFIED';
  if (startsRemoteTunnel(command)) {
    if (requestedTunnelId === null) throw new AcceptanceError('ACCEPTANCE_TUNNEL_ID_REQUIRED', 'Remote acceptance startup requires the exact non-production workload tunnel id');
    const evidencePath = environment.IRIS_ACCEPTANCE_TUNNEL_EVIDENCE?.trim();
    if (evidencePath === undefined || evidencePath.length === 0) throw new AcceptanceError('ACCEPTANCE_TUNNEL_UNVERIFIED', 'Acceptance tunnel ownership is UNVERIFIED; provide authoritative non-production tunnel ownership evidence');
    await verifyAcceptanceTunnelEvidence({
      filename: evidencePath,
      tunnelId: requestedTunnelId,
      dataRoot,
      sourceRoot,
      machineName: options.machineName,
      isPidAlive: options.isPidAlive,
      inspectProcess: options.inspectProcess,
      readTextFile: options.readTextFile,
    });
    tunnelIdentity = 'VERIFIED';
  }

  if (commandName === 'credentials' && command[1] === 'migrate') await validateCredentialProfile(command[2], protectedRoots);
  return {
    sourceRoot,
    dataRoot,
    rootIdentity,
    git,
    protectedRoots,
    processState,
    tunnelIdentity,
    ports,
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
    const childEnvironment = buildChildEnvironment(report.dataRoot, process.env, report.ports);
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'iris.mjs'), ...stripAcceptanceArguments(parsed.command)], {
      cwd: REPO_ROOT,
      env: childEnvironment,
      stdio: 'inherit',
    });
    child.once('exit', async (code, signal) => {
      if (signal !== null) process.kill(process.pid, signal);
      else {
        try {
          if (code === 0 && report.ports !== null) await verifyGeneratedPortBindings(report.dataRoot, report.ports);
          process.exitCode = code ?? 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Generated acceptance port bindings are invalid';
          process.stderr.write(`IRIS_ACCEPTANCE_BLOCKED code=ACCEPTANCE_PORT_BINDING_MISMATCH message=${message}\n`);
          process.exitCode = 1;
        }
      }
    });
  } catch (error) {
    const code = error instanceof AcceptanceError ? error.code : 'ACCEPTANCE_PREFLIGHT_FAILED';
    const message = error instanceof Error ? error.message : 'Acceptance preflight failed';
    process.stderr.write(`IRIS_ACCEPTANCE_BLOCKED code=${code} message=${message}\n`);
    process.exitCode = 1;
  }
}

export async function verifyAcceptanceTunnelEvidence(options) {
  const filename = options.filename;
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_INVALID', 'Tunnel evidence must be an absolute private file');
  const metadata = await lstat(filename).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
    throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_INVALID', 'Tunnel evidence must be a private physical file');
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_INVALID', 'Tunnel evidence is not owned by the current user');
  let evidence;
  try { evidence = JSON.parse(await (options.readTextFile ?? readFile)(filename, 'utf8')); } catch { throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_INVALID', 'Tunnel evidence is not valid JSON'); }
  const workloadBinding = options.dataRoot === undefined ? null : await readAcceptanceWorkloadBinding(options.dataRoot);
  let evidenceProfilePath = null;
  if (isRecord(evidence?.binding) && typeof evidence.binding.profilePath === 'string' && path.isAbsolute(evidence.binding.profilePath)) {
    try { evidenceProfilePath = await canonicalPath(evidence.binding.profilePath); } catch { throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_INVALID', 'Tunnel evidence profile path is not canonicalizable'); }
  }
  const expectedTunnelId = options.tunnelId;
  if (typeof expectedTunnelId !== 'string' || expectedTunnelId.length === 0) throw new AcceptanceError('ACCEPTANCE_TUNNEL_ID_REQUIRED', 'Tunnel evidence must name the exact workload tunnel');
  if (!isRecord(evidence)
    || evidence.schemaVersion !== 1
    || evidence.environment !== 'non-production'
    || typeof evidence.provider !== 'string' || evidence.provider.length === 0 || evidence.provider.length > 200
    || typeof evidence.machineId !== 'string' || evidence.machineId.length === 0 || evidence.machineId !== (workloadBinding?.machineId ?? options.machineId ?? options.machineName ?? os.hostname())
    || typeof evidence.sourceRoot !== 'string' || path.resolve(evidence.sourceRoot) !== path.resolve(options.sourceRoot)
    || typeof evidence.tunnelId !== 'string' || evidence.tunnelId.length === 0 || (typeof expectedTunnelId === 'string' && evidence.tunnelId !== expectedTunnelId)
    || !Number.isSafeInteger(evidence.pid) || evidence.pid <= 0
    || typeof evidence.executablePath !== 'string' || !path.isAbsolute(evidence.executablePath)
    || typeof evidence.processStartMarker !== 'string' || evidence.processStartMarker.length === 0 || evidence.processStartMarker.length > 128
    || !isRecord(evidence.binding) || evidence.binding.tunnelId !== evidence.tunnelId
    || (evidence.binding.profilePath !== undefined && (typeof evidence.binding.profilePath !== 'string' || !path.isAbsolute(evidence.binding.profilePath)))) {
    throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_INVALID', 'Tunnel evidence does not bind the expected non-production provider, machine, source or tunnel');
  }
  if (workloadBinding !== null && (evidence.tunnelId !== workloadBinding.tunnelId || evidence.binding.connectorId !== workloadBinding.connectorId || evidence.binding.machineId !== workloadBinding.machineId || evidenceProfilePath !== workloadBinding.managedProfilePath)) {
    throw new AcceptanceError('ACCEPTANCE_TUNNEL_BINDING_UNVERIFIED', 'Evidence does not bind the canonical unified workload connector');
  }
  const isAlive = options.isPidAlive ?? pidExists;
  if (!await isAlive(evidence.pid)) throw new AcceptanceError('ACCEPTANCE_TUNNEL_PROCESS_UNAVAILABLE', 'The evidenced local tunnel process is not alive');
  const inspectProcess = options.inspectProcess ?? inspectProcessIdentity;
  const processInfo = await inspectProcess(evidence.pid);
  if (processInfo === null
    || processInfo.uid !== (typeof process.getuid === 'function' ? process.getuid() : processInfo.uid)
    || path.resolve(processInfo.executable) !== path.resolve(evidence.executablePath)
    || processInfo.processStartMarker !== evidence.processStartMarker) {
    throw new AcceptanceError('ACCEPTANCE_TUNNEL_PROCESS_MISMATCH', 'The local process identity does not match the evidenced provider');
  }
  const bindingNeedle = workloadBinding?.managedProfilePath ?? evidenceProfilePath ?? evidence.tunnelId;
  if (!processInfo.command.includes(bindingNeedle)) throw new AcceptanceError('ACCEPTANCE_TUNNEL_BINDING_UNVERIFIED', 'The local provider process does not expose the evidenced tunnel binding');
  return { provider: evidence.provider, machineId: evidence.machineId, tunnelId: evidence.tunnelId, managedProfilePath: workloadBinding?.managedProfilePath ?? evidenceProfilePath, pid: evidence.pid };
}

async function readAcceptanceWorkloadBinding(dataRoot) {
  const registryPath = path.join(dataRoot, 'connector-registry.json');
  const registryContent = await readFile(registryPath, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (registryContent === null) throw new AcceptanceError('ACCEPTANCE_TUNNEL_BINDING_UNVERIFIED', 'Acceptance connector registry is required for remote startup');
  let parsedRegistry;
  try { parsedRegistry = JSON.parse(registryContent); } catch { throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_INVALID', 'Acceptance connector registry is invalid'); }
  const registry = parsedRegistry?.registry ?? parsedRegistry;
  const connectors = Array.isArray(registry?.connectors) ? registry.connectors : null;
  if (connectors === null || connectors.length !== 1) throw new AcceptanceError('ACCEPTANCE_TUNNEL_BINDING_UNVERIFIED', 'Acceptance requires exactly one unified workload connector');
  const workload = connectors[0];
  let managedProfilePath = null;
  if (isRecord(workload) && typeof workload.managedProfilePath === 'string' && path.isAbsolute(workload.managedProfilePath)) {
    try { managedProfilePath = await canonicalPath(workload.managedProfilePath); } catch { throw new AcceptanceError('ACCEPTANCE_TUNNEL_BINDING_UNVERIFIED', 'Acceptance connector profile path is not canonicalizable'); }
  }
  if (!isRecord(workload) || workload.connectorId !== 'iris-full' || workload.label !== 'IRIS' || workload.mode !== 'FULL'
    || workload.runtime !== 'iris-local-runtime' || workload.mcpProfile !== 'FULL' || workload.mcpPath !== '/mcp'
    || !Number.isSafeInteger(workload.healthPort) || workload.healthPort <= 0 || workload.healthPort > 65_535
    || managedProfilePath !== path.resolve(dataRoot, 'tunnel-profiles', 'iris-full.yaml')
    || !/^tunnel_[a-f0-9]{32}$/.test(workload.tunnelId) || !isUuid(workload.machineId)) {
    throw new AcceptanceError('ACCEPTANCE_TUNNEL_BINDING_UNVERIFIED', 'Acceptance registry does not contain a canonical unified workload connector');
  }
  return { connectorId: workload.connectorId, tunnelId: workload.tunnelId, machineId: workload.machineId, managedProfilePath };
}

export function buildChildEnvironment(dataRoot, environment = process.env, ports = null) {
  const childEnvironment = { ...environment };
  delete childEnvironment.IRIS_PROTECTED_REFERENCE_ROOT;
  return {
    ...childEnvironment,
    IRIS_RUNTIME_DATA_ROOT: dataRoot,
    IRIS_ACCEPTANCE_ROOT: dataRoot,
    ...(ports === null ? {} : portEnvironment(ports)),
  };
}

function parsePortEnvironment(raw) {
  if (raw === undefined || raw.trim().length === 0) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new AcceptanceError('ACCEPTANCE_PORTS_INVALID', 'IRIS_ACCEPTANCE_PORTS must be valid JSON'); }
  return validatePortSet(parsed);
}

function parsePortSpec(value) {
  const parsed = {};
  for (const entry of value.split(',')) {
    const [name, rawPort, ...extra] = entry.split('=');
    if (extra.length > 0 || !PORT_KEYS.includes(name) || rawPort === undefined || rawPort.length === 0 || Object.prototype.hasOwnProperty.call(parsed, name)) {
      throw new AcceptanceError('ACCEPTANCE_PORTS_INVALID', 'Use --ports key=port,... with the complete isolated port set');
    }
    parsed[name] = Number(rawPort);
  }
  return validatePortSet(parsed);
}

function validatePortSet(value) {
  if (!isRecord(value) || Object.keys(value).length !== PORT_KEYS.length || PORT_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new AcceptanceError('ACCEPTANCE_PORTS_INVALID', 'The isolated port set must contain runtime, supervisorAdmin, supervisorControl, supervisorTunnelHealth, fullTunnelHealth, proTunnelHealth and web');
  }
  const ports = Object.fromEntries(PORT_KEYS.map((key) => [key, value[key]]));
  if (Object.values(ports).some((port) => !Number.isSafeInteger(port) || port <= 0 || port > 65_535)) {
    throw new AcceptanceError('ACCEPTANCE_PORTS_INVALID', 'Every isolated port must be an integer from 1 through 65535');
  }
  if (new Set(Object.values(ports)).size !== PORT_KEYS.length) throw new AcceptanceError('ACCEPTANCE_PORTS_INVALID', 'Isolated ports must be unique');
  return ports;
}

function assertSideBySidePorts(ports) {
  const protectedPort = Object.entries(DEFAULT_PORTS).find(([, value]) => Object.values(ports).includes(value));
  if (protectedPort !== undefined) throw new AcceptanceError('ACCEPTANCE_PORT_PROTECTED', `Isolated port ${protectedPort[1]} reuses the protected production ${protectedPort[0]} port`);
}

function portEnvironment(ports) {
  return {
    IRIS_ACCEPTANCE_PORTS: JSON.stringify(ports),
    IRIS_RUNTIME_PORT: String(ports.runtime),
    IRIS_SUPERVISOR_ADMIN_PORT: String(ports.supervisorAdmin),
    IRIS_SUPERVISOR_CONTROL_PORT: String(ports.supervisorControl),
    IRIS_SUPERVISOR_TUNNEL_HEALTH_PORT: String(ports.supervisorTunnelHealth),
    IRIS_FULL_TUNNEL_HEALTH_PORT: String(ports.fullTunnelHealth),
    IRIS_PRO_TUNNEL_HEALTH_PORT: String(ports.proTunnelHealth),
    IRIS_WEB_PORT: String(ports.web),
  };
}

export async function verifyGeneratedPortBindings(dataRoot, ports) {
  const registry = await readJsonIfPresent(path.join(dataRoot, 'connector-registry.json'));
  if (registry !== null) {
    const connectors = registry?.connectors;
    if (!Array.isArray(connectors)) throw new AcceptanceError('ACCEPTANCE_PORT_BINDING_MISMATCH', 'Acceptance connector registry is invalid');
    for (const connector of connectors) {
      const expected = connector.connectorId === 'iris-full' ? ports.fullTunnelHealth : connector.connectorId === 'iris-pro' ? ports.proTunnelHealth : null;
      if (expected !== null && connector.healthPort !== expected) throw new AcceptanceError('ACCEPTANCE_PORT_BINDING_MISMATCH', `${connector.connectorId} health port does not match the isolated port set`);
    }
  }
  const endpoint = await readJsonIfPresent(path.join(dataRoot, 'endpoint.json'));
  if (endpoint !== null && new URL(endpoint.apiUrl).port !== String(ports.runtime)) throw new AcceptanceError('ACCEPTANCE_PORT_BINDING_MISMATCH', 'Runtime endpoint does not match the isolated runtime port');
  const profiles = [
    ['iris-full.yaml', ports.fullTunnelHealth, '/mcp'],
    ['iris-pro.yaml', ports.proTunnelHealth, '/mcp-pro'],
    ['iris-admin.yaml', ports.supervisorTunnelHealth, '/mcp'],
  ];
  for (const [filename, healthPort, mcpPath] of profiles) {
    const content = await readTextIfPresent(path.join(dataRoot, 'tunnel-profiles', filename));
    if (content === null) continue;
    if (!content.includes(`127.0.0.1:${healthPort}`)) throw new AcceptanceError('ACCEPTANCE_PORT_BINDING_MISMATCH', `${filename} health binding does not match the isolated port set`);
    if (!content.includes(`127.0.0.1:${ports.runtime}${mcpPath}`) && filename !== 'iris-admin.yaml') {
      throw new AcceptanceError('ACCEPTANCE_PORT_BINDING_MISMATCH', `${filename} runtime URL does not match the isolated runtime port`);
    }
    if (filename === 'iris-admin.yaml' && !content.includes(`127.0.0.1:${ports.supervisorControl}${mcpPath}`)) {
      throw new AcceptanceError('ACCEPTANCE_PORT_BINDING_MISMATCH', 'Admin profile does not match the isolated Supervisor control port');
    }
  }
}

async function readJsonIfPresent(filename) {
  const content = await readTextIfPresent(filename);
  return content === null ? null : JSON.parse(content);
}

async function readTextIfPresent(filename) {
  return readFile(filename, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

async function bindIdentity(dataRoot, sourceRoot, git, rootIdentity, allowCreate) {
  const filename = path.join(dataRoot, IDENTITY_FILE);
  const current = await readFile(filename, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  const expected = { schemaVersion: 2, dataRoot, sourceRoot, rootIdentity, branch: git.branch, head: git.head };
  if (current !== null) {
    let parsed;
    try { parsed = JSON.parse(current); } catch { throw new AcceptanceError('ACCEPTANCE_IDENTITY_INVALID', 'Acceptance identity file is invalid; preserve the root and ask the owner'); }
    if (!sameIdentity(parsed, expected)) throw new AcceptanceError('ACCEPTANCE_IDENTITY_CHANGED', 'Acceptance data-root or source identity changed; stop and preserve the root');
    return;
  }
  const entries = await readdir(dataRoot);
  if (entries.length > 0) throw new AcceptanceError('ACCEPTANCE_ROOT_REUSED', 'Acceptance data root already contains state but no IRIS acceptance identity; choose a new private root');
  if (!allowCreate) throw new AcceptanceError('ACCEPTANCE_PREFLIGHT_REQUIRED', 'Run the explicit acceptance preflight before any acceptance command');
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

async function findTunnelClaims(protectedRoots, tunnelId, readTextFile = readFile) {
  const claims = [];
  for (const root of protectedRoots) {
    const filename = path.join(root, 'connector-registry.json');
    let content;
    try {
      content = await readTextFile(filename, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_UNAVAILABLE', 'Protected tunnel ownership evidence is unavailable; refusing acceptance');
    }
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_INVALID', 'Protected connector registry is invalid; refusing acceptance'); }
    const registry = parsed?.registry ?? parsed;
    const bindings = registry?.connectors;
    const admin = registry?.admin;
    if (!Array.isArray(bindings) || (admin !== null && admin !== undefined && (typeof admin !== 'object' || Array.isArray(admin)))) {
      throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_INVALID', 'Protected connector registry is invalid; refusing acceptance');
    }
    const candidates = [...bindings, admin].filter(Boolean);
    if (candidates.some((binding) => typeof binding !== 'object' || Array.isArray(binding) || typeof binding.tunnelId !== 'string')) {
      throw new AcceptanceError('ACCEPTANCE_TUNNEL_EVIDENCE_INVALID', 'Protected connector registry is invalid; refusing acceptance');
    }
    if (candidates.some((binding) => binding.tunnelId === tunnelId)) claims.push(root);
  }
  return claims;
}

async function findPortConflicts(ports, probe = probePort) {
  const conflicts = [];
  for (const [name, port] of Object.entries(ports)) if (await probe(port, '127.0.0.1')) conflicts.push({ name, port });
  return conflicts;
}

function requiresPortSet(command) {
  return command.length > 0;
}

function needsFreePorts(command) {
  return command[0] === 'preflight' || command[0] === 'up' || command[0] === 'restart' || command[0] === 'supervisor' || (command[0] === 'setup' && command.includes('--start'));
}

function startsRemoteTunnel(command) {
  return (needsFreePorts(command) && command[0] !== 'preflight') || (command[0] === 'connectors' && command[1] === 'admin-bind');
}

function commandValue(command, flag) {
  const index = command.indexOf(flag);
  return index < 0 ? null : command[index + 1] ?? null;
}

function stripAcceptanceArguments(command) {
  if (!['up', 'restart', 'supervisor'].includes(command[0])) return command;
  const stripped = [];
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === '--tunnel-id') { index += 1; continue; }
    stripped.push(command[index]);
  }
  return stripped;
}

async function existingPrivateDirectory(input, code) {
  const canonical = await existingDirectory(input, code);
  const metadata = await stat(canonical);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new AcceptanceError(code, `Directory ${canonical} is not owned by the current user`);
  if ((metadata.mode & 0o077) !== 0) throw new AcceptanceError(code, `Directory ${canonical} must grant access only to the current user`);
  return canonical;
}

async function physicalDirectoryIdentity(canonical) {
  const metadata = await stat(canonical).catch(() => null);
  if (metadata === null || !metadata.isDirectory()) throw new AcceptanceError('ACCEPTANCE_ROOT_INVALID', 'Acceptance root is no longer a physical directory');
  return {
    canonicalPath: canonical,
    device: metadata.dev,
    inode: metadata.ino,
    ownerUid: metadata.uid,
    mode: metadata.mode & 0o777,
  };
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
  if (!/^[a-f0-9]{40}$/.test(head)) throw new AcceptanceError('ACCEPTANCE_SOURCE_INVALID', 'Acceptance source must have a verified HEAD');
  return { head, branch: branch.length === 0 ? 'DETACHED' : branch };
}

async function pidExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function inspectProcessIdentity(pid) {
  try {
    const [uid, executable, command] = await Promise.all([
      execFileAsync('ps', ['-p', String(pid), '-o', 'uid=']).then((result) => Number(result.stdout.trim())),
      execFileAsync('ps', ['-p', String(pid), '-o', 'comm=']).then((result) => result.stdout.trim()),
      execFileAsync('ps', ['-p', String(pid), '-o', 'command=']).then((result) => result.stdout.trim()),
    ]);
    if (!Number.isSafeInteger(uid) || executable.length === 0 || command.length === 0) return null;
    const processStartMarker = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=']).then((result) => result.stdout.trim());
    if (processStartMarker.length === 0) return null;
    return { uid, executable, command, processStartMarker };
  } catch { return null; }
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sameIdentity(actual, expected) {
  return actual?.schemaVersion === expected.schemaVersion
    && actual.dataRoot === expected.dataRoot
    && actual.sourceRoot === expected.sourceRoot
    && actual.rootIdentity?.canonicalPath === expected.rootIdentity.canonicalPath
    && actual.rootIdentity?.device === expected.rootIdentity.device
    && actual.rootIdentity?.inode === expected.rootIdentity.inode
    && actual.rootIdentity?.ownerUid === expected.rootIdentity.ownerUid
    && actual.rootIdentity?.mode === expected.rootIdentity.mode
    && actual.branch === expected.branch
    && actual.head === expected.head;
}
