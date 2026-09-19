import { auditRun, bounded, canonical, decisions, hash, identifier, itemId, MAX_SNAPSHOT_BYTES, requireValid, sameScope, sourceFingerprint, SyncError, timestamp, unique, validateFailure, validateGateDecisionMetadata, validateMembership, validateObservation, validatePolicy, validateScope, type Disposition, type SyncDocument } from './model.js';

export interface SyncStore {
  read(): SyncDocument;
  compareAndSwap(expectedGeneration: number, next: SyncDocument): void;
}

export function emptyDocument(): SyncDocument {
  return { schemaVersion: 1, generation: 0, syncRuns: [], sourceStaging: [], relations: [], comments: [], links: [], boardMembership: [], promoted: [], contextOnly: [], supportingEvidence: [], rejectedAudit: [], publishedHeads: [] };
}

export function validateDocument(document: SyncDocument): void {
  try {
    requireValid(document.schemaVersion === 1 && Number.isSafeInteger(document.generation) && document.generation >= 0);
    [document.syncRuns, document.sourceStaging, document.relations, document.comments, document.links, document.boardMembership, document.promoted, document.contextOnly, document.supportingEvidence, document.rejectedAudit, document.publishedHeads].forEach(bounded);
    requireValid(Buffer.byteLength(JSON.stringify(document), 'utf8') <= MAX_SNAPSHOT_BYTES);
    unique(document.syncRuns.map(run => run.syncRunId));
    unique(document.sourceStaging.map(row => canonical([row.syncRunId, row.itemId])));
    unique(document.boardMembership.map(row => canonical([row.syncRunId, row.itemId])));
    unique(decisions(document).map(row => canonical([row.syncRunId, row.itemId])));
    unique(document.publishedHeads.map(head => canonical([head.scope.organizationId, head.scope.projectId, head.scope.teamId, head.scope.boardId])));
    for (const run of document.syncRuns) {
      identifier(run.syncRunId); validateScope(run.scope); itemId(run.version);
      requireValid(['FULL', 'INCREMENTAL'].includes(run.mode) && ['RUNNING', 'PAUSED', 'AUDIT_FAILED', 'COMPLETE'].includes(run.status));
      requireValid(['MANUAL', 'INCREMENTAL', 'SCHEDULE'].includes(run.trigger.kind));
      requireValid(run.trigger.kind !== 'INCREMENTAL' || run.mode === 'INCREMENTAL');
      if (run.trigger.kind === 'SCHEDULE') identifier(run.trigger.scheduleId);
      timestamp(run.startedAt); timestamp(run.updatedAt);
      requireValid(run.updatedAt >= run.startedAt);
      if (run.endedAt !== null) { timestamp(run.endedAt); requireValid(run.endedAt === run.updatedAt); }
      requireValid((run.status === 'COMPLETE' || run.status === 'AUDIT_FAILED') === (run.endedAt !== null));
      identifier(run.snapshotId); requireValid(typeof run.inventoryComplete === 'boolean'); validatePolicy(run.policy);
      bounded(run.expectedIds); unique(run.expectedIds); run.expectedIds.forEach(itemId);
      bounded(run.duplicateIds); unique(run.duplicateIds); run.duplicateIds.forEach(id => { itemId(id); requireValid(run.expectedIds.includes(id)); });
      bounded(run.failed); unique(run.failed.map(failure => failure.itemId));
      run.failed.forEach(failure => { validateFailure(failure); requireValid(run.expectedIds.includes(failure.itemId) && !document.sourceStaging.some(source => source.syncRunId === run.syncRunId && source.itemId === failure.itemId)); });
      bounded(run.checkpoints); unique(run.checkpoints.map(checkpoint => checkpoint.batchId));
      for (const checkpoint of run.checkpoints) {
        identifier(checkpoint.batchId); requireValid(/^[a-f0-9]{64}$/.test(checkpoint.digest)); timestamp(checkpoint.committedAt);
        requireValid(['FETCH', 'INVALIDATE'].includes(checkpoint.kind));
        if (checkpoint.kind === 'INVALIDATE') { requireValid(checkpoint.reasonCode !== null); identifier(checkpoint.reasonCode); }
        else requireValid(checkpoint.reasonCode === null);
        requireValid(checkpoint.committedAt >= run.startedAt && checkpoint.committedAt <= run.updatedAt);
        bounded(checkpoint.itemIds); unique(checkpoint.itemIds);
        checkpoint.itemIds.forEach(id => { itemId(id); requireValid(run.expectedIds.includes(id)); });
        bounded(checkpoint.fetchedIds); unique(checkpoint.fetchedIds); checkpoint.fetchedIds.forEach(itemId);
        bounded(checkpoint.failed); checkpoint.failed.forEach(validateFailure);
        const observedIds = [...checkpoint.fetchedIds, ...checkpoint.failed.map(failure => failure.itemId)];
        unique(observedIds);
        if (checkpoint.kind === 'FETCH') requireValid(canonical(observedIds) === canonical(checkpoint.itemIds));
        else requireValid(observedIds.length === 0);
      }
      if (run.basePublishedRunId !== null) {
        requireValid(document.syncRuns.some(base => base.syncRunId === run.basePublishedRunId && base.status === 'COMPLETE' && sameScope(base.scope, run.scope) && base.syncRunId !== run.syncRunId));
        requireValid(document.syncRuns.findIndex(base => base.syncRunId === run.basePublishedRunId) < document.syncRuns.indexOf(run));
      }
      for (const ids of [run.reconciliation.newIds, run.reconciliation.movedIn, run.reconciliation.movedOut, run.reconciliation.hierarchyChanged]) { bounded(ids); unique(ids); ids.forEach(itemId); }
      const members = document.boardMembership.filter(member => member.syncRunId === run.syncRunId);
      requireValid(canonical(members.map(member => member.itemId).sort((left, right) => left - right)) === canonical([...run.expectedIds].sort((left, right) => left - right)));
    }
    for (const member of document.boardMembership) {
      validateMembership(member);
      requireValid(document.syncRuns.some(run => run.syncRunId === member.syncRunId && run.expectedIds.includes(member.itemId)));
    }
    for (const rows of [document.comments, document.relations, document.links]) {
      unique(rows.map(row => canonical([row.syncRunId, row.itemId, row.id])));
      for (const row of rows) requireValid(document.sourceStaging.some(source => source.syncRunId === row.syncRunId && source.itemId === row.itemId));
    }
    for (const source of document.sourceStaging) {
      const run = document.syncRuns.find(run => run.syncRunId === source.syncRunId);
      requireValid(run && run.expectedIds.includes(source.itemId) && run.checkpoints.some(checkpoint => checkpoint.itemIds.includes(source.itemId)));
      requireValid(run.checkpoints.filter(checkpoint => checkpoint.itemIds.includes(source.itemId)).at(-1)?.kind === 'FETCH');
      requireValid(typeof source.content === 'string' && typeof source.contentSkipped === 'boolean');
      if (source.contentSkipped) {
        const previous = document.sourceStaging.find(row => row.syncRunId === run.basePublishedRunId && row.itemId === source.itemId);
        requireValid(run.mode === 'INCREMENTAL' && previous && previous.contentHash === source.contentHash && previous.revision === source.revision && previous.changedAt === source.changedAt);
      }
      validateObservation({ ...source, comments: document.comments.filter(row => row.syncRunId === source.syncRunId && row.itemId === source.itemId), relations: document.relations.filter(row => row.syncRunId === source.syncRunId && row.itemId === source.itemId), links: document.links.filter(row => row.syncRunId === source.syncRunId && row.itemId === source.itemId) });
      requireValid(source.contentHash === hash(source.content) && source.fingerprint === sourceFingerprint(document, source));
    }
    const tables: [Disposition, SyncDocument['promoted']][] = [['PROMOTED', document.promoted], ['CONTEXT_ONLY', document.contextOnly], ['SUPPORTING_EVIDENCE', document.supportingEvidence], ['REJECTED', document.rejectedAudit]];
    for (const [disposition, rows] of tables) {
      for (const gate of rows) {
        const run = document.syncRuns.find(run => run.syncRunId === gate.syncRunId);
        const source = document.sourceStaging.find(source => source.syncRunId === gate.syncRunId && source.itemId === gate.itemId);
        requireValid(run && source && gate.disposition === disposition && gate.fingerprint === source.fingerprint && gate.gateVersion === run.policy.gateVersion);
        identifier(gate.reasonCode); validateGateDecisionMetadata(gate); timestamp(gate.decidedAt);
        requireValid(gate.decidedAt >= run.startedAt && gate.decidedAt <= run.updatedAt);
      }
    }
    for (const run of document.syncRuns) {
      if (run.status === 'COMPLETE' || run.status === 'AUDIT_FAILED') {
        const audit = auditRun(document, run);
        requireValid(canonical(audit) === canonical(run.audit) && (run.status === 'COMPLETE') === audit.complete);
      } else requireValid(run.audit === null);
    }
    for (const head of document.publishedHeads) {
      validateScope(head.scope);
      requireValid(document.syncRuns.some(run => run.syncRunId === head.syncRunId && run.status === 'COMPLETE' && sameScope(run.scope, head.scope)));
      requireValid(!document.syncRuns.some(run => run.status === 'COMPLETE' && run.basePublishedRunId === head.syncRunId));
    }
    for (const run of document.syncRuns.filter(run => run.status === 'COMPLETE')) requireValid(document.publishedHeads.some(head => sameScope(head.scope, run.scope)));
  } catch {
    throw new SyncError('INVALID_SNAPSHOT');
  }
}

