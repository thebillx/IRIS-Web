import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoryId } from '@iris/domain';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService, type CapabilityOutcome } from './capability-service.js';
import { parseNativeCodeReviewOutput } from './code-review-manager.js';
import { DurableJobManager } from './durable-job-manager.js';
import { codeReviewGroupedToolDefinitions, executeCodeReviewGroupedTool } from './mcp-code-review.js';
import { fullMcpToolDefinitionsV21 } from './mcp-v21.js';
import { proMcpToolDefinitions } from './mcp.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { ProjectValidationJobManager } from './project-test.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
const REVIEW_START_EFFECTS = ['READ','WRITE','EXECUTE','NETWORK','DESTRUCTIVE'] as const;
const REVIEW_STATUS_EFFECTS = ['READ'] as const;
const REVIEW_RESULT_EFFECTS = ['READ','WRITE'] as const;

afterEach(async () => {
  delete process.env.IRIS_CODEX_EXECUTABLE;
  delete process.env.IRIS_CODEX_AUTH_FILE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native Ponytail code-review capability', () => {
  it('exposes one FULL-only governed surface without caller-controlled reviewer execution knobs', () => {
    expect(fullMcpToolDefinitionsV21().some((definition) => definition.name === 'code_review')).toBe(true);
    expect(proMcpToolDefinitions().some((definition) => definition.name === 'code_review')).toBe(false);
    const definition = codeReviewGroupedToolDefinitions()[0]!;
    const schema = definition.inputSchema as { properties?: Record<string, unknown> };
    const keys = Object.keys(schema.properties ?? {}).sort();
    expect(keys).toEqual([
      'actionId','contextArtifactId','expectedEffects','jobId','missionId','operation','projectId',
      'requestId','sessionId','taskId','workspaceId',
    ]);
    for (const forbidden of ['model','sandbox','sandboxPolicy','approvalPolicy','executable','argv','envOverrides','prompt']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('prepares a review action through the new grouped surface without widening legacy mission_action_prepare', async () => {
    const fixture = await reviewFixture();
    const mission = await fixture.state.createMission(fixture.session.clientId, fixture.session.id, 'grouped prepare', 'CHATGPT');
    await fixture.state.setMissionState(mission.id, fixture.session.clientId, fixture.session.id, 'RUNNING');
    const withTask = await fixture.state.createMissionTask(mission.id, fixture.session.clientId, fixture.session.id, 'review exact diff');
    const taskId = withTask.tasks.at(-1)!.id;
    const request = new Request('http://127.0.0.1/mcp', {
      headers: {
        'x-iris-client-id': fixture.session.clientId,
        'x-iris-session-id': fixture.session.id,
      },
    });
    const prepared = await executeCodeReviewGroupedTool({
      operation: 'prepare',
      projectId: fixture.project.id,
      missionId: mission.id,
      taskId,
      expectedEffects: ['WRITE'],
    }, request, fixture.service, fixture.state);
    const value = executedValue<Awaited<ReturnType<RuntimeState['getMission']>>>(prepared);
    const action = value.tasks.find((task) => task.id === taskId)?.actions.at(-1);
    expect(action).toMatchObject({
      capabilityId: 'code_review.start',
      state: 'PLANNED',
      summary: 'Run Ponytail LOCAL_NATIVE exact-diff review',
    });

    const legacyPrepare = fullMcpToolDefinitionsV21().find((definition) => definition.name === 'mission_action_prepare');
    const schema = legacyPrepare?.inputSchema as { properties?: { capabilityId?: { enum?: string[] } } };
    expect(schema.properties?.capabilityId?.enum).not.toContain('code_review.start');
  });

  it('fails closed on malformed, duplicate-key, or internally inconsistent terminal receipts', () => {
    expect(() => parseNativeCodeReviewOutput('not-json')).toThrowError(expect.objectContaining({ code: 'AGENT_EXECUTION_FAILED' }));
    const duplicateDecision = JSON.stringify(validRunnerOutput('APPROVED'))
      .replace('"reviewDecision":"APPROVED"', '"reviewDecision":"CHANGES_REQUIRED","reviewDecision":"APPROVED"');
    expect(() => parseNativeCodeReviewOutput(duplicateDecision)).toThrowError(expect.objectContaining({ code: 'AGENT_EXECUTION_FAILED' }));
    const duplicateNestedFinding = JSON.stringify(validRunnerOutput('CHANGES_REQUIRED'))
      .replace('"severity":"BLOCKING"', '"severity":"NON_BLOCKING","severity":"BLOCKING"');
    expect(() => parseNativeCodeReviewOutput(duplicateNestedFinding)).toThrowError(expect.objectContaining({ code: 'AGENT_EXECUTION_FAILED' }));
    expect(() => parseNativeCodeReviewOutput(JSON.stringify({
      ...validRunnerOutput('APPROVED'),
      terminalReceipt: 'REVIEW_DECISION: CHANGES_REQUIRED',
    }))).toThrowError(expect.objectContaining({ code: 'AGENT_EXECUTION_FAILED' }));
    expect(() => parseNativeCodeReviewOutput(JSON.stringify({
      ...validRunnerOutput('APPROVED'),
      reviewReport: {
        ...validRunnerOutput('APPROVED').reviewReport,
        findings: [{
          severity: 'BLOCKING',
          rootCause: 'blocking',
          evidence: 'evidence',
          minimalRequiredChange: 'change',
        }],
      },
    }))).toThrowError(expect.objectContaining({ code: 'AGENT_EXECUTION_FAILED' }));
    expect(() => parseNativeCodeReviewOutput(JSON.stringify({
      ...validRunnerOutput('CHANGES_REQUIRED'),
      reviewReport: {
        ...validRunnerOutput('CHANGES_REQUIRED').reviewReport,
        findings: [],
      },
    }))).toThrowError(expect.objectContaining({ code: 'AGENT_EXECUTION_FAILED' }));
  });

  it('launches only the server-owned read-only review shape and binds one terminal receipt to the exact mission action', async () => {
    const fixture = await reviewFixture();
    const fakeCodex = await fakeCodexExecutable(await temp('iris-fake-codex-'));
    process.env.IRIS_CODEX_EXECUTABLE = fakeCodex;

    const primary = await fixture.resources.primaryWorkspace(fixture.project.id);
    const association = await preparedReviewAction(fixture);
    const context = [
      '# Exact review context',
      `project=${fixture.project.id}`,
      `workspace=${primary.workspaceId}`,
      'boundary=review-only',
    ].join('\n') + '\n';
    const normalizedContext = context.trim();
    const reviewContextSha256 = createHash('sha256').update(normalizedContext).digest('hex');
    const contextArtifact = await textArtifact(fixture, context);

    const start = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'code_review.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      workspaceId: primary.workspaceId,
      contextArtifactId: contextArtifact.artifactId,
      requestId: `review-${randomUUID()}`,
      mission: association,
      expectedEffects: REVIEW_START_EFFECTS,
    }));
    expect(start).toMatchObject({
      reviewer: 'Ponytail/code_review',
      contextArtifactId: contextArtifact.artifactId,
      contextArtifactSha256: contextArtifact.sha256,
      contextSha256: reviewContextSha256,
      reviewDecision: null,
      terminalReceipt: null,
    });
    const jobId = String(start.jobId);

    const terminal = await waitForReviewTerminal(fixture, jobId);
    expect(terminal).toMatchObject({
      state: 'SUCCEEDED',
      terminalReady: true,
      terminalValid: true,
      reviewDecision: null,
      terminalReceipt: null,
    });

    const finalized = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'code_review.result',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      jobId,
      expectedEffects: REVIEW_RESULT_EFFECTS,
    }));
    expect(finalized).toMatchObject({
      state: 'SUCCEEDED',
      reviewDecision: 'APPROVED',
      terminalReceipt: 'REVIEW_DECISION: APPROVED',
      contextSha256: reviewContextSha256,
    });

    const repeated = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'code_review.result',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      jobId,
      expectedEffects: REVIEW_RESULT_EFFECTS,
    }));
    expect(repeated).toMatchObject({
      reviewDecision: 'APPROVED',
      terminalReceipt: 'REVIEW_DECISION: APPROVED',
    });

    const mission = await fixture.state.getMission(association.missionId);
    const action = mission.tasks.find((task) => task.id === association.taskId)?.actions.find((item) => item.id === association.actionId);
    expect(action?.state).toBe('SUCCEEDED');
    const receipts = action?.result?.evidence.filter((item) => item.label === 'code_review.receipt') ?? [];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      kind: 'AUDIT',
      reference: `iris-review-job:${jobId}`,
      data: {
        reviewDecision: 'APPROVED',
        terminalReceipt: 'REVIEW_DECISION: APPROVED',
        contextSha256: reviewContextSha256,
      },
    });
    expect(JSON.stringify(await fixture.audit.recent(100))).not.toContain(context);
  }, 20_000);

  it('derives linked-worktree Git metadata read access only from the verified IRIS repository binding', async () => {
    const fixture = await reviewFixture();
    const commonGitDir = path.join(fixture.projectRoot, '.git');
    await mkdir(commonGitDir);
    const metadata = await lstat(commonGitDir, { bigint: true });
    const primary = await fixture.resources.primaryWorkspace(fixture.project.id);
    const repositoryId = randomUUID() as RepositoryId;
    await fixture.resources.ensureRepository({
      repositoryId,
      projectId: fixture.project.id,
      primaryWorkspaceId: primary.workspaceId,
      commonGitDir,
      commonGitDirDevice: metadata.dev.toString(),
      commonGitDirInode: metadata.ino.toString(),
    });

    const worktreeRoot = path.join(fixture.sourceRoot, 'project-a-review');
    await mkdir(path.join(worktreeRoot, '.codex', 'agents'), { recursive: true });
    await writeReviewProfile(worktreeRoot);
    const worktree = await fixture.resources.authorizeWorktree({
      projectId: fixture.project.id,
      repositoryId,
      physicalRoot: worktreeRoot,
      createdByAction: null,
    });

    const fakeCodex = await fakeCodexExecutable(await temp('iris-fake-codex-worktree-'), commonGitDir);
    process.env.IRIS_CODEX_EXECUTABLE = fakeCodex;
    const association = await preparedReviewAction(fixture, 'linked worktree native review');
    const contextArtifact = await textArtifact(fixture, '# linked worktree exact context');
    const start = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'code_review.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      workspaceId: worktree.workspaceId,
      contextArtifactId: contextArtifact.artifactId,
      requestId: `review-worktree-${randomUUID()}`,
      mission: association,
      expectedEffects: REVIEW_START_EFFECTS,
    }));

    expect(start.gitMetadataRead).toBe(true);
    expect(start.launchSpecArtifactId).toBeUndefined();
    expect(start.launchSpecSha256).toMatch(/^[0-9a-f]{64}$/);
    const publicArtifactsBeforeResult = await fixture.resources.listArtifacts(fixture.project.id);
    expect(publicArtifactsBeforeResult.some((artifact) => artifact.artifactType === 'local-native-review-launch-spec')).toBe(false);
    expect(publicArtifactsBeforeResult.some((artifact) => artifact.artifactType === 'native-code-review-result')).toBe(false);

    const terminal = await waitForReviewTerminal(fixture, String(start.jobId));
    expect(terminal).toMatchObject({ state: 'SUCCEEDED', terminalReady: true, terminalValid: true });
    const finalized = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'code_review.result',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      jobId: String(start.jobId),
      expectedEffects: REVIEW_RESULT_EFFECTS,
    }));
    expect(finalized).toMatchObject({
      reviewDecision: 'APPROVED',
      terminalReceipt: 'REVIEW_DECISION: APPROVED',
    });
    const mission = await fixture.state.getMission(association.missionId);
    const action = mission.tasks.find((task) => task.id === association.taskId)?.actions.find((item) => item.id === association.actionId);
    const receipt = action?.result?.evidence.find((item) => item.label === 'code_review.receipt');
    expect(receipt?.data).toMatchObject({
      contextArtifactId: contextArtifact.artifactId,
      contextArtifactSha256: contextArtifact.sha256,
      repositoryRoot: commonGitDir,
      repositoryDevice: metadata.dev.toString(),
      repositoryInode: metadata.ino.toString(),
      repositoryIdentitySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  }, 20_000);

  it('ignores project-visible log/context tampering, hides review jobs from generic job surfaces, and cleans terminal secrets before result', async () => {
    const fixture = await reviewFixture();
    const baselineTemps = await reviewTempDirs();
    const fakeCodex = await fakeCodexExecutable(await temp('iris-fake-codex-tamper-'), null, 'CHANGES_REQUIRED');
    process.env.IRIS_CODEX_EXECUTABLE = fakeCodex;
    const primary = await fixture.resources.primaryWorkspace(fixture.project.id);
    const association = await preparedReviewAction(fixture, 'tamper isolation review');
    const contextArtifact = await textArtifact(fixture, '# original exact context\n');
    const start = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'code_review.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      workspaceId: primary.workspaceId,
      contextArtifactId: contextArtifact.artifactId,
      requestId: `review-tamper-${randomUUID()}`,
      mission: association,
      expectedEffects: REVIEW_START_EFFECTS,
    }));
    const jobId = String(start.jobId);
    const terminal = await waitForReviewTerminal(fixture, jobId);
    expect(terminal).toMatchObject({ state: 'SUCCEEDED', terminalReady: true, reviewDecision: null, terminalReceipt: null });
    expect(await reviewTempDirs()).toEqual(baselineTemps);

    for (const operation of [
      () => fixture.jobs.status(fixture.project.id, jobId),
      () => fixture.jobs.logs(fixture.project.id, jobId, 'stdout'),
      () => fixture.jobs.result(fixture.project.id, jobId),
      () => fixture.jobs.compatibilitySnapshot(fixture.project.id, jobId),
      () => fixture.jobs.cancel(fixture.project.id, jobId),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    }

    const artifacts = await fixture.resources.listArtifacts(fixture.project.id);
    expect(artifacts.some((artifact) => artifact.artifactType === 'native-code-review-result')).toBe(false);
    expect(artifacts.some((artifact) => artifact.artifactType === 'local-native-review-launch-spec')).toBe(false);
    const stdout = artifacts.find((artifact) => artifact.producerJobId === jobId && artifact.artifactType === 'log-stdout');
    expect(stdout).toBeDefined();
    await writeFile(stdout!.physicalPath, JSON.stringify(validRunnerOutput('APPROVED')));
    await writeFile(contextArtifact.physicalPath, '# malicious replacement context\n');

    const finalized = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'code_review.result',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      jobId,
      expectedEffects: REVIEW_RESULT_EFFECTS,
    }));
    expect(finalized).toMatchObject({
      reviewDecision: 'CHANGES_REQUIRED',
      terminalReceipt: 'REVIEW_DECISION: CHANGES_REQUIRED',
    });
  }, 20_000);

  it('rejects canonical private result tampering after runner digest binding', async () => {
    const fixture = await reviewFixture();
    const fakeCodex = await fakeCodexExecutable(await temp('iris-fake-codex-private-tamper-'));
    process.env.IRIS_CODEX_EXECUTABLE = fakeCodex;
    const primary = await fixture.resources.primaryWorkspace(fixture.project.id);
    const association = await preparedReviewAction(fixture, 'private result tamper');
    const contextArtifact = await textArtifact(fixture, '# private result tamper');
    const start = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'code_review.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      workspaceId: primary.workspaceId,
      contextArtifactId: contextArtifact.artifactId,
      requestId: `review-private-tamper-${randomUUID()}`,
      mission: association,
      expectedEffects: REVIEW_START_EFFECTS,
    }));
    const jobId = String(start.jobId);
    await waitForReviewTerminal(fixture, jobId);
    const privateOutput = path.join(fixture.dataRoot, 'vnext-job-runtime', jobId, 'review-output.json');
    await writeFile(privateOutput, JSON.stringify(validRunnerOutput('APPROVED')) + '\n');
    await expect(fixture.service.execute({
      capabilityId: 'code_review.result',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      jobId,
      expectedEffects: REVIEW_RESULT_EFFECTS,
    })).rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED' });
  }, 20_000);

  it('rejects duplicate keys emitted by the model before a terminal review payload is accepted', async () => {
    const fixture = await reviewFixture();
    const raw = JSON.stringify({
      task: 'duplicate model report',
      scopeReviewed: 'scope',
      filesInspected: [],
      validationReviewed: [],
      findings: [],
      regressionRisks: [],
      decision: 'APPROVED',
      recommendedLifecycleAction: 'next',
    }).replace('"decision":"APPROVED"', '"decision":"CHANGES_REQUIRED","decision":"APPROVED"');
    const fakeCodex = await fakeCodexExecutable(await temp('iris-fake-codex-duplicate-'), null, 'APPROVED', raw);
    process.env.IRIS_CODEX_EXECUTABLE = fakeCodex;
    const primary = await fixture.resources.primaryWorkspace(fixture.project.id);
    const association = await preparedReviewAction(fixture, 'duplicate model report');
    const contextArtifact = await textArtifact(fixture, '# duplicate model report');
    const start = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'code_review.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      workspaceId: primary.workspaceId,
      contextArtifactId: contextArtifact.artifactId,
      requestId: `review-duplicate-${randomUUID()}`,
      mission: association,
      expectedEffects: REVIEW_START_EFFECTS,
    }));
    const status = await waitForReviewTerminal(fixture, String(start.jobId));
    expect(status).toMatchObject({ state: 'FAILED', terminalValid: false, reviewDecision: null, terminalReceipt: null });
    await expect(fixture.service.execute({
      capabilityId: 'code_review.result',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      jobId: String(start.jobId),
      expectedEffects: REVIEW_RESULT_EFFECTS,
    })).rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED' });
  }, 20_000);

  it('refuses capacity instead of evicting live review jobs and cleans newly prepared private auth/input state', async () => {
    const fixture = await reviewFixture();
    const baselineTemps = await reviewTempDirs();
    const fakeCodex = await fakeCodexExecutable(await temp('iris-fake-codex-capacity-'));
    process.env.IRIS_CODEX_EXECUTABLE = fakeCodex;

    const liveJobs = Array.from({ length: 200 }, (_, index) => ({
      jobId: randomUUID(),
      requestId: `live-review-${index}`,
      projectId: fixture.project.id,
      state: 'RUNNING',
      executionProfile: 'codex-review',
      reviewFinalizedAt: null,
    }));
    await writeFile(path.join(fixture.dataRoot, 'vnext-jobs.json'), JSON.stringify({ schemaVersion: 1, jobs: liveJobs }) + '\n', { mode: 0o600 });

    const primary = await fixture.resources.primaryWorkspace(fixture.project.id);
    const association = await preparedReviewAction(fixture, 'capacity refusal');
    const contextArtifact = await textArtifact(fixture, '# capacity refusal');
    await expect(fixture.service.execute({
      capabilityId: 'code_review.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      workspaceId: primary.workspaceId,
      contextArtifactId: contextArtifact.artifactId,
      requestId: `review-capacity-${randomUUID()}`,
      mission: association,
      expectedEffects: REVIEW_START_EFFECTS,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    expect(await reviewTempDirs()).toEqual(baselineTemps);
    const persisted = JSON.parse(await readFile(path.join(fixture.dataRoot, 'vnext-jobs.json'), 'utf8')) as { jobs: unknown[] };
    expect(persisted.jobs).toHaveLength(200);
  });

  it('cleans private auth/input state on reviewer bootstrap failure before any result finalization', async () => {
    const fixture = await reviewFixture();
    const baselineTemps = await reviewTempDirs();
    const fakeCodex = await fakeCodexExecutable(await temp('iris-fake-codex-bootstrap-'));
    process.env.IRIS_CODEX_EXECUTABLE = fakeCodex;
    await writeFile(path.join(fixture.projectRoot, '.codex', 'config.toml'), 'forbidden = true\n');

    const primary = await fixture.resources.primaryWorkspace(fixture.project.id);
    const association = await preparedReviewAction(fixture, 'bootstrap failure cleanup');
    const contextArtifact = await textArtifact(fixture, '# bootstrap failure');
    const start = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'code_review.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      workspaceId: primary.workspaceId,
      contextArtifactId: contextArtifact.artifactId,
      requestId: `review-bootstrap-${randomUUID()}`,
      mission: association,
      expectedEffects: REVIEW_START_EFFECTS,
    }));
    const terminal = await waitForReviewTerminal(fixture, String(start.jobId));
    expect(terminal.state).toBe('FAILED');
    expect(await reviewTempDirs()).toEqual(baselineTemps);
  }, 20_000);

  it('cleans private auth/input before terminal publication and remains restart-safe without code_review.result polling', async () => {
    const fixture = await reviewFixture();
    const baselineTemps = await reviewTempDirs();
    const fakeCodex = await fakeCodexExecutable(await temp('iris-fake-codex-restart-'));
    process.env.IRIS_CODEX_EXECUTABLE = fakeCodex;
    const primary = await fixture.resources.primaryWorkspace(fixture.project.id);
    const association = await preparedReviewAction(fixture, 'restart cleanup');
    const direct = await prepareDirectReview(fixture, primary.workspaceId, '# restart cleanup');
    const requestId = `review-restart-${randomUUID()}`;
    const start = await fixture.jobs.start(direct.prepared, requestId, REVIEW_START_EFFECTS, association);
    const jobId = String(start.jobId);

    await waitForPrivateRunnerResult(fixture.dataRoot, jobId);
    expect(await reviewTempDirs()).toEqual(baselineTemps);

    const restarted = new DurableJobManager(fixture.dataRoot, fixture.resources);
    await restarted.recover();
    const snapshot = await restarted.codeReviewStatusSnapshot(fixture.project.id, jobId);
    expect(snapshot).toMatchObject({ state: 'SUCCEEDED', terminalReady: true });
    expect(await reviewTempDirs()).toEqual(baselineTemps);
  }, 20_000);

  it('cleans newly prepared private state when an exact duplicate requestId reuses the existing job', async () => {
    const fixture = await reviewFixture();
    const baselineTemps = await reviewTempDirs();
    const fakeCodex = await fakeCodexExecutable(await temp('iris-fake-codex-duplicate-request-'));
    process.env.IRIS_CODEX_EXECUTABLE = fakeCodex;
    const primary = await fixture.resources.primaryWorkspace(fixture.project.id);
    const association = await preparedReviewAction(fixture, 'duplicate request cleanup');
    const requestId = `review-idempotent-${randomUUID()}`;

    const firstPrepared = await prepareDirectReview(fixture, primary.workspaceId, '# duplicate request');
    const first = await fixture.jobs.start(firstPrepared.prepared, requestId, REVIEW_START_EFFECTS, association);
    await waitForDirectReviewTerminal(fixture.jobs, fixture.project.id, String(first.jobId));
    expect(await reviewTempDirs()).toEqual(baselineTemps);

    const secondPrepared = await prepareDirectReview(fixture, primary.workspaceId, '# duplicate request', firstPrepared.contextArtifact);
    expect((await reviewTempDirs()).length).toBeGreaterThanOrEqual(baselineTemps.length + 2);
    const repeated = await fixture.jobs.start(secondPrepared.prepared, requestId, REVIEW_START_EFFECTS, association);
    expect(repeated.jobId).toBe(first.jobId);
    expect(await reviewTempDirs()).toEqual(baselineTemps);
  }, 20_000);

  it('cleans private auth/input when the durable review target times out and becomes CANCELLED', async () => {
    const fixture = await reviewFixture();
    const baselineTemps = await reviewTempDirs();
    const hangingCodex = await hangingCodexExecutable(await temp('iris-fake-codex-timeout-'));
    process.env.IRIS_CODEX_EXECUTABLE = hangingCodex;
    const primary = await fixture.resources.primaryWorkspace(fixture.project.id);
    const association = await preparedReviewAction(fixture, 'timeout cleanup');
    const direct = await prepareDirectReview(fixture, primary.workspaceId, '# timeout cleanup', undefined, 10_000);
    const start = await fixture.jobs.start(direct.prepared, `review-timeout-${randomUUID()}`, REVIEW_START_EFFECTS, association);
    const terminal = await waitForDirectReviewTerminal(fixture.jobs, fixture.project.id, String(start.jobId), 16_000);
    expect(terminal).toMatchObject({ state: 'CANCELLED', timedOut: true });
    expect(await reviewTempDirs()).toEqual(baselineTemps);
  }, 22_000);

  it('rejects effect under-declaration and refuses SCRATCH as the review target workspace', async () => {
    const fixture = await reviewFixture();
    const fakeCodex = await fakeCodexExecutable(await temp('iris-fake-codex-effects-'));
    process.env.IRIS_CODEX_EXECUTABLE = fakeCodex;
    const primary = await fixture.resources.primaryWorkspace(fixture.project.id);
    const contextArtifact = await textArtifact(fixture, '# bounded');
    const association = await preparedReviewAction(fixture);

    const underDeclared = await fixture.service.execute({
      capabilityId: 'code_review.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      workspaceId: primary.workspaceId,
      contextArtifactId: contextArtifact.artifactId,
      requestId: `review-effects-${randomUUID()}`,
      mission: association,
      expectedEffects: ['READ','EXECUTE'],
    });
    expect(underDeclared).toMatchObject({ status: 'denied', reason: expect.stringContaining('EFFECT_MISMATCH') });

    const association2 = await preparedReviewAction(fixture, 'scratch review must fail');
    const scratchTarget = await fixture.resources.createScratch(fixture.project.id);
    await expect(fixture.service.execute({
      capabilityId: 'code_review.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      workspaceId: scratchTarget.workspaceId,
      contextArtifactId: contextArtifact.artifactId,
      requestId: `review-scratch-${randomUUID()}`,
      mission: association2,
      expectedEffects: REVIEW_START_EFFECTS,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    const failedMission = await fixture.state.getMission(association2.missionId);
    const failedAction = failedMission.tasks.find((task) => task.id === association2.taskId)?.actions.find((item) => item.id === association2.actionId);
    expect(failedAction?.state).toBe('FAILED');
  });
});

async function reviewFixture() {
  const sourceRoot = await realpath(await temp('iris-review-source-'));
  const dataRoot = await realpath(await temp('iris-review-data-'));
  const authFile = path.join(dataRoot, 'server-codex-auth.json');
  await writeFile(authFile, '{"test":"server-owned"}\n', { mode: 0o600, flag: 'wx' });
  process.env.IRIS_CODEX_AUTH_FILE = authFile;
  const projectRoot = path.join(sourceRoot, 'project-a');
  await mkdir(path.join(projectRoot, '.codex', 'agents'), { recursive: true });
  await writeReviewProfile(projectRoot);

  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Review Project', projectRoot);
  const session = state.createSession('review-client', 'review-owner', 'owner');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  await settings.setMode('FULL_LOCAL_OWNER');
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot);
  const audit = new PermissionAuditStore(dataRoot);
  const resources = new VNextResourceRegistry(state, dataRoot);
  const jobs = new DurableJobManager(dataRoot, resources);
  const service = new CapabilityService(state, policy, audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1,
    agentExecutorType: 'local-development-executor', productionModelConnected: false,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }), new ProjectValidationJobManager(dataRoot), resources, jobs);
  return { sourceRoot, dataRoot, projectRoot, state, project, session, settings, audit, resources, jobs, service };
}

