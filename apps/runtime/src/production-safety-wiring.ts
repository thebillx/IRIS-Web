import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { SafetyWriterName, TrustedWriterVerification, TrustedWriterVerifier } from './production-safety.js';
import { inspectPrivateRegularFile, privateDirectoryProblem } from './private-fs.js';
import { observeProcessStart } from './macos-safety.js';
import { validateLifecycleRecord } from './durable-mission-validation.js';
import type { DurableMissionLifecycleSnapshot } from './durable-mission-lifecycle.js';
import { validateMultiWorkerDocument } from './multi-worker/validation.js';
import { validateSecurityAuditDocument } from './security-audit/validation.js';
import { inspectDurableRunnerEvidence } from './durable-job-manager.js';

type WriterBinding = readonly string[];

/** Canonical stores and process journals covered by the runtime safety fence. */
const WRITER_BINDINGS: Readonly<Record<SafetyWriterName, WriterBinding>> = {
  'runtime-state': ['state.json'],
  'mission-state': ['missions.json', 'mission-archive'],
  'mission-broker': ['mission-broker.json'],
  'durable-jobs': ['vnext-jobs.json', 'vnext-job-runtime'],
  'mission-lifecycle': ['mission-lifecycle.json', 'mission-lifecycle-archive'],
  'multi-worker': ['multi-worker-orchestration.json'],
  'security-audit': ['security-audit-engine.json'],
  'resource-registry': ['vnext-resources.json', 'vnext-registry-reconciliation.json', 'vnext-registry-mutation.lock'],
  'permission-store': ['permissions.json'],
  'permission-audit': ['audit.jsonl'],
  'activation': ['supervisor/activation-transactions.json'],
  'supervisor': ['supervisor/state.json', 'supervisor/operation.lock'],
  'external-runners': ['vnext-jobs.json', 'vnext-job-runtime'],
};

const ACTIVE_STATES = new Set(['ACTIVE', 'RUNNING', 'QUEUED', 'STARTING', 'PREPARED', 'APPLYING', 'ROLLBACK_IN_PROGRESS']);

export function runtimeWriterBindings(): Readonly<Record<SafetyWriterName, WriterBinding>> { return WRITER_BINDINGS; }

/** Build the daemon's trusted, identity-bound writer verifier. */
export function createRuntimeWriterVerifier(dataRootInput: string, supervisorStartupId?: string): TrustedWriterVerifier {
  const dataRoot = path.resolve(dataRootInput);
  return {
    verify: async (writer, identity, context) => {
      if (path.resolve(identity.dataRoot) !== dataRoot) return null;
      const status = await inspectBinding(dataRoot, writer, WRITER_BINDINGS[writer], supervisorStartupId);
      if (status === null) return null;
      return {
        state: status.active === 0 ? 'IDLE' : 'ACTIVE',
        inFlight: status.active,
        runtimeId: identity.runtimeId,
        instanceId: identity.instanceId,
        dataRoot,
        fenceEpoch: context.fenceEpoch,
        generation: context.generation,
      } satisfies TrustedWriterVerification;
    },
  };
}

async function inspectBinding(dataRoot: string, writer: SafetyWriterName, binding: WriterBinding, supervisorStartupId?: string): Promise<{ readonly active: number } | null> {
  if (writer === 'supervisor') return inspectSupervisorBinding(dataRoot, supervisorStartupId);
  if (writer === 'external-runners') return inspectDurableRunnerEvidence(dataRoot);
  let active = 0;
  for (const relative of binding) {
    const filename = path.join(dataRoot, relative);
    const metadata = await lstat(filename).catch((error: unknown) => isNotFound(error) ? null : undefined);
    if (metadata === undefined) return null;
    if (metadata === null) continue;
    if (metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) return null;
    if (metadata.isDirectory()) {
      if (await privateDirectoryProblem(filename, `${writer} writer directory`) !== null) return null;
      const entries = await readdir(filename).catch(() => null);
      if (entries === null) return null;
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) return null;
    if (relative === 'audit.jsonl') {
      const inspected = await inspectPrivateRegularFile(filename, `${writer} writer store`);
      if (inspected.state === 'missing') continue;
      if (inspected.state === 'invalid') return null;
      for (const line of inspected.content.split('\n')) {
        if (line.trim().length === 0) continue;
        try { JSON.parse(line); } catch { return null; }
      }
      continue;
    }
    if (relative.endsWith('.lock')) {
      const lock = await readJsonIfPrivate(filename);
      if (lock.state === 'missing') continue;
      if (lock.state === 'invalid' || !isRecord(lock.value) || !Number.isSafeInteger(lock.value.pid) || typeof lock.value.processStartMarker !== 'string') return null;
      const observed = observeProcessStart(lock.value.pid as number);
      if (observed.state === 'indeterminate') return null;
      if (observed.state === 'live' && observed.marker === lock.value.processStartMarker) active += 1;
      else if (observed.state === 'live') return null;
      continue;
    }
    const document = await readJsonIfPrivate(filename);
    if (document.state === 'invalid') return null;
    if (document.state === 'ok') {
      try {
        if (writer === 'mission-lifecycle') {
          if (!isRecord(document.value) || document.value.schemaVersion !== 1 || !Array.isArray(document.value.records)
            || document.value.records.length > 100) return null;
          const records = document.value.records.map((record) => validateLifecycleRecord(record as DurableMissionLifecycleSnapshot));
          if (new Set(records.map((record) => record.missionId)).size !== records.length) return null;
        } else if (writer === 'multi-worker') validateMultiWorkerDocument(document.value);
        else if (writer === 'security-audit') validateSecurityAuditDocument(document.value);
      } catch { return null; }
      active += countActiveStates(document.value);
    }
  }
  return { active };
}

