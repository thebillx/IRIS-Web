import { createHash } from 'node:crypto';
import type { ArtifactReference, WorkspaceId } from '@iris/domain';

export type AdoWikiWriteOperation = 'CREATE' | 'UPDATE';

export interface AdoWikiWriteGrant {
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly wikiId: string;
  readonly outputWorkspaceId: WorkspaceId;
  readonly allowedPathPrefixes: readonly string[];
  readonly operations: readonly AdoWikiWriteOperation[];
  readonly expiresAt: string;
  readonly enabled: boolean;
  readonly maxArtifactBytes: number;
}

export interface AdoWikiWriteRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly wikiId: string;
  readonly operation: AdoWikiWriteOperation;
  readonly targetPath: string;
  readonly expectedRemoteVersion: string | null;
  readonly artifact: ArtifactReference;
}

export interface BoundAdoWikiWriteIntent {
  readonly requestId: string;
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly wikiId: string;
  readonly operation: AdoWikiWriteOperation;
  readonly targetPath: string;
  readonly expectedRemoteVersion: string | null;
  readonly artifactId: string;
  readonly artifactSha256: string;
  readonly artifactSize: number;
  readonly intentDigest: string;
  readonly requiresOwnerApproval: true;
  readonly transportEnabled: false;
}

/**
 * Prepare an exact Azure DevOps Wiki write-back intent without executing any network mutation.
 *
 * The rendered Wiki body must already exist as a governed artifact. The target page, remote version,
 * artifact identity and digest are immutable in the returned intent. Existing CapabilityService owner
 * approval remains the required authority before any future transport is added.
 */
export function bindAdoWikiWriteBack(
  grant: AdoWikiWriteGrant,
  request: AdoWikiWriteRequest,
  now: number,
): BoundAdoWikiWriteIntent {
  validateGrant(grant, now);
  if (!bounded(request.requestId) || !bounded(request.projectId) || !bounded(request.connectorBindingId)
    || !bounded(request.wikiId) || !['CREATE','UPDATE'].includes(request.operation)
    || request.projectId !== grant.projectId || request.connectorBindingId !== grant.connectorBindingId
    || request.wikiId !== grant.wikiId || !grant.operations.includes(request.operation)) throw new Error('ADO_WIKI_WRITE_UNAUTHORIZED');
  validateTargetPath(request.targetPath);
  if (!grant.allowedPathPrefixes.some(prefix => pathWithin(prefix, request.targetPath))) throw new Error('ADO_WIKI_PATH_DENIED');
  if (request.operation === 'CREATE' && request.expectedRemoteVersion !== null) throw new Error('ADO_WIKI_VERSION_CONFLICT');
  if (request.operation === 'UPDATE' && !opaque(request.expectedRemoteVersion)) throw new Error('ADO_WIKI_VERSION_REQUIRED');
  validateArtifact(request.artifact, grant);
  const artifactId = String(request.artifact.artifactId);
  const digest = createHash('sha256').update(JSON.stringify([
    request.projectId, request.connectorBindingId, request.wikiId, request.operation, request.targetPath,
    request.expectedRemoteVersion, artifactId, request.artifact.sha256, request.artifact.size,
  ])).digest('hex');
  return Object.freeze({
    requestId: request.requestId, projectId: request.projectId, connectorBindingId: request.connectorBindingId,
    wikiId: request.wikiId, operation: request.operation, targetPath: request.targetPath,
    expectedRemoteVersion: request.expectedRemoteVersion, artifactId, artifactSha256: request.artifact.sha256,
    artifactSize: request.artifact.size, intentDigest: digest, requiresOwnerApproval: true, transportEnabled: false,
  });
}

function validateGrant(grant: AdoWikiWriteGrant, now: number): void {
  if (!grant.enabled) throw new Error('ADO_WIKI_WRITE_DISABLED');
  if (!bounded(grant.projectId) || !bounded(grant.connectorBindingId) || !bounded(grant.wikiId)
    || !grant.outputWorkspaceId || !Array.isArray(grant.allowedPathPrefixes) || grant.allowedPathPrefixes.length === 0
    || grant.allowedPathPrefixes.length > 100 || grant.allowedPathPrefixes.some(prefix => { try { validateTargetPath(prefix); return false; } catch { return true; } })
    || !Array.isArray(grant.operations) || grant.operations.length === 0 || new Set(grant.operations).size !== grant.operations.length
    || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now
    || !Number.isSafeInteger(grant.maxArtifactBytes) || grant.maxArtifactBytes <= 0) throw new Error('INVALID_ADO_WIKI_WRITE_GRANT');
}

function validateArtifact(artifact: ArtifactReference, grant: AdoWikiWriteGrant): void {
  if (artifact.projectId !== grant.projectId || artifact.workspaceId !== grant.outputWorkspaceId
    || artifact.size <= 0 || artifact.size > grant.maxArtifactBytes
    || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || !['text/markdown','text/plain'].includes(artifact.mime)) throw new Error('ADO_WIKI_ARTIFACT_DENIED');
}

function validateTargetPath(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000 || !value.startsWith('/')
    || value.includes('\\') || value.includes('\0') || value.includes('?') || value.includes('#')
    || value.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('INVALID_ADO_WIKI_PATH');
}

function pathWithin(prefix: string, target: string): boolean {
  const normalized = prefix.endsWith('/') && prefix !== '/' ? prefix.slice(0,-1) : prefix;
  return target === normalized || target.startsWith(normalized === '/' ? '/' : normalized + '/');
}
const bounded = (value: string) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const opaque = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\r\n\0]/.test(value);
