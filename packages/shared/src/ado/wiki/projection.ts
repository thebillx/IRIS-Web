import { createHash } from 'node:crypto';
import { categories, type BuildInput, type BuildState, type Candidate, type Category, type DependencyGraph, type Issue,
  type KnowledgeConcept, type Provenance, type Result, type SectionPolicy, type SourceFragment,
  type SourceIdentity, type SourceReference, type WikiTopic } from './models.js';

export const defaultSectionPolicy: SectionPolicy = {
  version: 'ado-wiki/v1',
  sections: [
    { id: 'overview', title: 'Overview', categories: ['FEATURE_OVERVIEW', 'FUNCTIONAL_BEHAVIOR', 'DEPENDENCIES', 'INTEGRATION', 'KNOWN_LIMITATION', 'PRODUCT_CONFIGURATION', 'RELEASE_INFORMATION', 'RELEASE_CHANGE'] },
    { id: 'business-rules', title: 'Business Rules', categories: ['BUSINESS_RULE'] },
    { id: 'user-flow', title: 'User Flow', categories: ['UX_BEHAVIOR', 'USER_FLOW'] },
    { id: 'validation', title: 'Validation', categories: ['VALIDATION'] },
    { id: 'error-handling', title: 'Error Handling', categories: ['ERROR_HANDLING'] },
    { id: 'qa-references', title: 'QA References', categories: ['QA_REFERENCE'] },
    { id: 'sources', title: 'Sources', categories: [] },
  ],
};

export function normalize(text: string): string {
  return text.trim();
}

export function sourceKey(reference: SourceIdentity): string {
  return JSON.stringify([reference.workItemId, reference.sourceLinkIdentity]);
}