export function validateTransition(current: SyncDocument, expectedGeneration: number, next: SyncDocument): void {
  if (current.generation !== expectedGeneration) throw new SyncError('CONFLICT');
  if (next.generation !== expectedGeneration + 1) throw new SyncError('CONFLICT');
  validateDocument(next);
  const completed = new Set(current.syncRuns.filter(run => run.status === 'COMPLETE').map(run => run.syncRunId));
  for (const key of ['syncRuns', 'sourceStaging', 'relations', 'comments', 'links', 'boardMembership', 'promoted', 'contextOnly', 'supportingEvidence', 'rejectedAudit'] as const) {
    requireValid(canonical(current[key].filter(row => completed.has(row.syncRunId))) === canonical(next[key].filter(row => completed.has(row.syncRunId))));
  }
  for (const previous of current.publishedHeads) requireValid(next.publishedHeads.some(head => sameScope(head.scope, previous.scope)));
  for (const head of next.publishedHeads) {
    const prior = current.publishedHeads.find(previous => sameScope(previous.scope, head.scope));
    if (prior?.syncRunId !== head.syncRunId) {
      const run = next.syncRuns.find(run => run.syncRunId === head.syncRunId)!;
      requireValid(!completed.has(head.syncRunId) && run.basePublishedRunId === (prior?.syncRunId ?? null));
    }
  }
}

export class MemorySyncStore implements SyncStore {
  #document: SyncDocument;

  constructor() { this.#document = emptyDocument(); }

  read(): SyncDocument { return structuredClone(this.#document); }

  compareAndSwap(expectedGeneration: number, next: SyncDocument): void {
    validateTransition(this.#document, expectedGeneration, next);
    this.#document = structuredClone(next);
  }

  exportSnapshot(): string { return JSON.stringify(this.#document); }

  static restore(snapshot: string): MemorySyncStore {
    try {
      requireValid(typeof snapshot === 'string' && Buffer.byteLength(snapshot, 'utf8') <= MAX_SNAPSHOT_BYTES);
      const document = JSON.parse(snapshot) as SyncDocument;
      validateDocument(document);
      const store = new MemorySyncStore();
      store.#document = structuredClone(document);
      return store;
    } catch {
      throw new SyncError('INVALID_SNAPSHOT');
    }
  }
}
