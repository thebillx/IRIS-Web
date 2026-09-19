import { describe, expect, it } from 'vitest';
import {
  BrowserContractError,
  assertResponsePolicy,
  bindBrowserRequest,
  bindRedirect,
  bindResolution,
  revalidateResolution,
  type BrowserGrant,
} from './browser/contract.js';
import {
  GitHubApprovalReplayGuard,
  GitHubContractError,
  bindGitHubRead,
  bindGitHubWrite,
  githubReadOperations,
  githubWriteOperations,
  type GitHubGrant,
  type GitHubRepositoryIdentity,
} from './github-connector/contract.js';

const now = Date.parse('2026-09-19T00:00:00.000Z');

const browserGrant: BrowserGrant = {
  projectId: 'phase7-project',
  browserBindingId: 'browser-binding',
  sessionRef: 'browser-secret-session-ref',
  network: 'allowed',
  allowedOrigins: ['https://example.com', 'https://cdn.example.com'],
  allowLocalhostHttp: false,
  outputWorkspaceId: 'phase7-workspace' as BrowserGrant['outputWorkspaceId'],
  expiresAt: '2026-10-01T00:00:00.000Z',
  revoked: false,
  limits: {
    maxRedirects: 2,
    maxResponseBytes: 4096,
    maxDecompressionRatio: 20,
    timeoutMs: 5000,
    allowedContentTypes: ['text/html', 'application/json', 'application/octet-stream'],
  },
};

const repository: GitHubRepositoryIdentity = {
  owner: 'thebillx',
  name: 'IRIS-Web',
  repositoryId: 'R_phase7',
};

const githubGrant: GitHubGrant = {
  projectId: 'phase7-project',
  connectorBindingId: 'github-binding',
  credentialRef: 'github-secret-token-ref',
  sessionRef: 'github-secret-session-ref',
  network: 'allowed',
  repository,
  readOperations: [...githubReadOperations],
  writeOperations: [...githubWriteOperations],
  tokenScopes: ['checks:read', 'contents:read', 'pull_requests:write', 'statuses:read'],
  expiresAt: '2026-10-01T00:00:00.000Z',
  revoked: false,
};

const base = { ref: 'refs/heads/main', sha: '1'.repeat(40) };
const head = { ref: 'refs/heads/phase7', sha: '2'.repeat(40) };

function browserCode(fn: () => unknown): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof BrowserContractError ? error.code : String(error);
  }
}

function githubCode(fn: () => unknown): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof GitHubContractError ? error.code : String(error);
  }
}

