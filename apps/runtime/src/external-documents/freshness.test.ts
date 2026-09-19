import { describe, expect, it } from 'vitest';
import { assessExternalKnowledgeFreshness } from './freshness.js';
import type { ExternalRevisionSnapshot } from './revision-correlation.js';

const current: ExternalRevisionSnapshot = {
  projectId: 'bbl-wiki', provider: 'figma', sourceId: 'AllowedFile', sourceLinkIdentity: 'ado-link:94747:figma',
  version: 'v2', acquiredAt: '2026-09-20T01:00:00.000Z', contentSha256: 'a'.repeat(64), artifactIds: [],
};
const projection = {
  projectId: 'bbl-wiki', sourceId: 'AllowedFile', sourceLinkIdentity: 'ado-link:94747:figma',
  sourceVersion: 'v2', contentSha256: 'a'.repeat(64), builtAt: '2026-09-20T00:30:00.000Z', topicIds: ['topic-1'],
} as const;

describe('M9 external knowledge freshness', () => {
  it('reports current when source identity/version/hash match inside the age bound', () => {
    expect(assessExternalKnowledgeFreshness(projection, current, '2026-09-20T01:00:00.000Z', 60 * 60 * 1000))
      .toEqual({ state: 'CURRENT', affectedTopicIds: [], reason: 'NONE' });
  });
  it('marks affected topics stale when source version or content changes', () => {
    expect(assessExternalKnowledgeFreshness(projection, { ...current, version: 'v3' }, '2026-09-20T01:00:00.000Z', 60 * 60 * 1000))
      .toEqual({ state: 'STALE_SOURCE', affectedTopicIds: ['topic-1'], reason: 'SOURCE_CHANGED' });
  });
  it('marks age-expired projections stale without inventing source changes', () => {
    expect(assessExternalKnowledgeFreshness(projection, current, '2026-09-20T03:00:00.000Z', 60 * 60 * 1000))
      .toEqual({ state: 'STALE_AGE', affectedTopicIds: ['topic-1'], reason: 'AGE_LIMIT' });
  });
  it('fails closed when the projection is rebound to a different source', () => {
    expect(() => assessExternalKnowledgeFreshness({ ...projection, sourceId: 'OtherFile' }, current, '2026-09-20T01:00:00.000Z', 1000))
      .toThrow('FRESHNESS_IDENTITY_MISMATCH');
  });
});
