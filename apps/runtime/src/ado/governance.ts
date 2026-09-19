import {
  isAllowed,
  validatePolicy,
  type PageRequest,
  type ReadPolicy,
  type Resource,
} from './adapter.js';
import type { BoardIdentity } from './discovery.js';

export const adoReadOperations = [
  'ado.board.read',
  'ado.scope.read',
  'ado.backlogs.list',
  'ado.work_items.query',
  'ado.work_items.get',
  'ado.work_items.batch',
  'ado.comments.list',
  'ado.links.list',
] as const;

export type AdoReadOperation = typeof adoReadOperations[number];
export type AdoGovernanceFailureCode =
  | 'INVALID_REQUEST'
  | 'POLICY_INVALID'
  | 'UNAUTHORIZED'
  | 'EXPIRED_AUTH'
  | 'REVOKED_AUTH'
  | 'NETWORK_DISABLED'
  | 'SCOPE_DENIED'
  | 'LIMIT_EXCEEDED';

export interface AdoReadGrant {
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly credentialRef: string;
  readonly sessionRef: string;
  readonly network: 'allowed' | 'disabled';
  readonly expiresAt: string;
  readonly revoked: boolean;
  readonly tokenScopes: readonly string[];
  readonly policy: ReadPolicy;
}

interface AdoReadRequestBase {
  readonly requestId: string;
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly identity: BoardIdentity;
}

export type AdoReadRequest =
  | (AdoReadRequestBase & { readonly operation: 'ado.board.read' | 'ado.scope.read' })
  | (AdoReadRequestBase & { readonly operation: 'ado.backlogs.list'; readonly page: PageRequest })
  | (AdoReadRequestBase & { readonly operation: 'ado.work_items.query'; readonly wiql: string; readonly page: PageRequest })
  | (AdoReadRequestBase & { readonly operation: 'ado.work_items.get'; readonly id: number })
  | (AdoReadRequestBase & { readonly operation: 'ado.work_items.batch'; readonly ids: readonly number[] })
  | (AdoReadRequestBase & { readonly operation: 'ado.comments.list' | 'ado.links.list'; readonly id: number; readonly page: PageRequest });

export type BoundAdoReadRequest = AdoReadRequest & {
  readonly expectedEffects: readonly ['READ', 'NETWORK'];
  readonly semanticEffect: 'READ' | 'READ_QUERY';
};

