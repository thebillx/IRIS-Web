import { createHash } from 'node:crypto';

export class SyncError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'INVALID_SNAPSHOT' | 'PERSISTENCE_FAILURE' | 'CONFLICT' | 'INVALID_STATE' | 'CHECKPOINT_CONFLICT' | 'STALE_GATE' | 'NOT_FOUND') { super(code); }
}

export interface BoardKey { organizationId: string; projectId: string; teamId: string; boardId: string }
export interface Membership { itemId: number; parentId: number | null; backlogIds: string[] }
export interface Inventory { snapshotId: string; complete: boolean; items: Membership[] }
export interface ChangeStamp { itemId: number; revision: number; changedAt: string }
export interface Source extends ChangeStamp { content: string }
export interface Comment { id: string; text: string }
export interface Relation { id: string; kind: string; targetItemId: number }
export interface Link { id: string; evidenceRef: string }
export interface Observation extends ChangeStamp {
  content: string | null;
  expectedCommentIds: string[];
  commentsComplete: boolean;
  comments: Comment[];
  relationsComplete: boolean;
  relations: Relation[];
  linksComplete: boolean;
  links: Link[];
}
export type FailureCode = 'UNAUTHENTICATED' | 'UNAUTHORIZED' | 'NETWORK_FAILURE' | 'POLICY_DENIED' | 'RATE_LIMITED' | 'UPSTREAM_FAILURE';
export interface FailedItem { itemId: number; code: FailureCode }
export interface Batch { batchId: string; observations: Observation[]; failures: FailedItem[] }
export type Disposition = 'PROMOTED' | 'CONTEXT_ONLY' | 'SUPPORTING_EVIDENCE' | 'REJECTED';
export interface GateEvidence {
  field: 'title' | 'description' | 'acceptanceCriteria';
  text: string;
}
export interface GateDecision {
  itemId: number;
  fingerprint: string;
  gateVersion: string;
  disposition: Disposition;
  reasonCode: string;
  category: string | null;
  classificationDigest: string;
  evidence: GateEvidence[];
}
export interface GateRow extends GateDecision { syncRunId: string; decidedAt: string }
export interface SourceRow extends Source {
  syncRunId: string;
  contentHash: string;
  fingerprint: string;
  contentSkipped: boolean;
  expectedCommentIds: string[];
  commentsComplete: boolean;
  relationsComplete: boolean;
  linksComplete: boolean;
}
export interface RelationRow extends Relation { syncRunId: string; itemId: number }
export interface CommentRow extends Comment { syncRunId: string; itemId: number }
export interface LinkRow extends Link { syncRunId: string; itemId: number }
export interface MembershipRow extends Membership { syncRunId: string }
export interface PublicationPolicy { gateVersion: string; minimumPromoted: number; allowRejections: boolean }

