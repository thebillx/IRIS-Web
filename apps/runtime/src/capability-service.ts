import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AgentRole,
  ArtifactRecord,
  ArtifactRetentionPolicy,
  ArtifactSensitivity,
  CapabilityEffect,
  CapabilityId,
  MissionExecutionAssociation,
  MissionState,
  MissionTaskState,
  OrchestratorMode,
  PermissionDecisionRecord,
  PendingApprovalView,
  PermissionMode,
  ProjectReference,
  RuntimeHealth,
  SupervisorGateState,
} from '@iris/domain';
import { RuntimeError } from '@iris/domain';
import { PermissionAuditStore } from './audit.js';
import { capabilityDefinition } from './capability-registry.js';
import { PermissionPolicyEngine, type PolicyRequest } from './permissions.js';
import { inspectProjectTarget } from './project-path.js';
import { discoverDeclaredProjectValidation, ProjectValidationJobManager } from './project-test.js';
import { ValidationCompatibilityAdapter } from './validation-compatibility.js';
import { assertExpectedEffects, deriveCapabilityEffects } from './capability-effects.js';
import { WorkspaceFilesystemEngine, type FsFindMode, type FsIgnoreMode, type FsReadMode, type FsWriteMode } from './filesystem-engine.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { DurableJobManager } from './durable-job-manager.js';
import { GovernedGitEngine, type GitCompatibilityOperation, type Phase4GitOperationName, type Phase4GitRequest } from './governed-git-engine.js';
import type { RuntimeState } from './state.js';

type Phase4GitCapabilityId = Exclude<Extract<CapabilityId, `git.${string}`>, 'git.local'>;
type Phase4GitOperationCore = Phase4GitRequest & {
  readonly capabilityId: Phase4GitCapabilityId;
  readonly clientId: string;
  readonly sessionId: string;
};

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PENDING_APPROVALS = 100;
const APPROVAL_TTL_MS = 15 * 60_000;

type CapabilityOperationCore =
  | { readonly capabilityId: 'runtime.status'; readonly clientId?: string | undefined; readonly sessionId?: string | undefined }
  | { readonly capabilityId: 'project.list'; readonly clientId?: string | undefined; readonly sessionId?: string | undefined }
  | { readonly capabilityId: 'project.info'; readonly clientId: string; readonly sessionId?: string | undefined; readonly projectId: string }
  | { readonly capabilityId: 'project.git_status'; readonly clientId: string; readonly sessionId?: string | undefined; readonly projectId?: string | undefined }
  | { readonly capabilityId: 'project.search'; readonly clientId: string; readonly sessionId?: string | undefined; readonly projectId: string; readonly query: string }
  | { readonly capabilityId: 'project.test.run'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined }
  | { readonly capabilityId: 'project.command.run'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly scriptName: string }
  | { readonly capabilityId: 'project.validation.discover'; readonly clientId: string; readonly sessionId?: string | undefined; readonly projectId: string }
  | { readonly capabilityId: 'project.validation.start'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly scriptName: string; readonly requestId: string }
  | { readonly capabilityId: 'project.validation.job.read'; readonly clientId: string; readonly sessionId?: string | undefined; readonly projectId: string; readonly jobId: string; readonly view: 'status' | 'logs' | 'result' }
  | { readonly capabilityId: 'git.local'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly operation: GitCompatibilityOperation; readonly paths?: readonly string[] | undefined; readonly message?: string | undefined }
  | { readonly capabilityId: 'remote.publish'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined }
  | { readonly capabilityId: 'mission.list'; readonly clientId?: string | undefined; readonly sessionId?: string | undefined }
  | { readonly capabilityId: 'mission.get'; readonly missionId: string; readonly clientId?: string | undefined; readonly sessionId?: string | undefined }
  | { readonly capabilityId: 'mission.create'; readonly clientId: string; readonly sessionId: string; readonly title: string; readonly orchestratorMode?: OrchestratorMode | undefined }
  | { readonly capabilityId: 'mission.state.set'; readonly clientId: string; readonly sessionId: string; readonly missionId: string; readonly state: MissionState }
  | { readonly capabilityId: 'mission.task.create'; readonly clientId: string; readonly sessionId: string; readonly missionId: string; readonly title: string }
  | { readonly capabilityId: 'mission.task.state.set'; readonly clientId: string; readonly sessionId: string; readonly missionId: string; readonly taskId: string; readonly state: MissionTaskState }
  | { readonly capabilityId: 'mission.action.prepare'; readonly clientId: string; readonly sessionId: string; readonly missionId: string; readonly taskId: string; readonly actionCapabilityId: CapabilityId; readonly summary: string }
  | { readonly capabilityId: 'mission.supervisor_gate.set'; readonly clientId: string; readonly sessionId: string; readonly missionId: string; readonly state: SupervisorGateState; readonly reason: string | null }
  | { readonly capabilityId: 'session.create'; readonly clientId?: string | undefined; readonly agentId?: string | undefined; readonly agentRole?: AgentRole | undefined }
  | { readonly capabilityId: 'session.delete'; readonly clientId: string; readonly sessionId: string }
  | { readonly capabilityId: 'session.current_project.set'; readonly clientId: string; readonly sessionId: string; readonly projectId: string | null }
  | { readonly capabilityId: 'session.instruction.submit'; readonly clientId: string; readonly sessionId: string; readonly submissionId: string; readonly instruction: string }
  | { readonly capabilityId: 'project.register'; readonly name: string; readonly rootPath: string; readonly clientId?: string | undefined; readonly sessionId?: string | undefined }
  | { readonly capabilityId: 'project.default.set'; readonly projectId: string | null; readonly clientId?: string | undefined; readonly sessionId?: string | undefined }
  | { readonly capabilityId: 'file.read'; readonly clientId: string; readonly sessionId?: string | undefined; readonly projectId?: string | undefined; readonly targetPath: string }
  | { readonly capabilityId: 'file.write'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string; readonly content: string }
  | { readonly capabilityId: 'file.edit'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string; readonly find: string; readonly replace: string; readonly expectedSha256: string; readonly dryRun?: boolean | undefined }
  | { readonly capabilityId: 'file.delete'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string }
  | { readonly capabilityId: 'directory.create'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string }
  | { readonly capabilityId: 'directory.delete'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string }
  | { readonly capabilityId: 'workspace.list'; readonly clientId: string; readonly sessionId: string; readonly projectId: string }
  | { readonly capabilityId: 'workspace.get'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string }
  | { readonly capabilityId: 'workspace.create_scratch'; readonly clientId: string; readonly sessionId: string; readonly projectId: string }
  | { readonly capabilityId: 'workspace.revoke_scratch'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string }
  | { readonly capabilityId: 'fs.list'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly path: string; readonly recursive?: boolean; readonly maxDepth?: number; readonly maxEntries?: number; readonly cursor?: string; readonly ignoreMode?: FsIgnoreMode; readonly includeHidden?: boolean }
  | { readonly capabilityId: 'fs.stat'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly path: string }
  | { readonly capabilityId: 'fs.read'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly path: string; readonly mode: FsReadMode; readonly maxBytes?: number; readonly encoding?: 'utf-8'; readonly offset?: number; readonly length?: number }
  | { readonly capabilityId: 'fs.write'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly path: string; readonly mode: FsWriteMode; readonly content: string; readonly expectedSize?: number; readonly expectedSha256?: string }
  | { readonly capabilityId: 'fs.edit'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly path: string; readonly find: string; readonly replace: string; readonly expectedSha256: string; readonly dryRun?: boolean }
  | { readonly capabilityId: 'fs.mkdir'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly path: string }
  | { readonly capabilityId: 'fs.delete'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly path: string }
  | { readonly capabilityId: 'fs.hash'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly path: string }
  | { readonly capabilityId: 'fs.find'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly root: string; readonly query: string; readonly mode?: FsFindMode; readonly maxDepth?: number; readonly maxResults?: number; readonly cursor?: string; readonly ignoreMode?: FsIgnoreMode; readonly includeHidden?: boolean }
  | { readonly capabilityId: 'artifact.stat'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly artifactId: string }
  | { readonly capabilityId: 'artifact.open_ref'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly artifactId: string }
  | { readonly capabilityId: 'artifact.register_existing'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly path: string; readonly mime: string; readonly artifactType: string; readonly sensitivity: ArtifactSensitivity; readonly retentionPolicy: ArtifactRetentionPolicy }
  | { readonly capabilityId: 'artifact.release'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly artifactId: string }
  | { readonly capabilityId: 'shell.run'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly executable: string; readonly argv: readonly string[]; readonly cwd: string; readonly executionProfile: string; readonly envOverrides: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly stdinArtifactId?: string | undefined }
  | { readonly capabilityId: 'shell.start'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly workspaceId: string; readonly executable: string; readonly argv: readonly string[]; readonly cwd: string; readonly executionProfile: string; readonly envOverrides: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly requestId: string; readonly stdinArtifactId?: string | undefined }
  | { readonly capabilityId: 'job.status'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly jobId: string }
  | { readonly capabilityId: 'job.logs'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly jobId: string; readonly stream: 'stdout' | 'stderr'; readonly cursor?: string | undefined; readonly maxBytes?: number | undefined }
  | { readonly capabilityId: 'job.result'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly jobId: string }
  | { readonly capabilityId: 'job.cancel'; readonly clientId: string; readonly sessionId: string; readonly projectId: string; readonly jobId: string }
  | Phase4GitOperationCore
  | { readonly capabilityId: 'policy.mode.set'; readonly mode: PermissionMode; readonly clientId?: string | undefined; readonly sessionId?: string | undefined };