async function inspectSupervisorBinding(dataRoot: string, startupIdInput?: string): Promise<{ readonly active: number } | null> {
  const state = await readJsonIfPrivate(path.join(dataRoot, 'supervisor', 'state.json'));
  const lock = await readJsonIfPrivate(path.join(dataRoot, 'supervisor', 'operation.lock'));
  if (state.state === 'invalid' || lock.state === 'invalid') return null;
  const activeStates = state.state === 'ok' ? countActiveStates(state.value) : 0;
  let lockActive = 0;
  let lockValue: Record<string, unknown> | undefined;
  if (lock.state === 'ok') {
    if (!isRecord(lock.value) || lock.value.schemaVersion !== 1 || !Number.isSafeInteger(lock.value.pid)
      || typeof lock.value.processStartMarker !== 'string' || typeof lock.value.operation !== 'string') return null;
    const observed = observeProcessStart(lock.value.pid as number);
    if (observed.state === 'indeterminate') return null;
    if (observed.state === 'live' && observed.marker !== lock.value.processStartMarker) return null;
    if (observed.state === 'live') {
      lockActive = 1;
      lockValue = lock.value;
    }
  }
  const active = activeStates + lockActive;
  if (active === 0) return { active: 0 };
  const startupId = startupIdInput?.trim();
  if (startupId === undefined || !/^[\da-f-]{36}$/.test(startupId) || state.state !== 'ok' || lockValue === undefined) return null;
  const operations = isRecord(state.value) && Array.isArray(state.value.startupOperations) ? state.value.startupOperations : [];
  const startup = operations.find((entry) => isRecord(entry) && entry.id === startupId);
  if (!isRecord(startup)
    || !['runtime', 'runtime-probe'].includes(startup.component as string)
    || !['PREPARED', 'SPAWNING', 'OWNERSHIP_VERIFIED'].includes(startup.state as string)
    || startup.dataRoot !== dataRoot
    || !Number.isSafeInteger(startup.supervisorPid)
    || typeof startup.supervisorStartMarker !== 'string'
    || startup.supervisorPid !== lockValue.pid
    || startup.supervisorStartMarker !== lockValue.processStartMarker
    || !['up', 'restart', 'runtime-on', 'runtime-restart', 'automatic-recovery', 'replace-workload-source'].includes(lockValue.operation as string)) return null;
  if (startup.pid !== null && startup.pid !== undefined) {
    const current = observeProcessStart(process.pid);
    if (current.state !== 'live' || startup.pid !== process.pid || startup.processStartMarker !== current.marker) return null;
  }
  return { active };
}

async function readJsonIfPrivate(filename: string): Promise<{ readonly state: 'missing' } | { readonly state: 'invalid' } | { readonly state: 'ok'; readonly value: unknown }> {
  const inspected = await inspectPrivateRegularFile(filename, 'Safety writer store');
  if (inspected.state === 'missing') return { state: 'missing' };
  if (inspected.state === 'invalid') return { state: 'invalid' };
  try { return { state: 'ok', value: JSON.parse(inspected.content) as unknown }; } catch { return { state: 'invalid' }; }
}

function countActiveStates(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countActiveStates(item), 0);
  if (!isRecord(value)) return 0;
  const own = typeof value.state === 'string' && ACTIVE_STATES.has(value.state) ? 1 : 0;
  return own + Object.entries(value).reduce((sum, [key, item]) => key === 'state' ? sum : sum + countActiveStates(item), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'; }
