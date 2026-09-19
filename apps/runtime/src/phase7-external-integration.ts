import { createHash } from 'node:crypto';
import type { ArtifactRetentionPolicy, ArtifactSensitivity, JobId, WorkspaceId } from '@iris/domain';
import type { BoundBrowserRequest } from './browser/contract.js';
import {
  assertCurrentRepositoryAndRefs,
  type BoundGitHubWriteIntent,
  type GitHubRepositoryIdentity,
} from './github-connector/contract.js';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const shaPattern = /^[0-9a-f]{64}$/;

function fail(code: string): never {
  throw new Error(code);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedContentType(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) fail('INVALID_CONTENT_TYPE');
  const mediaType = value.split(';', 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) fail('INVALID_CONTENT_TYPE');
  return mediaType;
}

export interface BrowserReadActionPlan {
  readonly missionId: string;
  readonly taskId: string;
  readonly actionId: string;
  readonly jobId: JobId;
  readonly projectId: string;
  readonly browserBindingId: string;
  readonly requestId: string;
  readonly method: BoundBrowserRequest['method'];
  readonly mode: BoundBrowserRequest['mode'];
  readonly outputWorkspaceId: BoundBrowserRequest['outputWorkspaceId'];
  readonly sourceOrigin: string;
  readonly sourceRequestSha256: string;
  readonly expectedEffects: readonly ['READ', 'NETWORK'];
}

export function browserReadActionPlan(
  request: BoundBrowserRequest,
  input: Readonly<{
    missionId: string;
    taskId: string;
    actionId: string;
    jobId: JobId;
  }>,
): BrowserReadActionPlan {
  if (![input.missionId, input.taskId, input.actionId, input.jobId, request.projectId, request.browserBindingId, request.requestId].every(validId)) {
    fail('INVALID_ACTION_IDENTITY');
  }
  const sourceRequestSha256 = digest(new TextEncoder().encode(request.url));
  return Object.freeze({
    missionId: input.missionId,
    taskId: input.taskId,
    actionId: input.actionId,
    jobId: input.jobId,
    projectId: request.projectId,
    browserBindingId: request.browserBindingId,
    requestId: request.requestId,
    method: request.method,
    mode: request.mode,
    outputWorkspaceId: request.outputWorkspaceId,
    sourceOrigin: request.origin,
    sourceRequestSha256,
    expectedEffects: Object.freeze(['READ', 'NETWORK'] as const),
  });
}

export interface BrowserArtifactRegistrationIntent {
  readonly projectId: string;
  readonly workspaceId: WorkspaceId;
  readonly producerJobId: JobId;
  readonly producerActionId: string;
  readonly requestId: string;
  readonly browserBindingId: string;
  readonly sourceOrigin: string;
  readonly sourceRequestSha256: string;
  readonly artifactType: 'browser.document' | 'browser.download';
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly sensitivity: ArtifactSensitivity;
  readonly retentionPolicy: ArtifactRetentionPolicy;
  readonly exportState: 'REVIEW_REQUIRED';
  readonly provenance: Readonly<{
    provider: 'browser';
    requestId: string;
    browserBindingId: string;
    sourceOrigin: string;
    sourceRequestSha256: string;
  }>;
}

export function browserArtifactIntent(
  request: BoundBrowserRequest,
  input: Readonly<{
    bytes: Uint8Array;
    contentType: string;
    action: BrowserReadActionPlan;
  }>,
): BrowserArtifactRegistrationIntent {
  const sourceRequestSha256 = digest(new TextEncoder().encode(request.url));
  const action = input.action;
  if (action.projectId !== request.projectId
    || action.browserBindingId !== request.browserBindingId
    || action.requestId !== request.requestId
    || action.method !== request.method
    || action.mode !== request.mode
    || action.outputWorkspaceId !== request.outputWorkspaceId
    || action.sourceOrigin !== request.origin
    || action.sourceRequestSha256 !== sourceRequestSha256) {
    fail('ACTION_INTENT_MISMATCH');
  }
  if (![action.projectId, action.outputWorkspaceId, action.jobId, action.actionId, request.requestId, request.browserBindingId].every(validId)) {
    fail('INVALID_ARTIFACT_IDENTITY');
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length > request.limits.maxResponseBytes) fail('INVALID_ARTIFACT_SIZE');
  const mime = normalizedContentType(input.contentType);
  if (!request.limits.allowedContentTypes.includes(mime)) fail('CONTENT_TYPE_DENIED');
  const sha256 = digest(input.bytes);
  return Object.freeze({
    projectId: action.projectId,
    workspaceId: action.outputWorkspaceId,
    producerJobId: action.jobId,
    producerActionId: action.actionId,
    requestId: request.requestId,
    browserBindingId: request.browserBindingId,
    sourceOrigin: request.origin,
    sourceRequestSha256,
    artifactType: request.mode === 'download' ? 'browser.download' : 'browser.document',
    mime,
    size: input.bytes.length,
    sha256,
    sensitivity: 'RESTRICTED',
    retentionPolicy: 'EPHEMERAL',
    exportState: 'REVIEW_REQUIRED',
    provenance: Object.freeze({
      provider: 'browser',
      requestId: request.requestId,
      browserBindingId: request.browserBindingId,
      sourceOrigin: request.origin,
      sourceRequestSha256,
    }),
  });
}