async function preparedReviewAction(fixture: Awaited<ReturnType<typeof reviewFixture>>, title = 'native review') {
  const mission = await fixture.state.createMission(fixture.session.clientId, fixture.session.id, title, 'CHATGPT');
  await fixture.state.setMissionState(mission.id, fixture.session.clientId, fixture.session.id, 'RUNNING');
  const withTask = await fixture.state.createMissionTask(mission.id, fixture.session.clientId, fixture.session.id, 'review exact diff');
  const taskId = withTask.tasks.at(-1)!.id;
  const withAction = await fixture.state.prepareMissionAction(
    mission.id,
    taskId,
    fixture.session.clientId,
    fixture.session.id,
    'code_review.start',
    'Run Ponytail LOCAL_NATIVE exact-diff review',
  );
  const actionId = withAction.tasks.find((task) => task.id === taskId)!.actions.at(-1)!.id;
  return { missionId: mission.id, taskId, actionId, orchestratorMode: 'CHATGPT' as const };
}

async function textArtifact(fixture: Awaited<ReturnType<typeof reviewFixture>>, content: string) {
  const scratch = await fixture.resources.createScratch(fixture.project.id);
  const filename = path.join(scratch.physicalRoot, 'review-context.md');
  await writeFile(filename, content, { mode: 0o600 });
  return fixture.resources.registerArtifact({
    projectId: fixture.project.id,
    workspaceId: scratch.workspaceId,
    physicalPath: filename,
    mime: 'text/markdown',
    artifactType: 'local-native-review-context',
    size: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content).digest('hex'),
    sensitivity: 'INTERNAL',
    retentionPolicy: 'MISSION',
  });
}

