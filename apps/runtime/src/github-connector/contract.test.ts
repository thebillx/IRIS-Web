import { describe, expect, it } from 'vitest';
import {
  GitHubApprovalReplayGuard,
  GitHubContractError,
  assertCurrentRepositoryAndRefs,
  bindGitHubRead,
  bindGitHubWrite,
  githubWriteOperations,
  type GitHubGrant,
  type GitHubRepositoryIdentity,
} from './contract.js';

const repository: GitHubRepositoryIdentity = {
  owner: 'thebillx',
  name: 'IRIS-Web',
  repositoryId: 'R_iris_web_1',
};

const grant: GitHubGrant = {
  projectId: 'project-p7',
  connectorBindingId: 'github-binding-1',
  credentialRef: 'secret://github/token',
  sessionRef: 'github-session-1',
  network: 'allowed',
  repository,
  readOperations: [
    'github.repository_metadata',
    'github.get_ref',
    'github.get_commit',
    'github.pull_request_metadata',
    'github.pull_request_checks',
    'github.pull_request_diff',
    'github.pull_request_file',
  ],
  writeOperations: [...githubWriteOperations],
  tokenScopes: ['checks:read', 'contents:read', 'pull_requests:write', 'statuses:read'],
  expiresAt: '2026-10-01T00:00:00.000Z',
  revoked: false,
};

const base = { ref: 'refs/heads/main', sha: '1'.repeat(40) };
const head = { ref: 'refs/heads/feature', sha: '2'.repeat(40) };
const now = Date.parse('2026-09-19T00:00:00.000Z');

function code(fn: () => unknown): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof GitHubContractError ? error.code : String(error);
  }
}

