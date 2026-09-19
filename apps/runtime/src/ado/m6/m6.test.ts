import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { auditRun, hash, planIncremental, reconcileMembership, type Batch, type BoardKey, type Disposition, type Membership, type Observation, type SyncDocument } from './model.js';
import { MemorySyncStore, type SyncStore } from './store.js';
import { SyncCoordinator, type StartSync } from './sync.js';

const at = '2026-09-15T00:00:00.000Z';
const later = '2026-09-15T01:00:00.000Z';
const scope: BoardKey = { organizationId: 'org-example', projectId: 'project-example', teamId: 'team-example', boardId: 'board-example' };
const member = (itemId: number, parentId: number | null = null, backlogIds = ['delivery']): Membership => ({ itemId, parentId, backlogIds });
const observation = (itemId: number, patch: Partial<Observation> = {}): Observation => ({
  itemId, revision: 1, changedAt: at, content: `Source ${itemId}`, expectedCommentIds: [`comment-${itemId}`], commentsComplete: true,
  comments: [{ id: `comment-${itemId}`, text: 'Synthetic comment' }], relationsComplete: true, relations: [], linksComplete: true,
  links: [{ id: `link-${itemId}`, evidenceRef: `evidence-${itemId}` }], ...patch,
});
const request = (syncRunId: string, ids: number[], patch: Partial<StartSync> = {}): StartSync => ({ syncRunId, scope, mode: 'FULL', trigger: { kind: 'MANUAL' }, inventory: { snapshotId: `snapshot-${syncRunId}`, complete: true, items: ids.map(id => member(id)) }, policy: { gateVersion: 'gate-1', minimumPromoted: 1, allowRejections: true }, at, ...patch });
function harness(store: SyncStore = new MemorySyncStore()) {
  const coordinator = new SyncCoordinator(store);
  const fetch = (syncRunId: string, observations: Observation[], batchId = 'batch-1', failures: Batch['failures'] = []) => coordinator.checkpoint(syncRunId, coordinator.inspect(syncRunId).run.version, { batchId, observations, failures }, at);
  const gate = (syncRunId: string, itemId: number, disposition: Disposition = 'PROMOTED') => {
    const source = store.read().sourceStaging.find(source => source.syncRunId === syncRunId && source.itemId === itemId)!;
    return coordinator.decide(syncRunId, coordinator.inspect(syncRunId).run.version, {
      itemId,
      fingerprint: source.fingerprint,
      gateVersion: coordinator.inspect(syncRunId).run.policy.gateVersion,
      disposition,
      reasonCode: 'SYNTHETIC_DECISION',
      category: disposition === 'PROMOTED' ? 'FUNCTIONAL_BEHAVIOR' : null,
      classificationDigest: hash(JSON.stringify([itemId, disposition, source.fingerprint])),
    }, at);
  };
  const finish = (syncRunId: string) => coordinator.finish(syncRunId, coordinator.inspect(syncRunId).run.version, at);
  const publish = (syncRunId = 'baseline', ids = [1]) => {
    coordinator.start(request(syncRunId, ids));
    fetch(syncRunId, ids.map(id => observation(id)));
    ids.forEach(id => gate(syncRunId, id));
    return finish(syncRunId);
  };
  return { store, coordinator, fetch, gate, finish, publish };
}

