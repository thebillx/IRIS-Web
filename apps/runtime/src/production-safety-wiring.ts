import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { SafetyIdentity, SafetyWriterName, TrustedWriterVerification, TrustedWriterVerifier } from './production-safety.js';
import { inspectPrivateRegularFile, privateDirectoryProblem } from './private-fs.js';
import { observeProcessStart } from './macos-safety.js';

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
export function createRuntimeWriterVerifier(dataRootInput: string): TrustedWriterVerifier {
  const dataRoot = path.resolve(dataRootInput);
  return {
    verify: async (writer, identity, context) => {
      if (path.resolve(identity.dataRoot) !== dataRoot) return null;
      const status = await inspectBinding(dataRoot, writer, WRITER_BINDINGS[writer]);
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

async function inspectBinding(dataRoot: string, writer: SafetyWriterName, binding: WriterBinding): Promise<{ readonly active: number } | null> {
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
      if (writer === 'external-runners' && entries.length > 0) {
        for (const entry of entries) {
          const claim = await readJsonIfPrivate(path.join(filename, entry, 'claim.json'));
          const result = await readJsonIfPrivate(path.join(filename, entry, 'result.json'));
          if (claim.state === 'invalid' || result.state === 'invalid') return null;
          if (claim.state === 'missing' && result.state === 'missing') return null;
          if (claim.state === 'ok' && result.state === 'missing') active += 1;
        }
      }
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) return null;
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
    if (document.state === 'ok') active += countActiveStates(document.value);
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
