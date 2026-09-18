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

export type OrchestratorMode = 'HERMES' | 'CHATGPT';
export type MissionState = 'PLANNED' | 'RUNNING' | 'WAITING_APPROVAL' | 'WAITING_SUPERVISOR' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type MissionTaskState = 'PENDING' | 'RUNNING' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type MissionActionState = 'PLANNED' | 'RUNNING' | 'OWNER_APPROVAL_REQUIRED' | 'SUCCEEDED' | 'DENIED' | 'FAILED' | 'CANCELLED';
export type SupervisorGateState = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'DENIED';
export type MissionBrokerState = 'ACTIVE' | 'AWAITING_SUPERVISOR' | 'COMPLETED' | 'FAILED';
export type SupervisorDecision = 'CONTINUE' | 'REVISE' | 'PAUSE' | 'COMPLETE';
export type MissionEvidenceKind = 'CAPABILITY_RESULT' | 'AUDIT' | 'ARTIFACT' | 'OBSERVATION';
export type MissionTimelineKind =
  | 'MISSION_CREATED'
  | 'MISSION_STATE_CHANGED'
  | 'TASK_CREATED'
  | 'TASK_STATE_CHANGED'
  | 'ACTION_PREPARED'
  | 'ACTION_STARTED'
  | 'APPROVAL_REQUIRED'
  | 'ACTION_SUCCEEDED'
  | 'ACTION_DENIED'
  | 'ACTION_FAILED'
  | 'SUPERVISOR_GATE_CHANGED'
  | 'ORCHESTRATOR_MODE_CHANGED'
  | 'MISSION_SESSION_REBOUND';

export interface MissionExecutionAssociation {
  readonly missionId: string;
  readonly taskId: string;
  readonly actionId: string;
  readonly orchestratorMode: OrchestratorMode;
}

export interface MissionOrchestratorHandoff {
  readonly handoffId: string;
  readonly expectedVersion: number;
  readonly from: OrchestratorMode;
  readonly to: OrchestratorMode;
  readonly completedAt: string;
}

export interface MissionEvidence {
  readonly id: string;
  readonly kind: MissionEvidenceKind;
  readonly label: string;
  readonly summary: string;
  readonly reference: string | null;
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MissionActionResult {
  readonly status: 'SUCCEEDED' | 'OWNER_REQUIRED' | 'DENIED' | 'FAILED';
  readonly summary: string;
  readonly approvalId: string | null;
  readonly completedAt: string | null;
  readonly evidence: readonly MissionEvidence[];
}

export interface MissionAction {
  readonly id: string;
  readonly capabilityId: CapabilityId;
  readonly summary: string;
  readonly state: MissionActionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approvalId: string | null;
  readonly result: MissionActionResult | null;
}

export interface MissionTask {
  readonly id: string;
  readonly title: string;
  readonly state: MissionTaskState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly actions: readonly MissionAction[];
}

export interface SupervisorGate {
  readonly state: SupervisorGateState;
  readonly reason: string | null;
  readonly updatedAt: string;
}

export interface MissionTimelineEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: MissionTimelineKind;
  readonly taskId: string | null;
  readonly actionId: string | null;
  readonly message: string;
}

export interface MissionRebindAuditEvent {
  readonly id: string;
  readonly missionId: string;
  readonly oldClientId: string;
  readonly oldSessionId: string;
  readonly newClientId: string;
  readonly newSessionId: string;
  readonly principal: 'owner';
  readonly projectId: string;
  readonly timestamp: string;
  readonly reason: string;
  readonly bindingRevision: number;
  readonly result: 'SUCCESS';
}

export interface MissionSnapshot {
  readonly id: string;
  readonly title: string;
  readonly state: MissionState;
  readonly orchestratorMode: OrchestratorMode;
  readonly orchestratorVersion: number;
  readonly lastOrchestratorHandoff: MissionOrchestratorHandoff | null;
  readonly orchestratorHandoffIds: readonly string[];
  readonly clientId: string;
  readonly sessionId: string;
  readonly ownerClientId: string;
  readonly bindingRevision: number;
  readonly rebindAudit: readonly MissionRebindAuditEvent[];
  readonly projectId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly supervisorGate: SupervisorGate;
  readonly tasks: readonly MissionTask[];
  readonly timeline: readonly MissionTimelineEvent[];
}

