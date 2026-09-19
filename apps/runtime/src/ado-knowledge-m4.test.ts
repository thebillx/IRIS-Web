import { describe, expect, it, vi } from 'vitest';
import {
  createKnowledgeFact, createKnowledgeRevisionDiff, knowledgeHash, normalizeProvenance, validateKnowledgeFact,
  workItemKey, type KnowledgeSource, type KnowledgeWorkItem,
} from './ado-knowledge-provenance.js';
import { buildKnowledgeGraph, createKnowledgeEdge, type KnowledgeEdge } from './ado-knowledge-graph.js';
import {
  assembleKnowledgeComments, classifyKnowledgeComment, createKnowledgeComment, indexKnowledgeSupportingLinks,
  type KnowledgeComment, type KnowledgeCommentPage, type KnowledgeInterpretationKind, type KnowledgeLinkKind,
} from './ado-knowledge-comments.js';

const changedDate = '2026-01-01T00:00:00.000Z';
const nextDate = '2026-01-02T00:00:00.000Z';
const item = (workItemId = 'item-a', scopeId = 'scope-fixture'): KnowledgeWorkItem => ({ scopeId, workItemId });
const provenance = (source: KnowledgeSource = { kind: 'FIELD', name: 'description' }, sourceWorkItem = item(), revision = 1) => ({
  sourceWorkItem, revision, source, changedDate,
});
const node = (workItemId: string) => ({ item: item(workItemId), provenance: createKnowledgeFact(provenance(undefined, item(workItemId)), '').provenance });
const edge = (source: string, target: string, type: 'PARENT' | 'CHILD' | 'RELATED' | 'DEPENDS_ON' = 'CHILD', relationId = `${type}-${target}`): KnowledgeEdge =>
  createKnowledgeEdge({ source: item(source), target: item(target), type,
    provenance: provenance({ kind: 'RELATION', relationId }, item(source)) });
const comment = (commentId = 'comment-a', version = 1, body = 'Synthetic discussion'): KnowledgeComment => createKnowledgeComment({
  sourceWorkItem: item(), revision: 1, changedDate, commentId, version, body, identityId: 'identity-fixture',
});
const page = (comments: readonly KnowledgeComment[], cursor: string | null = null, nextCursor: string | null = null): KnowledgeCommentPage => ({
  sourceWorkItem: item(), revision: 1, cursor, nextCursor, comments,
});

