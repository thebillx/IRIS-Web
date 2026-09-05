export const IRIS_VERSION = '0.0.0' as const;
export const IRIS_PLATFORM = 'darwin' as const;

export interface RuntimeIdentity {
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly platform: typeof IRIS_PLATFORM;
  readonly version: typeof IRIS_VERSION;
}

export type RuntimeStatus = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface ProjectReference {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
}

export type AgentRole = 'owner' | 'planner' | 'implementer' | 'reviewer' | 'security' | 'explorer' | 'other';
export type AgentExecutorType = 'local-development-executor' | 'production-provider-executor' | 'other';

export interface RuntimeSession {
  readonly id: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly agentRole: AgentRole;
  readonly createdAt: string;
  readonly currentProjectId: string | null;
}

export type SessionExecutionState = 'READY' | 'WORKING' | 'FAILED';
export type SessionInteractionKind = 'user' | 'assistant' | 'error';

export interface SessionInteractionEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: SessionInteractionKind;
  readonly text: string;
  readonly submissionId: string;
  readonly executionId: string;
}

export interface RuntimeSessionSnapshot extends RuntimeSession {
  readonly executionState: SessionExecutionState;
  readonly interactions: readonly SessionInteractionEvent[];
}

export interface RuntimeClientState {
  readonly clientId: string;
  readonly connected: boolean;
  readonly lastSeenAt: string;
}

export interface RuntimeHealth {
  readonly status: RuntimeStatus;
  readonly version: typeof IRIS_VERSION;
  readonly platform: typeof IRIS_PLATFORM;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly uptimeMs: number;
  readonly authority: 'owned';
  readonly connectedClients: number;
  readonly connectedSessions: number;
  readonly agentExecutorType: AgentExecutorType;
  readonly productionModelConnected: boolean;
  readonly apiUrl: string;
  readonly mcpUrl: string;
}

export interface DoctorCheck {
  readonly code: string;
  readonly status: 'pass' | 'fail';
  readonly message: string;
}

export interface DoctorReport {
  readonly status: 'pass' | 'fail';
  readonly checks: readonly DoctorCheck[];
}

export type PermissionMode =
  | 'ASK_EVERY_TIME'
  | 'AUTO_APPROVE_LOW_RISK'
  | 'AUTO_APPROVE_PROJECT_SCOPED'
  | 'FULL_LOCAL_OWNER';

export type RiskClass = 'LOW' | 'MODERATE' | 'HIGH' | 'SYSTEM';
export type RequiredScope = 'MACHINE' | 'PROJECT' | 'RUNTIME_DATA' | 'OWNER';
export type PolicyDecision = 'ALLOW_AUTO' | 'ALLOW_ONCE' | 'DENY' | 'OWNER_REQUIRED';

export type CapabilityId =
  | 'runtime.status'
  | 'project.list'
  | 'session.create'
  | 'session.delete'
  | 'session.current_project.set'
  | 'session.instruction.submit'
  | 'project.register'
  | 'project.default.set'
  | 'file.read'
  | 'file.write'
  | 'file.delete'
  | 'directory.create'
  | 'directory.delete'
  | 'project.command.run'
  | 'git.local'
  | 'runtime.lifecycle'
  | 'web.lifecycle'
  | 'package.project'
  | 'policy.mode.set'
  | 'credential.mutate'
  | 'remote.publish'
  | 'system.sudo';

export interface CapabilityDefinition {
  readonly id: CapabilityId;
  readonly title: string;
  readonly riskClass: RiskClass;
  readonly requiredScope: RequiredScope;
  readonly mutation: boolean;
  readonly implemented: boolean;
}

export interface PermissionDecisionRecord {
  readonly timestamp: string;
  readonly clientId: string | null;
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly capabilityId: CapabilityId | string;
  readonly riskClass: RiskClass;
  readonly projectId: string | null;
  readonly target: string | null;
  readonly decision: PolicyDecision;
  readonly reason: string;
}

export type AuditResult = 'DECISION' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'DENIED';

export interface PermissionAuditEvent extends PermissionDecisionRecord {
  readonly id: string;
  readonly result: AuditResult;
}

export interface PendingApprovalView extends PermissionDecisionRecord {
  readonly id: string;
  readonly exactAction: string;
  readonly canAlwaysAllowProject: boolean;
}

export type RuntimeFailureCode =
  | 'AUTHORITY_HELD'
  | 'AUTHORITY_INDETERMINATE'
  | 'AUTHORITY_CHANGED'
  | 'CONTROL_DENIED'
  | 'STALE_AUTHORITY'
  | 'PORT_UNAVAILABLE'
  | 'INVALID_PROJECT_PATH'
  | 'PROJECT_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY'
  | 'AGENT_EXECUTION_FAILED'
  | 'RUNTIME_NOT_RUNNING'
  | 'RUNTIME_SHUTTING_DOWN'
  | 'PERSISTENCE_FAILURE'
  | 'OWNER_DECISION_REQUIRED'
  | 'CAPABILITY_DENIED'
  | 'APPROVAL_NOT_FOUND'
  | 'INVALID_REQUEST';

export class RuntimeError extends Error {
  public constructor(
    public readonly code: RuntimeFailureCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = 'RuntimeError';
    if (options?.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, configurable: true });
    }
  }
}
