import { describe, expect, it } from 'vitest';
import { stageRawSource } from '@iris/ado';
import type { SemanticClassifier } from '@iris/shared/ado/knowledge-gate';
import type { Backlog, BoardIdentity } from './ado/discovery.js';
import { bridgeCanonicalStageToKnowledge } from './ado-knowledge-bridge.js';
import { classifyCanonicalKnowledge, policyVersionForBacklogs, toGateSourceRecord } from './ado-knowledge-gate-bridge.js';

const identity: BoardIdentity = {
  organization: { id: 'org-1', name: 'Example Org' },
  project: { id: 'project-1', name: 'Example Project' },
  team: { id: 'team-1', name: 'Delivery Team' },
  board: { id: 'board-1', name: 'Delivery Board' },
};

const backlogs: readonly Backlog[] = [
  { id: 'task', name: 'Execution', rank: 0, type: 'task', workItemTypes: ['Work'] },
  { id: 'delivery', name: 'Delivery', rank: 2, type: 'requirement', workItemTypes: ['Request', 'Issue'] },
  { id: 'strategy', name: 'Strategy', rank: 4, type: 'portfolio', workItemTypes: ['Outcome'] },
];

function candidate(type = 'Request', description = 'The system must export only the records selected by the user.', acceptanceCriteria = 'Only selected records appear in the export.') {
  return bridgeCanonicalStageToKnowledge(stageRawSource(JSON.stringify({
    id: type === 'Outcome' ? 200 : type === 'Work' ? 300 : 101,
    rev: 7,
    fields: {
      'System.WorkItemType': type,
      'System.Title': `${type} behavior`,
      'System.Description': description,
      'Microsoft.VSTS.Common.AcceptanceCriteria': acceptanceCriteria,
      'System.ChangedDate': '2026-09-19T12:34:56.123Z',
    },
  })), identity);
}

const semantic: SemanticClassifier = {
  classify(record) {
    return {
      verdict: 'VALIDATED',
      reusable: true,
      category: 'FUNCTIONAL_BEHAVIOR',
      quotes: [{ field: 'description', text: record.description }],
    };
  },
};

describe('ADO canonical knowledge gate bridge', () => {
  it('builds policy only from provider-discovered backlog types and work item types', () => {
    const version = policyVersionForBacklogs(backlogs);
    expect(version).toMatch(/^ado-discovered-backlogs\/v1:[a-f0-9]{64}$/);
    expect(policyVersionForBacklogs([...backlogs].reverse())).toBe(version);
    expect(policyVersionForBacklogs(backlogs.map(backlog => backlog.id === 'delivery'
      ? { ...backlog, workItemTypes: ['Custom Request'] }
      : backlog))).not.toBe(version);
  });

  it('never promotes a requirement candidate without semantic validation', () => {
    const result = classifyCanonicalKnowledge(candidate(), backlogs);
    expect(result.status).toBe('REJECTED');
    expect(result.reasonCodes).toContain('SEMANTIC_VALIDATION_REQUIRED');
  });

  it('promotes a discovered requirement type only with source-grounded semantic evidence', () => {
    const result = classifyCanonicalKnowledge(candidate('Request'), backlogs, semantic);
    expect(result.status).toBe('PROMOTED');
    expect(result.policyVersion).toBe(policyVersionForBacklogs(backlogs));
    expect(result.semanticEvidence?.quotes[0]?.text).toContain('export only');
  });

  it('keeps provider task-backlog types non-promotable even when a semantic classifier says reusable', () => {
    const result = classifyCanonicalKnowledge(candidate('Work'), backlogs, semantic);
    expect(result.status).toBe('REJECTED');
    expect(result.reasonCodes).toContain('TYPE_POLICY');
  });

  it('uses explicit same-scope child substance for thin portfolio context', () => {
    const parent = candidate('Outcome', '', '');
    const child = candidate('Request');
    const record = toGateSourceRecord(parent, [{ candidate: child, substantive: true }]);
    expect(record.children[0]?.substantive).toBe(true);
    const result = classifyCanonicalKnowledge(parent, backlogs, undefined, [{ candidate: child, substantive: true }]);
    expect(result.status).toBe('CONTEXT_ONLY');
    expect(result.reasonCodes).toContain('CONTAINER_WITH_SUBSTANTIVE_CHILDREN');
  });

  it('rejects custom types that were not present in the discovered backlog catalog', () => {
    const result = classifyCanonicalKnowledge(candidate('Undiscovered Type'), backlogs, semantic);
    expect(result.status).toBe('REJECTED');
    expect(result.reasonCodes).toContain('UNKNOWN_WORK_ITEM_TYPE');
  });

  it('does not allow child evidence to cross the authorized board scope', () => {
    const parent = candidate('Outcome', '', '');
    const child = candidate('Request');
    const foreign = {
      ...child,
      item: { ...child.item, scopeId: 'ado-board:'.concat('0'.repeat(64)) },
    };
    expect(() => toGateSourceRecord(parent, [{ candidate: foreign, substantive: true }])).toThrow('crosses authorized ADO scope');
  });
});
