import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { RuntimeError, type RuntimeHealth } from '@iris/domain';
import { probeRuntimeAuthority } from './authority.js';
import { resolveRuntimeDataRoot, RUNTIME_DATA_ENV } from './data-root.js';
import { readEndpoint, type EndpointDocument } from './persistence.js';

export type RuntimeEndpoint = Omit<EndpointDocument, 'controlToken'>;

export interface RuntimeObservedStatus {
  readonly state: 'running' | 'stopped' | 'stale' | 'indeterminate';
  readonly endpoint: RuntimeEndpoint | null;
  readonly health: RuntimeHealth | null;
  readonly reason?: string;
}

export interface StartRuntimeOptions {
  readonly dataRoot?: string;
  readonly preferredPort?: number;
  readonly startupDeadlineMs?: number;
}

export async function runtimeStatus(dataRootInput?: string): Promise<RuntimeObservedStatus> {
  const dataRoot = await canonicalDataRoot(dataRootInput);
  const privateEndpoint = await readEndpoint(dataRoot);
  const endpoint = privateEndpoint === null ? null : publicEndpoint(privateEndpoint);
  const authority = await probeRuntimeAuthority(dataRoot);
  if (endpoint === null) {
    if (authority.state === 'unowned') return { state: 'stopped', endpoint: null, health: null };
    if (authority.state === 'stale') return { state: 'stale', endpoint: null, health: null, reason: 'STALE_AUTHORITY' };
    if (authority.state === 'live') {
      return { state: 'indeterminate', endpoint: null, health: null, reason: 'Live authority has not published an endpoint' };
    }
    return { state: 'indeterminate', endpoint: null, health: null, reason: authority.reason };
  }

  try {
    const response = await fetch(`${endpoint.apiUrl}/health`, {
      signal: AbortSignal.timeout(1_000),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json() as RuntimeHealth;
    const identityMatches = health.runtimeId === endpoint.runtimeId
      && health.instanceId === endpoint.instanceId
      && health.pid === endpoint.pid;
    if (!identityMatches) return { state: 'stale', endpoint, health, reason: 'Runtime endpoint identity mismatch' };
    if (authority.state !== 'live'
      || authority.identity.instanceId !== endpoint.instanceId
      || authority.identity.runtimeId !== endpoint.runtimeId) {
      return {
        state: 'indeterminate',
        endpoint,
        health,
        reason: 'Endpoint and runtime authority do not identify the same daemon',
      };
    }
    return { state: 'running', endpoint, health };
  } catch {
    return {
      state: authority.state === 'stale' ? 'stale' : 'indeterminate',
      endpoint,
      health: null,
      reason: 'Runtime endpoint is unreachable',
    };
  }
}

export async function startRuntime(options: StartRuntimeOptions = {}): Promise<RuntimeObservedStatus> {
  const dataRoot = await canonicalDataRoot(options.dataRoot);
  const existing = await runtimeStatus(dataRoot);
  if (existing.state === 'running') return existing;
  if (existing.state === 'indeterminate') {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', existing.reason ?? 'Runtime authority is indeterminate');
  }

  const sourceEntrypoint = path.resolve(import.meta.dirname, 'main.ts');
  const builtEntrypoint = path.resolve(import.meta.dirname, 'main.js');
  const entrypoint = existsSync(sourceEntrypoint) ? sourceEntrypoint : builtEntrypoint;
  const args = entrypoint.endsWith('.ts') ? ['--import', 'tsx', entrypoint] : [entrypoint];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      [RUNTIME_DATA_ENV]: dataRoot,
      ...(options.preferredPort === undefined ? {} : { IRIS_RUNTIME_PORT: String(options.preferredPort) }),
    },
  });
  child.unref();

  const deadline = Date.now() + bounded(options.startupDeadlineMs ?? 10_000, 500, 60_000);
  while (Date.now() < deadline) {
    const status = await runtimeStatus(dataRoot);
    if (status.state === 'running') return status;
    if (status.state === 'indeterminate' && status.reason?.includes('identity mismatch')) {
      throw new RuntimeError('AUTHORITY_CHANGED', status.reason);
    }
    await conditionPoll();
  }
  throw new RuntimeError('RUNTIME_NOT_RUNNING', 'Runtime did not become ready before the startup deadline');
}

