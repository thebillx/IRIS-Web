import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IRIS_VERSION, RuntimeError, type RuntimeHealth, type RuntimeIdentity } from '@iris/domain';
import { AGENT_EXECUTOR_ENV, OPENAI_API_KEY_ENV, OPENAI_MODEL_ENV } from './agent-executor.js';
import { AUTHORITY_RECOVERY_IN_PROGRESS, probeRuntimeAuthority } from './authority.js';
import { resolveRuntimeDataRoot, RUNTIME_DATA_ENV } from './data-root.js';
import { readEndpoint, readRuntimeControl, type EndpointDocument, type RuntimeControlDocument } from './persistence.js';
import { assertSupportedNodeVersion, canonicalNodeRuntime, node24Path } from './node-runtime.js';

export interface RuntimeObservedStatus {
  readonly state: 'running' | 'stopped' | 'stale' | 'indeterminate';
  readonly endpoint: EndpointDocument | null;
  readonly health: RuntimeHealth | null;
  readonly reason?: string;
}

export interface StartRuntimeOptions {
  readonly dataRoot?: string;
  readonly preferredPort?: number;
  readonly startupDeadlineMs?: number;
}

export async function runtimeStatus(dataRootInput?: string): Promise<RuntimeObservedStatus> {
  assertSupportedNodeVersion();
  const dataRoot = await canonicalDataRoot(dataRootInput);
  let endpoint: EndpointDocument | null;
  try {
    endpoint = await readEndpoint(dataRoot);
  } catch (error: unknown) {
    return { state: 'indeterminate', endpoint: null, health: null, reason: errorCode(error) };
  }
  const authority = await probeRuntimeAuthority(dataRoot);
  let control;
  try {
    control = await readRuntimeControl(dataRoot);
  } catch (error: unknown) {
    return { state: 'indeterminate', endpoint, health: null, reason: errorCode(error) };
  }
  if (endpoint === null) {
    if (control !== null) {
      if (authority.state === 'live'
        && control.runtimeId === authority.identity.runtimeId
        && control.instanceId === authority.identity.instanceId) {
        return { state: 'indeterminate', endpoint: null, health: null, reason: 'RUNTIME_STARTING' };
      }
      if (authority.state === 'live') {
        return { state: 'indeterminate', endpoint: null, health: null, reason: 'RUNTIME_AUTHORITY_ACTIVE' };
      }
      return { state: 'stale', endpoint: null, health: null, reason: 'STALE_METADATA' };
    }
    if (authority.state === 'unowned') return { state: 'stopped', endpoint: null, health: null };
    if (authority.state === 'stale') return { state: 'stale', endpoint: null, health: null, reason: 'STALE_AUTHORITY' };
    if (authority.state === 'live') return { state: 'indeterminate', endpoint: null, health: null, reason: 'RUNTIME_STARTING' };
    if (authority.reason === AUTHORITY_RECOVERY_IN_PROGRESS) {
      return { state: 'indeterminate', endpoint: null, health: null, reason: 'RUNTIME_STARTING' };
    }
    return { state: 'indeterminate', endpoint: null, health: null, reason: authority.reason };
  }
  if (control === null) {
    if (authority.state === 'stale' && endpointMatchesIdentity(endpoint, authority.identity)) {
      return { state: 'stale', endpoint, health: null, reason: 'STALE_AUTHORITY' };
    }
    if (authority.state === 'live' && replacedStaleEndpointIsStarting(endpoint, authority.identity, null)) {
      return { state: 'indeterminate', endpoint, health: null, reason: 'RUNTIME_STARTING' };
    }
    if (authority.state === 'indeterminate'
      && authority.reason === AUTHORITY_RECOVERY_IN_PROGRESS
      && !pidExists(endpoint.pid)) {
      return { state: 'indeterminate', endpoint, health: null, reason: 'RUNTIME_STARTING' };
    }
    if (!pidExists(endpoint.pid) && authority.state !== 'live') return { state: 'stale', endpoint, health: null, reason: 'STALE_METADATA' };
    return { state: 'indeterminate', endpoint, health: null, reason: pidExists(endpoint.pid) ? 'FOREIGN_PROCESS' : 'Runtime control metadata does not identify the endpoint daemon' };
  }
  if (control.runtimeId !== endpoint.runtimeId || control.instanceId !== endpoint.instanceId) {
    if (authority.state === 'live' && replacedStaleEndpointIsStarting(endpoint, authority.identity, control)) {
      return { state: 'indeterminate', endpoint, health: null, reason: 'RUNTIME_STARTING' };
    }
    if (!pidExists(endpoint.pid) && authority.state !== 'live') return { state: 'stale', endpoint, health: null, reason: 'STALE_METADATA' };
    return { state: 'indeterminate', endpoint, health: null, reason: pidExists(endpoint.pid) ? 'FOREIGN_PROCESS' : 'Runtime control metadata does not identify the endpoint daemon' };
  }

  try {
    const response = await fetch(`${endpoint.apiUrl}/status`, { signal: AbortSignal.timeout(1_000), cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const remote = await response.json() as unknown;
    if (!isRemoteStatus(remote)) return { state: 'indeterminate', endpoint, health: null, reason: 'Runtime status response is invalid' };
    if (!endpointMatchesIdentity(endpoint, remote.identity)) {
      return { state: 'stale', endpoint, health: remote.health, reason: 'Runtime endpoint identity mismatch' };
    }
    if (authority.state !== 'live' || !sameIdentity(authority.identity, remote.identity)) {
      return { state: 'indeterminate', endpoint, health: remote.health, reason: 'Endpoint and runtime authority do not identify the same daemon' };
    }
    return { state: 'running', endpoint, health: remote.health };
  } catch {
    return {
      state: authority.state === 'stale' || !pidExists(endpoint.pid) ? 'stale' : 'indeterminate',
      endpoint,
      health: null,
      reason: authority.state === 'stale' || !pidExists(endpoint.pid) ? 'STALE_METADATA' : 'Runtime endpoint is unreachable',
    };
  }
}

export async function startRuntime(options: StartRuntimeOptions = {}): Promise<RuntimeObservedStatus> {
  assertSupportedNodeVersion();
  const dataRoot = await canonicalDataRoot(options.dataRoot);
  const existing = await runtimeStatus(dataRoot);
  if (existing.state === 'running') return existing;
  if (existing.state === 'indeterminate' && existing.reason !== 'RUNTIME_STARTING') {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', existing.reason ?? 'Runtime authority is indeterminate');
  }
  if (existing.reason === 'RUNTIME_STARTING') {
    return waitForRunningRuntime(dataRoot, options.startupDeadlineMs ?? 10_000);
  }

  const sourceEntrypoint = path.resolve(import.meta.dirname, 'main.ts');
  const builtEntrypoint = path.resolve(import.meta.dirname, 'main.js');
  const sourceMode = existsSync(sourceEntrypoint);
  const executable = canonicalNodeRuntime().path;
  const args = sourceMode
    ? [
      '--require', path.resolve(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'preflight.cjs'),
      '--import', pathToFileURL(path.resolve(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      sourceEntrypoint,
    ]
    : [builtEntrypoint];
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    env: runtimeChildEnvironment(dataRoot, options.preferredPort),
  });
  child.unref();
  return waitForRunningRuntime(
    dataRoot,
    options.startupDeadlineMs ?? 10_000,
    existing.state === 'stale' ? existing.endpoint : null,
  );
}

export async function stopRuntime(dataRootInput?: string, shutdownDeadlineMs = 10_000): Promise<RuntimeObservedStatus> {
  assertSupportedNodeVersion();
  const dataRoot = await canonicalDataRoot(dataRootInput);
  const current = await runtimeStatus(dataRoot);
  if (current.state === 'stopped') return current;
  if (current.state !== 'running' || current.endpoint === null || current.health === null) {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', current.reason ?? 'Runtime owner cannot be verified');
  }
  const target = current.endpoint;
  const authorityBeforeSignal = await probeRuntimeAuthority(dataRoot);
  const endpointBeforeSignal = await readEndpoint(dataRoot);
  const control = await readRuntimeControl(dataRoot);
  if (authorityBeforeSignal.state !== 'live'
    || endpointBeforeSignal === null
    || control === null
    || !endpointMatchesIdentity(endpointBeforeSignal, authorityBeforeSignal.identity)
    || endpointBeforeSignal.instanceId !== target.instanceId
    || endpointBeforeSignal.runtimeId !== target.runtimeId
    || control.instanceId !== target.instanceId
    || control.runtimeId !== target.runtimeId) {
    throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime identity changed before shutdown request');
  }

  let accepted: Response;
  try {
    accepted = await fetch(`${target.apiUrl}/control/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${control.secret}` },
      body: JSON.stringify({ runtimeId: target.runtimeId, instanceId: target.instanceId }),
      signal: AbortSignal.timeout(Math.min(2_000, bounded(shutdownDeadlineMs, 500, 60_000))),
    });
  } catch (error) {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Verified runtime did not accept the instance-bound shutdown request', { cause: error });
  }
  if (accepted.status !== 202) {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', `Verified runtime rejected shutdown with HTTP ${accepted.status}`);
  }

  const deadline = Date.now() + bounded(shutdownDeadlineMs, 500, 60_000);
  while (Date.now() < deadline) {
    const endpoint = await readEndpoint(dataRoot);
    if (endpoint !== null && !sameEndpointIdentity(endpoint, target)) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'A different runtime descriptor appeared during shutdown');
    }
    const controlAfter = await readRuntimeControl(dataRoot);
    if (controlAfter !== null && (controlAfter.instanceId !== target.instanceId || controlAfter.runtimeId !== target.runtimeId)) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'A different runtime control record appeared during shutdown');
    }
    const authority = await probeRuntimeAuthority(dataRoot);
    if (authority.state === 'live' && !endpointMatchesIdentity(target, authority.identity)) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'A different runtime authority appeared during shutdown');
    }
    if (!pidExists(target.pid) && endpoint === null && controlAfter === null && authority.state === 'unowned') {
      return { state: 'stopped', endpoint: null, health: null };
    }
    await conditionPoll();
  }
  throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'STOP_COMPLETE was not proven before the shutdown deadline');
}

