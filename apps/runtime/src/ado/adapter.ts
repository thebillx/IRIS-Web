import { positive, text, type Backlog, type BoardIdentity, type ScopeResponse } from './discovery.js';

declare const authReferenceBrand: unique symbol;
declare const sessionReferenceBrand: unique symbol;
export interface AuthReference { readonly [authReferenceBrand]: true }
export interface SessionReference { readonly [sessionReferenceBrand]: true }
export type FailureCode = 'UNAUTHENTICATED' | 'UNAUTHORIZED' | 'NETWORK_FAILURE' | 'POLICY_DENIED' | 'RATE_LIMITED' | 'UPSTREAM_FAILURE';
export type ReadResult<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly code: FailureCode; readonly retryAfterMs?: number };
export type Resource = 'board' | 'scope' | 'backlogs' | 'query' | 'workItems' | 'comments' | 'links';
export interface AllowedBoard { readonly organization: string; readonly project: string; readonly team: string; readonly board: string; readonly resources: readonly Resource[] }
export interface ReadPolicy {
  readonly mode: 'READ_ONLY';
  readonly allowlist: readonly AllowedBoard[];
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxPageItems: number;
  readonly maxPages: number;
  readonly maxBatchItems: number;
  readonly rateLimit: { readonly requests: number; readonly windowMs: number; readonly maxRetryAfterMs: number };
}
export interface ReadContext {
  readonly identity: BoardIdentity;
  readonly auth: AuthReference;
  readonly session: SessionReference;
}
export interface PageRequest { readonly index: number; readonly continuation: string | null; readonly limit: number }
export interface Page<Value> { readonly items: readonly Value[]; readonly nextContinuation: string | null }
export interface WorkItem { readonly id: number; readonly areaPath: string; readonly fields: Readonly<Record<string, string | number | boolean | null>> }
export interface Comment { readonly id: string; readonly text: string }
export interface WorkItemLink { readonly relation: string; readonly targetWorkItemId: number }
export interface AzureDevOpsAdapter {
  readonly mode: 'READ_ONLY';
  boardRead(context: ReadContext): Promise<ReadResult<BoardIdentity>>;
  boardScopeRead(context: ReadContext): Promise<ReadResult<ScopeResponse>>;
  backlogsList(context: ReadContext, page: PageRequest): Promise<ReadResult<Page<Backlog>>>;
  workItemQuery(context: ReadContext, query: { readonly wiql: string }, page: PageRequest): Promise<ReadResult<Page<number>>>;
  workItemGet(context: ReadContext, id: number): Promise<ReadResult<WorkItem>>;
  workItemBatch(context: ReadContext, ids: readonly number[]): Promise<ReadResult<readonly WorkItem[]>>;
  commentsList(context: ReadContext, id: number, page: PageRequest): Promise<ReadResult<Page<Comment>>>;
  linksList(context: ReadContext, id: number, page: PageRequest): Promise<ReadResult<Page<WorkItemLink>>>;
}
export const readSemantics = Object.freeze({ boardRead: 'READ', boardScopeRead: 'READ', backlogsList: 'READ', workItemQuery: 'READ_QUERY', workItemGet: 'READ', workItemBatch: 'READ', commentsList: 'READ', linksList: 'READ' } as const);
export function validatePolicy(policy: ReadPolicy): void {
  if (policy.mode !== 'READ_ONLY') throw new Error('INVALID_POLICY');
  [policy.timeoutMs, policy.maxResponseBytes, policy.maxPageItems, policy.maxPages, policy.maxBatchItems, policy.rateLimit.requests, policy.rateLimit.windowMs, policy.rateLimit.maxRetryAfterMs].forEach(positive);
  for (const entry of policy.allowlist) {
    [entry.organization, entry.project, entry.team, entry.board].forEach(text);
    if (entry.resources.some(resource => !['board', 'scope', 'backlogs', 'query', 'workItems', 'comments', 'links'].includes(resource))) throw new Error('INVALID_POLICY');
  }
}
export function isAllowed(policy: ReadPolicy, identity: BoardIdentity, resource: Resource): boolean {
  return policy.mode === 'READ_ONLY' && policy.allowlist.some(entry => entry.organization === identity.organization.id && entry.project === identity.project.id && entry.team === identity.team.id && entry.board === identity.board.id && entry.resources.includes(resource));
}
