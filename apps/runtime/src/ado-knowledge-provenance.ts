import { createHash } from 'node:crypto';
import { RuntimeError } from '@iris/domain';

export interface KnowledgeWorkItem {
  readonly scopeId: string;
  readonly workItemId: string;
}

export type KnowledgeSource =
  | { readonly kind: 'FIELD'; readonly name: string }
  | { readonly kind: 'COMMENT'; readonly commentId: string; readonly version: number }
  | { readonly kind: 'RELATION'; readonly relationId: string };

export interface KnowledgeProvenance {
  readonly sourceWorkItem: KnowledgeWorkItem;
  readonly revision: number;
  readonly source: KnowledgeSource;
  readonly changedDate: string;
  readonly contentHash: string;
}

export interface KnowledgeFact {
  readonly schemaVersion: 1;
  readonly authority: 'OFFICIAL_FIELD' | 'COMMENT' | 'RELATION';
  readonly format: 'PLAIN_TEXT';
  readonly body: string;
  readonly provenance: KnowledgeProvenance;
}

export interface KnowledgeRevisionDiff {
  readonly schemaVersion: 1;
  readonly diffId: string;
  readonly before: KnowledgeProvenance;
  readonly after: KnowledgeProvenance;
  readonly contentChanged: boolean;
}

export function knowledgeAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RuntimeError('INVALID_REQUEST', message);
}

export function knowledgeId(value: string): string {
  knowledgeAssert(typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value), 'Invalid knowledge identifier');
  return value;
}

export function knowledgeVersion(value: number): number {
  knowledgeAssert(Number.isSafeInteger(value) && value > 0, 'Invalid knowledge revision or version');
  return value;
}

export function workItemKey(item: KnowledgeWorkItem): string {
  knowledgeAssert(item !== null && typeof item === 'object', 'Missing source work item');
  return JSON.stringify([knowledgeId(item.scopeId), knowledgeId(item.workItemId)]);
}

export function normalizeKnowledgeText(value: string): string {
  knowledgeAssert(typeof value === 'string' && value.length <= 1_000_000, 'Knowledge text exceeds limit');
  return value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\p{Cc}\p{Cf}]/gu, character =>
    character === '\n' || character === '\t' ? character : '');
}

export function knowledgeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function normalizeProvenance(input: KnowledgeProvenance): KnowledgeProvenance {
  knowledgeAssert(input !== null && typeof input === 'object', 'Missing provenance');
  workItemKey(input.sourceWorkItem);
  knowledgeVersion(input.revision);
  knowledgeAssert(typeof input.changedDate === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(input.changedDate)
    && Number.isFinite(Date.parse(input.changedDate)), 'Expected UTC changed date');
  const canonicalChangedDate = new Date(input.changedDate).toISOString();
  knowledgeAssert(canonicalChangedDate.slice(0, 19) === input.changedDate.slice(0, 19), 'Expected valid UTC changed date');
  knowledgeAssert(typeof input.contentHash === 'string' && /^[a-f0-9]{64}$/.test(input.contentHash), 'Invalid SHA-256 content hash');
  knowledgeAssert(input.source !== null && typeof input.source === 'object', 'Missing source locator');
  let source: KnowledgeSource;
  switch (input.source.kind) {
    case 'FIELD': source = { kind: 'FIELD', name: knowledgeId(input.source.name) }; break;
    case 'COMMENT': source = { kind: 'COMMENT', commentId: knowledgeId(input.source.commentId), version: knowledgeVersion(input.source.version) }; break;
    case 'RELATION': source = { kind: 'RELATION', relationId: knowledgeId(input.source.relationId) }; break;
    default: throw new RuntimeError('INVALID_REQUEST', 'Unknown knowledge source');
  }
  return {
    sourceWorkItem: { scopeId: input.sourceWorkItem.scopeId, workItemId: input.sourceWorkItem.workItemId },
    revision: input.revision, source, changedDate: canonicalChangedDate, contentHash: input.contentHash,
  };
}

export function createKnowledgeFact(input: Omit<KnowledgeProvenance, 'contentHash'>, body: string): KnowledgeFact {
  const normalized = normalizeKnowledgeText(body);
  const provenance = normalizeProvenance({ ...input, contentHash: knowledgeHash(normalized) });
  return {
    schemaVersion: 1,
    authority: provenance.source.kind === 'FIELD' ? 'OFFICIAL_FIELD' : provenance.source.kind,
    format: 'PLAIN_TEXT', body: normalized, provenance,
  };
}

export function validateKnowledgeFact(fact: KnowledgeFact): KnowledgeFact {
  knowledgeAssert(fact !== null && typeof fact === 'object', 'Missing fact');
  const normalized = createKnowledgeFact(normalizeProvenance(fact.provenance), fact.body);
  knowledgeAssert(fact.schemaVersion === 1 && fact.format === 'PLAIN_TEXT'
    && fact.authority === normalized.authority && fact.body === normalized.body
    && fact.provenance.contentHash === normalized.provenance.contentHash, 'Fact content or authority does not match provenance');
  return normalized;
}

export function createKnowledgeRevisionDiff(before: KnowledgeFact, after: KnowledgeFact): KnowledgeRevisionDiff {
  const previous = validateKnowledgeFact(before).provenance;
  const next = validateKnowledgeFact(after).provenance;
  const locator = (source: KnowledgeSource): string => source.kind === 'FIELD' ? source.name
    : source.kind === 'COMMENT' ? source.commentId : source.relationId;
  const commentAdvanced = previous.source.kind === 'COMMENT' && next.source.kind === 'COMMENT'
    && next.source.version > previous.source.version;
  knowledgeAssert(workItemKey(previous.sourceWorkItem) === workItemKey(next.sourceWorkItem)
    && previous.source.kind === next.source.kind && locator(previous.source) === locator(next.source)
    && (next.revision > previous.revision || (next.revision === previous.revision && commentAdvanced))
    && next.changedDate >= previous.changedDate, 'Revision diff sources are incompatible or out of order');
  if (previous.source.kind === 'COMMENT' && next.source.kind === 'COMMENT') {
    knowledgeAssert(next.source.version >= previous.source.version
      && (next.source.version !== previous.source.version || previous.contentHash === next.contentHash), 'Comment version conflicts with content');
  }
  return {
    schemaVersion: 1, diffId: knowledgeHash(JSON.stringify([previous, next])), before: previous, after: next,
    contentChanged: previous.contentHash !== next.contentHash,
  };
}