async function waitForReviewTerminal(fixture: Awaited<ReturnType<typeof reviewFixture>>, jobId: string) {
  let last: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 160; attempt += 1) {
    last = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'code_review.status',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      jobId,
      expectedEffects: REVIEW_STATUS_EFFECTS,
    }));
    if (last.state !== 'QUEUED' && last.state !== 'RUNNING') return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Review job did not become terminal: ${JSON.stringify(last)}`);
}

async function prepareDirectReview(
  fixture: Awaited<ReturnType<typeof reviewFixture>>,
  workspaceId: string,
  content: string,
  existingContextArtifact?: Awaited<ReturnType<typeof textArtifact>>,
  timeoutMs = 30 * 60_000,
) {
  const workspace = await fixture.resources.getActiveWorkspace(fixture.project.id, workspaceId);
  const contextArtifact = existingContextArtifact ?? await textArtifact(fixture, content);
  const context = content.trim();
  const contextSha256 = createHash('sha256').update(context).digest('hex');
  const profileBytes = await readFile(path.join(workspace.physicalRoot, '.codex', 'agents', 'code_review.toml'));
  const reviewerProfileSha256 = createHash('sha256').update(profileBytes).digest('hex');
  const launch = {
    schemaVersion: 1,
    workspaceRoot: workspace.physicalRoot,
    context,
    contextSha256,
    reviewerProfileSha256,
    gitMetadata: null,
  };
  const prepared = await fixture.jobs.prepareServerOwnedCodeReview({
    projectId: fixture.project.id,
    workspaceId,
    executable: 'node',
    argv: [await import('./execution-profiles.js').then((module) => module.resolveCodeReviewRunnerPath())],
    cwd: '.',
    executionProfile: 'codex-review',
    envOverrides: {},
    timeoutMs,
  }, Buffer.from(JSON.stringify(launch), 'utf8'), {
    contextArtifactId: contextArtifact.artifactId,
    contextArtifactSha256: contextArtifact.sha256,
    contextSha256,
    workspaceSha256: createHash('sha256').update(workspace.physicalRoot).digest('hex'),
    reviewerProfileSha256,
    repositoryIdentity: null,
    repositoryIdentitySha256: createHash('sha256').update(JSON.stringify(null)).digest('hex'),
  });
  return { prepared, contextArtifact };
}

async function waitForPrivateRunnerResult(dataRoot: string, jobId: string, timeoutMs = 15_000): Promise<void> {
  const filename = path.join(dataRoot, 'vnext-job-runtime', jobId, 'result.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await lstat(filename);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('private runner result did not become available');
}

async function waitForDirectReviewTerminal(
  jobs: DurableJobManager,
  projectId: string,
  jobId: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<DurableJobManager['codeReviewStatusSnapshot']>> | null = null;
  while (Date.now() < deadline) {
    last = await jobs.codeReviewStatusSnapshot(projectId, jobId);
    if (last.state !== 'QUEUED' && last.state !== 'RUNNING') return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`direct review job did not become terminal: ${JSON.stringify(last)}`);
}

async function hangingCodexExecutable(root: string): Promise<string> {
  const filename = path.join(root, 'codex');
  await writeFile(filename, `#!/usr/bin/env node