describe('M6 logical stores and full-sync publication', () => {
  it('starts explicitly and keeps probes side-effect free', () => {
    const store = new MemorySyncStore();
    const { coordinator } = harness(store);
    const empty = store.exportSnapshot();
    expect(coordinator.published(scope)).toBeNull();
    expect(coordinator.status(scope)).toEqual({ lastSuccess: null, latestRun: null, activeRunIds: [] });
    expect(store.exportSnapshot()).toBe(empty);
    coordinator.start(request('run-1', [1, 2]));
    const started = store.exportSnapshot();
    expect(coordinator.inspect('run-1').audit.counts).toMatchObject({ expected: 2, fetched: 0, failed: 0 });
    expect(coordinator.inspect('run-1').pendingIds).toEqual([1, 2]);
    expect(store.exportSnapshot()).toBe(started);
  });
  it('populates all logical stores and separates promoted, context, evidence and rejected items', () => {
    const { coordinator, store, fetch, gate, finish } = harness();
    coordinator.start(request('run-1', [1, 2, 3, 4]));
    fetch('run-1', [observation(1, { relations: [{ id: 'related-1', kind: 'related', targetItemId: 2 }] }), observation(2), observation(3), observation(4)]);
    gate('run-1', 1); gate('run-1', 2, 'CONTEXT_ONLY'); gate('run-1', 3, 'SUPPORTING_EVIDENCE'); gate('run-1', 4, 'REJECTED');
    expect(coordinator.published(scope)).toBeNull();
    const result = finish('run-1');
    expect(result.published).toBe(true);
    expect(result.run).toMatchObject({ syncRunId: 'run-1', startedAt: at, endedAt: at, status: 'COMPLETE', audit: { counts: { expected: 4, fetched: 4, promoted: 1, contextOnly: 1, supportingEvidence: 1, rejected: 1 } } });
    const corpus = coordinator.published(scope)!;
    expect(corpus.promoted.sources.map(source => source.itemId)).toEqual([1]);
    expect(corpus.contextOnly.sources.map(source => source.itemId)).toEqual([2]);
    expect(corpus.supportingEvidence.sources.map(source => source.itemId)).toEqual([3]);
    expect(corpus.promoted.relations).toHaveLength(1);
    expect(store.read().rejectedAudit).toHaveLength(1);
    for (const name of ['sourceStaging', 'relations', 'comments', 'links', 'boardMembership', 'promoted', 'contextOnly', 'supportingEvidence', 'rejectedAudit', 'syncRuns'] as const) expect(store.read()[name].length).toBeGreaterThan(0);
  });
  it('keeps the validated corpus intact when replacement fails audit', () => {
    const { coordinator, publish, fetch, finish } = harness();
    publish();
    const previous = coordinator.published(scope);
    coordinator.start(request('replacement', [1, 2]));
    fetch('replacement', [observation(1)], 'batch-1', [{ itemId: 2, code: 'NETWORK_FAILURE' }]);
    const result = finish('replacement');
    expect(result).toMatchObject({ published: false, run: { status: 'AUDIT_FAILED', endedAt: at, audit: { failed: [{ itemId: 2, code: 'NETWORK_FAILURE' }], missingIds: [2] } } });
    expect(coordinator.published(scope)).toEqual(previous);
    expect(coordinator.status(scope).lastSuccess?.syncRunId).toBe('baseline');
  });
  it('never completes incomplete authoritative membership, even with all observed items', () => {
    const { coordinator, fetch, gate, finish } = harness();
    coordinator.start(request('partial', [1], { inventory: { snapshotId: 'partial', complete: false, items: [member(1)] } }));
    fetch('partial', [observation(1)]); gate('partial', 1);
    expect(finish('partial').published).toBe(false);
  });
  it('enforces explicit rejection and minimum-promotion policy', () => {
    const { coordinator, fetch, gate, finish } = harness();
    coordinator.start(request('denied', [1], { policy: { gateVersion: 'gate-1', minimumPromoted: 0, allowRejections: false } }));
    fetch('denied', [observation(1)]); gate('denied', 1, 'REJECTED');
    expect(finish('denied').run.audit?.policyPassed).toBe(false);
    coordinator.start(request('empty', []));
    expect(finish('empty').published).toBe(false);
  });
  it('supports a verified empty board only under explicit empty-publication policy', () => {
    const { coordinator, finish } = harness();
    coordinator.start(request('empty', [], { policy: { gateVersion: 'gate-1', minimumPromoted: 0, allowRejections: false } }));
    expect(finish('empty').published).toBe(true);
    expect(coordinator.published(scope)?.promoted.sources).toEqual([]);
  });
  it('isolates identical work-item IDs across board scopes', () => {
    const { coordinator, publish, fetch, gate, finish } = harness();
    publish();
    const other = { ...scope, organizationId: 'other-org' };
    coordinator.start(request('other', [1], { scope: other }));
    fetch('other', [observation(1, { content: 'Other organization' })]); gate('other', 1); finish('other');
    expect(coordinator.published(scope)?.promoted.sources[0]?.content).toBe('Source 1');
    expect(coordinator.published(other)?.promoted.sources[0]?.content).toBe('Other organization');
  });
});