describe('Phase 7 Browser/GitHub security acceptance', () => {
  it('fails closed on arbitrary URL escape, private resolution, hostile redirect and DNS rebinding', () => {
    const bound = bindBrowserRequest(browserGrant, {
      requestId: 'browser-sec-1',
      projectId: browserGrant.projectId,
      browserBindingId: browserGrant.browserBindingId,
      method: 'GET',
      mode: 'navigate',
      url: 'https://example.com/start',
    }, now);

    expect(browserCode(() => bindBrowserRequest(browserGrant, {
      requestId: 'browser-sec-2',
      projectId: browserGrant.projectId,
      browserBindingId: browserGrant.browserBindingId,
      method: 'GET',
      mode: 'navigate',
      url: 'https://unapproved.example/',
    }, now))).toBe('URL_NOT_ALLOWED');

    expect(browserCode(() => bindResolution(bound, ['169.254.169.254']))).toBe('SSRF_DENIED');
    expect(browserCode(() => bindRedirect(browserGrant, bound, 'https://unapproved.example/redirect', 0, now))).toBe('URL_NOT_ALLOWED');

    const first = bindResolution(bound, ['93.184.216.34']);
    expect(browserCode(() => revalidateResolution(first, ['93.184.216.35']))).toBe('DNS_CHANGED');
    expect(browserCode(() => revalidateResolution(first, ['127.0.0.1']))).toBe('SSRF_DENIED');
  });

  it('keeps browser session/cookie/header authority non-exportable', () => {
    const bound = bindBrowserRequest(browserGrant, {
      requestId: 'browser-sec-session',
      projectId: browserGrant.projectId,
      browserBindingId: browserGrant.browserBindingId,
      method: 'HEAD',
      mode: 'navigate',
      url: 'https://example.com/',
    }, now);
    const serialized = JSON.stringify(bound);
    expect(serialized).not.toContain(browserGrant.sessionRef);
    expect(serialized).not.toMatch(/cookie|authorization|header/i);
    expect(bound).not.toHaveProperty('headers');
    expect(bound).not.toHaveProperty('cookies');
    expect(bound).not.toHaveProperty('sessionRef');
  });

  it('keeps response size/content/decompression bounds server-owned', () => {
    const bound = bindBrowserRequest(browserGrant, {
      requestId: 'browser-sec-limits',
      projectId: browserGrant.projectId,
      browserBindingId: browserGrant.browserBindingId,
      method: 'GET',
      mode: 'download',
      url: 'https://example.com/file',
    }, now);
    expect(browserCode(() => assertResponsePolicy(bound, {
      contentType: 'application/octet-stream',
      compressedBytes: 10,
      decompressedBytes: 401,
      elapsedMs: 1,
    }))).toBe('DECOMPRESSION_LIMIT');
    expect(browserCode(() => assertResponsePolicy(bound, {
      contentType: 'application/octet-stream',
      compressedBytes: 4097,
      decompressedBytes: 4097,
      elapsedMs: 1,
    }))).toBe('RESPONSE_LIMIT');
  });

  it('uses exact GitHub repository identity rather than owner/name alone', () => {
    expect(githubCode(() => bindGitHubRead(githubGrant, {
      requestId: 'gh-sec-repo',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.repository_metadata',
      repository: { ...repository, repositoryId: 'R_substitute' },
    }, now))).toBe('REPOSITORY_MISMATCH');
  });

  it('requires minimum GitHub token scope without exposing credential/session refs', () => {
    const read = bindGitHubRead(githubGrant, {
      requestId: 'gh-sec-read',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.pull_request_metadata',
      repository,
      pullRequestNumber: 10,
    }, now);
    expect(JSON.stringify(read)).not.toContain(githubGrant.credentialRef);
    expect(JSON.stringify(read)).not.toContain(githubGrant.sessionRef);
    expect(githubGrant.tokenScopes).toContain('pull_requests:write');
    expect(githubGrant.tokenScopes).not.toContain('pull_requests:read');

    expect(githubCode(() => bindGitHubRead({
      ...githubGrant,
      tokenScopes: [...githubGrant.tokenScopes, 'pull_requests:read'],
    }, {
      requestId: 'gh-sec-redundant-read-scope',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.pull_request_metadata',
      repository,
      pullRequestNumber: 10,
    }, now))).toBe('SCOPE_DENIED');

    expect(githubCode(() => bindGitHubWrite({ ...githubGrant, tokenScopes: ['contents:read'] }, {
      requestId: 'gh-sec-scope',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base,
      head,
      payload: { title: 'Phase 7', body: '', draft: true },
    }, now))).toBe('SCOPE_DENIED');

    expect(githubCode(() => bindGitHubWrite({
      ...githubGrant,
      tokenScopes: [...githubGrant.tokenScopes, 'issues:write'],
    }, {
      requestId: 'gh-sec-over-scoped',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base,
      head,
      payload: { title: 'Phase 7', body: '', draft: true },
    }, now))).toBe('SCOPE_DENIED');
  });

  it('binds writes to exact payload/ref identity and ALLOW_ONCE owner approval', () => {
    const intent = bindGitHubWrite(githubGrant, {
      requestId: 'gh-sec-write',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base,
      head,
      payload: { title: 'Phase 7', body: 'Exact payload', draft: true },
    }, now);
    const changed = bindGitHubWrite(githubGrant, {
      requestId: 'gh-sec-write-2',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base,
      head,
      payload: { title: 'Phase 7', body: 'Changed payload', draft: true },
    }, now);
    expect(intent.intentDigest).not.toBe(changed.intentDigest);

    const reboundGrant: GitHubGrant = {
      ...githubGrant,
      projectId: 'phase7-project-other',
      connectorBindingId: 'github-binding-other',
    };
    const rebound = bindGitHubWrite(reboundGrant, {
      requestId: 'gh-sec-write-rebound',
      projectId: reboundGrant.projectId,
      connectorBindingId: reboundGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base,
      head,
      payload: { title: 'Phase 7', body: 'Exact payload', draft: true },
    }, now);
    expect(intent.intentDigest).not.toBe(rebound.intentDigest);

    const approvals = new GitHubApprovalReplayGuard();
    const approval = {
      approvalId: 'phase7-approval',
      sessionId: 'owner-session',
      intentDigest: intent.intentDigest,
      decision: 'ALLOW_ONCE' as const,
      expiresAt: now + 60_000,
    };
    expect(githubCode(() => approvals.consume(intent, approval, 'other-session', now))).toBe('APPROVAL_MISMATCH');
    expect(githubCode(() => approvals.consume(changed, approval, 'owner-session', now))).toBe('APPROVAL_MISMATCH');
    expect(() => approvals.consume(intent, approval, 'owner-session', now)).not.toThrow();
    expect(githubCode(() => approvals.consume(intent, approval, 'owner-session', now))).toBe('APPROVAL_REPLAY');
  });

  it('does not expose generic HTTP, REST, GraphQL, merge or repository-admin operations', () => {
    const surface = [...githubReadOperations, ...githubWriteOperations].join(' ');
    expect(surface).not.toMatch(/graphql|generic|http|merge|delete|secret|setting|admin/i);
    expect(githubWriteOperations).toEqual([
      'github.create_pull_request',
      'github.update_pull_request',
      'github.comment_pull_request',
    ]);
  });

  it('returns bounded error codes without echoing credential material', () => {
    try {
      bindGitHubWrite({ ...githubGrant, network: 'disabled' }, {
        requestId: 'gh-sec-error',
        projectId: githubGrant.projectId,
        connectorBindingId: githubGrant.connectorBindingId,
        operation: 'github.create_pull_request',
        repository,
        base,
        head,
        payload: { title: 'Phase 7', body: '', draft: false },
      }, now);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubContractError);
      const serialized = String(error);
      expect(serialized).not.toContain(githubGrant.credentialRef);
      expect(serialized).not.toContain(githubGrant.sessionRef);
    }
  });
});
