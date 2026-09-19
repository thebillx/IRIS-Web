import { auditRun, bounded, canonical, decisions, hash, identifier, itemId, reconcileMembership, requireValid, sameScope, sourceFingerprint, SyncError, timestamp, unique, validateFailure, validateGateDecisionMetadata, validateMembership, validateObservation, validatePolicy, validateScope, type Audit, type Batch, type BoardKey, type Disposition, type GateDecision, type GateRow, type Inventory, type PublicationPolicy, type RetryItems, type SourceRow, type SyncDocument, type SyncMode, type SyncRun, type SyncTrigger } from './model.js';
import type { SyncStore } from './store.js';

export interface StartSync {
  syncRunId: string;
  scope: BoardKey;
  mode: SyncMode;
  trigger: SyncTrigger;
  inventory: Inventory;
  policy: PublicationPolicy;
  at: string;
}
export interface ScheduleIntent { scheduleId: string; scope: BoardKey; mode: SyncMode; nextDueAt: string; enabled: boolean }
export interface SchedulerStatus {
  lastSuccess: { syncRunId: string; endedAt: string } | null;
  latestRun: { syncRunId: string; status: SyncRun['status'] } | null;
  activeRunIds: string[];
}
export interface SyncScheduler {
  start(request: StartSync): SyncRun;
  status(scope: BoardKey): SchedulerStatus;
}
export interface CorpusPartition { sources: SourceRow[]; comments: SyncDocument['comments']; relations: SyncDocument['relations']; links: SyncDocument['links']; membership: SyncDocument['boardMembership'] }
export interface PublishedCorpus { syncRunId: string; promoted: CorpusPartition; contextOnly: CorpusPartition; supportingEvidence: CorpusPartition }

function gateTable(document: SyncDocument, disposition: Disposition): GateRow[] {
  switch (disposition) {
    case 'PROMOTED': return document.promoted;
    case 'CONTEXT_ONLY': return document.contextOnly;
    case 'SUPPORTING_EVIDENCE': return document.supportingEvidence;
    case 'REJECTED': return document.rejectedAudit;
    default: throw new SyncError('INVALID_INPUT');
  }
}

export class SyncCoordinator implements SyncScheduler {
  constructor(private readonly store: SyncStore) {}

  private run(document: SyncDocument, syncRunId: string): SyncRun {
    identifier(syncRunId);
    const run = document.syncRuns.find(run => run.syncRunId === syncRunId);
    if (!run) throw new SyncError('NOT_FOUND');
    return run;
  }

  private save(document: SyncDocument): void {
    const generation = document.generation;
    document.generation += 1;
    this.store.compareAndSwap(generation, document);
  }

  private update(document: SyncDocument, syncRunId: string, expectedVersion: number, at: string): SyncRun {
    const run = this.run(document, syncRunId);
    itemId(expectedVersion); timestamp(at);
    if (run.version !== expectedVersion) throw new SyncError('CONFLICT');
    if (run.status === 'COMPLETE') throw new SyncError('INVALID_STATE');
    requireValid(at >= run.updatedAt);
    run.version += 1;
    run.updatedAt = at;
    run.audit = null;
    run.endedAt = null;
    return run;
  }