export type CapabilityOperation = CapabilityOperationCore & {
  readonly mission?: MissionExecutionAssociation | undefined;
  readonly expectedEffects?: readonly string[] | undefined;
};

export type OwnerApprovalChoice = 'ALLOW_ONCE' | 'ALWAYS_ALLOW_PROJECT' | 'DENY';

export type CapabilityOutcome =
  | { readonly status: 'executed'; readonly value: unknown }
  | { readonly status: 'owner_required'; readonly approval: PendingApprovalView }
  | { readonly status: 'denied'; readonly reason: string };

interface PendingApprovalInternal {
  readonly view: PendingApprovalView;
  readonly operation: CapabilityOperation;
  readonly expiresAt: number;
}

interface Phase2Preflight {
  readonly workspaceId: string | null;
  readonly resourceId: string | null;
  readonly target: string | null;
}

export class CapabilityService {
  private readonly pending = new Map<string, PendingApprovalInternal>();
  private missionActionTail: Promise<void> = Promise.resolve();
  private validationCompatibilityAdapter: ValidationCompatibilityAdapter | undefined;
  private resources: VNextResourceRegistry | undefined;
  private jobs: DurableJobManager | undefined;

  public constructor(
    private readonly state: RuntimeState,
    private readonly policy: PermissionPolicyEngine,
    private readonly audit: PermissionAuditStore,
    private readonly health: () => RuntimeHealth,
    private readonly validationJobs: ProjectValidationJobManager = new ProjectValidationJobManager(),
    resources?: VNextResourceRegistry,
    jobs?: DurableJobManager,
  ) {
    this.resources = resources;
    this.jobs = jobs;
  }

  public permissionSnapshot() {
    return this.policy.snapshot();
  }

  public recentAudit(limit?: number) {
    return this.audit.recent(limit);
  }

  public listPendingApprovals(): readonly PendingApprovalView[] {
    this.pruneExpiredApprovals();
    return [...this.pending.values()].map((entry) => entry.view);
  }

