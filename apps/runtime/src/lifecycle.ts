import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, open, readFile, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { IRIS_VERSION, RuntimeError, type RuntimeHealth, type RuntimeIdentity } from '@iris/domain';
import { AGENT_EXECUTOR_ENV, OPENAI_API_KEY_ENV, OPENAI_MODEL_ENV } from './agent-executor.js';
import { assertActivationSourceIdentity, assertActivationWorkloadReady, inspectActivationSourceIdentity, type ActivationSourceIdentity } from './activation-source-identity.js';
import { AUTHORITY_RECOVERY_IN_PROGRESS, probeRuntimeAuthority } from './authority.js';
import { resolveRuntimeDataRoot, RUNTIME_DATA_ENV } from './data-root.js';
import { readEndpoint, readRuntimeControl, type EndpointDocument, type RuntimeControlDocument } from './persistence.js';
import { assertSupportedNodeVersion, canonicalNodeRuntime, node24Path } from './node-runtime.js';

import { confirmChildSpawn } from './spawn-outcome.js';
import { writePrivateJsonAtomic } from './credentials.js';

export interface RuntimeObservedStatus {
  readonly state: 'running' | 'stopped' | 'stale' | 'indeterminate';
  readonly endpoint: EndpointDocument | null;
  readonly health: RuntimeHealth | null;
  readonly reason?: string;
}

export interface StartRuntimeOptions {
  readonly onSpawn?: (pid: number) => Promise<void>;
  readonly dataRoot?: string;
  readonly preferredPort?: number;
  readonly startupDeadlineMs?: number;
  readonly sourceRoot?: string;
  readonly protectedReferenceRoot?: string;
  readonly expectedSourceIdentity?: ActivationSourceIdentity;
  /** Opaque Supervisor startup operation binding; absent for direct starts. */
  readonly supervisorStartupId?: string;
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

