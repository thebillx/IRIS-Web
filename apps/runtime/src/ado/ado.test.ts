import { describe, expect, expectTypeOf, it } from 'vitest';
import { readSemantics, validatePolicy, type AuthReference, type FailureCode, type ReadPolicy } from './adapter.js';
import { discoverBacklogs, enumerationChunk, isAreaInScope, planEnumeration, resolveBoardIdentity, resolveBoardScope, type Backlog, type BoardIdentity, type IdentityCatalog, type ScopeResponse, type Target } from './discovery.js';
import { FakeAzureDevOpsAdapter, type FakeResponses } from './fake-adapter.js';

const identity: BoardIdentity = {
  organization: { id: 'org-1', name: 'ExampleOrg' },
  project: { id: 'project-1', name: 'ExampleProject' },
  team: { id: 'team-1', name: 'TeamOne' },
  board: { id: 'board-1', name: 'Delivery' },
};
const catalog: IdentityCatalog = {
  organizations: [identity.organization],
  projects: [{ ...identity.project, parentId: 'org-1' }],
  teams: [{ ...identity.team, parentId: 'project-1' }, { id: 'team-2', name: 'TeamOne', parentId: 'project-2' }],
  boards: [{ ...identity.board, parentId: 'team-1' }],
};
const target: Target = { organization: { name: 'ExampleOrg' }, project: { id: 'project-1' }, team: { name: 'TeamOne' }, board: { name: 'Delivery' } };
const scope: ScopeResponse = {
  teamId: 'team-1',
  field: { referenceName: 'System.AreaPath', defaultValue: 'ExampleProject\\One', values: [{ value: 'ExampleProject\\One', includeChildren: true }, { value: 'ExampleProject\\Shared', includeChildren: false }] },
  iterations: [{ id: 'iteration-1', name: 'Cycle', path: 'ExampleProject\\Cycle' }],
  backlogIteration: { id: 'iteration-root', name: 'All', path: 'ExampleProject' },
};
const backlogs: readonly Backlog[] = [
  { id: 'delivery', name: 'Deliverables', rank: 40, type: 'requirement', workItemTypes: ['Issue', 'Request'] },
  { id: 'strategy', name: 'Strategy', rank: 2, type: 'portfolio', workItemTypes: ['Outcome'] },
];
const limits = { maxPages: 8, maxPageItems: 3, maxItems: 20, chunkSize: 2 };
const policy: ReadPolicy = {
  mode: 'READ_ONLY',
  allowlist: [{ organization: 'org-1', project: 'project-1', team: 'team-1', board: 'board-1', resources: ['board', 'scope', 'backlogs', 'query', 'workItems', 'comments', 'links'] }],
  timeoutMs: 100, maxResponseBytes: 8192, maxPageItems: 10, maxPages: 10, maxBatchItems: 5,
  rateLimit: { requests: 100, windowMs: 1000, maxRetryAfterMs: 500 },
};
const fixtures: FakeResponses = {
  identity, scope, backlogs,
  workItems: [{ id: 1, areaPath: 'ExampleProject\\One', fields: { title: 'One' } }, { id: 2, areaPath: 'ExampleProject\\One\\Child', fields: {} }, { id: 3, areaPath: 'ExampleProject\\Other', fields: {} }],
  queryIds: [1, 2, 3], comments: { 1: [{ id: 'comment-1', text: 'Note' }] }, links: { 1: [{ relation: 'related', targetWorkItemId: 2 }] },
};
const page = { index: 0, limit: 10, continuation: null };

