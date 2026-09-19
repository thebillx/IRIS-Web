import type { RawSourceStage } from '@iris/ado';
import type { Classification, TruthStatus } from '@iris/shared/ado/knowledge-gate';
import type { CanonicalKnowledgeCandidate } from './ado-knowledge-bridge.js';
import { knowledgeAssert } from './ado-knowledge-provenance.js';
import { canonical, hash, type GateDecision, type Membership, type Observation } from './ado/m6/model.js';

export interface SyncEvidenceInput {
  readonly expectedCommentIds: readonly string[];
  readonly commentsComplete: boolean;
  readonly comments: readonly { readonly id: string; readonly text: string }[];
  readonly relationsComplete: boolean;
  readonly relations: readonly { readonly id: string; readonly kind: string; readonly targetItemId: number }[];
  readonly linksComplete: boolean;
  readonly links: readonly { readonly id: string; readonly evidenceRef: string }[];
}

export interface PersistedKnowledgeEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly scopeId: string;
  readonly workItemId: string;
  readonly revision: number;
  readonly sourceRawHash: string;
  readonly normalizerVersion: 'm3-v1';
  readonly facts: readonly {
    readonly field: CanonicalKnowledgeCandidate['facts'][number]['field'];
    readonly body: string;
    readonly contentHash: string;
    readonly sourceName: string;
  }[];
}

export function toSyncMembership(stage: RawSourceStage, backlogIds: readonly string[]): Membership {
  validateStageCandidateIdentity(stage);
  knowledgeAssert(Array.isArray(backlogIds) && backlogIds.length > 0, 'Sync membership requires discovered backlog IDs');
  return {
    itemId: stage.canonical.id,
    parentId: stage.canonical.parent,
    backlogIds: [...backlogIds],
  };
}

export function toSyncObservation(
  stage: RawSourceStage,
  candidate: CanonicalKnowledgeCandidate,
  evidence: SyncEvidenceInput,
): Observation {
  validateStageCandidateIdentity(stage, candidate);
  validateEvidenceInput(evidence);
  const envelope = knowledgeEnvelope(stage, candidate);
  return {
    itemId: stage.canonical.id,
    revision: stage.canonical.revision,
    changedAt: candidate.node.provenance.changedDate,
    content: canonical(envelope),
    expectedCommentIds: [...evidence.expectedCommentIds],
    commentsComplete: evidence.commentsComplete,
    comments: evidence.comments.map(comment => ({ ...comment })),
    relationsComplete: evidence.relationsComplete,
    relations: evidence.relations.map(relation => ({ ...relation })),
    linksComplete: evidence.linksComplete,
    links: evidence.links.map(link => ({ ...link })),
  };
}

export function knowledgeEnvelope(
  stage: RawSourceStage,
  candidate: CanonicalKnowledgeCandidate,
): PersistedKnowledgeEnvelopeV1 {
  validateStageCandidateIdentity(stage, candidate);
  return {
    schemaVersion: 1,
    scopeId: candidate.item.scopeId,
    workItemId: candidate.item.workItemId,
    revision: candidate.node.provenance.revision,
    sourceRawHash: stage.rawHash,
    normalizerVersion: stage.canonical.provenance.normalizerVersion,
    facts: candidate.facts.map(entry => {
      knowledgeAssert(entry.fact.provenance.source.kind === 'FIELD', 'Persisted canonical fact must originate from a field');
      return {
        field: entry.field,
        body: entry.fact.body,
        contentHash: entry.fact.provenance.contentHash,
        sourceName: entry.fact.provenance.source.name,
      };
    }),
  };
}

