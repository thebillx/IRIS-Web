import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  RuntimeError,
  type CapabilityId,
  type RuntimeHealth,
  type SecurityAuditComparison,
  type SecurityAuditRun,
  type SecurityCoverageStatus,
  type SecurityCoverageTarget,
  type SecurityDecisionPackage,
  type SecurityFinding,
  type SecurityFindingSeverity,
  type SecurityProofGateResult,
  type SecurityVerificationDecision,
  type SecurityVerificationResult,
  type WorkerResult,
  type WorkerRuntimeFence,
} from '@iris/domain';
import type { RuntimeState } from '../state.js';
import type { VNextResourceRegistry } from '../resource-registry.js';
import type { MultiWorkerRoutingService } from '../multi-worker/service.js';
import type { SecurityAuditDocument } from './model.js';
import { SecurityAuditStore } from './store.js';
import { validateSecurityAuditDocument } from './validation.js';

const READ_ONLY_CAPABILITIES = ['project.search', 'project.git_status', 'file.read'] as const satisfies readonly CapabilityId[];
const MAX_COVERAGE_TARGETS = 64;
const MAX_FINDINGS_PER_REPORT = 64;
const AUDIT_WORKER_TTL_MS = 2 * 60 * 60_000;

export interface SecurityCoverageTargetInput {
  readonly key: string;
  readonly title: string;
  readonly scope: string;
}

export interface SecurityFindingCandidateInput {
  readonly title: string;
  readonly category: string;
  readonly severity: SecurityFindingSeverity;
  readonly location: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

export interface CreateSecurityAuditRunInput {
  readonly clientId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly missionId: string;
  readonly baselineRunId?: string;
  readonly coverageTargets: readonly SecurityCoverageTargetInput[];
}

export interface RecordHunterReportInput {
  readonly clientId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly auditRunId: string;
  readonly coverageTargetId: string;
  readonly coverageStatus: Extract<SecurityCoverageStatus, 'COVERED' | 'GAP'>;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly filesRead: readonly string[];
  readonly findings: readonly SecurityFindingCandidateInput[];
}

export interface RecordVerifierReportInput {
  readonly clientId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly auditRunId: string;
  readonly findingId: string;
  readonly decision: SecurityVerificationDecision;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
  readonly filesRead: readonly string[];
}

export interface AuditIdentityInput {
  readonly clientId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly auditRunId: string;
}

export interface SecurityAuditRunView {
  readonly generation: number;
  readonly run: SecurityAuditRun;
  readonly coverageTargets: readonly SecurityCoverageTarget[];
  readonly findings: readonly SecurityFinding[];
  readonly verifications: readonly SecurityVerificationResult[];
  readonly proofGateResults: readonly SecurityProofGateResult[];
  readonly decisionPackage: SecurityDecisionPackage | null;
  readonly comparison: SecurityAuditComparison | null;
}

export interface SecurityAuditMissionObservability {
  readonly missionId: string;
  readonly runs: readonly {
    readonly runId: string;
    readonly state: SecurityAuditRun['state'];
    readonly coverage: Readonly<Record<SecurityCoverageStatus, number>>;
    readonly findings: Readonly<Record<SecurityFinding['state'], number>>;
    readonly updatedAt: string;
  }[];
}

export class SecurityAuditService {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly state: RuntimeState,
    private readonly multiWorker: MultiWorkerRoutingService,
    private readonly resources: VNextResourceRegistry,
    private readonly store: SecurityAuditStore,
    private readonly health: () => RuntimeHealth,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  public async listRuns(projectIdInput?: string): Promise<readonly SecurityAuditRun[]> {
    const document = await this.store.read();
    if (projectIdInput === undefined) return document.runs;
    const projectId = uuid(projectIdInput, 'projectId');
    return document.runs.filter((run) => run.projectId === projectId);
  }

  public async getRun(auditRunIdInput: string): Promise<SecurityAuditRunView> {
    const auditRunId = uuid(auditRunIdInput, 'auditRunId');
    const document = await this.store.read();
    return view(document, requiredRun(document, auditRunId));
  }

  public async observabilityForMission(missionIdInput: string): Promise<SecurityAuditMissionObservability | null> {
    const missionId = uuid(missionIdInput, 'missionId');
    const document = await this.store.read();
    const runs = document.runs.filter((entry) => entry.missionId === missionId);
    if (runs.length === 0) return null;
    return {
      missionId,
      runs: runs.map((run) => {
        const targets = targetsForRun(document, run.id);
        const findings = findingsForRun(document, run.id);
        return {
          runId: run.id,
          state: run.state,
          coverage: countCoverage(targets),
          findings: countFindings(findings),
          updatedAt: run.updatedAt,
        };
      }),
    };
  }