  public execute(operation: CapabilityOperation): Promise<CapabilityOutcome> {
    if (operation.mission === undefined) return this.executeGoverned(operation);
    const result = this.missionActionTail.then(() => this.executeGoverned(operation), () => this.executeGoverned(operation));
    this.missionActionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async executeGoverned(operation: CapabilityOperation): Promise<CapabilityOutcome> {
    const association = operation.mission;
    if (association !== undefined) {
      if (!isMissionExecutableOperation(operation)) throw new RuntimeError('CAPABILITY_DENIED', 'Mission action association is not supported for this capability');
      await this.state.validateMissionActionAssociation(association, operation.capabilityId, operation.clientId, operation.sessionId);
    }
    const decision = await this.evaluateOperation(operation);
    if (decision.decision === 'DENY') {
      await this.audit.append(decision, 'DENIED');
      if (association !== undefined) await this.state.markMissionActionDenied(association, decision.reason);
      return { status: 'denied', reason: decision.reason };
    }
    if (decision.decision === 'OWNER_REQUIRED') {
      const approval = this.queueApproval(operation, decision);
      try {
        if (association !== undefined) await this.state.markMissionActionApprovalRequired(association, approval.id);
      } catch (error) {
        this.pending.delete(approval.id);
        throw error;
      }
      await this.audit.append(decision, 'PENDING');
      return { status: 'owner_required', approval };
    }
    await this.audit.append(decision, 'DECISION');
    return this.executeAndAudit(operation, decision);
  }

  public resolveApproval(id: string, choice: OwnerApprovalChoice): Promise<CapabilityOutcome> {
    this.pruneExpiredApprovals();
    const pending = this.pending.get(id);
    if (pending?.operation.mission === undefined) return this.resolveApprovalGoverned(id, choice, 'approval-center');
    const result = this.missionActionTail.then(
      () => this.resolveApprovalGoverned(id, choice, 'approval-center'),
      () => this.resolveApprovalGoverned(id, choice, 'approval-center'),
    );
    this.missionActionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  public resolveOriginatingOwnerApproval(input: Readonly<{
    id: string;
    choice: 'ALLOW_ONCE' | 'DENY';
    clientId: string;
    sessionId: string;
    missionId: string;
    taskId: string;
    actionId: string;
    capabilityId: string;
    exactAction: string;
  }>): Promise<CapabilityOutcome> {
    const result = this.missionActionTail.then(
      () => this.resolveOriginatingOwnerApprovalGoverned(input),
      () => this.resolveOriginatingOwnerApprovalGoverned(input),
    );
    this.missionActionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async resolveOriginatingOwnerApprovalGoverned(input: Readonly<{
    id: string;
    choice: 'ALLOW_ONCE' | 'DENY';
    clientId: string;
    sessionId: string;
    missionId: string;
    taskId: string;
    actionId: string;
    capabilityId: string;
    exactAction: string;
  }>): Promise<CapabilityOutcome> {
    this.pruneExpiredApprovals();
    const pending = this.pending.get(input.id);
    if (pending === undefined) throw new RuntimeError('APPROVAL_NOT_FOUND', 'Pending approval was not found or has expired');
    if (pending.operation.mission === undefined) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Originating-session approval requires a prepared mission action');
    }
    if (pending.operation.mission.orchestratorMode !== 'CHATGPT') {
      throw new RuntimeError('CAPABILITY_DENIED', 'Originating-session approval is available only for CHATGPT-orchestrated mission actions');
    }

    const session = this.state.getSessionForClient(input.sessionId, input.clientId);
    if (session.agentRole !== 'owner') {
      throw new RuntimeError('CONTROL_DENIED', 'Only the authenticated originating owner session can resolve this approval');
    }
    if (pending.view.clientId !== input.clientId || pending.view.sessionId !== input.sessionId) {
      throw new RuntimeError('CONTROL_DENIED', 'Pending approval belongs to a different client/session');
    }
    if (pending.view.missionId !== input.missionId
      || pending.view.taskId !== input.taskId
      || pending.view.actionId !== input.actionId
      || pending.operation.mission.missionId !== input.missionId
      || pending.operation.mission.taskId !== input.taskId
      || pending.operation.mission.actionId !== input.actionId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Pending approval mission/task/action identity does not match');
    }
    if (pending.view.capabilityId !== input.capabilityId || pending.view.exactAction !== input.exactAction) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Pending approval capability or exact action does not match');
    }

    const claimed = this.claimPendingApproval(input.id);
    return this.resolveClaimedApproval(claimed, input.choice, 'originating-owner-session');
  }

  private async resolveApprovalGoverned(
    id: string,
    choice: OwnerApprovalChoice,
    source: 'approval-center' | 'originating-owner-session',
  ): Promise<CapabilityOutcome> {
    return this.resolveClaimedApproval(this.claimPendingApproval(id), choice, source);
  }

  private async resolveClaimedApproval(
    pending: PendingApprovalInternal,
    choice: OwnerApprovalChoice,
    source: 'approval-center' | 'originating-owner-session',
  ): Promise<CapabilityOutcome> {
    if (choice === 'DENY') {
      const denied: PermissionDecisionRecord = {
        ...pending.view,
        timestamp: new Date().toISOString(),
        decision: 'DENY',
        reason: source === 'originating-owner-session'
          ? 'Owner denied the pending exact action through the authenticated originating MCP session'
          : 'Owner denied the pending exact action',
      };
      await this.audit.append(denied, 'DENIED');
      if (pending.operation.mission !== undefined) await this.state.markMissionActionDenied(pending.operation.mission, denied.reason);
      return { status: 'denied', reason: denied.reason };
    }
    if (pending.operation.mission !== undefined) {
      if (pending.view.clientId === null || pending.view.sessionId === null) throw new RuntimeError('CAPABILITY_DENIED', 'Mission approval lost its originating client/session identity');
      await this.state.validateMissionApprovalAssociation(pending.operation.mission, pending.operation.capabilityId, pending.view.clientId, pending.view.sessionId, pending.view.id);
    }
    const reevaluated = await this.evaluateOperation(pending.operation);
    if (reevaluated.decision === 'DENY'
      || reevaluated.capabilityId !== pending.view.capabilityId
      || reevaluated.projectId !== pending.view.projectId
      || reevaluated.target !== pending.view.target
      || reevaluated.workspaceId !== pending.view.workspaceId
      || reevaluated.resourceId !== pending.view.resourceId
      || !sameEffects(reevaluated.effectiveEffects, pending.view.effectiveEffects)) {
      const denied: PermissionDecisionRecord = {
        ...reevaluated,
        timestamp: new Date().toISOString(),
        decision: 'DENY',
        reason: reevaluated.decision === 'DENY' ? reevaluated.reason : 'Pending action changed or became ineligible before owner approval was applied',
      };
      await this.audit.append(denied, 'DENIED');
      if (pending.operation.mission !== undefined) await this.state.markMissionActionDenied(pending.operation.mission, denied.reason);
      return { status: 'denied', reason: denied.reason };
    }
    if (choice === 'ALWAYS_ALLOW_PROJECT') {
      if (!pending.view.canAlwaysAllowProject || pending.view.projectId === null || capabilityDefinition(pending.view.capabilityId)?.requiredScope !== 'PROJECT') {
        throw new RuntimeError('CAPABILITY_DENIED', 'This approval cannot create a persistent project-scoped policy override');
      }
      const definition = capabilityDefinition(pending.view.capabilityId);
      if (definition === null) throw new RuntimeError('CAPABILITY_DENIED', 'Pending capability is no longer registered');
      await this.policy.addProjectOverride(pending.view.projectId, definition.id);
    }
    const approved: PermissionDecisionRecord = {
      ...reevaluated,
      timestamp: new Date().toISOString(),
      decision: 'ALLOW_ONCE',
      reason: choice === 'ALWAYS_ALLOW_PROJECT'
        ? 'Owner approved this exact action and added the matching project-scoped policy override'
        : source === 'originating-owner-session'
          ? 'Owner approved this exact action once through the authenticated originating MCP session'
          : 'Owner approved this exact action once',
    };
    await this.audit.append(approved, 'DECISION');
    return this.executeAndAudit(pending.operation, approved);
  }

  private async evaluateOperation(operation: CapabilityOperation): Promise<PermissionDecisionRecord> {
    const request = requestForOperation(operation);
    if (isPhase4GitOperation(operation)) {
      if (operation.capabilityId !== phase4GitCapabilityId(operation.operation)) {
        const base = await this.policy.evaluate(request);
        return {
          ...base,
          decision: 'DENY',
          reason: 'GIT_OPERATION_CAPABILITY_MISMATCH: grouped Git operation does not match its granular server capabilityId',
          decisionCode: 'UNKNOWN_EFFECT',
          effectiveEffects: [],
        };
      }
      const effectiveEffects = deriveCapabilityEffects(operation.capabilityId, { operation: operation.operation });
      if (effectiveEffects === null) {
        const base = await this.policy.evaluate(request);
        return {
          ...base,
          decision: 'DENY',
          reason: capabilityDefinition(operation.capabilityId) === null
            ? 'UNKNOWN_CAPABILITY: server has no registered capability/effect derivation'
            : 'UNKNOWN_EFFECT: server cannot derive a trusted effect set for this operation',
          decisionCode: capabilityDefinition(operation.capabilityId) === null ? 'UNKNOWN_CAPABILITY' : 'UNKNOWN_EFFECT',
          effectiveEffects: [],
        };
      }
      const policyDecision = await this.policy.evaluate({ ...request, effectiveEffects });
      const assertion = assertExpectedEffects(effectiveEffects, operation.expectedEffects);
      if (!assertion.valid) return { ...policyDecision, decision: 'DENY', reason: assertion.reason, decisionCode: assertion.code, effectiveEffects };
      if (policyDecision.decision === 'DENY') return { ...policyDecision, effectiveEffects, decisionCode: 'POLICY_DENIED' };
      const base = decorateDecision(policyDecision, await this.phase4GitPreflight(operation));
      return { ...base, effectiveEffects, decisionCode: null };
    }

    const preflight = isPhase3Operation(operation)
      ? await this.phase3Preflight(operation)
      : await this.phase2Preflight(operation);
    const operationName = operation.capabilityId === 'git.local'
      ? operation.operation
      : operation.capabilityId === 'fs.write'
        ? operation.mode
        : undefined;
    const effectiveEffects = deriveCapabilityEffects(operation.capabilityId, {
      operation: operationName,
      ...(operation.capabilityId === 'shell.run' || operation.capabilityId === 'shell.start' ? { executionProfile: operation.executionProfile } : {}),
    });
    if (effectiveEffects === null) {
      const base = await this.policy.evaluate(request);
      return decorateDecision({
        ...base,
        decision: 'DENY',
        reason: capabilityDefinition(operation.capabilityId) === null
          ? 'UNKNOWN_CAPABILITY: server has no registered capability/effect derivation'
          : 'UNKNOWN_EFFECT: server cannot derive a trusted effect set for this operation',
        decisionCode: capabilityDefinition(operation.capabilityId) === null ? 'UNKNOWN_CAPABILITY' : 'UNKNOWN_EFFECT',
        effectiveEffects: [],
      }, preflight);
    }
    const base = decorateDecision(await this.policy.evaluate({ ...request, effectiveEffects }), preflight);
    const assertion = assertExpectedEffects(effectiveEffects, operation.expectedEffects);
    if (!assertion.valid) return { ...base, decision: 'DENY', reason: assertion.reason, decisionCode: assertion.code, effectiveEffects };
    return { ...base, effectiveEffects, decisionCode: base.decision === 'DENY' ? 'POLICY_DENIED' : null };
  }

  private async phase2Preflight(operation: CapabilityOperation): Promise<Phase2Preflight | null> {
    if (!isPhase2Operation(operation)) return null;
    await this.authorizedProject(operation);
    const resources = this.resourceRegistry();
    const fs = new WorkspaceFilesystemEngine(resources);
    if (operation.capabilityId === 'workspace.list' || operation.capabilityId === 'workspace.create_scratch') return { workspaceId: null, resourceId: null, target: null };
    if (operation.capabilityId === 'workspace.get' || operation.capabilityId === 'workspace.revoke_scratch') {
      const workspace = operation.capabilityId === 'workspace.get'
        ? await resources.getWorkspace(operation.projectId, operation.workspaceId)
        : await resources.getActiveWorkspace(operation.projectId, operation.workspaceId);
      return { workspaceId: workspace.workspaceId, resourceId: workspace.workspaceId, target: workspace.physicalRoot };
    }
    if (operation.capabilityId === 'artifact.stat' || operation.capabilityId === 'artifact.open_ref') {
      const artifact = await resources.getArtifact(operation.projectId, operation.artifactId);
      return { workspaceId: artifact.workspaceId, resourceId: artifact.artifactId, target: artifact.physicalPath };
    }
    if (operation.capabilityId === 'artifact.release') return { workspaceId: null, resourceId: operation.artifactId, target: null };
    if (operation.capabilityId === 'artifact.register_existing') {
      const resolved = await fs.resolveTarget(operation.projectId, operation.workspaceId, operation.path, 'file-content');
      return { workspaceId: resolved.workspace.workspaceId, resourceId: null, target: resolved.absolutePath };
    }
    const resolved = await resolveFsPreflight(fs, operation);
    return { workspaceId: resolved.workspace.workspaceId, resourceId: null, target: resolved.absolutePath };
  }

  private async phase3Preflight(operation: Phase3Operation): Promise<Phase2Preflight> {
    await this.authorizedProject(operation);
    if (operation.capabilityId === 'shell.run' || operation.capabilityId === 'shell.start') {
      const prepared = await this.jobManager().prepare(shellExecutionInput(operation));
      return {
        workspaceId: prepared.workspaceId,
        resourceId: null,
        target: prepared.plan.executableIdentity,
      };
    }
    return { workspaceId: null, resourceId: operation.jobId, target: null };
  }

  private async phase4GitPreflight(operation: Phase4GitOperation): Promise<Phase2Preflight> {
    await this.authorizedProject(operation);
    const preflight = await this.gitEngine().preflight(operation);
    return {
      workspaceId: preflight.workspaceId,
      resourceId: preflight.repositoryId,
      target: preflight.target,
    };
  }

  private claimPendingApproval(id: string): PendingApprovalInternal {
    this.pruneExpiredApprovals();
    const pending = this.pending.get(id);
    if (pending === undefined || !this.pending.delete(id)) throw new RuntimeError('APPROVAL_NOT_FOUND', 'Pending approval was not found or has expired');
    return pending;
  }

  private queueApproval(operation: CapabilityOperation, record: PermissionDecisionRecord): PendingApprovalView {
    this.pruneExpiredApprovals();
    if (this.pending.size >= MAX_PENDING_APPROVALS) throw new RuntimeError('OWNER_DECISION_REQUIRED', 'Approval Center queue is full; no action was executed');
    const definition = capabilityDefinition(record.capabilityId);
    const view: PendingApprovalView = {
      ...record,
      id: randomUUID(),
      exactAction: describeOperation(operation),
      canAlwaysAllowProject: record.projectId !== null && definition?.riskClass === 'MODERATE' && definition.requiredScope === 'PROJECT',
    };
    this.pending.set(view.id, { view, operation, expiresAt: Date.now() + APPROVAL_TTL_MS });
    return view;
  }

  private pruneExpiredApprovals(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(id);
  }

  private async executeAndAudit(operation: CapabilityOperation, decision: PermissionDecisionRecord): Promise<CapabilityOutcome> {
    const association = operation.mission;
    if (association !== undefined) await this.state.markMissionActionStarted(association);
    let value: unknown;
    try {
      value = await this.executeAuthorized(operation, decision);
    } catch (error) {
      await this.audit.append(decision, 'FAILED');
      if (association !== undefined) await this.state.markMissionActionFailed(association);
      throw error;
    }
    await this.audit.append(decision, 'SUCCESS');
    if (association !== undefined) await this.state.markMissionActionSucceeded(association, operation.capabilityId, value, decision.effectiveEffects ?? []);
    return { status: 'executed', value };
  }

  private async executeAuthorized(operation: CapabilityOperation, decision: PermissionDecisionRecord): Promise<unknown> {
    if (isPhase4GitOperation(operation)) {
      await this.authorizedProject(operation);
      return this.gitEngine().execute(operation, operation.mission?.actionId ?? null);
    }
    if (isPhase3Operation(operation)) {
      await this.authorizedProject(operation);
      return this.executePhase3(operation, decision);
    }
    if (isPhase2Operation(operation)) {
      await this.authorizedProject(operation);
      return this.executePhase2(operation);
    }
    if (operation.capabilityId === 'runtime.status') return this.health();
    if (operation.capabilityId === 'project.list') return { projects: await this.state.listProjects(), defaultProjectId: await this.state.getDefaultProjectId() };
    if (operation.capabilityId === 'project.info') {
      const project = await this.authorizedProject(operation);
      return { id: project.id, name: project.name, rootPath: project.rootPath, isDefault: project.id === await this.state.getDefaultProjectId() };
    }
    if (operation.capabilityId === 'project.git_status') {
      const project = await this.authorizedProject(operation);
      const workspace = await this.resourceRegistry().primaryWorkspace(project.id);
      return this.gitEngine().compatibilityProjectStatus(project.id, workspace.workspaceId);
    }
    if (operation.capabilityId === 'project.search') {
      const project = await this.authorizedProject(operation);
      const resources = this.resourceRegistry();
      const workspace = await resources.primaryWorkspace(project.id);
      return new WorkspaceFilesystemEngine(resources).compatibilityTextSearch(project.id, workspace.workspaceId, operation.query);
    }
    if (operation.capabilityId === 'project.test.run') {
      const project = await this.authorizedProject(operation);
      return this.validationCompatibility().run(project, 'test', decision.effectiveEffects ?? [], operation.mission);
    }
    if (operation.capabilityId === 'project.command.run') {
      const project = await this.authorizedProject(operation);
      return this.validationCompatibility().run(project, operation.scriptName, decision.effectiveEffects ?? [], operation.mission);
    }
    if (operation.capabilityId === 'project.validation.discover') return discoverDeclaredProjectValidation((await this.authorizedProject(operation)).rootPath);
    if (operation.capabilityId === 'project.validation.start') {
      const project = await this.authorizedProject(operation);
      return this.validationCompatibility().start(project, operation.scriptName, operation.requestId, decision.effectiveEffects ?? [], operation.mission);
    }
    if (operation.capabilityId === 'project.validation.job.read') {
      const project = await this.authorizedProject(operation);
      return this.validationCompatibility().read(project, operation.jobId, operation.view);
    }
    if (operation.capabilityId === 'git.local') {
      const project = await this.authorizedProject(operation);
      const workspace = await this.resourceRegistry().primaryWorkspace(project.id);
      return this.gitEngine().compatibilityLocal(project.id, workspace.workspaceId, {
        operation: operation.operation,
        ...(operation.paths === undefined ? {} : { paths: operation.paths }),
        ...(operation.message === undefined ? {} : { message: operation.message }),
      });
    }
    if (operation.capabilityId === 'remote.publish') {
      const project = await this.authorizedProject(operation);
      const workspace = await this.resourceRegistry().primaryWorkspace(project.id);
      return this.gitEngine().compatibilityRemotePublish(project.id, workspace.workspaceId);
    }
    if (operation.capabilityId === 'mission.list') return { missions: await this.state.listMissions() };
    if (operation.capabilityId === 'mission.get') return this.state.getMission(operation.missionId);
    if (operation.capabilityId === 'mission.create') return this.state.createMission(operation.clientId, operation.sessionId, operation.title, operation.orchestratorMode ?? 'HERMES');
    if (operation.capabilityId === 'mission.state.set') return this.state.setMissionState(operation.missionId, operation.clientId, operation.sessionId, operation.state);
    if (operation.capabilityId === 'mission.task.create') return this.state.createMissionTask(operation.missionId, operation.clientId, operation.sessionId, operation.title);
    if (operation.capabilityId === 'mission.task.state.set') return this.state.setMissionTaskState(operation.missionId, operation.taskId, operation.clientId, operation.sessionId, operation.state);
    if (operation.capabilityId === 'mission.action.prepare') {
      if (!missionExecutionCapability(operation.actionCapabilityId)) throw new RuntimeError('CAPABILITY_DENIED', 'Mission action capability is not exposed for governed mission execution');
      return this.state.prepareMissionAction(operation.missionId, operation.taskId, operation.clientId, operation.sessionId, operation.actionCapabilityId, operation.summary);
    }
    if (operation.capabilityId === 'mission.supervisor_gate.set') return this.state.setMissionSupervisorGate(operation.missionId, operation.clientId, operation.sessionId, operation.state, operation.reason);
    if (operation.capabilityId === 'session.create') return this.state.createSession(operation.clientId, operation.agentId, operation.agentRole);
    if (operation.capabilityId === 'session.delete') { this.state.deleteSession(operation.sessionId, operation.clientId); return { deleted: true }; }
    if (operation.capabilityId === 'session.current_project.set') return this.state.setSessionCurrentProject(operation.sessionId, operation.clientId, operation.projectId);
    if (operation.capabilityId === 'session.instruction.submit') return this.state.submitInstruction(operation.sessionId, operation.clientId, operation.submissionId, operation.instruction);
    if (operation.capabilityId === 'project.register') {
      if (decision.target === null) throw new RuntimeError('CAPABILITY_DENIED', 'Approved project registration lost its canonical physical target');
      return this.state.registerCanonicalProject(operation.name, decision.target);
    }
    if (operation.capabilityId === 'project.default.set') { await this.state.setDefaultProject(operation.projectId); return { defaultProjectId: operation.projectId }; }
    if (operation.capabilityId === 'policy.mode.set') { await this.policy.setMode(operation.mode); return { mode: operation.mode }; }

    const project = await this.authorizedProject(operation);
    if (operation.capabilityId === 'file.read') {
      const target = await this.legacyPrimaryFsTarget(project, operation.targetPath, 'file-read');
      const result = await target.fs.readText(project.id, target.workspaceId, target.relativePath, MAX_FILE_BYTES, 'utf-8');
      return { targetPath: target.absolutePath, content: result.text };
    }
    if (operation.capabilityId === 'file.write') {
      const bytes = Buffer.byteLength(operation.content, 'utf8');
      if (bytes > MAX_FILE_BYTES) throw new RuntimeError('CAPABILITY_DENIED', 'File write exceeds the V1 local capability size limit');
      const target = await this.legacyPrimaryFsTarget(project, operation.targetPath, 'file-write');
      let writtenBytes: number;
      try {
        const created = await target.fs.write(project.id, target.workspaceId, target.relativePath, 'CREATE', operation.content);
        if (!('bytes' in created)) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace CREATE returned an invalid compatibility result');
        writtenBytes = created.bytes;
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.code !== 'PRECONDITION_FAILED') throw error;
        const metadata = await target.fs.stat(project.id, target.workspaceId, target.relativePath);
        if (metadata.type !== 'file' || metadata.symlink || metadata.hardLinkCount !== 1) {
          throw new RuntimeError('CAPABILITY_DENIED', 'Legacy file.write replacement target is not one physical regular file', { cause: error });
        }
        const replaced = await target.fs.write(project.id, target.workspaceId, target.relativePath, 'REPLACE', operation.content);
        if (!('bytes' in replaced)) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace REPLACE returned an invalid compatibility result');
        writtenBytes = replaced.bytes;
      }
      if (writtenBytes !== bytes) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace file write byte count did not match the approved exact action');
      return { targetPath: target.absolutePath, bytes };
    }
    if (operation.capabilityId === 'file.edit') {
      if (Buffer.byteLength(operation.find, 'utf8') === 0 || Buffer.byteLength(operation.find, 'utf8') > MAX_FILE_BYTES || Buffer.byteLength(operation.replace, 'utf8') > MAX_FILE_BYTES || !/^[0-9a-f]{64}$/i.test(operation.expectedSha256)) throw new RuntimeError('CAPABILITY_DENIED', 'File edit requires bounded UTF-8 text and a SHA-256 precondition');
      const target = await this.legacyPrimaryFsTarget(project, operation.targetPath, 'file-edit');
      const result = await target.fs.edit(project.id, target.workspaceId, target.relativePath, operation.find, operation.replace, operation.expectedSha256, operation.dryRun ?? false);
      return {
        targetPath: target.absolutePath,
        changed: result.changed,
        beforeSha256: result.beforeSha256,
        afterSha256: result.afterSha256,
        bytesBefore: result.bytesBefore,
        bytesAfter: result.bytesAfter,
        matchCount: result.matchCount,
        dryRun: result.dryRun,
        summary: result.changed ? 'One exact text occurrence is ready or was replaced' : 'The exact edit produced no byte change',
      };
    }
    if (operation.capabilityId === 'file.delete') {
      const target = await this.legacyPrimaryFsTarget(project, operation.targetPath, 'file-delete');
      const result = await target.fs.delete(project.id, target.workspaceId, target.relativePath);
      return { targetPath: target.absolutePath, deleted: result.deleted === true };
    }
    if (operation.capabilityId === 'directory.create') {
      const target = await this.legacyPrimaryFsTarget(project, operation.targetPath, 'directory-create');
      try {
        const result = await target.fs.mkdir(project.id, target.workspaceId, target.relativePath);
        return { targetPath: target.absolutePath, created: result.created === true };
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.code !== 'PRECONDITION_FAILED') throw error;
        const metadata = await target.fs.stat(project.id, target.workspaceId, target.relativePath);
        if (metadata.type !== 'directory' || metadata.symlink) throw error;
        return { targetPath: target.absolutePath, created: false };
      }
    }
    if (operation.capabilityId === 'directory.delete') {
      const target = await this.legacyPrimaryFsTarget(project, operation.targetPath, 'directory-delete');
      const result = await target.fs.delete(project.id, target.workspaceId, target.relativePath);
      return { targetPath: target.absolutePath, deleted: result.deleted === true };
    }
    throw new RuntimeError('CAPABILITY_DENIED', 'Capability execution is not implemented');
  }

  private async executePhase3(operation: Phase3Operation, decision: PermissionDecisionRecord): Promise<unknown> {
    const jobs = this.jobManager();
    if (operation.capabilityId === 'shell.run' || operation.capabilityId === 'shell.start') {
      const prepared = await jobs.prepare(shellExecutionInput(operation));
      const effects = decision.effectiveEffects ?? [];
      if (operation.capabilityId === 'shell.run') return jobs.run(prepared, effects, operation.mission);
      return jobs.start(prepared, operation.requestId, effects, operation.mission);
    }
    if (operation.capabilityId === 'job.status') return jobs.status(operation.projectId, operation.jobId);
    if (operation.capabilityId === 'job.logs') return jobs.logs(operation.projectId, operation.jobId, operation.stream, operation.cursor, operation.maxBytes);
    if (operation.capabilityId === 'job.result') return jobs.result(operation.projectId, operation.jobId);
    if (operation.capabilityId === 'job.cancel') return jobs.cancel(operation.projectId, operation.jobId);
    throw new RuntimeError('CAPABILITY_DENIED', 'Phase 3 capability execution is not implemented');
  }

  private async executePhase2(operation: Phase2Operation): Promise<unknown> {
    const resources = this.resourceRegistry();
    const fs = new WorkspaceFilesystemEngine(resources);
    if (operation.capabilityId === 'workspace.list') return { workspaces: await resources.listWorkspaces(operation.projectId) };
    if (operation.capabilityId === 'workspace.get') return resources.getWorkspace(operation.projectId, operation.workspaceId);
    if (operation.capabilityId === 'workspace.create_scratch') return resources.createScratch(operation.projectId, operation.mission?.actionId ?? null);
    if (operation.capabilityId === 'workspace.revoke_scratch') return resources.revokeScratch(operation.projectId, operation.workspaceId);
    if (operation.capabilityId === 'fs.list') return fs.list(operation.projectId, operation.workspaceId, operation.path, {
      ...(operation.recursive === undefined ? {} : { recursive: operation.recursive }),
      ...(operation.maxDepth === undefined ? {} : { maxDepth: operation.maxDepth }),
      ...(operation.maxEntries === undefined ? {} : { maxEntries: operation.maxEntries }),
      ...(operation.cursor === undefined ? {} : { cursor: operation.cursor }),
      ...(operation.ignoreMode === undefined ? {} : { ignoreMode: operation.ignoreMode }),
      ...(operation.includeHidden === undefined ? {} : { includeHidden: operation.includeHidden }),
    });
    if (operation.capabilityId === 'fs.stat') return fs.stat(operation.projectId, operation.workspaceId, operation.path);
    if (operation.capabilityId === 'fs.hash') return fs.hash(operation.projectId, operation.workspaceId, operation.path);
    if (operation.capabilityId === 'fs.read') {
      if (operation.mode === 'TEXT') return fs.readText(operation.projectId, operation.workspaceId, operation.path, operation.maxBytes, operation.encoding ?? 'utf-8');
      if (operation.mode === 'BYTE_RANGE') {
        if (operation.offset === undefined || operation.length === undefined) throw new RuntimeError('INVALID_REQUEST', 'BYTE_RANGE requires offset and length');
        return fs.readRange(operation.projectId, operation.workspaceId, operation.path, operation.offset, operation.length);
      }
      throw new RuntimeError('INVALID_REQUEST', 'Unknown fs.read mode');
    }
    if (operation.capabilityId === 'fs.write') return fs.write(operation.projectId, operation.workspaceId, operation.path, operation.mode, operation.content, operation.expectedSize, operation.expectedSha256);
    if (operation.capabilityId === 'fs.edit') return fs.edit(operation.projectId, operation.workspaceId, operation.path, operation.find, operation.replace, operation.expectedSha256, operation.dryRun ?? false);
    if (operation.capabilityId === 'fs.mkdir') return fs.mkdir(operation.projectId, operation.workspaceId, operation.path);
    if (operation.capabilityId === 'fs.delete') return fs.delete(operation.projectId, operation.workspaceId, operation.path);
    if (operation.capabilityId === 'fs.find') return fs.find(operation.projectId, operation.workspaceId, operation.root, {
      query: operation.query,
      ...(operation.mode === undefined ? {} : { mode: operation.mode }),
      ...(operation.maxDepth === undefined ? {} : { maxDepth: operation.maxDepth }),
      ...(operation.maxResults === undefined ? {} : { maxResults: operation.maxResults }),
      ...(operation.cursor === undefined ? {} : { cursor: operation.cursor }),
      ...(operation.ignoreMode === undefined ? {} : { ignoreMode: operation.ignoreMode }),
      ...(operation.includeHidden === undefined ? {} : { includeHidden: operation.includeHidden }),
    });
    if (operation.capabilityId === 'artifact.stat') return artifactView(await resources.getArtifact(operation.projectId, operation.artifactId));
    if (operation.capabilityId === 'artifact.open_ref') {
      const artifact = await resources.getArtifact(operation.projectId, operation.artifactId);
      const workspace = await resources.getActiveWorkspace(operation.projectId, artifact.workspaceId);
      const relative = path.relative(workspace.physicalRoot, artifact.physicalPath);
      const current = await fs.hash(operation.projectId, artifact.workspaceId, relative);
      if (current.size !== artifact.size || current.sha256 !== artifact.sha256) throw new RuntimeError('PRECONDITION_FAILED', 'Artifact content no longer matches its registered physical identity');
      return { ...artifactReference(artifact), reference: `iris-artifact:${artifact.artifactId}` };
    }
    if (operation.capabilityId === 'artifact.register_existing') {
      const resolved = await fs.resolveTarget(operation.projectId, operation.workspaceId, operation.path, 'file-content');
      const hash = await fs.hash(operation.projectId, operation.workspaceId, operation.path);
      const artifact = await resources.registerArtifact({
        projectId: operation.projectId,
        workspaceId: resolved.workspace.workspaceId,
        physicalPath: resolved.absolutePath,
        producerActionId: operation.mission?.actionId ?? null,
        producerJobId: null,
        mime: operation.mime,
        artifactType: operation.artifactType,
        size: hash.size,
        sha256: hash.sha256,
        sensitivity: operation.sensitivity,
        retentionPolicy: operation.retentionPolicy,
      });
      return artifactView(artifact);
    }
    if (operation.capabilityId === 'artifact.release') {
      const artifact = await resources.releaseArtifact(operation.projectId, operation.artifactId);
      return { released: true, artifactId: artifact.artifactId, physicalFileDeleted: false };
    }
    throw new RuntimeError('CAPABILITY_DENIED', 'Phase 2 capability execution is not implemented');
  }

  private validationCompatibility(): ValidationCompatibilityAdapter {
    this.validationCompatibilityAdapter ??= new ValidationCompatibilityAdapter(
      this.jobManager(),
      this.resourceRegistry(),
      this.validationJobs,
    );
    return this.validationCompatibilityAdapter;
  }

  private jobManager(): DurableJobManager {
    if (this.jobs === undefined) {
      this.jobs = new DurableJobManager(this.state.dataRoot, this.resourceRegistry());
    }
    return this.jobs;
  }

  private gitEngine(): GovernedGitEngine {
    return new GovernedGitEngine(this.resourceRegistry());
  }

  private resourceRegistry(): VNextResourceRegistry {
    if (this.resources === undefined) {
      this.resources = new VNextResourceRegistry(this.state, this.state.dataRoot);
    }
    return this.resources;
  }

  private async authorizedProject(operation: { readonly capabilityId: CapabilityId; readonly clientId: string; readonly sessionId?: string | undefined; readonly projectId?: string | undefined }): Promise<ProjectReference> {
    if (operation.sessionId === undefined) {
      if (operation.projectId === undefined || !sessionlessProjectRead(operation.capabilityId)) throw new RuntimeError('CAPABILITY_DENIED', 'Sessionless project reads require an explicit registered projectId');
      const project = (await this.state.listProjects()).find((entry) => entry.id === operation.projectId);
      if (project === undefined) throw new RuntimeError('PROJECT_NOT_FOUND', 'Requested project is not registered');
      return project;
    }
    const session = this.state.getSessionForClient(operation.sessionId, operation.clientId);
    if (session.currentProjectId === null) throw new RuntimeError('CAPABILITY_DENIED', 'Session has no current project');
    if ('projectId' in operation && operation.projectId !== undefined && operation.projectId !== session.currentProjectId) throw new RuntimeError('CAPABILITY_DENIED', 'Operation project no longer matches the live session project');
    const project = (await this.state.listProjects()).find((entry) => entry.id === session.currentProjectId);
    if (project === undefined) throw new RuntimeError('CAPABILITY_DENIED', 'Live session project is no longer registered');
    return project;
  }

  private async legacyPrimaryFsTarget(
    project: ProjectReference,
    targetPath: string,
    kind: 'file-read' | 'file-write' | 'file-edit' | 'file-delete' | 'directory-create' | 'directory-delete',
  ) {
    const absolutePath = await this.revalidateTarget(project, targetPath, kind);
    const resources = this.resourceRegistry();
    const workspace = await resources.primaryWorkspace(project.id);
    const relativePath = path.relative(workspace.physicalRoot, absolutePath);
    if (relativePath.length === 0 || path.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Legacy project target does not map to the authorized PRIMARY workspace');
    }
    return {
      absolutePath,
      relativePath,
      workspaceId: workspace.workspaceId,
      fs: new WorkspaceFilesystemEngine(resources),
    };
  }

  private async revalidateTarget(project: ProjectReference, targetPath: string, kind: 'file-read' | 'file-write' | 'file-edit' | 'file-delete' | 'directory-create' | 'directory-delete'): Promise<string> {
    const resolvedTarget = path.isAbsolute(targetPath) ? targetPath : path.resolve(project.rootPath, targetPath);
    const inspected = await inspectProjectTarget(project.rootPath, resolvedTarget, kind);
    if (!inspected.valid || inspected.target === null) throw new RuntimeError('CAPABILITY_DENIED', inspected.reason);
    return inspected.target;
  }
}

