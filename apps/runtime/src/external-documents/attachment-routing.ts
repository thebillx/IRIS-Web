import { createHash } from 'node:crypto';
import type { ArtifactReference, WorkspaceId } from '@iris/domain';
import { createExternalDocumentReference, type ExternalDocumentReference } from './contract.js';

export interface AdoAttachmentDescriptor {
  readonly projectId: string;
  readonly workspaceId: WorkspaceId;
  readonly sourceWorkItemId: string;
  readonly sourceLinkIdentity: string;
  readonly title: string;
  readonly artifact: ArtifactReference;
}

export type AdoAttachmentRoute =
  | Readonly<{ supported: true; provider: 'pdf' | 'excel'; reference: ExternalDocumentReference }>
  | Readonly<{ supported: false; reason: 'UNSUPPORTED_MIME'; sourceLinkIdentity: string; mime: string }>;

const EXCEL_MIME = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/**
 * Route an already governed ADO attachment artifact into the external-document pipeline.
 *
 * The router receives an ArtifactReference, never a filesystem path. Unsupported binaries remain
 * reference-only and are not handed to an extractor. Artifact project/workspace identity is checked
 * before a PDF/Excel extraction reference can be created.
 */
export function routeAdoAttachment(input: AdoAttachmentDescriptor): AdoAttachmentRoute {
  if (input.artifact.projectId !== input.projectId || input.artifact.workspaceId !== input.workspaceId) {
    throw new Error('ATTACHMENT_ARTIFACT_AUTHORITY_MISMATCH');
  }
  if (input.artifact.sensitivity === 'PUBLIC' && input.artifact.retentionPolicy === 'MANUAL') {
    // Valid but intentionally no special widening: routing stays evidence-only.
  }
  const provider = input.artifact.mime === 'application/pdf'
    ? 'pdf'
    : EXCEL_MIME.has(input.artifact.mime) ? 'excel' : null;
  if (provider === null) {
    return Object.freeze({
      supported: false, reason: 'UNSUPPORTED_MIME',
      sourceLinkIdentity: input.sourceLinkIdentity, mime: input.artifact.mime,
    });
  }
  const artifactId = String(input.artifact.artifactId);
  const referenceId = 'attachment:' + createHash('sha256').update(JSON.stringify([
    input.projectId, input.sourceWorkItemId, input.sourceLinkIdentity, provider, artifactId, input.artifact.sha256,
  ])).digest('hex').slice(0, 32);
  const reference = createExternalDocumentReference({
    referenceId, projectId: input.projectId, sourceWorkItemId: input.sourceWorkItemId,
    sourceLinkIdentity: input.sourceLinkIdentity, provider, sourceId: artifactId, title: input.title,
    authority: 'REFERENCE_ONLY',
  });
  return Object.freeze({ supported: true, provider, reference });
}