describe('pure Board discovery', () => {
  it('resolves names and non-UUID IDs under their exact parents', () => {
    const result = resolveBoardIdentity(target, catalog);
    expect(result.team.id).toBe('team-1');
    expect(result.board.name).toBe('Delivery');
  });
  it('fails on missing and ambiguous identities without guessing', () => {
    expect(() => resolveBoardIdentity({ ...target, board: { id: 'missing' } }, catalog)).toThrow('MISSING_TARGET');
    expect(() => resolveBoardIdentity(target, { ...catalog, boards: [...catalog.boards, { id: 'board-2', name: 'Delivery', parentId: 'team-1' }] })).toThrow('AMBIGUOUS_TARGET');
    expect(() => resolveBoardIdentity({ ...target, project: { name: '' } }, catalog)).toThrow('INVALID_RESPONSE');
  });
  it('retains area and iteration configuration without inventing an iteration restriction', () => {
    const result = resolveBoardScope(identity, scope, 10);
    expect(result.iterations).toEqual(scope.iterations);
    expect(result.backlogIteration).toEqual(scope.backlogIteration);
    expect(result.iterationFilter).toBe('ALL_CONFIGURED_AREAS');
    expect(isAreaInScope(result, 'ExampleProject\\One\\Child')).toBe(true);
    expect(isAreaInScope(result, 'ExampleProject\\OneOther')).toBe(false);
    expect(isAreaInScope(result, 'ExampleProject\\Shared')).toBe(true);
    expect(isAreaInScope(result, 'ExampleProject\\Shared\\Child')).toBe(false);
    expect(isAreaInScope(result, 'ExampleProject\\Other')).toBe(false);
  });
  it.each([
    { ...scope, teamId: 'team-other' },
    { ...scope, field: { ...scope.field, values: [] } },
    { ...scope, field: { ...scope.field, referenceName: 'Custom.Team' } },
    { ...scope, field: { ...scope.field, defaultValue: 'missing' } },
    { ...scope, field: { ...scope.field, values: [{ value: 'OtherProject\\One', includeChildren: true }] } },
    { ...scope, field: { ...scope.field, values: [{ value: 'ExampleProject\\..\\Other', includeChildren: true }] } },
    { ...scope, field: { ...scope.field, values: [...scope.field.values, scope.field.values[0]!] } },
    { ...scope, iterations: [...scope.iterations, scope.iterations[0]!] },
  ])('rejects unsafe or incomplete scope %#', response => {
    expect(() => resolveBoardScope(identity, response, 10)).toThrow('INVALID_RESPONSE');
  });
  it('bounds discovery responses', () => {
    expect(() => resolveBoardScope(identity, scope, 1)).toThrow('LIMIT_EXCEEDED');
    expect(() => discoverBacklogs(backlogs, 1)).toThrow('LIMIT_EXCEEDED');
  });
  it('rejects conflicting display names for a single resolved ID', () => {
    expect(() => resolveBoardIdentity(target, { ...catalog, boards: [...catalog.boards, { ...catalog.boards[0]!, name: 'Conflicting' }] })).toThrow('AMBIGUOUS_TARGET');
  });
  it('keeps alternate levels and types with source-defined rank', () => {
    const result = discoverBacklogs(backlogs, 10);
    expect(result.map(backlog => backlog.id)).toEqual(['strategy', 'delivery']);
    expect(result[0]!.type).toBe('portfolio');
    expect(result[1]!.type).toBe('requirement');
    expect(result[1]!.workItemTypes).toEqual(['Issue', 'Request']);
    expect(backlogs[0]!.id).toBe('delivery');
    expect(() => discoverBacklogs([backlogs[0]!, backlogs[0]!], 10)).toThrow('INVALID_RESPONSE');
    expect(() => discoverBacklogs([{ ...backlogs[0]!, rank: NaN }], 10)).toThrow('INVALID_RESPONSE');
    expect(() => discoverBacklogs([{ ...backlogs[0]!, type: 'unknown' as Backlog['type'] }], 10)).toThrow('INVALID_RESPONSE');
  });
});

