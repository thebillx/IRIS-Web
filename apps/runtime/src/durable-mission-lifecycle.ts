import type { MissionEvidence } from '@iris/domain';

export type DurableMissionLifecycleState =
  | 'CREATED'
  | 'READY'
  | 'RUNNING'
  | 'CHECKPOINTED'
  | 'WAITING_FOR_SUPERVISOR'
  | 'RESUMING'
  | 'VALIDATING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type WorkerRuntimeState = 'RUNNING' | 'RESUMABLE' | 'STOPPED' | 'FAILED' | 'UNKNOWN';
export type LifecycleOperationKind = 'START' | 'CHECKPOINT' | 'RESUME' | 'CANCEL' | 'COMPLETE';
export type LifecycleOperationStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface WorkerBinding {
  readonly workerType: string;
  readonly workerId: string;
  readonly resumeToken: string | null;
  readonly missionId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly resumable: boolean;
}

export interface DurableMissionCheckpoint {
  readonly checkpointId: string;
  readonly missionId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly workerStateRef: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
  readonly resumeMetadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DurableSupervisorDirective {
  readonly directiveId: string;
  readonly missionId: string;
  readonly projectId: string;
  readonly basedOnRevision: number;
  readonly directive: string;
  readonly createdAt: string;
  readonly appliedAt: string | null;
  readonly status: 'ACCEPTED' | 'APPLIED';
}

export interface LifecycleOperationReceipt {
  readonly requestId: string;
  readonly kind: LifecycleOperationKind;
  readonly basedOnRevision: number;
  readonly resultRevision: number | null;
  readonly status: LifecycleOperationStatus;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface DurableMissionLifecycleSnapshot {
  readonly missionId: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly state: DurableMissionLifecycleState;
  readonly revision: number;
  readonly workerBinding: WorkerBinding | null;
  readonly checkpoints: readonly DurableMissionCheckpoint[];
  readonly directives: readonly DurableSupervisorDirective[];
  readonly evidence: readonly MissionEvidence[];
  readonly operations: readonly LifecycleOperationReceipt[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkerStartReceipt {
  readonly workerId: string;
  readonly resumeToken: string | null;
  readonly resumable: boolean;
}

export interface WorkerCheckpointReceipt {
  readonly workerStateRef: string;
  readonly resumeMetadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface WorkerStatusReceipt {
  readonly state: WorkerRuntimeState;
  readonly workerId: string;
  readonly resumeToken: string | null;
  readonly resumable: boolean;
}

export interface WorkerAdapter {
  readonly workerType: string;
  start(input: { readonly operationId: string; readonly missionId: string; readonly projectId: string; readonly goal: string }): Promise<WorkerStartReceipt>;
  checkpoint(input: { readonly operationId: string; readonly missionId: string; readonly projectId: string; readonly binding: WorkerBinding }): Promise<WorkerCheckpointReceipt>;
  resume(input: { readonly operationId: string; readonly missionId: string; readonly projectId: string; readonly binding: WorkerBinding; readonly checkpoint: DurableMissionCheckpoint; readonly directive: DurableSupervisorDirective }): Promise<WorkerStartReceipt>;
  cancel(input: { readonly operationId: string; readonly missionId: string; readonly projectId: string; readonly binding: WorkerBinding }): Promise<void>;
  status(input: { readonly missionId: string; readonly projectId: string; readonly binding: WorkerBinding }): Promise<WorkerStatusReceipt>;
}

export interface StartMissionInput {
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly requestId: string;
  readonly workerType: string;
}

export interface CheckpointMissionInput {
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly checkpointId: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

export interface DirectiveMissionInput {
  readonly missionId: string;
  readonly basedOnRevision: number;
  readonly directiveId: string;
  readonly directive: string;
}

export interface ResumeMissionInput {
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly requestId: string;
}

export interface CancelMissionInput {
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly requestId: string;
}

export interface CompleteMissionInput {
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly requestId: string;
}

export interface AppendMissionEvidenceInput {
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly evidence: MissionEvidence;
}