export function validateGateDecisionMetadata(decision: GateDecision): void {
  if (decision.category !== null) identifier(decision.category);
  requireValid(typeof decision.classificationDigest === 'string' && /^[a-f0-9]{64}$/.test(decision.classificationDigest));
  bounded(decision.evidence);
  unique(decision.evidence.map(entry => canonical([entry.field, entry.text])));
  for (const entry of decision.evidence) {
    requireValid(['title', 'description', 'acceptanceCriteria'].includes(entry.field));
    validText(entry.text);
    requireValid(entry.text.trim().length > 0);
  }
}
export type SyncTrigger = { kind: 'MANUAL' } | { kind: 'INCREMENTAL' } | { kind: 'SCHEDULE'; scheduleId: string };
export type SyncMode = 'FULL' | 'INCREMENTAL';
export type RunStatus = 'RUNNING' | 'PAUSED' | 'AUDIT_FAILED' | 'COMPLETE';
export interface Checkpoint { batchId: string; kind: 'FETCH' | 'INVALIDATE'; reasonCode: string | null; digest: string; itemIds: number[]; fetchedIds: number[]; failed: FailedItem[]; committedAt: string }
export interface RetryItems { batchId: string; itemIds: number[]; reasonCode: string }
export interface Reconciliation { newIds: number[]; movedIn: number[]; movedOut: number[]; hierarchyChanged: number[] }
export interface Audit {
  expectedIds: number[];
  fetchedIds: number[];
  failed: FailedItem[];
  missingIds: number[];
  duplicates: number[];
  orphans: number[];
  missingParents: { itemId: number; parentId: number }[];
  missingComments: { itemId: number; commentId: string }[];
  unresolvedRelations: { itemId: number; relationId: string; targetItemId: number }[];
  incompleteComments: number[];
  incompleteRelations: number[];
  incompleteLinks: number[];
  pendingGate: number[];
  counts: { expected: number; fetched: number; failed: number; promoted: number; contextOnly: number; supportingEvidence: number; rejected: number; contentSkipped: number };
  policyPassed: boolean;
  complete: boolean;
}
export interface SyncRun {
  syncRunId: string;
  scope: BoardKey;
  mode: SyncMode;
  trigger: SyncTrigger;
  version: number;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  snapshotId: string;
  inventoryComplete: boolean;
  expectedIds: number[];
  duplicateIds: number[];
  failed: FailedItem[];
  checkpoints: Checkpoint[];
  basePublishedRunId: string | null;
  policy: PublicationPolicy;
  reconciliation: Reconciliation;
  audit: Audit | null;
}
export interface PublishedHead { scope: BoardKey; syncRunId: string }
export interface SyncDocument {
  schemaVersion: 1;
  generation: number;
  syncRuns: SyncRun[];
  sourceStaging: SourceRow[];
  relations: RelationRow[];
  comments: CommentRow[];
  links: LinkRow[];
  boardMembership: MembershipRow[];
  promoted: GateRow[];
  contextOnly: GateRow[];
  supportingEvidence: GateRow[];
  rejectedAudit: GateRow[];
  publishedHeads: PublishedHead[];
}
export const MAX_ITEMS = 10_000;
export const MAX_TEXT_BYTES = 1_048_576;
export const MAX_SNAPSHOT_BYTES = 32 * 1_048_576;