  public createRun(input: CreateSecurityAuditRunInput): Promise<SecurityAuditRunView> {
    return this.serialize(async () => {
      const clientId = bounded(input.clientId, 'clientId', 200);
      const sessionId = uuid(input.sessionId, 'sessionId');
      const projectId = uuid(input.projectId, 'projectId');
      const workspaceId = uuid(input.workspaceId, 'workspaceId');
      const missionId = uuid(input.missionId, 'missionId');
      if (!Array.isArray(input.coverageTargets) || input.coverageTargets.length === 0 || input.coverageTargets.length > MAX_COVERAGE_TARGETS) {
        throw new RuntimeError('INVALID_REQUEST', 'coverageTargets must contain 1 through 64 targets');
      }
      const normalizedTargets = input.coverageTargets.map(normalizeCoverageInput);
      uniqueOrThrow(normalizedTargets.map((entry) => entry.key), 'coverage target key');

      const mission = await this.state.getMission(missionId);
      const session = this.state.getSessionForClient(sessionId, clientId);
      if (mission.projectId !== projectId || mission.sessionId !== sessionId || mission.clientId !== clientId) {
        throw new RuntimeError('CONTROL_DENIED', 'Security audit mission must be bound to the calling session and project');
      }
      if (session.currentProjectId !== projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Security audit session is not selected on its project');
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(mission.state)) throw new RuntimeError('CAPABILITY_DENIED', 'Terminal mission cannot create a security audit run');

      const current = await this.store.read();
      const baselineRunId = input.baselineRunId === undefined ? null : uuid(input.baselineRunId, 'baselineRunId');
      if (baselineRunId !== null) {
        const baseline = requiredRun(current, baselineRunId);
        if (baseline.projectId !== projectId || baseline.state !== 'COMPLETED') {
          throw new RuntimeError('PRECONDITION_FAILED', 'Baseline security audit run must be completed in the same project');
        }
      }

      const auditRunId = randomUUID();
      const mwRun = await this.multiWorker.createRun({
        expectedGeneration: await this.multiWorker.currentGeneration(),
        missionId,
        parentOrchestratorId: session.agentId,
      });
      const coverageTargets: SecurityCoverageTarget[] = [];
      try {
        for (const target of normalizedTargets) {
          const worker = await this.multiWorker.createWorker({
            expectedGeneration: await this.multiWorker.currentGeneration(),
            orchestrationRunId: mwRun.run.id,
            principalId: `security-hunter:${auditRunId}:${target.key}`,
            workerType: 'IRIS_LOGICAL',
            role: 'RESEARCH',
          });
          const workerTask = await this.multiWorker.createTask({
            expectedGeneration: await this.multiWorker.currentGeneration(),
            orchestrationRunId: mwRun.run.id,
            missionTaskId: null,
            title: `Security Hunter: ${target.title}`,
            dependencyTaskIds: [],
            workspaceId: workspaceId as never,
            principalId: worker.principalId,
            allowedCapabilities: READ_ONLY_CAPABILITIES,
            allowedPaths: ['**'],
            readOnlyPaths: ['**'],
            mutablePaths: [],
            allowedProcesses: [],
            approvalPolicy: 'INHERIT_MISSION',
            resourceBudget: { maxRuntimeMs: 30 * 60_000, maxJobs: 0, maxArtifacts: 32, maxOutputBytes: 2 * 1024 * 1024 },
            concurrencyPolicy: { maxParallelCapabilities: 4, mutablePathOwnership: 'READ_ONLY', allowParallelReads: true },
            expiresAt: new Date(Date.parse(this.now()) + AUDIT_WORKER_TTL_MS).toISOString(),
          });
          await this.multiWorker.assignTask({
            expectedGeneration: await this.multiWorker.currentGeneration(),
            orchestrationRunId: mwRun.run.id,
            taskId: workerTask.id,
            workerId: worker.id,
            runtimeFence: this.runtimeFence(),
          });
          await this.multiWorker.startTask({
            expectedGeneration: await this.multiWorker.currentGeneration(),
            orchestrationRunId: mwRun.run.id,
            taskId: workerTask.id,
            requestId: randomUUID(),
          });
          const now = this.now();
          coverageTargets.push({
            id: randomUUID(),
            auditRunId,
            key: target.key,
            title: target.title,
            scope: target.scope,
            status: 'IN_PROGRESS',
            hunterWorkerId: worker.id,
            hunterTaskId: workerTask.id,
            hunterResultId: null,
            evidenceRefs: [],
            createdAt: now,
            updatedAt: now,
          });
        }
      } catch (error) {
        const generation = await this.multiWorker.currentGeneration();
        await this.multiWorker.cancelRun({ expectedGeneration: generation, orchestrationRunId: mwRun.run.id }).catch(() => undefined);
        throw error;
      }

      const now = this.now();
      const run: SecurityAuditRun = {
        id: auditRunId,
        missionId,
        orchestrationRunId: mwRun.run.id,
        projectId,
        sessionId,
        workspaceId: workspaceId as never,
        baselineRunId,
        state: 'HUNTING',
        coverageTargetIds: coverageTargets.map((entry) => entry.id),
        findingIds: [],
        verificationIds: [],
        proofGateResultIds: [],
        decisionPackageId: null,
        comparisonId: null,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      const next = validateSecurityAuditDocument({
        ...current,
        generation: current.generation + 1,
        runs: [...current.runs, run],
        coverageTargets: [...current.coverageTargets, ...coverageTargets],
      });
      await this.store.write(next, current.generation);
      return view(next, run);
    });
  }

  public recordHunterReport(input: RecordHunterReportInput): Promise<SecurityAuditRunView> {
    return this.serialize(async () => {
      const current = await this.store.read();
      const run = await this.assertMutableRun(current, input);
      const coverageTargetId = uuid(input.coverageTargetId, 'coverageTargetId');
      const target = requiredTarget(current, coverageTargetId);
      if (target.auditRunId !== run.id || target.status !== 'IN_PROGRESS') {
        throw new RuntimeError('INVALID_REQUEST', 'Coverage target is not awaiting a Hunter report');
      }
      if (input.coverageStatus !== 'COVERED' && input.coverageStatus !== 'GAP') throw new RuntimeError('INVALID_REQUEST', 'coverageStatus is invalid');
      const summary = bounded(input.summary, 'summary', 4_000);
      const evidenceRefs = strings(input.evidenceRefs, 'evidenceRefs', 128, 2_000);
      const filesRead = workspacePaths(input.filesRead, 'filesRead', 128, 2_000);
      const bindingReceipts = await this.validateEvidenceRefs(evidenceRefs, filesRead, run.projectId, run.workspaceId);
      if (!Array.isArray(input.findings) || input.findings.length > MAX_FINDINGS_PER_REPORT) throw new RuntimeError('INVALID_REQUEST', 'findings exceeds the bounded report limit');
      const candidates = input.findings.map(normalizeCandidate);
      for (const candidate of candidates) {
        bindingReceipts.push(...await this.validateEvidenceRefs(candidate.evidenceRefs, filesRead, run.projectId, run.workspaceId));
      }
      if (input.coverageStatus === 'GAP' && candidates.length > 0) throw new RuntimeError('INVALID_REQUEST', 'Coverage GAP report cannot publish findings');

      const result = await this.finalizeWorkerTask(run.orchestrationRunId, target.hunterTaskId, target.hunterWorkerId, {
        summary,
        evidenceRefs: union(union(evidenceRefs, candidates.flatMap((candidate) => candidate.evidenceRefs)), bindingReceipts),
        filesRead,
        validationName: 'security-hunter-report',
      });

      const now = this.now();
      const findings = [...current.findings];
      const runFindingIds = [...run.findingIds];
      for (const candidate of candidates) {
        const fingerprint = findingFingerprint(candidate);
        const index = findings.findIndex((finding) => finding.auditRunId === run.id && finding.fingerprint === fingerprint);
        if (index >= 0) {
          const existing = findings[index]!;
          findings[index] = {
            ...existing,
            severity: maxSeverity(existing.severity, candidate.severity),
            evidenceRefs: union(existing.evidenceRefs, candidate.evidenceRefs),
            occurrences: existing.occurrences + 1,
            lastSeenAt: now,
          };
          continue;
        }
        const finding: SecurityFinding = {
          id: randomUUID(),
          auditRunId: run.id,
          coverageTargetId: target.id,
          fingerprint,
          title: candidate.title,
          category: candidate.category,
          severity: candidate.severity,
          location: candidate.location,
          summary: candidate.summary,
          state: 'CANDIDATE',
          hunterWorkerId: target.hunterWorkerId,
          hunterTaskId: target.hunterTaskId,
          hunterResultId: result.id,
          evidenceRefs: [...candidate.evidenceRefs],
          verificationIds: [],
          proofGateResultId: null,
          occurrences: 1,
          firstSeenAt: now,
          lastSeenAt: now,
        };
        findings.push(finding);
        runFindingIds.push(finding.id);
      }

      const updatedTarget: SecurityCoverageTarget = {
        ...target,
        status: input.coverageStatus,
        hunterResultId: result.id,
        evidenceRefs,
        updatedAt: now,
      };
      const targets = replaceById(current.coverageTargets, updatedTarget);
      const remainingCoverage = targetsForRun({ ...current, coverageTargets: targets }, run.id).some((entry) => entry.status === 'IN_PROGRESS');
      const updatedRun: SecurityAuditRun = {
        ...run,
        state: remainingCoverage ? 'HUNTING' : (runFindingIds.length > 0 ? 'VERIFYING' : 'PROOFING'),
        findingIds: runFindingIds,
        updatedAt: now,
      };
      const next = validateSecurityAuditDocument({
        ...current,
        generation: current.generation + 1,
        runs: replaceById(current.runs, updatedRun),
        coverageTargets: targets,
        findings,
      });
      await this.store.write(next, current.generation);
      return view(next, updatedRun);
    });
  }

  public recordVerifierReport(input: RecordVerifierReportInput): Promise<SecurityAuditRunView> {
    return this.serialize(async () => {
      const current = await this.store.read();
      const run = await this.assertMutableRun(current, input);
      const findingId = uuid(input.findingId, 'findingId');
      const finding = requiredFinding(current, findingId);
      if (finding.auditRunId !== run.id || !['CANDIDATE','VERIFYING','NEEDS_MORE_EVIDENCE'].includes(finding.state)) {
        throw new RuntimeError('INVALID_REQUEST', 'Finding is not eligible for independent verification');
      }
      if (!['VERIFIED','REJECTED','NEEDS_MORE_EVIDENCE'].includes(input.decision)) throw new RuntimeError('INVALID_REQUEST', 'Verifier decision is invalid');
      const rationale = bounded(input.rationale, 'rationale', 4_000);
      const evidenceRefs = strings(input.evidenceRefs, 'evidenceRefs', 128, 2_000);
      const filesRead = workspacePaths(input.filesRead, 'filesRead', 128, 2_000);
      const bindingReceipts = await this.validateEvidenceRefs(evidenceRefs, filesRead, run.projectId, run.workspaceId);
      const mwBeforeVerifier = await this.multiWorker.getRun(run.orchestrationRunId);
      if (mwBeforeVerifier.run.sessionId !== input.sessionId) {
        await this.multiWorker.rebindRunSession({
          expectedGeneration: mwBeforeVerifier.generation,
          orchestrationRunId: run.orchestrationRunId,
          sessionId: input.sessionId,
        });
      }
      const attemptId = randomUUID();
      const worker = await this.multiWorker.createWorker({
        expectedGeneration: await this.multiWorker.currentGeneration(),
        orchestrationRunId: run.orchestrationRunId,
        principalId: `security-verifier:${finding.id}:${attemptId.slice(0, 8)}`,
        workerType: 'IRIS_LOGICAL',
        role: 'QA',
      });
      if (worker.id === finding.hunterWorkerId) throw new RuntimeError('CAPABILITY_DENIED', 'Verifier must be independent from the Hunter worker');
      const task = await this.multiWorker.createTask({
        expectedGeneration: await this.multiWorker.currentGeneration(),
        orchestrationRunId: run.orchestrationRunId,
        missionTaskId: null,
        title: `Security Verifier: ${finding.title}`,
        dependencyTaskIds: [finding.hunterTaskId],
        workspaceId: run.workspaceId,
        principalId: worker.principalId,
        allowedCapabilities: READ_ONLY_CAPABILITIES,
        allowedPaths: ['**'],
        readOnlyPaths: ['**'],
        mutablePaths: [],
        allowedProcesses: [],
        approvalPolicy: 'INHERIT_MISSION',
        resourceBudget: { maxRuntimeMs: 30 * 60_000, maxJobs: 0, maxArtifacts: 32, maxOutputBytes: 2 * 1024 * 1024 },
        concurrencyPolicy: { maxParallelCapabilities: 4, mutablePathOwnership: 'READ_ONLY', allowParallelReads: true },
        expiresAt: new Date(Date.parse(this.now()) + AUDIT_WORKER_TTL_MS).toISOString(),
      });
      await this.multiWorker.assignTask({
        expectedGeneration: await this.multiWorker.currentGeneration(),
        orchestrationRunId: run.orchestrationRunId,
        taskId: task.id,
        workerId: worker.id,
        runtimeFence: this.runtimeFence(),
      });
      await this.multiWorker.startTask({
        expectedGeneration: await this.multiWorker.currentGeneration(),
        orchestrationRunId: run.orchestrationRunId,
        taskId: task.id,
        requestId: randomUUID(),
      });
      const result = await this.finalizeWorkerTask(run.orchestrationRunId, task.id, worker.id, {
        summary: rationale,
        evidenceRefs: union(evidenceRefs, bindingReceipts),
        filesRead,
        validationName: 'security-verifier-report',
      });
      const now = this.now();
      const verification: SecurityVerificationResult = {
        id: randomUUID(),
        auditRunId: run.id,
        findingId: finding.id,
        verifierWorkerId: worker.id,
        verifierTaskId: task.id,
        verifierResultId: result.id,
        decision: input.decision,
        rationale,
        evidenceRefs,
        createdAt: now,
      };
      const updatedFinding: SecurityFinding = {
        ...finding,
        state: 'VERIFYING',
        verificationIds: [...finding.verificationIds, verification.id],
        proofGateResultId: null,
        lastSeenAt: now,
      };
      const updatedRun: SecurityAuditRun = {
        ...run,
        state: 'PROOFING',
        verificationIds: [...run.verificationIds, verification.id],
        updatedAt: now,
      };
      const next = validateSecurityAuditDocument({
        ...current,
        generation: current.generation + 1,
        runs: replaceById(current.runs, updatedRun),
        findings: replaceById(current.findings, updatedFinding),
        verifications: [...current.verifications, verification],
      });
      await this.store.write(next, current.generation);
      return view(next, updatedRun);
    });
  }

  public evaluateProofGate(input: AuditIdentityInput & { readonly findingId: string }): Promise<SecurityAuditRunView> {
    return this.serialize(async () => {
      const current = await this.store.read();
      const run = await this.assertMutableRun(current, input);
      const finding = requiredFinding(current, uuid(input.findingId, 'findingId'));
      if (finding.auditRunId !== run.id) throw new RuntimeError('CAPABILITY_DENIED', 'Finding does not belong to the selected audit run');

      const satisfied: string[] = [];
      const missing: string[] = [];
      const hunterResult = await this.multiWorker.getResult(finding.hunterResultId).catch(() => null);
      const hunterEvidenceValid = hunterResult !== null
        && await this.evidenceRefsRemainValid(finding.evidenceRefs, hunterResult.filesRead, run.projectId, run.workspaceId, hunterResult.evidenceRefs);
      requirement(hunterResult?.status === 'SUCCEEDED', 'HUNTER_RESULT_SUCCEEDED', satisfied, missing);
      requirement(hunterResult?.filesChanged.length === 0, 'HUNTER_RESULT_READ_ONLY', satisfied, missing);
      requirement(hunterEvidenceValid && hasSourceEvidence(finding.evidenceRefs), 'HUNTER_EVIDENCE_PRESENT', satisfied, missing);

      const verificationId = finding.verificationIds.at(-1) ?? null;
      const verification = verificationId === null ? null : requiredVerification(current, verificationId);
      requirement(verification !== null && verification.verifierWorkerId !== finding.hunterWorkerId, 'INDEPENDENT_VERIFIER', satisfied, missing);
      const verifierResult = verification === null ? null : await this.multiWorker.getResult(verification.verifierResultId).catch(() => null);
      const verifierEvidenceValid = verification !== null && verifierResult !== null
        && await this.evidenceRefsRemainValid(verification.evidenceRefs, verifierResult.filesRead, run.projectId, run.workspaceId, verifierResult.evidenceRefs);
      requirement(verifierResult?.status === 'SUCCEEDED' && verifierResult.filesChanged.length === 0, 'VERIFIER_RESULT_READ_ONLY', satisfied, missing);
      requirement(verifierEvidenceValid && hasSourceEvidence(verification?.evidenceRefs ?? []), 'VERIFIER_EVIDENCE_PRESENT', satisfied, missing);

      let decision: SecurityVerificationDecision;
      if (missing.length > 0 || verification === null) decision = 'NEEDS_MORE_EVIDENCE';
      else if (verification.decision === 'REJECTED') decision = 'REJECTED';
      else if (verification.decision === 'NEEDS_MORE_EVIDENCE') decision = 'NEEDS_MORE_EVIDENCE';
      else decision = 'VERIFIED';

      const now = this.now();
      const gate: SecurityProofGateResult = {
        id: randomUUID(),
        auditRunId: run.id,
        findingId: finding.id,
        verificationId,
        decision,
        satisfiedRequirements: satisfied,
        missingRequirements: missing,
        evaluatedAt: now,
      };
      const state = decision === 'VERIFIED' ? 'VERIFIED' : decision === 'REJECTED' ? 'REJECTED' : 'NEEDS_MORE_EVIDENCE';
      const updatedFinding: SecurityFinding = { ...finding, state, proofGateResultId: gate.id, lastSeenAt: now };
      const updatedRun: SecurityAuditRun = {
        ...run,
        state: 'PROOFING',
        proofGateResultIds: [...run.proofGateResultIds, gate.id],
        updatedAt: now,
      };
      const next = validateSecurityAuditDocument({
        ...current,
        generation: current.generation + 1,
        runs: replaceById(current.runs, updatedRun),
        findings: replaceById(current.findings, updatedFinding),
        proofGateResults: [...current.proofGateResults, gate],
      });
      await this.store.write(next, current.generation);
      return view(next, updatedRun);
    });
  }

  public finalizeRun(input: AuditIdentityInput): Promise<SecurityAuditRunView> {
    return this.serialize(async () => {
      const current = await this.store.read();
      const run = await this.assertMutableRun(current, input);
      const targets = targetsForRun(current, run.id);
      const findings = findingsForRun(current, run.id);
      if (targets.some((target) => target.status === 'IN_PROGRESS')) throw new RuntimeError('PRECONDITION_FAILED', 'All coverage targets require a Hunter report before finalization');
      if (findings.some((finding) => finding.proofGateResultId === null)) throw new RuntimeError('PRECONDITION_FAILED', 'Every finding must pass through Proof Gate before finalization');

      await this.acceptAllWorkerResults(run.orchestrationRunId);
      const now = this.now();
      const verified = findings.filter((finding) => finding.state === 'VERIFIED');
      const rejected = findings.filter((finding) => finding.state === 'REJECTED');
      const needsMore = findings.filter((finding) => finding.state === 'NEEDS_MORE_EVIDENCE');
      const pkg: SecurityDecisionPackage = {
        id: randomUUID(),
        auditRunId: run.id,
        verifiedFindingIds: verified.map((finding) => finding.id),
        rejectedFindingIds: rejected.map((finding) => finding.id),
        needsMoreEvidenceFindingIds: needsMore.map((finding) => finding.id),
        coverageGapTargetIds: targets.filter((target) => target.status === 'GAP').map((target) => target.id),
        coverageTargetCount: targets.length,
        findingCount: findings.length,
        generatedAt: now,
      };
      let comparison: SecurityAuditComparison | null = null;
      if (run.baselineRunId !== null) comparison = buildComparison(current, run, run.baselineRunId, pkg, now);
      const updatedRun: SecurityAuditRun = {
        ...run,
        state: 'COMPLETED',
        decisionPackageId: pkg.id,
        comparisonId: comparison?.id ?? null,
        updatedAt: now,
        completedAt: now,
      };
      const next = validateSecurityAuditDocument({
        ...current,
        generation: current.generation + 1,
        runs: replaceById(current.runs, updatedRun),
        decisionPackages: [...current.decisionPackages, pkg],
        comparisons: comparison === null ? current.comparisons : [...current.comparisons, comparison],
      });
      await this.store.write(next, current.generation);
      return view(next, updatedRun);
    });
  }

  public compareRun(input: AuditIdentityInput & { readonly baselineRunId: string }): Promise<SecurityAuditComparison> {
    return this.serialize(async () => {
      const current = await this.store.read();
      const run = await this.assertCallerRun(current, input);
      if (run.state !== 'COMPLETED' || run.decisionPackageId === null) throw new RuntimeError('PRECONDITION_FAILED', 'Current audit run must be completed before comparison');
      const baselineRunId = uuid(input.baselineRunId, 'baselineRunId');
      const pkg = requiredPackage(current, run.decisionPackageId);
      const comparison = buildComparison(current, run, baselineRunId, pkg, this.now());
      const updatedRun = { ...run, comparisonId: comparison.id, updatedAt: this.now() };
      const existing = current.comparisons.filter((entry) => entry.auditRunId !== run.id);
      const next = validateSecurityAuditDocument({
        ...current,
        generation: current.generation + 1,
        runs: replaceById(current.runs, updatedRun),
        comparisons: [...existing, comparison],
      });
      await this.store.write(next, current.generation);
      return comparison;
    });
  }

  public cancelRun(input: AuditIdentityInput): Promise<SecurityAuditRunView> {
    return this.serialize(async () => {
      const current = await this.store.read();
      const run = await this.assertMutableRun(current, input);
      const mw = await this.multiWorker.getRun(run.orchestrationRunId);
      if (!['SUCCEEDED','FAILED','CANCELLED'].includes(mw.run.state)) {
        await this.multiWorker.cancelRun({ expectedGeneration: mw.generation, orchestrationRunId: run.orchestrationRunId });
      }
      const now = this.now();
      const updatedRun: SecurityAuditRun = { ...run, state: 'CANCELLED', updatedAt: now, completedAt: now };
      const next = validateSecurityAuditDocument({ ...current, generation: current.generation + 1, runs: replaceById(current.runs, updatedRun) });
      await this.store.write(next, current.generation);
      return view(next, updatedRun);
    });
  }

  public async assertMissionAuditsFinalized(missionIdInput: string): Promise<void> {
    const missionId = uuid(missionIdInput, 'missionId');
    const active = (await this.store.read()).runs.filter((run) => run.missionId === missionId && !['COMPLETED','FAILED','CANCELLED'].includes(run.state));
    if (active.length > 0) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Mission has active Security Audit Engine runs that must be finalized or cancelled');
    }
  }

