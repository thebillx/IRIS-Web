import { describe, expect, it } from 'vitest';
import { fixtureGrant as figmaGrant, fixtureRequest as figmaRequest } from '../figma-read/fixtures.js';
import type { ReadResult } from '../figma-read/contract.js';
import { bindFigmaKnowledgeRead, projectFigmaReadAsSupportingEvidence } from './figma-knowledge-link.js';
import type { ExternalDocumentGrant, ExternalDocumentReference, ExternalDocumentRequest } from './contract.js';

const reference: ExternalDocumentReference = {
  referenceId: 'figma-link-1', projectId: 'bbl-wiki', sourceWorkItemId: '94747',
  sourceLinkIdentity: 'ado-link:94747:figma', provider: 'figma', sourceId: 'AllowedFile',
  title: 'Payment confirmation design', authority: 'REFERENCE_ONLY',
};

const externalGrant: ExternalDocumentGrant = {
  projectId: figmaGrant.projectId, connectorId: figmaGrant.connectorId,
  connectorBindingId: figmaGrant.connectorBindingId, provider: 'figma',
  credentialRef: figmaGrant.credentialRef, sessionRef: figmaGrant.sessionRef, sourceMode: 'REMOTE',
  allowedSourceIds: ['AllowedFile'], allowedOperations: ['metadata', 'content', 'structure', 'preview'],
  network: 'allowed', expiresAt: figmaGrant.expiresAt, revoked: false,
  outputWorkspaceId: figmaGrant.outputWorkspaceId,
  limits: { maxContentBytes: 1024, maxArtifacts: 8, timeoutMs: 1000 },
};

const externalRequest: ExternalDocumentRequest = {
  requestId: figmaRequest.requestId, projectId: figmaRequest.projectId,
  connectorBindingId: figmaRequest.connectorBindingId, provider: 'figma', operation: 'content',
  sourceId: figmaRequest.fileKey, expectedVersion: 'v1',
};

const result: ReadResult = {
  provenance: {
    acquisitionId: 'acquisition-1', requestId: figmaRequest.requestId, projectId: figmaRequest.projectId,
    connectorId: figmaGrant.connectorId, connectorBindingId: figmaGrant.connectorBindingId,
    operation: figmaRequest.operation,
    source: { provider: 'figma', organizationId: figmaGrant.organizationId, fileKey: figmaRequest.fileKey, nodeIds: figmaRequest.nodeIds, version: 'v1' },
    acquiredAt: '2026-09-20T00:00:00.000Z', resumedFrom: null,
  },
  status: 'complete', artifacts: [], evidence: [], failures: [],
};

describe('M9 Figma knowledge linking', () => {
  it('binds ADO reference → external authority → existing Figma file/node authority', () => {
    const bound = bindFigmaKnowledgeRead(reference, externalGrant, externalRequest, figmaGrant, figmaRequest, Date.parse('2026-09-20'));
    expect(bound.reference.sourceWorkItemId).toBe('94747');
    expect(bound.externalRequest.operation).toBe('content');
    expect(bound.figmaRequest.operation).toBe('figma.get_design_context');
    expect(bound.figmaRequest.nodeIds).toEqual(['1:2']);
    const serialized = JSON.stringify(bound);
    expect(serialized).not.toContain(figmaGrant.credentialRef);
    expect(serialized).not.toContain(figmaGrant.sessionRef);
  });

  it('projects acquired Figma data only as provenance-retaining supporting evidence', () => {
    const bound = bindFigmaKnowledgeRead(reference, externalGrant, externalRequest, figmaGrant, figmaRequest, Date.parse('2026-09-20'));
    const evidence = projectFigmaReadAsSupportingEvidence(bound, externalGrant, result);
    expect(evidence).toMatchObject({
      authority: 'SUPPORTING_EVIDENCE', status: 'complete', contentSha256: null,
      provenance: { provider: 'figma', sourceId: 'AllowedFile', version: 'v1', sourceLinkIdentity: 'ado-link:94747:figma' },
    });
  });

  it('rejects a changed Figma version before it can be linked as current evidence', () => {
    const bound = bindFigmaKnowledgeRead(reference, externalGrant, externalRequest, figmaGrant, figmaRequest, Date.parse('2026-09-20'));
    expect(() => projectFigmaReadAsSupportingEvidence(bound, externalGrant, {
      ...result, provenance: { ...result.provenance, source: { ...result.provenance.source, version: 'v2' } },
    })).toThrow('SOURCE_CHANGED');
  });

  it('rejects source substitution between ADO link and Figma file', () => {
    expect(() => bindFigmaKnowledgeRead({ ...reference, sourceId: 'OtherFile' }, externalGrant, externalRequest, figmaGrant, figmaRequest, Date.now()))
      .toThrow('UNAUTHORIZED');
  });

  it('rejects connector authority split even when file identity matches', () => {
    expect(() => bindFigmaKnowledgeRead(reference, { ...externalGrant, credentialRef: 'other-credential' }, externalRequest, figmaGrant, figmaRequest, Date.now()))
      .toThrow('UNAUTHORIZED');
  });

  it('rejects operation remapping that could widen Figma evidence access', () => {
    expect(() => bindFigmaKnowledgeRead(reference, externalGrant, { ...externalRequest, operation: 'preview' }, figmaGrant, figmaRequest, Date.now()))
      .toThrow('UNAUTHORIZED');
  });

  it('preserves existing Figma node allowlist enforcement', () => {
    expect(() => bindFigmaKnowledgeRead(reference, externalGrant, externalRequest, figmaGrant, { ...figmaRequest, nodeIds: ['9:9'] }, Date.now()))
      .toThrow('UNAUTHORIZED');
  });
});