export const STOP_COMPLETE_CONTRACT = 'target_pid_gone+target_descriptor_absent+target_control_absent+authority_unowned' as const;

export function runtimeChildEnvironment(dataRoot: string, preferredPort?: number, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: node24Path(),
    [RUNTIME_DATA_ENV]: dataRoot,
    ...(preferredPort === undefined ? {} : { IRIS_RUNTIME_PORT: String(preferredPort) }),
  };
  for (const name of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const) {
    const value = source[name];
    if (value !== undefined && value.length > 0) environment[name] = value;
  }
  const executorSelection = source[AGENT_EXECUTOR_ENV];
  if (executorSelection !== undefined && executorSelection.length > 0) environment[AGENT_EXECUTOR_ENV] = executorSelection;
  if (executorSelection?.trim() === 'openai') {
    for (const name of [OPENAI_API_KEY_ENV, OPENAI_MODEL_ENV] as const) {
      const value = source[name];
      if (value !== undefined && value.length > 0) environment[name] = value;
    }
  }
  return environment;
}

async function canonicalDataRoot(input: string | undefined): Promise<string> {
  return input === undefined
    ? resolveRuntimeDataRoot()
    : resolveRuntimeDataRoot({ ...process.env, [RUNTIME_DATA_ENV]: input });
}