if (process.argv[2] !== 'app-server') process.exit(2);
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  await chmod(filename, 0o700);
  return realpath(filename);
}

async function writeReviewProfile(root: string): Promise<void> {
  await mkdir(path.join(root, '.codex', 'agents'), { recursive: true });
  const trustedProfile = await readFile(new URL('../../../.codex/agents/code_review.toml', import.meta.url));
  await writeFile(path.join(root, '.codex', 'agents', 'code_review.toml'), trustedProfile);
}

async function fakeCodexExecutable(
  root: string,
  expectedGitRoot: string | null = null,
  decision: 'APPROVED' | 'CHANGES_REQUIRED' = 'APPROVED',
  rawAgentMessage: string | null = null,
): Promise<string> {
  const filename = path.join(root, 'codex');
  await writeFile(filename, `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
if (process.argv[2] !== 'app-server') process.exit(2);
const config = await readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
const requiredConfig = [
  'approval_policy = "never"',
  'default_permissions = "iris-review"',
  '[permissions.iris-review.filesystem]',
  '":root" = "deny"',
  '":minimal" = "read"',
  '[permissions.iris-review.filesystem.":workspace_roots"]',
  '"." = "read"',
  '[permissions.iris-review.network]',
  'enabled = false',
];
if (!requiredConfig.every((item) => config.includes(item))) process.exit(7);
const expectedGitRoot = ${JSON.stringify(expectedGitRoot)};
const reviewDecision = ${JSON.stringify(decision)};
const injectedAgentMessage = ${JSON.stringify(rawAgentMessage)};
if (expectedGitRoot !== null && !config.includes(JSON.stringify(expectedGitRoot) + ' = "read"')) process.exit(9);
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (message.params?.capabilities?.experimentalApi !== true) process.exit(8);
    send({ id: message.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    const roots = message.params?.runtimeWorkspaceRoots;
    const valid = message.params?.approvalPolicy === 'never'
      && message.params?.cwd === process.cwd()
      && message.params?.permissions === 'iris-review'
      && message.params?.ephemeral === true
      && Array.isArray(roots)
      && roots.length === 1
      && roots[0] === process.cwd();
    if (!valid) process.exit(3);
    send({
      id: message.id,
      result: {
        thread: { id: 'thread-test' },
        activePermissionProfile: { id: 'iris-review' },
        sandbox: { type: 'readOnly' },
      },
    });
    return;
  }
  if (message.method === 'turn/start') {
    if (message.params?.sandboxPolicy !== undefined || message.params?.approvalPolicy !== undefined || message.params?.permissions !== undefined) process.exit(4);
    if (message.params?.cwd !== process.cwd()) process.exit(4);
    if (message.params?.model !== 'gpt-5.6-sol' || message.params?.effort !== 'xhigh') process.exit(5);
    if (!message.params?.outputSchema || message.params?.input?.[0]?.type !== 'text') process.exit(6);
    send({ id: message.id, result: { turn: { id: 'turn-test', status: 'inProgress' } } });
    const report = {
      task: 'native review',
      scopeReviewed: 'exact test boundary',
      filesInspected: ['AGENTS.md'],
      validationReviewed: ['typecheck PASS'],
      findings: reviewDecision === 'CHANGES_REQUIRED'
        ? [{ severity: 'BLOCKING', rootCause: 'test blocker', evidence: 'bounded evidence', minimalRequiredChange: 'apply bounded fix' }]
        : [],
      regressionRisks: [],
      decision: reviewDecision,
      recommendedLifecycleAction: reviewDecision === 'APPROVED' ? 'continue feature delivery' : 'correct and review again',
    };
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: injectedAgentMessage ?? JSON.stringify(report) } } });
    send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed' } } });
  }
});
`, { mode: 0o700 });
  await chmod(filename, 0o700);
  return await realpath(filename);
}