describe('ADO M4 provenance facts and revision diff contract', () => {
  it('normalizes text deterministically and binds its canonical bytes to source identity', () => {
    const fact = createKnowledgeFact(provenance(), 'Cafe\u0301\r\ntext\u0000\u202e\tend');
    expect(fact.body).toBe('Café\ntext\tend');
    expect(fact.provenance).toEqual({ ...provenance(), contentHash: knowledgeHash(fact.body) });
    expect(fact.authority).toBe('OFFICIAL_FIELD');
    expect(validateKnowledgeFact(JSON.parse(JSON.stringify(fact)))).toEqual(fact);
  });

  it('treats markup as literal plain text, not trusted HTML', () => {
    const fact = createKnowledgeFact(provenance(), '<script>untrusted()</script>');
    expect(fact.format).toBe('PLAIN_TEXT');
    expect(fact.body).toBe('<script>untrusted()</script>');
  });

  it('rejects forged content, promoted comment authority and noncanonical text', () => {
    const fact = comment().fact;
    expect(() => validateKnowledgeFact({ ...fact, body: 'changed' })).toThrow();
    expect(() => validateKnowledgeFact({ ...fact, authority: 'OFFICIAL_FIELD' })).toThrow();
    expect(() => validateKnowledgeFact({ ...fact, body: 'text\r\n' })).toThrow();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid revision %s', revision => {
    expect(() => createKnowledgeFact({ ...provenance(), revision }, '')).toThrow();
  });

  it.each(['2026-02-30T00:00:00.000Z', 'not-a-date', '2026-01-01', '2026-01-01T00:00:00+00:00'])('rejects noncanonical changed date %s', date => {
    expect(() => createKnowledgeFact({ ...provenance(), changedDate: date }, '')).toThrow();
  });

  it('validates identifiers, source kinds, hashes and text bounds', () => {
    expect(() => workItemKey(item('item\n'))).toThrow();
    expect(() => workItemKey(item('', 'scope-fixture'))).toThrow();
    expect(() => createKnowledgeFact(provenance(), 'x'.repeat(1_000_001))).toThrow();
    const fact = createKnowledgeFact(provenance(), 'text');
    expect(() => normalizeProvenance({ ...fact.provenance, contentHash: 'invalid' })).toThrow();
    expect(() => createKnowledgeFact(provenance({ kind: 'UNKNOWN' } as unknown as KnowledgeSource), '')).toThrow();
  });

  it('creates stable revision identities without conflating identical content across revisions', () => {
    const before = createKnowledgeFact(provenance(), 'first');
    const after = createKnowledgeFact({ ...provenance(), revision: 2, changedDate: nextDate }, 'second');
    const diff = createKnowledgeRevisionDiff(before, after);
    expect(diff).toEqual(createKnowledgeRevisionDiff(before, after));
    expect(diff.contentChanged).toBe(true);
    expect(diff.before).toEqual(before.provenance);
    expect(diff.after).toEqual(after.provenance);
    const unchanged = createKnowledgeRevisionDiff(before, createKnowledgeFact({ ...provenance(), revision: 2 }, 'first'));
    expect(unchanged.contentChanged).toBe(false);
    expect(unchanged.diffId).not.toBe(diff.diffId);
  });

  it('rejects cross-item, cross-scope, cross-field and reversed revision comparisons', () => {
    const before = createKnowledgeFact(provenance(), 'first');
    for (const source of [provenance(undefined, item('item-b'), 2), provenance(undefined, item('item-a', 'scope-other'), 2),
      provenance({ kind: 'FIELD', name: 'title' }, item(), 2), provenance(undefined, item(), 1)]) {
      expect(() => createKnowledgeRevisionDiff(before, createKnowledgeFact(source, 'next'))).toThrow();
    }
  });

  it('tracks both comment version identities and rejects unversioned content changes', () => {
    const before = comment().fact;
    const after = createKnowledgeFact({ ...provenance({ kind: 'COMMENT', commentId: 'comment-a', version: 2 }), revision: 2 }, 'changed');
    expect(createKnowledgeRevisionDiff(before, after).after.source).toEqual({ kind: 'COMMENT', commentId: 'comment-a', version: 2 });
    const conflict = createKnowledgeFact({ ...before.provenance, revision: 2 }, 'changed');
    expect(() => createKnowledgeRevisionDiff(before, conflict)).toThrow();
  });

  it('supports comment version diffs at the same work-item revision but not reversed dates or versions', () => {
    const before = comment('comment-a', 1).fact;
    const after = comment('comment-a', 2, 'new comment body').fact;
    expect(createKnowledgeRevisionDiff(before, after).contentChanged).toBe(true);
    expect(() => createKnowledgeRevisionDiff(after, before)).toThrow();
    const olderDate = createKnowledgeFact({ ...after.provenance, changedDate: '2025-12-31T00:00:00.000Z' }, after.body);
    expect(() => createKnowledgeRevisionDiff(before, olderDate)).toThrow();
  });
});

