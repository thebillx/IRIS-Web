import { createHash } from 'node:crypto';
import {
  buildWiki,
  categories,
  type BuildInput,
  type Candidate,
  type Category,
  type HierarchyNode,
  type SectionPolicy,
  type SourceFragment,
  type SourceReference,
  type TopicDefinition,
} from '@iris/shared/ado/wiki';
import { parseKnowledgeEnvelope } from './ado-knowledge-sync-bridge.js';
import type { GateRow, SourceRow } from './ado/m6/model.js';
import type { CorpusPartition, PublishedCorpus } from './ado/m6/sync.js';
import { knowledgeAssert } from './ado-knowledge-provenance.js';

export interface WikiBuildPlan {
  readonly topics: readonly TopicDefinition[];
  readonly sectionPolicy?: SectionPolicy;
}

interface ItemProjection {
  readonly source: SourceRow;
  readonly gate: GateRow;
  readonly status: 'PROMOTED' | 'CONTEXT_ONLY' | 'SUPPORTING_EVIDENCE';
  readonly envelope: ReturnType<typeof parseKnowledgeEnvelope>;
  readonly backlogIds: readonly string[];
  readonly parentId: number | null;
  readonly fullFragments: readonly SourceFragment[];
}

export function buildWikiInputFromPublishedCorpus(
  corpus: PublishedCorpus,
  plan: WikiBuildPlan,
): BuildInput {
  knowledgeAssert(Array.isArray(plan.topics) && plan.topics.length > 0, 'Wiki build requires explicit topic definitions');
  const projections = [
    ...projectPartition(corpus.promoted, 'PROMOTED'),
    ...projectPartition(corpus.contextOnly, 'CONTEXT_ONLY'),
    ...projectPartition(corpus.supportingEvidence, 'SUPPORTING_EVIDENCE'),
  ];
  const scopes = new Set(projections.map(entry => entry.envelope.scopeId));
  knowledgeAssert(scopes.size <= 1, 'Wiki build cannot mix ADO board scopes');
  const sources: SourceFragment[] = projections.flatMap(entry => [...entry.fullFragments]);
  const nodeEligible = projections.filter(entry => entry.status === 'PROMOTED' || entry.status === 'CONTEXT_ONLY');
  const nodeIds = new Map(nodeEligible.map(entry => [entry.source.itemId, nodeId(entry.envelope.scopeId, entry.source.itemId)]));
  const hierarchy: HierarchyNode[] = nodeEligible.flatMap(entry => {
    const reference = preferredReference(entry.fullFragments);
    if (reference === null) return [];
    const title = factBody(entry, 'title') ?? ('Work item ' + entry.source.itemId);
    const parent = entry.parentId === null ? undefined : nodeIds.get(entry.parentId);
    return [{
      id: nodeIds.get(entry.source.itemId)!,
      title,
      parentIds: parent === undefined ? [] : [parent],
      references: [reference],
    }];
  });
  const candidates: Candidate[] = [];
  for (const entry of projections) {
    if (entry.status === 'PROMOTED') {
      const category = promotedCategory(entry.gate);
      for (const [index, evidence] of entry.gate.evidence.entries()) {
        const fact = entry.envelope.facts.find(candidate => candidate.field === evidence.field);
        knowledgeAssert(fact !== undefined && fact.body.includes(evidence.text), 'Gate evidence does not resolve to persisted canonical source');
        const reference = quoteReference(entry, evidence.field, fact.sourceName, index);
        sources.push({ reference, text: evidence.text, status: 'PROMOTED' });
        candidates.push({
          conceptId: conceptId(entry.envelope.scopeId, entry.source.itemId, evidence.field, index),
          title: factBody(entry, 'title') ?? ('Work item ' + entry.source.itemId),
          text: evidence.text,
          category,
          references: [reference],
          hierarchyIds: nodeIds.has(entry.source.itemId) ? [nodeIds.get(entry.source.itemId)!] : [],
          groupingKeys: [...entry.backlogIds],
          iterations: factBody(entry, 'iterationPath') === null ? [] : [factBody(entry, 'iterationPath')!],
          releases: [],
        });
      }
    } else if (entry.status === 'SUPPORTING_EVIDENCE') {
      const preferred = preferredSupportingFact(entry);
      if (preferred !== null) {
        const reference = fullReference(entry, preferred.field, preferred.sourceName);
        candidates.push({
          conceptId: evidenceConceptId(entry.envelope.scopeId, entry.source.itemId, preferred.field),
          title: factBody(entry, 'title') ?? ('Work item ' + entry.source.itemId),
          text: preferred.body,
          category: 'QA_REFERENCE',
          references: [reference],
          hierarchyIds: [],
          groupingKeys: [...entry.backlogIds],
          iterations: factBody(entry, 'iterationPath') === null ? [] : [factBody(entry, 'iterationPath')!],
          releases: [],
        });
      }
    }
  }

  return {
    sources,
    candidates,
    hierarchy,
    topics: plan.topics.map(topic => structuredClone(topic)),
    ...(plan.sectionPolicy === undefined ? {} : { sectionPolicy: structuredClone(plan.sectionPolicy) }),
  };
}

