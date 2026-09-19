import { createHash } from 'node:crypto';

export const githubReadOperations = [
  'github.repository_metadata',
  'github.get_ref',
  'github.get_commit',
  'github.pull_request_metadata',
  'github.pull_request_checks',
  'github.pull_request_diff',
  'github.pull_request_file',
] as const;

export const githubWriteOperations = [
  'github.create_pull_request',
  'github.update_pull_request',
  'github.comment_pull_request',
] as const;

export type GitHubReadOperation = typeof githubReadOperations[number];
export type GitHubWriteOperation = typeof githubWriteOperations[number];

export type GitHubFailureCode =
  | 'INVALID_REQUEST'
  | 'POLICY_INVALID'
  | 'UNAUTHORIZED'
  | 'EXPIRED_AUTH'
  | 'REVOKED_AUTH'
  | 'NETWORK_DISABLED'
  | 'OPERATION_DENIED'
  | 'REPOSITORY_MISMATCH'
  | 'SCOPE_DENIED'
  | 'STALE_REF'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_STALE'
  | 'APPROVAL_MISMATCH'
  | 'APPROVAL_REPLAY';

export interface GitHubRepositoryIdentity {
  readonly owner: string;
  readonly name: string;
  readonly repositoryId: string;
}

export interface GitHubRefIdentity {
  readonly ref: string;
  readonly sha: string;
}

export interface GitHubGrant {
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly credentialRef: string;
  readonly sessionRef: string;
  readonly network: 'allowed' | 'disabled';
  readonly repository: GitHubRepositoryIdentity;
  readonly readOperations: readonly GitHubReadOperation[];
  readonly writeOperations: readonly GitHubWriteOperation[];
  readonly tokenScopes: readonly string[];
  readonly expiresAt: string;
  readonly revoked: boolean;
}

export interface GitHubReadRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly operation: GitHubReadOperation;
  readonly repository: GitHubRepositoryIdentity;
  readonly ref?: string;
  readonly sha?: string;
  readonly pullRequestNumber?: number;
  readonly path?: string;
}

export interface BoundGitHubReadRequest extends GitHubReadRequest {
  readonly repository: GitHubRepositoryIdentity;
}

export type GitHubWritePayload =
  | { readonly title: string; readonly body: string; readonly draft: boolean }
  | { readonly title?: string; readonly body?: string }
  | { readonly body: string };

export interface GitHubWriteRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly operation: GitHubWriteOperation;
  readonly repository: GitHubRepositoryIdentity;
  readonly base: GitHubRefIdentity;
  readonly head: GitHubRefIdentity;
  readonly pullRequestNumber?: number;
  readonly payload: GitHubWritePayload;
}

export interface BoundGitHubWriteIntent {
  readonly requestId: string;
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly operation: GitHubWriteOperation;
  readonly repository: GitHubRepositoryIdentity;
  readonly base: GitHubRefIdentity;
  readonly head: GitHubRefIdentity;
  readonly pullRequestNumber: number | null;
  readonly payload: GitHubWritePayload;
  readonly payloadDigest: string;
  readonly intentDigest: string;
}

export interface GitHubApprovalBinding {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intentDigest: string;
  readonly decision: 'ALLOW_ONCE';
  readonly expiresAt: number;
}

