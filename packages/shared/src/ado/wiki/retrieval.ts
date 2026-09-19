import type { Authority, BuildState, KnowledgeConcept, Provenance } from './models.js';

export type RetrievalQuery = Readonly<{
  id?: string;
  title?: string;
  topic?: string;
  hierarchy?: string;
  iteration?: string;
  release?: string;
  keyword?: string;
  relatedToConceptId?: string;
  includeSupportingEvidence?: boolean;
}>;
export type AgentAnswer = Readonly<{
  answer: string;
  knowledgeStatus: 'PROMOTED' | 'SUPPORTING_EVIDENCE';
  authority: Authority;
  conceptId: string;
  topicId: string;
  provenance: readonly Provenance[];
}>;
export type AgentQueryResponse = Readonly<{
  status: 'ANSWERED' | 'INSUFFICIENT_EVIDENCE' | 'INVALID_QUERY';
  answer: string;
  claims: readonly AgentAnswer[];
  policyVersion: string;
}>;

function matches(value: string, query: string | undefined): boolean {
  return query === undefined || value.toLowerCase().includes(query.trim().toLowerCase());
}

function eligible(concept: KnowledgeConcept, includeSupporting: boolean): boolean {
  if (!concept.provenance.length || concept.provenance.some(citation => !['PROMOTED', 'SUPPORTING_EVIDENCE'].includes(citation.status))) return false;
  if (concept.authority === 'SUPPORTING_EVIDENCE') return includeSupporting && concept.category === 'QA_REFERENCE';
  return concept.authority === 'VALIDATED_KNOWLEDGE' && concept.category !== 'QA_REFERENCE'
    && concept.provenance.every(citation => citation.status === 'PROMOTED');
}

export function queryKnowledge(state: BuildState, query: RetrievalQuery): AgentQueryResponse {
  const empty = (status: 'INSUFFICIENT_EVIDENCE' | 'INVALID_QUERY'): AgentQueryResponse => ({
    status, answer: '', claims: [], policyVersion: state.policyVersion,
  });
  if (!query || Object.entries(query).some(([key, value]) => key === 'includeSupportingEvidence'
    ? typeof value !== 'boolean'
    : !['id', 'title', 'topic', 'hierarchy', 'iteration', 'release', 'keyword', 'relatedToConceptId'].includes(key)
      || typeof value !== 'string' || !value.trim())) return empty('INVALID_QUERY');
  const corpus = state.concepts.filter(concept => eligible(concept, query.includeSupportingEvidence ?? true));
  const related = query.relatedToConceptId === undefined ? undefined
    : corpus.find(concept => concept.aliasIds.includes(query.relatedToConceptId!));
  if (query.relatedToConceptId !== undefined && !related) return empty('INSUFFICIENT_EVIDENCE');
  const found = corpus.filter(concept => {
    const topic = state.topics.find(candidate => candidate.id === concept.topicId);
    return (query.id === undefined || concept.aliasIds.includes(query.id) || concept.provenance.some(citation => citation.reference.workItemId === query.id))
      && (query.title === undefined || concept.titles.some(title => matches(title, query.title)))
      && (query.topic === undefined || matches(concept.topicId, query.topic) || matches(topic?.title ?? '', query.topic))
      && (query.hierarchy === undefined || [...concept.hierarchyIds, ...concept.hierarchyTitles].some(value => matches(value, query.hierarchy)))
      && (query.iteration === undefined || concept.iterations.some(value => matches(value, query.iteration)))
      && (query.release === undefined || concept.releases.some(value => matches(value, query.release)))
      && matches([concept.text, ...concept.titles].join(' '), query.keyword)
      && (!related || concept.topicId === related.topicId || concept.hierarchyIds.some(id => related.hierarchyIds.includes(id)));
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (!found.length) return empty('INSUFFICIENT_EVIDENCE');
  const claims: AgentAnswer[] = found.map(concept => ({ answer: concept.text,
    knowledgeStatus: concept.authority === 'VALIDATED_KNOWLEDGE' ? 'PROMOTED' : 'SUPPORTING_EVIDENCE',
    authority: concept.authority, conceptId: concept.id, topicId: concept.topicId, provenance: structuredClone(concept.provenance) }));
  return { status: 'ANSWERED', answer: claims.map(claim => `[${claim.authority}] ${claim.answer}`).join('\n'),
    claims, policyVersion: state.policyVersion };
}