describe('Phase 7 GitHub connector contract', () => {
  it('keeps the initial write surface bounded to PR create/update/comment only', () => {
    expect(githubWriteOperations).toEqual([
      'github.create_pull_request',
      'github.update_pull_request',
      'github.comment_pull_request',
    ]);
    expect(githubWriteOperations.join(' ')).not.toMatch(/merge|delete|secret|setting|admin/i);
  });

  it('binds exact repository identity for read requests without exposing auth references', () => {
    const bound = bindGitHubRead(grant, {
      requestId: 'read-pr-1',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.pull_request_file',
      repository,
      pullRequestNumber: 10,
      path: 'apps/runtime/src/server.ts',
    }, now);
    expect(bound.repository).toEqual(repository);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(JSON.stringify(bound)).not.toContain(grant.credentialRef);
    expect(JSON.stringify(bound)).not.toContain(grant.sessionRef);
  });

  it('rejects name-only or cross-repository substitution even when owner/name look plausible', () => {
    const otherId = { ...repository, repositoryId: 'R_other' };
    expect(code(() => bindGitHubRead(grant, {
      requestId: 'read-pr-2',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.repository_metadata',
      repository: otherId,
    }, now))).toBe('REPOSITORY_MISMATCH');

    const otherRepo = { owner: repository.owner, name: 'IRIS-Web-fork', repositoryId: repository.repositoryId };
    expect(code(() => bindGitHubRead(grant, {
      requestId: 'read-pr-3',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.repository_metadata',
      repository: otherRepo,
    }, now))).toBe('REPOSITORY_MISMATCH');
  });

  it('requires both Checks and Commit statuses read permissions for pull-request checks', () => {
    const underScoped = {
      ...grant,
      tokenScopes: grant.tokenScopes.filter((scope) => scope !== 'statuses:read'),
    };
    expect(code(() => bindGitHubRead(underScoped, {
      requestId: 'read-checks-under-scoped',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.pull_request_checks',
      repository,
      pullRequestNumber: 10,
    }, now))).toBe('SCOPE_DENIED');
  });

  it('binds PR creation to exact repo, base/head SHA, operation and payload digest', () => {
    const intent = bindGitHubWrite(grant, {
      requestId: 'create-pr-1',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base,
      head,
      payload: { title: 'Phase 7', body: 'Browser and GitHub contract', draft: true },
    }, now);
    expect(intent.repository).toEqual(repository);
    expect(intent.base).toEqual(base);
    expect(intent.head).toEqual(head);
    expect(intent.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.intentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(intent)).not.toContain(grant.credentialRef);
    expect(Object.isFrozen(intent.payload)).toBe(true);
  });

  it('changes the approval identity when any exact payload field changes', () => {
    const first = bindGitHubWrite(grant, {
      requestId: 'update-pr-1',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.update_pull_request',
      repository,
      base,
      head,
      pullRequestNumber: 10,
      payload: { title: 'A' },
    }, now);
    const second = bindGitHubWrite(grant, {
      requestId: 'update-pr-2',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.update_pull_request',
      repository,
      base,
      head,
      pullRequestNumber: 10,
      payload: { title: 'B' },
    }, now);
    expect(first.payloadDigest).not.toBe(second.payloadDigest);
    expect(first.intentDigest).not.toBe(second.intentDigest);
  });

  it('fails closed when base/head moved after approval preparation', () => {
    const intent = bindGitHubWrite(grant, {
      requestId: 'comment-pr-1',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.comment_pull_request',
      repository,
      base,
      head,
      pullRequestNumber: 10,
      payload: { body: 'Reviewed' },
    }, now);
    expect(() => assertCurrentRepositoryAndRefs(intent, {
      repository,
      baseSha: base.sha,
      headSha: head.sha,
    })).not.toThrow();
    expect(code(() => assertCurrentRepositoryAndRefs(intent, {
      repository,
      baseSha: '3'.repeat(40),
      headSha: head.sha,
    }))).toBe('STALE_REF');
  });

  it('rejects cross-session, changed-intent and replayed ALLOW_ONCE approvals', () => {
    const intent = bindGitHubWrite(grant, {
      requestId: 'create-pr-approval',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base,
      head,
      payload: { title: 'P7', body: '', draft: false },
    }, now);
    const guard = new GitHubApprovalReplayGuard();
    const approval = {
      approvalId: 'approval-1',
      sessionId: 'owner-session-1',
      intentDigest: intent.intentDigest,
      decision: 'ALLOW_ONCE' as const,
      expiresAt: now + 60_000,
    };
    expect(code(() => guard.consume(intent, approval, 'owner-session-2', now))).toBe('APPROVAL_MISMATCH');
    expect(code(() => guard.consume(intent, { ...approval, intentDigest: 'f'.repeat(64) }, 'owner-session-1', now))).toBe('APPROVAL_MISMATCH');
    expect(() => guard.consume(intent, approval, 'owner-session-1', now)).not.toThrow();
    expect(code(() => guard.consume(intent, approval, 'owner-session-1', now))).toBe('APPROVAL_REPLAY');
  });

  it('requires minimum token scopes and rejects disabled/expired/revoked authority', () => {
    const request = {
      requestId: 'create-pr-scope',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.create_pull_request' as const,
      repository,
      base,
      head,
      payload: { title: 'P7', body: '', draft: false },
    };
    expect(code(() => bindGitHubWrite({ ...grant, tokenScopes: ['contents:read'] }, request, now))).toBe('SCOPE_DENIED');
    expect(code(() => bindGitHubWrite({ ...grant, network: 'disabled' }, request, now))).toBe('NETWORK_DISABLED');
    expect(code(() => bindGitHubWrite({ ...grant, revoked: true }, request, now))).toBe('REVOKED_AUTH');
    expect(code(() => bindGitHubWrite({ ...grant, expiresAt: '2026-09-01T00:00:00.000Z' }, request, now))).toBe('EXPIRED_AUTH');
  });

  it('rejects generic REST/GraphQL-like payload expansion and unsafe refs', () => {
    expect(code(() => bindGitHubWrite(grant, {
      requestId: 'bad-payload',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base,
      head,
      payload: { title: 'P7', body: '', draft: false, endpoint: '/repos/x/y' } as never,
    }, now))).toBe('INVALID_REQUEST');

    expect(code(() => bindGitHubWrite(grant, {
      requestId: 'bad-ref',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base: { ref: 'refs/heads/../main', sha: base.sha },
      head,
      payload: { title: 'P7', body: '', draft: false },
    }, now))).toBe('INVALID_REQUEST');
  });
});
