import { knowledgeCategories, type Classification, type KnowledgeCategory, type Signal, type SourceReference } from './models.js';

export const truthStatuses = ['DUPLICATE', 'SUPERSEDED', 'CURRENT', 'CONFLICTING', 'AMBIGUOUS', 'NEEDS_REVIEW'] as const;
export type TruthStatus = typeof truthStatuses[number];
export type Claim = Readonly<{
  id: string;
  text: string;
  category: KnowledgeCategory;
  references: readonly SourceReference[];
  supersedes: readonly string[];
  ambiguous: boolean;
}>;
export type ConceptResolution = Readonly<{
  conceptId: string;
  status: TruthStatus;
  reasonCodes: readonly string[];
  sourceReferences: readonly SourceReference[];
  currentReferences: readonly SourceReference[];
  historicalReferences: readonly SourceReference[];
  currentClaim: Claim | null;
  claimStates: readonly Readonly<{ id: string; status: TruthStatus }>[];
  signals: readonly Signal[];
}>;

function references(claims: readonly Claim[]): SourceReference[] {
  const unique = new Map<string, SourceReference>();
  for (const claim of claims) for (const reference of claim.references) {
    unique.set(JSON.stringify([reference.source, reference.id, reference.revision]), { ...reference });
  }
  return Array.from(unique.values()).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function resolveConcept(conceptId: string, claims: readonly Claim[]): ConceptResolution {
  const allReferences = references(claims);
  const finish = (status: TruthStatus, reason: string, current: readonly Claim[] = [], historical: readonly Claim[] = []): ConceptResolution => ({
    conceptId, status, reasonCodes: [reason], sourceReferences: allReferences,
    currentReferences: references(current), historicalReferences: references(historical),
    currentClaim: current[0] ?? null,
    claimStates: [...claims].sort((left, right) => left.id.localeCompare(right.id)).map(claim => ({ id: claim.id,
      status: historical.includes(claim) ? 'SUPERSEDED' : status })),
    signals: [{ code: status, weight: status === 'CURRENT' ? 0 : -20, evidence: reason }],
  });
  const ids = new Set(claims.map(claim => claim.id));
  if (!conceptId.trim() || !claims.length || ids.size !== claims.length || claims.some(claim => !claim.id.trim()
    || !claim.text.trim() || !knowledgeCategories.includes(claim.category) || !claim.references.length || claim.references.some(reference =>
      !reference.source.trim() || !reference.id.trim() || !reference.revision.trim())
    || claim.supersedes.some(id => !ids.has(id) || id === claim.id))) return finish('NEEDS_REVIEW', 'INVALID_CLAIM_GRAPH');
  const byId = new Map(claims.map(claim => [claim.id, claim]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (byId.get(id)!.supersedes.some(cycle)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (claims.some(claim => cycle(claim.id))) return finish('NEEDS_REVIEW', 'SUPERSESSION_CYCLE');
  const supersededIds = new Set(claims.flatMap(claim => [...claim.supersedes]));
  const current = claims.filter(claim => !supersededIds.has(claim.id)).sort((left, right) => left.id.localeCompare(right.id));
  const historical = claims.filter(claim => supersededIds.has(claim.id));
  if (current.some(claim => claim.ambiguous)) return finish('AMBIGUOUS', 'AMBIGUOUS_CURRENT_CLAIM', [], historical);
  const signatures = new Set(current.map(claim => JSON.stringify([claim.category, claim.text.trim().replace(/\s+/g, ' ')])));
  if (signatures.size > 1) return finish('CONFLICTING', 'DIVERGENT_CURRENT_CLAIMS', [], historical);
  return finish(current.length > 1 ? 'DUPLICATE' : 'CURRENT', historical.length ? 'EXPLICIT_SUPERSESSION' : 'EXACT_CLAIM_IDENTITY', current, historical);
}

export type Projection = 'PRIMARY_KNOWLEDGE_STORE' | 'GRAPH_CONTEXT' | 'EVIDENCE_INDEX' | 'AUDIT_QUARANTINE';
export function projectionFor(classification: Classification, truth: TruthStatus = 'CURRENT'): Projection {
  if (!['CURRENT', 'DUPLICATE'].includes(truth)) return 'AUDIT_QUARANTINE';
  switch (classification.status) {
    case 'PROMOTED': return 'PRIMARY_KNOWLEDGE_STORE';
    case 'CONTEXT_ONLY': return 'GRAPH_CONTEXT';
    case 'SUPPORTING_EVIDENCE': return 'EVIDENCE_INDEX';
    default: return 'AUDIT_QUARANTINE';
  }
}

export function includedInDefaultRetrieval(classification: Classification, truth: TruthStatus = 'CURRENT'): boolean {
  return projectionFor(classification, truth) === 'PRIMARY_KNOWLEDGE_STORE';
}