export function referenceKey(reference: SourceReference): string {
  return JSON.stringify([
    sourceKey(reference),
    reference.revision,
    reference.changedDate,
    reference.location.kind,
    reference.location.name,
    reference.classification?.gateVersion ?? null,
    reference.classification?.digest ?? null,
  ]);
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function strings(values: readonly string[]): boolean {
  return Array.isArray(values) && values.every(value => typeof value === 'string' && !!value.trim());
}

function validReference(reference: SourceReference): boolean {
  return !!reference && strings([reference.workItemId, reference.sourceLinkIdentity, reference.revision, reference.changedDate])
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(reference.changedDate)
    && Number.isFinite(Date.parse(reference.changedDate))
    && new Date(reference.changedDate).toISOString().replace('.000Z', 'Z') === reference.changedDate.replace('.000Z', 'Z')
    && !!reference.location && ['FIELD', 'COMMENT'].includes(reference.location.kind) && strings([reference.location.name])
    && (reference.classification === undefined
      || (strings([reference.classification.gateVersion])
        && /^[a-f0-9]{64}$/.test(reference.classification.digest)));
}

export function validateSources(sources: readonly SourceFragment[]): Issue[] {
  if (!Array.isArray(sources)) return [{ code: 'INVALID_SOURCES', identity: 'sources' }];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const locations = new Set<string>();
  for (const source of sources) {
    if (!source || !validReference(source.reference) || typeof source.text !== 'string'
      || !['PROMOTED', 'SUPPORTING_EVIDENCE', 'CONTEXT_ONLY', 'REJECTED'].includes(source.status)) {
      issues.push({ code: 'INVALID_SOURCE', identity: 'sources' });
      continue;
    }
    const key = referenceKey(source.reference);
    const locationKey = JSON.stringify([sourceKey(source.reference), source.reference.location.kind, source.reference.location.name]);
    if (seen.has(key)) issues.push({ code: 'DUPLICATE_SOURCE_REFERENCE', identity: key });
    else if (locations.has(locationKey)) issues.push({ code: 'AMBIGUOUS_SOURCE_REVISION', identity: locationKey });
    seen.add(key);
    locations.add(locationKey);
  }
  return issues;
}

export function sourceFingerprints(sources: readonly SourceFragment[]): Record<string, string> {
  const grouped = new Map<string, string[]>();
  for (const source of sources) {
    const key = sourceKey(source.reference);
    grouped.set(key, [...(grouped.get(key) ?? []), JSON.stringify([referenceKey(source.reference), source.text, source.status])]);
  }
  return Object.fromEntries(Array.from(grouped, ([key, fragments]) => [key, fingerprint(fragments.sort())]));
}

function provenanceUnion(provenance: readonly Provenance[]): Provenance[] {
  return Array.from(new Map(provenance.map(citation => [referenceKey(citation.reference), citation])).values())
    .sort((left, right) => referenceKey(left.reference).localeCompare(referenceKey(right.reference)));
}

export type PreparedBuild = Readonly<{
  input: BuildInput;
  policy: SectionPolicy;
  concepts: readonly KnowledgeConcept[];
  graph: DependencyGraph;
  topicFingerprints: Readonly<Record<string, string>>;
}>;

export function prepareBuild(input: BuildInput): Result<PreparedBuild> {
  if (!input || !Array.isArray(input.candidates) || !Array.isArray(input.topics) || !Array.isArray(input.hierarchy)) {
    return { ok: false, issues: [{ code: 'INVALID_BUILD_INPUT', identity: 'input' }] };
  }
  const issues = validateSources(input.sources);
  if (issues.length) return { ok: false, issues };
  const policy = input.sectionPolicy ?? defaultSectionPolicy;
  if (!policy || !strings([policy.version]) || !Array.isArray(policy.sections)
    || policy.sections.some(section => !section || !strings([section.id, section.title]) || !Array.isArray(section.categories))
    || new Set(policy.sections.map(section => section.id)).size !== policy.sections.length
    || policy.sections.filter(section => section.id === 'sources' && section.categories.length === 0).length !== 1
    || categories.some(category => policy.sections.flatMap(section => section.categories).filter(value => value === category).length !== 1)
    || policy.sections.some(section => section.categories.some((category: Category) => !categories.includes(category)))) {
    return { ok: false, issues: [{ code: 'INVALID_SECTION_POLICY', identity: 'policy' }] };
  }
  const sourceMap = new Map(input.sources.map(source => [referenceKey(source.reference), source]));
  const hierarchyMap = new Map(input.hierarchy.map(node => [node?.id, node]));
  if (hierarchyMap.size !== input.hierarchy.length || input.hierarchy.some(node => !node || !strings([node.id, node.title])
    || !strings(node.parentIds) || !Array.isArray(node.references) || !node.references.length
    || node.parentIds.some((id: string) => !hierarchyMap.has(id)) || node.references.some((reference: SourceReference) => !validReference(reference)
      || !['PROMOTED', 'CONTEXT_ONLY'].includes(sourceMap.get(referenceKey(reference))?.status ?? '')))) {
    return { ok: false, issues: [{ code: 'INVALID_HIERARCHY', identity: 'hierarchy' }] };
  }
  const ancestors = (ids: readonly string[], path = new Set<string>()): string[] => {
    const result: string[] = [];
    for (const id of ids) {
      if (path.has(id)) throw new Error('cycle');
      const node = hierarchyMap.get(id);
      if (!node) throw new Error('missing');
      result.push(id, ...ancestors(node.parentIds, new Set([...Array.from(path), id])));
    }
    return unique(result);
  };
  try {
    ancestors(input.hierarchy.map(node => node.id));
  } catch {
    return { ok: false, issues: [{ code: 'HIERARCHY_CYCLE', identity: 'hierarchy' }] };
  }
  if (new Set(input.topics.map(topic => topic?.id)).size !== input.topics.length || input.topics.some(topic => !topic
    || !strings([topic.id, topic.title]) || !strings(topic.hierarchyIds) || !strings(topic.groupingKeys) || !strings(topic.conceptIds)
    || topic.hierarchyIds.some((id: string) => !hierarchyMap.has(id)))) {
    return { ok: false, issues: [{ code: 'INVALID_TOPIC', identity: 'topics' }] };
  }
  const grouped = new Map<string, { candidates: Candidate[]; provenance: Provenance[] }>();
  const identities = new Map<string, string>();
  const textCategories = new Map<string, string>();
  for (const candidate of input.candidates) {
    if (!candidate || !strings([candidate.conceptId, candidate.title, candidate.text]) || !categories.includes(candidate.category)
      || !strings(candidate.hierarchyIds) || !strings(candidate.groupingKeys) || !strings(candidate.iterations) || !strings(candidate.releases)
      || candidate.hierarchyIds.some((id: string) => !hierarchyMap.has(id)) || !Array.isArray(candidate.references) || !candidate.references.length) {
      issues.push({ code: 'INVALID_CANDIDATE', identity: candidate?.conceptId ?? 'candidate' });
      continue;
    }
    const provenance: Provenance[] = [];
    for (const reference of candidate.references) {
      const source = validReference(reference) ? sourceMap.get(referenceKey(reference)) : undefined;
      if (!source) issues.push({ code: 'UNRESOLVED_REFERENCE', identity: candidate.conceptId });
      else if (source.status === 'REJECTED' || source.status === 'CONTEXT_ONLY') {
        issues.push({ code: 'SOURCE_NOT_KNOWLEDGE', identity: candidate.conceptId });
      } else if (normalize(source.text) !== normalize(candidate.text)) {
        issues.push({ code: 'UNSUPPORTED_CLAIM', identity: candidate.conceptId });
      } else if (source.status === 'SUPPORTING_EVIDENCE' && candidate.category !== 'QA_REFERENCE') {
        issues.push({ code: 'EVIDENCE_CANNOT_AUTHOR_REQUIREMENT', identity: candidate.conceptId });
      } else provenance.push({ reference: structuredClone(reference), status: source.status });
    }
    const signature = JSON.stringify([candidate.category, normalize(candidate.text)]);
    const existingCategory = textCategories.get(normalize(candidate.text));
    if (existingCategory && existingCategory !== candidate.category) issues.push({ code: 'AMBIGUOUS_CATEGORY', identity: candidate.conceptId });
    textCategories.set(normalize(candidate.text), candidate.category);
    const existing = identities.get(candidate.conceptId);
    if (existing && existing !== signature) issues.push({ code: 'CONFLICTING_CONCEPT', identity: candidate.conceptId });
    identities.set(candidate.conceptId, signature);
    const group = grouped.get(signature) ?? { candidates: [], provenance: [] };
    group.candidates.push(candidate);
    group.provenance.push(...provenance);
    grouped.set(signature, group);
  }
  if (issues.length) return { ok: false, issues };
  const concepts: KnowledgeConcept[] = [];
  for (const group of Array.from(grouped.values())) {
    const candidates = [...group.candidates].sort((left, right) => left.conceptId.localeCompare(right.conceptId));
    const first = candidates[0]!;
    const aliasIds = unique(candidates.map(candidate => candidate.conceptId));
    const hierarchyIds = ancestors(unique(candidates.flatMap(candidate => [...candidate.hierarchyIds])));
    const groupingKeys = unique(candidates.flatMap(candidate => [...candidate.groupingKeys]));
    const ranked = input.topics.map(topic => ({ topic, rank: aliasIds.some(id => topic.conceptIds.includes(id)) ? 3
      : topic.groupingKeys.some((key: string) => groupingKeys.includes(key)) ? 2
        : topic.hierarchyIds.some((id: string) => hierarchyIds.includes(id)) ? 1 : 0 })).sort((left, right) => right.rank - left.rank);
    const best = ranked[0];
    if (!best || best.rank === 0 || ranked[1]?.rank === best.rank) {
      issues.push({ code: best?.rank ? 'AMBIGUOUS_TOPIC' : 'NO_TOPIC', identity: first.conceptId });
      continue;
    }
    concepts.push({ id: first.conceptId, aliasIds, titles: unique(candidates.map(candidate => candidate.title)),
      text: normalize(first.text), category: first.category,
      authority: first.category === 'QA_REFERENCE' ? 'SUPPORTING_EVIDENCE' : 'VALIDATED_KNOWLEDGE',
      provenance: provenanceUnion(group.provenance), hierarchyIds,
      hierarchyTitles: unique(hierarchyIds.map(id => hierarchyMap.get(id)!.title)), groupingKeys,
      iterations: unique(candidates.flatMap(candidate => [...candidate.iterations])),
      releases: unique(candidates.flatMap(candidate => [...candidate.releases])), topicId: best.topic.id });
  }
  if (issues.length) return { ok: false, issues };
  concepts.sort((left, right) => left.id.localeCompare(right.id));
  const graph: DependencyGraph = {
    sourceConcepts: concepts.flatMap(concept => unique(concept.provenance.map(citation => sourceKey(citation.reference)))
      .map(key => ({ sourceKey: key, conceptId: concept.id }))),
    sourceTopics: input.topics.flatMap(topic => {
      const contextIds = unique([...ancestors(topic.hierarchyIds), ...concepts.filter(concept => concept.topicId === topic.id).flatMap(concept => [...concept.hierarchyIds])]);
      return unique(contextIds.flatMap(id => hierarchyMap.get(id)!.references.map(sourceKey)))
        .map(key => ({ sourceKey: key, topicId: topic.id }));
    }),
    conceptTopics: concepts.map(concept => ({ conceptId: concept.id, topicId: concept.topicId })),
  };
  const topicFingerprints = Object.fromEntries(input.topics.map(topic => [topic.id, fingerprint([
    topic, policy, concepts.filter(concept => concept.topicId === topic.id),
    graph.sourceTopics.filter(edge => edge.topicId === topic.id),
  ])]));
  return { ok: true, value: { input, policy, concepts, graph, topicFingerprints } };
}

export function renderTopic(prepared: PreparedBuild, topicId: string): WikiTopic {
  const topic = prepared.input.topics.find(candidate => candidate.id === topicId)!;
  const concepts = prepared.concepts.filter(concept => concept.topicId === topicId);
  return { id: topic.id, title: topic.title, sections: prepared.policy.sections.map(section => ({
    id: section.id, title: section.title,
    conceptIds: section.id === 'sources' ? [] : concepts.filter(concept => section.categories.includes(concept.category)).map(concept => concept.id),
    sources: section.id === 'sources' ? provenanceUnion(concepts.flatMap(concept => [...concept.provenance])) : [],
  })), curatedAnnotations: [], curationNeedsReview: false };
}

export function assembleState(prepared: PreparedBuild, topics: readonly WikiTopic[]): BuildState {
  return { policyVersion: prepared.policy.version, concepts: prepared.concepts, topics, graph: prepared.graph,
    sourceFingerprints: sourceFingerprints(prepared.input.sources), topicFingerprints: prepared.topicFingerprints };
}

export function buildWiki(input: BuildInput): Result<BuildState> {
  const prepared = prepareBuild(input);
  if (!prepared.ok) return prepared;
  return { ok: true, value: assembleState(prepared.value, unique(input.topics.map(topic => topic.id)).map(id => renderTopic(prepared.value, id))) };
}
