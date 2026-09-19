import {
  createKnowledgeFact, knowledgeAssert, knowledgeHash, knowledgeId, knowledgeVersion, normalizeKnowledgeText,
  validateKnowledgeFact, workItemKey, type KnowledgeFact, type KnowledgeProvenance, type KnowledgeWorkItem,
} from './ado-knowledge-provenance.js';

export interface KnowledgeComment {
  readonly commentId: string;
  readonly version: number;
  readonly identity: { readonly opaqueId: string };
  readonly fact: KnowledgeFact;
}

export interface KnowledgeCommentPage {
  readonly sourceWorkItem: KnowledgeWorkItem;
  readonly revision: number;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  readonly comments: readonly KnowledgeComment[];
}

export function createKnowledgeComment(input: {
  readonly sourceWorkItem: KnowledgeWorkItem; readonly revision: number; readonly changedDate: string;
  readonly commentId: string; readonly version: number; readonly body: string; readonly identityId: string;
}): KnowledgeComment {
  const fact = createKnowledgeFact({ sourceWorkItem: input.sourceWorkItem, revision: input.revision,
    changedDate: input.changedDate, source: { kind: 'COMMENT', commentId: input.commentId, version: input.version } }, input.body);
  return { commentId: input.commentId, version: input.version,
    identity: { opaqueId: knowledgeHash(JSON.stringify([knowledgeId(input.sourceWorkItem.scopeId), knowledgeId(input.identityId)])) }, fact };
}

function validateComment(comment: KnowledgeComment): KnowledgeComment {
  const fact = validateKnowledgeFact(comment.fact);
  knowledgeAssert(fact.provenance.source.kind === 'COMMENT' && fact.provenance.source.commentId === comment.commentId
    && fact.provenance.source.version === comment.version, 'Comment identity does not match its source');
  knowledgeAssert(comment.identity !== null && typeof comment.identity === 'object'
    && /^[a-f0-9]{64}$/.test(comment.identity.opaqueId), 'Invalid sanitized comment identity');
  return { commentId: comment.commentId, version: comment.version, identity: { opaqueId: comment.identity.opaqueId }, fact };
}

export function assembleKnowledgeComments(pages: readonly KnowledgeCommentPage[]): {
  readonly pages: readonly KnowledgeCommentPage[];
  readonly comments: readonly KnowledgeComment[];
  readonly complete: boolean;
} {
  knowledgeAssert(Array.isArray(pages) && pages.length > 0 && pages.length <= 100, 'Expected bounded comment pages');
  const first = pages[0]!;
  const sourceKey = workItemKey(first.sourceWorkItem);
  knowledgeVersion(first.revision);
  const seenCursors = new Set<string | null>();
  const seenComments = new Set<string>();
  const normalized: KnowledgeCommentPage[] = [];
  const comments: KnowledgeComment[] = [];
  let bodyBytes = 0;
  for (const [index, page] of pages.entries()) {
    knowledgeAssert(workItemKey(page.sourceWorkItem) === sourceKey && page.revision === first.revision, 'Comment batch mixes work items or revisions');
    if (page.cursor !== null) knowledgeId(page.cursor);
    if (page.nextCursor !== null) knowledgeId(page.nextCursor);
    knowledgeAssert(!seenCursors.has(page.cursor) && (page.nextCursor === null || page.nextCursor !== page.cursor)
      && (page.nextCursor === null || !seenCursors.has(page.nextCursor)), 'Comment cursor cycle');
    knowledgeAssert(index === 0 || (pages[index - 1]!.nextCursor !== null && pages[index - 1]!.nextCursor === page.cursor), 'Comment page chain has a gap');
    seenCursors.add(page.cursor);
    knowledgeAssert(Array.isArray(page.comments) && page.comments.length <= 1000, 'Comment page exceeds limit');
    const entries = page.comments.map((comment: KnowledgeComment) => {
      const normalizedComment = validateComment(comment);
      bodyBytes += Buffer.byteLength(normalizedComment.fact.body, 'utf8');
      knowledgeAssert(bodyBytes <= 8 * 1024 * 1024, 'Comment batch content exceeds limit');
      const provenance = normalizedComment.fact.provenance;
      knowledgeAssert(workItemKey(provenance.sourceWorkItem) === sourceKey && provenance.revision === page.revision, 'Comment source does not match page');
      const key = JSON.stringify([comment.commentId, comment.version]);
      knowledgeAssert(!seenComments.has(key), 'Duplicate comment version in batch');
      seenComments.add(key);
      return normalizedComment;
    });
    comments.push(...entries);
    knowledgeAssert(comments.length <= 10_000, 'Comment batch exceeds limit');
    normalized.push({ sourceWorkItem: { scopeId: first.sourceWorkItem.scopeId, workItemId: first.sourceWorkItem.workItemId },
      revision: page.revision, cursor: page.cursor, nextCursor: page.nextCursor, comments: entries });
  }
  return { pages: normalized, comments, complete: first.cursor === null && pages[pages.length - 1]!.nextCursor === null };
}