describe('full enumeration planning', () => {
  const first = { backlogId: 'delivery', continuation: null, nextContinuation: 'cursor-one', ids: [1, 2, 2] };
  const second = { backlogId: 'delivery', continuation: 'cursor-one', nextContinuation: null, ids: [3] };
  const strategy = { backlogId: 'strategy', continuation: null, nextContinuation: null, ids: [2] };
  it('returns pending levels, resumes pages and unions provenance before chunking', () => {
    const partial = planEnumeration(backlogs, [first], limits);
    expect(partial.complete).toBe(false);
    expect(partial.pending).toEqual([{ backlogId: 'strategy', continuation: null }, { backlogId: 'delivery', continuation: 'cursor-one' }]);
    expect(() => enumerationChunk(partial, 0)).toThrow('INVALID_CONTINUATION');
    const complete = planEnumeration(backlogs, [first, strategy, second], limits);
    expect(complete.items.map(item => item.id)).toEqual([1, 2, 3]);
    expect(complete.items[1]!.memberships.map(backlog => backlog.id)).toEqual(['delivery', 'strategy']);
    expect(complete.items[1]!.memberships[1]!.rank).toBe(2);
    expect(enumerationChunk(complete, 0).nextOffset).toBe(2);
    expect(enumerationChunk(complete, 2)).toMatchObject({ items: [{ id: 3 }], nextOffset: null });
    expect(() => enumerationChunk(complete, -1)).toThrow('INVALID_CONTINUATION');
  });
  it('distinguishes undiscovered membership from an explicitly empty level', () => {
    expect(planEnumeration(backlogs, [], limits).complete).toBe(false);
    expect(planEnumeration(backlogs, backlogs.map(backlog => ({ backlogId: backlog.id, ids: [], continuation: null, nextContinuation: null })), limits).complete).toBe(true);
  });
  it('rejects replay, unknown levels, skipped cursors and cursor cycles', () => {
    for (const pages of [[first, first], [second], [strategy, strategy], [{ ...first, backlogId: 'unknown' }], [first, { ...second, nextContinuation: 'cursor-one' }]]) {
      expect(() => planEnumeration(backlogs, pages, limits)).toThrow('INVALID_CONTINUATION');
    }
  });
  it('enforces page, total, page-item and ID bounds', () => {
    expect(() => planEnumeration(backlogs, [first], { ...limits, maxPages: 1 })).toThrow('LIMIT_EXCEEDED');
    expect(() => planEnumeration(backlogs, [first], { ...limits, maxPageItems: 2 })).toThrow('LIMIT_EXCEEDED');
    expect(() => planEnumeration(backlogs, [first, second], { ...limits, maxItems: 2 })).toThrow('LIMIT_EXCEEDED');
    expect(() => planEnumeration(backlogs, [{ ...first, ids: [0] }], limits)).toThrow('INVALID_RESPONSE');
    expect(() => planEnumeration(backlogs, [], { ...limits, chunkSize: 0 })).toThrow('INVALID_RESPONSE');
  });
});