function validRunnerOutput(decision: 'APPROVED' | 'CHANGES_REQUIRED') {
  const findings = decision === 'CHANGES_REQUIRED'
    ? [{ severity: 'BLOCKING', rootCause: 'root', evidence: 'evidence', minimalRequiredChange: 'fix' }]
    : [];
  return {
    schemaVersion: 1,
    reviewDecision: decision,
    terminalReceipt: `REVIEW_DECISION: ${decision}`,
    reviewReport: {
      task: 'task',
      scopeReviewed: 'scope',
      filesInspected: [],
      validationReviewed: [],
      findings,
      regressionRisks: [],
      decision,
      recommendedLifecycleAction: 'next',
    },
    workspaceSha256: 'a'.repeat(64),
    contextSha256: 'b'.repeat(64),
    reviewerProfileSha256: 'c'.repeat(64),
    repositoryIdentitySha256: 'd'.repeat(64),
    stderrObserved: false,
  };
}

function executedValue<T>(outcome: CapabilityOutcome): T {
  if (outcome.status !== 'executed') throw new Error(`Expected executed outcome, received ${outcome.status}: ${'reason' in outcome ? outcome.reason : ''}`);
  return outcome.value as T;
}

async function reviewTempDirs(): Promise<string[]> {
  return (await readdir(os.tmpdir()))
    .filter((entry) => entry.startsWith('iris-code-review-'))
    .sort();
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
