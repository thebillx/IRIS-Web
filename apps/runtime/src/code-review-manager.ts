import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type CapabilityEffect, type MissionEvidence, type MissionExecutionAssociation } from '@iris/domain';
import { parseNativeCodeReviewOutput } from './code-review-contract.js';
import { TRUSTED_CODE_REVIEW_PROFILE_SHA256 } from './code-review-policy.js';
import type { ReviewLaunchSpec } from './code-review-launch.js';
import { DurableJobManager, type CodeReviewBinding } from './durable-job-manager.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { codeReviewExecutionEffects, resolveCodeReviewRunnerPath } from './execution-profiles.js';
import type { RuntimeState } from './state.js';
const REVIEW_EFFECTS = codeReviewExecutionEffects();
const MAX_REVIEW_CONTEXT_BYTES = 256 * 1024;

export interface CodeReviewStartInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly contextArtifactId: string;
  readonly requestId: string;
}

export interface CodeReviewStatusInput {
  readonly projectId: string;
  readonly jobId: string;
}

export interface CodeReviewResultInput {
  readonly projectId: string;
  readonly jobId: string;
  readonly clientId: string;
  readonly sessionId: string;
}


export class CodeReviewManager {
  public constructor(
    private readonly state: RuntimeState,
    private readonly resources: VNextResourceRegistry,
    private readonly jobs: DurableJobManager,
  ) {}

  public async start(input: CodeReviewStartInput, mission: MissionExecutionAssociation): Promise<Record<string, unknown>> {
    const workspace = await this.resources.getActiveWorkspace(input.projectId, input.workspaceId);
    if (workspace.role !== 'PRIMARY' && workspace.role !== 'WORKTREE') {
      throw new RuntimeError('CAPABILITY_DENIED', 'Native code review requires an ACTIVE PRIMARY or WORKTREE workspace');
    }
    const contextArtifact = await this.resources.getArtifact(input.projectId, input.contextArtifactId);
    if (contextArtifact.artifactType !== 'local-native-review-context') {
      throw new RuntimeError('CAPABILITY_DENIED', 'Review context artifact type is not authorized for native code review');
    }
    if (contextArtifact.mime !== 'text/markdown' && contextArtifact.mime !== 'text/plain' && contextArtifact.mime !== 'text/plain; charset=utf-8') {
      throw new RuntimeError('CAPABILITY_DENIED', 'Review context artifact must be UTF-8 text or Markdown');
    }
    if (contextArtifact.size < 1 || contextArtifact.size > MAX_REVIEW_CONTEXT_BYTES) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Review context artifact exceeds the bounded native-review size');
    }