  start(request: StartSync): SyncRun {
    const input = structuredClone(request);
    identifier(input.syncRunId); validateScope(input.scope); validatePolicy(input.policy); timestamp(input.at);
    identifier(input.inventory.snapshotId); requireValid(typeof input.inventory.complete === 'boolean');
    requireValid(['FULL', 'INCREMENTAL'].includes(input.mode) && ['MANUAL', 'INCREMENTAL', 'SCHEDULE'].includes(input.trigger.kind));
    requireValid(input.trigger.kind !== 'INCREMENTAL' || input.mode === 'INCREMENTAL');
    if (input.trigger.kind === 'SCHEDULE') identifier(input.trigger.scheduleId);
    bounded(input.inventory.items); input.inventory.items.forEach(validateMembership);
    const document = this.store.read();
    if (document.syncRuns.some(run => run.syncRunId === input.syncRunId)) throw new SyncError('CONFLICT');
    const base = document.publishedHeads.find(head => sameScope(head.scope, input.scope))?.syncRunId ?? null;
    if (base !== null) requireValid(input.at >= this.run(document, base).endedAt!);
    if (input.mode === 'INCREMENTAL' && base === null) throw new SyncError('INVALID_STATE');
    const seen = new Set<number>();
    const duplicates = new Set<number>();
    const members = input.inventory.items.filter(member => {
      if (seen.has(member.itemId)) { duplicates.add(member.itemId); return false; }
      seen.add(member.itemId);
      return true;
    });
    const knownRuns = new Set(document.syncRuns.filter(run => run.scope.organizationId === input.scope.organizationId && run.scope.projectId === input.scope.projectId && run.status === 'COMPLETE').map(run => run.syncRunId));
    const knownIds = [...new Set(document.boardMembership.filter(member => knownRuns.has(member.syncRunId)).map(member => member.itemId))];
    const run: SyncRun = {
      syncRunId: input.syncRunId, scope: input.scope, mode: input.mode, trigger: input.trigger,
      version: 1, status: 'RUNNING', startedAt: input.at, updatedAt: input.at, endedAt: null,
      snapshotId: input.inventory.snapshotId, inventoryComplete: input.inventory.complete,
      expectedIds: members.map(member => member.itemId), duplicateIds: [...duplicates], failed: [], checkpoints: [], basePublishedRunId: base,
      policy: input.policy, reconciliation: reconcileMembership(document.boardMembership.filter(member => member.syncRunId === base), members, knownIds), audit: null,
    };
    document.syncRuns.push(run);
    document.boardMembership.push(...members.map(member => ({ ...member, syncRunId: run.syncRunId })));
    this.save(document);
    return structuredClone(run);
  }

  checkpoint(syncRunId: string, expectedVersion: number, batch: Batch, at: string): SyncRun {
    identifier(batch.batchId); bounded(batch.observations); bounded(batch.failures);
    requireValid(batch.observations.length + batch.failures.length > 0);
    batch.observations.forEach(validateObservation); batch.failures.forEach(validateFailure);
    const ids = [...batch.observations, ...batch.failures].map(entry => entry.itemId);
    unique(ids);
    const digest = hash(canonical({ kind: 'FETCH', batch }));
    const document = this.store.read();
    const original = this.run(document, syncRunId);
    const replay = original.checkpoints.find(checkpoint => checkpoint.batchId === batch.batchId);
    if (replay) {
      if (replay.kind !== 'FETCH' || replay.digest !== digest) throw new SyncError('CHECKPOINT_CONFLICT');
      return original;
    }
    if (original.status !== 'RUNNING') throw new SyncError('INVALID_STATE');
    const run = this.update(document, syncRunId, expectedVersion, at);
    requireValid(ids.every(id => run.expectedIds.includes(id)));
    for (const observation of batch.observations) {
      if (document.sourceStaging.some(source => source.syncRunId === syncRunId && source.itemId === observation.itemId)) {
        if (!run.duplicateIds.includes(observation.itemId)) run.duplicateIds.push(observation.itemId);
        continue;
      }
      const previous = document.sourceStaging.find(source => source.syncRunId === run.basePublishedRunId && source.itemId === observation.itemId);
      if (observation.content === null) requireValid(run.mode === 'INCREMENTAL' && previous && previous.revision === observation.revision && previous.changedAt === observation.changedAt);
      if (previous) requireValid(observation.revision >= previous.revision && observation.changedAt >= previous.changedAt);
      const content = observation.content ?? previous!.content;
      const source: SourceRow = {
        syncRunId, itemId: observation.itemId, revision: observation.revision, changedAt: observation.changedAt, content,
        contentHash: hash(content), fingerprint: '', contentSkipped: observation.content === null,
        expectedCommentIds: [...observation.expectedCommentIds], commentsComplete: observation.commentsComplete, relationsComplete: observation.relationsComplete, linksComplete: observation.linksComplete,
      };
      document.comments.push(...observation.comments.map(comment => ({ syncRunId, itemId: source.itemId, id: comment.id, text: comment.text })));
      document.relations.push(...observation.relations.map(relation => ({ syncRunId, itemId: source.itemId, id: relation.id, kind: relation.kind, targetItemId: relation.targetItemId })));
      document.links.push(...observation.links.map(link => ({ syncRunId, itemId: source.itemId, id: link.id, evidenceRef: link.evidenceRef })));
      source.fingerprint = sourceFingerprint(document, source);
      document.sourceStaging.push(source);
      run.failed = run.failed.filter(failure => failure.itemId !== source.itemId);
      if (run.mode === 'INCREMENTAL' && previous?.fingerprint === source.fingerprint) {
        const priorGate = decisions(document).find(gate => gate.syncRunId === run.basePublishedRunId && gate.itemId === source.itemId && gate.gateVersion === run.policy.gateVersion);
        if (priorGate) gateTable(document, priorGate.disposition).push({ ...priorGate, syncRunId, decidedAt: at });
      }
    }
    for (const failure of batch.failures) {
      if (document.sourceStaging.some(source => source.syncRunId === syncRunId && source.itemId === failure.itemId)) {
        if (!run.duplicateIds.includes(failure.itemId)) run.duplicateIds.push(failure.itemId);
      } else {
        run.failed = run.failed.filter(existing => existing.itemId !== failure.itemId);
        run.failed.push({ itemId: failure.itemId, code: failure.code });
      }
    }
    run.checkpoints.push({ batchId: batch.batchId, kind: 'FETCH', reasonCode: null, digest, itemIds: ids, fetchedIds: batch.observations.map(observation => observation.itemId), failed: batch.failures.map(failure => ({ itemId: failure.itemId, code: failure.code })), committedAt: at });
    this.save(document);
    return structuredClone(run);
  }