export class AdoGovernanceError extends Error {
  readonly code: AdoGovernanceFailureCode;
  constructor(code: AdoGovernanceFailureCode) {
    super(code);
    this.code = code;
  }
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const opaqueRefMaxLength = 2048;
const continuationMaxLength = 2048;
const wiqlMaxLength = 32 * 1024;
const upstreamWorkItemBatchMaximum = 200;

export function bindAdoRead(grant: AdoReadGrant, request: AdoReadRequest, now: number): BoundAdoReadRequest {
  validateRequestBase(request);
  validateGrant(grant, now);
  if (request.projectId !== grant.projectId || request.connectorBindingId !== grant.connectorBindingId) fail('UNAUTHORIZED');

  const resource = resourceForOperation(request.operation);
  if (!isAllowed(grant.policy, request.identity, resource)) fail('SCOPE_DENIED');

  const common = {
    requestId: request.requestId,
    projectId: request.projectId,
    connectorBindingId: request.connectorBindingId,
    identity: freezeIdentity(request.identity),
    expectedEffects: Object.freeze(['READ', 'NETWORK'] as const),
    semanticEffect: request.operation === 'ado.work_items.query' ? 'READ_QUERY' as const : 'READ' as const,
  };

  if (request.operation === 'ado.board.read' || request.operation === 'ado.scope.read') {
    return Object.freeze({ ...common, operation: request.operation });
  }
  if (request.operation === 'ado.backlogs.list') {
    return Object.freeze({ ...common, operation: request.operation, page: freezePage(request.page, grant.policy) });
  }
  if (request.operation === 'ado.work_items.query') {
    if (!boundedText(request.wiql, wiqlMaxLength)) fail('INVALID_REQUEST');
    return Object.freeze({
      ...common,
      operation: request.operation,
      wiql: request.wiql,
      page: freezePage(request.page, grant.policy),
    });
  }
  if (request.operation === 'ado.work_items.get') {
    return Object.freeze({ ...common, operation: request.operation, id: positiveId(request.id) });
  }
  if (request.operation === 'ado.work_items.batch') {
    if (!Array.isArray(request.ids) || request.ids.length === 0
      || request.ids.length > grant.policy.maxBatchItems
      || request.ids.length > upstreamWorkItemBatchMaximum) fail('LIMIT_EXCEEDED');
    const ids = request.ids.map(positiveId);
    if (new Set(ids).size !== ids.length) fail('INVALID_REQUEST');
    return Object.freeze({ ...common, operation: request.operation, ids: Object.freeze(ids) });
  }
  if (request.operation === 'ado.comments.list' || request.operation === 'ado.links.list') {
    return Object.freeze({
      ...common,
      operation: request.operation,
      id: positiveId(request.id),
      page: freezePage(request.page, grant.policy),
    });
  }
  return fail('INVALID_REQUEST');
}

export function resourceForOperation(operation: AdoReadOperation): Resource {
  if (operation === 'ado.board.read') return 'board';
  if (operation === 'ado.scope.read') return 'scope';
  if (operation === 'ado.backlogs.list') return 'backlogs';
  if (operation === 'ado.work_items.query') return 'query';
  if (operation === 'ado.work_items.get' || operation === 'ado.work_items.batch') return 'workItems';
  if (operation === 'ado.comments.list') return 'comments';
  return 'links';
}

function validateGrant(grant: AdoReadGrant, now: number): void {
  if (typeof grant !== 'object' || grant === null || !Number.isFinite(now)
    || !boundedIdentity(grant.projectId) || !boundedIdentity(grant.connectorBindingId)
    || !boundedOpaqueRef(grant.credentialRef) || !boundedOpaqueRef(grant.sessionRef)
    || typeof grant.expiresAt !== 'string' || typeof grant.revoked !== 'boolean'
    || (grant.network !== 'allowed' && grant.network !== 'disabled')
    || !Array.isArray(grant.tokenScopes)) fail('POLICY_INVALID');

  if (grant.revoked) fail('REVOKED_AUTH');
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt)) fail('POLICY_INVALID');
  if (expiresAt <= now) fail('EXPIRED_AUTH');
  if (grant.network !== 'allowed') fail('NETWORK_DISABLED');

  if (grant.tokenScopes.length !== 1 || grant.tokenScopes[0] !== 'vso.work') fail('SCOPE_DENIED');
  try {
    validatePolicy(grant.policy);
  } catch {
    fail('POLICY_INVALID');
  }
  if (grant.policy.maxBatchItems > upstreamWorkItemBatchMaximum) fail('POLICY_INVALID');
}

function validateRequestBase(request: AdoReadRequest): void {
  if (typeof request !== 'object' || request === null
    || !adoReadOperations.includes(request.operation)
    || !boundedIdentity(request.requestId)
    || !boundedIdentity(request.projectId)
    || !boundedIdentity(request.connectorBindingId)) fail('INVALID_REQUEST');
  validateIdentity(request.identity);
}

function validateIdentity(identity: BoardIdentity): void {
  if (typeof identity !== 'object' || identity === null) fail('INVALID_REQUEST');
  for (const value of [identity.organization, identity.project, identity.team, identity.board]) {
    if (typeof value !== 'object' || value === null
      || !boundedText(value.id, 1024) || !boundedText(value.name, 1024)) fail('INVALID_REQUEST');
  }
}

function freezeIdentity(identity: BoardIdentity): BoardIdentity {
  validateIdentity(identity);
  return Object.freeze({
    organization: Object.freeze({ ...identity.organization }),
    project: Object.freeze({ ...identity.project }),
    team: Object.freeze({ ...identity.team }),
    board: Object.freeze({ ...identity.board }),
  });
}

function freezePage(page: PageRequest, policy: ReadPolicy): PageRequest {
  if (typeof page !== 'object' || page === null
    || !Number.isSafeInteger(page.index) || page.index < 0 || page.index >= policy.maxPages
    || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > policy.maxPageItems
    || !(page.continuation === null || boundedText(page.continuation, continuationMaxLength))) fail('LIMIT_EXCEEDED');
  if ((page.index === 0) !== (page.continuation === null)) fail('INVALID_REQUEST');
  return Object.freeze({
    index: page.index,
    continuation: page.continuation,
    limit: page.limit,
  });
}

function positiveId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_REQUEST');
  return value;
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && requestIdPattern.test(value);
}

function boundedOpaqueRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= opaqueRefMaxLength && !value.includes('\0');
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !value.includes('\0');
}

function fail(code: AdoGovernanceFailureCode): never {
  throw new AdoGovernanceError(code);
}
