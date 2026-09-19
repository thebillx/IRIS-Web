import {
  knowledgeAssert, knowledgeHash, knowledgeId, normalizeProvenance, workItemKey,
  type KnowledgeProvenance, type KnowledgeWorkItem,
} from './ado-knowledge-provenance.js';

export interface KnowledgeGraphNode {
  readonly item: KnowledgeWorkItem;
  readonly provenance: KnowledgeProvenance;
}

export type KnowledgeEdge = {
  readonly source: KnowledgeWorkItem;
  readonly provenance: KnowledgeProvenance;
} & (
  | { readonly type: 'PARENT' | 'CHILD' | 'RELATED' | 'DEPENDS_ON'; readonly target: KnowledgeWorkItem }
  | { readonly type: 'EXTERNAL_SUPPORTING_REFERENCE'; readonly target: { readonly referenceId: string } }
);

export interface KnowledgeHierarchyNode {
  readonly key: string;
  readonly parents: readonly string[];
  readonly children: readonly string[];
}

export interface KnowledgeGraphIssue {
  readonly kind: 'ORPHAN' | 'SELF_LINK' | 'MULTIPLE_PARENTS' | 'CYCLE';
  readonly domain: 'HIERARCHY' | 'RELATION';
  readonly nodeKeys: readonly string[];
}

export interface KnowledgeGraph {
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeEdge[];
  readonly hierarchy: readonly KnowledgeHierarchyNode[];
  readonly roots: readonly string[];
  readonly issues: readonly KnowledgeGraphIssue[];
  readonly validHierarchy: boolean;
}

export function createKnowledgeEdge(input: Omit<KnowledgeEdge, 'provenance'> & {
  readonly provenance: Omit<KnowledgeProvenance, 'contentHash'>;
}): KnowledgeEdge {
  workItemKey(input.source);
  let edge: KnowledgeEdge;
  if (input.type === 'EXTERNAL_SUPPORTING_REFERENCE') {
    knowledgeAssert('referenceId' in input.target, 'External relation requires supporting reference');
    const target = { referenceId: knowledgeId(input.target.referenceId) };
    edge = { source: { scopeId: input.source.scopeId, workItemId: input.source.workItemId }, type: input.type, target,
      provenance: normalizeProvenance({ ...input.provenance, contentHash: knowledgeHash(JSON.stringify([input.type, target])) }) };
  } else {
    knowledgeAssert(['PARENT', 'CHILD', 'RELATED', 'DEPENDS_ON'].includes(input.type)
      && 'workItemId' in input.target, 'Invalid work item relation');
    workItemKey(input.target);
    const target = { scopeId: input.target.scopeId, workItemId: input.target.workItemId };
    edge = { source: { scopeId: input.source.scopeId, workItemId: input.source.workItemId }, type: input.type, target,
      provenance: normalizeProvenance({ ...input.provenance, contentHash: knowledgeHash(JSON.stringify([input.type, target])) }) };
  }
  knowledgeAssert(edge.provenance.source.kind === 'RELATION'
    && workItemKey(edge.provenance.sourceWorkItem) === workItemKey(edge.source), 'Edge provenance must identify its source relation');
  return edge;
}

