import type { RawSourceStage } from '@iris/ado';
import type { Classification } from '@iris/shared/ado/knowledge-gate';
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

export function gateDecisionFromClassification(
  itemId: number,
  fingerprint: string,
  classification: Classification,
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