describe('M6 checkpoints, resume and concurrency', () => {
  it('atomically checkpoints fetched and failed counts, then resumes only missing IDs', () => {
    const { coordinator, fetch, gate, finish } = harness();
    coordinator.start(request('run-1', [1, 2]));
    fetch('run-1', [observation(1)], 'first', [{ itemId: 2, code: 'RATE_LIMITED' }]);
    gate('run-1', 1);
    expect(finish('run-1').run.audit?.counts).toMatchObject({ expected: 2, fetched: 1, failed: 1 });
    const failed = coordinator.inspect('run-1').run;
    coordinator.resume('run-1', failed.version, at);
    fetch('run-1', [observation(2)], 'retry'); gate('run-1', 2);
    const result = finish('run-1');
    expect(result.run.checkpoints.map(checkpoint => checkpoint.batchId)).toEqual(['first', 'retry']);
    expect(result.run.checkpoints[0]!.failed).toEqual([{ itemId: 2, code: 'RATE_LIMITED' }]);
    expect(result.run.audit?.counts).toMatchObject({ fetched: 2, failed: 0 });
    expect(result.published).toBe(true);
  });
  it('makes exact batch replay idempotent even after lost acknowledgement', () => {
    const backing = new MemorySyncStore();
    let loseAck = false;
    const store: SyncStore = { read: () => backing.read(), compareAndSwap: (generation, next) => { backing.compareAndSwap(generation, next); if (loseAck) throw new Error('ACK_LOST'); } };
    const { coordinator } = harness(store);
    const run = coordinator.start(request('run-1', [1]));
    const batch = { batchId: 'first', observations: [observation(1)], failures: [] };
    loseAck = true;
    expect(() => coordinator.checkpoint('run-1', run.version, batch, at)).toThrow('ACK_LOST');
    const snapshot = backing.exportSnapshot();
    expect(coordinator.checkpoint('run-1', run.version, batch, at).checkpoints).toHaveLength(1);
    expect(backing.exportSnapshot()).toBe(snapshot);
    expect(() => coordinator.checkpoint('run-1', run.version, { ...batch, observations: [observation(1, { content: 'Changed' })] }, at)).toThrow('CHECKPOINT_CONFLICT');
  });
  it('rolls back every batch row if storage commit fails before acknowledgement', () => {
    const backing = new MemorySyncStore();
    let fail = false;
    const store: SyncStore = { read: () => backing.read(), compareAndSwap: (generation, next) => { if (fail) throw new Error('STORAGE_FAILURE'); backing.compareAndSwap(generation, next); } };
    const { coordinator, fetch } = harness(store);
    coordinator.start(request('run-1', [1]));
    const snapshot = backing.exportSnapshot(); fail = true;
    expect(() => fetch('run-1', [observation(1)])).toThrow('STORAGE_FAILURE');
    expect(backing.exportSnapshot()).toBe(snapshot);
  });
  it('rejects stale workers and stale whole-document commits', () => {
    const store = new MemorySyncStore();
    const { coordinator } = harness(store);
    const run = coordinator.start(request('run-1', [1]));
    const stale = store.read();
    coordinator.pause('run-1', run.version, at);
    expect(() => coordinator.resume('run-1', run.version, at)).toThrow('CONFLICT');
    stale.generation += 1;
    expect(() => store.compareAndSwap(stale.generation - 1, stale)).toThrow('CONFLICT');
  });
  it('does not let an older run overwrite a newly published corpus', () => {
    const { coordinator, fetch, gate, finish } = harness();
    coordinator.start(request('older', [1])); coordinator.start(request('newer', [1]));
    fetch('older', [observation(1)]); gate('older', 1);
    fetch('newer', [observation(1, { content: 'Newer' })]); gate('newer', 1); finish('newer');
    expect(() => finish('older')).toThrow('CONFLICT');
    expect(coordinator.published(scope)?.syncRunId).toBe('newer');
    expect(coordinator.inspect('older').run.status).toBe('RUNNING');
  });
  it('records duplicates from inventory and repeated non-replay batches without publishing', () => {
    const { coordinator, fetch, gate, finish } = harness();
    coordinator.start(request('run-1', [1, 1]));
    fetch('run-1', [observation(1)]); fetch('run-1', [observation(1)], 'second'); gate('run-1', 1);
    expect(finish('run-1').run.audit).toMatchObject({ duplicates: [1], complete: false, counts: { fetched: 1 } });
  });
  it('blocks mutation of paused or completed runs and refuses reversed time', () => {
    const { coordinator, fetch, publish } = harness();
    publish();
    expect(() => coordinator.resume('baseline', coordinator.inspect('baseline').run.version, at)).toThrow('INVALID_STATE');
    coordinator.start(request('paused', [1]));
    coordinator.pause('paused', 1, later);
    expect(() => fetch('paused', [observation(1)])).toThrow('INVALID_STATE');
    expect(() => coordinator.resume('paused', 2, at)).toThrow('INVALID_INPUT');
  });
});

