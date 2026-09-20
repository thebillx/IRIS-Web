import type { CapabilityEffect, CapabilityId } from '@iris/domain';
import { executionProfileEffects } from './execution-profiles.js';

export const CAPABILITY_EFFECT_ORDER = ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const satisfies readonly CapabilityEffect[];

export interface EffectDerivationContext {
  readonly operation?: string | undefined;
  readonly executionProfile?: string | undefined;
}

export interface EffectAssertionResult {
  readonly valid: boolean;
  readonly code: 'OK' | 'UNKNOWN_EFFECT' | 'EFFECT_MISMATCH';
  readonly reason: string;
  readonly expectedEffects: readonly CapabilityEffect[] | null;
}

const BASE_EFFECTS: Readonly<Record<CapabilityId, readonly CapabilityEffect[]>> = {
  'runtime.status': ['READ'],
  'project.list': ['READ'],
  'project.info': ['READ'],
  'project.git_status': ['READ', 'EXECUTE'],
  'project.search': ['READ', 'EXECUTE'],
  'ado.discovery': ['READ', 'NETWORK'],
  'ado.workitem.read': ['READ', 'NETWORK'],
  'ado.hierarchy.read': ['READ', 'NETWORK'],
  'ado.context.search': ['READ', 'NETWORK'],
  'project.test.run': ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'],
  'mission.list': ['READ'],
  'mission.get': ['READ'],
  'mission.create': ['WRITE'],
  'mission.state.set': ['WRITE'],
  'mission.task.create': ['WRITE'],
  'mission.task.state.set': ['WRITE'],
  'mission.action.prepare': ['WRITE'],
  'mission.supervisor_gate.set': ['WRITE'],
  'session.create': ['WRITE'],
  'session.delete': ['WRITE', 'DESTRUCTIVE'],
  'session.current_project.set': ['WRITE'],
  'session.instruction.submit': ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'],
  'project.register': ['WRITE'],
  'project.default.set': ['WRITE'],
  'file.read': ['READ'],
  'file.write': ['WRITE', 'DESTRUCTIVE'],
  'file.edit': ['READ', 'WRITE', 'DESTRUCTIVE'],
  'file.delete': ['WRITE', 'DESTRUCTIVE'],
  'directory.create': ['WRITE'],
  'directory.delete': ['WRITE', 'DESTRUCTIVE'],
  'workspace.list': ['READ'],
  'workspace.get': ['READ'],
  'workspace.create_scratch': ['WRITE'],
  'workspace.revoke_scratch': ['WRITE', 'DESTRUCTIVE'],
  'fs.list': ['READ'],
  'fs.stat': ['READ'],
  'fs.read': ['READ'],
  'fs.write': ['WRITE', 'DESTRUCTIVE'],
  'fs.edit': ['READ', 'WRITE', 'DESTRUCTIVE'],
  'fs.mkdir': ['WRITE'],
  'fs.delete': ['WRITE', 'DESTRUCTIVE'],
  'fs.hash': ['READ'],
  'fs.find': ['READ'],
  'artifact.stat': ['READ'],
  'artifact.open_ref': ['READ'],
  'artifact.register_existing': ['READ', 'WRITE'],
  'artifact.release': ['WRITE', 'DESTRUCTIVE'],
  'shell.run': ['EXECUTE'],
  'shell.start': ['EXECUTE'],
  'job.status': ['READ'],
  'job.logs': ['READ'],
  'job.result': ['READ'],
  'job.cancel': ['WRITE', 'EXECUTE', 'DESTRUCTIVE'],
  'code_review.start': ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'],
  'code_review.status': ['READ'],
  'code_review.result': ['READ', 'WRITE'],
  'project.command.run': ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'],
  'project.validation.discover': ['READ'],
  'project.validation.start': ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'],
  'project.validation.job.read': ['READ'],
  'git.status': ['READ', 'EXECUTE'],
  'git.head': ['READ', 'EXECUTE'],
  'git.diff': ['READ', 'EXECUTE'],
  'git.log': ['READ', 'EXECUTE'],
  'git.show': ['READ', 'EXECUTE'],
  'git.cat_file': ['READ', 'EXECUTE'],
  'git.merge_base': ['READ', 'EXECUTE'],
  'git.ancestry': ['READ', 'EXECUTE'],
  'git.refs': ['READ', 'EXECUTE'],
  'git.branch_list': ['READ', 'EXECUTE'],
  'git.worktree_list': ['READ', 'EXECUTE'],
  'git.branch_create': ['READ', 'WRITE', 'EXECUTE'],
  'git.worktree_add': ['READ', 'WRITE', 'EXECUTE'],
  'git.worktree_remove': ['READ', 'WRITE', 'EXECUTE', 'DESTRUCTIVE'],
  'git.add': ['READ', 'WRITE', 'EXECUTE'],
  'git.commit': ['READ', 'WRITE', 'EXECUTE'],
  'git.fetch': ['READ', 'WRITE', 'EXECUTE', 'NETWORK'],
  'git.push': ['READ', 'WRITE', 'EXECUTE', 'NETWORK'],
  'git.local': ['READ', 'WRITE', 'EXECUTE', 'DESTRUCTIVE'],
  'runtime.lifecycle': ['READ', 'WRITE', 'EXECUTE', 'DESTRUCTIVE'],
  'web.lifecycle': ['READ', 'WRITE', 'EXECUTE', 'DESTRUCTIVE'],
  'package.project': ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'],
  'policy.mode.set': ['WRITE'],
  'credential.mutate': ['WRITE', 'DESTRUCTIVE'],
  'remote.publish': ['READ', 'WRITE', 'EXECUTE', 'NETWORK'],
  'system.sudo': ['WRITE', 'EXECUTE', 'DESTRUCTIVE'],
};

