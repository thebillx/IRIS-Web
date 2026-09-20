import { describe, expect, it } from 'vitest';
import { indexExternalDocumentReferences, projectExternalDocumentReferencesForWiki } from './reference-index.js';
import type { ExternalDocumentReference } from './contract.js';

const figma: ExternalDocumentReference = {
  referenceId: 'link-2', projectId: 'bbl-wiki', sourceWorkItemId: '94747',
  sourceLinkIdentity: 'ado-link:94747:figma', provider: 'figma', sourceId: 'AllowedFile',
  title: 'Payment design', authority: 'REFERENCE_ONLY',
};
const pdf: ExternalDocumentReference = {
  referenceId: 'link-1', projectId: 'bbl-wiki', sourceWorkItemId: '15126',
  sourceLinkIdentity: 'ado-link:15126:pdf', provider: 'pdf', sourceId: 'artifact-123',
  title: 'Requirement attachment', authority: 'REFERENCE_ONLY',
};

describe('M9 external supporting-reference index', () => {
  it('is deterministic and connector-independent', () => {
    const indexed = indexExternalDocumentReferences([figma, pdf]);
    expect(indexed.map(entry => entry.referenceId)).toEqual(['link-1', 'link-2']);
    expect(JSON.stringify(indexed)).not.toContain('credential');
  });

  it('lets Wiki expose references before document acquisition without searchable content', () => {
    expect(projectExternalDocumentReferencesForWiki([figma])).toEqual([{
      referenceId: 'link-2', sourceWorkItemId: '94747', sourceLinkIdentity: 'ado-link:94747:figma',
      provider: 'figma', sourceId: 'AllowedFile', title: 'Payment design',
      authority: 'SUPPORTING_EVIDENCE', acquisition: 'NOT_REQUESTED', searchable: false,
    }]);
  });

  it('fails closed on conflicting reference-id substitution', () => {
    expect(() => indexExternalDocumentReferences([figma, { ...figma, sourceId: 'OtherFile' }]))
      .toThrow('EXTERNAL_REFERENCE_ID_CONFLICT');
  });

  it('fails closed when one ADO source-link identity is rebound to a different reference', () => {
    expect(() => indexExternalDocumentReferences([figma, { ...figma, referenceId: 'link-3' }]))
      .toThrow('EXTERNAL_SOURCE_LINK_CONFLICT');
  });
});