export function buildWikiFromPublishedCorpus(
  corpus: PublishedCorpus,
  plan: WikiBuildPlan,
) {
  return buildWiki(buildWikiInputFromPublishedCorpus(corpus, plan));
}

function projectPartition(
  partition: CorpusPartition,
  status: ItemProjection['status'],
): ItemProjection[] {
  const gates = new Map(partition.gates.map(gate => [gate.itemId, gate]));
  const membership = new Map(partition.membership.map(entry => [entry.itemId, entry]));
  knowledgeAssert(gates.size === partition.gates.length, 'Published corpus contains duplicate gate decisions');
  knowledgeAssert(partition.sources.length === partition.gates.length, 'Published corpus source/gate cardinality mismatch');
  return partition.sources.map(source => {
    const gate = gates.get(source.itemId);
    const member = membership.get(source.itemId);
    knowledgeAssert(gate !== undefined && member !== undefined
      && gate.disposition === status
      && gate.fingerprint === source.fingerprint, 'Published corpus gate identity mismatch');
    const envelope = parseKnowledgeEnvelope(source.content);
    knowledgeAssert(envelope.workItemId === String(source.itemId)
      && envelope.revision === source.revision, 'Persisted knowledge envelope does not match sync source');
    const projection: ItemProjection = {
      source,
      gate,
      status,
      envelope,
      backlogIds: [...member.backlogIds],
      parentId: member.parentId,
      fullFragments: [],
    };
    const fullFragments = envelope.facts.map(fact => ({
      reference: fullReference(projection, fact.field, fact.sourceName),
      text: fact.body,
      status,
    } satisfies SourceFragment));
    return { ...projection, fullFragments };
  });
}

function promotedCategory(gate: GateRow): Category {
  knowledgeAssert(gate.category !== null && categories.includes(gate.category as Category), 'Promoted gate category is not supported by Wiki projection');
  return gate.category as Category;
}

function classification(gate: GateRow): NonNullable<SourceReference['classification']> {
  return { gateVersion: gate.gateVersion, digest: gate.classificationDigest, truthStatus: gate.truthStatus };
}

function fullReference(
  entry: ItemProjection,
  field: ReturnType<typeof parseKnowledgeEnvelope>['facts'][number]['field'],
  sourceName: string,
): SourceReference {
  return {
    workItemId: entry.envelope.workItemId,
    sourceLinkIdentity: 'ado-field:' + digest([entry.envelope.scopeId, field]),
    revision: String(entry.source.revision),
    changedDate: entry.source.changedAt,
    location: { kind: 'FIELD', name: sourceName },
    classification: classification(entry.gate),
  };
}

function quoteReference(
  entry: ItemProjection,
  field: ReturnType<typeof parseKnowledgeEnvelope>['facts'][number]['field'],
  sourceName: string,
  index: number,
): SourceReference {
  return {
    workItemId: entry.envelope.workItemId,
    sourceLinkIdentity: 'ado-evidence:' + digest([entry.envelope.scopeId, field, index]),
    revision: String(entry.source.revision),
    changedDate: entry.source.changedAt,
    location: { kind: 'FIELD', name: sourceName },
    classification: classification(entry.gate),
  };
}

function preferredReference(fragments: readonly SourceFragment[]): SourceReference | null {
  return fragments.find(fragment => fragment.reference.location.name === 'System.Title')?.reference
    ?? fragments[0]?.reference
    ?? null;
}

function preferredSupportingFact(entry: ItemProjection) {
  return entry.envelope.facts.find(fact => fact.field === 'description')
    ?? entry.envelope.facts.find(fact => fact.field === 'acceptanceCriteria')
    ?? entry.envelope.facts.find(fact => fact.field === 'title')
    ?? null;
}

function factBody(entry: ItemProjection, field: ReturnType<typeof parseKnowledgeEnvelope>['facts'][number]['field']): string | null {
  return entry.envelope.facts.find(fact => fact.field === field)?.body ?? null;
}

function nodeId(scopeId: string, itemId: number): string {
  return 'ado-node:' + digest([scopeId, itemId]).slice(0, 32);
}

function conceptId(scopeId: string, itemId: number, field: string, index: number): string {
  return 'ado-claim:' + digest([scopeId, itemId, field, index]).slice(0, 32);
}

function evidenceConceptId(scopeId: string, itemId: number, field: string): string {
  return 'ado-evidence:' + digest([scopeId, itemId, field]).slice(0, 32);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
