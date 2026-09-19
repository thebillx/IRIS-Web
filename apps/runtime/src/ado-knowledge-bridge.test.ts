import { describe, expect, it } from 'vitest';
import { stageRawSource } from '@iris/ado';
import { adoKnowledgeScopeId, bridgeCanonicalStageToKnowledge } from './ado-knowledge-bridge.js';
import type { BoardIdentity } from './ado/discovery.js';

const identity: BoardIdentity = {
  organization: { id: 'org-1', name: 'Example Org' },
  project: { id: 'project-1', name: 'Example Project' },
  team: { id: 'team-1', name: 'Delivery Team' },
  board: { id: 'board-1', name: 'Delivery Board' },
};

function stage(changedDate = '2026-09-19T12:34:56.1234567Z') {
  return stageRawSource(JSON.stringify({
    id: 101,
    rev: 7,
    fields: {
      'System.WorkItemType': 'Story',
      'System.Title': 'Synthetic title',
      'System.State': 'Active',
      'System.Description': '<p>Useful description</p>',
      'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>Observable result</li></ul>',
      'System.AreaPath': 'Example Project\\Area',
      'System.IterationPath': 'Example Project\\Sprint',
      'System.Tags': 'one; two',
      'System.BoardColumn': 'Doing',
      'System.ChangedDate': changedDate,
    },
  }));
}

describe('ADO M3 to M4 convergence bridge', () => {
  it('derives stable scope identity from authorized IDs, never display names', () => {
    const scope = adoKnowledgeScopeId(identity);
    expect(scope).toMatch(/^ado-board:[a-f0-9]{64}$/);
    expect(adoKnowledgeScopeId({
      ...identity,
      organization: { ...identity.organization, name: 'Renamed Org' },
      board: { ...identity.board, name: 'Renamed Board' },
    })).toBe(scope);
    expect(adoKnowledgeScopeId({
      ...identity,
      board: { ...identity.board, id: 'board-2' },
    })).not.toBe(scope);
  });

  it('keeps M3 data candidate-only and never carries raw audit bytes into M4 facts', () => {
    const source = stage();
    const result = bridgeCanonicalStageToKnowledge(source, identity);
    expect(result).toMatchObject({
      status: 'CANDIDATE',
      validation: 'UNVALIDATED_SOURCE',
      searchable: false,
      sourceRawHash: source.rawHash,
      item: { workItemId: '101' },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('rawAudit');
    expect(serialized).not.toContain('System.WorkItemType');
    expect(serialized).not.toContain(source.rawAudit.json);
    expect(result.facts.every(candidate => candidate.status === 'CANDIDATE' && candidate.searchable === false)).toBe(true);
  });

  it('projects only canonical knowledge fields and preserves sanitized M3 text', () => {
    const result = bridgeCanonicalStageToKnowledge(stage(), identity);
    expect(result.facts.map(candidate => candidate.field)).toEqual([
      'type', 'title', 'state', 'description', 'acceptanceCriteria', 'areaPath', 'iterationPath', 'boardColumn', 'tags',
    ]);
    expect(result.facts.find(candidate => candidate.field === 'acceptanceCriteria')!.fact.body).toBe('- Observable result');
    expect(result.facts.find(candidate => candidate.field === 'tags')!.fact.body).toBe('one\ntwo');
    expect(result.facts.every(candidate => candidate.fact.provenance.revision === 7)).toBe(true);
  });

  it('canonicalizes valid ADO fractional changed dates at the M4 provenance boundary', () => {
    const result = bridgeCanonicalStageToKnowledge(stage('2026-09-19T12:34:56.1234567Z'), identity);
    expect(result.node.provenance.changedDate).toBe('2026-09-19T12:34:56.123Z');
    expect(result.facts.every(candidate => candidate.fact.provenance.changedDate === '2026-09-19T12:34:56.123Z')).toBe(true);
  });

  it('binds node and field provenance to the same board-scoped work item identity', () => {
    const result = bridgeCanonicalStageToKnowledge(stage(), identity);
    expect(result.node.item).toEqual(result.item);
    expect(result.node.provenance.sourceWorkItem).toEqual(result.item);
    expect(result.facts.every(candidate => JSON.stringify(candidate.fact.provenance.sourceWorkItem) === JSON.stringify(result.item))).toBe(true);
  });

  it('fails closed if M3 stage identity is tampered after normalization', () => {
    const source = stage();
    expect(() => bridgeCanonicalStageToKnowledge({
      ...source,
      rawHash: '0'.repeat(64),
    }, identity)).toThrow('raw source hash mismatch');
    expect(() => bridgeCanonicalStageToKnowledge({
      ...source,
      revision: source.revision + 1,
    }, identity)).toThrow('version identity mismatch');
  });
});
