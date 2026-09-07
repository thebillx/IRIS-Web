import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentRole, CapabilityId, MissionExecutionAssociation, MissionState, MissionTaskState, OrchestratorMode, PermissionDecisionRecord, PendingApprovalView, PermissionMode, ProjectReference, RuntimeHealth, SupervisorGateState } from '@iris/domain';
import { RuntimeError } from '@iris/domain';
import { PermissionAuditStore } from './audit.js';
import { capabilityDefinition } from './capability-registry.js';
import { PermissionPolicyEngine, type PolicyRequest } from './permissions.js';
import { inspectProjectTarget } from './project-path.js';
import { secureProjectFileRead, secureProjectFileWrite, secureProjectMutation } from './macos-safety.js';
import { inspectProjectGitStatus } from './git-status.js';
import { searchProjectText } from './project-search.js';
import { runDeclaredProjectTest } from './project-test.js';
import type { RuntimeState } from './state.js';

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
  | { readonly capabilityId: 'file.delete'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string }
  | { readonly capabilityId: 'directory.create'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string }
  | { readonly capabilityId: 'directory.delete'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string }
  | { readonly capabilityId: 'policy.mode.set'; readonly mode: PermissionMode; readonly clientId?: string | undefined; readonly sessionId?: string | undefined };

export type CapabilityOperation = CapabilityOperationCore & { readonly mission?: MissionExecutionAssociation | undefined };

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