describe('M6 explicit retries and commit failures', () => {
  it('explicitly invalidates an incomplete ungated item before re-fetching', () => {
    const { coordinator, store, fetch, gate, finish } = harness();
    coordinator.start(request('partial', [1]));
    const partial = observation(1, { commentsComplete: false, comments: [] });
    fetch('partial', [partial]);
    expect(finish('partial').published).toBe(false);
    const resumed = coordinator.resume('partial', coordinator.inspect('partial').run.version, at);
    const retry = { batchId: 'retry-checkpoint', itemIds: [1], reasonCode: 'INCOMPLETE_COMMENTS' };
    coordinator.retryItems('partial', resumed.version, retry, at);
    expect(coordinator.inspect('partial').pendingIds).toEqual([1]);
    expect(store.read().sourceStaging).toEqual([]);
    expect(store.read().links).toEqual([]);
    const generation = store.read().generation;
    coordinator.retryItems('partial', resumed.version, retry, at);
    fetch('partial', [partial]);
    expect(store.read().generation).toBe(generation);
    expect(coordinator.inspect('partial').pendingIds).toEqual([1]);
    fetch('partial', [observation(1)], 're-fetched'); gate('partial', 1);
    expect(finish('partial').published).toBe(true);
    expect(coordinator.inspect('partial').run.checkpoints.map(checkpoint => checkpoint.kind)).toEqual(['FETCH', 'INVALIDATE', 'FETCH']);
  });
  it('preserves rejection audits instead of erasing decisions during retries', () => {
    const { coordinator, store, fetch, gate } = harness();
    coordinator.start(request('rejected', [1])); fetch('rejected', [observation(1)]); gate('rejected', 1, 'REJECTED');
    const before = store.read();
    expect(() => coordinator.retryItems('rejected', coordinator.inspect('rejected').run.version, { batchId: 'retry', itemIds: [1], reasonCode: 'RETRY' }, at)).toThrow('INVALID_STATE');
    expect(store.read()).toEqual(before);
  });
  it('does not partially replace publication when the final storage commit fails', () => {
    const backing = new MemorySyncStore();
    let fail = false;
    const store: SyncStore = { read: () => backing.read(), compareAndSwap: (generation, next) => { if (fail) throw new Error('STORAGE_FAILURE'); backing.compareAndSwap(generation, next); } };
    const { coordinator, publish, fetch, gate, finish } = harness(store);
    publish(); coordinator.start(request('replacement', [1])); fetch('replacement', [observation(1, { content: 'Replacement' })]); gate('replacement', 1);
    const before = backing.exportSnapshot(); fail = true;
    expect(() => finish('replacement')).toThrow('STORAGE_FAILURE');
    expect(backing.exportSnapshot()).toBe(before);
    expect(coordinator.published(scope)?.syncRunId).toBe('baseline');
  });
});