export function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new SyncError('INVALID_INPUT');
}
export function identifier(value: string): void {
  requireValid(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value));
}
export function gateVersion(value: string): void {
  requireValid(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value));
}
export function itemId(value: number): void { requireValid(Number.isSafeInteger(value) && value > 0); }
export function timestamp(value: string): void {
  requireValid(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}
export function validText(value: string): void {
  requireValid(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES);
}
export function bounded(values: readonly unknown[]): void { requireValid(Array.isArray(values) && values.length <= MAX_ITEMS); }
export function unique<Value>(values: Value[]): void { requireValid(new Set(values).size === values.length); }
export function sameScope(left: BoardKey, right: BoardKey): boolean {
  return left.organizationId === right.organizationId && left.projectId === right.projectId && left.teamId === right.teamId && left.boardId === right.boardId;
}
export function validateScope(scope: BoardKey): void {
  [scope.organizationId, scope.projectId, scope.teamId, scope.boardId].forEach(identifier);
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  requireValid(encoded !== undefined);
  return encoded;
}
export function validateMembership(member: Membership): void {
  itemId(member.itemId);
  if (member.parentId !== null) { itemId(member.parentId); requireValid(member.parentId !== member.itemId); }
  bounded(member.backlogIds); unique(member.backlogIds);
  requireValid(member.backlogIds.length > 0);
  member.backlogIds.forEach(identifier);
}
export function validateObservation(observation: Observation): void {
  itemId(observation.itemId); itemId(observation.revision); timestamp(observation.changedAt);
  if (observation.content !== null) validText(observation.content);
  bounded(observation.expectedCommentIds); unique(observation.expectedCommentIds); observation.expectedCommentIds.forEach(identifier);
  requireValid(typeof observation.commentsComplete === 'boolean' && typeof observation.relationsComplete === 'boolean' && typeof observation.linksComplete === 'boolean');
  bounded(observation.comments); bounded(observation.relations); bounded(observation.links);
  unique(observation.comments.map(comment => comment.id));
  unique(observation.relations.map(relation => relation.id));
  unique(observation.links.map(link => link.id));
  observation.comments.forEach(comment => { identifier(comment.id); validText(comment.text); });
  observation.relations.forEach(relation => { identifier(relation.id); identifier(relation.kind); itemId(relation.targetItemId); });
  observation.links.forEach(link => { identifier(link.id); identifier(link.evidenceRef); });
}
export function validateFailure(failure: FailedItem): void {
  itemId(failure.itemId);
  requireValid(['UNAUTHENTICATED', 'UNAUTHORIZED', 'NETWORK_FAILURE', 'POLICY_DENIED', 'RATE_LIMITED', 'UPSTREAM_FAILURE'].includes(failure.code));
}
export function validatePolicy(policy: PublicationPolicy): void {
  gateVersion(policy.gateVersion);
  requireValid(Number.isSafeInteger(policy.minimumPromoted) && policy.minimumPromoted >= 0 && policy.minimumPromoted <= MAX_ITEMS && typeof policy.allowRejections === 'boolean');
}
export function reconcileMembership(previous: Membership[], current: Membership[], knownItemIds: number[]): Reconciliation {
  [previous, current].forEach(members => { bounded(members); members.forEach(validateMembership); unique(members.map(member => member.itemId)); });
  bounded(knownItemIds); knownItemIds.forEach(itemId);
  const before = new Map(previous.map(member => [member.itemId, member]));
  const after = new Set(current.map(member => member.itemId));
  const known = new Set(knownItemIds);
  const result: Reconciliation = { newIds: [], movedIn: [], movedOut: [], hierarchyChanged: [] };
  for (const member of current) {
    const existing = before.get(member.itemId);
    if (!existing) (known.has(member.itemId) ? result.movedIn : result.newIds).push(member.itemId);
    else if (existing.parentId !== member.parentId || canonical([...existing.backlogIds].sort()) !== canonical([...member.backlogIds].sort())) result.hierarchyChanged.push(member.itemId);
  }
  result.movedOut = previous.filter(member => !after.has(member.itemId)).map(member => member.itemId);
  return result;
}
export function planIncremental(previous: Source[], inventory: Inventory, changes: ChangeStamp[]): { itemId: number; content: 'FETCH' | 'RECHECK_VERSION'; recheckComments: true; recheckRelations: true; recheckLinks: true }[] {
  requireValid(inventory.complete === true);
  bounded(inventory.items); inventory.items.forEach(validateMembership); unique(inventory.items.map(member => member.itemId));
  bounded(previous); unique(previous.map(source => source.itemId));
  previous.forEach(source => { itemId(source.itemId); itemId(source.revision); timestamp(source.changedAt); });
  bounded(changes); unique(changes.map(change => change.itemId));
  changes.forEach(change => { itemId(change.itemId); itemId(change.revision); timestamp(change.changedAt); });
  const before = new Map(previous.map(source => [source.itemId, source]));
  const hints = new Map(changes.map(change => [change.itemId, change]));
  return inventory.items.map(member => {
    const source = before.get(member.itemId);
    const hint = hints.get(member.itemId);
    return { itemId: member.itemId, content: !source || (hint && (hint.revision !== source.revision || hint.changedAt !== source.changedAt)) ? 'FETCH' : 'RECHECK_VERSION', recheckComments: true, recheckRelations: true, recheckLinks: true };
  });
}
export function decisions(document: SyncDocument): GateRow[] {
  return [...document.promoted, ...document.contextOnly, ...document.supportingEvidence, ...document.rejectedAudit];
}
export function sourceFingerprint(document: SyncDocument, source: SourceRow): string {
  const membership = document.boardMembership.find(member => member.syncRunId === source.syncRunId && member.itemId === source.itemId);
  requireValid(membership !== undefined);
  const ordered = <Value extends { id: string }>(values: Value[]) => values.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return hash(canonical({
    itemId: source.itemId, revision: source.revision, changedAt: source.changedAt, contentHash: source.contentHash,
    membership: { parentId: membership.parentId, backlogIds: [...membership.backlogIds].sort() },
    expectedCommentIds: [...source.expectedCommentIds].sort(), commentsComplete: source.commentsComplete, relationsComplete: source.relationsComplete, linksComplete: source.linksComplete,
    comments: ordered(document.comments.filter(row => row.syncRunId === source.syncRunId && row.itemId === source.itemId).map(row => ({ id: row.id, text: row.text }))),
    relations: ordered(document.relations.filter(row => row.syncRunId === source.syncRunId && row.itemId === source.itemId).map(row => ({ id: row.id, kind: row.kind, targetItemId: row.targetItemId }))),
    links: ordered(document.links.filter(row => row.syncRunId === source.syncRunId && row.itemId === source.itemId).map(row => ({ id: row.id, evidenceRef: row.evidenceRef }))),
  }));
}
export function auditRun(document: SyncDocument, run: SyncRun): Audit {
  const sources = document.sourceStaging.filter(source => source.syncRunId === run.syncRunId);
  const fetched = new Set(sources.map(source => source.itemId));
  const expected = new Set(run.expectedIds);
  const members = document.boardMembership.filter(member => member.syncRunId === run.syncRunId);
  const comments = document.comments.filter(row => row.syncRunId === run.syncRunId);
  const relations = document.relations.filter(row => row.syncRunId === run.syncRunId);
  const links = document.links.filter(row => row.syncRunId === run.syncRunId);
  const gates = decisions(document).filter(row => row.syncRunId === run.syncRunId);
  const validGates = gates.filter(gate => gate.gateVersion === run.policy.gateVersion && sources.some(source => source.itemId === gate.itemId && source.fingerprint === gate.fingerprint));
  const count = (disposition: Disposition) => validGates.filter(gate => gate.disposition === disposition).length;
  const counts = { expected: expected.size, fetched: fetched.size, failed: run.failed.length, promoted: count('PROMOTED'), contextOnly: count('CONTEXT_ONLY'), supportingEvidence: count('SUPPORTING_EVIDENCE'), rejected: count('REJECTED'), contentSkipped: sources.filter(source => source.contentSkipped).length };
  const missingIds = run.expectedIds.filter(id => !fetched.has(id));
  const missingParents = members.filter(member => member.parentId !== null && !fetched.has(member.parentId)).map(member => ({ itemId: member.itemId, parentId: member.parentId! }));
  const missingComments = sources.flatMap(source => source.expectedCommentIds.filter(id => !comments.some(comment => comment.itemId === source.itemId && comment.id === id)).map(commentId => ({ itemId: source.itemId, commentId })));
  const unresolvedRelations = relations.filter(relation => !fetched.has(relation.targetItemId)).map(relation => ({ itemId: relation.itemId, relationId: relation.id, targetItemId: relation.targetItemId }));
  const orphans = [...new Set([...sources, ...comments, ...relations, ...links, ...members, ...gates].filter(row => !expected.has(row.itemId) || (!('backlogIds' in row) && !fetched.has(row.itemId))).map(row => row.itemId))];
  const incompleteComments = sources.filter(source => !source.commentsComplete || comments.some(comment => comment.itemId === source.itemId && !source.expectedCommentIds.includes(comment.id))).map(source => source.itemId);
  const incompleteRelations = sources.filter(source => !source.relationsComplete).map(source => source.itemId);
  const incompleteLinks = sources.filter(source => !source.linksComplete).map(source => source.itemId);
  const pendingGate = run.expectedIds.filter(id => !validGates.some(gate => gate.itemId === id));
  const policyPassed = counts.promoted >= run.policy.minimumPromoted && (run.policy.allowRejections || counts.rejected === 0) && pendingGate.length === 0;
  const complete = run.inventoryComplete && policyPassed && [run.failed, missingIds, run.duplicateIds, missingParents, missingComments, unresolvedRelations, orphans, incompleteComments, incompleteRelations, incompleteLinks].every(values => values.length === 0);
  return { expectedIds: [...run.expectedIds], fetchedIds: [...fetched], failed: structuredClone(run.failed), missingIds, duplicates: [...run.duplicateIds], orphans, missingParents, missingComments, unresolvedRelations, incompleteComments, incompleteRelations, incompleteLinks, pendingGate, counts, policyPassed, complete };
}
