import { createHash } from 'node:crypto';
import { stageRawSource, type RawSourceStage } from '@iris/ado';
import type {
  RecordKind,
  SemanticEvidence,
  SemanticClassifier,
  TruthStatus,
} from '@iris/shared/ado/knowledge-gate';
import { queryKnowledge, type TopicDefinition } from '@iris/shared/ado/wiki';
import type { Backlog, BoardIdentity } from './discovery.js';
import { bridgeCanonicalStageToKnowledge, type CanonicalKnowledgeCandidate } from '../ado-knowledge-bridge.js';
import { classifyCanonicalKnowledge, policyVersionForBacklogs } from '../ado-knowledge-gate-bridge.js';
import { gateDecisionFromClassification, toSyncObservation } from '../ado-knowledge-sync-bridge.js';
import { buildWikiFromPublishedCorpus } from '../ado-wiki-bridge.js';
import type { AdoLiveAcceptanceSnapshot, AdoLiveSanitizedItem } from './live-acceptance.js';
import { MemorySyncStore } from './m6/store.js';
import { SyncCoordinator } from './m6/sync.js';

export interface AdoLiveReviewDecision {
  readonly itemId: number;
  readonly revision: number;
  readonly kind: RecordKind;
  readonly truthStatus: TruthStatus;
  readonly semantic: SemanticEvidence | null;
}

export interface AdoLiveReviewManifest {
  readonly schemaVersion: 1;
  readonly targetDigest: string;
  readonly reviewer: 'CHATGPT_SUPERVISED';
  readonly decisions: readonly AdoLiveReviewDecision[];
}

export interface AdoLiveFinalizationReceipt {
  readonly schemaVersion: 1;
  readonly targetDigest: string;
  readonly policyVersion: string;
  readonly sourceItemCount: number;
  readonly classifiedItemCount: number;
  readonly classificationCounts: Readonly<Record<'PROMOTED' | 'CONTEXT_ONLY' | 'SUPPORTING_EVIDENCE' | 'REJECTED', number>>;
  readonly truthCounts: Readonly<Record<TruthStatus, number>>;
  readonly published: boolean;
  readonly promotedCount: number;
  readonly contextCount: number;
  readonly supportingEvidenceCount: number;
  readonly reviewCount: number;
  readonly historyCount: number;
  readonly wikiClaimCount: number;
  readonly wikiGrounded: boolean;
  readonly zeroMutation: boolean;
  readonly revisionStable: boolean;
  readonly complete: boolean;
}

interface PreparedItem {
  readonly source: AdoLiveSanitizedItem;
  readonly stage: RawSourceStage;
  readonly candidate: CanonicalKnowledgeCandidate;
  readonly decision: AdoLiveReviewDecision;
}

export class AdoLiveFinalizationError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'TARGET_MISMATCH' | 'INCOMPLETE_REVIEW'
    | 'INVALID_SEMANTIC_EVIDENCE' | 'SYNC_FAILED' | 'WIKI_FAILED') {
    super(code);
  }
}