type Phase4GitOperation = Extract<CapabilityOperation, { capabilityId: Phase4GitCapabilityId }>;

type Phase3Operation = Extract<CapabilityOperation,
  | { capabilityId: 'shell.run' | 'shell.start' }
  | { capabilityId: 'job.status' | 'job.logs' | 'job.result' | 'job.cancel' }
>;

type ShellPhase3Operation = Extract<Phase3Operation, { capabilityId: 'shell.run' | 'shell.start' }>;

function shellExecutionInput(operation: ShellPhase3Operation) {
  return {
    projectId: operation.projectId,
    workspaceId: operation.workspaceId,
    executable: operation.executable,
    argv: operation.argv,
    cwd: operation.cwd,
    executionProfile: operation.executionProfile,
    envOverrides: operation.envOverrides,
    timeoutMs: operation.timeoutMs,
    ...(operation.stdinArtifactId === undefined ? {} : { stdinArtifactId: operation.stdinArtifactId }),
  };
}

function isPhase4GitOperation(operation: CapabilityOperation): operation is Phase4GitOperation {
  return operation.capabilityId.startsWith('git.') && operation.capabilityId !== 'git.local';
}

function phase4GitCapabilityId(operation: Phase4GitOperationName): Phase4GitCapabilityId {
  return `git.${operation}` as Phase4GitCapabilityId;
}