export async function stopRuntime(dataRootInput?: string, shutdownDeadlineMs = 10_000): Promise<RuntimeObservedStatus> {
  const dataRoot = await canonicalDataRoot(dataRootInput);
  const current = await runtimeStatus(dataRoot);
  if (current.state === 'stopped') return current;
  if (current.state !== 'running' || current.endpoint === null || current.health === null) {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', current.reason ?? 'Runtime owner cannot be verified');
  }

  const target = current.endpoint;
  if (current.health.instanceId !== target.instanceId
    || current.health.runtimeId !== target.runtimeId
    || current.health.pid !== target.pid) {
    throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime identity changed before shutdown request');
  }
  const privateTarget = await readEndpoint(dataRoot);
  if (privateTarget === null || !sameEndpointIdentity(privateTarget, target)) {
    throw new RuntimeError('AUTHORITY_CHANGED', 'Private runtime control record changed before shutdown request');
  }

  let accepted: Response;
  try {
    accepted = await fetch(`${target.apiUrl}/control/stop`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${privateTarget.controlToken}`,
      },
      body: JSON.stringify({ runtimeId: target.runtimeId, instanceId: target.instanceId }),
      signal: AbortSignal.timeout(Math.min(2_000, bounded(shutdownDeadlineMs, 500, 60_000))),
    });
  } catch (error) {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Verified runtime did not accept the instance-bound stop request', { cause: error });
  }
  if (accepted.status !== 202) {
    throw new RuntimeError('AUTHORITY_INDETERMINATE', `Verified runtime rejected the stop request with HTTP ${accepted.status}`);
  }

  const deadline = Date.now() + bounded(shutdownDeadlineMs, 500, 60_000);
  while (Date.now() < deadline) {
    const endpoint = await readEndpoint(dataRoot);
    if (endpoint !== null && endpoint.instanceId !== target.instanceId) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'A different runtime descriptor appeared during shutdown');
    }
    const authority = await probeRuntimeAuthority(dataRoot);
    if (authority.state === 'live' && authority.identity.instanceId !== target.instanceId) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'A different runtime authority appeared during shutdown');
    }
    const processGone = !pidExists(target.pid);
    if (processGone && endpoint === null && authority.state === 'unowned') {
      return { state: 'stopped', endpoint: null, health: null };
    }
    await conditionPoll();
  }
  throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'STOP_COMPLETE was not proven before the shutdown deadline');
}

export const STOP_COMPLETE_CONTRACT = 'target_pid_gone+target_descriptor_absent+authority_unowned' as const;

async function canonicalDataRoot(input: string | undefined): Promise<string> {
  return input === undefined
    ? resolveRuntimeDataRoot()
    : resolveRuntimeDataRoot({ ...process.env, [RUNTIME_DATA_ENV]: input });
}

function publicEndpoint(endpoint: EndpointDocument): RuntimeEndpoint {
  return {
    schemaVersion: endpoint.schemaVersion,
    runtimeId: endpoint.runtimeId,
    instanceId: endpoint.instanceId,
    pid: endpoint.pid,
    apiUrl: endpoint.apiUrl,
    mcpUrl: endpoint.mcpUrl,
    startedAt: endpoint.startedAt,
  };
}

function sameEndpointIdentity(left: EndpointDocument, right: RuntimeEndpoint): boolean {
  return left.runtimeId === right.runtimeId
    && left.instanceId === right.instanceId
    && left.pid === right.pid
    && left.apiUrl === right.apiUrl
    && left.mcpUrl === right.mcpUrl
    && left.startedAt === right.startedAt;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ESRCH');
  }
}

function bounded(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;
}

async function conditionPoll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}
