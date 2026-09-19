import type { BuildInput, BuildState, CurationPolicy, IncrementalResult, Result, SourceFragment,
  SourceIdentity, SourceRevalidator, WikiTopic } from './models.js';
import { assembleState, fingerprint, prepareBuild, referenceKey, renderTopic, sourceFingerprints,
  sourceKey, unique, validateSources } from './projection.js';

export type RevalidationPlan = Readonly<{
  phase: 'REVALIDATION_REQUIRED';
  changedSourceKeys: readonly string[];
  previouslyAffectedConceptIds: readonly string[];
  previouslyAffectedTopicIds: readonly string[];
}>;

export function planRebuild(previous: BuildState, nextSources: readonly SourceFragment[]): Result<RevalidationPlan> {
  const issues = validateSources(nextSources);
  if (issues.length) return { ok: false, issues };
  const next = sourceFingerprints(nextSources);
  const changedSourceKeys = unique([...Object.keys(previous.sourceFingerprints), ...Object.keys(next)])
    .filter(key => previous.sourceFingerprints[key] !== next[key]);
  const previouslyAffectedConceptIds = unique(previous.graph.sourceConcepts
    .filter(edge => changedSourceKeys.includes(edge.sourceKey)).map(edge => edge.conceptId));
  const previouslyAffectedTopicIds = unique([
    ...previous.graph.sourceTopics.filter(edge => changedSourceKeys.includes(edge.sourceKey)).map(edge => edge.topicId),
    ...previous.graph.conceptTopics.filter(edge => previouslyAffectedConceptIds.includes(edge.conceptId)).map(edge => edge.topicId),
  ]);
  return { ok: true, value: { phase: 'REVALIDATION_REQUIRED', changedSourceKeys,
    previouslyAffectedConceptIds, previouslyAffectedTopicIds } };
}

function sourceContent(fragments: readonly SourceFragment[]): string {
  return fingerprint(fragments.map(fragment => JSON.stringify([referenceKey(fragment.reference), fragment.text])).sort());
}

export function rebuildWiki(previous: BuildState, nextInput: BuildInput, revalidator: SourceRevalidator,
  curationPolicy: CurationPolicy): Result<IncrementalResult> {
  if (!['PRESERVE_WITH_REVIEW', 'BLOCK_REBUILD'].includes(curationPolicy)) {
    return { ok: false, issues: [{ code: 'INVALID_CURATION_POLICY', identity: 'curation' }] };
  }
  const plan = planRebuild(previous, nextInput.sources);
  if (!plan.ok) return plan;
  const changed = plan.value.changedSourceKeys;
  const validated: SourceFragment[] = nextInput.sources.filter(source => !changed.includes(sourceKey(source.reference)));
  for (const key of changed) {
    const [workItemId, sourceLinkIdentity] = JSON.parse(key) as [string, string];
    const identity: SourceIdentity = { workItemId, sourceLinkIdentity };
    const fragments = nextInput.sources.filter(source => sourceKey(source.reference) === key);
    try {
      const result = revalidator.revalidate(identity, structuredClone(fragments));
      if (!result.ok) return result;
      if (validateSources(result.value).length || sourceContent(result.value) !== sourceContent(fragments)) {
        return { ok: false, issues: [{ code: 'REVALIDATOR_CHANGED_SOURCE_CONTENT', identity: key }] };
      }
      validated.push(...structuredClone(result.value));
    } catch {
      return { ok: false, issues: [{ code: 'REVALIDATION_FAILED', identity: key }] };
    }
  }
  const prepared = prepareBuild({ ...nextInput, sources: validated });
  if (!prepared.ok) return prepared;
  const next = prepared.value;
  const affectedConceptIds = unique([
    ...plan.value.previouslyAffectedConceptIds,
    ...next.graph.sourceConcepts.filter(edge => changed.includes(edge.sourceKey)).map(edge => edge.conceptId),
    ...next.concepts.filter(concept => fingerprint(concept) !== fingerprint(previous.concepts.find(old => old.id === concept.id) ?? null)).map(concept => concept.id),
    ...previous.concepts.filter(concept => !next.concepts.some(current => current.id === concept.id)).map(concept => concept.id),
  ]);
  const affectedTopics = unique([
    ...plan.value.previouslyAffectedTopicIds,
    ...next.graph.sourceTopics.filter(edge => changed.includes(edge.sourceKey)).map(edge => edge.topicId),
    ...next.graph.conceptTopics.filter(edge => affectedConceptIds.includes(edge.conceptId)).map(edge => edge.topicId),
    ...previous.graph.conceptTopics.filter(edge => affectedConceptIds.includes(edge.conceptId)).map(edge => edge.topicId),
    ...unique([...Object.keys(previous.topicFingerprints), ...Object.keys(next.topicFingerprints)])
      .filter(id => previous.topicFingerprints[id] !== next.topicFingerprints[id]),
  ]);
  const removedTopicIds = previous.topics.filter(topic => !next.input.topics.some(current => current.id === topic.id)).map(topic => topic.id).sort();
  for (const topic of previous.topics) {
    if (!topic.curatedAnnotations.length || !affectedTopics.includes(topic.id)) continue;
    if (curationPolicy === 'BLOCK_REBUILD' || removedTopicIds.includes(topic.id)) {
      return { ok: false, issues: [{ code: 'CURATED_CONTENT_REQUIRES_REVIEW', identity: topic.id }] };
    }
  }
  const rebuiltTopicIds: string[] = [];
  const topics: WikiTopic[] = unique(next.input.topics.map(topic => topic.id)).map(id => {
    const old = previous.topics.find(topic => topic.id === id);
    if (old && !affectedTopics.includes(id)) return old;
    rebuiltTopicIds.push(id);
    return { ...renderTopic(next, id), curatedAnnotations: structuredClone(old?.curatedAnnotations ?? []),
      curationNeedsReview: !!old?.curatedAnnotations.length };
  });
  return { ok: true, value: { state: assembleState(next, topics), revalidatedSourceKeys: changed,
    affectedConceptIds, rebuiltTopicIds, removedTopicIds } };
}