export type KnowledgeInterpretationKind = 'CLARIFICATION' | 'DECISION' | 'REJECTED_BEHAVIOR' | 'KNOWN_LIMITATION';

export interface KnowledgeCommentClassifier {
  classify(comment: KnowledgeComment): readonly { readonly kind: KnowledgeInterpretationKind; readonly body: string }[];
}

export interface KnowledgeInterpretation {
  readonly kind: KnowledgeInterpretationKind;
  readonly body: string;
  readonly contentHash: string;
  readonly authority: 'DERIVED_COMMENT';
  readonly status: 'CANDIDATE';
  readonly sourceComment: KnowledgeProvenance;
}

export function classifyKnowledgeComment(comment: KnowledgeComment, classifier: KnowledgeCommentClassifier): readonly KnowledgeInterpretation[] {
  const normalized = validateComment(comment);
  const sourceComment = structuredClone(normalized.fact.provenance);
  const candidates = classifier.classify(structuredClone(normalized));
  knowledgeAssert(Array.isArray(candidates) && candidates.length <= 100, 'Classifier result exceeds limit');
  return candidates.map(candidate => {
    knowledgeAssert(['CLARIFICATION', 'DECISION', 'REJECTED_BEHAVIOR', 'KNOWN_LIMITATION'].includes(candidate.kind), 'Unknown interpretation kind');
    const body = normalizeKnowledgeText(candidate.body);
    knowledgeAssert(body.trim().length > 0, 'Empty interpretation');
    return { kind: candidate.kind, body, contentHash: knowledgeHash(body), authority: 'DERIVED_COMMENT',
      status: 'CANDIDATE', sourceComment: structuredClone(sourceComment) };
  });
}

export type KnowledgeLinkKind = 'DOCUMENT' | 'DESIGN' | 'TEST_RESULT' | 'ATTACHMENT' | 'SHAREPOINT_REFERENCE';

export interface KnowledgeSupportingLink {
  readonly referenceId: string;
  readonly kind: KnowledgeLinkKind;
  readonly title: string;
  readonly url: string;
  readonly fact: KnowledgeFact;
}

export function indexKnowledgeSupportingLinks(inputs: readonly {
  readonly referenceId: string; readonly kind: KnowledgeLinkKind; readonly title: string; readonly url: string;
  readonly provenance: Omit<KnowledgeProvenance, 'contentHash'>;
}[]): readonly KnowledgeSupportingLink[] {
  knowledgeAssert(Array.isArray(inputs) && inputs.length <= 10_000, 'Supporting index exceeds limit');
  const seen = new Set<string>();
  let metadataBytes = 0;
  return inputs.map(input => {
    const referenceId = knowledgeId(input.referenceId);
    knowledgeAssert(['DOCUMENT', 'DESIGN', 'TEST_RESULT', 'ATTACHMENT', 'SHAREPOINT_REFERENCE'].includes(input.kind), 'Unknown supporting link kind');
    knowledgeAssert(typeof input.url === 'string' && input.url.length <= 8192
      && !/[\p{Cc}\p{Cf}]/u.test(input.url), 'Invalid supporting URL');
    let url: URL;
    try { url = new URL(input.url); } catch { knowledgeAssert(false, 'Invalid supporting URL'); }
    knowledgeAssert(url.protocol === 'https:' && url.username === '' && url.password === '', 'Supporting URL must be HTTPS without credentials');
    url.search = '';
    url.hash = '';
    const title = normalizeKnowledgeText(input.title);
    knowledgeAssert(title.length <= 4096, 'Supporting title exceeds limit');
    const fact = createKnowledgeFact(input.provenance, JSON.stringify([referenceId, input.kind, title, url.href]));
    metadataBytes += Buffer.byteLength(fact.body, 'utf8');
    knowledgeAssert(metadataBytes <= 8 * 1024 * 1024, 'Supporting metadata exceeds limit');
    const key = JSON.stringify([workItemKey(fact.provenance.sourceWorkItem), referenceId]);
    knowledgeAssert(!seen.has(key), 'Duplicate supporting reference');
    seen.add(key);
    return { referenceId, kind: input.kind, title, url: url.href, fact };
  });
}
