import { describe, expect, it } from 'vitest';
import { buildWiki, defaultSectionPolicy, sourceKey } from './projection.js';
import { planRebuild, rebuildWiki } from './incremental.js';
import { queryKnowledge, type RetrievalQuery } from './retrieval.js';
import { categories, type BuildInput, type BuildState, type Candidate, type KnowledgeStatus, type Result,
  type SourceFragment, type SourceIdentity, type SourceReference, type SourceRevalidator } from './models.js';

function reference(id: string, revision = '1'): SourceReference {
  return { workItemId: id, revision, changedDate: '2026-01-01T00:00:00Z',
    location: { kind: 'FIELD', name: 'Description' }, sourceLinkIdentity: `synthetic-source/${id}` };
}

function source(id: string, text: string, status: KnowledgeStatus = 'PROMOTED'): SourceFragment {
  return { reference: reference(id), text, status };
}

function candidate(id: string, fragment: SourceFragment, overrides: Partial<Candidate> = {}): Candidate {
  return { conceptId: id, title: `Behavior ${id}`, text: fragment.text, category: 'FUNCTIONAL_BEHAVIOR',
    references: [fragment.reference], hierarchyIds: [], groupingKeys: ['results'], iterations: ['iteration-one'],
    releases: ['release-one'], ...overrides };
}

function fixture(): BuildInput {
  const exportSource = source('item-export', 'Exports contain the selected records.');
  const validationSource = source('item-validation', 'An empty selection prevents export.');
  const preferenceSource = source('item-preference', 'The selected locale is saved.');
  const feature = source('feature-results', '', 'CONTEXT_ONLY');
  return { sources: [exportSource, validationSource, preferenceSource, feature],
    candidates: [candidate('export', exportSource, { hierarchyIds: ['results-feature'] }),
      candidate('validation', validationSource, { category: 'VALIDATION', hierarchyIds: ['results-feature'] }),
      candidate('preferences', preferenceSource, { groupingKeys: ['preferences'] })],
    hierarchy: [{ id: 'results-feature', title: 'Result selection', parentIds: [], references: [feature.reference] }],
    topics: [
      { id: 'results', title: 'Working with results', hierarchyIds: ['results-feature'], groupingKeys: ['results'], conceptIds: [] },
      { id: 'preferences', title: 'User preferences', hierarchyIds: [], groupingKeys: ['preferences'], conceptIds: [] },
    ] };
}

function success<Value>(result: Result<Value>): Value {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function fails<Value>(result: Result<Value>, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues.map(issue => issue.code)).toContain(code);
}

function revised(input: BuildInput): BuildInput {
  const old = input.sources[0]!;
  const replacement: SourceFragment = { ...old, reference: { ...old.reference, revision: '2', changedDate: '2026-01-02T00:00:00Z' },
    text: 'Exports contain only the selected visible records.' };
  return { ...input, sources: [replacement, ...input.sources.slice(1)],
    candidates: input.candidates.map(item => item.conceptId === 'export' ? { ...item, text: replacement.text, references: [replacement.reference] } : item) };
}

class FakeRevalidator implements SourceRevalidator {
  readonly calls: SourceIdentity[] = [];
  constructor(private readonly status?: KnowledgeStatus) {}
  revalidate(identity: SourceIdentity, fragments: readonly SourceFragment[]): Result<readonly SourceFragment[]> {
    this.calls.push(identity);
    return { ok: true, value: fragments.map(fragment => ({ ...fragment, status: this.status ?? fragment.status })) };
  }
}

function curated(state: BuildState): BuildState {
  return { ...state, topics: state.topics.map(topic => topic.id === 'results' ? { ...topic,
    curatedAnnotations: [{ id: 'curation-one', text: 'Editorial note to preserve verbatim.' }] } : topic) };
}

