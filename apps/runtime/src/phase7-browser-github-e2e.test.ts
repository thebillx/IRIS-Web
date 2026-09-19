import { describe, expect, it } from 'vitest';
import type { JobId } from '@iris/domain';
import {
  BrowserContractError,
  assertResponsePolicy,
  bindBrowserRequest,
  bindRedirect,
  bindResolution,
  type BrowserGrant,
} from './browser/contract.js';
import {
  GitHubApprovalReplayGuard,
  GitHubContractError,
  bindGitHubWrite,
  type GitHubGrant,
  type GitHubRepositoryIdentity,
} from './github-connector/contract.js';
import {
  GitHubMutationLedger,
  assertBrowserArtifactBytes,
  browserArtifactIntent,
  browserReadActionPlan,
  githubMutationReceipt,
  githubWriteActionPlan,
} from './phase7-external-integration.js';

const now = Date.parse('2026-09-19T00:00:00.000Z');

const browserGrant: BrowserGrant = {
  projectId: 'phase7-project',
  browserBindingId: 'browser-binding-e2e',
  sessionRef: 'BROWSER_SESSION_SECRET_DO_NOT_EXPORT',
  network: 'allowed',
  allowedOrigins: ['https://example.com', 'https://127.0.0.1'],
  allowLocalhostHttp: false,
  outputWorkspaceId: 'phase7-workspace' as BrowserGrant['outputWorkspaceId'],
  expiresAt: '2026-10-01T00:00:00.000Z',
  revoked: false,
  limits: {
    maxRedirects: 2,
    maxResponseBytes: 8192,
    maxDecompressionRatio: 20,
    timeoutMs: 5000,
    allowedContentTypes: ['text/html', 'application/octet-stream'],
  },
};

const repository: GitHubRepositoryIdentity = {
  owner: 'thebillx',
  name: 'IRIS-Web',
  repositoryId: 'R_phase7_e2e',
};

const githubGrant: GitHubGrant = {
  projectId: browserGrant.projectId,
  connectorBindingId: 'github-binding-e2e',
  credentialRef: 'GITHUB_TOKEN_SECRET_DO_NOT_EXPORT',
  sessionRef: 'GITHUB_SESSION_SECRET_DO_NOT_EXPORT',
  network: 'allowed',
  repository,
  readOperations: ['github.repository_metadata', 'github.get_ref', 'github.get_commit', 'github.pull_request_metadata'],
  writeOperations: ['github.create_pull_request'],
  tokenScopes: ['contents:read', 'pull_requests:write'],
  expiresAt: '2026-10-01T00:00:00.000Z',
  revoked: false,
};

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