describe('ADO M4 hierarchy and generic relation graph', () => {
  it('reconstructs an unordered forest without work-item type assumptions', () => {
    const graph = buildKnowledgeGraph(['leaf', 'root', 'middle', 'independent'].map(node), [edge('middle', 'leaf'), edge('middle', 'root', 'PARENT')]);
    expect(graph.validHierarchy).toBe(true);
    expect(graph.roots).toEqual([workItemKey(item('independent')), workItemKey(item('root'))]);
    expect(graph.hierarchy.find(entry => entry.key === workItemKey(item('middle')))).toEqual({ key: workItemKey(item('middle')),
      parents: [workItemKey(item('root'))], children: [workItemKey(item('leaf'))] });
  });

  it('reconciles reciprocal parent/child evidence without losing either provenance', () => {
    const graph = buildKnowledgeGraph(['root', 'leaf'].map(node), [edge('root', 'leaf'), edge('leaf', 'root', 'PARENT')]);
    expect(graph.validHierarchy).toBe(true);
    expect(graph.edges).toHaveLength(2);
    expect(graph.hierarchy.find(entry => entry.key === workItemKey(item('leaf')))!.parents).toHaveLength(1);
  });

  it('reports missing source and target nodes as orphans rather than inventing nodes', () => {
    const graph = buildKnowledgeGraph([node('leaf')], [edge('missing-parent', 'leaf'), edge('leaf', 'missing-child')]);
    expect(graph.validHierarchy).toBe(false);
    expect(graph.issues.filter(issue => issue.kind === 'ORPHAN').map(issue => issue.nodeKeys[0])).toEqual([
      workItemKey(item('missing-child')), workItemKey(item('missing-parent')),
    ]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.roots).toEqual([]);
  });

  it('detects a rootless cycle and does not label downstream nodes as cyclic', () => {
    const graph = buildKnowledgeGraph(['node-a', 'node-b', 'node-c', 'tail'].map(node), [
      edge('node-a', 'node-b'), edge('node-b', 'node-c'), edge('node-c', 'node-a'), edge('node-c', 'tail'),
    ]);
    const cycles = graph.issues.filter(issue => issue.kind === 'CYCLE');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodeKeys).toEqual(['node-a', 'node-b', 'node-c', 'node-a'].map(value => workItemKey(item(value))));
    expect(graph.validHierarchy).toBe(false);
  });

  it('detects self-links and conflicting multiple-parent hierarchy', () => {
    const graph = buildKnowledgeGraph(['node-a', 'node-b', 'leaf'].map(node), [edge('node-a', 'node-a'), edge('node-a', 'leaf'), edge('node-b', 'leaf')]);
    expect(graph.issues.map(issue => issue.kind)).toEqual(expect.arrayContaining(['SELF_LINK', 'MULTIPLE_PARENTS', 'CYCLE']));
  });

  it('keeps related/dependency cycles and supporting references outside hierarchy', () => {
    const supporting = createKnowledgeEdge({ source: item('node-a'), type: 'EXTERNAL_SUPPORTING_REFERENCE', target: { referenceId: 'support-fixture' },
      provenance: provenance({ kind: 'RELATION', relationId: 'support-edge' }, item('node-a')) });
    const graph = buildKnowledgeGraph(['node-a', 'node-b'].map(node), [edge('node-a', 'node-b', 'RELATED'), edge('node-b', 'node-a', 'DEPENDS_ON'), supporting]);
    expect(graph.validHierarchy).toBe(true);
    expect(graph.roots).toHaveLength(2);
    expect(graph.hierarchy.every(entry => entry.parents.length === 0 && entry.children.length === 0)).toBe(true);
    expect(graph.edges.map(entry => entry.type)).toEqual(['RELATED', 'DEPENDS_ON', 'EXTERNAL_SUPPORTING_REFERENCE']);
    expect(graph.edges.every(entry => entry.provenance.contentHash.length === 64)).toBe(true);
  });

  it('distinguishes unresolved generic relations from invalid hierarchy', () => {
    const graph = buildKnowledgeGraph([node('node-a')], [edge('node-a', 'absent', 'RELATED')]);
    expect(graph.validHierarchy).toBe(true);
    expect(graph.issues).toEqual([{ kind: 'ORPHAN', domain: 'RELATION', nodeKeys: [workItemKey(item('absent'))] }]);
  });

  it('bounds cycle evidence to one witness even in a multiply connected cyclic graph', () => {
    const graph = buildKnowledgeGraph(['node-a', 'node-b', 'node-c'].map(node), [
      edge('node-a', 'node-b'), edge('node-b', 'node-a'), edge('node-a', 'node-c'), edge('node-c', 'node-a'),
    ]);
    expect(graph.issues.filter(issue => issue.kind === 'CYCLE')).toHaveLength(1);
    expect(graph.validHierarchy).toBe(false);
  });

  it('rejects conflicting node/edge identities, stale revisions and tampered edge hashes', () => {
    const valid = edge('node-a', 'node-b');
    expect(() => buildKnowledgeGraph([node('node-a'), node('node-a')], [])).toThrow();
    expect(() => buildKnowledgeGraph([node('node-a')], [valid, valid])).toThrow();
    expect(() => buildKnowledgeGraph([node('node-a')], [{ ...valid, provenance: { ...valid.provenance, revision: 2 } }])).toThrow();
    expect(() => buildKnowledgeGraph([], [{ ...valid, provenance: { ...valid.provenance, contentHash: '0'.repeat(64) } }])).toThrow();
    expect(() => buildKnowledgeGraph([{ ...node('node-a'), item: item('other') }], [])).toThrow();
  });

  it('rejects cross-scope internal relations and non-relation evidence', () => {
    const foreign = createKnowledgeEdge({ source: item(), target: item('item-a', 'scope-other'), type: 'RELATED',
      provenance: provenance({ kind: 'RELATION', relationId: 'related-fixture' }) });
    expect(() => buildKnowledgeGraph([], [foreign])).toThrow();
    expect(() => createKnowledgeEdge({ source: item(), target: item('item-b'), type: 'CHILD', provenance: provenance() })).toThrow();
  });

  it('handles deep hierarchies iteratively with explicit size limits', () => {
    const nodes = Array.from({ length: 3000 }, (_, index) => node(`item-${index}`));
    const edges = nodes.slice(1).map((entry, index) => edge(`item-${index}`, entry.item.workItemId));
    expect(buildKnowledgeGraph(nodes, edges).validHierarchy).toBe(true);
    expect(() => buildKnowledgeGraph(Array.from({ length: 10_001 }, () => node('item-fixture')), [])).toThrow();
    expect(() => buildKnowledgeGraph([], Array.from({ length: 50_001 }, () => edge('item-a', 'item-b')))).toThrow();
  });
});

