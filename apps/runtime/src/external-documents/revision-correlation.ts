import { createHash } from 'node:crypto';
import type { ExternalDocumentEvidence } from './contract.js';

export interface ExternalRevisionSnapshot {
  readonly projectId: string;
  readonly provider: ExternalDocumentEvidence['provenance']['provider'];
  readonly sourceId: string;
  readonly sourceLinkIdentity: string;
  readonly version: string;
  readonly acquiredAt: string;
  readonly contentSha256: string | null;
  readonly artifactIds: readonly string[];
}

export type ExternalRevisionChange = 'UNCHANGED' | 'METADATA_CHANGED' | 'CONTENT_CHANGED';

export interface ExternalRevisionDiff {
  readonly diffId: string;
  readonly state: ExternalRevisionChange;
  readonly versionChanged: boolean;
  readonly contentChanged: boolean;
  readonly artifactsChanged: boolean;
  readonly previous: ExternalRevisionSnapshot;
  readonly current: ExternalRevisionSnapshot;
}

export function externalRevisionFromEvidence(evidence: ExternalDocumentEvidence): ExternalRevisionSnapshot {
  const snapshot: ExternalRevisionSnapshot = {
    projectId: evidence.provenance.projectId,
    provider: evidence.provenance.provider,
    sourceId: evidence.provenance.sourceId,
    sourceLinkIdentity: evidence.provenance.sourceLinkIdentity,
    version: evidence.provenance.version,
    acquiredAt: evidence.provenance.acquiredAt,
    contentSha256: evidence.contentSha256,
    artifactIds: evidence.artifacts.map(artifact => String(artifact.artifactId)).sort(),
  };
  validateRevision(snapshot);
  return Object.freeze({ ...snapshot, artifactIds: Object.freeze([...snapshot.artifactIds]) });
}

export function compareExternalRevisions(
  previous: ExternalRevisionSnapshot,
  current: ExternalRevisionSnapshot,
): ExternalRevisionDiff {
  validateRevision(previous); validateRevision(current);
  if (identity(previous) !== identity(current)) throw new Error('EXTERNAL_REVISION_IDENTITY_MISMATCH');
  if (Date.parse(current.acquiredAt) < Date.parse(previous.acquiredAt)) throw new Error('EXTERNAL_REVISION_OUT_OF_ORDER');
  const versionChanged = current.version !== previous.version;
  const contentChanged = current.contentSha256 !== previous.contentSha256;
  const artifactsChanged = JSON.stringify(current.artifactIds) !== JSON.stringify(previous.artifactIds);
  const state: ExternalRevisionChange = contentChanged ? 'CONTENT_CHANGED'
    : versionChanged || artifactsChanged ? 'METADATA_CHANGED' : 'UNCHANGED';
  return Object.freeze({
    diffId: 'external-diff:' + digest([previous, current]).slice(0, 32),
    state, versionChanged, contentChanged, artifactsChanged,
    previous: structuredClone(previous), current: structuredClone(current),
  });
}

export const crossSourceKinds = [
  'ADO_WORK_ITEM', 'EXTERNAL_DOCUMENT', 'BUG', 'TEST_CASE', 'PULL_REQUEST', 'COMMIT', 'BUILD',
] as const;
export type CrossSourceKind = typeof crossSourceKinds[number];
export type CrossSourceRelation = 'SUPPORTS' | 'VERIFIES' | 'IMPLEMENTS' | 'DERIVED_FROM';

export interface CrossSourceNode {
  readonly nodeId: string;
  readonly projectId: string;
  readonly kind: CrossSourceKind;
  readonly sourceIdentity: string;
  readonly version: string | null;
}

export interface CrossSourceLink {
  readonly linkId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly relation: CrossSourceRelation;
  readonly authority: 'SUPPORTING_EVIDENCE';
}