export function buildKnowledgeGraph(nodes: readonly KnowledgeGraphNode[], edges: readonly KnowledgeEdge[]): KnowledgeGraph {
  knowledgeAssert(Array.isArray(nodes) && nodes.length <= 10_000 && Array.isArray(edges) && edges.length <= 50_000, 'Graph exceeds bounded limits');
  const known = new Map<string, KnowledgeGraphNode>();
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  for (const node of nodes) {
    const key = workItemKey(node.item);
    const provenance = normalizeProvenance(node.provenance);
    knowledgeAssert(!known.has(key) && workItemKey(provenance.sourceWorkItem) === key, 'Duplicate node or mismatched node provenance');
    known.set(key, { item: { ...provenance.sourceWorkItem }, provenance });
    parents.set(key, new Set());
    children.set(key, new Set());
  }
  const issues: KnowledgeGraphIssue[] = [];
  const missing = new Set<string>();
  const hierarchyMissing = new Set<string>();
  const normalizedEdges: KnowledgeEdge[] = [];
  const relationIdentities = new Set<string>();
  for (const edge of edges) {
    const source = workItemKey(edge.source);
    const provenance = normalizeProvenance(edge.provenance);
    knowledgeAssert(provenance.source.kind === 'RELATION' && workItemKey(provenance.sourceWorkItem) === source, 'Edge provenance must identify its source relation');
    const normalized = createKnowledgeEdge(edge);
    knowledgeAssert(normalized.provenance.contentHash === provenance.contentHash, 'Edge content hash mismatch');
    knowledgeAssert(!known.has(source) || known.get(source)!.provenance.revision === provenance.revision, 'Edge and source node revisions differ');
    const relationIdentity = JSON.stringify([source, provenance.revision, provenance.source.relationId]);
    knowledgeAssert(!relationIdentities.has(relationIdentity), 'Duplicate source relation identity');
    relationIdentities.add(relationIdentity);
    if (!known.has(source)) missing.add(source);
    if (edge.type === 'EXTERNAL_SUPPORTING_REFERENCE') {
      normalizedEdges.push({ source: { ...provenance.sourceWorkItem }, type: edge.type,
        target: { referenceId: knowledgeId(edge.target.referenceId) }, provenance });
      continue;
    }
    knowledgeAssert(['PARENT', 'CHILD', 'RELATED', 'DEPENDS_ON'].includes(edge.type), 'Unknown relation type');
    const target = workItemKey(edge.target);
    knowledgeAssert(edge.source.scopeId === edge.target.scopeId, 'Cross-scope work item relation requires an external reference');
    if (!known.has(target)) missing.add(target);
    normalizedEdges.push({ source: { ...provenance.sourceWorkItem }, type: edge.type,
      target: { scopeId: edge.target.scopeId, workItemId: edge.target.workItemId }, provenance });
    if (edge.type !== 'PARENT' && edge.type !== 'CHILD') continue;
    if (!known.has(source)) hierarchyMissing.add(source);
    if (!known.has(target)) hierarchyMissing.add(target);
    const parent = edge.type === 'CHILD' ? source : target;
    const child = edge.type === 'CHILD' ? target : source;
    if (parent === child) issues.push({ kind: 'SELF_LINK', domain: 'HIERARCHY', nodeKeys: [parent] });
    parents.get(child)?.add(parent);
    children.get(parent)?.add(child);
  }
  for (const key of [...missing].sort()) issues.push({ kind: 'ORPHAN', domain: hierarchyMissing.has(key) ? 'HIERARCHY' : 'RELATION', nodeKeys: [key] });
  for (const [key, incoming] of parents) {
    if (incoming.size > 1) issues.push({ kind: 'MULTIPLE_PARENTS', domain: 'HIERARCHY', nodeKeys: [key, ...[...incoming].sort()] });
  }
  const colors = new Map<string, 'ACTIVE' | 'DONE'>();
  let cycleReported = false;
  for (const root of [...known.keys()].sort()) {
    if (colors.has(root)) continue;
    const stack: { key: string; next: number; targets: string[] }[] = [{ key: root, next: 0, targets: [...children.get(root) ?? []].sort() }];
    const active = new Map<string, number>([[root, 0]]);
    colors.set(root, 'ACTIVE');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const target = frame.targets[frame.next++];
      if (target === undefined) {
        colors.set(frame.key, 'DONE');
        active.delete(frame.key);
        stack.pop();
      } else if (colors.get(target) === 'ACTIVE') {
        if (!cycleReported) {
          issues.push({ kind: 'CYCLE', domain: 'HIERARCHY', nodeKeys: [...stack.slice(active.get(target)!).map(entry => entry.key), target] });
          cycleReported = true;
        }
      } else if (known.has(target) && !colors.has(target)) {
        active.set(target, stack.length);
        colors.set(target, 'ACTIVE');
        stack.push({ key: target, next: 0, targets: [...children.get(target) ?? []].sort() });
      }
    }
  }
  const hierarchy = [...known.keys()].sort().map(key => ({ key, parents: [...parents.get(key)!].sort(), children: [...children.get(key)!].sort() }));
  return { nodes: [...known.values()], edges: normalizedEdges, hierarchy,
    roots: hierarchy.filter(node => node.parents.length === 0).map(node => node.key), issues,
    validHierarchy: !issues.some(issue => issue.domain === 'HIERARCHY') };
}
