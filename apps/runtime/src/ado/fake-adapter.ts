import { isAllowed, validatePolicy, type AuthReference, type AzureDevOpsAdapter, type Comment, type FailureCode, type Page, type PageRequest, type ReadContext, type ReadPolicy, type ReadResult, type Resource, type SessionReference, type WorkItem, type WorkItemLink } from './adapter.js';
import { isAreaInScope, positive, resolveBoardScope, text, type Backlog, type BoardIdentity, type ScopeResponse } from './discovery.js';

export interface FakeResponses {
  readonly identity: BoardIdentity;
  readonly scope: ScopeResponse;
  readonly backlogs: readonly Backlog[];
  readonly workItems: readonly WorkItem[];
  readonly queryIds: readonly number[];
  readonly comments: Readonly<Record<number, readonly Comment[]>>;
  readonly links: Readonly<Record<number, readonly WorkItemLink[]>>;
}
export interface FakeScenario {
  readonly failure?: FailureCode;
  readonly retryAfterMs?: number;
  readonly latencyMs?: number;
}
function sameIdentity(left: BoardIdentity, right: BoardIdentity): boolean {
  return (['organization', 'project', 'team', 'board'] as const).every(key => left[key].id === right[key].id);
}
export class FakeAzureDevOpsAdapter implements AzureDevOpsAdapter {
  readonly mode = 'READ_ONLY' as const;
  private readonly policy: ReadPolicy;
  private readonly fixtures: FakeResponses;
  private readonly scenario: FakeScenario;
  private readonly sessions = new WeakMap<SessionReference, AuthReference>();
  private windowStart: number | undefined;
  private requests = 0;

  constructor(policy: ReadPolicy, fixtures: FakeResponses, scenario: FakeScenario = {}, private readonly now: () => number = Date.now) {
    validatePolicy(policy);
    if (scenario.latencyMs !== undefined && (!Number.isSafeInteger(scenario.latencyMs) || scenario.latencyMs < 0)) throw new Error('INVALID_SCENARIO');
    if (scenario.retryAfterMs !== undefined) positive(scenario.retryAfterMs);
    this.policy = structuredClone(policy);
    this.fixtures = structuredClone(fixtures);
    this.scenario = structuredClone(scenario);
  }

  createContext(): ReadContext {
    const auth = Object.freeze({}) as AuthReference;
    const session = Object.freeze({}) as SessionReference;
    this.sessions.set(session, auth);
    return { identity: structuredClone(this.fixtures.identity), auth, session };
  }