export class GitHubContractError extends Error {
  readonly code: GitHubFailureCode;
  constructor(code: GitHubFailureCode) {
    super(code);
    this.code = code;
  }
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const repositoryPartPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const repositoryIdPattern = /^[A-Za-z0-9][A-Za-z0-9_:=.-]{0,199}$/;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const pathPattern = /^(?!\x2f)(?!.*(?:^|\x2f)\.\.(?:\x2f|$))[\p{L}\p{N}A-Za-z0-9_.@+ \x2f-]{1,1000}$/u;

function fail(code: GitHubFailureCode): never {
  throw new GitHubContractError(code);
}

export function bindGitHubRead(grant: GitHubGrant, request: GitHubReadRequest, now: number): BoundGitHubReadRequest {
  validateGrant(grant, now);
  if (typeof request !== 'object' || request === null || !boundedIdentity(request.requestId)
    || !boundedIdentity(request.projectId) || !boundedIdentity(request.connectorBindingId)
    || !githubReadOperations.includes(request.operation)) fail('INVALID_REQUEST');
  if (request.projectId !== grant.projectId || request.connectorBindingId !== grant.connectorBindingId) fail('UNAUTHORIZED');
  assertRepositoryIdentity(request.repository);
  assertSameRepository(grant.repository, request.repository);
  if (!grant.readOperations.includes(request.operation)) fail('OPERATION_DENIED');
  assertRequiredScopes(grant.tokenScopes, requiredScopesForRead(request.operation));

  if (request.operation === 'github.repository_metadata') {
    if (request.ref !== undefined || request.sha !== undefined || request.pullRequestNumber !== undefined || request.path !== undefined) fail('INVALID_REQUEST');
  } else if (request.operation === 'github.get_ref') {
    if (request.ref === undefined || request.sha !== undefined || request.pullRequestNumber !== undefined || request.path !== undefined) fail('INVALID_REQUEST');
    assertRef(request.ref);
  } else if (request.operation === 'github.get_commit') {
    if (request.sha === undefined || !shaPattern.test(request.sha)
      || request.ref !== undefined || request.pullRequestNumber !== undefined || request.path !== undefined) fail('INVALID_REQUEST');
  } else if (request.operation.startsWith('github.pull_request_')) {
    assertPullRequestNumber(request.pullRequestNumber);
    if (request.ref !== undefined || request.sha !== undefined) fail('INVALID_REQUEST');
    if (request.operation === 'github.pull_request_file') {
      if (request.path === undefined || !pathPattern.test(request.path)) fail('INVALID_REQUEST');
    } else if (request.path !== undefined) fail('INVALID_REQUEST');
  }

  return Object.freeze({
    requestId: request.requestId,
    projectId: request.projectId,
    connectorBindingId: request.connectorBindingId,
    operation: request.operation,
    repository: freezeRepository(request.repository),
    ...(request.ref === undefined ? {} : { ref: request.ref }),
    ...(request.sha === undefined ? {} : { sha: request.sha.toLowerCase() }),
    ...(request.pullRequestNumber === undefined ? {} : { pullRequestNumber: request.pullRequestNumber }),
    ...(request.path === undefined ? {} : { path: request.path }),
  });
}

export function bindGitHubWrite(grant: GitHubGrant, request: GitHubWriteRequest, now: number): BoundGitHubWriteIntent {
  validateGrant(grant, now);
  if (typeof request !== 'object' || request === null || !boundedIdentity(request.requestId)
    || !boundedIdentity(request.projectId) || !boundedIdentity(request.connectorBindingId)
    || !githubWriteOperations.includes(request.operation)) fail('INVALID_REQUEST');
  if (request.projectId !== grant.projectId || request.connectorBindingId !== grant.connectorBindingId) fail('UNAUTHORIZED');
  assertRepositoryIdentity(request.repository);
  assertSameRepository(grant.repository, request.repository);
  if (!grant.writeOperations.includes(request.operation)) fail('OPERATION_DENIED');
  assertRequiredScopes(grant.tokenScopes, ['contents:read', 'pull_requests:write']);

  const base = freezeRef(request.base);
  const head = freezeRef(request.head);
  if (base.ref === head.ref && base.sha === head.sha) fail('INVALID_REQUEST');

  if (request.operation === 'github.create_pull_request' && request.pullRequestNumber !== undefined) fail('INVALID_REQUEST');
  const pullRequestNumber = request.operation === 'github.create_pull_request'
    ? null
    : assertPullRequestNumber(request.pullRequestNumber);

  const payload = freezePayload(request.operation, request.payload);
  const payloadDigest = digest(serializePayload(request.operation, payload));
  const intentDigest = digest(JSON.stringify([
    request.projectId,
    request.connectorBindingId,
    request.repository.repositoryId,
    request.repository.owner,
    request.repository.name,
    base.ref,
    base.sha,
    head.ref,
    head.sha,
    request.operation,
    pullRequestNumber,
    payloadDigest,
  ]));

  return Object.freeze({
    requestId: request.requestId,
    projectId: request.projectId,
    connectorBindingId: request.connectorBindingId,
    operation: request.operation,
    repository: freezeRepository(request.repository),
    base,
    head,
    pullRequestNumber,
    payload,
    payloadDigest,
    intentDigest,
  });
}

export function assertCurrentRepositoryAndRefs(
  intent: BoundGitHubWriteIntent,
  observed: {
    readonly repository: GitHubRepositoryIdentity;
    readonly baseSha: string;
    readonly headSha: string;
  },
): void {
  assertRepositoryIdentity(observed.repository);
  assertSameRepository(intent.repository, observed.repository);
  if (!shaPattern.test(observed.baseSha) || !shaPattern.test(observed.headSha)
    || observed.baseSha.toLowerCase() !== intent.base.sha
    || observed.headSha.toLowerCase() !== intent.head.sha) {
    fail('STALE_REF');
  }
}

/**
 * Synthetic/local acceptance helper only. This Set is not restart-durable and MUST NOT
 * replace IRIS durable owner-approval continuation or action-receipt idempotency.
 */
export class GitHubApprovalReplayGuard {
  private readonly consumed = new Set<string>();