describe('M6 completeness audit', () => {
  it('reports missing parents, comments, relation targets and attachment enumeration failures', () => {
    const { coordinator, fetch, gate, finish } = harness();
    coordinator.start(request('run-1', [1], { inventory: { snapshotId: 'snapshot', complete: true, items: [member(1, 9)] } }));
    fetch('run-1', [observation(1, { comments: [], commentsComplete: false, relations: [{ id: 'relation-1', kind: 'related', targetItemId: 8 }], relationsComplete: false, linksComplete: false })]);
    gate('run-1', 1);
    expect(finish('run-1').run.audit).toMatchObject({ complete: false, missingParents: [{ itemId: 1, parentId: 9 }], missingComments: [{ itemId: 1, commentId: 'comment-1' }], unresolvedRelations: [{ itemId: 1, relationId: 'relation-1', targetItemId: 8 }], incompleteComments: [1], incompleteRelations: [1], incompleteLinks: [1] });
  });
  it('audits orphan rows and never treats an unexpected comment as complete enumeration', () => {
    const { coordinator, fetch, store, gate, finish } = harness();
    coordinator.start(request('run-1', [1]));
    fetch('run-1', [observation(1, { expectedCommentIds: [] })]); gate('run-1', 1);
    expect(finish('run-1').run.audit?.incompleteComments).toEqual([1]);
    const document = store.read();
    document.comments.push({ syncRunId: 'run-1', itemId: 99, id: 'orphan', text: '' });
    expect(auditRun(document, document.syncRuns[0]!).orphans).toEqual([99]);
  });
  it('refuses gate decisions for stale fingerprints or a different policy version', () => {
    const { coordinator, fetch, store } = harness();
    coordinator.start(request('run-1', [1])); fetch('run-1', [observation(1)]);
    const base = {
      itemId: 1,
      fingerprint: store.read().sourceStaging[0]!.fingerprint,
      gateVersion: 'gate-1',
      disposition: 'PROMOTED' as const,
      reasonCode: 'PASS',
      category: 'FUNCTIONAL_BEHAVIOR',
      classificationDigest: hash('synthetic-classification'),
    };
    expect(() => coordinator.decide('run-1', 2, { ...base, fingerprint: hash('stale') }, at)).toThrow('STALE_GATE');
    expect(() => coordinator.decide('run-1', 2, { ...base, gateVersion: 'other-gate' }, at)).toThrow('STALE_GATE');
    expect(coordinator.finish('run-1', 2, at).published).toBe(false);
  });
});

