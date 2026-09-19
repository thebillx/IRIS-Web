import type { GatePolicy, TypeRule } from './models.js';

export type DiscoveredBacklogType = 'portfolio' | 'requirement' | 'task';
export interface DiscoveredBacklogPolicyInput {
  readonly id: string;
  readonly rank: number;
  readonly type: DiscoveredBacklogType;
  readonly workItemTypes: readonly string[];
}

export function gatePolicyFromBacklogs(
  backlogs: readonly DiscoveredBacklogPolicyInput[],
  version = 'ado-discovered-backlogs/v1',
): GatePolicy {
  if (typeof version !== 'string' || version.trim().length === 0 || version.length > 200
    || !Array.isArray(backlogs) || backlogs.length === 0 || backlogs.length > 100) {
    throw new Error('Invalid discovered backlog policy input');
  }
  const types: Record<string, TypeRule> = {};
  for (const backlog of backlogs) {
    if (!backlog || typeof backlog.id !== 'string' || backlog.id.trim().length === 0
      || !Number.isSafeInteger(backlog.rank) || backlog.rank < 0
      || !['portfolio', 'requirement', 'task'].includes(backlog.type)
      || !Array.isArray(backlog.workItemTypes) || backlog.workItemTypes.length === 0 || backlog.workItemTypes.length > 100) {
      throw new Error('Invalid discovered backlog policy input');
    }
    const rule: TypeRule = backlog.type === 'portfolio'
      ? { defaultStatus: 'CONTEXT_ONLY', allowSemanticPromotion: true, container: true }
      : backlog.type === 'requirement'
        ? { defaultStatus: 'REJECTED', allowSemanticPromotion: true, container: false }
        : { defaultStatus: 'REJECTED', allowSemanticPromotion: false, container: false };
    for (const sourceType of backlog.workItemTypes) {
      if (typeof sourceType !== 'string' || sourceType.trim().length === 0 || sourceType.length > 256) {
        throw new Error('Invalid discovered work item type');
      }
      const key = sourceType.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(types, key)) {
        throw new Error('Work item type belongs to more than one discovered backlog level');
      }
      types[key] = Object.freeze({ ...rule });
    }
  }
  return Object.freeze({ version: version.trim(), types: Object.freeze(types) });
}