  consume(intent: BoundGitHubWriteIntent, approval: GitHubApprovalBinding, sessionId: string, now: number): void {
    if (!approval || approval.decision !== 'ALLOW_ONCE'
      || !boundedIdentity(approval.approvalId)
      || !boundedIdentity(approval.sessionId)
      || !boundedIdentity(sessionId)
      || typeof approval.intentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(approval.intentDigest)
      || !Number.isSafeInteger(approval.expiresAt) || !Number.isFinite(now)) {
      fail('APPROVAL_REQUIRED');
    }
    if (approval.expiresAt <= now) fail('APPROVAL_STALE');
    if (approval.sessionId !== sessionId || approval.intentDigest !== intent.intentDigest) fail('APPROVAL_MISMATCH');
    if (this.consumed.has(approval.approvalId)) fail('APPROVAL_REPLAY');
    this.consumed.add(approval.approvalId);
  }
}

function validateGrant(grant: GitHubGrant, now: number): void {
  if (!Number.isFinite(now)) fail('INVALID_REQUEST');
  if (typeof grant !== 'object' || grant === null
    || typeof grant.revoked !== 'boolean'
    || typeof grant.expiresAt !== 'string'
    || !boundedIdentity(grant.projectId)
    || !boundedIdentity(grant.connectorBindingId)
    || !boundedOpaqueRef(grant.credentialRef)
    || !boundedOpaqueRef(grant.sessionRef)) fail('POLICY_INVALID');
  if (grant.revoked) fail('REVOKED_AUTH');
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt)) fail('POLICY_INVALID');
  if (expiresAt <= now) fail('EXPIRED_AUTH');
  if (grant.network !== 'allowed') fail('NETWORK_DISABLED');
  assertRepositoryIdentity(grant.repository);
  if (!Array.isArray(grant.readOperations) || !grant.readOperations.every((operation) => githubReadOperations.includes(operation))
    || new Set(grant.readOperations).size !== grant.readOperations.length
    || !Array.isArray(grant.writeOperations) || !grant.writeOperations.every((operation) => githubWriteOperations.includes(operation))
    || new Set(grant.writeOperations).size !== grant.writeOperations.length
    || !Array.isArray(grant.tokenScopes) || grant.tokenScopes.length > 32
    || grant.tokenScopes.some((scope) => typeof scope !== 'string' || scope.length === 0 || scope.length > 100)
    || new Set(grant.tokenScopes).size !== grant.tokenScopes.length) {
    fail('POLICY_INVALID');
  }
  assertExactGrantScopes(grant);
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && requestIdPattern.test(value);
}

function boundedOpaqueRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !value.includes('\0');
}

function assertRequiredScopes(actual: readonly string[], required: readonly string[]): void {
  const scopes = new Set(actual);
  if (required.some((scope) => !scopeSatisfied(scopes, scope))) fail('SCOPE_DENIED');
}

function scopeSatisfied(actual: ReadonlySet<string>, required: string): boolean {
  if (actual.has(required)) return true;
  if (required === 'pull_requests:read' && actual.has('pull_requests:write')) return true;
  return false;
}

function assertExactGrantScopes(grant: GitHubGrant): void {
  const required = new Set<string>();
  for (const operation of grant.readOperations) {
    for (const scope of requiredScopesForRead(operation)) required.add(scope);
  }
  if (grant.writeOperations.length > 0) {
    required.add('contents:read');
    required.add('pull_requests:write');
  }
  if (required.has('pull_requests:write')) required.delete('pull_requests:read');

  const actual = [...grant.tokenScopes].sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((scope, index) => scope !== expected[index])) fail('SCOPE_DENIED');
}

function requiredScopesForRead(operation: GitHubReadOperation): readonly string[] {
  if (operation === 'github.repository_metadata') return [];
  if (operation === 'github.get_ref' || operation === 'github.get_commit') return ['contents:read'];
  if (operation === 'github.pull_request_checks') return ['pull_requests:read', 'checks:read', 'statuses:read'];
  return ['pull_requests:read'];
}

function assertSameRepository(expected: GitHubRepositoryIdentity, actual: GitHubRepositoryIdentity): void {
  if (expected.repositoryId !== actual.repositoryId || expected.owner !== actual.owner || expected.name !== actual.name) {
    fail('REPOSITORY_MISMATCH');
  }
}

