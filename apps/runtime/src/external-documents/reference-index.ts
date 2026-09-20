import { createExternalDocumentReference, type ExternalDocumentReference } from './contract.js';

export interface WikiSupportingDocumentReference {
  readonly referenceId: string;
  readonly sourceWorkItemId: string;
  readonly sourceLinkIdentity: string;
  readonly provider: ExternalDocumentReference['provider'];
  readonly sourceId: string;
  readonly title: string;
  readonly authority: 'SUPPORTING_EVIDENCE';
  readonly acquisition: 'NOT_REQUESTED';
  readonly searchable: false;
}

/**
 * Build a deterministic, inert external-document reference index from ADO link metadata.
 *
 * No connector lookup or network access occurs here. Duplicate identities must be byte-equivalent;
 * conflicting duplicates fail closed so a later connector cannot silently substitute source authority.
 */
export function indexExternalDocumentReferences(
  inputs: readonly ExternalDocumentReference[],
): readonly ExternalDocumentReference[] {
  if (!Array.isArray(inputs) || inputs.length > 10_000) throw new Error('EXTERNAL_REFERENCE_LIMIT');
  const byId = new Map<string, ExternalDocumentReference>();
  const bySourceLink = new Map<string, ExternalDocumentReference>();
  for (const input of inputs) {
    const reference = createExternalDocumentReference(input);
    const existingId = byId.get(reference.referenceId);
    if (existingId !== undefined && JSON.stringify(existingId) !== JSON.stringify(reference)) {
      throw new Error('EXTERNAL_REFERENCE_ID_CONFLICT');
    }
    const existingLink = bySourceLink.get(reference.sourceLinkIdentity);
    if (existingLink !== undefined && JSON.stringify(existingLink) !== JSON.stringify(reference)) {
      throw new Error('EXTERNAL_SOURCE_LINK_CONFLICT');
    }
    byId.set(reference.referenceId, reference);
    bySourceLink.set(reference.sourceLinkIdentity, reference);
  }
  return Object.freeze([...byId.values()].sort((left, right) =>
    left.referenceId < right.referenceId ? -1 : left.referenceId > right.referenceId ? 1 : 0));
}

/**
 * Project supporting-document links into the Wiki/reference surface without making their content
 * searchable or authoritative knowledge. Acquisition is a later, separately governed step.
 */
export function projectExternalDocumentReferencesForWiki(
  references: readonly ExternalDocumentReference[],
): readonly WikiSupportingDocumentReference[] {
  return Object.freeze(indexExternalDocumentReferences(references).map(reference => Object.freeze({
    referenceId: reference.referenceId,
    sourceWorkItemId: reference.sourceWorkItemId,
    sourceLinkIdentity: reference.sourceLinkIdentity,
    provider: reference.provider,
    sourceId: reference.sourceId,
    title: reference.title,
    authority: 'SUPPORTING_EVIDENCE' as const,
    acquisition: 'NOT_REQUESTED' as const,
    searchable: false as const,
  })));
}
