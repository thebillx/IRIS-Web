import { describe, expect, it } from 'vitest';
import { stageRawSource } from '@iris/ado';
import { buildWiki, queryKnowledge, type TopicDefinition } from '@iris/shared/ado/wiki';
import type { SemanticClassifier } from '@iris/shared/ado/knowledge-gate';
import type { Backlog, BoardIdentity } from './ado/discovery.js';
import { bridgeCanonicalStageToKnowledge } from './ado-knowledge-bridge.js';
import { classifyCanonicalKnowledge } from './ado-knowledge-gate-bridge.js';
import { gateDecisionFromClassification, toSyncMembership, toSyncObservation } from './ado-knowledge-sync-bridge.js';
import { buildWikiFromPublishedCorpus, buildWikiInputFromPublishedCorpus } from './ado-wiki-bridge.js';
import { MemorySyncStore } from './ado/m6/store.js';
import { SyncCoordinator } from './ado/m6/sync.js';

const at = '2026-09-19T12:34:56.123Z';
const identity: BoardIdentity = {
  organization: { id: 'org-1', name: 'Example Org' },
  project: { id: 'project-1', name: 'Example Project' },
  team: { id: 'team-1', name: 'Delivery Team' },
  board: { id: 'board-1', name: 'Delivery Board' },
};
const backlogs: readonly Backlog[] = [
  { id: 'delivery', name: 'Delivery', rank: 2, type: 'requirement', workItemTypes: ['Request'] },
];
const topic: TopicDefinition = {
  id: 'delivery',
  title: 'Delivery knowledge',
  hierarchyIds: [],
  groupingKeys: ['delivery'],
  conceptIds: [],
};
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

function published() {
  const stage = stageRawSource(JSON.stringify({
    id: 101,
    rev: 7,
    fields: {
      'System.WorkItemType': 'Request',
      'System.Title': 'Export selected results',
      'System.Description': 'The system exports only records selected by the user.',
      'Microsoft.VSTS.Common.AcceptanceCriteria': 'Only selected records appear in the export.',
      'System.AreaPath': 'Example Project\\Delivery',
      'System.IterationPath': 'Example Project\\Sprint 1',
      'System.ChangedDate': at,
    },
  }));
  const candidate = bridgeCanonicalStageToKnowledge(stage, identity);
  const classification = classifyCanonicalKnowledge(candidate, backlogs, semantic);
  expect(classification.status).toBe('PROMOTED');

  const store = new MemorySyncStore();
  const coordinator = new SyncCoordinator(store);
  coordinator.start({
    syncRunId: 'wiki-run',
    scope: { organizationId: 'org-1', projectId: 'project-1', teamId: 'team-1', boardId: 'board-1' },
    mode: 'FULL',
    trigger: { kind: 'MANUAL' },
    inventory: { snapshotId: 'inventory-1', complete: true, items: [toSyncMembership(stage, ['delivery'])] },
    policy: { gateVersion: classification.policyVersion, minimumPromoted: 1, allowRejections: true },
    at,
  });
  coordinator.checkpoint('wiki-run', 1, {
    batchId: 'batch-1',
    observations: [toSyncObservation(stage, candidate, {
      expectedCommentIds: [],
      commentsComplete: true,
      comments: [],
      relationsComplete: true,
      relations: [],
      linksComplete: true,
      links: [],
    })],
    failures: [],
  }, at);
  const source = store.read().sourceStaging[0]!;
  coordinator.decide('wiki-run', 2, gateDecisionFromClassification(101, source.fingerprint, classification, 'CURRENT'), at);
  expect(coordinator.finish('wiki-run', 3, at).published).toBe(true);
  return coordinator.published({
    organizationId: 'org-1', projectId: 'project-1', teamId: 'team-1', boardId: 'board-1',
  })!;
}

describe('M6 to M7 Wiki convergence bridge', () => {
  it('builds extractive Wiki input from promoted gate evidence with classification provenance', () => {
    const corpus = published();
    const input = buildWikiInputFromPublishedCorpus(corpus, { topics: [topic] });
    expect(input.candidates).toHaveLength(1);
    expect(input.candidates[0]).toMatchObject({
      category: 'FUNCTIONAL_BEHAVIOR',
      text: 'The system exports only records selected by the user.',
      groupingKeys: ['delivery'],
      iterations: ['Example Project\\Sprint 1'],
    });
    const citation = input.candidates[0]!.references[0]!;
    expect(citation.classification?.gateVersion).toBe(corpus.promoted.gates[0]!.gateVersion);
    expect(citation.classification?.digest).toBe(corpus.promoted.gates[0]!.classificationDigest);
    expect(citation.classification?.truthStatus).toBe('CURRENT');
  });

  it('builds a grounded Wiki and answers only from cited promoted text', () => {
    const result = buildWikiFromPublishedCorpus(published(), { topics: [topic] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const response = queryKnowledge(result.value, { keyword: 'selected by the user' });
    expect(response.status).toBe('ANSWERED');
    expect(response.claims).toHaveLength(1);
    expect(response.claims[0]!.answer).toBe('The system exports only records selected by the user.');
    expect(response.claims[0]!.provenance[0]!.reference.classification?.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not project context-only sources into factual candidates', () => {
    const corpus = published();
    const promoted = corpus.promoted;
    const gate = promoted.gates[0]!;
    const contextCorpus = {
      syncRunId: corpus.syncRunId,
      promoted: { sources: [], comments: [], relations: [], links: [], membership: [], gates: [] },
      contextOnly: {
        ...promoted,
        gates: [{ ...gate, disposition: 'CONTEXT_ONLY' as const, category: null, evidence: [] }],
      },
      supportingEvidence: { sources: [], comments: [], relations: [], links: [], membership: [], gates: [] },
      review: { sources: [], comments: [], relations: [], links: [], membership: [], gates: [] },
      history: { sources: [], comments: [], relations: [], links: [], membership: [], gates: [] },
    };
    const input = buildWikiInputFromPublishedCorpus(contextCorpus, { topics: [topic] });
    expect(input.candidates).toEqual([]);
    expect(buildWiki(input).ok).toBe(true);
  });

  it('fails closed when persisted gate evidence is not present in the canonical source field', () => {
    const corpus = published();
    const gate = corpus.promoted.gates[0]!;
    const forged = {
      ...corpus,
      promoted: {
        ...corpus.promoted,
        gates: [{ ...gate, evidence: [{ field: 'description' as const, text: 'Invented requirement' }] }],
      },
    };
    expect(() => buildWikiInputFromPublishedCorpus(forged, { topics: [topic] }))
      .toThrow('does not resolve to persisted canonical source');
  });

  it('requires explicit topics instead of creating one page per work item', () => {
    expect(() => buildWikiInputFromPublishedCorpus(published(), { topics: [] }))
      .toThrow('explicit topic definitions');
  });
});