  public async recover(): Promise<void> {
    return this.serialize(async () => {
      const current = await this.store.read();
      let runs = [...current.runs];
      let changed = false;
      const now = this.now();
      for (const run of current.runs) {
        if (['COMPLETED','FAILED','CANCELLED'].includes(run.state)) continue;
        try {
          const mw = await this.multiWorker.getRun(run.orchestrationRunId);
          if (mw.run.state === 'FAILED' || mw.run.state === 'CANCELLED') {
            runs = replaceById(runs, {
              ...run,
              state: mw.run.state === 'FAILED' ? 'FAILED' : 'CANCELLED',
              failureReason: mw.run.state === 'FAILED' ? 'Underlying multi-worker orchestration failed during recovery' : null,
              updatedAt: now,
              completedAt: now,
            });
            changed = true;
          }
        } catch {
          runs = replaceById(runs, {
            ...run,
            state: 'FAILED',
            failureReason: 'Underlying multi-worker orchestration is unavailable during recovery',
            updatedAt: now,
            completedAt: now,
          });
          changed = true;
        }
      }
      if (!changed) return;
      const next = validateSecurityAuditDocument({ ...current, generation: current.generation + 1, runs });
      await this.store.write(next, current.generation);
    });
  }

  private async assertMutableRun(document: SecurityAuditDocument, input: AuditIdentityInput): Promise<SecurityAuditRun> {
    const run = await this.assertCallerRun(document, input);
    if (['COMPLETED','FAILED','CANCELLED'].includes(run.state)) throw new RuntimeError('INVALID_REQUEST', 'Security audit run is terminal');
    return run;
  }