export class CapabilityService {
  private readonly pending = new Map<string, PendingApprovalInternal>();
  private missionActionTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly state: RuntimeState,
    private readonly policy: PermissionPolicyEngine,
    private readonly audit: PermissionAuditStore,
    private readonly health: () => RuntimeHealth,
  ) {}

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
    const result = this.missionActionTail.then(
      () => this.executeGoverned(operation),
      () => this.executeGoverned(operation),
    );
    this.missionActionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async executeGoverned(operation: CapabilityOperation): Promise<CapabilityOutcome> {
    const association = operation.mission;
    if (association !== undefined) {
      if (!isMissionExecutableOperation(operation)) throw new RuntimeError('CAPABILITY_DENIED', 'Mission action association is not supported for this capability');
      await this.state.validateMissionActionAssociation(association, operation.capabilityId, operation.clientId, operation.sessionId);
    }

    const policyRequest = requestForOperation(operation);
    const decision = await this.policy.evaluate(policyRequest);
    if (decision.decision === 'DENY') {
      await this.audit.append(decision, 'DENIED');
      if (association !== undefined) await this.state.markMissionActionDenied(association, 'Governed capability was denied by policy');
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
    if (pending?.operation.mission === undefined) return this.resolveApprovalGoverned(id, choice);
    const result = this.missionActionTail.then(
      () => this.resolveApprovalGoverned(id, choice),
      () => this.resolveApprovalGoverned(id, choice),
    );
    this.missionActionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async resolveApprovalGoverned(id: string, choice: OwnerApprovalChoice): Promise<CapabilityOutcome> {
    const pending = this.claimPendingApproval(id);

    if (choice === 'DENY') {
      const denied: PermissionDecisionRecord = {
        ...pending.view,
        timestamp: new Date().toISOString(),
        decision: 'DENY',
        reason: 'Owner denied the pending exact action',
      };
      await this.audit.append(denied, 'DENIED');
      if (pending.operation.mission !== undefined) await this.state.markMissionActionDenied(pending.operation.mission, denied.reason);
      return { status: 'denied', reason: denied.reason };
    }

    if (pending.operation.mission !== undefined) {
      if (pending.view.clientId === null || pending.view.sessionId === null) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Mission approval lost its originating client/session identity');
      }
      await this.state.validateMissionApprovalAssociation(
        pending.operation.mission,
        pending.operation.capabilityId,
        pending.view.clientId,
        pending.view.sessionId,
        pending.view.id,
      );
    }

    const reevaluated = await this.policy.evaluate(requestForOperation(pending.operation));
    if (reevaluated.decision === 'DENY'
      || reevaluated.capabilityId !== pending.view.capabilityId
      || reevaluated.projectId !== pending.view.projectId
      || reevaluated.target !== pending.view.target) {
      const denied: PermissionDecisionRecord = {
        ...reevaluated,
        timestamp: new Date().toISOString(),
        decision: 'DENY',
        reason: 'Pending action changed or became ineligible before owner approval was applied',
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
        : 'Owner approved this exact action once',
    };
    await this.audit.append(approved, 'DECISION');
    return this.executeAndAudit(pending.operation, approved);
  }

  private claimPendingApproval(id: string): PendingApprovalInternal {
    this.pruneExpiredApprovals();
    const pending = this.pending.get(id);
    if (pending === undefined || !this.pending.delete(id)) {
      throw new RuntimeError('APPROVAL_NOT_FOUND', 'Pending approval was not found or has expired');
    }
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
    if (association !== undefined) await this.state.markMissionActionSucceeded(association, operation.capabilityId, value);
    return { status: 'executed', value };
  }

  private async executeAuthorized(operation: CapabilityOperation, decision: PermissionDecisionRecord): Promise<unknown> {
    if (operation.capabilityId === 'runtime.status') return this.health();
    if (operation.capabilityId === 'project.list') return {
      projects: await this.state.listProjects(),
      defaultProjectId: await this.state.getDefaultProjectId(),
    };
    if (operation.capabilityId === 'project.info') {
      const project = await this.authorizedProject(operation);
      return { id: project.id, name: project.name, rootPath: project.rootPath, isDefault: project.id === await this.state.getDefaultProjectId() };
    }
    if (operation.capabilityId === 'project.git_status') {
      const project = await this.authorizedProject(operation);
      return inspectProjectGitStatus(project.rootPath);
    }
    if (operation.capabilityId === 'project.search') {
      const project = await this.authorizedProject(operation);
      return searchProjectText(project.rootPath, operation.query);
    }
    if (operation.capabilityId === 'project.test.run') {
      const project = await this.authorizedProject(operation);
      return runDeclaredProjectTest(project.rootPath);
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
    if (operation.capabilityId === 'session.delete') {
      this.state.deleteSession(operation.sessionId, operation.clientId);
      return { deleted: true };
    }
    if (operation.capabilityId === 'session.current_project.set') {
      return this.state.setSessionCurrentProject(operation.sessionId, operation.clientId, operation.projectId);
    }
    if (operation.capabilityId === 'session.instruction.submit') {
      return this.state.submitInstruction(operation.sessionId, operation.clientId, operation.submissionId, operation.instruction);
    }
    if (operation.capabilityId === 'project.register') {
      if (decision.target === null) throw new RuntimeError('CAPABILITY_DENIED', 'Approved project registration lost its canonical physical target');
      return this.state.registerCanonicalProject(operation.name, decision.target);
    }
    if (operation.capabilityId === 'project.default.set') {
      await this.state.setDefaultProject(operation.projectId);
      return { defaultProjectId: operation.projectId };
    }
    if (operation.capabilityId === 'policy.mode.set') {
      await this.policy.setMode(operation.mode);
      return { mode: operation.mode };
    }

    const project = await this.authorizedProject(operation);
    if (operation.capabilityId === 'file.read') {
      const target = await this.revalidateTarget(project, operation.targetPath, 'file-read');
      return { targetPath: target, content: await secureProjectFileRead(project.rootPath, target) };
    }
    if (operation.capabilityId === 'file.write') {
      const bytes = Buffer.byteLength(operation.content, 'utf8');
      if (bytes > MAX_FILE_BYTES) throw new RuntimeError('CAPABILITY_DENIED', 'File write exceeds the V1 local capability size limit');
      const target = await this.revalidateTarget(project, operation.targetPath, 'file-write');
      const written = await secureProjectFileWrite(project.rootPath, target, operation.content);
      if (written !== bytes) throw new RuntimeError('CAPABILITY_DENIED', 'Protected project write byte count did not match the approved exact action');
      return { targetPath: target, bytes };
    }
    if (operation.capabilityId === 'file.delete') {
      const target = await this.revalidateTarget(project, operation.targetPath, 'file-delete');
      const result = await secureProjectMutation('unlink', project.rootPath, target);
      return { targetPath: target, deleted: result.deleted === true };
    }
    if (operation.capabilityId === 'directory.create') {
      const target = await this.revalidateTarget(project, operation.targetPath, 'directory-create');
      const result = await secureProjectMutation('mkdir', project.rootPath, target);
      return { targetPath: target, created: result.created === true };
    }
    if (operation.capabilityId === 'directory.delete') {
      const target = await this.revalidateTarget(project, operation.targetPath, 'directory-delete');
      const result = await secureProjectMutation('rmdir', project.rootPath, target);
      return { targetPath: target, deleted: result.deleted === true };
    }
    throw new RuntimeError('CAPABILITY_DENIED', 'Capability execution is not implemented');
  }

  private async authorizedProject(operation: { readonly capabilityId: CapabilityId; readonly clientId: string; readonly sessionId?: string | undefined; readonly projectId?: string | undefined }): Promise<ProjectReference> {
    if (operation.sessionId === undefined) {
      if (operation.projectId === undefined || !sessionlessProjectRead(operation.capabilityId)) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Sessionless project reads require an explicit registered projectId');
      }
      const project = (await this.state.listProjects()).find((entry) => entry.id === operation.projectId);
      if (project === undefined) throw new RuntimeError('PROJECT_NOT_FOUND', 'Requested project is not registered');
      return project;
    }
    const session = this.state.getSessionForClient(operation.sessionId, operation.clientId);
    if (session.currentProjectId === null) throw new RuntimeError('CAPABILITY_DENIED', 'Session has no current project');
    if ('projectId' in operation && operation.projectId !== undefined && operation.projectId !== session.currentProjectId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Operation project no longer matches the live session project');
    }
    const project = (await this.state.listProjects()).find((entry) => entry.id === session.currentProjectId);
    if (project === undefined) throw new RuntimeError('CAPABILITY_DENIED', 'Live session project is no longer registered');
    return project;
  }

  private async revalidateTarget(
    project: ProjectReference,
    targetPath: string,
    kind: 'file-read' | 'file-write' | 'file-delete' | 'directory-create' | 'directory-delete',
  ): Promise<string> {
    const resolvedTarget = path.isAbsolute(targetPath) ? targetPath : path.resolve(project.rootPath, targetPath);
    const inspected = await inspectProjectTarget(project.rootPath, resolvedTarget, kind);
    if (!inspected.valid || inspected.target === null) throw new RuntimeError('CAPABILITY_DENIED', inspected.reason);
    return inspected.target;
  }
}

function sessionlessProjectRead(capabilityId: CapabilityId): boolean {
  return capabilityId === 'project.info' || capabilityId === 'project.git_status' || capabilityId === 'project.search' || capabilityId === 'file.read';
}

function requestForOperation(operation: CapabilityOperation): PolicyRequest {
  let request: PolicyRequest;
  if (operation.capabilityId === 'runtime.status' || operation.capabilityId === 'project.list' || operation.capabilityId === 'mission.list') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId };
  } else if (operation.capabilityId === 'project.info' || operation.capabilityId === 'project.git_status' || operation.capabilityId === 'project.search' || operation.capabilityId === 'project.test.run') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, projectId: operation.projectId };
  } else if (operation.capabilityId === 'mission.get') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, missionId: operation.missionId };
  } else if (operation.capabilityId === 'mission.create') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId };
  } else if (operation.capabilityId === 'mission.state.set' || operation.capabilityId === 'mission.task.create'
    || operation.capabilityId === 'mission.task.state.set' || operation.capabilityId === 'mission.action.prepare'
    || operation.capabilityId === 'mission.supervisor_gate.set') {
    request = { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, missionId: operation.missionId,
      ...('taskId' in operation ? { taskId: operation.taskId } : {}) };
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
    request = {
      capabilityId: operation.capabilityId,
      clientId: operation.clientId,
      sessionId: operation.sessionId,
      projectId: operation.projectId,
      targetPath: operation.targetPath,
    };
  }
  return operation.mission === undefined ? request : {
    ...request,
    missionId: operation.mission.missionId,
    taskId: operation.mission.taskId,
    actionId: operation.mission.actionId,
  };
}

