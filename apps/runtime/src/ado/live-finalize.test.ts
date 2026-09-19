import { describe, expect, it } from 'vitest';
import type { AdoLiveAcceptanceSnapshot } from './live-acceptance.js';
import {
  finalizeAdoLiveAcceptance,
  liveReviewBundle,
  reviewManifestDigest,
  type AdoLiveReviewManifest,
} from './live-finalize.js';

const digest = 'a'.repeat(64);

function snapshot(): AdoLiveAcceptanceSnapshot {
  return {
    schemaVersion: 1,
    observedAt: '2026-09-19T15:00:00.000Z',
    targetDigest: digest,
    organization: 'example-org',
    project: { id: 'p1', name: 'Example Project' },
    team: { id: 't1', name: 'Example Team' },
    board: { id: 'b1', name: 'Example Board' },
    scope: {
      field: 'System.AreaPath',
      defaultValue: 'Example Project\\Area',
      values: [{ value: 'Example Project\\Area', includeChildren: true }],
    },
    backlogLevels: [
      { id: 'portfolio', name: 'Portfolio', rank: 2, type: 'portfolio', workItemTypes: ['Feature'], hidden: false },
      { id: 'requirements', name: 'Requirements', rank: 1, type: 'requirement', workItemTypes: ['User Story'], hidden: false },
    ],
    levels: {
      level1: { itemId: 200, revision: 1, commentCount: 0 },
      level2: { featureRootId: 200, itemCount: 3 },
      level3: { backlogId: 'requirements', backlogName: 'Requirements', itemCount: 2 },
      level4: { uniqueItemCount: 3, commentCount: 0, relationCount: 2 },
    },
    items: [
      {
        id: 200, revision: 1, type: 'Feature', title: 'Preference management', state: 'Active',
        description: null, acceptanceCriteria: null, areaPath: 'Example Project\\Area',
        iterationPath: 'Example Project\\Sprint 1', parent: null, changedDate: '2026-09-19T12:00:00.000Z',
        backlogIds: ['portfolio'], comments: [],
        relations: [
          { relation: 'System.LinkTypes.Hierarchy-Forward', targetWorkItemId: 201 },
          { relation: 'System.LinkTypes.Hierarchy-Forward', targetWorkItemId: 202 },
        ],
      },
      {
        id: 201, revision: 2, type: 'User Story', title: 'Save preference', state: 'Active',
        description: 'Users can save a preference and reopen the workspace with the same value.',
        acceptanceCriteria: 'Reopening the workspace restores the previously saved preference value.',
        areaPath: 'Example Project\\Area', iterationPath: 'Example Project\\Sprint 1',
        parent: 200, changedDate: '2026-09-19T12:01:00.000Z',
        backlogIds: ['requirements'], comments: [], relations: [],
      },
      {
        id: 202, revision: 1, type: 'User Story', title: 'Reset preference', state: 'Active',
        description: 'Reopening the workspace resets the preference instead of keeping the saved value.',
        acceptanceCriteria: null, areaPath: 'Example Project\\Area',
        iterationPath: 'Example Project\\Sprint 1', parent: 200, changedDate: '2026-09-19T12:02:00.000Z',
        backlogIds: ['requirements'], comments: [], relations: [],
      },
    ],
    revisionStable: true,
    zeroMutation: true,
    ledger: [{ operation: 'work_items.list', method: 'GET', status: 200, objectCount: 3 }],
  };
}

function manifest(): AdoLiveReviewManifest {
  return {
    schemaVersion: 1,
    targetDigest: digest,
    reviewer: 'CHATGPT_SUPERVISED',
    decisions: [
      { itemId: 200, revision: 1, kind: 'WORK_ITEM', truthStatus: 'CURRENT', semantic: null },
      {
        itemId: 201, revision: 2, kind: 'WORK_ITEM', truthStatus: 'CURRENT',
        semantic: {
          verdict: 'VALIDATED', reusable: true, category: 'FUNCTIONAL_BEHAVIOR',
          quotes: [{ field: 'description', text: 'Users can save a preference and reopen the workspace with the same value.' }],
        },
      },
      {
        itemId: 202, revision: 1, kind: 'WORK_ITEM', truthStatus: 'CONFLICTING',
        semantic: {
          verdict: 'VALIDATED', reusable: true, category: 'FUNCTIONAL_BEHAVIOR',
          quotes: [{ field: 'description', text: 'Reopening the workspace resets the preference instead of keeping the saved value.' }],
        },
      },
    ],
  };
}

describe('ADO live supervised finalization', () => {
  it('classifies every source, quarantines unresolved truth, and builds grounded Wiki output', () => {
    const result = finalizeAdoLiveAcceptance(snapshot(), manifest());
    expect(result).toMatchObject({
      sourceItemCount: 3,
      classifiedItemCount: 3,
      published: true,
      promotedCount: 1,
      contextCount: 1,
      supportingEvidenceCount: 0,
      reviewCount: 1,
      historyCount: 0,
      wikiClaimCount: 1,
      wikiGrounded: true,
      zeroMutation: true,
      revisionStable: true,
      complete: true,
    });
    expect(result.classificationCounts).toEqual({
      PROMOTED: 2,
      CONTEXT_ONLY: 1,
      SUPPORTING_EVIDENCE: 0,
      REJECTED: 0,
    });
    expect(result.truthCounts.CONFLICTING).toBe(1);
  });

  it('requires an exact decision set and exact source-grounded semantic quotes', () => {
    const incomplete = manifest();
    expect(() => finalizeAdoLiveAcceptance(snapshot(), {
      ...incomplete,
      decisions: incomplete.decisions.slice(0, 2),
    })).toThrow('INCOMPLETE_REVIEW');

    const forged = manifest();
    expect(() => finalizeAdoLiveAcceptance(snapshot(), {
      ...forged,
      decisions: forged.decisions.map(decision => decision.itemId === 201
        ? {
          ...decision,
          semantic: {
            verdict: 'VALIDATED' as const,
            reusable: true,
            category: 'FUNCTIONAL_BEHAVIOR' as const,
            quotes: [{ field: 'description' as const, text: 'Invented requirement that is not present in the source.' }],
          },
        }
        : decision),
    })).toThrow('INVALID_SEMANTIC_EVIDENCE');
  });

  it('emits a bounded review bundle and a stable manifest digest', () => {
    const bundle = liveReviewBundle(snapshot());
    expect(bundle.targetDigest).toBe(digest);
    expect(bundle.items).toHaveLength(3);
    expect(bundle.items[1]).toMatchObject({
      itemId: 201,
      workItemType: 'User Story',
      backlogIds: ['requirements'],
    });
    expect(reviewManifestDigest(manifest())).toMatch(/^[a-f0-9]{64}$/);
    expect(reviewManifestDigest(structuredClone(manifest()))).toBe(reviewManifestDigest(manifest()));
  });
});
