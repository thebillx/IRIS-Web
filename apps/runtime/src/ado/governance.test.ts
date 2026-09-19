import { describe, expect, it } from 'vitest';
import type { ReadPolicy } from './adapter.js';
import { AdoGovernanceError, bindAdoRead, resourceForOperation, type AdoReadGrant, type AdoReadRequest } from './governance.js';
import type { BoardIdentity } from './discovery.js';

const identity: BoardIdentity = {
  organization: { id: 'org-1', name: 'ExampleOrg' },
  project: { id: 'project-1', name: 'ExampleProject' },
  team: { id: 'team-1', name: 'ExampleTeam' },
  board: { id: 'board-1', name: 'Delivery' },
};

const policy: ReadPolicy = {
  mode: 'READ_ONLY',
  allowlist: [{
    organization: 'org-1',
    project: 'project-1',
    team: 'team-1',
    board: 'board-1',
    resources: ['board', 'scope', 'backlogs', 'query', 'workItems', 'comments', 'links'],
  }],
  timeoutMs: 5_000,
  maxResponseBytes: 2_000_000,
  maxPageItems: 100,
  maxPages: 20,
  maxBatchItems: 200,
  rateLimit: { requests: 100, windowMs: 60_000, maxRetryAfterMs: 60_000 },
};

const grant: AdoReadGrant = {
  projectId: 'iris-project',
  connectorBindingId: 'ado-binding-1',
  credentialRef: 'secret://ado/read-token',
  sessionRef: 'ado-session-1',
  network: 'allowed',
  expiresAt: '2026-09-20T00:00:00.000Z',
  revoked: false,
  tokenScopes: ['vso.work'],
  policy,
};

const base = {
  requestId: 'ado-request-1',
  projectId: grant.projectId,
  connectorBindingId: grant.connectorBindingId,
  identity,
} as const;

const now = Date.parse('2026-09-19T12:00:00.000Z');

function code(work: () => unknown): string {
  try {
    work();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof AdoGovernanceError ? error.code : 'OTHER_ERROR';
  }
}

describe('ADO current-governance binding', () => {
  it('binds every named operation to READ + NETWORK without leaking auth references', () => {
    const requests: AdoReadRequest[] = [
      { ...base, operation: 'ado.board.read' },
      { ...base, operation: 'ado.scope.read' },
      { ...base, operation: 'ado.backlogs.list', page: { index: 0, continuation: null, limit: 50 } },
      { ...base, operation: 'ado.work_items.query', wiql: 'SELECT [System.Id] FROM WorkItems', page: { index: 0, continuation: null, limit: 50 } },
      { ...base, operation: 'ado.work_items.get', id: 1 },
      { ...base, operation: 'ado.work_items.batch', ids: [1, 2] },
      { ...base, operation: 'ado.comments.list', id: 1, page: { index: 0, continuation: null, limit: 50 } },
      { ...base, operation: 'ado.links.list', id: 1, page: { index: 0, continuation: null, limit: 50 } },
    ];
    for (const request of requests) {
      const bound = bindAdoRead(grant, request, now);
      expect(bound.expectedEffects).toEqual(['READ', 'NETWORK']);
      expect(JSON.stringify(bound)).not.toContain(grant.credentialRef);
      expect(JSON.stringify(bound)).not.toContain(grant.sessionRef);
    }
    expect(bindAdoRead(grant, requests[3]!, now).semanticEffect).toBe('READ_QUERY');
  });

  it('requires the least-privilege documented read scope', () => {
    expect(code(() => bindAdoRead({ ...grant, tokenScopes: [] }, { ...base, operation: 'ado.board.read' }, now))).toBe('SCOPE_DENIED');
    expect(code(() => bindAdoRead({ ...grant, tokenScopes: ['vso.work', 'vso.work_write'] }, { ...base, operation: 'ado.board.read' }, now))).toBe('SCOPE_DENIED');
  });

  it('fails closed for expired, revoked or network-disabled grants', () => {
    expect(code(() => bindAdoRead({ ...grant, expiresAt: '2026-09-19T11:59:59.000Z' }, { ...base, operation: 'ado.board.read' }, now))).toBe('EXPIRED_AUTH');
    expect(code(() => bindAdoRead({ ...grant, revoked: true }, { ...base, operation: 'ado.board.read' }, now))).toBe('REVOKED_AUTH');
    expect(code(() => bindAdoRead({ ...grant, network: 'disabled' }, { ...base, operation: 'ado.board.read' }, now))).toBe('NETWORK_DISABLED');
  });

  it('binds project, connector and exact board tuple before resource access', () => {
    expect(code(() => bindAdoRead(grant, { ...base, projectId: 'other', operation: 'ado.board.read' }, now))).toBe('UNAUTHORIZED');
    expect(code(() => bindAdoRead(grant, { ...base, connectorBindingId: 'other', operation: 'ado.board.read' }, now))).toBe('UNAUTHORIZED');
    expect(code(() => bindAdoRead(grant, {
      ...base,
      identity: { ...identity, board: { id: 'other-board', name: identity.board.name } },
      operation: 'ado.board.read',
    }, now))).toBe('SCOPE_DENIED');
  });

  it('enforces resource-specific grants', () => {
    const boardOnly: AdoReadGrant = { ...grant, policy: { ...policy, allowlist: [{ ...policy.allowlist[0]!, resources: ['board'] }] } };
    expect(bindAdoRead(boardOnly, { ...base, operation: 'ado.board.read' }, now).operation).toBe('ado.board.read');
    expect(code(() => bindAdoRead(boardOnly, { ...base, operation: 'ado.work_items.get', id: 1 }, now))).toBe('SCOPE_DENIED');
    expect(resourceForOperation('ado.work_items.batch')).toBe('workItems');
  });

  it('caps batch grants and requests at the upstream 200-item maximum', () => {
    expect(code(() => bindAdoRead({ ...grant, policy: { ...policy, maxBatchItems: 201 } }, {
      ...base, operation: 'ado.work_items.batch', ids: [1],
    }, now))).toBe('POLICY_INVALID');
    expect(code(() => bindAdoRead(grant, {
      ...base, operation: 'ado.work_items.batch', ids: Array.from({ length: 201 }, (_, index) => index + 1),
    }, now))).toBe('LIMIT_EXCEEDED');
    expect(code(() => bindAdoRead(grant, { ...base, operation: 'ado.work_items.batch', ids: [1, 1] }, now))).toBe('INVALID_REQUEST');
  });

  it('bounds WIQL and pagination without exposing a generic transport', () => {
    expect(code(() => bindAdoRead(grant, {
      ...base, operation: 'ado.work_items.query', wiql: '', page: { index: 0, continuation: null, limit: 1 },
    }, now))).toBe('INVALID_REQUEST');
    expect(code(() => bindAdoRead(grant, {
      ...base, operation: 'ado.backlogs.list', page: { index: 20, continuation: 'next', limit: 1 },
    }, now))).toBe('LIMIT_EXCEEDED');
    expect(code(() => bindAdoRead(grant, {
      ...base, operation: 'ado.backlogs.list', page: { index: 1, continuation: null, limit: 1 },
    }, now))).toBe('INVALID_REQUEST');
  });

  it('returns detached immutable identity and request arrays', () => {
    const ids = [1, 2];
    const bound = bindAdoRead(grant, { ...base, operation: 'ado.work_items.batch', ids }, now);
    ids.push(3);
    if (bound.operation !== 'ado.work_items.batch') throw new Error('EXPECTED_BATCH_BINDING');
    expect(bound.ids).toEqual([1, 2]);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.identity.board)).toBe(true);
  });
});