  const runtimeSourceRoot = options.sourceRoot === undefined
    ? path.resolve(import.meta.dirname, '../../..')
    : path.resolve(options.sourceRoot);
  const runtimeDirectory = path.join(runtimeSourceRoot, 'apps', 'runtime');
  const sourceEntrypoint = path.join(runtimeDirectory, 'src', 'main.ts');
  const builtEntrypoint = path.join(runtimeDirectory, 'dist', 'main.js');
  const sourceMode = existsSync(sourceEntrypoint);
  const executable = canonicalNodeRuntime().path;
  const args = sourceMode
    ? [
      '--require', path.join(runtimeDirectory, 'node_modules', 'tsx', 'dist', 'preflight.cjs'),
      '--import', pathToFileURL(path.join(runtimeDirectory, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      sourceEntrypoint,
    ]
    : [builtEntrypoint];
  if (options.expectedSourceIdentity !== undefined) {
    await assertActivationSourceIdentity(
      runtimeSourceRoot,
      options.expectedSourceIdentity,
      'Candidate source identity changed at the runtime launch boundary',
    );
    await assertActivationWorkloadReady(runtimeSourceRoot);
  }
  const child = spawn(executable, args, {
    cwd: runtimeSourceRoot,
    detached: true,
    stdio: 'ignore',
    env: runtimeChildEnvironment(dataRoot, options.preferredPort, process.env, options.protectedReferenceRoot, options.supervisorStartupId),
  });
  child.on('error', () => undefined);
  child.unref();
  const pid = await confirmChildSpawn(child);
  await options.onSpawn?.(pid);
  const ready = await waitForRunningRuntime(
    dataRoot,
    options.startupDeadlineMs ?? 10_000,
    existing.state === 'stale' ? existing.endpoint : null,
  );
  if (options.expectedSourceIdentity !== undefined) {
    await assertActivationSourceIdentity(runtimeSourceRoot, options.expectedSourceIdentity, 'Candidate source identity changed after runtime became ready');
  }
  return ready;
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

export function runtimeChildEnvironment(
  dataRoot: string,
  preferredPort?: number,
  source: NodeJS.ProcessEnv = process.env,
  protectedReferenceRoot?: string,
  supervisorStartupId?: string,
): NodeJS.ProcessEnv {
  const configuredProtectedReferenceRoot = protectedReferenceRoot ?? source.IRIS_PROTECTED_REFERENCE_ROOT?.trim();
  const environment: NodeJS.ProcessEnv = {
    PATH: node24Path(),
    [RUNTIME_DATA_ENV]: dataRoot,
    ...(preferredPort === undefined ? {} : { IRIS_RUNTIME_PORT: String(preferredPort) }),
    ...(configuredProtectedReferenceRoot === undefined || configuredProtectedReferenceRoot.length === 0
      ? {}
      : { IRIS_PROTECTED_REFERENCE_ROOT: configuredProtectedReferenceRoot }),
    ...(supervisorStartupId === undefined ? {} : { IRIS_SUPERVISOR_STARTUP_ID: supervisorStartupId }),
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
    && (health.status === 'ready' || health.status === 'failed' || health.status === 'stopping')
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


const execFileForRecovery = promisify(execFile);

export interface RecoverySourceDescriptor {
  readonly commitSha: string; readonly treeSha: string; readonly sourceRoot: string; readonly entrypoint: string; readonly entrypointGitBlob: string;
}
interface AttestedRecoverySource { readonly descriptor: RecoverySourceDescriptor; readonly activationIdentity: ActivationSourceIdentity; }
export interface RecoveryReceipt {
  readonly schemaVersion: 2; readonly requestId: string; readonly dataRoot: string; readonly startupDeadlineMs: number; readonly shutdownDeadlineMs: number;
  readonly outcome: 'COMMITTED' | 'FAILED' | 'RECONCILIATION_REQUIRED'; readonly selectedSource: 'A' | 'B' | null;
  readonly sourceA: RecoverySourceDescriptor; readonly sourceB: RecoverySourceDescriptor; readonly primaryFailure: string | null;
  readonly sourceAFailure: string | null; readonly sourceBFailure: string | null;
  readonly cleanup: readonly { readonly source: 'A' | 'B'; readonly outcome: 'STOPPED' | 'UNRESOLVED' }[]; readonly createdAt: string;
}
export interface RecoveryRuntimeAdapter {
  readonly status: (dataRoot: string) => Promise<RuntimeObservedStatus>;
  readonly start: (options: StartRuntimeOptions) => Promise<RuntimeObservedStatus>;
  readonly stop: (dataRoot: string, deadlineMs: number) => Promise<RuntimeObservedStatus>;
}
export interface RecoveryFallbackInput {
  readonly requestId: string; readonly dataRoot: string; readonly receiptPath: string; readonly sourceA: RecoverySourceDescriptor; readonly sourceB: RecoverySourceDescriptor;
  readonly startupDeadlineMs?: number; readonly shutdownDeadlineMs?: number; readonly runtime?: RecoveryRuntimeAdapter;
}
export async function recoverRuntimeWithSourceFallback(input: RecoveryFallbackInput): Promise<RecoveryReceipt> {
  const dataRoot = await realpath(input.dataRoot); const receiptPath = await canonicalReceiptPath(dataRoot, input.receiptPath);
  const startupDeadlineMs = bounded(input.startupDeadlineMs ?? 10_000, 500, 60_000); const shutdownDeadlineMs = bounded(input.shutdownDeadlineMs ?? 10_000, 500, 60_000);
  const runtime = input.runtime ?? { status: runtimeStatus, start: startRuntime, stop: stopRuntime };
  const sourceA = await attestRecoverySource(input.sourceA); const sourceB = await attestRecoverySource(input.sourceB);
  if (immutableContentIdentityEqual(sourceA.descriptor, sourceB.descriptor)) throw new RuntimeError('PRECONDITION_FAILED', 'Recovery sources must be distinct immutable identities');
  const intentPath = `${receiptPath}.intent`;
  const existing = await readRecoveryReceipt(receiptPath);
  if (existing !== null) {
    assertRecoveryEnvelope(existing, input.requestId, dataRoot, startupDeadlineMs, shutdownDeadlineMs, sourceA.descriptor, sourceB.descriptor);
    const finalizedIntent = await readRecoveryIntent(intentPath);
    if (finalizedIntent?.state !== 'FINALIZED' || finalizedIntent.outcome !== existing.outcome) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Recovery receipt and intent disagree');
    }
    if (existing.outcome === 'RECONCILIATION_REQUIRED') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Recovery outcome requires explicit reconciliation');
    return existing;
  }
  const intent = { schemaVersion: 2 as const, state: 'IN_PROGRESS' as const, requestId: input.requestId, dataRoot, startupDeadlineMs, shutdownDeadlineMs, sourceA: sourceA.descriptor, sourceB: sourceB.descriptor };
  try { await writeDurableExclusive(intentPath, intent); }
  catch (error: unknown) { if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Recovery intent already exists; explicit reconciliation is required'); throw error; }
  const cleanup: Array<{ readonly source: 'A' | 'B'; readonly outcome: 'STOPPED' | 'UNRESOLVED' }> = [];
  const base: Omit<RecoveryReceipt, 'outcome' | 'selectedSource' | 'primaryFailure' | 'sourceAFailure' | 'sourceBFailure' | 'cleanup'> = { schemaVersion: 2, requestId: input.requestId, dataRoot, startupDeadlineMs, shutdownDeadlineMs, sourceA: sourceA.descriptor, sourceB: sourceB.descriptor, createdAt: new Date().toISOString() };
  let primaryFailure: string | null = null; let sourceAFailure: string | null = null; let sourceBFailure: string | null = null; let aStartAttempted = false;
  const existingRuntime = await runtime.status(dataRoot);
  if (existingRuntime.state === 'running') { const receipt: RecoveryReceipt = { ...base, outcome: 'RECONCILIATION_REQUIRED', selectedSource: null, primaryFailure: 'An unrelated runtime is already running', sourceAFailure: null, sourceBFailure: null, cleanup }; await persistRecoveryReceipt(receiptPath, intentPath, intent, receipt); throw new RuntimeError('AUTHORITY_CHANGED', 'A pre-existing runtime cannot be attributed to Source A'); }
  try {
    await assertActivationSourceIdentity(sourceA.descriptor.sourceRoot, sourceA.activationIdentity, 'Source A changed at the launch boundary');
    aStartAttempted = true;
    const statusA = await runtime.start({ dataRoot, sourceRoot: sourceA.descriptor.sourceRoot, expectedSourceIdentity: sourceA.activationIdentity, startupDeadlineMs });
    if (statusA.state === 'running' && statusA.health?.status === 'ready') { const receipt: RecoveryReceipt = { ...base, outcome: 'COMMITTED', selectedSource: 'A', primaryFailure: null, sourceAFailure: null, sourceBFailure: null, cleanup: [] }; await persistRecoveryReceipt(receiptPath, intentPath, intent, receipt); return receipt; }
    primaryFailure = statusA.reason ?? 'Source A did not reach ready health';
    sourceAFailure = primaryFailure;
  } catch (error: unknown) { primaryFailure = error instanceof Error ? error.message : String(error); sourceAFailure = primaryFailure; }
  if (aStartAttempted) {
    try { const stopped = await runtime.stop(dataRoot, shutdownDeadlineMs); if (stopped.state !== 'stopped') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Source A cleanup was not proven'); cleanup.push({ source: 'A', outcome: 'STOPPED' }); }
    catch (error: unknown) { cleanup.push({ source: 'A', outcome: 'UNRESOLVED' }); const receipt: RecoveryReceipt = { ...base, outcome: 'RECONCILIATION_REQUIRED', selectedSource: null, primaryFailure, sourceAFailure, sourceBFailure, cleanup }; await persistRecoveryReceipt(receiptPath, intentPath, intent, receipt); throw new RuntimeError('AUTHORITY_INDETERMINATE', error instanceof Error ? error.message : String(error)); }
  }
  let bStartAttempted = false;
  try {
    const reattestedB = await attestRecoverySource(sourceB.descriptor); await assertActivationSourceIdentity(reattestedB.descriptor.sourceRoot, reattestedB.activationIdentity, 'Source B changed at the launch boundary');
    bStartAttempted = true;
    const statusB = await runtime.start({ dataRoot, sourceRoot: reattestedB.descriptor.sourceRoot, expectedSourceIdentity: reattestedB.activationIdentity, startupDeadlineMs });
    if (statusB.state !== 'running' || statusB.health?.status !== 'ready') throw new RuntimeError('RUNTIME_NOT_RUNNING', statusB.reason ?? 'Source B did not reach ready health');
    const receipt: RecoveryReceipt = { ...base, outcome: 'COMMITTED', selectedSource: 'B', primaryFailure, sourceAFailure, sourceBFailure, cleanup }; await persistRecoveryReceipt(receiptPath, intentPath, intent, receipt); return receipt;
  } catch (error: unknown) {
    const failure = error instanceof Error ? error.message : String(error);
    sourceBFailure = failure;
    if (bStartAttempted) { try { const stopped = await runtime.stop(dataRoot, shutdownDeadlineMs); if (stopped.state !== 'stopped') throw new Error('Source B cleanup was not proven'); cleanup.push({ source: 'B', outcome: 'STOPPED' }); }
      catch { cleanup.push({ source: 'B', outcome: 'UNRESOLVED' }); const receipt: RecoveryReceipt = { ...base, outcome: 'RECONCILIATION_REQUIRED', selectedSource: null, primaryFailure: failure, sourceAFailure, sourceBFailure, cleanup }; await persistRecoveryReceipt(receiptPath, intentPath, intent, receipt); throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Recovery cleanup is unresolved'); } }
    const receipt: RecoveryReceipt = { ...base, outcome: 'FAILED', selectedSource: null, primaryFailure: failure, sourceAFailure, sourceBFailure, cleanup }; await persistRecoveryReceipt(receiptPath, intentPath, intent, receipt); throw error;
  }
}
async function attestRecoverySource(descriptor: RecoverySourceDescriptor): Promise<AttestedRecoverySource> {
  if (!/^[0-9a-f]{40}$/.test(descriptor.commitSha) || !/^[0-9a-f]{40}$/.test(descriptor.treeSha) || !/^[0-9a-f]{40}$/.test(descriptor.entrypointGitBlob)) throw new RuntimeError('PRECONDITION_FAILED', 'Recovery source identity is not canonical');
  const root = await realpath(descriptor.sourceRoot); const entrypoint = path.resolve(root, descriptor.entrypoint);
  if (!pathWithin(root, entrypoint)) throw new RuntimeError('PRECONDITION_FAILED', 'Recovery entrypoint escapes source root');
  const entrypointPhysical = await realpath(entrypoint); if (!pathWithin(root, entrypointPhysical)) throw new RuntimeError('PRECONDITION_FAILED', 'Recovery entrypoint symlink escapes source root');
  const metadata = await lstat(entrypointPhysical); if (!metadata.isFile()) throw new RuntimeError('PRECONDITION_FAILED', 'Recovery entrypoint is not a regular file');
  const status = (await execFileForRecovery('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim(); if (status !== '') throw new RuntimeError('PRECONDITION_FAILED', 'Recovery source is dirty or contains untracked files');
  const head = (await execFileForRecovery('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(); const tree = (await execFileForRecovery('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'])).stdout.trim();
  const committedBlob = (await execFileForRecovery('git', ['-C', root, 'rev-parse', \`HEAD:\${descriptor.entrypoint}\`])).stdout.trim();
  const physicalBlob = (await execFileForRecovery('git', ['-C', root, 'hash-object', '--', descriptor.entrypoint])).stdout.trim();
  const contentDigest = createHash('sha256').update(await readFile(entrypointPhysical)).digest('hex');
  if (head !== descriptor.commitSha || tree !== descriptor.treeSha || committedBlob !== descriptor.entrypointGitBlob || physicalBlob !== committedBlob || !/^[0-9a-f]{64}$/.test(contentDigest)) throw new RuntimeError('PRECONDITION_FAILED', 'Recovery source attestation changed');
  const activationIdentity = await inspectActivationSourceIdentity(root); if (activationIdentity.head !== head || activationIdentity.trackedModifiedCount !== 0) throw new RuntimeError('PRECONDITION_FAILED', 'Recovery source workload identity is not clean');
  return { descriptor: { ...descriptor, sourceRoot: root, entrypoint: path.relative(root, entrypointPhysical) }, activationIdentity };
}
async function canonicalReceiptPath(dataRoot: string, requested: string): Promise<string> {
  const lexical = path.resolve(requested); const parentLexical = path.dirname(lexical); const parent = await realpath(parentLexical);
  if (parent !== parentLexical || !pathWithin(dataRoot, parent)) throw new RuntimeError('PRECONDITION_FAILED', 'Recovery receipt parent is not canonical and contained');
  try { const existing = await lstat(lexical); if (existing.isSymbolicLink()) throw new RuntimeError('PRECONDITION_FAILED', 'Recovery receipt path is a symlink'); if (!existing.isFile()) throw new RuntimeError('PRECONDITION_FAILED', 'Recovery receipt path is not a regular file'); }
  catch (error: unknown) { if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error; }
  return lexical;
}
function assertRecoveryEnvelope(receipt: RecoveryReceipt, requestId: string, dataRoot: string, startupDeadlineMs: number, shutdownDeadlineMs: number, sourceA: RecoverySourceDescriptor, sourceB: RecoverySourceDescriptor): void {
  if (receipt.schemaVersion !== 2 || receipt.requestId !== requestId || receipt.dataRoot !== dataRoot || receipt.startupDeadlineMs !== startupDeadlineMs || receipt.shutdownDeadlineMs !== shutdownDeadlineMs || !exactRecoveryEnvelopeEqual(receipt, requestId, dataRoot, startupDeadlineMs, shutdownDeadlineMs, sourceA, sourceB)) throw new RuntimeError('PRECONDITION_FAILED', 'Recovery receipt envelope does not match the request');
}
function immutableContentIdentityEqual(left: RecoverySourceDescriptor, right: RecoverySourceDescriptor): boolean { return left.treeSha === right.treeSha && left.entrypoint === right.entrypoint && left.entrypointGitBlob === right.entrypointGitBlob; }
function exactRecoveryEnvelopeEqual(receipt: RecoveryReceipt, requestId: string, dataRoot: string, startupDeadlineMs: number, shutdownDeadlineMs: number, sourceA: RecoverySourceDescriptor, sourceB: RecoverySourceDescriptor): boolean {
  return receipt.schemaVersion === 2 && receipt.requestId === requestId && receipt.dataRoot === dataRoot && receipt.startupDeadlineMs === startupDeadlineMs && receipt.shutdownDeadlineMs === shutdownDeadlineMs && exactDescriptorEqual(receipt.sourceA, sourceA) && exactDescriptorEqual(receipt.sourceB, sourceB);
}
function exactDescriptorEqual(left: RecoverySourceDescriptor, right: RecoverySourceDescriptor): boolean { return left.commitSha === right.commitSha && left.treeSha === right.treeSha && left.sourceRoot === right.sourceRoot && left.entrypoint === right.entrypoint && left.entrypointGitBlob === right.entrypointGitBlob; }
async function writeDurableExclusive(filename: string, value: unknown): Promise<void> {
  const handle = await open(filename, 'wx', 0o600); try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); } await syncParentDirectory(filename);
}
async function writeDurableJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`; const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); } await rename(temporary, filename); await syncParentDirectory(filename);
}
async function syncParentDirectory(filename: string): Promise<void> { const directory = await open(path.dirname(filename), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
async function persistRecoveryReceipt(receiptPath: string, intentPath: string, intent: Record<string, unknown>, receipt: RecoveryReceipt): Promise<void> {
  await writeDurableJson(receiptPath, receipt);
  await writeDurableJson(intentPath, { ...intent, state: 'FINALIZED', outcome: receipt.outcome });
}

async function readRecoveryIntent(filename: string): Promise<{ readonly state: string; readonly outcome?: string } | null> { try { const value: unknown = JSON.parse(await readFile(filename, 'utf8')); if (!isRecord(value) || typeof value.state !== 'string') throw new RuntimeError('PERSISTENCE_FAILURE', 'Recovery intent is invalid'); return value as { readonly state: string; readonly outcome?: string }; } catch (error: unknown) { if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
async function readRecoveryReceipt(filename: string): Promise<RecoveryReceipt | null> {
  try {
    const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.requestId !== 'string' || value.requestId.length === 0 || typeof value.dataRoot !== 'string' || !path.isAbsolute(value.dataRoot) || !Number.isSafeInteger(value.startupDeadlineMs) || !Number.isSafeInteger(value.shutdownDeadlineMs) || !['COMMITTED', 'FAILED', 'RECONCILIATION_REQUIRED'].includes(String(value.outcome)) || !['A', 'B'].includes(String(value.selectedSource)) && value.selectedSource !== null || typeof value.primaryFailure !== 'string' && value.primaryFailure !== null || typeof value.sourceAFailure !== 'string' && value.sourceAFailure !== null || typeof value.sourceBFailure !== 'string' && value.sourceBFailure !== null || !Array.isArray(value.cleanup) || !isRecord(value.sourceA) || !isRecord(value.sourceB) || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) throw new RuntimeError('PERSISTENCE_FAILURE', 'Recovery receipt is invalid');
    for (const descriptor of [value.sourceA, value.sourceB]) if (!/^[0-9a-f]{40}$/.test(String(descriptor.commitSha)) || !/^[0-9a-f]{40}$/.test(String(descriptor.treeSha)) || !/^[0-9a-f]{40}$/.test(String(descriptor.entrypointGitBlob)) || typeof descriptor.sourceRoot !== 'string' || typeof descriptor.entrypoint !== 'string') throw new RuntimeError('PERSISTENCE_FAILURE', 'Recovery receipt descriptor is invalid');
    for (const item of value.cleanup) if (!isRecord(item) || !['A', 'B'].includes(String(item.source)) || !['STOPPED', 'UNRESOLVED'].includes(String(item.outcome))) throw new RuntimeError('PERSISTENCE_FAILURE', 'Recovery receipt cleanup is invalid');
    if (value.outcome === 'COMMITTED' && value.selectedSource === null || value.outcome !== 'COMMITTED' && value.selectedSource !== null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Recovery receipt outcome is inconsistent');
    return value as unknown as RecoveryReceipt;
  } catch (error: unknown) { if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function pathWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
