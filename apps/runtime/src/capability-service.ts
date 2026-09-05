import { createHash, randomUUID } from 'node:crypto';
import type { AgentRole, PermissionDecisionRecord, PendingApprovalView, PermissionMode, ProjectReference, RuntimeHealth } from '@iris/domain';
import { RuntimeError } from '@iris/domain';
import { PermissionAuditStore } from './audit.js';
import { capabilityDefinition } from './capability-registry.js';
import { PermissionPolicyEngine, type PolicyRequest } from './permissions.js';
import { inspectProjectTarget } from './project-path.js';
import { secureProjectFileRead, secureProjectFileWrite, secureProjectMutation } from './macos-safety.js';
import type { RuntimeState } from './state.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PENDING_APPROVALS = 100;
const APPROVAL_TTL_MS = 15 * 60_000;

export type CapabilityOperation =
  | { readonly capabilityId: 'runtime.status'; readonly clientId?: string | undefined; readonly sessionId?: string | undefined }
  | { readonly capabilityId: 'project.list'; readonly clientId?: string | undefined; readonly sessionId?: string | undefined }
  | { readonly capabilityId: 'session.create'; readonly clientId?: string | undefined; readonly agentId?: string | undefined; readonly agentRole?: AgentRole | undefined }
  | { readonly capabilityId: 'session.delete'; readonly clientId: string; readonly sessionId: string }
  | { readonly capabilityId: 'session.current_project.set'; readonly clientId: string; readonly sessionId: string; readonly projectId: string | null }
  | { readonly capabilityId: 'session.instruction.submit'; readonly clientId: string; readonly sessionId: string; readonly submissionId: string; readonly instruction: string }
  | { readonly capabilityId: 'project.register'; readonly name: string; readonly rootPath: string; readonly clientId?: string | undefined; readonly sessionId?: string | undefined }
  | { readonly capabilityId: 'project.default.set'; readonly projectId: string | null; readonly clientId?: string | undefined; readonly sessionId?: string | undefined }
  | { readonly capabilityId: 'file.read'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string }
  | { readonly capabilityId: 'file.write'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string; readonly content: string }
  | { readonly capabilityId: 'file.delete'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string }
  | { readonly capabilityId: 'directory.create'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string }
  | { readonly capabilityId: 'directory.delete'; readonly clientId: string; readonly sessionId: string; readonly projectId?: string | undefined; readonly targetPath: string }
  | { readonly capabilityId: 'policy.mode.set'; readonly mode: PermissionMode; readonly clientId?: string | undefined; readonly sessionId?: string | undefined };

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

  public async execute(operation: CapabilityOperation): Promise<CapabilityOutcome> {
    const policyRequest = requestForOperation(operation);
    const decision = await this.policy.evaluate(policyRequest);
    if (decision.decision === 'DENY') {
      await this.audit.append(decision, 'DENIED');
      return { status: 'denied', reason: decision.reason };
    }
    if (decision.decision === 'OWNER_REQUIRED') {
      const approval = this.queueApproval(operation, decision);
      await this.audit.append(decision, 'PENDING');
      return { status: 'owner_required', approval };
    }

    await this.audit.append(decision, 'DECISION');
    return this.executeAndAudit(operation, decision);
  }

  public async resolveApproval(id: string, choice: OwnerApprovalChoice): Promise<CapabilityOutcome> {
    const pending = this.claimPendingApproval(id);

    if (choice === 'DENY') {
      const denied: PermissionDecisionRecord = {
        ...pending.view,
        timestamp: new Date().toISOString(),
        decision: 'DENY',
        reason: 'Owner denied the pending exact action',
      };
      await this.audit.append(denied, 'DENIED');
      return { status: 'denied', reason: denied.reason };
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
    try {
      const value = await this.executeAuthorized(operation, decision);
      await this.audit.append(decision, 'SUCCESS');
      return { status: 'executed', value };
    } catch (error) {
      await this.audit.append(decision, 'FAILED');
      throw error;
    }
  }

  private async executeAuthorized(operation: CapabilityOperation, decision: PermissionDecisionRecord): Promise<unknown> {
    if (operation.capabilityId === 'runtime.status') return this.health();
    if (operation.capabilityId === 'project.list') return {
      projects: await this.state.listProjects(),
      defaultProjectId: await this.state.getDefaultProjectId(),
    };
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

  private async authorizedProject(operation: Extract<CapabilityOperation, { clientId: string; sessionId: string }>): Promise<ProjectReference> {
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
    const inspected = await inspectProjectTarget(project.rootPath, targetPath, kind);
    if (!inspected.valid || inspected.target === null) throw new RuntimeError('CAPABILITY_DENIED', inspected.reason);
    return inspected.target;
  }
}

function requestForOperation(operation: CapabilityOperation): PolicyRequest {
  if (operation.capabilityId === 'runtime.status' || operation.capabilityId === 'project.list') {
    return { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId };
  }
  if (operation.capabilityId === 'project.register') {
    return { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, targetPath: operation.rootPath };
  }
  if (operation.capabilityId === 'project.default.set') {
    return { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, projectId: operation.projectId };
  }
  if (operation.capabilityId === 'policy.mode.set') {
    return { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId };
  }
  if (operation.capabilityId === 'session.create') return { capabilityId: operation.capabilityId, clientId: operation.clientId, agentId: operation.agentId };
  if (operation.capabilityId === 'session.delete') return { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId };
  if (operation.capabilityId === 'session.current_project.set') {
    return { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId, projectId: operation.projectId };
  }
  if (operation.capabilityId === 'session.instruction.submit') {
    return { capabilityId: operation.capabilityId, clientId: operation.clientId, sessionId: operation.sessionId };
  }
  return {
    capabilityId: operation.capabilityId,
    clientId: operation.clientId,
    sessionId: operation.sessionId,
    projectId: operation.projectId,
    targetPath: operation.targetPath,
  };
}

function describeOperation(operation: CapabilityOperation): string {
  if (operation.capabilityId === 'runtime.status' || operation.capabilityId === 'project.list') return operation.capabilityId;
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