export interface CrossSourceCorrelationGraph {
  readonly projectId: string;
  readonly nodes: readonly CrossSourceNode[];
  readonly links: readonly CrossSourceLink[];
}

/**
 * Build a same-project evidence correlation graph. This records traceability only: every edge remains
 * SUPPORTING_EVIDENCE and cannot promote Bug/Test/PR/Commit/Build/external content to requirement truth.
 * Cross-project edges are deliberately reserved for M9-E.
 */
export function buildCrossSourceCorrelation(
  nodesInput: readonly CrossSourceNode[],
  linksInput: readonly CrossSourceLink[],
): CrossSourceCorrelationGraph {
  if (!Array.isArray(nodesInput) || !Array.isArray(linksInput) || nodesInput.length === 0
    || nodesInput.length > 20_000 || linksInput.length > 50_000) throw new Error('CORRELATION_LIMIT');
  const nodes = new Map<string, CrossSourceNode>();
  let projectId: string | null = null;
  for (const node of nodesInput) {
    validateNode(node);
    if (projectId === null) projectId = node.projectId;
    if (node.projectId !== projectId) throw new Error('CROSS_PROJECT_CORRELATION_DENIED');
    const prior = nodes.get(node.nodeId);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(node)) throw new Error('CORRELATION_NODE_CONFLICT');
    nodes.set(node.nodeId, Object.freeze({ ...node }));
  }
  const links = new Map<string, CrossSourceLink>();
  for (const link of linksInput) {
    validateLink(link);
    if (!nodes.has(link.fromNodeId) || !nodes.has(link.toNodeId) || link.fromNodeId === link.toNodeId) throw new Error('CORRELATION_ENDPOINT_INVALID');
    const prior = links.get(link.linkId);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(link)) throw new Error('CORRELATION_LINK_CONFLICT');
    links.set(link.linkId, Object.freeze({ ...link }));
  }
  return Object.freeze({
    projectId: projectId!,
    nodes: Object.freeze([...nodes.values()].sort((a,b)=>a.nodeId.localeCompare(b.nodeId))),
    links: Object.freeze([...links.values()].sort((a,b)=>a.linkId.localeCompare(b.linkId))),
  });
}

function validateRevision(value: ExternalRevisionSnapshot): void {
  if (!boundedId(value.projectId) || !boundedId(value.sourceId) || !boundedOpaque(value.sourceLinkIdentity)
    || !boundedOpaque(value.version) || !validTimestamp(value.acquiredAt)
    || (value.contentSha256 !== null && !/^[a-f0-9]{64}$/.test(value.contentSha256))
    || !Array.isArray(value.artifactIds) || value.artifactIds.length > 10_000
    || value.artifactIds.some(item => !boundedOpaque(item))
    || new Set(value.artifactIds).size !== value.artifactIds.length) throw new Error('INVALID_EXTERNAL_REVISION');
}

function validateNode(node: CrossSourceNode): void {
  if (!boundedId(node.nodeId) || !boundedId(node.projectId) || !crossSourceKinds.includes(node.kind)
    || !boundedOpaque(node.sourceIdentity) || (node.version !== null && !boundedOpaque(node.version))) throw new Error('INVALID_CORRELATION_NODE');
}

function validateLink(link: CrossSourceLink): void {
  if (!boundedId(link.linkId) || !boundedId(link.fromNodeId) || !boundedId(link.toNodeId)
    || !['SUPPORTS','VERIFIES','IMPLEMENTS','DERIVED_FROM'].includes(link.relation)
    || link.authority !== 'SUPPORTING_EVIDENCE') throw new Error('INVALID_CORRELATION_LINK');
}

const boundedId = (value: string): boolean => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const boundedOpaque = (value: string): boolean => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\r\n\0]/.test(value);
const validTimestamp = (value: string): boolean => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const identity = (value: ExternalRevisionSnapshot): string => JSON.stringify([value.projectId,value.provider,value.sourceId,value.sourceLinkIdentity]);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