export interface MissionCheckpoint {
  readonly checkpointId: string;
  readonly missionId: string;
  readonly missionVersion: number;
  readonly state: MissionState;
  readonly currentPhase: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly blockers: readonly string[];
  readonly hermesAssessment: string;
  readonly proposedNextAction: string;
  readonly decisionRequired: boolean;
  readonly createdAt: string;
}

export interface SupervisorDirective {
  readonly missionId: string;
  readonly expectedVersion: number;
  readonly directiveId: string;
  readonly directiveSequence: number;
  readonly decision: SupervisorDecision;
  readonly instruction: string;
  readonly authorizedScope: readonly string[];
  readonly doNot: readonly string[];
  readonly successCriteria: readonly string[];
  readonly acceptedAt: string;
}

export interface MissionBrokerSnapshot {
  readonly missionId: string;
  readonly missionVersion: number;
  readonly hermesSessionId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly state: MissionBrokerState;
  readonly lastCheckpointId: string | null;
  readonly lastDirectiveId: string | null;
  readonly lastDirectiveSequence: number;
  readonly checkpoints: readonly MissionCheckpoint[];
  readonly directives: readonly SupervisorDirective[];
  readonly updatedAt: string;
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
  | 'project.info'
  | 'project.git_status'
  | 'project.search'
  | 'project.test.run'
  | 'mission.list'
  | 'mission.get'
  | 'mission.create'
  | 'mission.state.set'
  | 'mission.task.create'
  | 'mission.task.state.set'
  | 'mission.action.prepare'
  | 'mission.supervisor_gate.set'
  | 'session.create'
  | 'session.delete'
  | 'session.current_project.set'
  | 'session.instruction.submit'
  | 'project.register'
  | 'project.default.set'
  | 'file.read'
  | 'file.write'
  | 'file.edit'
  | 'file.delete'
  | 'directory.create'
  | 'directory.delete'
  | 'project.command.run'
  | 'project.validation.discover'
  | 'project.validation.start'
  | 'project.validation.job.read'
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
  readonly missionId?: string | null;
  readonly taskId?: string | null;
  readonly actionId?: string | null;
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
  | 'MISSION_NOT_FOUND'
  | 'AGENT_EXECUTION_FAILED'
  | 'RUNTIME_NOT_RUNNING'
  | 'RUNTIME_SHUTTING_DOWN'
  | 'PERSISTENCE_FAILURE'
  | 'OWNER_DECISION_REQUIRED'
  | 'CAPABILITY_DENIED'
  | 'APPROVAL_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'CREDENTIAL_MISSING'
  | 'CREDENTIAL_INVALID'
  | 'LEGACY_CONFIG_DETECTED'
  | 'MIGRATION_REQUIRED'
  | 'TUNNEL_NOT_RUNNING'
  | 'CONTROL_PLANE_UNREACHABLE'
  | 'TUNNEL_CONTROL_PLANE_AUTH_FAILED'
  | 'TUNNEL_SERVICE_CREDENTIAL_MISMATCH'
  | 'CONNECTOR_BINDING_MISMATCH'
  | 'CONNECTOR_MANIFEST_STALE'
  | 'RUNTIME_IDENTITY_MISMATCH'
  | 'SUPERVISOR_NOT_RUNNING'
  | 'SUPERVISOR_BUSY'
  | 'PROCESS_OWNERSHIP_AMBIGUOUS'
  | 'RECOVERY_EXHAUSTED'
  | 'E2E_PROBE_UNAVAILABLE'
  | 'NODE_VERSION_UNSUPPORTED'
  | 'MCP_CATALOG_STALE'
  | 'MISSION_SESSION_STALE'
  | 'PRECONDITION_FAILED';

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