describe('isolated read-only adapter contract', () => {
  it('exposes only semantic read operations, including query POST semantics', () => {
    expect(Object.values(readSemantics).every(effect => effect === 'READ' || effect === 'READ_QUERY')).toBe(true);
    expect(readSemantics.workItemQuery).toBe('READ_QUERY');
    const fake = new FakeAzureDevOpsAdapter(policy, fixtures);
    expect(fake.mode).toBe('READ_ONLY');
    expect('http' in fake || 'patch' in fake || 'delete' in fake).toBe(false);
    const context = fake.createContext();
    expect(JSON.stringify([context.auth, context.session])).toBe('[{},{}]');
    expectTypeOf<string>().not.toMatchTypeOf<AuthReference>();
    expectTypeOf<keyof typeof readSemantics>().toEqualTypeOf<'boardRead' | 'boardScopeRead' | 'backlogsList' | 'workItemQuery' | 'workItemGet' | 'workItemBatch' | 'commentsList' | 'linksList'>();
  });
  it.each<FailureCode>(['UNAUTHENTICATED', 'UNAUTHORIZED', 'NETWORK_FAILURE', 'POLICY_DENIED', 'RATE_LIMITED', 'UPSTREAM_FAILURE'])('models %s without raw upstream diagnostics', async failure => {
    const fake = new FakeAzureDevOpsAdapter(policy, fixtures, { failure, retryAfterMs: 9000 });
    const result = await fake.boardRead(fake.createContext());
    expect(result).toEqual(failure === 'RATE_LIMITED' ? { ok: false, code: failure, retryAfterMs: 500 } : { ok: false, code: failure });
  });
  it('rejects forged, mixed and foreign references', async () => {
    const fake = new FakeAzureDevOpsAdapter(policy, fixtures);
    const context = fake.createContext();
    expect(await fake.boardRead({ ...context, auth: {} as AuthReference })).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await fake.boardRead({ ...context, auth: fake.createContext().auth })).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await fake.boardRead(new FakeAzureDevOpsAdapter(policy, fixtures).createContext())).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it.each(['organization', 'project', 'team', 'board'] as const)('checks exact %s allowlist IDs', async key => {
    const fake = new FakeAzureDevOpsAdapter({ ...policy, allowlist: [{ ...policy.allowlist[0]!, [key]: 'not-allowed' }] }, fixtures);
    expect(await fake.boardRead(fake.createContext())).toMatchObject({ code: 'POLICY_DENIED' });
  });
  it('denies empty and resource-specific allowlists', async () => {
    for (const allowlist of [[], [{ ...policy.allowlist[0]!, resources: [] }]]) {
      const fake = new FakeAzureDevOpsAdapter({ ...policy, allowlist }, fixtures);
      expect(await fake.boardRead(fake.createContext())).toMatchObject({ code: 'POLICY_DENIED' });
    }
    expect(() => validatePolicy({ ...policy, timeoutMs: 0 })).toThrow();
  });
  it('fails closed when limits are omitted at runtime', () => {
    const incomplete = structuredClone(limits);
    Reflect.deleteProperty(incomplete, 'maxPages');
    expect(() => planEnumeration(backlogs, [], incomplete)).toThrow('INVALID_RESPONSE');
    const incompletePolicy = structuredClone(policy);
    Reflect.deleteProperty(incompletePolicy.rateLimit, 'requests');
    expect(() => validatePolicy(incompletePolicy)).toThrow('INVALID_RESPONSE');
  });
  it('covers all eight operations and does not return cross-team query items', async () => {
    const fake = new FakeAzureDevOpsAdapter(policy, fixtures);
    const context = fake.createContext();
    expect(await fake.boardRead(context)).toEqual({ ok: true, value: identity });
    expect(await fake.boardScopeRead(context)).toEqual({ ok: true, value: scope });
    expect(await fake.backlogsList(context, page)).toMatchObject({ ok: true, value: { items: backlogs } });
    expect(await fake.workItemQuery(context, { wiql: 'synthetic query' }, page)).toMatchObject({ value: { items: [1, 2] } });
    expect(await fake.workItemGet(context, 1)).toMatchObject({ value: { id: 1 } });
    expect(await fake.workItemBatch(context, [1, 2])).toMatchObject({ ok: true });
    expect(await fake.commentsList(context, 1, page)).toMatchObject({ value: { items: fixtures.comments[1] } });
    expect(await fake.linksList(context, 1, page)).toMatchObject({ value: { items: fixtures.links[1] } });
    expect(await fake.workItemGet(context, 3)).toMatchObject({ code: 'UPSTREAM_FAILURE' });
    expect(await fake.workItemBatch(context, [1, 3])).toMatchObject({ code: 'UPSTREAM_FAILURE' });
    expect(await fake.commentsList(context, 3, page)).toMatchObject({ code: 'UPSTREAM_FAILURE' });
  });
  it('bounds payload bytes, batch size, timeout and page requests', async () => {
    const tiny = new FakeAzureDevOpsAdapter({ ...policy, maxResponseBytes: 1 }, fixtures);
    expect(await tiny.boardRead(tiny.createContext())).toMatchObject({ code: 'POLICY_DENIED' });
    const slow = new FakeAzureDevOpsAdapter(policy, fixtures, { latencyMs: 101 });
    expect(await slow.boardRead(slow.createContext())).toMatchObject({ code: 'NETWORK_FAILURE' });
    const fake = new FakeAzureDevOpsAdapter(policy, fixtures);
    const context = fake.createContext();
    expect(await fake.workItemBatch(context, [1, 1, 1, 1, 1, 1])).toMatchObject({ code: 'POLICY_DENIED' });
    expect(await fake.backlogsList(context, { ...page, limit: 11 })).toMatchObject({ code: 'POLICY_DENIED' });
    expect(await fake.backlogsList(context, { ...page, index: 10 })).toMatchObject({ code: 'POLICY_DENIED' });
  });
  it('paginates deterministically and rejects invalid continuations', async () => {
    const fake = new FakeAzureDevOpsAdapter(policy, fixtures);
    const context = fake.createContext();
    expect(await fake.backlogsList(context, { ...page, limit: 1 })).toMatchObject({ value: { items: [backlogs[0]], nextContinuation: 'fake:1:1' } });
    expect(await fake.backlogsList(context, { index: 1, limit: 1, continuation: 'fake:1:1' })).toMatchObject({ value: { items: [backlogs[1]], nextContinuation: null } });
    expect(await fake.backlogsList(context, { ...page, continuation: 'bad' })).toMatchObject({ code: 'UPSTREAM_FAILURE' });
  });
  it('models rate windows and clamps retry delay without sleeps', async () => {
    let now = 0;
    const fake = new FakeAzureDevOpsAdapter({ ...policy, rateLimit: { ...policy.rateLimit, requests: 1 } }, fixtures, {}, () => now);
    const context = fake.createContext();
    expect(await fake.boardRead(context)).toMatchObject({ ok: true });
    expect(await fake.boardRead(context)).toEqual({ ok: false, code: 'RATE_LIMITED', retryAfterMs: 500 });
    now = 1000;
    expect(await fake.boardRead(context)).toMatchObject({ ok: true });
  });
  it('refuses out-of-scope link targets and redacts validation exceptions', async () => {
    const fake = new FakeAzureDevOpsAdapter(policy, { ...fixtures, links: { 1: [{ relation: 'related', targetWorkItemId: 3 }] } });
    expect(await fake.linksList(fake.createContext(), 1, page)).toEqual({ ok: false, code: 'UPSTREAM_FAILURE' });
  });
  it('snapshots policy and fixtures and returns detached values', async () => {
    const mutablePolicy = structuredClone(policy);
    const mutableFixtures = structuredClone(fixtures);
    const fake = new FakeAzureDevOpsAdapter(mutablePolicy, mutableFixtures);
    Object.assign(mutablePolicy, { allowlist: [] });
    Object.assign(mutableFixtures.identity.board, { name: 'Changed' });
    const context = fake.createContext();
    const result = await fake.boardRead(context);
    if (!result.ok) throw new Error('EXPECTED_SUCCESS');
    Object.assign(result.value.board, { name: 'ChangedAgain' });
    expect(await fake.boardRead(context)).toEqual({ ok: true, value: identity });
  });
  it('measures response limits as UTF-8 bytes and rejects page exhaustion', async () => {
    const unicode = { ...fixtures, comments: { 1: [{ id: 'comment-1', text: '界'.repeat(30) }] } };
    const fake = new FakeAzureDevOpsAdapter({ ...policy, maxResponseBytes: 120 }, unicode);
    expect(await fake.commentsList(fake.createContext(), 1, page)).toMatchObject({ code: 'POLICY_DENIED' });
    const limited = new FakeAzureDevOpsAdapter({ ...policy, maxPages: 1 }, fixtures);
    expect(await limited.backlogsList(limited.createContext(), { ...page, limit: 1 })).toMatchObject({ code: 'UPSTREAM_FAILURE' });
  });
});
