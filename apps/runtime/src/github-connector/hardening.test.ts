import { describe, expect, it } from 'vitest';
import {
  GitHubApprovalReplayGuard,
  GitHubContractError,
  bindGitHubRead,
  bindGitHubWrite,
  type GitHubGrant,
  type GitHubRepositoryIdentity,
} from './contract.js';

const repository: GitHubRepositoryIdentity = { owner: 'thebillx', name: 'IRIS-Web', repositoryId: 'R_hardening' };
const grant: GitHubGrant = {
  projectId: 'project-p7',
  connectorBindingId: 'github-binding',
  credentialRef: 'credential-ref',
  sessionRef: 'session-ref',
  network: 'allowed',
  repository,
  readOperations: ['github.repository_metadata', 'github.get_ref', 'github.get_commit', 'github.pull_request_metadata'],
  writeOperations: ['github.create_pull_request'],
  tokenScopes: ['contents:read', 'pull_requests:write'],
  expiresAt: '2026-10-01T00:00:00.000Z',
  revoked: false,
};
const now = Date.parse('2026-09-19T00:00:00.000Z');

function code(fn: () => unknown): string {
  try { fn(); return 'NO_ERROR'; }
  catch (error) { return error instanceof GitHubContractError ? error.code : String(error); }
}

describe('Phase 7 GitHub exact-field hardening', () => {
  it('rejects unused read fields instead of silently carrying generic payload data', () => {
    expect(code(() => bindGitHubRead(grant, {
      requestId: 'read-extra-1',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.repository_metadata',
      repository,
      sha: '1'.repeat(40),
    }, now))).toBe('INVALID_REQUEST');

    expect(code(() => bindGitHubRead(grant, {
      requestId: 'read-extra-2',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.get_ref',
      repository,
      ref: 'refs/heads/main',
      path: 'unexpected',
    }, now))).toBe('INVALID_REQUEST');

    expect(code(() => bindGitHubRead(grant, {
      requestId: 'read-extra-3',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.pull_request_metadata',
      repository,
      pullRequestNumber: 1,
      ref: 'refs/heads/main',
    }, now))).toBe('INVALID_REQUEST');
  });

  it('rejects Git-invalid branch refs before intent hashing', () => {
    for (const ref of [
      'refs/heads/feature//child',
      'refs/heads/.hidden',
      'refs/heads/feature/.hidden',
      'refs/heads/feature.lock',
      'refs/heads/feature/child.lock',
      'refs/heads/feature.',
      'refs/heads/@',
      'refs/heads/feature\u0001child',
    ]) {
      expect(code(() => bindGitHubRead(grant, {
        requestId: 'bad-ref-shape',
        projectId: grant.projectId,
        connectorBindingId: grant.connectorBindingId,
        operation: 'github.get_ref',
        repository,
        ref,
      }, now))).toBe('INVALID_REQUEST');
    }
    expect(() => bindGitHubRead(grant, {
      requestId: 'good-ref-shape',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.get_ref',
      repository,
      ref: 'refs/heads/feature/phase-7',
    }, now)).not.toThrow();
  });

  it('rejects pullRequestNumber on create instead of ignoring it', () => {
    expect(code(() => bindGitHubWrite(grant, {
      requestId: 'create-extra-pr-number',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base: { ref: 'refs/heads/main', sha: '1'.repeat(40) },
      head: { ref: 'refs/heads/feature', sha: '2'.repeat(40) },
      pullRequestNumber: 99,
      payload: { title: 'P7', body: '', draft: true },
    }, now))).toBe('INVALID_REQUEST');
  });
  it('requires Checks(read) specifically for pull_request_checks', () => {
    const request = {
      requestId: 'read-checks-scope',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.pull_request_checks' as const,
      repository,
      pullRequestNumber: 1,
    };
    const underScoped: GitHubGrant = {
      ...grant,
      readOperations: [...grant.readOperations, 'github.pull_request_checks'],
    };
    expect(code(() => bindGitHubRead(underScoped, request, now))).toBe('SCOPE_DENIED');
    expect(() => bindGitHubRead({
      ...underScoped,
      tokenScopes: [...grant.tokenScopes, 'checks:read', 'statuses:read'],
    }, request, now)).not.toThrow();
  });

  it('rejects malformed runtime identities, opaque refs and approval identity before coercion', () => {
    expect(code(() => bindGitHubRead(grant, {
      requestId: undefined as never,
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.repository_metadata',
      repository,
    }, now))).toBe('INVALID_REQUEST');

    expect(code(() => bindGitHubRead({
      ...grant,
      projectId: undefined as never,
    }, {
      requestId: 'malformed-grant-project',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.repository_metadata',
      repository,
    }, now))).toBe('POLICY_INVALID');

    expect(code(() => bindGitHubRead({
      ...grant,
      credentialRef: 'x'.repeat(2049),
    }, {
      requestId: 'oversized-credential-ref',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.repository_metadata',
      repository,
    }, now))).toBe('POLICY_INVALID');

    const intent = bindGitHubWrite(grant, {
      requestId: 'approval-shape-intent',
      projectId: grant.projectId,
      connectorBindingId: grant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base: { ref: 'refs/heads/main', sha: '1'.repeat(40) },
      head: { ref: 'refs/heads/feature', sha: '2'.repeat(40) },
      payload: { title: 'P7', body: '', draft: true },
    }, now);
    const guard = new GitHubApprovalReplayGuard();
    expect(code(() => guard.consume(intent, {
      approvalId: undefined as never,
      sessionId: 'owner-session',
      intentDigest: intent.intentDigest,
      decision: 'ALLOW_ONCE',
      expiresAt: now + 60_000,
    }, 'owner-session', now))).toBe('APPROVAL_REQUIRED');
    expect(code(() => guard.consume(intent, {
      approvalId: 'approval-shape',
      sessionId: 'x'.repeat(201),
      intentDigest: intent.intentDigest,
      decision: 'ALLOW_ONCE',
      expiresAt: now + 60_000,
    }, 'owner-session', now))).toBe('APPROVAL_REQUIRED');
  });

});