function isPhase3Operation(operation: CapabilityOperation): operation is Phase3Operation {
  return operation.capabilityId === 'shell.run' || operation.capabilityId === 'shell.start'
    || operation.capabilityId === 'job.status' || operation.capabilityId === 'job.logs'
    || operation.capabilityId === 'job.result' || operation.capabilityId === 'job.cancel';
}

type Phase2Operation = Extract<CapabilityOperation,
  | { capabilityId: 'workspace.list' | 'workspace.get' | 'workspace.create_scratch' | 'workspace.revoke_scratch' }
  | { capabilityId: 'fs.list' | 'fs.stat' | 'fs.read' | 'fs.write' | 'fs.edit' | 'fs.mkdir' | 'fs.delete' | 'fs.hash' | 'fs.find' }
  | { capabilityId: 'artifact.stat' | 'artifact.open_ref' | 'artifact.register_existing' | 'artifact.release' }
>;

async function resolveFsPreflight(fs: WorkspaceFilesystemEngine, operation: Extract<Phase2Operation, { capabilityId: `fs.${string}` }>) {
  if (operation.capabilityId === 'fs.list') return fs.resolveTarget(operation.projectId, operation.workspaceId, operation.path, 'directory');
  if (operation.capabilityId === 'fs.stat') return fs.resolveTarget(operation.projectId, operation.workspaceId, operation.path, 'metadata');
  if (operation.capabilityId === 'fs.read' || operation.capabilityId === 'fs.hash' || operation.capabilityId === 'fs.edit') return fs.resolveTarget(operation.projectId, operation.workspaceId, operation.path, 'file-content');
  if (operation.capabilityId === 'fs.write') {
    if (operation.mode === 'CREATE') return fs.resolveTarget(operation.projectId, operation.workspaceId, operation.path, 'create-file');
    if (operation.mode === 'REPLACE' || operation.mode === 'APPEND') return fs.resolveTarget(operation.projectId, operation.workspaceId, operation.path, 'replace-file');
    throw new RuntimeError('UNKNOWN_EFFECT', 'Unknown fs.write mode fails closed before permission evaluation');
  }
  if (operation.capabilityId === 'fs.mkdir') return fs.resolveTarget(operation.projectId, operation.workspaceId, operation.path, 'mkdir');
  if (operation.capabilityId === 'fs.delete') return fs.resolveTarget(operation.projectId, operation.workspaceId, operation.path, 'delete');
  if (operation.capabilityId === 'fs.find') return fs.resolveTarget(operation.projectId, operation.workspaceId, operation.root, 'directory');
  throw new RuntimeError('CAPABILITY_DENIED', 'Unknown Phase 2 filesystem operation fails closed');
}