async function waitForRunningRuntime(
  dataRoot: string,
  timeoutMs: number,
  recoveryEndpoint: EndpointDocument | null = null,
): Promise<RuntimeObservedStatus> {
  const deadline = Date.now() + bounded(timeoutMs, 500, 60_000);
  while (Date.now() < deadline) {
    const status = await runtimeStatus(dataRoot);
    if (status.state === 'running') return status;
    const exactRecoveryTransition = recoveryEndpoint !== null
      && status.endpoint !== null
      && sameEndpointIdentity(status.endpoint, recoveryEndpoint)
      && !pidExists(recoveryEndpoint.pid)
      && status.reason === 'Runtime control metadata does not identify the endpoint daemon';
    if (status.state === 'indeterminate'
      && status.reason !== 'RUNTIME_STARTING'
      && status.reason !== 'Runtime endpoint is unreachable'
      && !exactRecoveryTransition) {
      throw new RuntimeError('AUTHORITY_INDETERMINATE', status.reason ?? 'Runtime startup became indeterminate');
    }
    await conditionPoll();
  }
  throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Runtime did not become ready before the startup deadline');
}

function replacedStaleEndpointIsStarting(
  endpoint: EndpointDocument,
  liveIdentity: RuntimeIdentity,
  control: RuntimeControlDocument | null,
): boolean {
  return endpoint.runtimeId === liveIdentity.runtimeId
    && !endpointMatchesIdentity(endpoint, liveIdentity)
    && !pidExists(endpoint.pid)
    && (control === null
      || (control.runtimeId === liveIdentity.runtimeId && control.instanceId === liveIdentity.instanceId));
}

function endpointMatchesIdentity(endpoint: EndpointDocument, identity: RuntimeIdentity): boolean {
  return endpoint.runtimeId === identity.runtimeId
    && endpoint.instanceId === identity.instanceId
    && endpoint.pid === identity.pid
    && endpoint.startedAt === identity.startedAt;
}

function sameEndpointIdentity(left: EndpointDocument, right: EndpointDocument): boolean {
  return left.runtimeId === right.runtimeId
    && left.instanceId === right.instanceId
    && left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.apiUrl === right.apiUrl
    && left.mcpUrl === right.mcpUrl;
}

function sameIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.runtimeId === right.runtimeId
    && left.instanceId === right.instanceId
    && left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.platform === right.platform
    && left.version === right.version;
}

function isRemoteStatus(value: unknown): value is { readonly identity: RuntimeIdentity; readonly health: RuntimeHealth } {
  if (!isRecord(value) || !isRecord(value.identity) || !isRecord(value.health)) return false;
  const identity = value.identity;
  const health = value.health;
  return typeof identity.runtimeId === 'string'
    && typeof identity.instanceId === 'string'
    && Number.isSafeInteger(identity.pid)
    && typeof identity.startedAt === 'string'
    && identity.platform === 'darwin'
    && identity.version === IRIS_VERSION
    && health.runtimeId === identity.runtimeId
    && health.instanceId === identity.instanceId
    && health.pid === identity.pid
    && health.platform === identity.platform
    && health.version === identity.version
    && (health.status === 'ready' || health.status === 'stopping')
    && health.authority === 'owned'
    && typeof health.uptimeMs === 'number'
    && typeof health.apiUrl === 'string'
    && typeof health.mcpUrl === 'string';
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isProcessMissing(error);
  }
}

function isProcessMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ESRCH';
}

function errorCode(error: unknown): string {
  return error instanceof RuntimeError ? error.code : 'PERSISTENCE_FAILURE';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;
}

async function conditionPoll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}