export function parseKnowledgeEnvelope(content: string): PersistedKnowledgeEnvelopeV1 {
  knowledgeAssert(typeof content === 'string' && content.length > 0 && content.length <= 1_048_576, 'Persisted knowledge envelope is invalid');
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    knowledgeAssert(false, 'Persisted knowledge envelope is invalid');
    throw new Error('UNREACHABLE');
  }
  knowledgeAssert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Persisted knowledge envelope is invalid');
  const envelope = value as Partial<PersistedKnowledgeEnvelopeV1>;
  const revision = envelope.revision;
  knowledgeAssert(envelope.schemaVersion === 1
    && typeof envelope.scopeId === 'string' && /^ado-board:[a-f0-9]{64}$/.test(envelope.scopeId)
    && typeof envelope.workItemId === 'string' && /^[1-9][0-9]*$/.test(envelope.workItemId)
    && typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0
    && typeof envelope.sourceRawHash === 'string' && /^[a-f0-9]{64}$/.test(envelope.sourceRawHash)
    && envelope.normalizerVersion === 'm3-v1'
    && Array.isArray(envelope.facts), 'Persisted knowledge envelope is invalid');
  const allowedFields = new Set(['type', 'title', 'state', 'description', 'acceptanceCriteria', 'areaPath', 'iterationPath', 'boardColumn', 'tags']);
  const seen = new Set<string>();
  const facts = envelope.facts.map(fact => {
    knowledgeAssert(fact !== null && typeof fact === 'object'
      && typeof fact.field === 'string' && allowedFields.has(fact.field)
      && typeof fact.body === 'string'
      && typeof fact.contentHash === 'string' && /^[a-f0-9]{64}$/.test(fact.contentHash)
      && fact.contentHash === hash(fact.body)
      && typeof fact.sourceName === 'string' && fact.sourceName.length > 0
      && !seen.has(fact.field), 'Persisted knowledge envelope fact is invalid');
    seen.add(fact.field);
    return {
      field: fact.field as PersistedKnowledgeEnvelopeV1['facts'][number]['field'],
      body: fact.body,
      contentHash: fact.contentHash,
      sourceName: fact.sourceName,
    };
  });
  return {
    schemaVersion: 1,
    scopeId: envelope.scopeId,
    workItemId: envelope.workItemId,
    revision,
    sourceRawHash: envelope.sourceRawHash,
    normalizerVersion: 'm3-v1',
    facts,
  };
}

export function gateDecisionFromClassification(
  itemId: number,
  fingerprint: string,
  classification: Classification,
  truthStatus: TruthStatus,
): GateDecision {
  knowledgeAssert(Number.isSafeInteger(itemId) && itemId > 0, 'Gate decision requires positive item ID');
  knowledgeAssert(typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint), 'Gate decision requires source fingerprint');
  knowledgeAssert(typeof classification.policyVersion === 'string' && classification.policyVersion.length > 0, 'Gate classification requires policy version');
  const reasonCode = classification.reasonCodes[0];
  knowledgeAssert(typeof reasonCode === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(reasonCode), 'Gate classification requires bounded reason code');
  const digest = hash(canonical({
    status: classification.status,
    reasonCodes: classification.reasonCodes,
    signals: classification.signals,
    score: classification.score,
    policyVersion: classification.policyVersion,
    category: classification.category,
    semanticEvidence: classification.semanticEvidence,
    sourceReferences: classification.sourceReferences,
  }));
  return {
    itemId,
    fingerprint,
    gateVersion: classification.policyVersion,
    disposition: classification.status,
    reasonCode,
    category: classification.category,
    classificationDigest: digest,
    truthStatus,
    evidence: classification.semanticEvidence?.quotes.map(quote => ({
      field: quote.field,
      text: quote.text,
    })) ?? [],
  };
}

function validateStageCandidateIdentity(stage: RawSourceStage, candidate?: CanonicalKnowledgeCandidate): void {
  knowledgeAssert(stage !== null && typeof stage === 'object'
    && stage.kind === 'raw-source-stage'
    && stage.validation === 'unvalidated'
    && stage.searchable === false
    && stage.rawHash === stage.canonical.provenance.rawHash, 'Expected valid M3 stage');
  if (candidate === undefined) return;
  knowledgeAssert(candidate !== null && typeof candidate === 'object'
    && candidate.status === 'CANDIDATE'
    && candidate.searchable === false
    && candidate.sourceRawHash === stage.rawHash
    && candidate.item.workItemId === String(stage.canonical.id)
    && candidate.node.provenance.revision === stage.canonical.revision, 'M3/M4 source identity mismatch');
}

function validateEvidenceInput(evidence: SyncEvidenceInput): void {
  knowledgeAssert(evidence !== null && typeof evidence === 'object'
    && Array.isArray(evidence.expectedCommentIds)
    && Array.isArray(evidence.comments)
    && Array.isArray(evidence.relations)
    && Array.isArray(evidence.links)
    && typeof evidence.commentsComplete === 'boolean'
    && typeof evidence.relationsComplete === 'boolean'
    && typeof evidence.linksComplete === 'boolean', 'Sync evidence completeness must be explicit');
}
