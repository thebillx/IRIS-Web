import { bindRead, type ReadGrant, type ReadRequest, type ReadResult } from '../figma-read/contract.js';
import {
  bindExternalDocumentAcquisition,
  ExternalDocumentContractError,
  type ExternalDocumentGrant,
  type ExternalDocumentReference,
  type ExternalDocumentRequest,
  type ExternalDocumentEvidence,
} from './contract.js';

const operationMap = {
  metadata: 'figma.get_file_metadata',
  content: 'figma.get_design_context',
  structure: 'figma.get_page_or_node',
  preview: 'figma.get_screenshot',
} as const satisfies Readonly<Record<ExternalDocumentRequest['operation'], ReadRequest['operation']>>;

export interface BoundFigmaKnowledgeRead {
  readonly reference: ExternalDocumentReference;
  readonly externalRequest: ExternalDocumentRequest;
  readonly figmaRequest: ReadRequest;
}

/**
 * Bind one inert ADO→Figma supporting-document reference to the existing governed Figma read contract.
 *
 * Both grants must describe the same connector authority. This function never accepts a URL or token
 * from the caller, never promotes Figma content to primary knowledge, and preserves the existing
 * file/node allowlists enforced by figma-read/bindRead.
 */
export function bindFigmaKnowledgeRead(
  reference: ExternalDocumentReference,
  externalGrant: ExternalDocumentGrant,
  externalRequest: ExternalDocumentRequest,
  figmaGrant: ReadGrant,
  figmaRequest: ReadRequest,
  now: number,
): BoundFigmaKnowledgeRead {
  if (reference.provider !== 'figma'
    || reference.authority !== 'REFERENCE_ONLY'
    || externalGrant.provider !== 'figma'
    || externalRequest.provider !== 'figma'
    || reference.projectId !== externalRequest.projectId
    || reference.sourceId !== externalRequest.sourceId
    || reference.sourceId !== figmaRequest.fileKey
    || externalRequest.projectId !== figmaRequest.projectId
    || externalRequest.connectorBindingId !== figmaRequest.connectorBindingId
    || externalGrant.connectorId !== figmaGrant.connectorId
    || externalGrant.connectorBindingId !== figmaGrant.connectorBindingId
    || externalGrant.credentialRef !== figmaGrant.credentialRef
    || externalGrant.sessionRef !== figmaGrant.sessionRef
    || externalGrant.outputWorkspaceId !== figmaGrant.outputWorkspaceId
    || operationMap[externalRequest.operation] !== figmaRequest.operation) {
    throw new ExternalDocumentContractError('UNAUTHORIZED');
  }

  const boundExternal = bindExternalDocumentAcquisition(externalGrant, externalRequest, now);
  const boundFigma = bindRead(figmaGrant, figmaRequest, now);

  return Object.freeze({
    reference: Object.freeze({ ...reference }),
    externalRequest: boundExternal,
    figmaRequest: boundFigma,
  });
}

export function projectFigmaReadAsSupportingEvidence(
  bound: BoundFigmaKnowledgeRead,
  grant: ExternalDocumentGrant,
  result: ReadResult,
): ExternalDocumentEvidence {
  if (grant.provider !== 'figma'
    || result.provenance.projectId !== bound.externalRequest.projectId
    || result.provenance.connectorId !== grant.connectorId
    || result.provenance.connectorBindingId !== bound.externalRequest.connectorBindingId
    || result.provenance.requestId !== bound.figmaRequest.requestId
    || result.provenance.operation !== bound.figmaRequest.operation
    || result.provenance.source.provider !== 'figma'
    || result.provenance.source.fileKey !== bound.reference.sourceId
    || (bound.externalRequest.expectedVersion !== null
      && result.provenance.source.version !== bound.externalRequest.expectedVersion)
    || result.artifacts.length > grant.limits.maxArtifacts) {
    throw new ExternalDocumentContractError('SOURCE_CHANGED');
  }

  return Object.freeze({
    authority: 'SUPPORTING_EVIDENCE',
    provenance: Object.freeze({
      acquisitionId: result.provenance.acquisitionId,
      requestId: result.provenance.requestId,
      projectId: result.provenance.projectId,
      connectorId: result.provenance.connectorId,
      connectorBindingId: result.provenance.connectorBindingId,
      provider: 'figma',
      sourceId: result.provenance.source.fileKey,
      version: result.provenance.source.version,
      sourceLinkIdentity: bound.reference.sourceLinkIdentity,
      acquiredAt: result.provenance.acquiredAt,
    }),
    status: result.status,
    artifacts: Object.freeze(result.artifacts.map(artifact => Object.freeze({ ...artifact }))),
    contentSha256: null,
    failures: Object.freeze([...result.failures]),
  });
}
