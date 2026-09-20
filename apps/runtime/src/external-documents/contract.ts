import type { ArtifactReference, WorkspaceId } from '@iris/domain';

export const externalDocumentProviders = ['figma', 'sharepoint', 'pdf', 'excel'] as const;
export type ExternalDocumentProvider = typeof externalDocumentProviders[number];

export const externalDocumentOperations = ['metadata', 'content', 'structure', 'preview'] as const;
export type ExternalDocumentOperation = typeof externalDocumentOperations[number];

export type ExternalDocumentFailureCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'EXPIRED_AUTH'
  | 'REVOKED_AUTH'
  | 'NETWORK_DISABLED'
  | 'LIMIT_EXCEEDED'
  | 'TIMEOUT'
  | 'SOURCE_CHANGED'
  | 'UNSUPPORTED'
  | 'ACQUISITION_FAILED';

export interface ExternalDocumentReference {
  readonly referenceId: string;
  readonly projectId: string;
  readonly sourceWorkItemId: string;
  readonly sourceLinkIdentity: string;
  readonly provider: ExternalDocumentProvider;
  readonly sourceId: string;
  readonly title: string;
  readonly authority: 'REFERENCE_ONLY';
}

export interface ExternalDocumentGrant {
  readonly projectId: string;
  readonly connectorId: string;
  readonly connectorBindingId: string;
  readonly provider: ExternalDocumentProvider;
  readonly credentialRef: string;
  readonly sessionRef: string;
  readonly sourceMode: 'REMOTE' | 'LOCAL_ARTIFACT';
  readonly allowedSourceIds: readonly string[];
  readonly allowedOperations: readonly ExternalDocumentOperation[];
  readonly network: 'allowed' | 'disabled';
  readonly expiresAt: string;
  readonly revoked: boolean;
  readonly outputWorkspaceId: WorkspaceId;
  readonly limits: {
    readonly maxContentBytes: number;
    readonly maxArtifacts: number;
    readonly timeoutMs: number;
  };
}

export interface ExternalDocumentRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly provider: ExternalDocumentProvider;
  readonly operation: ExternalDocumentOperation;
  readonly sourceId: string;
  readonly expectedVersion: string | null;
}

export interface ExternalDocumentProvenance {
  readonly acquisitionId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly connectorId: string;
  readonly connectorBindingId: string;
  readonly provider: ExternalDocumentProvider;
  readonly sourceId: string;
  readonly version: string;
  readonly sourceLinkIdentity: string;
  readonly acquiredAt: string;
}

export interface ExternalDocumentEvidence {
  readonly authority: 'SUPPORTING_EVIDENCE';
  readonly provenance: ExternalDocumentProvenance;
  readonly status: 'complete' | 'partial';
  readonly artifacts: readonly ArtifactReference[];
  readonly contentSha256: string | null;
  readonly failures: readonly ExternalDocumentFailureCode[];
}

export interface ExternalDocumentAdapter<Auth> {
  readonly connectorId: string;
  readonly provider: ExternalDocumentProvider;
  status(signal: AbortSignal): Promise<'available' | 'unavailable'>;
  acquire(request: ExternalDocumentRequest, context: {
    readonly auth: Auth;
    readonly signal: AbortSignal;
    readonly expectedVersion: string | null;
    readonly limits: ExternalDocumentGrant['limits'];
  }): Promise<{
    readonly sourceId: string;
    readonly version: string;
    readonly content: AsyncIterable<Uint8Array>;
    readonly artifacts: readonly ArtifactReference[];
  }>;
}

export class ExternalDocumentContractError extends Error {
  readonly code: ExternalDocumentFailureCode;

  constructor(code: ExternalDocumentFailureCode) {
    super(code);
    this.code = code;
  }
}

const identifier = (value: string): boolean =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);

const opaqueIdentity = (value: string): boolean =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\r\n\0]/.test(value);

function fail(code: ExternalDocumentFailureCode): never {
  throw new ExternalDocumentContractError(code);
}

/**
 * Create an inert supporting-document reference from ADO link metadata.
 *
 * This deliberately requires no connector, credential or network access. A reference may be
 * rendered by Wiki/retrieval before acquisition exists, but it never becomes validated knowledge.
 */
export function createExternalDocumentReference(input: ExternalDocumentReference): ExternalDocumentReference {
  if (!identifier(input.referenceId)
    || !identifier(input.projectId)
    || !identifier(input.sourceWorkItemId)
    || !opaqueIdentity(input.sourceLinkIdentity)
    || !externalDocumentProviders.includes(input.provider)
    || !identifier(input.sourceId)
    || typeof input.title !== 'string'
    || input.title.length === 0
    || input.title.length > 500
    || input.authority !== 'REFERENCE_ONLY') {
    fail('INVALID_REQUEST');
  }

  return Object.freeze({ ...input });
}

/**
 * Bind an acquisition request to a trusted connector grant.
 *
 * The caller supplies no URL, token, headers, path or executable. Provider/source authority is
 * copied only from named fields and checked against a trusted grant. This is a preflight only;
 * runtime connector lookup and commit-time identity checks remain authoritative.
 */
export function bindExternalDocumentAcquisition(
  grant: ExternalDocumentGrant,
  request: ExternalDocumentRequest,
  now: number,
): ExternalDocumentRequest {
  if (!identifier(request.requestId)
    || !identifier(request.projectId)
    || !identifier(request.connectorBindingId)
    || !externalDocumentProviders.includes(request.provider)
    || !externalDocumentOperations.includes(request.operation)
    || !identifier(request.sourceId)
    || (request.expectedVersion !== null && !opaqueIdentity(request.expectedVersion))) {
    fail('INVALID_REQUEST');
  }

  if (!Number.isFinite(now) || !Number.isFinite(Date.parse(grant.expiresAt))) fail('UNAUTHORIZED');
  if (grant.revoked) fail('REVOKED_AUTH');
  if (Date.parse(grant.expiresAt) <= now) fail('EXPIRED_AUTH');

  if (!identifier(grant.projectId)
    || !identifier(grant.connectorId)
    || !identifier(grant.connectorBindingId)
    || !externalDocumentProviders.includes(grant.provider)
    || !opaqueIdentity(grant.credentialRef)
    || !opaqueIdentity(grant.sessionRef)
    || !grant.outputWorkspaceId
    || request.projectId !== grant.projectId
    || request.connectorBindingId !== grant.connectorBindingId
    || request.provider !== grant.provider
    || !grant.allowedSourceIds.includes(request.sourceId)
    || !grant.allowedOperations.includes(request.operation)) {
    fail('UNAUTHORIZED');
  }

  if (grant.sourceMode === 'REMOTE' && grant.network !== 'allowed') fail('NETWORK_DISABLED');
  if (!['REMOTE', 'LOCAL_ARTIFACT'].includes(grant.sourceMode)) fail('UNAUTHORIZED');

  if (Object.values(grant.limits).some(value => !Number.isSafeInteger(value) || value <= 0)
    || grant.allowedSourceIds.length === 0
    || grant.allowedSourceIds.length > 10_000
    || new Set(grant.allowedSourceIds).size !== grant.allowedSourceIds.length
    || grant.allowedOperations.length === 0
    || new Set(grant.allowedOperations).size !== grant.allowedOperations.length) {
    fail('LIMIT_EXCEEDED');
  }

  return Object.freeze({
    requestId: request.requestId,
    projectId: request.projectId,
    connectorBindingId: request.connectorBindingId,
    provider: request.provider,
    operation: request.operation,
    sourceId: request.sourceId,
    expectedVersion: request.expectedVersion,
  });
}
