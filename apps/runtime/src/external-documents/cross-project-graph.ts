import type { CrossSourceLink, CrossSourceNode, CrossSourceRelation } from './revision-correlation.js';

export interface CrossProjectGraphGrant {
  readonly grantId: string;
  readonly allowedProjectIds: readonly string[];
  readonly allowedRelations: readonly CrossSourceRelation[];
  readonly expiresAt: string;
  readonly maxNodes: number;
  readonly maxLinks: number;
}

export interface CrossProjectKnowledgeGraph {
  readonly grantId: string;
  readonly projectIds: readonly string[];
  readonly nodes: readonly CrossSourceNode[];
  readonly links: readonly CrossSourceLink[];
}

export function buildCrossProjectKnowledgeGraph(
  grant: CrossProjectGraphGrant,
  nodesInput: readonly CrossSourceNode[],
  linksInput: readonly CrossSourceLink[],
  now: number,
): CrossProjectKnowledgeGraph {
  validateGrant(grant, now);
  if (!Array.isArray(nodesInput) || !Array.isArray(linksInput)
    || nodesInput.length === 0 || nodesInput.length > grant.maxNodes || linksInput.length > grant.maxLinks) throw new Error('CROSS_PROJECT_GRAPH_LIMIT');
  const allowed = new Set(grant.allowedProjectIds);
  const nodes = new Map<string, CrossSourceNode>();
  for (const node of nodesInput) {
    if (!allowed.has(node.projectId)) throw new Error('CROSS_PROJECT_AUTHORITY_DENIED');
    if (!bounded(node.nodeId) || !bounded(node.projectId) || !opaque(node.sourceIdentity)
      || (node.version !== null && !opaque(node.version))) throw new Error('INVALID_CROSS_PROJECT_NODE');
    const prior = nodes.get(node.nodeId);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(node)) throw new Error('CROSS_PROJECT_NODE_CONFLICT');
    nodes.set(node.nodeId, Object.freeze({ ...node }));
  }
  const links = new Map<string, CrossSourceLink>();
  for (const link of linksInput) {
    if (link.authority !== 'SUPPORTING_EVIDENCE' || !grant.allowedRelations.includes(link.relation)) throw new Error('CROSS_PROJECT_RELATION_DENIED');
    if (!nodes.has(link.fromNodeId) || !nodes.has(link.toNodeId) || link.fromNodeId === link.toNodeId) throw new Error('CROSS_PROJECT_ENDPOINT_INVALID');
    const prior = links.get(link.linkId);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(link)) throw new Error('CROSS_PROJECT_LINK_CONFLICT');
    links.set(link.linkId, Object.freeze({ ...link }));
  }
  return Object.freeze({
    grantId: grant.grantId,
    projectIds: Object.freeze([...new Set([...nodes.values()].map(node => node.projectId))].sort()),
    nodes: Object.freeze([...nodes.values()].sort((a,b)=>a.nodeId.localeCompare(b.nodeId))),
    links: Object.freeze([...links.values()].sort((a,b)=>a.linkId.localeCompare(b.linkId))),
  });
}

function validateGrant(grant: CrossProjectGraphGrant, now: number): void {
  if (!bounded(grant.grantId) || !Array.isArray(grant.allowedProjectIds) || grant.allowedProjectIds.length < 2
    || grant.allowedProjectIds.length > 100 || new Set(grant.allowedProjectIds).size !== grant.allowedProjectIds.length
    || grant.allowedProjectIds.some(id => !bounded(id)) || !Array.isArray(grant.allowedRelations)
    || grant.allowedRelations.length === 0 || new Set(grant.allowedRelations).size !== grant.allowedRelations.length
    || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now
    || !Number.isSafeInteger(grant.maxNodes) || grant.maxNodes <= 0 || grant.maxNodes > 50_000
    || !Number.isSafeInteger(grant.maxLinks) || grant.maxLinks < 0 || grant.maxLinks > 100_000) throw new Error('INVALID_CROSS_PROJECT_GRANT');
}
const bounded = (value: string) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const opaque = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\r\n\0]/.test(value);
