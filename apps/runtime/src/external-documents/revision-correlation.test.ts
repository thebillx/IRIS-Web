import { describe, expect, it } from 'vitest';
import {
  buildCrossSourceCorrelation, compareExternalRevisions, externalRevisionFromEvidence,
  type CrossSourceLink, type CrossSourceNode, type ExternalRevisionSnapshot,
} from './revision-correlation.js';
import type { ExternalDocumentEvidence } from './contract.js';

const revision = (patch: Partial<ExternalRevisionSnapshot> = {}): ExternalRevisionSnapshot => ({
  projectId: 'bbl-wiki', provider: 'figma', sourceId: 'AllowedFile',
  sourceLinkIdentity: 'ado-link:94747:figma', version: 'v1',
  acquiredAt: '2026-09-20T00:00:00.000Z', contentSha256: 'a'.repeat(64), artifactIds: ['artifact-1'],
  ...patch,
});

const node = (nodeId: string, kind: CrossSourceNode['kind'], sourceIdentity: string, version: string | null = null): CrossSourceNode => ({
  nodeId, projectId: 'bbl-wiki', kind, sourceIdentity, version,
});
const link = (linkId: string, fromNodeId: string, toNodeId: string, relation: CrossSourceLink['relation']): CrossSourceLink => ({
  linkId, fromNodeId, toNodeId, relation, authority: 'SUPPORTING_EVIDENCE',
});

describe('M9 revision history and cross-source correlation', () => {
  it('classifies unchanged, metadata-only and content-changing document revisions', () => {
    expect(compareExternalRevisions(revision(), revision({ acquiredAt: '2026-09-20T00:01:00.000Z' })).state).toBe('UNCHANGED');
    expect(compareExternalRevisions(revision(), revision({ version: 'v2', acquiredAt: '2026-09-20T00:01:00.000Z' })).state).toBe('METADATA_CHANGED');
    const changed = compareExternalRevisions(revision(), revision({ version: 'v2', acquiredAt: '2026-09-20T00:01:00.000Z', contentSha256: 'b'.repeat(64) }));
    expect(changed).toMatchObject({ state: 'CONTENT_CHANGED', versionChanged: true, contentChanged: true });
    expect(changed.diffId).toMatch(/^external-diff:[a-f0-9]{32}$/);
  });

  it('rejects external revision rebinding and time reversal', () => {
    expect(() => compareExternalRevisions(revision(), revision({ sourceId: 'OtherFile', acquiredAt: '2026-09-20T00:01:00.000Z' })))
      .toThrow('EXTERNAL_REVISION_IDENTITY_MISMATCH');
    expect(() => compareExternalRevisions(revision(), revision({ acquiredAt: '2026-09-19T23:59:59.000Z' })))
      .toThrow('EXTERNAL_REVISION_OUT_OF_ORDER');
  });

  it('derives a revision snapshot from supporting evidence without secrets or content bytes', () => {
    const evidence: ExternalDocumentEvidence = {
      authority: 'SUPPORTING_EVIDENCE', status: 'complete', contentSha256: 'c'.repeat(64), failures: [], artifacts: [],
      provenance: {
        acquisitionId: 'acq-1', requestId: 'req-1', projectId: 'bbl-wiki', connectorId: 'figma-read',
        connectorBindingId: 'binding-1', provider: 'figma', sourceId: 'AllowedFile', version: 'v7',
        sourceLinkIdentity: 'ado-link:94747:figma', acquiredAt: '2026-09-20T00:00:00.000Z',
      },
    };
    expect(externalRevisionFromEvidence(evidence)).toEqual({
      projectId: 'bbl-wiki', provider: 'figma', sourceId: 'AllowedFile', sourceLinkIdentity: 'ado-link:94747:figma',
      version: 'v7', acquiredAt: '2026-09-20T00:00:00.000Z', contentSha256: 'c'.repeat(64), artifactIds: [],
    });
  });

  it('correlates ADO requirement, design, bug, test, PR, commit and build as evidence-only nodes', () => {
    const graph = buildCrossSourceCorrelation([
      node('ado-94747','ADO_WORK_ITEM','workitem:94747','17'),
      node('figma-payment','EXTERNAL_DOCUMENT','figma:AllowedFile:1:2','v7'),
      node('bug-123','BUG','ado-bug:123','4'),
      node('test-555','TEST_CASE','ado-testcase:555','9'),
      node('pr-14','PULL_REQUEST','github-pr:14','merged'),
      node('commit-abc','COMMIT','github-commit:abc123','abc123'),
      node('build-88','BUILD','ado-build:88','succeeded'),
    ], [
      link('l1','figma-payment','ado-94747','SUPPORTS'),
      link('l2','bug-123','ado-94747','SUPPORTS'),
      link('l3','test-555','ado-94747','VERIFIES'),
      link('l4','pr-14','ado-94747','IMPLEMENTS'),
      link('l5','commit-abc','pr-14','DERIVED_FROM'),
      link('l6','build-88','commit-abc','VERIFIES'),
    ]);
    expect(graph.nodes).toHaveLength(7);
    expect(graph.links).toHaveLength(6);
    expect(graph.links.every(edge => edge.authority === 'SUPPORTING_EVIDENCE')).toBe(true);
  });

  it('denies cross-project correlation until the explicit M9-E graph boundary', () => {
    expect(() => buildCrossSourceCorrelation([
      node('ado-1','ADO_WORK_ITEM','workitem:1'),
      { ...node('ado-2','ADO_WORK_ITEM','workitem:2'), projectId: 'foreign' },
    ], [])).toThrow('CROSS_PROJECT_CORRELATION_DENIED');
  });

  it('fails closed on endpoint substitution and correlation identity conflicts', () => {
    expect(() => buildCrossSourceCorrelation([node('ado-1','ADO_WORK_ITEM','workitem:1')], [
      link('l1','missing','ado-1','SUPPORTS'),
    ])).toThrow('CORRELATION_ENDPOINT_INVALID');
    expect(() => buildCrossSourceCorrelation([
      node('ado-1','ADO_WORK_ITEM','workitem:1'),
      { ...node('ado-1','ADO_WORK_ITEM','workitem:1'), sourceIdentity: 'workitem:2' },
    ], [])).toThrow('CORRELATION_NODE_CONFLICT');
  });
});