  private async assertCallerRun(document: SecurityAuditDocument, input: AuditIdentityInput): Promise<SecurityAuditRun> {
    const clientId = bounded(input.clientId, 'clientId', 200);
    const sessionId = uuid(input.sessionId, 'sessionId');
    const projectId = uuid(input.projectId, 'projectId');
    const run = requiredRun(document, uuid(input.auditRunId, 'auditRunId'));
    const session = this.state.getSessionForClient(sessionId, clientId);
    const mission = await this.state.getMission(run.missionId);
    if (run.projectId !== projectId || session.currentProjectId !== projectId
      || mission.projectId !== projectId || mission.clientId !== clientId || mission.sessionId !== sessionId) {
      throw new RuntimeError('CONTROL_DENIED', 'Security audit run does not belong to the calling mission session/project');
    }
    return run;
  }

  private async finalizeWorkerTask(
    orchestrationRunId: string,
    taskId: string,
    workerId: string,
    report: { readonly summary: string; readonly evidenceRefs: readonly string[]; readonly filesRead: readonly string[]; readonly validationName: string },
  ): Promise<WorkerResult> {
    let task = await this.multiWorker.getTask(taskId);
    if (task.state === 'RUNNING') {
      await this.multiWorker.completeTask({ expectedGeneration: await this.multiWorker.currentGeneration(), orchestrationRunId, taskId });
      task = await this.multiWorker.getTask(taskId);
    }
    if (task.state !== 'SUCCEEDED') throw new RuntimeError('PRECONDITION_FAILED', 'Security worker task is not in a successful terminal state');
    if (task.resultId !== null) return this.multiWorker.getResult(task.resultId);
    return this.multiWorker.recordResult({
      expectedGeneration: await this.multiWorker.currentGeneration(),
      orchestrationRunId,
      taskId,
      workerId,
      status: 'SUCCEEDED',
      summary: report.summary,
      evidenceRefs: report.evidenceRefs,
      artifactIds: [],
      filesRead: report.filesRead,
      filesChanged: [],
      commandsExecuted: [],
      validationResults: [{ name: report.validationName, status: 'PASSED', summary: 'Bounded read-only security worker report accepted for domain evaluation' }],
      risks: [],
      blockers: [],
      recommendedNextActions: [],
    });
  }