function isPhase2Operation(operation: CapabilityOperation): operation is Phase2Operation {
  return operation.capabilityId.startsWith('workspace.') || operation.capabilityId.startsWith('fs.') || operation.capabilityId.startsWith('artifact.');
}

function decorateDecision(record: PermissionDecisionRecord, preflight: Phase2Preflight | null): PermissionDecisionRecord {
  if (preflight === null) return record;
  return {
    ...record,
    ...(preflight.workspaceId === null ? {} : { workspaceId: preflight.workspaceId }),
    ...(preflight.resourceId === null ? {} : { resourceId: preflight.resourceId }),
    ...(preflight.target === null ? {} : { target: preflight.target }),
  };
}

function sessionlessProjectRead(capabilityId: CapabilityId): boolean {
  return capabilityId === 'project.info' || capabilityId === 'project.git_status' || capabilityId === 'project.search'
    || capabilityId === 'project.validation.discover' || capabilityId === 'project.validation.job.read' || capabilityId === 'file.read';
}

function requestForOperation(operation: CapabilityOperation): PolicyRequest {
  let request: PolicyRequest;
  if (isPhase4GitOperation(operation)) {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, projectId: operation.projectId };
  } else if (isPhase3Operation(operation)) {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, projectId: operation.projectId };
  } else if (isPhase2Operation(operation)) {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, projectId: operation.projectId };
  } else if (operation.capabilityId === 'runtime.status' || operation.capabilityId === 'project.list' || operation.capabilityId === 'mission.list') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId };
  } else if (operation.capabilityId === 'project.info' || operation.capabilityId === 'project.git_status' || operation.capabilityId === 'project.search' || operation.capabilityId === 'project.test.run' || operation.capabilityId === 'project.command.run' || operation.capabilityId === 'project.validation.discover' || operation.capabilityId === 'project.validation.start' || operation.capabilityId === 'project.validation.job.read' || operation.capabilityId === 'git.local' || operation.capabilityId === 'remote.publish') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, projectId: operation.projectId };
  } else if (operation.capabilityId === 'mission.get') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, missionId: operation.missionId };
  } else if (operation.capabilityId === 'mission.create') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId };
  } else if (operation.capabilityId === 'mission.state.set' || operation.capabilityId === 'mission.task.create' || operation.capabilityId === 'mission.task.state.set' || operation.capabilityId === 'mission.action.prepare' || operation.capabilityId === 'mission.supervisor_gate.set') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, missionId: operation.missionId, ...('taskId' in operation ? { taskId: operation.taskId } : {}) };
  } else if (operation.capabilityId === 'project.register') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, targetPath: operation.rootPath };
  } else if (operation.capabilityId === 'project.default.set') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, projectId: operation.projectId };
  } else if (operation.capabilityId === 'policy.mode.set') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId };
  } else if (operation.capabilityId === 'session.create') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, agentId: operation.agentId };
  } else if (operation.capabilityId === 'session.delete') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId };
  } else if (operation.capabilityId === 'session.current_project.set') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, projectId: operation.projectId };
  } else if (operation.capabilityId === 'session.instruction.submit') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId };
  } else {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, projectId: operation.projectId, targetPath: operation.targetPath };
  }
  return operation.mission === undefined ? request : { ...request, missionId: operation.mission.missionId, taskId: operation.mission.taskId, actionId: operation.mission.actionId };
}