describe('Phase 7 synthetic Browser -> GitHub E2E', () => {
  it('produces one deterministic no-production-write receipt from bounded browser evidence to approved PR intent', () => {
    const browser = bindBrowserRequest(browserGrant, {
      requestId: 'browser-e2e-1',
      projectId: browserGrant.projectId,
      browserBindingId: browserGrant.browserBindingId,
      method: 'GET',
      mode: 'download',
      url: 'https://example.com/evidence',
    }, now);

    const resolution = bindResolution(browser, ['93.184.216.34']);
    expect(resolution.addresses).toEqual(['93.184.216.34']);

    const browserAction = browserReadActionPlan(browser, {
      missionId: 'mission-e2e-1',
      taskId: 'browser-task-e2e-1',
      actionId: 'browser-action-e2e-1',
      jobId: 'browser-job-e2e-1' as JobId,
    });
    expect(browserAction.expectedEffects).toEqual(['READ', 'NETWORK']);

    const bytes = new TextEncoder().encode('phase7 deterministic browser evidence v1');
    assertResponsePolicy(browser, {
      contentType: 'application/octet-stream',
      compressedBytes: bytes.length,
      decompressedBytes: bytes.length,
      elapsedMs: 20,
    });

    const artifact = browserArtifactIntent(browser, {
      bytes,
      contentType: 'application/octet-stream',
      action: browserAction,
    });
    assertBrowserArtifactBytes(artifact, bytes);

    const base = { ref: 'refs/heads/main', sha: '1'.repeat(40) };
    const head = { ref: 'refs/heads/phase7-e2e', sha: '2'.repeat(40) };
    const githubIntent = bindGitHubWrite(githubGrant, {
      requestId: 'github-e2e-1',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base,
      head,
      payload: {
        title: 'Synthetic Phase 7 PR',
        body: `Source artifact SHA-256: ${artifact.sha256}`,
        draft: true,
      },
    }, now);

    const approvals = new GitHubApprovalReplayGuard();
    const approval = {
      approvalId: 'approval-e2e-1',
      sessionId: 'owner-session-e2e',
      intentDigest: githubIntent.intentDigest,
      decision: 'ALLOW_ONCE' as const,
      expiresAt: now + 60_000,
    };
    approvals.consume(githubIntent, approval, 'owner-session-e2e', now);

    const action = githubWriteActionPlan(githubIntent, {
      missionId: 'mission-e2e-1',
      taskId: 'task-e2e-1',
      actionId: 'action-e2e-1',
      approvalId: approval.approvalId,
    });

    const mutations = new GitHubMutationLedger();
    mutations.record(githubIntent);

    const receipt = githubMutationReceipt(action, githubIntent, {
      repository,
      baseSha: base.sha,
      headSha: head.sha,
      pullRequestNumber: 77,
      providerResultId: 'synthetic-github-result-77',
    });

    expect(receipt).toMatchObject({
      missionId: 'mission-e2e-1',
      actionId: 'action-e2e-1',
      operation: 'github.create_pull_request',
      pullRequestNumber: 77,
      payloadDigest: githubIntent.payloadDigest,
      intentDigest: githubIntent.intentDigest,
    });
    expect(receipt.effects).toEqual(['READ', 'WRITE', 'NETWORK']);
    expect(artifact.provenance.sourceOrigin).toBe(browser.origin);
    expect(artifact.provenance.sourceRequestSha256).toMatch(/^[0-9a-f]{64}$/);

    const exported = JSON.stringify({ browserAction, artifact, githubIntent, action, receipt });
    expect(exported).not.toContain(browserGrant.sessionRef);
    expect(exported).not.toContain(githubGrant.credentialRef);
    expect(exported).not.toContain(githubGrant.sessionRef);
    expect(exported).not.toMatch(/authorization|cookie/i);
  });

  it('negative: redirect to a private address fails before acquisition', () => {
    const browser = bindBrowserRequest(browserGrant, {
      requestId: 'browser-e2e-private',
      projectId: browserGrant.projectId,
      browserBindingId: browserGrant.browserBindingId,
      method: 'GET',
      mode: 'navigate',
      url: 'https://example.com/',
    }, now);
    expect(browserCode(() => bindRedirect(browserGrant, browser, 'https://127.0.0.1/metadata', 0, now))).toBe('SSRF_DENIED');
  });

  it('negative: changed browser source bytes fail the artifact hash binding', () => {
    const browser = bindBrowserRequest(browserGrant, {
      requestId: 'browser-e2e-changed',
      projectId: browserGrant.projectId,
      browserBindingId: browserGrant.browserBindingId,
      method: 'GET',
      mode: 'download',
      url: 'https://example.com/evidence',
    }, now);
    const browserAction = browserReadActionPlan(browser, {
      missionId: 'mission-e2e-changed',
      taskId: 'browser-task-e2e-changed',
      actionId: 'browser-operation-e2e-changed',
      jobId: 'browser-job-e2e-changed' as JobId,
    });
    const original = new TextEncoder().encode('original');
    const artifact = browserArtifactIntent(browser, {
      bytes: original,
      contentType: 'application/octet-stream',
      action: browserAction,
    });
    expect(() => assertBrowserArtifactBytes(artifact, new TextEncoder().encode('changed'))).toThrow('SOURCE_CHANGED');
  });

  it('negative: moved base/head SHA fails receipt finalization', () => {
    const intent = bindGitHubWrite(githubGrant, {
      requestId: 'github-e2e-stale-ref',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base: { ref: 'refs/heads/main', sha: '1'.repeat(40) },
      head: { ref: 'refs/heads/phase7', sha: '2'.repeat(40) },
      payload: { title: 'P7', body: '', draft: true },
    }, now);
    const action = githubWriteActionPlan(intent, {
      missionId: 'mission-stale', taskId: 'task-stale', actionId: 'action-stale', approvalId: 'approval-stale-ref',
    });
    expect(() => githubMutationReceipt(action, intent, {
      repository,
      baseSha: '3'.repeat(40),
      headSha: intent.head.sha,
      pullRequestNumber: 88,
      providerResultId: 'result-stale',
    })).toThrow('STALE_REF');
  });

  it('negative: repository substitution fails closed', () => {
    expect(githubCode(() => bindGitHubWrite(githubGrant, {
      requestId: 'github-e2e-substitute',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository: { ...repository, repositoryId: 'R_substituted' },
      base: { ref: 'refs/heads/main', sha: '1'.repeat(40) },
      head: { ref: 'refs/heads/phase7', sha: '2'.repeat(40) },
      payload: { title: 'P7', body: '', draft: true },
    }, now))).toBe('REPOSITORY_MISMATCH');
  });

  it('negative: stale approval and duplicate PR create are both rejected', () => {
    const intent = bindGitHubWrite(githubGrant, {
      requestId: 'github-e2e-replay-1',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base: { ref: 'refs/heads/main', sha: '1'.repeat(40) },
      head: { ref: 'refs/heads/phase7', sha: '2'.repeat(40) },
      payload: { title: 'P7', body: '', draft: false },
    }, now);
    const approvals = new GitHubApprovalReplayGuard();
    expect(githubCode(() => approvals.consume(intent, {
      approvalId: 'expired-approval',
      sessionId: 'owner',
      intentDigest: intent.intentDigest,
      decision: 'ALLOW_ONCE',
      expiresAt: now - 1,
    }, 'owner', now))).toBe('APPROVAL_STALE');

    const duplicate = bindGitHubWrite(githubGrant, {
      requestId: 'github-e2e-replay-2',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base: { ref: 'refs/heads/main', sha: '1'.repeat(40) },
      head: { ref: 'refs/heads/phase7', sha: '2'.repeat(40) },
      payload: { title: 'P7', body: '', draft: false },
    }, now);
    expect(duplicate.intentDigest).toBe(intent.intentDigest);
    const ledger = new GitHubMutationLedger();
    ledger.record(intent);
    expect(() => ledger.record(duplicate)).toThrow('DUPLICATE_MUTATION');
  });
});