function isMissionExecutableOperation(operation: CapabilityOperation): operation is CapabilityOperation & { readonly clientId: string; readonly sessionId: string; readonly mission: MissionExecutionAssociation } {
  return operation.capabilityId === 'project.test.run' || operation.capabilityId === 'file.read' || operation.capabilityId === 'file.write' || operation.capabilityId === 'file.delete'
    || operation.capabilityId === 'directory.create' || operation.capabilityId === 'directory.delete';
}

function missionExecutionCapability(capabilityId: CapabilityId): capabilityId is 'project.test.run' | 'file.read' | 'file.write' | 'file.delete' | 'directory.create' | 'directory.delete' {
  return capabilityId === 'project.test.run' || capabilityId === 'file.read' || capabilityId === 'file.write' || capabilityId === 'file.delete'
    || capabilityId === 'directory.create' || capabilityId === 'directory.delete';
}

function describeOperation(operation: CapabilityOperation): string {
  if (operation.capabilityId === 'runtime.status' || operation.capabilityId === 'project.list' || operation.capabilityId === 'mission.list') return operation.capabilityId;
  if (operation.capabilityId === 'project.info') return `project.info projectId=${operation.projectId}`;
  if (operation.capabilityId === 'project.git_status') return `project.git_status projectId=${operation.projectId}`;
  if (operation.capabilityId === 'project.search') return `project.search projectId=${operation.projectId} queryLength=${operation.query.length}`;
  if (operation.capabilityId === 'project.test.run') return `project.test.run projectId=${operation.projectId ?? 'session-current'} declared-script=test`;
  if (operation.capabilityId === 'mission.get') return `mission.get missionId=${operation.missionId}`;
  if (operation.capabilityId === 'mission.create') return `mission.create sessionId=${operation.sessionId} title=${JSON.stringify(operation.title)}`;
  if (operation.capabilityId === 'mission.state.set') return `mission.state.set missionId=${operation.missionId} state=${operation.state}`;
  if (operation.capabilityId === 'mission.task.create') return `mission.task.create missionId=${operation.missionId} title=${JSON.stringify(operation.title)}`;
  if (operation.capabilityId === 'mission.task.state.set') return `mission.task.state.set missionId=${operation.missionId} taskId=${operation.taskId} state=${operation.state}`;
  if (operation.capabilityId === 'mission.action.prepare') return `mission.action.prepare missionId=${operation.missionId} taskId=${operation.taskId} capability=${operation.actionCapabilityId} summary=${JSON.stringify(operation.summary)}`;
  if (operation.capabilityId === 'mission.supervisor_gate.set') return `mission.supervisor_gate.set missionId=${operation.missionId} state=${operation.state}`;
  if (operation.capabilityId === 'file.write') {
    const bytes = Buffer.byteLength(operation.content, 'utf8');
    const digest = createHash('sha256').update(operation.content).digest('hex');
    return `file.write target=${operation.targetPath} bytes=${bytes} sha256=${digest}`;
  }
  if (operation.capabilityId === 'file.read' || operation.capabilityId === 'file.delete'
    || operation.capabilityId === 'directory.create' || operation.capabilityId === 'directory.delete') {
    return `${operation.capabilityId} target=${operation.targetPath}`;
  }
  if (operation.capabilityId === 'project.register') return `project.register name=${JSON.stringify(operation.name)} rootPath=${operation.rootPath}`;
  if (operation.capabilityId === 'project.default.set') return `project.default.set projectId=${operation.projectId ?? 'null'}`;
  if (operation.capabilityId === 'session.current_project.set') return `session.current_project.set sessionId=${operation.sessionId} projectId=${operation.projectId ?? 'null'}`;
  if (operation.capabilityId === 'session.instruction.submit') {
    const bytes = Buffer.byteLength(operation.instruction, 'utf8');
    const digest = createHash('sha256').update(operation.instruction).digest('hex');
    return `session.instruction.submit sessionId=${operation.sessionId} submissionId=${operation.submissionId} bytes=${bytes} sha256=${digest}`;
  }
  if (operation.capabilityId === 'session.create') return `session.create clientId=${operation.clientId ?? 'generated'} agentId=${operation.agentId ?? 'generated'} role=${operation.agentRole ?? 'other'}`;
  if (operation.capabilityId === 'session.delete') return `session.delete sessionId=${operation.sessionId} clientId=${operation.clientId}`;
  return `policy.mode.set mode=${operation.mode}`;
}
