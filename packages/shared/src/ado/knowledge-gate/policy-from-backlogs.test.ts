import { describe, expect, it } from 'vitest';
import { gatePolicyFromBacklogs } from './policy-from-backlogs.js';

describe('discovered backlog policy', () => {
  it('derives rules from provider backlog type rather than hardcoded work item names', () => {
    const policy = gatePolicyFromBacklogs([
      { id: 'strategy', rank: 4, type: 'portfolio', workItemTypes: ['Outcome'] },
      { id: 'delivery', rank: 2, type: 'requirement', workItemTypes: ['Request', 'Issue'] },
      { id: 'task', rank: 0, type: 'task', workItemTypes: ['Work'] },
    ]);
    expect(policy.types.outcome).toEqual({ defaultStatus: 'CONTEXT_ONLY', allowSemanticPromotion: true, container: true });
    expect(policy.types.request).toEqual({ defaultStatus: 'REJECTED', allowSemanticPromotion: true, container: false });
    expect(policy.types.issue).toEqual(policy.types.request);
    expect(policy.types.work).toEqual({ defaultStatus: 'REJECTED', allowSemanticPromotion: false, container: false });
    expect(policy.types['user story']).toBeUndefined();
  });

  it('normalizes discovered type keys without changing the source catalog', () => {
    const input = [{ id: 'delivery', rank: 2, type: 'requirement' as const, workItemTypes: [' Custom Request '] }];
    const policy = gatePolicyFromBacklogs(input, 'board-policy/7');
    expect(policy.version).toBe('board-policy/7');
    expect(policy.types['custom request']).toBeDefined();
    expect(input[0]!.workItemTypes[0]).toBe(' Custom Request ');
  });

  it('fails closed on duplicate membership across backlog levels', () => {
    expect(() => gatePolicyFromBacklogs([
      { id: 'portfolio', rank: 3, type: 'portfolio', workItemTypes: ['Issue'] },
      { id: 'requirement', rank: 2, type: 'requirement', workItemTypes: ['issue'] },
    ])).toThrow('more than one');
  });

  it('rejects incomplete provider metadata', () => {
    expect(() => gatePolicyFromBacklogs([])).toThrow();
    expect(() => gatePolicyFromBacklogs([{ id: '', rank: 0, type: 'task', workItemTypes: ['Work'] }])).toThrow();
    expect(() => gatePolicyFromBacklogs([{ id: 'x', rank: 0, type: 'unknown' as 'task', workItemTypes: ['Work'] }])).toThrow();
    expect(() => gatePolicyFromBacklogs([{ id: 'x', rank: 0, type: 'task', workItemTypes: [] }])).toThrow();
  });
});