  private read<Value>(context: ReadContext, resource: Resource, operation: () => Value, page?: PageRequest): ReadResult<Value> {
    if (!this.sessions.has(context.session) || this.sessions.get(context.session) !== context.auth) return { ok: false, code: 'UNAUTHENTICATED' };
    if (!sameIdentity(context.identity, this.fixtures.identity) || !isAllowed(this.policy, context.identity, resource)) return { ok: false, code: 'POLICY_DENIED' };
    if (page && (!Number.isSafeInteger(page.index) || page.index < 0 || page.index >= this.policy.maxPages || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > this.policy.maxPageItems)) return { ok: false, code: 'POLICY_DENIED' };
    const now = this.now();
    if (!Number.isSafeInteger(now) || (this.windowStart !== undefined && now < this.windowStart)) return { ok: false, code: 'POLICY_DENIED' };
    if (this.windowStart === undefined || now - this.windowStart >= this.policy.rateLimit.windowMs) { this.windowStart = now; this.requests = 0; }
    if (this.requests >= this.policy.rateLimit.requests) return { ok: false, code: 'RATE_LIMITED', retryAfterMs: Math.min(this.policy.rateLimit.maxRetryAfterMs, this.policy.rateLimit.windowMs - (now - this.windowStart)) };
    this.requests += 1;
    if (this.scenario.failure) return this.scenario.failure === 'RATE_LIMITED'
      ? { ok: false, code: 'RATE_LIMITED', retryAfterMs: Math.min(this.scenario.retryAfterMs ?? this.policy.rateLimit.windowMs, this.policy.rateLimit.maxRetryAfterMs) }
      : { ok: false, code: this.scenario.failure };
    if ((this.scenario.latencyMs ?? 0) > this.policy.timeoutMs) return { ok: false, code: 'NETWORK_FAILURE' };
    try {
      const value = operation();
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.policy.maxResponseBytes) return { ok: false, code: 'POLICY_DENIED' };
      return { ok: true, value: structuredClone(value) };
    } catch {
      return { ok: false, code: 'UPSTREAM_FAILURE' };
    }
  }

  private page<Value>(items: readonly Value[], page: PageRequest): Page<Value> {
    const offset = page.index * page.limit;
    const expected = page.index === 0 ? null : `fake:${page.index}:${page.limit}`;
    if (!Number.isSafeInteger(offset) || page.continuation !== expected || (offset >= items.length && page.index !== 0)) throw new Error('INVALID_PAGE');
    const more = offset + page.limit < items.length;
    if (more && page.index + 1 >= this.policy.maxPages) throw new Error('PAGE_LIMIT');
    return { items: items.slice(offset, offset + page.limit), nextContinuation: more ? `fake:${page.index + 1}:${page.limit}` : null };
  }

  private item(id: number): WorkItem {
    positive(id);
    const matches = this.fixtures.workItems.filter(item => item.id === id);
    if (matches.length !== 1 || !isAreaInScope(resolveBoardScope(this.fixtures.identity, this.fixtures.scope, this.policy.maxPageItems), matches[0]!.areaPath)) throw new Error('OUTSIDE_SCOPE');
    return matches[0]!;
  }

  async boardRead(context: ReadContext): Promise<ReadResult<BoardIdentity>> {
    return this.read(context, 'board', () => this.fixtures.identity);
  }
  async boardScopeRead(context: ReadContext): Promise<ReadResult<ScopeResponse>> {
    return this.read(context, 'scope', () => {
      resolveBoardScope(this.fixtures.identity, this.fixtures.scope, this.policy.maxPageItems);
      return this.fixtures.scope;
    });
  }
  async backlogsList(context: ReadContext, page: PageRequest): Promise<ReadResult<Page<Backlog>>> {
    return this.read(context, 'backlogs', () => this.page(this.fixtures.backlogs, page), page);
  }
  async workItemQuery(context: ReadContext, query: { readonly wiql: string }, page: PageRequest): Promise<ReadResult<Page<number>>> {
    return this.read(context, 'query', () => {
      text(query.wiql);
      const ids = this.fixtures.queryIds.filter(id => {
        positive(id);
        const item = this.fixtures.workItems.find(candidate => candidate.id === id);
        return item && isAreaInScope(resolveBoardScope(this.fixtures.identity, this.fixtures.scope, this.policy.maxPageItems), item.areaPath);
      });
      return this.page(ids, page);
    }, page);
  }
  async workItemGet(context: ReadContext, id: number): Promise<ReadResult<WorkItem>> {
    return this.read(context, 'workItems', () => this.item(id));
  }
  async workItemBatch(context: ReadContext, ids: readonly number[]): Promise<ReadResult<readonly WorkItem[]>> {
    if (!ids.length || ids.length > this.policy.maxBatchItems) return { ok: false, code: 'POLICY_DENIED' };
    return this.read(context, 'workItems', () => ids.map(id => this.item(id)));
  }
  async commentsList(context: ReadContext, id: number, page: PageRequest): Promise<ReadResult<Page<Comment>>> {
    return this.read(context, 'comments', () => { this.item(id); return this.page(this.fixtures.comments[id] ?? [], page); }, page);
  }
  async linksList(context: ReadContext, id: number, page: PageRequest): Promise<ReadResult<Page<WorkItemLink>>> {
    return this.read(context, 'links', () => {
      this.item(id);
      const links = this.fixtures.links[id] ?? [];
      links.forEach(link => { text(link.relation); this.item(link.targetWorkItemId); });
      return this.page(links, page);
    }, page);
  }
}