function isMissionExecutableOperation(operation: CapabilityOperation): operation is CapabilityOperation & { readonly clientId: string; readonly sessionId: string; readonly mission: MissionExecutionAssociation } {
  return operation.capabilityId === 'project.test.run' || operation.capabilityId === 'project.command.run' || operation.capabilityId === 'project.validation.start' || operation.capabilityId === 'git.local' || operation.capabilityId === 'git.push' || operation.capabilityId === 'remote.publish' || operation.capabilityId === 'file.read' || operation.capabilityId === 'file.write' || operation.capabilityId === 'file.delete' || operation.capabilityId === 'file.edit' || operation.capabilityId === 'directory.create' || operation.capabilityId === 'directory.delete';
}

function missionExecutionCapability(capabilityId: CapabilityId): capabilityId is 'project.test.run' | 'project.command.run' | 'project.validation.start' | 'git.local' | 'git.push' | 'remote.publish' | 'file.read' | 'file.write' | 'file.edit' | 'file.delete' | 'directory.create' | 'directory.delete' {
  return capabilityId === 'project.test.run' || capabilityId === 'project.command.run' || capabilityId === 'project.validation.start' || capabilityId === 'git.local' || capabilityId === 'git.push' || capabilityId === 'remote.publish' || capabilityId === 'file.read' || capabilityId === 'file.write' || capabilityId === 'file.delete' || capabilityId === 'file.edit' || capabilityId === 'directory.create' || capabilityId === 'directory.delete';
}

