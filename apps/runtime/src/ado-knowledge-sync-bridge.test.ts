import { describe, expect, it } from 'vitest';
import { stageRawSource } from '@iris/ado';
import type { Classification } from '@iris/shared/ado/knowledge-gate';
import type { BoardIdentity } from './ado/discovery.js';
import { bridgeCanonicalStageToKnowledge } from './ado-knowledge-bridge.js';
import { gateDecisionFromClassification, knowledgeEnvelope, toSyncMembership, toSyncObservation } from './ado-knowledge-sync-bridge.js';
import { canonical, hash } from './ado/m6/model.js';

const identity: BoardIdentity = {
  organization: { id: 'org-1', name: 'Example Org' },
  project: { id: 'project-1', name: 'Example Project' },
  team: { id: 'team-1', name: 'Delivery Team' },
  board: { id: 'board-1', name: 'Delivery Board' },
};

function source() {
  return stageRawSource(JSON.stringify({
    id: 101,
    rev: 7,
    fields: {
      'System.WorkItemType': 'Request',
      'System.Title': 'Export selected results',
      'System.Description': '<p>The system exports only selected records.</p>',
      'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>Only selected records appear.</p>',
      'System.Parent': 100,
      'System.ChangedDate': '2026-09-19T12:34:56.1234567Z',
    },
    secretAuditOnly: 'must-not-enter-sync-content',
  }));
}

const evidence = {
  expectedCommentIds: ['comment-1'],
  commentsComplete: true,
  comments: [{ id: 'comment-1', text: 'Synthetic comment' }],
  relationsComplete: true,
  relations: [{ id: 'relation-1', kind: 'related', targetItemId: 102 }],
  linksComplete: true,
  links: [{ id: 'link-1', evidenceRef: 'evidence-1' }],
} as const;

const classification: Classification = {
  status: 'PROMOTED',
  reasonCodes: ['REUSABLE_KNOWLEDGE_VALIDATED'],
  signals: [{ code: 'EXPLICIT_PRODUCT_BEHAVIOR', weight: 35, evidence: 'source quote' }],
  score: 85,
  policyVersion: 'ado-discovered-backlogs/v1:'.concat('a'.repeat(64)),
  category: 'FUNCTIONAL_BEHAVIOR',
  semanticEvidence: {
    verdict: 'VALIDATED',
    reusable: true,
    category: 'FUNCTIONAL_BEHAVIOR',
    quotes: [{ field: 'description', text: 'The system exports only selected records.' }],
  },
  sourceReferences: [{ source: 'ado-board:fixture', id: '101', revision: '7' }],
};

describe('ADO M5 to M6 sync bridge', () => {
  it('persists only canonical field facts, never raw audit payload', () => {
    const stage = source();
    const candidate = bridgeCanonicalStageToKnowledge(stage, identity);
    const envelope = knowledgeEnvelope(stage, candidate);
    const serialized = canonical(envelope);
    expect(serialized).not.toContain('secretAuditOnly');
    expect(serialized).not.toContain('rawAudit');
    expect(envelope.workItemId).toBe('101');
    expect(envelope.revision).toBe(7);
    expect(envelope.facts.some(fact => fact.field === 'acceptanceCriteria')).toBe(true);
  });

  it('builds membership from canonical parent plus discovered backlog IDs', () => {
    expect(toSyncMembership(source(), ['delivery', 'strategy'])).toEqual({
      itemId: 101,
      parentId: 100,
      backlogIds: ['delivery', 'strategy'],
    });
  });

  it('requires explicit attachment completeness and preserves canonical changed time', () => {
    const stage = source();
    const candidate = bridgeCanonicalStageToKnowledge(stage, identity);
    const observation = toSyncObservation(stage, candidate, evidence);
    expect(observation.changedAt).toBe('2026-09-19T12:34:56.123Z');
    expect(observation.commentsComplete).toBe(true);
    expect(observation.relationsComplete).toBe(true);
    expect(observation.linksComplete).toBe(true);
    expect(observation.expectedCommentIds).toEqual(['comment-1']);
  });

  it('fails closed when M3 and M4 source identities do not match', () => {
    const stage = source();
    const candidate = bridgeCanonicalStageToKnowledge(stage, identity);
    expect(() => knowledgeEnvelope(stage, {
      ...candidate,
      item: { ...candidate.item, workItemId: '999' },
    })).toThrow('source identity mismatch');
  });

  it('binds the full gate classification to the source fingerprint and policy version', () => {
    const fingerprint = hash('source-fingerprint');
    const decision = gateDecisionFromClassification(101, fingerprint, classification);
    expect(decision).toMatchObject({
      itemId: 101,
      fingerprint,
      gateVersion: classification.policyVersion,
      disposition: 'PROMOTED',
      reasonCode: 'REUSABLE_KNOWLEDGE_VALIDATED',
      category: 'FUNCTIONAL_BEHAVIOR',
    });
    expect(decision.classificationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(gateDecisionFromClassification(101, fingerprint, structuredClone(classification)).classificationDigest)
      .toBe(decision.classificationDigest);
  });

  it('changes the classification digest when semantic evidence changes', () => {
    const fingerprint = hash('source-fingerprint');
    const baseline = gateDecisionFromClassification(101, fingerprint, classification);
    const changed = gateDecisionFromClassification(101, fingerprint, {
      ...classification,
      score: 86,
    });
    expect(changed.classificationDigest).not.toBe(baseline.classificationDigest);
  });
});
