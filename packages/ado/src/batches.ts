import { createHash } from 'node:crypto';
import { changedDate, positiveInteger } from './normalize.js';

export interface ItemVersion {
  readonly id: number;
  readonly revision: number;
  readonly changedDate: string;
  readonly rawHash: string;
}

export type RetryClass = 'retryable' | 'permanent';
export interface BatchFailure {
  readonly classification: RetryClass;
  readonly reason: 'transport' | 'throttled' | 'server' | 'rejected';
}
export interface CollectionBatch {
  readonly key: string;
  readonly ids: readonly number[];
  readonly attempts: number;
  readonly outcome: { readonly status: 'pending' } | { readonly status: 'succeeded'; readonly items: readonly ItemVersion[] } | { readonly status: 'failed'; readonly failure: BatchFailure };
}
export interface CollectionPlan {
  readonly version: 'm3-v1';
  readonly maxAttempts: number;
  readonly batches: readonly CollectionBatch[];
}

export function classifyBatchFailure(status: number | null): BatchFailure {
  if (status === null) return { classification: 'retryable', reason: 'transport' };
  if (!Number.isInteger(status) || status < 400 || status > 599) throw new Error('Expected failed HTTP status or transport failure');
  if (status === 429) return { classification: 'retryable', reason: 'throttled' };
  if (status === 408 || status >= 500) return { classification: 'retryable', reason: 'server' };
  return { classification: 'permanent', reason: 'rejected' };
}

export function planCollection(ids: readonly number[], chunkSize = 100, maxAttempts = 3): CollectionPlan {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 200) throw new Error('Chunk size must be 1..200');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('Attempt limit must be 1..10');
  if (ids.length > 100_000) throw new Error('Collection plan exceeds limit');
  const unique = [...new Set(ids.map(positiveInteger))].sort((left, right) => left - right);
  const batches: CollectionBatch[] = [];
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    batches.push({ key: createHash('sha256').update(JSON.stringify(chunk)).digest('hex'), ids: chunk, attempts: 0, outcome: { status: 'pending' } });
  }
  return { version: 'm3-v1', maxAttempts, batches };
}

export function resumableBatches(plan: CollectionPlan): readonly CollectionBatch[] {
  return plan.batches.filter(batch => batch.attempts < plan.maxAttempts && (batch.outcome.status === 'pending' || (batch.outcome.status === 'failed' && batch.outcome.failure.classification === 'retryable')));
}

export function recordBatchResult(plan: CollectionPlan, key: string, expectedAttempts: number, result: { readonly items: readonly ItemVersion[] } | { readonly failureStatus: number | null }): CollectionPlan {
  const batch = plan.batches.find(candidate => candidate.key === key);
  if (!batch || batch.attempts !== expectedAttempts || !resumableBatches(plan).includes(batch)) throw new Error('Unknown, stale, completed or exhausted batch');
  let outcome: CollectionBatch['outcome'];
  if ('failureStatus' in result) outcome = { status: 'failed', failure: classifyBatchFailure(result.failureStatus) };
  else {
    const seen = new Set<number>();
    const items = result.items.map(item => {
      const id = positiveInteger(item.id);
      if (!batch.ids.includes(id) || seen.has(id)) throw new Error('Unexpected or duplicate response item');
      seen.add(id);
      if (!/^[a-f0-9]{64}$/.test(item.rawHash)) throw new Error('Expected source SHA-256');
      return { id, revision: positiveInteger(item.revision), changedDate: changedDate(item.changedDate), rawHash: item.rawHash };
    });
    if (seen.size !== batch.ids.length) throw new Error('Incomplete response: retain batch for retry');
    outcome = { status: 'succeeded', items };
  }
  return { ...plan, batches: plan.batches.map(candidate => candidate.key === key ? { ...batch, attempts: batch.attempts + 1, outcome } : candidate) };
}

export function restoreCollectionPlan(json: string): CollectionPlan {
  if (Buffer.byteLength(json, 'utf8') > 33_554_432) throw new Error('Checkpoint exceeds limit');
  function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid checkpoint object');
    return value as Record<string, unknown>;
  }
  const root = object(JSON.parse(json));
  if (root.version !== 'm3-v1' || !Array.isArray(root.batches) || root.batches.length > 100_000) throw new Error('Invalid checkpoint format');
  const maxAttempts = positiveInteger(root.maxAttempts);
  if (maxAttempts > 10) throw new Error('Invalid attempt limit');
  const seen = new Set<number>();
  const batches = root.batches.map(entry => {
    const saved = object(entry);
    if (!Array.isArray(saved.ids) || saved.ids.length < 1 || saved.ids.length > 200) throw new Error('Invalid checkpoint batch');
    const ids = saved.ids.map(positiveInteger);
    for (const id of ids) {
      if (seen.has(id) || seen.size >= 100_000) throw new Error('Duplicate or excessive checkpoint IDs');
      seen.add(id);
    }
    const expected = planCollection(ids, ids.length, maxAttempts).batches[0]!;
    if (saved.key !== expected.key || JSON.stringify(ids) !== JSON.stringify(expected.ids)) throw new Error('Checkpoint batch identity mismatch');
    const attempts = saved.attempts;
    if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0 || attempts > maxAttempts) throw new Error('Invalid checkpoint attempts');
    const outcome = object(saved.outcome);
    if (outcome.status === 'pending' && attempts === 0) return expected;
    if (attempts === 0) throw new Error('Missing checkpoint attempt');
    const before: CollectionPlan = { version: 'm3-v1', maxAttempts, batches: [{ ...expected, attempts: attempts - 1 }] };
    if (outcome.status === 'succeeded') {
      if (!Array.isArray(outcome.items) || outcome.items.length !== ids.length) throw new Error('Invalid checkpoint items');
      const items = outcome.items.map(entry => {
        const item = object(entry);
        if (typeof item.rawHash !== 'string') throw new Error('Invalid checkpoint hash');
        return { id: positiveInteger(item.id), revision: positiveInteger(item.revision), changedDate: changedDate(item.changedDate), rawHash: item.rawHash };
      });
      return recordBatchResult(before, expected.key, attempts - 1, { items }).batches[0]!;
    }
    if (outcome.status !== 'failed') throw new Error('Invalid checkpoint outcome');
    const failure = object(outcome.failure);
    const failureStatus = failure.reason === 'transport' ? null : failure.reason === 'throttled' ? 429 : failure.reason === 'server' ? 503 : failure.reason === 'rejected' ? 400 : undefined;
    if (failureStatus === undefined || failure.classification !== classifyBatchFailure(failureStatus).classification) throw new Error('Invalid checkpoint failure');
    return recordBatchResult(before, expected.key, attempts - 1, { failureStatus }).batches[0]!;
  });
  return { version: 'm3-v1', maxAttempts, batches };
}