describe('provenance-backed synthesis and topic structure', () => {
  it('groups multiple source stories into a topic rather than one page each', () => {
    const state = success(buildWiki(fixture()));
    expect(state.topics).toHaveLength(2);
    expect(state.concepts).toHaveLength(3);
    const results = state.topics.find(topic => topic.id === 'results')!;
    expect(results.sections.flatMap(section => section.conceptIds)).toEqual(['export', 'validation']);
    expect(results.sections.map(section => section.title)).toEqual([
      'Overview', 'Business Rules', 'User Flow', 'Validation', 'Error Handling', 'QA References', 'Sources',
    ]);
    expect(results.sections.find(section => section.id === 'sources')?.sources).toHaveLength(2);
  });

  it.each(categories)('projects grounded %s without inventing content', category => {
    const input = fixture();
    const first = input.candidates[0]!;
    const state = success(buildWiki({ ...input, candidates: [{ ...first, category }] }));
    expect(state.concepts[0]?.text).toBe(first.text);
    expect(state.concepts[0]?.category).toBe(category);
    expect(state.concepts[0]?.provenance[0]?.reference).toEqual(input.sources[0]?.reference);
  });

  it('supports data-driven section labels and category placement', () => {
    const policy = { version: 'synthetic-wiki/v2', sections: defaultSectionPolicy.sections.map(section =>
      section.id === 'user-flow' ? { ...section, title: 'Interaction flow' } : section) };
    const state = success(buildWiki({ ...fixture(), sectionPolicy: policy }));
    expect(state.policyVersion).toBe('synthetic-wiki/v2');
    expect(state.topics[0]?.sections.find(section => section.id === 'user-flow')?.title).toBe('Interaction flow');
    fails(buildWiki({ ...fixture(), sectionPolicy: { version: 'invalid', sections: [] } }), 'INVALID_SECTION_POLICY');
  });

  it('deduplicates paragraphs and concept aliases while retaining all source revisions', () => {
    const input = fixture();
    const duplicate = source('item-duplicate', input.sources[0]!.text);
    const state = success(buildWiki({ ...input, sources: [...input.sources, duplicate],
      candidates: [...input.candidates, candidate('export-copy', duplicate)] }));
    const concept = state.concepts.find(item => item.id === 'export')!;
    expect(state.concepts).toHaveLength(3);
    expect(concept.aliasIds).toEqual(['export', 'export-copy']);
    expect(concept.provenance.map(citation => citation.reference.workItemId).sort()).toEqual(['item-duplicate', 'item-export']);
    expect(state.topics.find(topic => topic.id === 'results')?.sections.flatMap(section => section.conceptIds))
      .toEqual(['export', 'validation']);
  });

  it('deduplicates repeated citations and trims only surrounding whitespace', () => {
    const input = fixture();
    const first = input.candidates[0]!;
    const state = success(buildWiki({ ...input, candidates: [{ ...first, text: `  ${first.text} `,
      references: [...first.references, ...first.references] }] }));
    expect(state.concepts[0]?.provenance).toHaveLength(1);
  });

  it('does not discard meaningful internal whitespace in a claim', () => {
    const input = fixture();
    const fragment = source('format-rule', 'The literal "a  b" is accepted.');
    fails(buildWiki({ ...input, sources: [...input.sources, fragment], candidates: [candidate('format-rule', fragment,
      { text: 'The literal "a b" is accepted.' })] }), 'UNSUPPORTED_CLAIM');
    expect(success(buildWiki({ ...input, sources: [...input.sources, fragment],
      candidates: [candidate('format-rule', fragment)] })).concepts[0]?.text).toBe(fragment.text);
  });

  it('rejects conflicting claims and ambiguous categories rather than silently merging', () => {
    const input = fixture();
    const contrary = source('item-contrary', 'Exports contain all records.');
    fails(buildWiki({ ...input, sources: [...input.sources, contrary], candidates: [...input.candidates,
      candidate('export', contrary)] }), 'CONFLICTING_CONCEPT');
    fails(buildWiki({ ...input, candidates: [...input.candidates, { ...input.candidates[0]!, conceptId: 'alternate', category: 'BUSINESS_RULE' }] }), 'AMBIGUOUS_CATEGORY');
  });

  it('uses hierarchy ancestors when no semantic grouping is supplied', () => {
    const input = fixture();
    const child = source('container-child', '', 'CONTEXT_ONLY');
    const state = success(buildWiki({ ...input, sources: [...input.sources, child],
      hierarchy: [...input.hierarchy, { id: 'child-node', title: 'Child context', parentIds: ['results-feature'], references: [child.reference] }],
      candidates: [{ ...input.candidates[0]!, groupingKeys: [], hierarchyIds: ['child-node'] }] }));
    expect(state.concepts[0]?.topicId).toBe('results');
    expect(state.concepts[0]?.hierarchyIds).toEqual(['child-node', 'results-feature']);
  });

  it('uses explicit concept placement ahead of grouping and hierarchy', () => {
    const input = fixture();
    const state = success(buildWiki({ ...input, topics: input.topics.map(topic => topic.id === 'preferences'
      ? { ...topic, conceptIds: ['export'] } : topic) }));
    expect(state.concepts.find(concept => concept.id === 'export')?.topicId).toBe('preferences');
  });

  it('fails on missing or ambiguous placement instead of guessing a page', () => {
    const input = fixture();
    fails(buildWiki({ ...input, topics: [] }), 'NO_TOPIC');
    fails(buildWiki({ ...input, topics: [...input.topics, { ...input.topics[0]!, id: 'competing-topic' }] }), 'AMBIGUOUS_TOPIC');
  });

  it('allows context-only containers to structure an empty page without adding claims', () => {
    const state = success(buildWiki({ ...fixture(), candidates: [] }));
    expect(state.topics).toHaveLength(2);
    expect(state.concepts).toEqual([]);
    expect(state.topics.every(topic => topic.sections.every(section => !section.conceptIds.length && !section.sources.length))).toBe(true);
    expect(queryKnowledge(state, {}).status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it.each(['REJECTED', 'CONTEXT_ONLY'] as const)('prevents %s from producing factual claims', status => {
    const input = fixture();
    fails(buildWiki({ ...input, sources: input.sources.map((item, index) => index === 0 ? { ...item, status } : item) }), 'SOURCE_NOT_KNOWLEDGE');
  });

  it('only admits supporting evidence as non-requirement QA references', () => {
    const input = fixture();
    const evidence = { ...source('test-result', 'The export verification passed.', 'SUPPORTING_EVIDENCE'),
      reference: { ...reference('test-result'), location: { kind: 'COMMENT' as const, name: 'comment-one' } } };
    fails(buildWiki({ ...input, sources: [...input.sources, evidence], candidates: [candidate('test', evidence)] }), 'EVIDENCE_CANNOT_AUTHOR_REQUIREMENT');
    const state = success(buildWiki({ ...input, sources: [...input.sources, evidence], candidates: [candidate('test', evidence, { category: 'QA_REFERENCE' })] }));
    expect(state.concepts[0]?.authority).toBe('SUPPORTING_EVIDENCE');
    expect(state.concepts[0]?.provenance[0]?.reference.location.kind).toBe('COMMENT');
    expect(state.topics.find(topic => topic.id === 'results')?.sections.find(section => section.id === 'qa-references')?.conceptIds).toEqual(['test']);
  });

  it('rejects fabricated acceptance criteria and partial quotations', () => {
    const input = fixture();
    fails(buildWiki({ ...input, candidates: [{ ...input.candidates[0]!, text: 'Exports must complete within one second.' }] }), 'UNSUPPORTED_CLAIM');
    fails(buildWiki({ ...input, candidates: [{ ...input.candidates[0]!, text: 'selected records' }] }), 'UNSUPPORTED_CLAIM');
  });

  it.each(['revision', 'changedDate', 'workItemId', 'sourceLinkIdentity'] as const)('requires resolving citation %s', field => {
    const input = fixture();
    const original = input.candidates[0]!;
    const altered = { ...original.references[0]!, [field]: field === 'changedDate' ? '2026-01-03T00:00:00Z' : 'unresolved' };
    fails(buildWiki({ ...input, candidates: [{ ...original, references: [altered] }] }), 'UNRESOLVED_REFERENCE');
  });

  it('requires the cited field/comment to resolve exactly', () => {
    const input = fixture();
    fails(buildWiki({ ...input, candidates: [{ ...input.candidates[0]!, references: [{ ...reference('item-export'),
      location: { kind: 'FIELD', name: 'AcceptanceCriteria' } }] }] }), 'UNRESOLVED_REFERENCE');
  });

  it('rejects invalid dates, duplicate identities, and multiple current revisions', () => {
    const input = fixture();
    fails(buildWiki({ ...input, sources: [{ ...input.sources[0]!, reference: { ...reference('item-export'), changedDate: '2026-02-30T00:00:00Z' } }] }), 'INVALID_SOURCE');
    fails(buildWiki({ ...input, sources: [...input.sources, input.sources[0]!] }), 'DUPLICATE_SOURCE_REFERENCE');
    fails(buildWiki({ ...input, sources: [...input.sources, { ...input.sources[0]!, reference: reference('item-export', '2') }] }), 'AMBIGUOUS_SOURCE_REVISION');
  });

  it('requires provenance and a valid acyclic hierarchy', () => {
    const input = fixture();
    fails(buildWiki({ ...input, candidates: [{ ...input.candidates[0]!, references: [] }] }), 'INVALID_CANDIDATE');
    fails(buildWiki({ ...input, hierarchy: [{ ...input.hierarchy[0]!, parentIds: ['results-feature'] }] }), 'HIERARCHY_CYCLE');
    fails(buildWiki({ ...input, hierarchy: [{ ...input.hierarchy[0]!, references: [] }] }), 'INVALID_HIERARCHY');
  });

  it('is deterministic under source/candidate ordering and does not mutate inputs', () => {
    const input = fixture();
    const before = structuredClone(input);
    const first = success(buildWiki(input));
    const reordered = success(buildWiki({ ...input, sources: [...input.sources].reverse(), candidates: [...input.candidates].reverse() }));
    expect(reordered).toEqual(first);
    expect(input).toEqual(before);
  });
});

describe('incremental revalidation and curated content', () => {
  it('revalidates the changed source and rebuilds only its affected topic', () => {
    const input = fixture();
    const previous = success(buildWiki(input));
    const next = revised(input);
    const plan = success(planRebuild(previous, next.sources));
    expect(plan.phase).toBe('REVALIDATION_REQUIRED');
    expect(plan.previouslyAffectedTopicIds).toEqual(['results']);
    const fake = new FakeRevalidator();
    const result = success(rebuildWiki(previous, next, fake, 'PRESERVE_WITH_REVIEW'));
    expect(fake.calls).toHaveLength(1);
    expect(result.affectedConceptIds).toEqual(['export']);
    expect(result.rebuiltTopicIds).toEqual(['results']);
    expect(result.state.topics.find(topic => topic.id === 'preferences')).toBe(previous.topics.find(topic => topic.id === 'preferences'));
    expect(result.state.concepts.find(concept => concept.id === 'export')?.provenance[0]?.reference.revision).toBe('2');
  });

  it('performs no revalidation or rendering for an unchanged snapshot', () => {
    const input = fixture();
    const previous = success(buildWiki(input));
    const fake = new FakeRevalidator();
    const result = success(rebuildWiki(previous, input, fake, 'PRESERVE_WITH_REVIEW'));
    expect(fake.calls).toEqual([]);
    expect(result.rebuiltTopicIds).toEqual([]);
    expect(result.state.topics[0]).toBe(previous.topics[0]);
  });

  it('traverses context-source dependencies without fabricating context claims', () => {
    const input = fixture();
    const previous = success(buildWiki(input));
    const old = input.sources[3]!;
    const updated = { ...old, reference: { ...old.reference, revision: '2' } };
    const next = { ...input, sources: [...input.sources.slice(0, 3), updated],
      hierarchy: [{ ...input.hierarchy[0]!, references: [updated.reference] }] };
    const result = success(rebuildWiki(previous, next, new FakeRevalidator(), 'PRESERVE_WITH_REVIEW'));
    expect(result.rebuiltTopicIds).toEqual(['results']);
    expect(result.state.concepts).toEqual(previous.concepts);
  });

  it('detects deletion through the old graph and requires explicit revalidation', () => {
    const input = fixture();
    const previous = success(buildWiki(input));
    const next = { ...input, sources: input.sources.slice(1), candidates: input.candidates.slice(1) };
    const fake = new FakeRevalidator();
    const result = success(rebuildWiki(previous, next, fake, 'PRESERVE_WITH_REVIEW'));
    expect(fake.calls.map(sourceKey)).toEqual([sourceKey(input.sources[0]!.reference)]);
    expect(result.rebuiltTopicIds).toEqual(['results']);
    expect(result.state.concepts.some(concept => concept.id === 'export')).toBe(false);
  });

  it('fails atomically when revalidation rejects a source still used for a claim', () => {
    const input = fixture();
    const previous = success(buildWiki(input));
    const before = structuredClone(previous);
    fails(rebuildWiki(previous, revised(input), new FakeRevalidator('REJECTED'), 'PRESERVE_WITH_REVIEW'), 'SOURCE_NOT_KNOWLEDGE');
    expect(previous).toEqual(before);
  });

  it('fails on stale citations after a source revision changes', () => {
    const input = fixture();
    fails(rebuildWiki(success(buildWiki(input)), { ...revised(input), candidates: input.candidates }, new FakeRevalidator(),
      'PRESERVE_WITH_REVIEW'), 'UNRESOLVED_REFERENCE');
  });

  it('contains failed revalidation and prevents the revalidator from rewriting source text', () => {
    const input = fixture();
    const previous = success(buildWiki(input));
    fails(rebuildWiki(previous, revised(input), { revalidate() { throw new Error('failure'); } }, 'PRESERVE_WITH_REVIEW'), 'REVALIDATION_FAILED');
    fails(rebuildWiki(previous, revised(input), { revalidate() { return { ok: false, issues: [{ code: 'INSUFFICIENT_EVIDENCE', identity: 'source' }] }; } },
      'PRESERVE_WITH_REVIEW'), 'INSUFFICIENT_EVIDENCE');
    fails(rebuildWiki(previous, revised(input), { revalidate(_identity, fragments) {
      return { ok: true, value: fragments.map(fragment => ({ ...fragment, text: 'Fabricated acceptance criteria.' })) };
    } }, 'PRESERVE_WITH_REVIEW'), 'REVALIDATOR_CHANGED_SOURCE_CONTENT');
  });

  it('preserves curated annotations verbatim and flags them for review', () => {
    const input = fixture();
    const previous = curated(success(buildWiki(input)));
    const result = success(rebuildWiki(previous, revised(input), new FakeRevalidator(), 'PRESERVE_WITH_REVIEW'));
    const topic = result.state.topics.find(topic => topic.id === 'results')!;
    expect(topic.curatedAnnotations).toEqual(previous.topics.find(topic => topic.id === 'results')?.curatedAnnotations);
    expect(topic.curationNeedsReview).toBe(true);
    expect(queryKnowledge(result.state, { keyword: 'Editorial' }).status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('blocks rebuilding curated content under explicit blocking policy', () => {
    const input = fixture();
    fails(rebuildWiki(curated(success(buildWiki(input))), revised(input), new FakeRevalidator(), 'BLOCK_REBUILD'), 'CURATED_CONTENT_REQUIRES_REVIEW');
  });

  it('never deletes a curated topic even under preservation policy', () => {
    const input = fixture();
    const next = { ...input, topics: input.topics.filter(topic => topic.id !== 'results'),
      candidates: input.candidates.filter(candidate => candidate.conceptId === 'preferences') };
    fails(rebuildWiki(curated(success(buildWiki(input))), next, new FakeRevalidator(), 'PRESERVE_WITH_REVIEW'), 'CURATED_CONTENT_REQUIRES_REVIEW');
  });

  it('rebuilds both old and new placement when a concept moves', () => {
    const input = fixture();
    const next = { ...input, topics: input.topics.map(topic => topic.id === 'preferences' ? { ...topic, conceptIds: ['export'] } : topic) };
    const result = success(rebuildWiki(success(buildWiki(input)), next, new FakeRevalidator(), 'PRESERVE_WITH_REVIEW'));
    expect(result.rebuiltTopicIds).toEqual(['preferences', 'results']);
  });
});

describe('deterministic graph-aware agent retrieval', () => {
  it.each([
    { id: 'item-export' }, { id: 'export' }, { title: 'Behavior export' }, { topic: 'Working with results' },
    { hierarchy: 'results-feature' }, { hierarchy: 'Result selection' }, { iteration: 'iteration-one' },
    { release: 'release-one' }, { keyword: 'selected records' }, { relatedToConceptId: 'validation' },
  ] satisfies RetrievalQuery[])('supports query %j with grounded answers', query => {
    const response = queryKnowledge(success(buildWiki(fixture())), query);
    expect(response.status).toBe('ANSWERED');
    expect(response.claims.some(claim => claim.conceptId === 'export')).toBe(true);
    expect(response.claims.every(claim => claim.provenance.length > 0)).toBe(true);
    expect(response.answer).toContain('[VALIDATED_KNOWLEDGE]');
  });

  it('combines filters rather than broadening exact ID requests', () => {
    const state = success(buildWiki(fixture()));
    expect(queryKnowledge(state, { id: 'export', keyword: 'locale' }).status).toBe('INSUFFICIENT_EVIDENCE');
    expect(queryKnowledge(state, { id: 'item' }).status).toBe('INSUFFICIENT_EVIDENCE');
    expect(queryKnowledge(state, { relatedToConceptId: 'absent' }).status).toBe('INSUFFICIENT_EVIDENCE');
    expect(queryKnowledge(state, { keyword: '' }).status).toBe('INVALID_QUERY');
  });

  it('excludes rejected corpus sources and labels controlled supporting evidence', () => {
    const input = fixture();
    const rejected = source('noise', 'Retest-only hidden content.', 'REJECTED');
    const evidence = source('qa', 'The export verification passed.', 'SUPPORTING_EVIDENCE');
    const state = success(buildWiki({ ...input, sources: [...input.sources, rejected, evidence],
      candidates: [...input.candidates, candidate('qa-result', evidence, { category: 'QA_REFERENCE' })] }));
    const response = queryKnowledge(state, {});
    expect(response.answer).not.toContain('Retest');
    expect(response.claims.find(claim => claim.conceptId === 'qa-result')?.authority).toBe('SUPPORTING_EVIDENCE');
    expect(response.claims.find(claim => claim.conceptId === 'qa-result')?.knowledgeStatus).toBe('SUPPORTING_EVIDENCE');
    expect(queryKnowledge(state, { includeSupportingEvidence: false }).claims.some(claim => claim.conceptId === 'qa-result')).toBe(false);
    expect(queryKnowledge(state, { id: 'noise' }).status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('searches deduplicated aliases and retains all references in agent answers', () => {
    const input = fixture();
    const duplicate = source('item-copy', input.sources[0]!.text);
    const state = success(buildWiki({ ...input, sources: [...input.sources, duplicate], candidates: [...input.candidates, candidate('export-copy', duplicate)] }));
    const response = queryKnowledge(state, { id: 'export-copy' });
    expect(response.claims).toHaveLength(1);
    expect(response.claims[0]?.provenance).toHaveLength(2);
  });
});