export function finalizeAdoLiveAcceptance(
  snapshot: AdoLiveAcceptanceSnapshot,
  manifest: AdoLiveReviewManifest,
): AdoLiveFinalizationReceipt {
  validateSnapshot(snapshot);
  validateManifest(snapshot, manifest);

  const identity: BoardIdentity = {
    organization: { id: snapshot.organization, name: snapshot.organization },
    project: { ...snapshot.project },
    team: { ...snapshot.team },
    board: { ...snapshot.board },
  };
  const backlogs: readonly Backlog[] = snapshot.backlogLevels.map(level => ({
    id: level.id,
    name: level.name,
    rank: level.rank,
    type: level.type,
    workItemTypes: [...level.workItemTypes],
  }));
  const policyVersion = policyVersionForBacklogs(backlogs);
  const decisions = new Map(manifest.decisions.map(decision => [decision.itemId, decision]));
  const prepared: PreparedItem[] = snapshot.items.map(source => {
    const stage = stageFromLiveItem(source);
    const candidate = bridgeCanonicalStageToKnowledge(stage, identity);
    return { source, stage, candidate, decision: decisions.get(source.id)! };
  });
  const candidates = new Map(prepared.map(entry => [entry.source.id, entry.candidate]));

  const classifications = prepared.map(entry => {
    const semantic: SemanticClassifier | undefined = entry.decision.semantic === null
      ? undefined
      : { classify: () => structuredClone(entry.decision.semantic!) };
    const children = prepared.filter(child => child.source.parent === entry.source.id).map(child => ({
      candidate: candidates.get(child.source.id)!,
      substantive: child.decision.semantic?.verdict === 'VALIDATED' && child.decision.semantic.reusable,
    }));
    const classification = classifyCanonicalKnowledge(
      entry.candidate,
      backlogs,
      semantic,
      children,
      entry.decision.kind,
    );
    if (classification.policyVersion !== policyVersion) throw new AdoLiveFinalizationError('INVALID_INPUT');
    return { ...entry, classification };
  });

  const store = new MemorySyncStore();
  const coordinator = new SyncCoordinator(store);
  const at = snapshot.observedAt;
  coordinator.start({
    syncRunId: 'live-' + snapshot.targetDigest.slice(0, 24),
    scope: {
      organizationId: snapshot.organization,
      projectId: snapshot.project.id,
      teamId: snapshot.team.id,
      boardId: snapshot.board.id,
    },
    mode: 'FULL',
    trigger: { kind: 'MANUAL' },
    inventory: {
      snapshotId: snapshot.targetDigest,
      complete: true,
      items: prepared.map(entry => ({
        itemId: entry.source.id,
        parentId: entry.source.parent,
        backlogIds: [...entry.source.backlogIds],
      })),
    },
    policy: { gateVersion: policyVersion, minimumPromoted: 0, allowRejections: true },
    at,
  });

  const observations = prepared.map(entry => toSyncObservation(entry.stage, entry.candidate, {
    expectedCommentIds: entry.source.comments.map(comment => comment.id),
    commentsComplete: true,
    comments: entry.source.comments.map(comment => ({ ...comment })),
    relationsComplete: true,
    relations: entry.source.relations.map((relation, index) => ({
      id: 'live-relation-' + entry.source.id + '-' + index,
      kind: relation.relation,
      targetItemId: relation.targetWorkItemId,
    })),
    linksComplete: true,
    links: [],
  }));
  coordinator.checkpoint(
    'live-' + snapshot.targetDigest.slice(0, 24),
    1,
    { batchId: 'live-complete-snapshot', observations, failures: [] },
    at,
  );

  for (const entry of classifications) {
    const row = store.read().sourceStaging.find(source =>
      source.syncRunId === 'live-' + snapshot.targetDigest.slice(0, 24)
      && source.itemId === entry.source.id);
    if (row === undefined) throw new AdoLiveFinalizationError('SYNC_FAILED');
    const version = coordinator.inspect('live-' + snapshot.targetDigest.slice(0, 24)).run.version;
    coordinator.decide(
      'live-' + snapshot.targetDigest.slice(0, 24),
      version,
      gateDecisionFromClassification(
        entry.source.id,
        row.fingerprint,
        entry.classification,
        entry.decision.truthStatus,
      ),
      at,
    );
  }

  const finalVersion = coordinator.inspect('live-' + snapshot.targetDigest.slice(0, 24)).run.version;
  const finished = coordinator.finish('live-' + snapshot.targetDigest.slice(0, 24), finalVersion, at);
  if (!finished.published) throw new AdoLiveFinalizationError('SYNC_FAILED');

  const corpus = coordinator.published({
    organizationId: snapshot.organization,
    projectId: snapshot.project.id,
    teamId: snapshot.team.id,
    boardId: snapshot.board.id,
  });
  if (corpus === null) throw new AdoLiveFinalizationError('SYNC_FAILED');

  const topic: TopicDefinition = {
    id: 'live-board-knowledge',
    title: 'Live Board Knowledge Acceptance',
    hierarchyIds: [],
    groupingKeys: [...new Set(snapshot.items.flatMap(item => item.backlogIds))],
    conceptIds: [],
  };
  const wiki = buildWikiFromPublishedCorpus(corpus, { topics: [topic] });
  if (!wiki.ok) throw new AdoLiveFinalizationError('WIKI_FAILED');
  const response = queryKnowledge(wiki.value, {});
  const excluded = new Set([
    ...corpus.review.sources.map(source => String(source.itemId)),
    ...corpus.history.sources.map(source => String(source.itemId)),
  ]);
  const wikiGrounded = response.claims.every(claim =>
    claim.provenance.length > 0
    && claim.provenance.every(citation =>
      citation.reference.classification !== undefined
      && /^[a-f0-9]{64}$/.test(citation.reference.classification.digest)
      && !excluded.has(citation.reference.workItemId)));

  const classificationCounts = {
    PROMOTED: 0,
    CONTEXT_ONLY: 0,
    SUPPORTING_EVIDENCE: 0,
    REJECTED: 0,
  } as Record<'PROMOTED' | 'CONTEXT_ONLY' | 'SUPPORTING_EVIDENCE' | 'REJECTED', number>;
  const truthCounts = {
    DUPLICATE: 0,
    SUPERSEDED: 0,
    CURRENT: 0,
    CONFLICTING: 0,
    AMBIGUOUS: 0,
    NEEDS_REVIEW: 0,
  } as Record<TruthStatus, number>;
  for (const entry of classifications) {
    classificationCounts[entry.classification.status] += 1;
    truthCounts[entry.decision.truthStatus] += 1;
  }

  const complete = snapshot.zeroMutation
    && snapshot.revisionStable
    && classifications.length === snapshot.items.length
    && finished.run.audit?.complete === true
    && wikiGrounded;

  return {
    schemaVersion: 1,
    targetDigest: snapshot.targetDigest,
    policyVersion,
    sourceItemCount: snapshot.items.length,
    classifiedItemCount: classifications.length,
    classificationCounts,
    truthCounts,
    published: finished.published,
    promotedCount: corpus.promoted.sources.length,
    contextCount: corpus.contextOnly.sources.length,
    supportingEvidenceCount: corpus.supportingEvidence.sources.length,
    reviewCount: corpus.review.sources.length,
    historyCount: corpus.history.sources.length,
    wikiClaimCount: response.claims.length,
    wikiGrounded,
    zeroMutation: snapshot.zeroMutation,
    revisionStable: snapshot.revisionStable,
    complete,
  };
}