describe('M6 incremental sync and membership reconciliation', () => {
  it('reconciles new, moved-in, moved-out and hierarchy changes independently of query hints', () => {
    expect(reconcileMembership([member(1), member(2)], [member(1, 3, ['strategy']), member(3), member(4)], [1, 2, 3])).toEqual({ newIds: [4], movedIn: [3], movedOut: [2], hierarchyChanged: [1] });
    expect(reconcileMembership([member(1, null, ['strategy', 'delivery'])], [member(1, null, ['delivery', 'strategy'])], [1]).hierarchyChanged).toEqual([]);
  });
  it('plans version and attachment rechecks for every membership ID, including absent change-query results', () => {
    const inventory = { snapshotId: 'inventory', complete: true, items: [member(1), member(2), member(3)] };
    const previous = [1, 2].map(id => ({ itemId: id, revision: 1, changedAt: at, content: 'old' }));
    expect(planIncremental(previous, inventory, [{ itemId: 2, revision: 2, changedAt: later }])).toEqual([
      { itemId: 1, content: 'RECHECK_VERSION', recheckComments: true, recheckRelations: true, recheckLinks: true },
      { itemId: 2, content: 'FETCH', recheckComments: true, recheckRelations: true, recheckLinks: true },
      { itemId: 3, content: 'FETCH', recheckComments: true, recheckRelations: true, recheckLinks: true },
    ]);
    expect(() => planIncremental(previous, { ...inventory, complete: false }, [])).toThrow('INVALID_INPUT');
  });
  it('skips unchanged content and reuses gate decisions only after attachment rechecks', () => {
    const { coordinator, publish, fetch, finish } = harness();
    publish();
    coordinator.start(request('incremental', [1], { mode: 'INCREMENTAL', trigger: { kind: 'INCREMENTAL' } }));
    fetch('incremental', [observation(1, { content: null })]);
    expect(coordinator.inspect('incremental').audit.pendingGate).toEqual([]);
    expect(finish('incremental').run.audit?.counts.contentSkipped).toBe(1);
    expect(coordinator.published(scope)?.promoted.sources[0]?.contentHash).toBe(hash('Source 1'));
  });
  it.each([
    { content: 'Changed content' },
    { content: 'Source 1', revision: 2, changedAt: later },
    { content: null, comments: [{ id: 'comment-1', text: 'Edited comment' }] },
    { content: null, relations: [{ id: 'new-relation', kind: 'related', targetItemId: 1 }] },
    { content: null, links: [{ id: 'new-link', evidenceRef: 'new-evidence' }] },
  ] satisfies Partial<Observation>[])('requires a fresh Knowledge Gate for changed source or attachments %#', patch => {
    const { coordinator, publish, fetch, gate, finish } = harness();
    publish();
    coordinator.start(request('incremental', [1], { mode: 'INCREMENTAL' }));
    fetch('incremental', [observation(1, patch)]);
    expect(coordinator.inspect('incremental').audit.pendingGate).toEqual([1]);
    expect(coordinator.published(scope)?.syncRunId).toBe('baseline');
    gate('incremental', 1); expect(finish('incremental').published).toBe(true);
  });
  it('requires re-gating on hierarchy or policy changes even if content is identical', () => {
    const { coordinator, publish, fetch } = harness();
    publish();
    coordinator.start(request('hierarchy', [1], { mode: 'INCREMENTAL', inventory: { snapshotId: 'changed', complete: true, items: [member(1, null, ['strategy'])] } }));
    fetch('hierarchy', [observation(1, { content: null })]);
    expect(coordinator.inspect('hierarchy').audit.pendingGate).toEqual([1]);
    coordinator.start(request('policy', [1], { mode: 'INCREMENTAL', policy: { gateVersion: 'gate-2', minimumPromoted: 1, allowRejections: true } }));
    fetch('policy', [observation(1, { content: null })]);
    expect(coordinator.inspect('policy').audit.pendingGate).toEqual([1]);
  });
  it('rejects unsafe body skips and backwards revisions', () => {
    const { coordinator, publish, fetch } = harness();
    expect(() => coordinator.start(request('no-base', [1], { mode: 'INCREMENTAL' }))).toThrow('INVALID_STATE');
    publish();
    coordinator.start(request('incremental', [1, 2], { mode: 'INCREMENTAL' }));
    expect(() => fetch('incremental', [observation(1, { content: null, revision: 2 })])).toThrow('INVALID_INPUT');
    expect(() => fetch('incremental', [observation(2, { content: null })])).toThrow('INVALID_INPUT');
    expect(() => fetch('incremental', [observation(1, { changedAt: '2026-09-14T00:00:00.000Z' })])).toThrow('INVALID_INPUT');
    expect(coordinator.inspect('incremental').audit.counts.fetched).toBe(0);
  });
  it('removes moved-out members only on successful replacement and detects later moved-in members', () => {
    const { coordinator, publish, fetch, gate, finish } = harness();
    publish('baseline', [1, 2]);
    coordinator.start(request('leave', [1], { mode: 'INCREMENTAL' }));
    expect(coordinator.inspect('leave').run.reconciliation.movedOut).toEqual([2]);
    expect(coordinator.published(scope)?.promoted.sources).toHaveLength(2);
    fetch('leave', [observation(1, { content: null })]); finish('leave');
    expect(coordinator.published(scope)?.promoted.sources.map(source => source.itemId)).toEqual([1]);
    coordinator.start(request('return', [1, 2], { mode: 'INCREMENTAL' }));
    expect(coordinator.inspect('return').run.reconciliation).toMatchObject({ newIds: [], movedIn: [2] });
    fetch('return', [observation(1, { content: null }), observation(2)]); gate('return', 2);
    expect(finish('return').published).toBe(true);
  });
});