  retryItems(syncRunId: string, expectedVersion: number, retry: RetryItems, at: string): SyncRun {
    identifier(retry.batchId); identifier(retry.reasonCode); bounded(retry.itemIds); unique(retry.itemIds); retry.itemIds.forEach(itemId);
    requireValid(retry.itemIds.length > 0);
    const digest = hash(canonical({ kind: 'INVALIDATE', retry }));
    const document = this.store.read();
    const original = this.run(document, syncRunId);
    const replay = original.checkpoints.find(checkpoint => checkpoint.batchId === retry.batchId);
    if (replay) {
      if (replay.kind !== 'INVALIDATE' || replay.digest !== digest) throw new SyncError('CHECKPOINT_CONFLICT');
      return original;
    }
    if (original.status !== 'RUNNING') throw new SyncError('INVALID_STATE');
    const run = this.update(document, syncRunId, expectedVersion, at);
    requireValid(retry.itemIds.every(id => run.expectedIds.includes(id)));
    const ids = new Set(retry.itemIds);
    if (decisions(document).some(gate => gate.syncRunId === syncRunId && ids.has(gate.itemId))) throw new SyncError('INVALID_STATE');
    const keep = (row: { syncRunId: string; itemId: number }) => row.syncRunId !== syncRunId || !ids.has(row.itemId);
    document.sourceStaging = document.sourceStaging.filter(keep);
    document.comments = document.comments.filter(keep);
    document.relations = document.relations.filter(keep);
    document.links = document.links.filter(keep);
    run.failed = run.failed.filter(failure => !ids.has(failure.itemId));
    run.checkpoints.push({ batchId: retry.batchId, kind: 'INVALIDATE', reasonCode: retry.reasonCode, digest, itemIds: [...retry.itemIds], fetchedIds: [], failed: [], committedAt: at });
    this.save(document);
    return structuredClone(run);
  }