export function liveReviewBundle(snapshot: AdoLiveAcceptanceSnapshot): {
  readonly targetDigest: string;
  readonly items: readonly {
    readonly itemId: number;
    readonly revision: number;
    readonly workItemType: string | null;
    readonly title: string | null;
    readonly description: string | null;
    readonly acceptanceCriteria: string | null;
    readonly parent: number | null;
    readonly backlogIds: readonly string[];
  }[];
} {
  validateSnapshot(snapshot);
  return {
    targetDigest: snapshot.targetDigest,
    items: snapshot.items.map(item => ({
      itemId: item.id,
      revision: item.revision,
      workItemType: item.type,
      title: item.title,
      description: item.description,
      acceptanceCriteria: item.acceptanceCriteria,
      parent: item.parent,
      backlogIds: [...item.backlogIds],
    })),
  };
}

function validateSnapshot(snapshot: AdoLiveAcceptanceSnapshot): void {
  if (!snapshot || snapshot.schemaVersion !== 1
    || typeof snapshot.targetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.targetDigest)
    || !snapshot.zeroMutation || !snapshot.revisionStable
    || !Array.isArray(snapshot.items) || snapshot.items.length === 0
    || snapshot.items.some(item => !Number.isSafeInteger(item.id) || item.id < 1
      || !Number.isSafeInteger(item.revision) || item.revision < 1
      || !Array.isArray(item.backlogIds) || item.backlogIds.length === 0)) {
    throw new AdoLiveFinalizationError('INVALID_INPUT');
  }
}

