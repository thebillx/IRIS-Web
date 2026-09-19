import { describe, expect, it } from 'vitest';
import type { JobId } from '@iris/domain';
import { bindBrowserRequest, type BrowserGrant } from './browser/contract.js';
import { bindGitHubWrite, type GitHubGrant, type GitHubRepositoryIdentity } from './github-connector/contract.js';
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
  browserBindingId: 'browser-binding',
  sessionRef: 'browser-session-secret',
  network: 'allowed',
  allowedOrigins: ['https://example.com'],
  allowLocalhostHttp: false,
  outputWorkspaceId: 'phase7-workspace' as BrowserGrant['outputWorkspaceId'],
  expiresAt: '2026-10-01T00:00:00.000Z',
  revoked: false,
  limits: {
    maxRedirects: 2,
    maxResponseBytes: 1024,
    maxDecompressionRatio: 10,
    timeoutMs: 5000,
    allowedContentTypes: ['text/html', 'application/octet-stream'],
  },
};

const repository: GitHubRepositoryIdentity = { owner: 'thebillx', name: 'IRIS-Web', repositoryId: 'R_phase7' };
const githubGrant: GitHubGrant = {
  projectId: 'phase7-project',
  connectorBindingId: 'github-binding',
  credentialRef: 'github-secret-ref',
  sessionRef: 'github-session-secret',
  network: 'allowed',
  repository,
  readOperations: ['github.repository_metadata'],
  writeOperations: ['github.create_pull_request', 'github.update_pull_request', 'github.comment_pull_request'],
  tokenScopes: ['contents:read', 'pull_requests:write'],
  expiresAt: '2026-10-01T00:00:00.000Z',
  revoked: false,
};