export function assertBrowserArtifactBytes(intent: BrowserArtifactRegistrationIntent, bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== intent.size || digest(bytes) !== intent.sha256) fail('SOURCE_CHANGED');
}

export interface GitHubWriteActionPlan {
  readonly missionId: string;
  readonly taskId: string;
  readonly actionId: string;
  readonly approvalId: string;
  readonly projectId: string;
  readonly connectorBindingId: string;
  readonly operation: BoundGitHubWriteIntent['operation'];
  readonly intentDigest: string;
  readonly payloadDigest: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly base: BoundGitHubWriteIntent['base'];
  readonly head: BoundGitHubWriteIntent['head'];
  readonly pullRequestNumber: number | null;
  readonly expectedEffects: readonly ['READ', 'WRITE', 'NETWORK'];
  readonly approvalMode: 'ALLOW_ONCE';
}

export function githubWriteActionPlan(
  intent: BoundGitHubWriteIntent,
  input: Readonly<{
    missionId: string;
    taskId: string;
    actionId: string;
    approvalId: string;
  }>,
): GitHubWriteActionPlan {
  if (![input.missionId, input.taskId, input.actionId, input.approvalId, intent.projectId, intent.connectorBindingId].every(validId)
    || !shaPattern.test(intent.intentDigest) || !shaPattern.test(intent.payloadDigest)) fail('INVALID_ACTION_IDENTITY');
  return Object.freeze({
    missionId: input.missionId,
    taskId: input.taskId,
    actionId: input.actionId,
    approvalId: input.approvalId,
    projectId: intent.projectId,
    connectorBindingId: intent.connectorBindingId,
    operation: intent.operation,
    intentDigest: intent.intentDigest,
    payloadDigest: intent.payloadDigest,
    repository: Object.freeze({ ...intent.repository }),
    base: Object.freeze({ ...intent.base }),
    head: Object.freeze({ ...intent.head }),
    pullRequestNumber: intent.pullRequestNumber,
    expectedEffects: Object.freeze(['READ', 'WRITE', 'NETWORK'] as const),
    approvalMode: 'ALLOW_ONCE',
  });
}

/**
 * Synthetic/local acceptance helper only. Duplicate production mutations must be fenced
 * by durable mission/action/provider idempotency rather than this in-memory Set.
 */
export class GitHubMutationLedger {
  private readonly completedIntentDigests = new Set<string>();

  record(intent: BoundGitHubWriteIntent): void {
    if (!shaPattern.test(intent.intentDigest)) fail('INVALID_ACTION_IDENTITY');
    if (this.completedIntentDigests.has(intent.intentDigest)) fail('DUPLICATE_MUTATION');
    this.completedIntentDigests.add(intent.intentDigest);
  }

  has(intentDigest: string): boolean {
    return this.completedIntentDigests.has(intentDigest);
  }
}

export interface GitHubMutationReceipt {
  readonly missionId: string;
  readonly taskId: string;
  readonly actionId: string;
  readonly approvalId: string;
  readonly operation: GitHubWriteActionPlan['operation'];
  readonly repository: GitHubRepositoryIdentity;
  readonly baseSha: string;
  readonly headSha: string;
  readonly payloadDigest: string;
  readonly intentDigest: string;
  readonly pullRequestNumber: number | null;
  readonly providerResultId: string;
  readonly effects: readonly ['READ', 'WRITE', 'NETWORK'];
}

export function githubMutationReceipt(
  plan: GitHubWriteActionPlan,
  intent: BoundGitHubWriteIntent,
  observed: Readonly<{
    repository: GitHubRepositoryIdentity;
    baseSha: string;
    headSha: string;
    pullRequestNumber: number | null;
    providerResultId: string;
  }>,
): GitHubMutationReceipt {
  if (plan.intentDigest !== intent.intentDigest || plan.payloadDigest !== intent.payloadDigest
    || plan.projectId !== intent.projectId || plan.connectorBindingId !== intent.connectorBindingId) fail('ACTION_INTENT_MISMATCH');
  assertCurrentRepositoryAndRefs(intent, {
    repository: observed.repository,
    baseSha: observed.baseSha,
    headSha: observed.headSha,
  });
  if (!validId(observed.providerResultId)) fail('INVALID_PROVIDER_RESULT');
  if (intent.operation === 'github.create_pull_request') {
    if (!Number.isSafeInteger(observed.pullRequestNumber) || observed.pullRequestNumber === null || observed.pullRequestNumber <= 0) {
      fail('INVALID_PROVIDER_RESULT');
    }
  } else if (observed.pullRequestNumber !== intent.pullRequestNumber) {
    fail('INVALID_PROVIDER_RESULT');
  }
  return Object.freeze({
    missionId: plan.missionId,
    taskId: plan.taskId,
    actionId: plan.actionId,
    approvalId: plan.approvalId,
    operation: plan.operation,
    repository: Object.freeze({ ...observed.repository }),
    baseSha: observed.baseSha.toLowerCase(),
    headSha: observed.headSha.toLowerCase(),
    payloadDigest: plan.payloadDigest,
    intentDigest: plan.intentDigest,
    pullRequestNumber: observed.pullRequestNumber,
    providerResultId: observed.providerResultId,
    effects: plan.expectedEffects,
  });
}