  private async acceptAllWorkerResults(orchestrationRunId: string): Promise<void> {
    for (;;) {
      const view = await this.multiWorker.getRun(orchestrationRunId);
      if (view.run.state === 'SUCCEEDED') return;
      if (view.run.state === 'FAILED' || view.run.state === 'CANCELLED') throw new RuntimeError('PRECONDITION_FAILED', 'Underlying multi-worker orchestration is terminal without success');
      const reviewed = new Set(view.reviews.map((review) => review.resultId));
      const result = view.results.find((candidate) => !reviewed.has(candidate.id));
      if (result === undefined) throw new RuntimeError('PRECONDITION_FAILED', 'Underlying worker results are incomplete');
      await this.multiWorker.reviewResult({
        expectedGeneration: view.generation,
        orchestrationRunId,
        resultId: result.id,
        parentOrchestratorId: view.run.parentOrchestratorId,
        basedOnRunRevision: view.run.revision,
        decision: 'ACCEPT',
        instruction: 'Security Audit Engine accepted the durable read-only worker report; finding truth remains owned by Proof Gate.',
        requestedEvidence: [],
      });
    }
  }

  private async evidenceRefsRemainValid(
    refs: readonly string[],
    filesRead: readonly string[],
    projectId: string,
    workspaceId: string,
    boundEvidenceRefs: readonly string[],
  ): Promise<boolean> {
    try {
      const currentBindingReceipts = await this.validateEvidenceRefs(refs, filesRead, projectId, workspaceId);
      return currentBindingReceipts.every((receipt) => boundEvidenceRefs.includes(receipt));
    } catch {
      return false;
    }
  }