describe('ADO M4 comments, interpretation candidates and supporting metadata', () => {
  it('normalizes comment body and retains only a scope-bound pseudonymous identity', () => {
    const result = createKnowledgeComment({ sourceWorkItem: item(), revision: 1, changedDate, commentId: 'comment-a', version: 2,
      body: 'line\r\nnext\u0000', identityId: 'synthetic-user@example.invalid' });
    expect(result.fact.body).toBe('line\nnext');
    expect(result.identity.opaqueId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('synthetic-user@example.invalid');
    expect(result.fact.provenance.source).toEqual({ kind: 'COMMENT', commentId: 'comment-a', version: 2 });
  });

  it('assembles complete, partial and empty pages without inventing completeness', () => {
    const result = assembleKnowledgeComments([page([comment()], null, 'cursor-b'), page([comment('comment-b')], 'cursor-b')]);
    expect(result.complete).toBe(true);
    expect(result.comments).toHaveLength(2);
    expect(assembleKnowledgeComments([page([], 'cursor-b')]).complete).toBe(false);
    expect(assembleKnowledgeComments([page([], null, 'cursor-b')]).complete).toBe(false);
    expect(assembleKnowledgeComments([page([])]).complete).toBe(true);
  });

  it('preserves distinct comment versions and rejects duplicated versions', () => {
    expect(assembleKnowledgeComments([page([comment('comment-a', 1), comment('comment-a', 2)])]).comments).toHaveLength(2);
    expect(() => assembleKnowledgeComments([page([comment(), comment()])])).toThrow();
  });

  it('rejects page gaps, cycles, continuation after terminal pages and oversized batches', () => {
    expect(() => assembleKnowledgeComments([page([], null, 'cursor-b'), page([], 'cursor-c')])).toThrow();
    expect(() => assembleKnowledgeComments([page([], 'cursor-a', 'cursor-b'), page([], 'cursor-b', 'cursor-a')])).toThrow();
    expect(() => assembleKnowledgeComments([page([]), page([], 'cursor-b')])).toThrow();
    expect(() => assembleKnowledgeComments([])).toThrow();
    expect(() => assembleKnowledgeComments(Array.from({ length: 101 }, () => page([])))).toThrow();
    expect(() => assembleKnowledgeComments([page(Array.from({ length: 1001 }, () => comment()))])).toThrow();
  });

  it('bounds aggregate comment content independently from comment count', () => {
    const entries = Array.from({ length: 9 }, (_, index) => comment(`comment-${index}`, 1, 'x'.repeat(1_000_000)));
    expect(() => assembleKnowledgeComments([page(entries)])).toThrow('content exceeds limit');
  });

  it('rejects cross-item/revision page contamination and forged comment identity', () => {
    expect(() => assembleKnowledgeComments([{ ...page([comment()]), revision: 2 }])).toThrow();
    expect(() => assembleKnowledgeComments([{ ...page([comment()]), sourceWorkItem: item('item-other') }])).toThrow();
    expect(() => assembleKnowledgeComments([page([{ ...comment(), commentId: 'forged' }])])).toThrow();
    expect(() => assembleKnowledgeComments([page([{ ...comment(), identity: { opaqueId: 'raw-email@example.invalid' } }])])).toThrow();
  });

  it('keeps fake classifier interpretations as candidates with exact comment provenance', () => {
    const source = comment();
    const official = createKnowledgeFact(provenance(), 'Official description');
    const kinds: KnowledgeInterpretationKind[] = ['CLARIFICATION', 'DECISION', 'REJECTED_BEHAVIOR', 'KNOWN_LIMITATION'];
    const classify = vi.fn(() => kinds.map(kind => ({ kind, body: `Possible ${kind}` })));
    const results = classifyKnowledgeComment(source, { classify });
    expect(classify).toHaveBeenCalledOnce();
    expect(results.map(result => result.kind)).toEqual(kinds);
    for (const result of results) {
      expect(result.sourceComment).toEqual(source.fact.provenance);
      expect(result.authority).toBe('DERIVED_COMMENT');
      expect(result.status).toBe('CANDIDATE');
      expect(result.contentHash).toBe(knowledgeHash(result.body));
    }
    expect(official.body).toBe('Official description');
    expect(official.authority).toBe('OFFICIAL_FIELD');
  });

  it('rejects invalid classifier output and protects source provenance from classifier mutation', () => {
    const source = comment();
    expect(() => classifyKnowledgeComment(source, { classify: () => [{ kind: 'REQUIREMENT' as KnowledgeInterpretationKind, body: 'promoted' }] })).toThrow();
    expect(() => classifyKnowledgeComment(source, { classify: () => [{ kind: 'DECISION', body: ' ' }] })).toThrow();
    const results = classifyKnowledgeComment(source, { classify: input => {
      Object.assign(input.fact.provenance, { revision: 99 });
      return [{ kind: 'DECISION', body: 'Candidate' }];
    } });
    expect(results[0]!.sourceComment.revision).toBe(1);
    expect(source.fact.provenance.revision).toBe(1);
    expect(classifyKnowledgeComment(source, { classify: () => [] })).toEqual([]);
  });

  it('indexes all five supporting link kinds as metadata only and strips query/fragment tokens', () => {
    const kinds: KnowledgeLinkKind[] = ['DOCUMENT', 'DESIGN', 'TEST_RESULT', 'ATTACHMENT', 'SHAREPOINT_REFERENCE'];
    const inputs = kinds.map((kind, index) => ({ referenceId: `reference-${index}`, kind, title: 'Synthetic reference',
      url: `https://documents.example.invalid/path/${index}?access_token=synthetic-secret#secret`, provenance: provenance() }));
    const result = indexKnowledgeSupportingLinks(inputs);
    expect(result.map(entry => entry.kind)).toEqual(kinds);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(result.every(entry => !entry.url.includes('?') && !entry.url.includes('#'))).toBe(true);
    expect(result.every(entry => validateKnowledgeFact(entry.fact))).toBe(true);
    expect(result[0]!.fact.body).toBe(JSON.stringify([inputs[0]!.referenceId, inputs[0]!.kind, inputs[0]!.title, result[0]!.url]));
  });

  it.each(['file:///private/document', 'javascript:alert(1)', 'http://example.invalid/doc', 'https://user:password@example.invalid/doc', 'not a url'])('rejects unsafe supporting reference %s', url => {
    expect(() => indexKnowledgeSupportingLinks([{ referenceId: 'reference-a', kind: 'DOCUMENT', title: 'Fixture', url, provenance: provenance() }])).toThrow();
  });

  it('rejects duplicate link IDs within a source while keeping different source namespaces', () => {
    const input = { referenceId: 'reference-a', kind: 'DOCUMENT' as const, title: 'Fixture', url: 'https://example.invalid/doc', provenance: provenance() };
    expect(() => indexKnowledgeSupportingLinks([input, input])).toThrow();
    expect(indexKnowledgeSupportingLinks([input, { ...input, provenance: provenance(undefined, item('other')) }])).toHaveLength(2);
  });

  it('preserves comment source authority for links rather than claiming official document content', () => {
    const reference = indexKnowledgeSupportingLinks([{ referenceId: 'reference-a', kind: 'DOCUMENT', title: 'Fixture',
      url: 'https://example.invalid/doc', provenance: provenance({ kind: 'COMMENT', commentId: 'comment-a', version: 1 }) }])[0]!;
    expect(reference.fact.authority).toBe('COMMENT');
    expect(reference.fact.provenance.source.kind).toBe('COMMENT');
  });

  it('snapshots inputs without shared mutable provenance', () => {
    const input = provenance();
    const fact = createKnowledgeFact(input, 'body');
    Object.assign(input.sourceWorkItem, { scopeId: 'changed-scope' });
    expect(fact.provenance.sourceWorkItem.scopeId).toBe('scope-fixture');
    const commentInput = comment();
    const batch = assembleKnowledgeComments([page([commentInput])]);
    Object.assign(commentInput.fact.provenance, { revision: 999 });
    expect(batch.comments[0]!.fact.provenance.revision).toBe(1);
  });
});