describe('Phase 7 external platform integration', () => {
  it('maps browser output to a restricted hash/size-bound artifact intent with job/action identity', () => {
    const request = bindBrowserRequest(browserGrant, {
      requestId: 'browser-integration-1',
      projectId: browserGrant.projectId,
      browserBindingId: browserGrant.browserBindingId,
      method: 'GET',
      mode: 'download',
      url: 'https://example.com/file',
    }, now);
    const action = browserReadActionPlan(request, {
      missionId: 'mission-browser-1',
      taskId: 'task-browser-1',
      actionId: 'browser-operation-1',
      jobId: 'browser-job-1' as JobId,
    });
    expect(action.expectedEffects).toEqual(['READ', 'NETWORK']);
    expect(action.sourceOrigin).toBe('https://example.com');
    expect(action.sourceRequestSha256).toMatch(/^[0-9a-f]{64}$/);
    const bytes = new TextEncoder().encode('bounded browser evidence');
    const intent = browserArtifactIntent(request, {
      bytes,
      contentType: 'application/octet-stream',
      action,
    });
    expect(intent.size).toBe(bytes.length);
    expect(intent.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.sensitivity).toBe('RESTRICTED');
    expect(intent.retentionPolicy).toBe('EPHEMERAL');
    expect(intent.exportState).toBe('REVIEW_REQUIRED');
    expect(intent).not.toHaveProperty('path');
    expect(JSON.stringify(intent)).not.toContain(browserGrant.sessionRef);
    expect(() => assertBrowserArtifactBytes(intent, bytes)).not.toThrow();
    expect(() => assertBrowserArtifactBytes(intent, new TextEncoder().encode('changed'))).toThrow('SOURCE_CHANGED');
  });

  it('keeps secret-bearing URL path/query material out of artifact metadata while preserving a request digest', () => {
    const marker = 'SIGNED_VALUE_MUST_NOT_LEAK';
    const request = bindBrowserRequest(browserGrant, {
      requestId: 'browser-integration-secret-url',
      projectId: browserGrant.projectId,
      browserBindingId: browserGrant.browserBindingId,
      method: 'GET',
      mode: 'download',
      url: `https://example.com/private/${marker}?token=${marker}`,
    }, now);
    const action = browserReadActionPlan(request, {
      missionId: 'mission-browser-secret-url',
      taskId: 'task-browser-secret-url',
      actionId: 'browser-operation-secret-url',
      jobId: 'browser-job-secret-url' as JobId,
    });
    const bytes = new TextEncoder().encode('safe evidence');
    const intent = browserArtifactIntent(request, {
      bytes,
      contentType: 'application/octet-stream',
      action,
    });
    const serialized = JSON.stringify({ action, intent });
    expect(serialized).not.toContain(marker);
    expect(action.sourceOrigin).toBe('https://example.com');
    expect(action.sourceRequestSha256).toBe(intent.sourceRequestSha256);
    expect(intent.sourceRequestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.provenance.sourceRequestSha256).toBe(intent.sourceRequestSha256);
  });

  it('rejects cross-project/workspace artifact publication and oversized bytes', () => {
    const request = bindBrowserRequest(browserGrant, {
      requestId: 'browser-integration-2',
      projectId: browserGrant.projectId,
      browserBindingId: browserGrant.browserBindingId,
      method: 'GET',
      mode: 'download',
      url: 'https://example.com/file',
    }, now);
    const action = browserReadActionPlan(request, {
      missionId: 'mission-browser-2',
      taskId: 'task-browser-2',
      actionId: 'browser-operation-2',
      jobId: 'browser-job-2' as JobId,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(() => browserArtifactIntent(request, {
      bytes,
      contentType: 'application/octet-stream',
      action: { ...action, projectId: 'other-project' },
    })).toThrow('ACTION_INTENT_MISMATCH');
    expect(() => browserArtifactIntent(request, {
      bytes,
      contentType: 'application/octet-stream',
      action: { ...action, outputWorkspaceId: 'other-workspace' as BrowserGrant['outputWorkspaceId'] },
    })).toThrow('ACTION_INTENT_MISMATCH');
    expect(() => browserArtifactIntent(request, {
      bytes: new Uint8Array(1025),
      contentType: 'application/octet-stream',
      action,
    })).toThrow('INVALID_ARTIFACT_SIZE');

    const otherRequest = bindBrowserRequest(browserGrant, {
      requestId: 'browser-integration-other-request',
      projectId: browserGrant.projectId,
      browserBindingId: browserGrant.browserBindingId,
      method: 'GET',
      mode: 'download',
      url: 'https://example.com/other-file',
    }, now);
    const otherAction = browserReadActionPlan(otherRequest, {
      missionId: 'mission-browser-other',
      taskId: 'task-browser-other',
      actionId: 'browser-operation-other',
      jobId: 'browser-job-other' as JobId,
    });
    expect(() => browserArtifactIntent(request, {
      bytes,
      contentType: 'application/octet-stream',
      action: otherAction,
    })).toThrow('ACTION_INTENT_MISMATCH');
  });

  it('maps GitHub write intent to mission/action identity with separately derived NETWORK and WRITE effects', () => {
    const intent = bindGitHubWrite(githubGrant, {
      requestId: 'github-integration-1',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base: { ref: 'refs/heads/main', sha: '1'.repeat(40) },
      head: { ref: 'refs/heads/phase7', sha: '2'.repeat(40) },
      payload: { title: 'Phase 7', body: 'Synthetic', draft: true },
    }, now);
    const plan = githubWriteActionPlan(intent, {
      missionId: 'mission-1',
      taskId: 'task-1',
      actionId: 'action-1',
      approvalId: 'approval-1',
    });
    expect(plan.approvalMode).toBe('ALLOW_ONCE');
    expect(plan.expectedEffects).toEqual(['READ', 'WRITE', 'NETWORK']);
    expect(plan.intentDigest).toBe(intent.intentDigest);
    expect(JSON.stringify(plan)).not.toContain(githubGrant.credentialRef);
    expect(JSON.stringify(plan)).not.toContain(githubGrant.sessionRef);
  });

  it('produces an audit receipt only when repo and ref identities still match', () => {
    const intent = bindGitHubWrite(githubGrant, {
      requestId: 'github-integration-2',
      projectId: githubGrant.projectId,
      connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request',
      repository,
      base: { ref: 'refs/heads/main', sha: '1'.repeat(40) },
      head: { ref: 'refs/heads/phase7', sha: '2'.repeat(40) },
      payload: { title: 'Phase 7', body: '', draft: false },
    }, now);
    const plan = githubWriteActionPlan(intent, {
      missionId: 'mission-2', taskId: 'task-2', actionId: 'action-2', approvalId: 'approval-2',
    });
    const receipt = githubMutationReceipt(plan, intent, {
      repository,
      baseSha: intent.base.sha,
      headSha: intent.head.sha,
      pullRequestNumber: 11,
      providerResultId: 'github-result-11',
    });
    expect(receipt.pullRequestNumber).toBe(11);
    expect(receipt.effects).toEqual(['READ', 'WRITE', 'NETWORK']);
    expect(() => githubMutationReceipt(plan, intent, {
      repository,
      baseSha: '3'.repeat(40),
      headSha: intent.head.sha,
      pullRequestNumber: 11,
      providerResultId: 'github-result-11',
    })).toThrow('STALE_REF');
  });

  it('rejects duplicate/replayed external mutation intents independent of request id', () => {
    const first = bindGitHubWrite(githubGrant, {
      requestId: 'github-replay-1', projectId: githubGrant.projectId, connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request', repository,
      base: { ref: 'refs/heads/main', sha: '1'.repeat(40) },
      head: { ref: 'refs/heads/phase7', sha: '2'.repeat(40) },
      payload: { title: 'Phase 7', body: '', draft: false },
    }, now);
    const second = bindGitHubWrite(githubGrant, {
      requestId: 'github-replay-2', projectId: githubGrant.projectId, connectorBindingId: githubGrant.connectorBindingId,
      operation: 'github.create_pull_request', repository,
      base: { ref: 'refs/heads/main', sha: '1'.repeat(40) },
      head: { ref: 'refs/heads/phase7', sha: '2'.repeat(40) },
      payload: { title: 'Phase 7', body: '', draft: false },
    }, now);
    expect(first.intentDigest).toBe(second.intentDigest);
    const ledger = new GitHubMutationLedger();
    ledger.record(first);
    expect(ledger.has(first.intentDigest)).toBe(true);
    expect(() => ledger.record(second)).toThrow('DUPLICATE_MUTATION');
  });
});