  private async validateEvidenceRefs(
    refs: readonly string[],
    filesRead: readonly string[],
    projectId: string,
    workspaceId: string,
  ): Promise<string[]> {
    const workspace = await this.resources.getActiveWorkspace(projectId, workspaceId);
    const bindingReceipts: string[] = [];
    for (const ref of refs) {
      const parsed = parseEvidenceRef(ref);
      if (parsed.kind === 'file') {
        if (!filesRead.includes(parsed.path)) {
          throw new RuntimeError('CAPABILITY_DENIED', 'File evidence must reference a path declared in filesRead');
        }
        const sha256 = await assertFileEvidenceRange(workspace.physicalRoot, parsed);
        bindingReceipts.push(sourceEvidenceBindingReceipt(ref, sha256));
        continue;
      }
      if (parsed.kind === 'artifact') {
        const artifact = await this.resources.getArtifact(projectId, parsed.artifactId);
        if (String(artifact.workspaceId) !== workspaceId) {
          throw new RuntimeError('CAPABILITY_DENIED', 'Security evidence artifact does not belong to the audit workspace');
        }
        const sha256 = await assertArtifactEvidenceIntegrity(artifact.physicalPath, artifact.size, artifact.sha256);
        bindingReceipts.push(sourceEvidenceBindingReceipt(ref, sha256));
      }
    }
    return [...new Set(bindingReceipts)];
  }