    const contextBytes = await readFile(contextArtifact.physicalPath);
    if (contextBytes.byteLength !== contextArtifact.size
      || createHash('sha256').update(contextBytes).digest('hex') !== contextArtifact.sha256) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Review context artifact bytes no longer match the registered identity');
    }
    const context = contextBytes.toString('utf8').trim();
    if (context.length === 0 || context.includes('\0')) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Review context artifact is not valid bounded UTF-8 review context');
    }
    const reviewContextSha256 = createHash('sha256').update(context).digest('hex');

    const repository = await this.resources.verifiedRepositoryForWorkspace(input.projectId, input.workspaceId);
    const repositoryIdentity = repository === null
      ? null
      : {
          root: repository.commonGitDir,
          device: repository.commonGitDirDevice,
          inode: repository.commonGitDirInode,
        };
    const gitMetadataRead = repositoryIdentity !== null && !pathIsWithin(workspace.physicalRoot, repositoryIdentity.root);
    const reviewerProfileSha256 = await reviewerProfileIdentity(workspace.physicalRoot);
    const workspaceSha256 = createHash('sha256').update(workspace.physicalRoot).digest('hex');
    const launchSpec: ReviewLaunchSpec = {
      schemaVersion: 1,
      workspaceRoot: workspace.physicalRoot,
      context,
      contextSha256: reviewContextSha256,
      reviewerProfileSha256,
      gitMetadata: repositoryIdentity,
    };
    const launchBytes = Buffer.from(JSON.stringify(launchSpec), 'utf8');
    const repositoryIdentitySha256 = createHash('sha256').update(JSON.stringify(repositoryIdentity)).digest('hex');
    const binding: CodeReviewBinding = {
      contextArtifactId: input.contextArtifactId,
      contextArtifactSha256: contextArtifact.sha256,
      contextSha256: reviewContextSha256,
      workspaceSha256,
      reviewerProfileSha256,
      repositoryIdentity,
      repositoryIdentitySha256,
    };

    const prepared = await this.jobs.prepareServerOwnedCodeReview({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      executable: 'node',
      argv: [await resolveCodeReviewRunnerPath()],
      cwd: '.',
      executionProfile: 'codex-review',
      envOverrides: {},
      timeoutMs: 30 * 60_000,
    }, launchBytes, binding);
    const started = await this.jobs.start(prepared, input.requestId, REVIEW_EFFECTS, mission);
    return {
      ...started,
      reviewer: 'Ponytail/code_review',
      contextArtifactId: input.contextArtifactId,
      contextArtifactSha256: contextArtifact.sha256,
      contextSha256: reviewContextSha256,
      launchSpecSha256: prepared.stdinArtifactSha256,
      gitMetadataRead,
      reviewDecision: null,
      terminalReceipt: null,
    };
  }

  public async status(input: CodeReviewStatusInput): Promise<Record<string, unknown>> {
    const snapshot = await this.jobs.codeReviewStatusSnapshot(input.projectId, input.jobId);
    if (snapshot.state === 'QUEUED' || snapshot.state === 'RUNNING') {
      return {
        jobId: snapshot.jobId,
        state: snapshot.state,
        workspaceId: snapshot.workspaceId,
        reviewDecision: null,
        terminalReceipt: null,
      };
    }
    if (snapshot.state !== 'SUCCEEDED' || snapshot.exitCode !== 0 || snapshot.timedOut || !snapshot.terminalReady) {
      return {
        jobId: snapshot.jobId,
        state: snapshot.state,
        workspaceId: snapshot.workspaceId,
        reviewDecision: null,
        terminalReceipt: null,
        terminalValid: false,
      };
    }
    return {
      jobId: snapshot.jobId,
      state: snapshot.state,
      workspaceId: snapshot.workspaceId,
      terminalReady: true,
      terminalValid: true,
      reviewDecision: null,
      terminalReceipt: null,
    };
  }

  public async result(input: CodeReviewResultInput): Promise<Record<string, unknown>> {
    const snapshot = await this.jobs.codeReviewResultSnapshot(input.projectId, input.jobId);
    if (snapshot.state === 'QUEUED' || snapshot.state === 'RUNNING') {
      throw new RuntimeError('PRECONDITION_FAILED', 'Native code review job is not terminal yet');
    }
    if (snapshot.missionId === null || snapshot.taskId === null || snapshot.actionId === null) {
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Native code review job is missing its mission action binding');
    }
    const mission = await this.state.getMission(snapshot.missionId);
    if (mission.clientId !== input.clientId || mission.sessionId !== input.sessionId || mission.projectId !== input.projectId) {
      throw new RuntimeError('CONTROL_DENIED', 'Native code review result belongs to a different mission/session binding');
    }

    if (snapshot.state !== 'SUCCEEDED' || snapshot.exitCode !== 0 || snapshot.timedOut) {
      if (snapshot.reviewBinding === null) {
        throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Native code review failure is missing its expected identity binding');
      }
      const binding = snapshot.reviewBinding;
      const evidence: MissionEvidence = {
        id: randomUUID(),
        kind: 'AUDIT',
        label: 'code_review.failure_receipt',
        summary: `Ponytail LOCAL_NATIVE review execution ended ${snapshot.state} without a review decision`,
        reference: `iris-review-job:${snapshot.jobId}`,
        data: {
          reviewJobId: snapshot.jobId,
          lifecycleOutcome: 'EXECUTION_FAILED',
          jobState: snapshot.state,
          exitCode: snapshot.exitCode,
          timedOut: snapshot.timedOut,
          reviewDecision: null,
          terminalReceipt: null,
          launchSpecSha256: snapshot.reviewLaunchSha256,
          contextArtifactId: binding.contextArtifactId,
          contextArtifactSha256: binding.contextArtifactSha256,
          contextSha256: binding.contextSha256,
          reviewerProfileSha256: binding.reviewerProfileSha256,
          workspaceSha256: binding.workspaceSha256,
          repositoryIdentitySha256: binding.repositoryIdentitySha256,
        },
      };
      await this.state.appendMissionActionEvidence(
        snapshot.missionId,
        snapshot.taskId,
        snapshot.actionId,
        'code_review.start',
        evidence,
      ).catch(async (error) => {
        if (!(error instanceof RuntimeError) || error.code !== 'PRECONDITION_FAILED') throw error;
        const currentMission = await this.state.getMission(snapshot.missionId!);
        const action = currentMission.tasks.find((task) => task.id === snapshot.taskId)?.actions.find((item) => item.id === snapshot.actionId);
        const existing = action?.result?.evidence.find((item) =>
          item.label === 'code_review.failure_receipt' && item.reference === evidence.reference);
        if (existing?.data.lifecycleOutcome !== 'EXECUTION_FAILED'
          || existing.data.jobState !== snapshot.state
          || existing.data.exitCode !== snapshot.exitCode
          || existing.data.timedOut !== snapshot.timedOut
          || existing.data.contextArtifactId !== binding.contextArtifactId
          || existing.data.contextArtifactSha256 !== binding.contextArtifactSha256
          || existing.data.contextSha256 !== binding.contextSha256
          || existing.data.reviewerProfileSha256 !== binding.reviewerProfileSha256
          || existing.data.workspaceSha256 !== binding.workspaceSha256
          || existing.data.repositoryIdentitySha256 !== binding.repositoryIdentitySha256) {
          throw error;
        }
      });
      await this.jobs.markCodeReviewFinalized(input.projectId, snapshot.jobId);
      return {
        jobId: snapshot.jobId,
        state: snapshot.state,
        workspaceId: snapshot.workspaceId,
        terminalValid: false,
        lifecycleOutcome: 'EXECUTION_FAILED',
        reviewDecision: null,
        terminalReceipt: null,
        exitCode: snapshot.exitCode,
        timedOut: snapshot.timedOut,
        logArtifactIds: snapshot.logArtifactIds,
      };
    }
    if (snapshot.reviewOutput === null || snapshot.reviewOutputSha256 === null || snapshot.reviewBinding === null) {
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Native code review private terminal payload or expected identity binding is missing');
    }
    const binding = snapshot.reviewBinding;
    const parsed = parseNativeCodeReviewOutput(snapshot.reviewOutput);
    if (parsed.contextSha256 !== binding.contextSha256
      || parsed.workspaceSha256 !== binding.workspaceSha256
      || parsed.reviewerProfileSha256 !== binding.reviewerProfileSha256
      || parsed.repositoryIdentitySha256 !== binding.repositoryIdentitySha256) {
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Native code review terminal identities do not match the server-retained review binding');
    }

    const reportCanonical = JSON.stringify(parsed.reviewReport);
    const reportSha256 = createHash('sha256').update(reportCanonical).digest('hex');
    const evidence: MissionEvidence = {
      id: randomUUID(),
      kind: 'AUDIT',
      label: 'code_review.receipt',
      summary: `Ponytail LOCAL_NATIVE review returned ${parsed.reviewDecision}`,
      reference: `iris-review-job:${snapshot.jobId}`,
      data: {
        reviewJobId: snapshot.jobId,
        reviewDecision: parsed.reviewDecision,
        terminalReceipt: parsed.terminalReceipt,
        reportSha256,
        privateResultSha256: snapshot.reviewOutputSha256,
        launchSpecSha256: snapshot.reviewLaunchSha256,
        contextArtifactId: binding.contextArtifactId,
        contextArtifactSha256: binding.contextArtifactSha256,
        contextSha256: parsed.contextSha256,
        reviewerProfileSha256: parsed.reviewerProfileSha256,
        workspaceSha256: parsed.workspaceSha256,
        repositoryRoot: binding.repositoryIdentity?.root ?? null,
        repositoryDevice: binding.repositoryIdentity?.device ?? null,
        repositoryInode: binding.repositoryIdentity?.inode ?? null,
        repositoryIdentitySha256: parsed.repositoryIdentitySha256,
      },
    };
    await this.state.appendMissionActionEvidence(
      snapshot.missionId,
      snapshot.taskId,
      snapshot.actionId,
      'code_review.start',
      evidence,
    ).catch(async (error) => {
      if (!(error instanceof RuntimeError) || error.code !== 'PRECONDITION_FAILED') throw error;
      const mission = await this.state.getMission(snapshot.missionId!);
      const action = mission.tasks.find((task) => task.id === snapshot.taskId)?.actions.find((item) => item.id === snapshot.actionId);
      const existing = action?.result?.evidence.find((item) => item.reference === evidence.reference);
      if (existing?.data.reviewDecision !== parsed.reviewDecision
        || existing.data.reportSha256 !== reportSha256
        || existing.data.privateResultSha256 !== snapshot.reviewOutputSha256
        || existing.data.contextArtifactId !== binding.contextArtifactId
        || existing.data.contextArtifactSha256 !== binding.contextArtifactSha256
        || existing.data.contextSha256 !== parsed.contextSha256
        || existing.data.reviewerProfileSha256 !== parsed.reviewerProfileSha256
        || existing.data.workspaceSha256 !== parsed.workspaceSha256
        || existing.data.repositoryIdentitySha256 !== parsed.repositoryIdentitySha256) {
        throw error;
      }
    });
    await this.jobs.markCodeReviewFinalized(input.projectId, snapshot.jobId);

    return {
      jobId: snapshot.jobId,
      state: snapshot.state,
      workspaceId: snapshot.workspaceId,
      reviewDecision: parsed.reviewDecision,
      terminalReceipt: parsed.terminalReceipt,
      reviewReport: parsed.reviewReport,
      contextSha256: parsed.contextSha256,
      reviewerProfileSha256: parsed.reviewerProfileSha256,
      workspaceSha256: parsed.workspaceSha256,
      logArtifactIds: snapshot.logArtifactIds,
    };
  }
}

async function reviewerProfileIdentity(workspaceRoot: string): Promise<string> {
  const candidate = path.join(workspaceRoot, '.codex', 'agents', 'code_review.toml');
  let physical: string;
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    physical = await realpath(candidate);
    metadata = await lstat(candidate);
  } catch (error) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Repository-local code_review profile is unavailable', { cause: error });
  }
  if (physical !== candidate || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > 32 * 1024
    || !pathIsWithin(workspaceRoot, physical)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Repository-local code_review profile identity is invalid');
  }
  const sha256 = createHash('sha256').update(await readFile(candidate)).digest('hex');
  if (sha256 !== TRUSTED_CODE_REVIEW_PROFILE_SHA256) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Repository-local code_review profile does not match the server-owned trusted reviewer identity');
  }
  return sha256;
}

export { parseNativeCodeReviewOutput } from './code-review-contract.js';

export function codeReviewEffects(): readonly CapabilityEffect[] {
  return REVIEW_EFFECTS;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
