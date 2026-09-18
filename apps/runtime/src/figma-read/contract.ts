import type { ArtifactReference, WorkspaceId } from '@iris/domain';

export const readOperations = [
  'connector.status', 'connector.capabilities', 'figma.get_file_metadata',
  'figma.get_page_or_node', 'figma.get_design_context', 'figma.get_screenshot',
] as const;
export type ReadOperation = typeof readOperations[number];
export type EvidenceKind = 'pages' | 'frames' | 'nodes' | 'components' | 'text'
  | 'cta_labels' | 'validation_states' | 'error_states' | 'variants'
  | 'annotations' | 'screenshots' | 'design_context';
export type FailureCode = 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'EXPIRED_AUTH'
  | 'REVOKED_AUTH' | 'NETWORK_DISABLED' | 'LIMIT_EXCEEDED' | 'TIMEOUT'
  | 'SOURCE_CHANGED' | 'UNSUPPORTED' | 'ACQUISITION_FAILED';

/** Trusted authority output; never deserialize this as a caller-supplied grant. */
export interface ReadGrant {
  readonly projectId: string;
  readonly connectorId: string;
  readonly connectorBindingId: string;
  readonly credentialRef: string;
  readonly sessionRef: string;
  readonly organizationId: string;
  readonly fileKeys: readonly string[];
  readonly nodeIds: readonly string[];
  readonly network: 'allowed' | 'disabled';
  readonly expiresAt: string;
  readonly revoked: boolean;
  readonly outputWorkspaceId: WorkspaceId;
  readonly limits: { readonly metadataBytes: number; readonly screenshotBytes: number;
    readonly maxNodes: number; readonly maxDepth: number; readonly timeoutMs: number };
}
export interface ReadRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly operation: ReadOperation;
  readonly fileKey: string;
  readonly nodeIds: readonly string[];
  readonly depth: number;
}
export interface Provenance {
  readonly acquisitionId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly connectorId: string;
  readonly connectorBindingId: string;
  readonly operation: ReadOperation;
  readonly source: { readonly provider: 'figma'; readonly organizationId: string;
    readonly fileKey: string; readonly nodeIds: readonly string[]; readonly version: string };
  readonly acquiredAt: string;
  readonly resumedFrom: string | null;
}
export interface ReadResult {
  readonly provenance: Provenance;
  readonly status: 'complete' | 'partial';
  readonly artifacts: readonly ArtifactReference[];
  readonly evidence: readonly { readonly kind: EvidenceKind;
    readonly availability: 'acquired' | 'unsupported' | 'inaccessible' | 'failed';
    readonly artifactIds: readonly ArtifactReference['artifactId'][] }[];
  readonly failures: readonly FailureCode[];
}
export interface ConnectorCapabilities {
  readonly operations: readonly ReadOperation[];
  readonly evidence: Readonly<Record<EvidenceKind, 'supported' | 'unsupported' | 'conditional'>>;
  readonly surface: 'rest' | 'mcp';
  readonly versionPinning: boolean;
}
/** Internal transport boundary only. Materialized auth must never enter public DTOs. */
export interface FigmaReadAdapter<Auth> {
  readonly connectorId: string;
  status(signal: AbortSignal): Promise<'available' | 'unavailable'>;
  capabilities(): ConnectorCapabilities;
  acquire(request: ReadRequest, context: {
    readonly auth: Auth;
    readonly signal: AbortSignal;
    readonly expectedOrganizationId: string;
    readonly expectedVersion: string | null;
    readonly limits: ReadGrant['limits'];
  }): Promise<{
    readonly organizationId: string;
    readonly fileKey: string;
    readonly version: string;
    readonly metadata: AsyncIterable<Uint8Array>;
    readonly screenshot: AsyncIterable<Uint8Array> | null;
    readonly evidence: ReadResult['evidence'];
  }>;
}

export class ContractError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(code); this.code = code; }
}
/** Pure preflight, not a replacement for trusted grant lookup or commit-time checks. */
export function bindRead(grant: ReadGrant, request: ReadRequest, now: number): ReadRequest {
  const fail = (code: FailureCode): never => { throw new ContractError(code); };
  if (!readOperations.includes(request.operation) || !/^[A-Za-z0-9]+$/.test(request.fileKey)
    || !request.requestId || request.requestId.length > 200
    || !Array.isArray(request.nodeIds) || request.nodeIds.some(id => !/^\d+:\d+$/.test(id))
    || new Set(request.nodeIds).size !== request.nodeIds.length
    || !Number.isSafeInteger(request.depth) || request.depth < 0) fail('INVALID_REQUEST');
  if (!Number.isFinite(now) || !Number.isFinite(Date.parse(grant.expiresAt))) fail('UNAUTHORIZED');
  if (grant.revoked) fail('REVOKED_AUTH');
  if (Date.parse(grant.expiresAt) <= now) fail('EXPIRED_AUTH');
  if (grant.network !== 'allowed') fail('NETWORK_DISABLED');
  if (!grant.credentialRef || !grant.sessionRef || !grant.connectorId || !grant.organizationId
    || !grant.outputWorkspaceId || request.projectId !== grant.projectId
    || request.connectorBindingId !== grant.connectorBindingId
    || !grant.fileKeys.includes(request.fileKey)
    || request.nodeIds.some(id => !grant.nodeIds.includes(id))) fail('UNAUTHORIZED');
  if (Object.values(grant.limits).some(n => !Number.isSafeInteger(n) || n <= 0)
    || request.nodeIds.length > grant.limits.maxNodes || request.depth > grant.limits.maxDepth) fail('LIMIT_EXCEEDED');
  if (request.operation.startsWith('figma.') && request.operation !== 'figma.get_file_metadata'
    && request.nodeIds.length === 0) fail('INVALID_REQUEST');
  // Copy only named fields. No URL, token, arbitrary headers or mutable caller arrays cross this boundary.
  return Object.freeze({ requestId: request.requestId, projectId: request.projectId,
    connectorBindingId: request.connectorBindingId, operation: request.operation,
    fileKey: request.fileKey, nodeIds: Object.freeze([...request.nodeIds]), depth: request.depth });
}