  private runtimeFence(): WorkerRuntimeFence {
    const health = this.health();
    const full = health.tunnelBindings?.find((binding) => binding.connectorProfile === 'FULL');
    if (health.status !== 'ready' || health.machineId === undefined || full === undefined || full.deploymentEpoch <= 0 || !full.catalogHash.startsWith('sha256:')) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Security audit worker runtime/catalog fence is unavailable');
    }
    return {
      machineId: health.machineId,
      runtimeId: health.runtimeId,
      instanceId: health.instanceId,
      deploymentEpoch: full.deploymentEpoch,
      connectorProfile: 'FULL',
      catalogHash: full.catalogHash,
    };
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => work();
    const result = this.mutationTail.then(execute, execute);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private now(): string { return this.clock(); }
}

function view(document: SecurityAuditDocument, run: SecurityAuditRun): SecurityAuditRunView {
  return {
    generation: document.generation,
    run,
    coverageTargets: targetsForRun(document, run.id),
    findings: findingsForRun(document, run.id),
    verifications: document.verifications.filter((entry) => entry.auditRunId === run.id),
    proofGateResults: document.proofGateResults.filter((entry) => entry.auditRunId === run.id),
    decisionPackage: run.decisionPackageId === null ? null : requiredPackage(document, run.decisionPackageId),
    comparison: run.comparisonId === null ? null : requiredComparison(document, run.comparisonId),
  };
}

function buildComparison(
  document: SecurityAuditDocument,
  run: SecurityAuditRun,
  baselineRunId: string,
  pkg: SecurityDecisionPackage,
  now: string,
): SecurityAuditComparison {
  const baseline = requiredRun(document, uuid(baselineRunId, 'baselineRunId'));
  if (baseline.projectId !== run.projectId || baseline.id === run.id || baseline.state !== 'COMPLETED' || baseline.decisionPackageId === null) {
    throw new RuntimeError('PRECONDITION_FAILED', 'Baseline audit run is not a completed comparable run');
  }
  const currentVerified = new Set(pkg.verifiedFindingIds.map((id) => requiredFinding(document, id).fingerprint));
  const baselinePkg = requiredPackage(document, baseline.decisionPackageId);
  const baselineVerified = new Set(baselinePkg.verifiedFindingIds.map((id) => requiredFinding(document, id).fingerprint));
  return {
    id: randomUUID(),
    auditRunId: run.id,
    baselineRunId: baseline.id,
    newVerifiedFingerprints: [...currentVerified].filter((fingerprint) => !baselineVerified.has(fingerprint)).sort(),
    persistentVerifiedFingerprints: [...currentVerified].filter((fingerprint) => baselineVerified.has(fingerprint)).sort(),
    resolvedVerifiedFingerprints: [...baselineVerified].filter((fingerprint) => !currentVerified.has(fingerprint)).sort(),
    generatedAt: now,
  };
}

type ParsedEvidenceRef =
  | { readonly kind: 'file'; readonly path: string; readonly startLine: number; readonly endLine: number }
  | { readonly kind: 'artifact'; readonly artifactId: string }
  | { readonly kind: 'receipt'; readonly sha256: string };

function parseEvidenceRef(value: string): ParsedEvidenceRef {
  const file = /^file:([^#]+)#L([1-9]\d*)-L([1-9]\d*)$/.exec(value);
  if (file !== null) {
    const candidate = canonicalWorkspacePath(file[1]!, 'Security file evidence path');
    const startLine = Number(file[2]);
    const endLine = Number(file[3]);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || endLine < startLine) {
      throw new RuntimeError('INVALID_REQUEST', 'Security file evidence reference is invalid');
    }
    return { kind: 'file', path: candidate, startLine, endLine };
  }
  const artifact = /^artifact:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(value);
  if (artifact !== null) return { kind: 'artifact', artifactId: artifact[1]! };
  const receipt = /^receipt:sha256:([0-9a-f]{64})$/.exec(value);
  if (receipt !== null) return { kind: 'receipt', sha256: receipt[1]! };
  throw new RuntimeError('INVALID_REQUEST', 'Security evidence reference must be a bounded file, artifact, or SHA-256 receipt reference');
}

async function assertFileEvidenceRange(
  workspaceRoot: string,
  evidence: Extract<ParsedEvidenceRef, { readonly kind: 'file' }>,
): Promise<string> {
  const lexical = path.resolve(workspaceRoot, evidence.path);
  if (!pathIsWithin(workspaceRoot, lexical) || lexical === workspaceRoot) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Security file evidence escapes the audit workspace');
  }
  let physical: string;
  try {
    const metadata = await lstat(lexical);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('not a physical regular file');
    physical = await realpath(lexical);
  } catch (error) {
    throw new RuntimeError('PRECONDITION_FAILED', 'Security file evidence target is unavailable', { cause: error });
  }
  if (!pathIsWithin(workspaceRoot, physical)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Security file evidence resolves outside the audit workspace');
  }

  const handle = await open(physical, 'r');
  try {
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let currentLine = 1;
    let endLineExists = false;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
      for (let index = 0; index < bytesRead; index += 1) {
        if (currentLine === evidence.endLine) endLineExists = true;
        if (buffer[index] === 0x0a) currentLine += 1;
      }
    }
    if (!endLineExists) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Security file evidence line range does not exist');
    }
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

async function assertArtifactEvidenceIntegrity(physicalPath: string, expectedSize: number, expectedSha256: string): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(physicalPath);
  } catch (error) {
    throw new RuntimeError('PRECONDITION_FAILED', 'Security evidence artifact is unavailable', { cause: error });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expectedSize) {
    throw new RuntimeError('PRECONDITION_FAILED', 'Security evidence artifact no longer matches its registered metadata');
  }
  const handle = await open(physicalPath, 'r');
  try {
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const observedSha256 = digest.digest('hex');
    if (observedSha256 !== expectedSha256) {
      throw new RuntimeError('PRECONDITION_FAILED', 'Security evidence artifact hash no longer matches its registered metadata');
    }
    return observedSha256;
  } finally {
    await handle.close();
  }
}

function sourceEvidenceBindingReceipt(ref: string, sourceSha256: string): string {
  const digest = createHash('sha256').update(ref).update('\0').update(sourceSha256).digest('hex');
  return `receipt:sha256:${digest}`;
}

function hasSourceEvidence(refs: readonly string[]): boolean {
  return refs.some((ref) => {
    try { return parseEvidenceRef(ref).kind !== 'receipt'; }
    catch { return false; }
  });
}

function findingFingerprint(input: SecurityFindingCandidateInput): string {
  const canonical = [
    input.category.trim().toLowerCase(),
    input.location.trim().replace(/\s+/g, ' ').toLowerCase(),
    input.title.trim().replace(/\s+/g, ' ').toLowerCase(),
  ].join('\0');
  return createHash('sha256').update(canonical).digest('hex');
}

