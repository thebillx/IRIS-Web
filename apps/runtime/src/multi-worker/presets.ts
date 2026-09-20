import {
  RuntimeError,
  type CapabilityId,
  type WorkerConcurrencyPolicy,
  type WorkerResourceBudget,
} from '@iris/domain';

export type WorkerPresetRole = 'CODE' | 'QA' | 'RESEARCH' | 'DOCS';

export interface WorkerPresetAuthorityBounds {
  readonly allowedCapabilities: readonly CapabilityId[];
  readonly allowedPaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
  readonly mutablePaths: readonly string[];
  readonly allowedProcesses: readonly string[];
  readonly approvalPolicy: 'INHERIT_MISSION' | 'OWNER_REQUIRED';
  readonly resourceBudget: WorkerResourceBudget;
  readonly concurrencyPolicy: WorkerConcurrencyPolicy;
}

export interface WorkerPreset {
  readonly role: WorkerPresetRole;
  readonly capabilityAllowlist: readonly CapabilityId[];
  readonly processAllowlist: readonly string[];
  readonly maxResourceBudget: WorkerResourceBudget;
  readonly maxConcurrency: number;
  readonly allowParallelReads: boolean;
  readonly mutationMode: 'READ_ONLY_V1';
}

const READ_ONLY_V1_CAPABILITIES = [
  'project.search',
  'fs.list',
  'fs.stat',
  'fs.read',
  'fs.hash',
  'fs.find',
] as const satisfies readonly CapabilityId[];

const PRESETS: Readonly<Record<WorkerPresetRole, WorkerPreset>> = Object.freeze({
  CODE: Object.freeze({
    role: 'CODE',
    capabilityAllowlist: READ_ONLY_V1_CAPABILITIES,
    processAllowlist: [],
    maxResourceBudget: Object.freeze({
      maxRuntimeMs: 30 * 60_000,
      maxJobs: 0,
      maxArtifacts: 32,
      maxOutputBytes: 16 * 1024 * 1024,
    }),
    maxConcurrency: 2,
    allowParallelReads: true,
    mutationMode: 'READ_ONLY_V1',
  }),
  QA: Object.freeze({
    role: 'QA',
    capabilityAllowlist: READ_ONLY_V1_CAPABILITIES,
    processAllowlist: [],
    maxResourceBudget: Object.freeze({
      maxRuntimeMs: 30 * 60_000,
      maxJobs: 0,
      maxArtifacts: 64,
      maxOutputBytes: 16 * 1024 * 1024,
    }),
    maxConcurrency: 4,
    allowParallelReads: true,
    mutationMode: 'READ_ONLY_V1',
  }),
  RESEARCH: Object.freeze({
    role: 'RESEARCH',
    capabilityAllowlist: READ_ONLY_V1_CAPABILITIES,
    processAllowlist: [],
    maxResourceBudget: Object.freeze({
      maxRuntimeMs: 20 * 60_000,
      maxJobs: 0,
      maxArtifacts: 32,
      maxOutputBytes: 12 * 1024 * 1024,
    }),
    maxConcurrency: 4,
    allowParallelReads: true,
    mutationMode: 'READ_ONLY_V1',
  }),
  DOCS: Object.freeze({
    role: 'DOCS',
    capabilityAllowlist: READ_ONLY_V1_CAPABILITIES,
    processAllowlist: [],
    maxResourceBudget: Object.freeze({
      maxRuntimeMs: 20 * 60_000,
      maxJobs: 0,
      maxArtifacts: 32,
      maxOutputBytes: 12 * 1024 * 1024,
    }),
    maxConcurrency: 2,
    allowParallelReads: true,
    mutationMode: 'READ_ONLY_V1',
  }),
});

/**
 * V1 role presets are convenience defaults only. They never create authority.
 *
 * Effective authority is always a strict subset of the caller-supplied authoritative parent bounds:
 * - capabilities and processes are intersected;
 * - path grants are inherited exactly rather than broadened;
 * - mutable paths/process execution are intentionally removed in V1;
 * - resource/concurrency budgets are clamped downward;
 * - OWNER_REQUIRED can never be weakened.
 */
export function applyWorkerPreset(
  roleInput: string,
  parent: WorkerPresetAuthorityBounds,
): WorkerPresetAuthorityBounds {
  const preset = workerPreset(roleInput);
  const capabilityAllowlist = new Set<CapabilityId>(preset.capabilityAllowlist);
  const processAllowlist = new Set(preset.processAllowlist);

  return Object.freeze({
    allowedCapabilities: Object.freeze(parent.allowedCapabilities.filter((capability) => capabilityAllowlist.has(capability))),
    allowedPaths: Object.freeze([...parent.allowedPaths]),
    readOnlyPaths: Object.freeze([...parent.readOnlyPaths]),
    mutablePaths: Object.freeze([]),
    allowedProcesses: Object.freeze(parent.allowedProcesses.filter((profile) => processAllowlist.has(profile))),
    approvalPolicy: parent.approvalPolicy,
    resourceBudget: Object.freeze({
      maxRuntimeMs: Math.min(parent.resourceBudget.maxRuntimeMs, preset.maxResourceBudget.maxRuntimeMs),
      maxJobs: Math.min(parent.resourceBudget.maxJobs, preset.maxResourceBudget.maxJobs),
      maxArtifacts: Math.min(parent.resourceBudget.maxArtifacts, preset.maxResourceBudget.maxArtifacts),
      maxOutputBytes: Math.min(parent.resourceBudget.maxOutputBytes, preset.maxResourceBudget.maxOutputBytes),
    }),
    concurrencyPolicy: Object.freeze({
      maxParallelCapabilities: Math.min(parent.concurrencyPolicy.maxParallelCapabilities, preset.maxConcurrency),
      mutablePathOwnership: 'READ_ONLY',
      allowParallelReads: parent.concurrencyPolicy.allowParallelReads && preset.allowParallelReads,
    }),
  });
}

export function workerPreset(roleInput: string): WorkerPreset {
  if (roleInput !== 'CODE' && roleInput !== 'QA' && roleInput !== 'RESEARCH' && roleInput !== 'DOCS') {
    throw new RuntimeError('INVALID_REQUEST', 'Worker preset role is invalid');
  }
  return PRESETS[roleInput];
}