function assertRepositoryIdentity(repository: GitHubRepositoryIdentity): void {
  if (typeof repository !== 'object' || repository === null
    || typeof repository.owner !== 'string' || !repositoryPartPattern.test(repository.owner)
    || typeof repository.name !== 'string' || !repositoryPartPattern.test(repository.name)
    || typeof repository.repositoryId !== 'string' || !repositoryIdPattern.test(repository.repositoryId)) fail('INVALID_REQUEST');
}

function freezeRepository(repository: GitHubRepositoryIdentity): GitHubRepositoryIdentity {
  assertRepositoryIdentity(repository);
  return Object.freeze({
    owner: repository.owner,
    name: repository.name,
    repositoryId: repository.repositoryId,
  });
}

function freezeRef(identity: GitHubRefIdentity): GitHubRefIdentity {
  if (!identity || !shaPattern.test(identity.sha)) fail('INVALID_REQUEST');
  assertRef(identity.ref);
  return Object.freeze({ ref: identity.ref, sha: identity.sha.toLowerCase() });
}

function assertRef(ref: string): void {
  const invalidCharacter = typeof ref === 'string' && [...ref].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f
      || character === '~' || character === '^' || character === ':' || character === '?'
      || character === '*' || character === '[' || character === '\\';
  });
  if (typeof ref !== 'string' || ref.length < 'refs/heads/x'.length || ref.length > 300
    || !ref.startsWith('refs/heads/') || ref.endsWith('/') || ref.endsWith('.')
    || ref.includes('..') || ref.includes('//') || invalidCharacter
    || ref.includes('@{')) fail('INVALID_REQUEST');
  const branch = ref.slice('refs/heads/'.length);
  const components = branch.split('/');
  if (branch === '@' || components.some((component) => component.length === 0
    || component.startsWith('.') || component.endsWith('.') || component.endsWith('.lock'))) {
    fail('INVALID_REQUEST');
  }
}

function assertPullRequestNumber(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) fail('INVALID_REQUEST');
  return value;
}

function freezePayload(operation: GitHubWriteOperation, payload: GitHubWritePayload): GitHubWritePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_REQUEST');
  const keys = Object.keys(payload);
  if (operation === 'github.create_pull_request') {
    if (keys.some((key) => !['title', 'body', 'draft'].includes(key)) || keys.length !== 3) fail('INVALID_REQUEST');
    const candidate = payload as { title?: unknown; body?: unknown; draft?: unknown };
    if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0 || candidate.title.length > 256
      || typeof candidate.body !== 'string' || candidate.body.length > 65536
      || typeof candidate.draft !== 'boolean') fail('INVALID_REQUEST');
    return Object.freeze({ title: candidate.title, body: candidate.body, draft: candidate.draft });
  }
  if (operation === 'github.update_pull_request') {
    if (keys.length === 0 || keys.some((key) => !['title', 'body'].includes(key))) fail('INVALID_REQUEST');
    const candidate = payload as { title?: unknown; body?: unknown };
    if (candidate.title !== undefined && (typeof candidate.title !== 'string' || candidate.title.trim().length === 0 || candidate.title.length > 256)) fail('INVALID_REQUEST');
    if (candidate.body !== undefined && (typeof candidate.body !== 'string' || candidate.body.length > 65536)) fail('INVALID_REQUEST');
    return Object.freeze({
      ...(candidate.title === undefined ? {} : { title: candidate.title }),
      ...(candidate.body === undefined ? {} : { body: candidate.body }),
    });
  }
  if (keys.length !== 1 || keys[0] !== 'body') fail('INVALID_REQUEST');
  const candidate = payload as { body?: unknown };
  if (typeof candidate.body !== 'string' || candidate.body.length === 0 || candidate.body.length > 65536) fail('INVALID_REQUEST');
  return Object.freeze({ body: candidate.body });
}

function serializePayload(operation: GitHubWriteOperation, payload: GitHubWritePayload): string {
  if (operation === 'github.create_pull_request') {
    const value = payload as { readonly title: string; readonly body: string; readonly draft: boolean };
    return JSON.stringify([value.title, value.body, value.draft]);
  }
  if (operation === 'github.update_pull_request') {
    const value = payload as { readonly title?: string; readonly body?: string };
    return JSON.stringify([value.title ?? null, value.body ?? null]);
  }
  return JSON.stringify([(payload as { readonly body: string }).body]);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