function normalizeCoverageInput(value: SecurityCoverageTargetInput): SecurityCoverageTargetInput {
  return {
    key: bounded(value.key, 'coverageTargets.key', 160),
    title: bounded(value.title, 'coverageTargets.title', 500),
    scope: bounded(value.scope, 'coverageTargets.scope', 2_000),
  };
}

function normalizeCandidate(value: SecurityFindingCandidateInput): SecurityFindingCandidateInput {
  if (!['LOW','MEDIUM','HIGH','CRITICAL'].includes(value.severity)) throw new RuntimeError('INVALID_REQUEST', 'Finding severity is invalid');
  return {
    title: bounded(value.title, 'finding.title', 500),
    category: bounded(value.category, 'finding.category', 200),
    severity: value.severity,
    location: bounded(value.location, 'finding.location', 1_000),
    summary: bounded(value.summary, 'finding.summary', 4_000),
    evidenceRefs: strings(value.evidenceRefs, 'finding.evidenceRefs', 128, 2_000),
  };
}

function requiredRun(document: SecurityAuditDocument, id: string): SecurityAuditRun {
  const value = document.runs.find((entry) => entry.id === id);
  if (value === undefined) throw new RuntimeError('INVALID_REQUEST', 'Security audit run was not found');
  return value;
}
function requiredTarget(document: SecurityAuditDocument, id: string): SecurityCoverageTarget {
  const value = document.coverageTargets.find((entry) => entry.id === id);
  if (value === undefined) throw new RuntimeError('INVALID_REQUEST', 'Security coverage target was not found');
  return value;
}
function requiredFinding(document: SecurityAuditDocument, id: string): SecurityFinding {
  const value = document.findings.find((entry) => entry.id === id);
  if (value === undefined) throw new RuntimeError('INVALID_REQUEST', 'Security finding was not found');
  return value;
}
function requiredVerification(document: SecurityAuditDocument, id: string): SecurityVerificationResult {
  const value = document.verifications.find((entry) => entry.id === id);
  if (value === undefined) throw new RuntimeError('INVALID_REQUEST', 'Security verification was not found');
  return value;
}
function requiredPackage(document: SecurityAuditDocument, id: string): SecurityDecisionPackage {
  const value = document.decisionPackages.find((entry) => entry.id === id);
  if (value === undefined) throw new RuntimeError('PERSISTENCE_FAILURE', 'Security decision package was not found');
  return value;
}
function requiredComparison(document: SecurityAuditDocument, id: string): SecurityAuditComparison {
  const value = document.comparisons.find((entry) => entry.id === id);
  if (value === undefined) throw new RuntimeError('PERSISTENCE_FAILURE', 'Security audit comparison was not found');
  return value;
}
function targetsForRun(document: Pick<SecurityAuditDocument, 'coverageTargets'>, runId: string): SecurityCoverageTarget[] {
  return document.coverageTargets.filter((entry) => entry.auditRunId === runId);
}
function findingsForRun(document: Pick<SecurityAuditDocument, 'findings'>, runId: string): SecurityFinding[] {
  return document.findings.filter((entry) => entry.auditRunId === runId);
}
function countCoverage(targets: readonly SecurityCoverageTarget[]): Readonly<Record<SecurityCoverageStatus, number>> {
  return {
    IN_PROGRESS: targets.filter((entry) => entry.status === 'IN_PROGRESS').length,
    COVERED: targets.filter((entry) => entry.status === 'COVERED').length,
    GAP: targets.filter((entry) => entry.status === 'GAP').length,
  };
}
function countFindings(findings: readonly SecurityFinding[]): Readonly<Record<SecurityFinding['state'], number>> {
  return {
    CANDIDATE: findings.filter((entry) => entry.state === 'CANDIDATE').length,
    VERIFYING: findings.filter((entry) => entry.state === 'VERIFYING').length,
    VERIFIED: findings.filter((entry) => entry.state === 'VERIFIED').length,
    REJECTED: findings.filter((entry) => entry.state === 'REJECTED').length,
    NEEDS_MORE_EVIDENCE: findings.filter((entry) => entry.state === 'NEEDS_MORE_EVIDENCE').length,
  };
}

function requirement(ok: boolean, name: string, satisfied: string[], missing: string[]): void { (ok ? satisfied : missing).push(name); }
function union(left: readonly string[], right: readonly string[]): string[] { return [...new Set([...left, ...right])]; }
function maxSeverity(left: SecurityFindingSeverity, right: SecurityFindingSeverity): SecurityFindingSeverity {
  const rank: Record<SecurityFindingSeverity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  return rank[right] > rank[left] ? right : left;
}
function replaceById<T extends { readonly id: string }>(values: readonly T[], value: T): T[] {
  return values.map((entry) => entry.id === value.id ? value : entry);
}
function uniqueOrThrow(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new RuntimeError('INVALID_REQUEST', `Duplicate ${label}`);
}
function workspacePaths(value: readonly string[], label: string, maxItems: number, maxLength: number): string[] {
  return strings(value, label, maxItems, maxLength).map((entry) => canonicalWorkspacePath(entry, label));
}

function canonicalWorkspacePath(value: string, label: string): string {
  const candidate = bounded(value, label, 2_000);
  const segments = candidate.split('/');
  if (path.posix.isAbsolute(candidate) || candidate.includes('\\') || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || path.posix.normalize(candidate) !== candidate) {
    throw new RuntimeError('INVALID_REQUEST', `${label} must be a canonical workspace-relative path`);
  }
  return candidate;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function strings(value: readonly string[], label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new RuntimeError('INVALID_REQUEST', `${label} is invalid`);
  const normalized = value.map((entry) => bounded(entry, label, maxLength));
  uniqueOrThrow(normalized, label);
  return normalized;
}
function bounded(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new RuntimeError('INVALID_REQUEST', `${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || normalized.includes('\0')) throw new RuntimeError('INVALID_REQUEST', `${label} is invalid`);
  return normalized;
}
function uuid(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RuntimeError('INVALID_REQUEST', `${label} must be a UUID`);
  }
  return value;
}