describe('M6 restart durability contract and scheduler port', () => {
  it('resumes checkpoints after coordinator and storage-adapter replacement', () => {
    const store = new MemorySyncStore();
    const first = harness(store);
    first.coordinator.start(request('run-1', [1, 2])); first.fetch('run-1', [observation(1)]);
    first.coordinator.pause('run-1', 2, at);
    const restored = MemorySyncStore.restore(store.exportSnapshot());
    const second = harness(restored);
    expect(second.coordinator.inspect('run-1').pendingIds).toEqual([2]);
    second.coordinator.resume('run-1', 3, at); second.fetch('run-1', [observation(2)], 'second');
    second.gate('run-1', 1); second.gate('run-1', 2);
    expect(second.finish('run-1').published).toBe(true);
    expect(first.coordinator.inspect('run-1').run.status).toBe('PAUSED');
  });
  it('round-trips committed state through a fresh Node process and continues from its next checkpoint', () => {
    const store = new MemorySyncStore();
    const first = harness(store);
    first.coordinator.start(request('run-1', [1, 2])); first.fetch('run-1', [observation(1)]);
    const script = `
      import { readFileSync } from 'node:fs';
      import { MemorySyncStore } from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)};
      import { SyncCoordinator } from ${JSON.stringify(new URL('./sync.ts', import.meta.url).href)};
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const store = MemorySyncStore.restore(input.snapshot);
      const coordinator = new SyncCoordinator(store);
      const run = coordinator.resume('run-1', coordinator.inspect('run-1').run.version, input.at);
      coordinator.checkpoint('run-1', run.version, input.batch, input.at);
      process.stdout.write(store.exportSnapshot());
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { input: JSON.stringify({ snapshot: store.exportSnapshot(), at, batch: { batchId: 'after-restart', observations: [observation(2)], failures: [] } }), encoding: 'utf8', timeout: 15_000, maxBuffer: 1_048_576 });
    expect(child.status, child.stderr).toBe(0);
    const second = harness(MemorySyncStore.restore(child.stdout));
    expect(second.coordinator.inspect('run-1').audit.counts.fetched).toBe(2);
    expect(second.coordinator.inspect('run-1').run.checkpoints.map(checkpoint => checkpoint.batchId)).toEqual(['batch-1', 'after-restart']);
    second.gate('run-1', 1); second.gate('run-1', 2); second.finish('run-1');
    expect(second.coordinator.status(scope).lastSuccess).toEqual({ syncRunId: 'run-1', endedAt: at });
  });
  it.each([
    (document: SyncDocument) => { Object.assign(document, { schemaVersion: 99 }); },
    (document: SyncDocument) => { document.sourceStaging[0]!.content = 'Tampered'; },
    (document: SyncDocument) => { document.comments[0]!.text = 'Tampered'; },
    (document: SyncDocument) => { document.promoted[0]!.fingerprint = hash('Tampered'); },
    (document: SyncDocument) => { document.syncRuns[0]!.audit!.counts.fetched = 999; },
    (document: SyncDocument) => { document.publishedHeads[0]!.scope.boardId = 'other-board'; },
    (document: SyncDocument) => { document.sourceStaging.push(document.sourceStaging[0]!); },
  ])('rejects corrupt or incompatible restart snapshots %#', corrupt => {
    const { store, publish } = harness(); publish();
    const document = store.read(); corrupt(document);
    expect(() => MemorySyncStore.restore(JSON.stringify(document))).toThrow('INVALID_SNAPSHOT');
  });
  it('returns detached snapshots and rejects truncated persistence data', () => {
    const store = new MemorySyncStore(); const { publish } = harness(store); publish();
    const snapshot = store.exportSnapshot();
    store.read().sourceStaging[0]!.content = 'Changed';
    expect(store.exportSnapshot()).toBe(snapshot);
    expect(() => MemorySyncStore.restore(snapshot.slice(0, -1))).toThrow('INVALID_SNAPSHOT');
    expect(() => MemorySyncStore.restore('null')).toThrow('INVALID_SNAPSHOT');
  });
  it('prevents low-level rewrites of completed run history and publication rollback', () => {
    const store = new MemorySyncStore(); const { publish } = harness(store); publish(); publish('second');
    const history = store.read(); history.generation += 1;
    history.syncRuns[0]!.snapshotId = 'rewritten';
    expect(() => store.compareAndSwap(history.generation - 1, history)).toThrow('INVALID_INPUT');
    const rollback = store.read(); rollback.generation += 1; rollback.publishedHeads[0]!.syncRunId = 'baseline';
    expect(() => store.compareAndSwap(rollback.generation - 1, rollback)).toThrow('INVALID_SNAPSHOT');
    expect(() => MemorySyncStore.restore(JSON.stringify(rollback))).toThrow('INVALID_SNAPSHOT');
  });
  it('records manual, incremental and future-schedule triggers without scheduling execution', () => {
    const { coordinator, publish } = harness(); publish();
    coordinator.start(request('scheduled-request', [1], { mode: 'INCREMENTAL', trigger: { kind: 'SCHEDULE', scheduleId: 'future-schedule' } }));
    expect(coordinator.inspect('scheduled-request').run.trigger).toEqual({ kind: 'SCHEDULE', scheduleId: 'future-schedule' });
    expect(coordinator.status(scope)).toEqual({ lastSuccess: { syncRunId: 'baseline', endedAt: at }, latestRun: { syncRunId: 'scheduled-request', status: 'RUNNING' }, activeRunIds: ['scheduled-request'] });
  });
});