function describeOperation(operation: CapabilityOperation): string {
  if (isPhase4GitOperation(operation)) {
    const prefix = `${operation.capabilityId} projectId=${operation.projectId} workspaceId=${operation.workspaceId}`;
    if (operation.operation === 'status' || operation.operation === 'head' || operation.operation === 'worktree_list') return `${prefix} repositoryId=${operation.repositoryId ?? 'derived'}`;
    if (operation.operation === 'diff') return `${prefix} repositoryId=${operation.repositoryId ?? 'derived'} paths=${operation.paths?.length ?? 0}`;
    if (operation.operation === 'log') return `${prefix} repositoryId=${operation.repositoryId ?? 'derived'} ref=${operation.ref ?? 'HEAD'} maxCount=${operation.maxCount ?? 'default'}`;
    if (operation.operation === 'show') return `${prefix} repositoryId=${operation.repositoryId ?? 'derived'} ref=${operation.ref}`;
    if (operation.operation === 'cat_file') return `${prefix} repositoryId=${operation.repositoryId ?? 'derived'} object=${operation.object}`;
    if (operation.operation === 'merge_base') return `${prefix} repositoryId=${operation.repositoryId ?? 'derived'} left=${operation.left} right=${operation.right}`;
    if (operation.operation === 'ancestry') return `${prefix} repositoryId=${operation.repositoryId ?? 'derived'} ancestor=${operation.ancestor} descendant=${operation.descendant}`;
    if (operation.operation === 'refs' || operation.operation === 'branch_list') return `${prefix} repositoryId=${operation.repositoryId ?? 'derived'} maxEntries=${operation.maxEntries ?? 'default'}`;
    if (operation.operation === 'branch_create') return `${prefix} repositoryId=${operation.repositoryId} branch=${operation.branchName} baseRef=${operation.baseRef}`;
    if (operation.operation === 'worktree_add') return `${prefix} repositoryId=${operation.repositoryId} branch=${operation.branchName} baseRef=${operation.baseRef} destination=${operation.destinationPath}`;
    if (operation.operation === 'worktree_remove') return `${prefix} repositoryId=${operation.repositoryId}`;
    if (operation.operation === 'add') return `${prefix} repositoryId=${operation.repositoryId} paths=${operation.paths.length}`;
    if (operation.operation === 'commit') return `${prefix} repositoryId=${operation.repositoryId} paths=${operation.paths.length} messageBytes=${Buffer.byteLength(operation.message, 'utf8')} messageSha256=${createHash('sha256').update(operation.message).digest('hex')}`;
    if (operation.operation === 'fetch') return `${prefix} repositoryId=${operation.repositoryId} remote=${operation.remote}`;
    if (operation.operation === 'push') return `${prefix} repositoryId=${operation.repositoryId} remote=${operation.remote} branch=${operation.branch}`;
    return prefix;
  }
  if (isPhase3Operation(operation)) {
    if (operation.capabilityId === 'shell.run' || operation.capabilityId === 'shell.start') {
      const argvHash = createHash('sha256').update(JSON.stringify(operation.argv)).digest('hex');
      const envKeys = Object.keys(operation.envOverrides).sort().join(',');
      return `${operation.capabilityId} projectId=${operation.projectId} workspaceId=${operation.workspaceId} profile=${operation.executionProfile} executable=${operation.executable} cwd=${operation.cwd} argvSha256=${argvHash} envKeys=${envKeys} timeoutMs=${operation.timeoutMs}${operation.capabilityId === 'shell.start' ? ` requestId=${operation.requestId}` : ''}`;
    }
    if (operation.capabilityId === 'job.logs') return `job.logs projectId=${operation.projectId} jobId=${operation.jobId} stream=${operation.stream} maxBytes=${operation.maxBytes ?? 'default'}`;
    return `${operation.capabilityId} projectId=${operation.projectId} jobId=${operation.jobId}`;
  }
  if (isPhase2Operation(operation)) {
    if (operation.capabilityId === 'workspace.list') return `workspace.list projectId=${operation.projectId}`;
    if (operation.capabilityId === 'workspace.get' || operation.capabilityId === 'workspace.revoke_scratch') return `${operation.capabilityId} projectId=${operation.projectId} workspaceId=${operation.workspaceId}`;
    if (operation.capabilityId === 'workspace.create_scratch') return `workspace.create_scratch projectId=${operation.projectId}`;
    if (operation.capabilityId === 'fs.list') return `fs.list projectId=${operation.projectId} workspaceId=${operation.workspaceId} path=${operation.path} recursive=${operation.recursive ?? false}`;
    if (operation.capabilityId === 'fs.stat' || operation.capabilityId === 'fs.hash' || operation.capabilityId === 'fs.mkdir' || operation.capabilityId === 'fs.delete') return `${operation.capabilityId} projectId=${operation.projectId} workspaceId=${operation.workspaceId} path=${operation.path}`;
    if (operation.capabilityId === 'fs.read') return `fs.read projectId=${operation.projectId} workspaceId=${operation.workspaceId} path=${operation.path} mode=${operation.mode}`;
    if (operation.capabilityId === 'fs.write') return `fs.write projectId=${operation.projectId} workspaceId=${operation.workspaceId} path=${operation.path} mode=${operation.mode} bytes=${Buffer.byteLength(operation.content, 'utf8')} sha256=${createHash('sha256').update(operation.content).digest('hex')}`;
    if (operation.capabilityId === 'fs.edit') return `fs.edit projectId=${operation.projectId} workspaceId=${operation.workspaceId} path=${operation.path} findSha256=${createHash('sha256').update(operation.find).digest('hex')} replaceSha256=${createHash('sha256').update(operation.replace).digest('hex')} expectedSha256=${operation.expectedSha256} dryRun=${operation.dryRun === true}`;
    if (operation.capabilityId === 'fs.find') return `fs.find projectId=${operation.projectId} workspaceId=${operation.workspaceId} root=${operation.root} mode=${operation.mode ?? 'NAME'} queryLength=${operation.query.length}`;
    if (operation.capabilityId === 'artifact.register_existing') return `artifact.register_existing projectId=${operation.projectId} workspaceId=${operation.workspaceId} path=${operation.path} mime=${operation.mime} type=${operation.artifactType} sensitivity=${operation.sensitivity} retention=${operation.retentionPolicy}`;
    return `${operation.capabilityId} projectId=${operation.projectId} artifactId=${operation.artifactId}`;
  }
  if (operation.capabilityId === 'runtime.status' || operation.capabilityId === 'project.list' || operation.capabilityId === 'mission.list') return operation.capabilityId;
  if (operation.capabilityId === 'project.info') return `project.info projectId=${operation.projectId}`;
  if (operation.capabilityId === 'project.git_status') return `project.git_status projectId=${operation.projectId}`;
  if (operation.capabilityId === 'project.search') return `project.search projectId=${operation.projectId} queryLength=${operation.query.length}`;
  if (operation.capabilityId === 'project.test.run') return `project.test.run projectId=${operation.projectId ?? 'session-current'} declared-script=test`;
  if (operation.capabilityId === 'project.command.run') return `project.command.run projectId=${operation.projectId ?? 'session-current'} declared-script=${operation.scriptName}`;
  if (operation.capabilityId === 'project.validation.discover') return `project.validation.discover projectId=${operation.projectId}`;
  if (operation.capabilityId === 'project.validation.start') return `project.validation.start projectId=${operation.projectId ?? 'session-current'} declared-script=${operation.scriptName} requestId=${operation.requestId}`;
  if (operation.capabilityId === 'project.validation.job.read') return `project.validation.job.read projectId=${operation.projectId} jobId=${operation.jobId} view=${operation.view}`;
  if (operation.capabilityId === 'git.local') return `git.local projectId=${operation.projectId ?? 'session-current'} operation=${operation.operation} paths=${operation.paths?.length ?? 0}`;
  if (operation.capabilityId === 'remote.publish') return `remote.publish projectId=${operation.projectId ?? 'session-current'} configured-origin-current-feature-branch`;
  if (operation.capabilityId === 'mission.get') return `mission.get missionId=${operation.missionId}`;
  if (operation.capabilityId === 'mission.create') return `mission.create sessionId=${operation.sessionId} title=${JSON.stringify(operation.title)}`;
  if (operation.capabilityId === 'mission.state.set') return `mission.state.set missionId=${operation.missionId} state=${operation.state}`;
  if (operation.capabilityId === 'mission.task.create') return `mission.task.create missionId=${operation.missionId} title=${JSON.stringify(operation.title)}`;
  if (operation.capabilityId === 'mission.task.state.set') return `mission.task.state.set missionId=${operation.missionId} taskId=${operation.taskId} state=${operation.state}`;
  if (operation.capabilityId === 'mission.action.prepare') return `mission.action.prepare missionId=${operation.missionId} taskId=${operation.taskId} capability=${operation.actionCapabilityId} summary=${JSON.stringify(operation.summary)}`;
  if (operation.capabilityId === 'mission.supervisor_gate.set') return `mission.supervisor_gate.set missionId=${operation.missionId} state=${operation.state}`;
  if (operation.capabilityId === 'file.write') return `file.write target=${operation.targetPath} bytes=${Buffer.byteLength(operation.content, 'utf8')} sha256=${createHash('sha256').update(operation.content).digest('hex')}`;
  if (operation.capabilityId === 'file.edit') return `file.edit target=${operation.targetPath} findSha256=${createHash('sha256').update(operation.find).digest('hex')} replaceSha256=${createHash('sha256').update(operation.replace).digest('hex')} expectedSha256=${operation.expectedSha256} dryRun=${operation.dryRun === true}`;
  if (operation.capabilityId === 'file.read' || operation.capabilityId === 'file.delete' || operation.capabilityId === 'directory.create' || operation.capabilityId === 'directory.delete') return `${operation.capabilityId} target=${operation.targetPath}`;
  if (operation.capabilityId === 'project.register') return `project.register name=${JSON.stringify(operation.name)} rootPath=${operation.rootPath}`;
  if (operation.capabilityId === 'project.default.set') return `project.default.set projectId=${operation.projectId ?? 'null'}`;
  if (operation.capabilityId === 'session.current_project.set') return `session.current_project.set sessionId=${operation.sessionId} projectId=${operation.projectId ?? 'null'}`;
  if (operation.capabilityId === 'session.instruction.submit') return `session.instruction.submit sessionId=${operation.sessionId} submissionId=${operation.submissionId} bytes=${Buffer.byteLength(operation.instruction, 'utf8')} sha256=${createHash('sha256').update(operation.instruction).digest('hex')}`;
  if (operation.capabilityId === 'session.create') return `session.create clientId=${operation.clientId ?? 'generated'} agentId=${operation.agentId ?? 'generated'} role=${operation.agentRole ?? 'other'}`;
  if (operation.capabilityId === 'session.delete') return `session.delete sessionId=${operation.sessionId} clientId=${operation.clientId}`;
  return `policy.mode.set mode=${operation.mode}`;
}

function artifactView(artifact: ArtifactRecord) {
  return {
    artifactId: artifact.artifactId,
    projectId: artifact.projectId,
    workspaceId: artifact.workspaceId,
    producerJobId: artifact.producerJobId,
    producerActionId: artifact.producerActionId,
    mime: artifact.mime,
    artifactType: artifact.artifactType,
    size: artifact.size,
    sha256: artifact.sha256,
    sensitivity: artifact.sensitivity,
    createdAt: artifact.createdAt,
    retentionPolicy: artifact.retentionPolicy,
  };
}

function artifactReference(artifact: ArtifactRecord) {
  return {
    artifactId: artifact.artifactId,
    projectId: artifact.projectId,
    workspaceId: artifact.workspaceId,
    mime: artifact.mime,
    artifactType: artifact.artifactType,
    size: artifact.size,
    sha256: artifact.sha256,
    sensitivity: artifact.sensitivity,
    retentionPolicy: artifact.retentionPolicy,
  };
}

function sameEffects(left: readonly CapabilityEffect[] | undefined, right: readonly CapabilityEffect[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((effect, index) => effect === b[index]);
}