function validateManifest(snapshot: AdoLiveAcceptanceSnapshot, manifest: AdoLiveReviewManifest): void {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.reviewer !== 'CHATGPT_SUPERVISED'
    || manifest.targetDigest !== snapshot.targetDigest || !Array.isArray(manifest.decisions)) {
    throw new AdoLiveFinalizationError('TARGET_MISMATCH');
  }
  const sourceIds = [...snapshot.items.map(item => item.id)].sort((a, b) => a - b);
  const decisionIds = [...manifest.decisions.map(decision => decision.itemId)].sort((a, b) => a - b);
  if (new Set(decisionIds).size !== decisionIds.length
    || JSON.stringify(sourceIds) !== JSON.stringify(decisionIds)) {
    throw new AdoLiveFinalizationError('INCOMPLETE_REVIEW');
  }
  const source = new Map(snapshot.items.map(item => [item.id, item]));
  for (const decision of manifest.decisions) {
    const item = source.get(decision.itemId);
    if (item === undefined || item.revision !== decision.revision
      || !['WORK_ITEM', 'TEST_RESULT', 'CLARIFICATION', 'LINK', 'IMPLEMENTATION_NOTE'].includes(decision.kind)
      || !['DUPLICATE', 'SUPERSEDED', 'CURRENT', 'CONFLICTING', 'AMBIGUOUS', 'NEEDS_REVIEW'].includes(decision.truthStatus)) {
      throw new AdoLiveFinalizationError('INVALID_INPUT');
    }
    if (decision.semantic !== null) validateSemantic(item, decision.semantic);
  }
}

function validateSemantic(item: AdoLiveSanitizedItem, semantic: SemanticEvidence): void {
  if (!['VALIDATED', 'NOT_KNOWLEDGE', 'AMBIGUOUS'].includes(semantic.verdict)
    || typeof semantic.reusable !== 'boolean'
    || typeof semantic.category !== 'string'
    || !Array.isArray(semantic.quotes) || semantic.quotes.length === 0) {
    throw new AdoLiveFinalizationError('INVALID_SEMANTIC_EVIDENCE');
  }
  for (const quote of semantic.quotes) {
    if (!['title', 'description', 'acceptanceCriteria'].includes(quote.field)
      || typeof quote.text !== 'string' || quote.text.trim().length === 0) {
      throw new AdoLiveFinalizationError('INVALID_SEMANTIC_EVIDENCE');
    }
    const source = quote.field === 'title' ? item.title
      : quote.field === 'description' ? item.description
        : item.acceptanceCriteria;
    if (source === null || !source.includes(quote.text)) throw new AdoLiveFinalizationError('INVALID_SEMANTIC_EVIDENCE');
  }
}

function stageFromLiveItem(item: AdoLiveSanitizedItem): RawSourceStage {
  return stageRawSource(JSON.stringify({
    id: item.id,
    rev: item.revision,
    fields: {
      'System.WorkItemType': item.type,
      'System.Title': item.title,
      'System.State': item.state,
      'System.Description': item.description,
      'Microsoft.VSTS.Common.AcceptanceCriteria': item.acceptanceCriteria,
      'System.AreaPath': item.areaPath,
      'System.IterationPath': item.iterationPath,
      'System.Parent': item.parent,
      'System.ChangedDate': item.changedDate,
    },
  }));
}

export function reviewManifestDigest(manifest: AdoLiveReviewManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}