const GIT_READ_OPERATIONS = new Set(['status', 'head', 'diff', 'diff-check', 'diff-name-only']);
const GIT_WRITE_OPERATIONS = new Set(['add', 'commit']);

export function deriveCapabilityEffects(capabilityId: string, context: EffectDerivationContext = {}): readonly CapabilityEffect[] | null {
  if (!Object.prototype.hasOwnProperty.call(BASE_EFFECTS, capabilityId)) return null;
  if (capabilityId === 'git.local') {
    if (context.operation === undefined) return canonicalEffects(BASE_EFFECTS['git.local']);
    if (GIT_READ_OPERATIONS.has(context.operation)) return canonicalEffects(['READ', 'EXECUTE']);
    if (GIT_WRITE_OPERATIONS.has(context.operation)) return canonicalEffects(['READ', 'WRITE', 'EXECUTE']);
    return null;
  }
  if (capabilityId === 'fs.write') {
    if (context.operation === 'CREATE' || context.operation === 'APPEND') return canonicalEffects(['WRITE']);
    if (context.operation === 'REPLACE') return canonicalEffects(['WRITE', 'DESTRUCTIVE']);
    return null;
  }
  if (capabilityId === 'shell.run' || capabilityId === 'shell.start') {
    if (context.executionProfile === undefined) return null;
    const envelope = executionProfileEffects(context.executionProfile);
    if (envelope === null || !envelope.includes('EXECUTE')) return null;
    return canonicalEffects(envelope);
  }
  return canonicalEffects(BASE_EFFECTS[capabilityId as CapabilityId]);
}

export function assertExpectedEffects(
  effectiveEffects: readonly CapabilityEffect[],
  expectedEffects: readonly string[] | undefined,
): EffectAssertionResult {
  if (expectedEffects === undefined) {
    return { valid: true, code: 'OK', reason: 'Legacy caller supplied no expectedEffects assertion', expectedEffects: null };
  }
  const normalized: CapabilityEffect[] = [];
  for (const effect of expectedEffects) {
    if (!isCapabilityEffect(effect)) {
      return { valid: false, code: 'UNKNOWN_EFFECT', reason: `UNKNOWN_EFFECT: unsupported expected effect ${JSON.stringify(effect)}`, expectedEffects: null };
    }
    if (!normalized.includes(effect)) normalized.push(effect);
  }
  const canonicalExpected = canonicalEffects(normalized);
  const missing = effectiveEffects.filter((effect) => !canonicalExpected.includes(effect));
  if (missing.length > 0) {
    return {
      valid: false,
      code: 'EFFECT_MISMATCH',
      reason: `EFFECT_MISMATCH: server-derived effects exceed expectedEffects: ${missing.join(',')}`,
      expectedEffects: canonicalExpected,
    };
  }
  return { valid: true, code: 'OK', reason: 'expectedEffects covers the server-derived effect set', expectedEffects: canonicalExpected };
}

export function canonicalEffects(effects: readonly CapabilityEffect[]): readonly CapabilityEffect[] {
  const present = new Set(effects);
  return CAPABILITY_EFFECT_ORDER.filter((effect) => present.has(effect));
}

export function isCapabilityEffect(value: unknown): value is CapabilityEffect {
  return value === 'READ' || value === 'WRITE' || value === 'EXECUTE' || value === 'NETWORK' || value === 'DESTRUCTIVE';
}