  decide(syncRunId: string, expectedVersion: number, decision: GateDecision, at: string): SyncRun {
    const document = this.store.read();
    const run = this.update(document, syncRunId, expectedVersion, at);
    if (run.status !== 'RUNNING') throw new SyncError('INVALID_STATE');
    identifier(decision.reasonCode);
    validateGateDecisionMetadata(decision);
    const source = document.sourceStaging.find(source => source.syncRunId === syncRunId && source.itemId === decision.itemId);
    if (!source || decision.fingerprint !== source.fingerprint || decision.gateVersion !== run.policy.gateVersion) throw new SyncError('STALE_GATE');
    if (decisions(document).some(gate => gate.syncRunId === syncRunId && gate.itemId === decision.itemId)) throw new SyncError('INVALID_STATE');
    gateTable(document, decision.disposition).push({
      syncRunId,
      itemId: decision.itemId,
      fingerprint: decision.fingerprint,
      gateVersion: decision.gateVersion,
      disposition: decision.disposition,
      reasonCode: decision.reasonCode,
      category: decision.category,
      classificationDigest: decision.classificationDigest,
      decidedAt: at,
    });
    this.save(document);
    return structuredClone(run);
  }

  pause(syncRunId: string, expectedVersion: number, at: string): SyncRun {
    const document = this.store.read();
    const run = this.update(document, syncRunId, expectedVersion, at);
    if (run.status !== 'RUNNING') throw new SyncError('INVALID_STATE');
    run.status = 'PAUSED';
    this.save(document);
    return structuredClone(run);
  }

  resume(syncRunId: string, expectedVersion: number, at: string): SyncRun {
    const document = this.store.read();
    const run = this.update(document, syncRunId, expectedVersion, at);
    run.status = 'RUNNING';
    this.save(document);
    return structuredClone(run);
  }

  inspect(syncRunId: string): { run: SyncRun; audit: Audit; pendingIds: number[] } {
    const document = this.store.read();
    const run = this.run(document, syncRunId);
    const audit = auditRun(document, run);
    return { run, audit, pendingIds: audit.missingIds };
  }

  finish(syncRunId: string, expectedVersion: number, at: string): { run: SyncRun; published: boolean } {
    const document = this.store.read();
    const run = this.update(document, syncRunId, expectedVersion, at);
    if (run.status !== 'RUNNING') throw new SyncError('INVALID_STATE');
    const audit = auditRun(document, run);
    if (audit.complete) {
      const head = document.publishedHeads.find(head => sameScope(head.scope, run.scope));
      if ((head?.syncRunId ?? null) !== run.basePublishedRunId) throw new SyncError('CONFLICT');
      if (head) head.syncRunId = run.syncRunId;
      else document.publishedHeads.push({ scope: structuredClone(run.scope), syncRunId: run.syncRunId });
    }
    run.audit = audit;
    run.status = audit.complete ? 'COMPLETE' : 'AUDIT_FAILED';
    run.endedAt = at;
    this.save(document);
    return { run: structuredClone(run), published: audit.complete };
  }

  status(scope: BoardKey): SchedulerStatus {
    validateScope(scope);
    const document = this.store.read();
    const runs = document.syncRuns.filter(run => sameScope(run.scope, scope));
    const head = document.publishedHeads.find(head => sameScope(head.scope, scope));
    const successful = head ? this.run(document, head.syncRunId) : null;
    const latest = runs.at(-1);
    return { lastSuccess: successful ? { syncRunId: successful.syncRunId, endedAt: successful.endedAt! } : null, latestRun: latest ? { syncRunId: latest.syncRunId, status: latest.status } : null, activeRunIds: runs.filter(run => run.status === 'RUNNING' || run.status === 'PAUSED').map(run => run.syncRunId) };
  }

  published(scope: BoardKey): PublishedCorpus | null {
    validateScope(scope);
    const document = this.store.read();
    const head = document.publishedHeads.find(head => sameScope(head.scope, scope));
    if (!head) return null;
    const partition = (gates: GateRow[]): CorpusPartition => {
      const ids = new Set(gates.filter(gate => gate.syncRunId === head.syncRunId).map(gate => gate.itemId));
      const matches = (row: { syncRunId: string; itemId: number }) => row.syncRunId === head.syncRunId && ids.has(row.itemId);
      return { sources: document.sourceStaging.filter(matches), comments: document.comments.filter(matches), relations: document.relations.filter(matches), links: document.links.filter(matches), membership: document.boardMembership.filter(matches) };
    };
    return { syncRunId: head.syncRunId, promoted: partition(document.promoted), contextOnly: partition(document.contextOnly), supportingEvidence: partition(document.supportingEvidence) };
  }
}
