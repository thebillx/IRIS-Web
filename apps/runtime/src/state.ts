import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  RuntimeError,
  type AgentRole,
  type CapabilityEffect,
  type CapabilityId,
  type MissionExecutionAssociation,
  type MissionEvidence,
  type MissionRebindAuditEvent,
  type MissionSnapshot,
  type MissionState,
  type OrchestratorMode,
  type MissionTaskState,
  type ProjectReference,
  type SupervisorGateState,
  type RuntimeClientState,
  type RuntimeSessionSnapshot,
  type SessionInteractionEvent,
  type DurableSessionAuthority,
} from '@iris/domain';
import { LocalDevelopmentAgentExecutor, type AgentExecutor } from './agent-executor.js';
import { FoundationStateStore, type DurableSessionRecord, type SessionMutationReceipt } from './persistence.js';
import { readMachineId } from './machine-identity.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { MissionLedgerStore, missionArchiveEligible } from './mission-store.js';
import { inspectRegistrationRoot } from './project-path.js';

const MAX_INSTRUCTION_CHARS = 8_000;
const MAX_INTERACTION_EVENTS = 200;
const MAX_EXECUTOR_OUTPUT_CHARS = 12_000;

export interface EnsureSessionInput {
  readonly clientId: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly agentId?: string;
  readonly agentRole?: AgentRole;
}
export interface SessionMutationInput {
  readonly operation: 'select' | 'resume' | 'detach' | 'close';
  readonly clientId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly expectedRevision?: number;
  readonly projectId?: string | null;
  readonly workspaceId?: string | null;
}

export interface MissionRebindInput {
  readonly requestId?: string;
  readonly missionId: string;
  readonly clientId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly expectedBindingRevision: number;
  readonly reason: string;
  readonly principal?: 'owner' | 'tunnel-service';
}

export class RuntimeState {
  private readonly sessions = new Map<string, RuntimeSessionSnapshot>();
  private readonly durableSessions = new Map<string, DurableSessionRecord>();
  private sessionInitialization: Promise<void> | null = null;
  private readonly clients = new Map<string, RuntimeClientState>();
  private readonly activeSubmissions = new Map<string, string>();
  private readonly submissionBindings = new Map<string, Map<string, string>>();
  private mutationTail: Promise<void> = Promise.resolve();
  private missionMutationTail: Promise<void> = Promise.resolve();

  public readonly dataRoot: string;

  public constructor(
    private readonly store: FoundationStateStore,
    private readonly executor: AgentExecutor = new LocalDevelopmentAgentExecutor(),
    private readonly missionStore: MissionLedgerStore = new MissionLedgerStore(store.dataRoot),
  ) {
    this.dataRoot = store.dataRoot;
  }

  public executorDescriptor() {
    return this.executor.descriptor;
  }

  public initializeSessions(): Promise<void> {
    this.sessionInitialization ??= (async () => {
      const document = await this.store.read();
      const machineId = await readMachineId(this.dataRoot);
      for (const stored of document.sessions ?? []) {
        if (stored.snapshot.machineId !== machineId) throw new RuntimeError('CONTROL_DENIED', 'Durable session belongs to a different machine');
        const record: DurableSessionRecord = {
          ...stored,
          snapshot: stored.snapshot.executionState === 'WORKING' ? { ...stored.snapshot, executionState: 'FAILED' } : stored.snapshot,
          submissions: stored.submissions.map((submission) => submission.state === 'RUNNING' ? { ...submission, state: 'UNCERTAIN' as const } : submission),
        };
        this.durableSessions.set(record.snapshot.id, record);
        this.sessions.set(record.snapshot.id, record.snapshot);
      }
    })();
    return this.sessionInitialization;
  }

  public async ensureSession(input: EnsureSessionInput): Promise<RuntimeSessionSnapshot> {
    await this.initializeSessions();
    const clientId = normalizeClientId(input.clientId);
    const conversationId = boundedSessionKey(input.conversationId, 'conversationId');
    const requestId = boundedSessionKey(input.requestId, 'requestId');
    const agentId = normalizeAgentId(input.agentId ?? clientId);
    const agentRole = normalizeAgentRole(input.agentRole ?? 'other');
    const digest = sessionDigest({ operation: 'ensure', clientId, conversationId, agentId, agentRole });
    return this.serializeMachineMutation(async () => {
      const machineId = await readMachineId(this.dataRoot);
      if (machineId === null) throw new RuntimeError('CONTROL_DENIED', 'Durable session requires an enrolled machine identity');
      const duplicate = this.findSessionReceipt(requestId, clientId, digest);
      if (duplicate !== null) {
        const current = this.durableSessions.get(duplicate.result.id)!.snapshot;
        if (current.attachmentState === 'CLOSED') throw new RuntimeError('CONTROL_DENIED', 'Conversation session is closed');
        await this.assertDurableSessionScope(current);
        return duplicate.result;
      }
      const existing = [...this.durableSessions.values()].find(({ snapshot }) => snapshot.clientId === clientId && snapshot.conversationId === conversationId);
      if (existing !== undefined) {
        await this.assertDurableSessionScope(existing.snapshot);
        if (existing.snapshot.attachmentState === 'CLOSED') throw new RuntimeError('CONTROL_DENIED', 'Conversation session is closed');
        return this.commitSessionReceipt(existing, requestId, digest, existing.snapshot, 'ensure');
      }
      const snapshot: RuntimeSessionSnapshot = {
        id: randomUUID(), machineId, clientId, conversationId, agentId, agentRole,
        createdAt: new Date().toISOString(), currentProjectId: null, currentWorkspaceId: null,
        revision: 1, attachmentState: 'ATTACHED', executionState: 'READY', interactions: [],
      };
      return this.commitSessionReceipt({ snapshot, receipts: [], submissions: [] }, requestId, digest, snapshot, 'ensure');
    });
  }

  public async mutateSession(input: SessionMutationInput): Promise<RuntimeSessionSnapshot> {
    await this.initializeSessions();
    const clientId = normalizeClientId(input.clientId);
    const sessionId = normalizeUuidIdentity(input.sessionId, 'sessionId');
    const requestId = boundedSessionKey(input.requestId, 'requestId');
    const digest = sessionDigest({ operation: input.operation, clientId, sessionId, expectedRevision: input.expectedRevision ?? null, projectId: input.projectId ?? null, workspaceId: input.workspaceId ?? null });
    return this.serializeMachineMutation(async () => {
      const record = this.durableSessions.get(sessionId);
      if (record === undefined || record.snapshot.clientId !== clientId) throw new RuntimeError('CONTROL_DENIED', 'Durable session is not owned by this client');
      const session = record.snapshot;
      if (session.machineId !== await readMachineId(this.dataRoot)) throw new RuntimeError('CONTROL_DENIED', 'Durable session machine identity changed');
      const duplicate = this.findSessionReceipt(requestId, clientId, digest);
      if (duplicate !== null) {
        if (session.attachmentState === 'CLOSED' && input.operation !== 'close') throw new RuntimeError('CONTROL_DENIED', 'Session is closed');
        if (input.operation !== 'close') await this.assertDurableSessionScope(session);
        return duplicate.result;
      }
      if (session.attachmentState === 'CLOSED') throw new RuntimeError('CONTROL_DENIED', 'Session is closed');
      if (input.expectedRevision !== undefined && input.expectedRevision !== session.revision) throw new RuntimeError('PRECONDITION_FAILED', 'Session revision is stale');
      if (input.operation === 'close' && this.activeSubmissions.has(sessionId)) throw new RuntimeError('SESSION_BUSY', 'Session instruction is executing');
      let updated = { ...session, revision: session.revision! + 1 };
      if (input.operation === 'select') {
        if (session.attachmentState !== 'ATTACHED') throw new RuntimeError('CONTROL_DENIED', 'Resume the session before selecting its workspace');
        const projectId = input.projectId === null ? null : normalizeUuidIdentity(input.projectId ?? '', 'projectId');
        const workspace = projectId === null ? null : input.workspaceId == null
          ? await new VNextResourceRegistry(this, this.dataRoot).primaryWorkspace(projectId)
          : await new VNextResourceRegistry(this, this.dataRoot).getActiveWorkspace(projectId, input.workspaceId);
        updated = { ...updated, currentProjectId: projectId, currentWorkspaceId: workspace?.workspaceId ?? null };
      } else {
        if (input.operation === 'resume') await this.assertDurableSessionScope(session);
        updated = { ...updated, attachmentState: input.operation === 'resume' ? 'ATTACHED' : input.operation === 'detach' ? 'DETACHED' : 'CLOSED' };
      }
      return this.commitSessionReceipt(record, requestId, digest, updated, input.operation);
    });
  }

  public async validateSessionAuthority(sessionId: string, clientId: string, allowInactive = false): Promise<RuntimeSessionSnapshot> {
    await this.initializeSessions();
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.clientId !== normalizeClientId(clientId)) throw new RuntimeError('CONTROL_DENIED', 'Session is not owned by this client');
    if (!allowInactive && session.attachmentState !== undefined && session.attachmentState !== 'ATTACHED') throw new RuntimeError('CONTROL_DENIED', 'Resume the session before using its authority');
    if (session.machineId !== undefined) await this.assertDurableSessionScope(session);
    return session;
  }

  public async validateCapturedJobSession(sessionId: string, clientId: string): Promise<RuntimeSessionSnapshot> {
    await this.initializeSessions();
    const session = this.getSessionForClient(sessionId, clientId);
    if (session.machineId !== undefined && session.machineId !== await readMachineId(this.dataRoot)) throw new RuntimeError('CONTROL_DENIED', 'Session machine binding is stale');
    return session;
  }

  public getDurableSessionAuthority(sessionId: string, clientId: string): DurableSessionAuthority | undefined {
    const session = this.getSessionForClient(sessionId, clientId);
    if (session.machineId === undefined || session.conversationId === undefined || session.revision === undefined) return undefined;
    return { machineId: session.machineId, clientId: session.clientId, conversationId: session.conversationId, sessionId: session.id, sessionRevision: session.revision };
  }

  public async sessionMutationEvidence(requestId: string, clientId: string): Promise<SessionMutationReceipt | null> {
    await this.initializeSessions();
    const receipt = [...this.durableSessions.values()].flatMap((record) => record.receipts).find((entry) => entry.requestId === requestId);
    if (receipt === undefined) return null;
    if (receipt.result.clientId !== clientId || receipt.result.machineId !== await readMachineId(this.dataRoot)) throw new RuntimeError('CONTROL_DENIED', 'Session receipt belongs to another authority');
    await this.validateSessionAuthority(receipt.result.id, clientId, true);
    return receipt;
  }

  private findSessionReceipt(requestId: string, clientId: string, digest: string): SessionMutationReceipt | null {
    for (const record of this.durableSessions.values()) {
      const receipt = record.receipts.find((candidate) => candidate.requestId === requestId);
      if (receipt === undefined) continue;
      if (receipt.result.clientId !== clientId || receipt.digest !== digest) throw new RuntimeError('AUTHORITY_CHANGED', 'Session requestId is bound to different arguments or owner');
      return receipt;
    }
    return null;
  }

  private async assertDurableSessionScope(session: RuntimeSessionSnapshot): Promise<void> {
    if (session.machineId !== await readMachineId(this.dataRoot)) throw new RuntimeError('CONTROL_DENIED', 'Session machine binding is stale');
    if (session.currentProjectId !== null) {
      if (session.currentWorkspaceId == null) throw new RuntimeError('CONTROL_DENIED', 'Session workspace binding is unavailable');
      await new VNextResourceRegistry(this, this.dataRoot).getActiveWorkspace(session.currentProjectId, session.currentWorkspaceId);
    }
  }

  private async commitSessionReceipt(record: DurableSessionRecord, requestId: string, digest: string, snapshot: RuntimeSessionSnapshot, operation: SessionMutationReceipt['operation']): Promise<RuntimeSessionSnapshot> {
    if (record.receipts.length >= 400) throw new RuntimeError('CAPABILITY_DENIED', 'Session receipt capacity reached; existing evidence is retained');
    await this.publishDurableSession({ ...record, snapshot, receipts: [...record.receipts, { requestId, digest, operation, result: snapshot }] });
    return snapshot;
  }

  private async publishDurableSession(record: DurableSessionRecord): Promise<void> {
    const document = await this.store.read();
    await this.store.write({ ...document, schemaVersion: 2, sessions: [...(document.sessions ?? []).filter((entry) => entry.snapshot.id !== record.snapshot.id), record] });
    this.durableSessions.set(record.snapshot.id, record);
    this.sessions.set(record.snapshot.id, record.snapshot);
  }

  private persistSessionExecution(snapshot: RuntimeSessionSnapshot, submissionId: string, digest: string, state: DurableSessionRecord['submissions'][number]['state']): Promise<void> {
    return this.serializeMachineMutation(async () => {
      const record = this.durableSessions.get(snapshot.id);
      if (record === undefined) { this.sessions.set(snapshot.id, snapshot); return; }
      const previous = record.submissions.find((entry) => entry.submissionId === submissionId);
      if (previous === undefined && record.submissions.length >= 400) throw new RuntimeError('CAPABILITY_DENIED', 'Session submission capacity reached; replay evidence is retained');
      await this.publishDurableSession({ ...record,
        snapshot: { ...record.snapshot, interactions: snapshot.interactions, executionState: snapshot.executionState },
        submissions: [...record.submissions.filter((entry) => entry.submissionId !== submissionId), { submissionId, digest, state }],
      });
    });
  }

  public listSessions(): readonly RuntimeSessionSnapshot[] {
    return [...this.sessions.values()];
  }

  public listSessionsForClient(clientIdInput: string): readonly RuntimeSessionSnapshot[] {
    const clientId = normalizeClientId(clientIdInput);
    return [...this.sessions.values()].filter((session) => session.clientId === clientId);
  }

  public listClients(): readonly RuntimeClientState[] {
    return [...this.clients.values()];
  }

  public async listMissions(): Promise<readonly MissionSnapshot[]> {
    return (await this.missionStore.read()).missions;
  }

  public async getMission(missionIdInput: string): Promise<MissionSnapshot> {
    const missionId = normalizeUuidIdentity(missionIdInput, 'missionId');
    const mission = (await this.listMissions()).find((candidate) => candidate.id === missionId);
    if (mission !== undefined) return mission;
    const archived = await this.missionStore.readArchived(missionId);
    if (archived === null) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission was not found');
    return archived;
  }

  public async assertMissionReviewActionsFinalized(missionIdInput: string): Promise<void> {
    assertMissionReviewActionsFinalized(await this.getMission(missionIdInput));
  }

  public rebindMissionSession(input: MissionRebindInput): Promise<MissionSnapshot> {
    const missionId = normalizeUuidIdentity(input.missionId, 'missionId');
    const clientId = normalizeClientId(input.clientId);
    const sessionId = normalizeUuidIdentity(input.sessionId, 'sessionId');
    const projectId = normalizeUuidIdentity(input.projectId, 'projectId');
    const reason = normalizeMissionText(input.reason, 'reason', 500);
    const principal = input.principal ?? 'owner';
    const requestId = input.requestId === undefined ? undefined : boundedSessionKey(input.requestId, 'requestId');
    const requestDigest = sessionDigest({ missionId, clientId, sessionId, projectId, reason, principal, expectedBindingRevision: input.expectedBindingRevision });
    if (!Number.isSafeInteger(input.expectedBindingRevision) || input.expectedBindingRevision <= 0) {
      throw new RuntimeError('INVALID_REQUEST', 'expectedBindingRevision is invalid');
    }
    const session = this.getSessionForClient(sessionId, clientId);
    if (session.currentProjectId !== projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Rebind session is not selected on the mission project');
    return this.serializeMissionMutation(async () => {
      const currentSession = this.getSessionForClient(sessionId, clientId);
      if (currentSession.currentProjectId !== projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Rebind session is not selected on the mission project');
      const document = await this.missionStore.read();
      const index = document.missions.findIndex((mission) => mission.id === missionId);
      if (index < 0) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission was not found');
      const mission = document.missions[index]!;
      if (mission.projectId !== projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Rebind project does not match the durable mission project');
      if (mission.state === 'COMPLETED' || mission.state === 'FAILED' || mission.state === 'CANCELLED') {
        throw new RuntimeError('CAPABILITY_DENIED', 'Terminal missions cannot be rebound');
      }
      const duplicate = requestId === undefined ? undefined : mission.rebindAudit.find((entry) => entry.requestId === requestId);
      if (duplicate !== undefined) {
        if (duplicate.requestDigest !== requestDigest || mission.clientId !== clientId || mission.sessionId !== sessionId) throw new RuntimeError('AUTHORITY_CHANGED', 'Mission rebind request conflicts with its durable receipt');
        return mission;
      }
      if (mission.bindingRevision !== input.expectedBindingRevision) {
        throw new RuntimeError('INVALID_REQUEST', 'Mission binding revision is stale');
      }
      if (requestId === undefined && mission.clientId === clientId && mission.sessionId === sessionId) return mission;
      if (this.activeSubmissions.has(mission.sessionId) || mission.tasks.some((task) => task.actions.some((action) => action.state === 'RUNNING' || action.state === 'OWNER_APPROVAL_REQUIRED'))) {
        throw new RuntimeError('SESSION_BUSY', 'Mission has active mutation authority and cannot be rebound yet');
      }
      const now = new Date().toISOString();
      const bindingRevision = mission.bindingRevision + 1;
      const audit: MissionRebindAuditEvent = {
        ...(requestId === undefined ? {} : { requestId, requestDigest }),
        id: randomUUID(),
        missionId: mission.id,
        oldClientId: mission.clientId,
        oldSessionId: mission.sessionId,
        newClientId: clientId,
        newSessionId: sessionId,
        principal,
        projectId,
        timestamp: now,
        reason,
        bindingRevision,
        result: 'SUCCESS',
      };
      const updated: MissionSnapshot = {
        ...mission,
        clientId,
        sessionId,
        bindingRevision,
        rebindAudit: [...mission.rebindAudit, audit].slice(-64),
        updatedAt: now,
        timeline: appendMissionEvent(mission.timeline, missionEvent('MISSION_SESSION_REBOUND', `Durable mission session rebound by authenticated ${principal === 'owner' ? 'owner' : 'tunnel connector'}`, null, null, now)),
      };
      const missions = [...document.missions];
      missions[index] = updated;
      await this.missionStore.write({ schemaVersion: 1, missions });
      return updated;
    });
  }

  public async rehydrateBrokerMissionSession(missionIdInput: string): Promise<RuntimeSessionSnapshot> {
    const mission = await this.getMission(missionIdInput);
    const existing = this.sessions.get(mission.sessionId);
    if (existing !== undefined) {
      if (existing.clientId !== mission.clientId || (existing.machineId === undefined && existing.currentProjectId !== mission.projectId)) {
        throw new RuntimeError('CONTROL_DENIED', 'Persisted mission session identity conflicts with the live runtime session');
      }
      return existing;
    }
    if (mission.projectId !== null) {
      const persisted = await this.store.read();
      if (!persisted.projects.some((project) => project.id === mission.projectId)) {
        throw new RuntimeError('CONTROL_DENIED', 'Persisted mission project is no longer registered');
      }
    }
    const now = new Date().toISOString();
    const session: RuntimeSessionSnapshot = {
      id: mission.sessionId,
      clientId: mission.clientId,
      agentId: mission.orchestratorMode === 'HERMES' ? 'hermes-loop-engineer' : 'chatgpt-direct-orchestrator',
      agentRole: mission.orchestratorMode === 'HERMES' ? 'implementer' : 'owner',
      createdAt: now,
      currentProjectId: mission.projectId,
      executionState: 'READY',
      interactions: [],
    };
    this.sessions.set(session.id, session);
    this.submissionBindings.set(session.id, new Map());
    this.clients.set(session.clientId, { clientId: session.clientId, connected: true, lastSeenAt: now });
    return session;
  }

  public createMission(clientIdInput: string, sessionIdInput: string, titleInput: string, orchestratorMode: OrchestratorMode = 'HERMES', requestIdInput?: string, goal?: string): Promise<MissionSnapshot> {
    const clientId = normalizeClientId(clientIdInput);
    const sessionId = normalizeUuidIdentity(sessionIdInput, 'sessionId');
    const title = normalizeMissionText(titleInput, 'mission title', 240);
    const requestId = requestIdInput === undefined ? undefined : boundedSessionKey(requestIdInput, 'requestId');
    const session = this.getSessionForClient(sessionId, clientId);
    return this.serializeMissionMutation(async () => {
      let document = await this.missionStore.read();
      const id = requestId === undefined ? randomUUID() : missionRequestIdentity(requestId);
      const digest = sessionDigest({ clientId, sessionId, title, orchestratorMode, projectId: session.currentProjectId, goal: goal ?? null });
      const duplicate = document.missions.find((candidate) => candidate.id === id) ?? (requestId === undefined ? null : await this.missionStore.readArchived(id));
      if (duplicate != null) {
        if (duplicate.creationRequest?.requestId !== requestId || duplicate.creationRequest?.digest !== digest) throw new RuntimeError('AUTHORITY_CHANGED', 'Mission creation request is bound to different input');
        return duplicate;
      }
      if (document.missions.length >= 100) {
        const candidate = [...document.missions]
          .filter(missionArchiveEligible)
          .sort((left, right) =>
            left.updatedAt !== right.updatedAt
              ? left.updatedAt.localeCompare(right.updatedAt)
              : left.id.localeCompare(right.id))[0];
        if (candidate === undefined) {
          throw new RuntimeError('CAPABILITY_DENIED', 'Mission ledger capacity has been reached and no safely archivable completed mission exists');
        }
        await this.missionStore.archiveForCapacity(candidate);
        document = {
          schemaVersion: 1,
          missions: document.missions.filter((mission) => mission.id !== candidate.id),
        };
      }
      const now = new Date().toISOString();
      const mission: MissionSnapshot = {
        id,
        ...(requestId === undefined ? {} : { creationRequest: { requestId, digest } }),
        title,
        state: 'PLANNED',
        orchestratorMode,
        orchestratorVersion: 1,
        lastOrchestratorHandoff: null,
        orchestratorHandoffIds: [],
        ownerClientId: clientId,
        bindingRevision: 1,
        rebindAudit: [],
        clientId,
        sessionId,
        projectId: session.currentProjectId,
        createdAt: now,
        updatedAt: now,
        supervisorGate: { state: 'NOT_REQUIRED', reason: null, updatedAt: now },
        tasks: [],
        timeline: [missionEvent('MISSION_CREATED', 'Mission registered by the orchestration client', null, null, now)],
      };
      await this.missionStore.write({ schemaVersion: 1, missions: [...document.missions, mission] });
      return mission;
    });
  }

  public setMissionState(
    missionIdInput: string,
    clientIdInput: string,
    sessionIdInput: string,
    state: MissionState,
  ): Promise<MissionSnapshot> {
    return this.updateControlledMission(missionIdInput, clientIdInput, sessionIdInput, (mission, now) => {
      if (state === 'COMPLETED') assertMissionReviewActionsFinalized(mission);
      return {
        ...mission,
        state,
        updatedAt: now,
        timeline: appendMissionEvent(mission.timeline, missionEvent('MISSION_STATE_CHANGED', `Mission state recorded as ${state}`, null, null, now)),
      };
    });
  }

  public createMissionTask(
    missionIdInput: string,
    clientIdInput: string,
    sessionIdInput: string,
    titleInput: string,
  ): Promise<MissionSnapshot> {
    const title = normalizeMissionText(titleInput, 'task title', 240);
    return this.updateControlledMission(missionIdInput, clientIdInput, sessionIdInput, (mission, now) => {
      if (mission.tasks.length >= 200) throw new RuntimeError('CAPABILITY_DENIED', 'Mission task capacity has been reached');
      const taskId = randomUUID();
      return {
        ...mission,
        updatedAt: now,
        tasks: [...mission.tasks, { id: taskId, title, state: 'PENDING', createdAt: now, updatedAt: now, actions: [] }],
        timeline: appendMissionEvent(mission.timeline, missionEvent('TASK_CREATED', `Task registered: ${title}`, taskId, null, now)),
      };
    });
  }

  public setMissionTaskState(
    missionIdInput: string,
    taskIdInput: string,
    clientIdInput: string,
    sessionIdInput: string,
    state: MissionTaskState,
  ): Promise<MissionSnapshot> {
    const taskId = normalizeUuidIdentity(taskIdInput, 'taskId');
    return this.updateControlledMission(missionIdInput, clientIdInput, sessionIdInput, (mission, now) => {
      let found = false;
      const tasks = mission.tasks.map((task) => {
        if (task.id !== taskId) return task;
        found = true;
        return { ...task, state, updatedAt: now };
      });
      if (!found) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission task was not found');
      return {
        ...mission,
        updatedAt: now,
        tasks,
        timeline: appendMissionEvent(mission.timeline, missionEvent('TASK_STATE_CHANGED', `Task state recorded as ${state}`, taskId, null, now)),
      };
    });
  }

  public prepareMissionAction(
    missionIdInput: string,
    taskIdInput: string,
    clientIdInput: string,
    sessionIdInput: string,
    capabilityId: CapabilityId,
    summaryInput: string,
  ): Promise<MissionSnapshot> {
    const taskId = normalizeUuidIdentity(taskIdInput, 'taskId');
    const summary = normalizeMissionText(summaryInput, 'action summary', 400);
    return this.updateControlledMission(missionIdInput, clientIdInput, sessionIdInput, (mission, now) => {
      let found = false;
      let actionId = '';
      const tasks = mission.tasks.map((task) => {
        if (task.id !== taskId) return task;
        found = true;
        if (task.actions.length >= 200) throw new RuntimeError('CAPABILITY_DENIED', 'Mission action capacity has been reached');
        actionId = randomUUID();
        return {
          ...task,
          updatedAt: now,
          actions: [...task.actions, {
            id: actionId,
            capabilityId,
            summary,
            state: 'PLANNED' as const,
            createdAt: now,
            updatedAt: now,
            approvalId: null,
            result: null,
          }],
        };
      });
      if (!found) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission task was not found');
      return {
        ...mission,
        updatedAt: now,
        tasks,
        timeline: appendMissionEvent(mission.timeline, missionEvent('ACTION_PREPARED', `Governed action prepared for ${capabilityId}`, taskId, actionId, now)),
      };
    });
  }

  public setMissionSupervisorGate(
    missionIdInput: string,
    clientIdInput: string,
    sessionIdInput: string,
    state: SupervisorGateState,
    reasonInput: string | null,
  ): Promise<MissionSnapshot> {
    const reason = reasonInput === null ? null : normalizeMissionText(reasonInput, 'supervisor gate reason', 500);
    return this.updateControlledMission(missionIdInput, clientIdInput, sessionIdInput, (mission, now) => ({
      ...mission,
      updatedAt: now,
      supervisorGate: { state, reason, updatedAt: now },
      timeline: appendMissionEvent(mission.timeline, missionEvent('SUPERVISOR_GATE_CHANGED', `Supervisor gate recorded as ${state}`, null, null, now)),
    }));
  }

  public changeMissionOrchestrator(
    missionIdInput: string,
    targetMode: OrchestratorMode,
    expectedVersionInput: number,
    handoffIdInput: string,
    externalHandoffSafe: boolean,
  ): Promise<MissionSnapshot> {
    const missionId = normalizeUuidIdentity(missionIdInput, 'missionId');
    const handoffId = normalizeUuidIdentity(handoffIdInput, 'handoffId');
    if (!Number.isInteger(expectedVersionInput) || expectedVersionInput <= 0) throw new RuntimeError('INVALID_REQUEST', 'expectedVersion is invalid');
    if (targetMode !== 'HERMES' && targetMode !== 'CHATGPT') throw new RuntimeError('INVALID_REQUEST', 'orchestratorMode is invalid');
    return this.serializeMissionMutation(async () => {
      const document = await this.missionStore.read();
      const index = document.missions.findIndex((mission) => mission.id === missionId);
      if (index < 0) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission was not found');
      const mission = document.missions[index]!;
      const duplicate = mission.lastOrchestratorHandoff;
      if (mission.orchestratorHandoffIds.includes(handoffId)) {
        if (duplicate?.handoffId === handoffId && duplicate.expectedVersion === expectedVersionInput && duplicate.from !== duplicate.to && duplicate.to === targetMode) return mission;
        throw new RuntimeError('INVALID_REQUEST', 'handoffId was already used by this mission');
      }
      if (mission.orchestratorVersion !== expectedVersionInput) throw new RuntimeError('INVALID_REQUEST', 'Orchestrator handoff expectedVersion is stale');
      if (mission.orchestratorHandoffIds.length >= 64) throw new RuntimeError('CAPABILITY_DENIED', 'Mission orchestrator handoff history capacity has been reached');
      if (mission.orchestratorMode === targetMode) throw new RuntimeError('INVALID_REQUEST', 'Mission already uses the requested orchestrator mode');
      const handoff = missionHandoffSafety(mission, externalHandoffSafe);
      if (!handoff.safe) throw new RuntimeError('CAPABILITY_DENIED', handoff.reason);
      const now = new Date().toISOString();
      const updated: MissionSnapshot = {
        ...mission,
        orchestratorMode: targetMode,
        orchestratorVersion: mission.orchestratorVersion + 1,
        lastOrchestratorHandoff: {
          handoffId,
          expectedVersion: expectedVersionInput,
          from: mission.orchestratorMode,
          to: targetMode,
          completedAt: now,
        },
        orchestratorHandoffIds: [...mission.orchestratorHandoffIds, handoffId],
        updatedAt: now,
        timeline: appendMissionEvent(mission.timeline, missionEvent('ORCHESTRATOR_MODE_CHANGED', `Operational orchestrator changed from ${mission.orchestratorMode} to ${targetMode}`, null, null, now)),
      };
      const missions = [...document.missions];
      missions[index] = updated;
      await this.missionStore.write({ schemaVersion: 1, missions });
      return updated;
    });
  }

  public missionHandoffSafety(mission: MissionSnapshot, externalHandoffSafe = true): { safe: boolean; reason: string } {
    return missionHandoffSafety(mission, externalHandoffSafe);
  }

  public async assertMissionOrchestrator(missionIdInput: string, expectedMode: OrchestratorMode): Promise<MissionSnapshot> {
    const mission = await this.getMission(missionIdInput);
    if (mission.orchestratorMode !== expectedMode) {
      throw new RuntimeError('CAPABILITY_DENIED', `Mission operational orchestrator is ${mission.orchestratorMode}, not ${expectedMode}`);
    }
    return mission;
  }

  public async validateMissionActionAssociation(
    association: MissionExecutionAssociation,
    capabilityId: CapabilityId,
    clientIdInput: string,
    sessionIdInput: string,
  ): Promise<void> {
    const clientId = normalizeClientId(clientIdInput);
    const sessionId = normalizeUuidIdentity(sessionIdInput, 'sessionId');
    const session = this.getSessionForClient(sessionId, clientId);
    const mission = await this.getMission(association.missionId);
    assertMissionControlIdentity(mission, clientId, sessionId);
    if (mission.orchestratorMode !== association.orchestratorMode) {
      throw new RuntimeError('CAPABILITY_DENIED', `Mission operational orchestrator is ${mission.orchestratorMode}, not ${association.orchestratorMode}`);
    }
    if (mission.projectId !== session.currentProjectId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Mission project no longer matches the live session project');
    }
    const { action } = findMissionAction(mission, association);
    if (action.capabilityId !== capabilityId) throw new RuntimeError('CAPABILITY_DENIED', 'Mission action capability does not match the governed operation');
    if (action.state !== 'PLANNED') {
      throw new RuntimeError('CAPABILITY_DENIED', 'Mission action is not eligible for initial execution');
    }
  }

  public async validateMissionApprovalAssociation(
    association: MissionExecutionAssociation,
    capabilityId: CapabilityId,
    clientIdInput: string,
    sessionIdInput: string,
    approvalIdInput: string,
  ): Promise<void> {
    const clientId = normalizeClientId(clientIdInput);
    const sessionId = normalizeUuidIdentity(sessionIdInput, 'sessionId');
    const approvalId = normalizeUuidIdentity(approvalIdInput, 'approvalId');
    const session = this.getSessionForClient(sessionId, clientId);
    const mission = await this.getMission(association.missionId);
    assertMissionControlIdentity(mission, clientId, sessionId);
    if (mission.orchestratorMode !== association.orchestratorMode) {
      throw new RuntimeError('CAPABILITY_DENIED', `Mission operational orchestrator is ${mission.orchestratorMode}, not ${association.orchestratorMode}`);
    }
    if (mission.projectId !== session.currentProjectId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Mission project no longer matches the live session project');
    }
    if (mission.state === 'COMPLETED' || mission.state === 'FAILED' || mission.state === 'CANCELLED') {
      throw new RuntimeError('CAPABILITY_DENIED', 'Mission is no longer eligible for approved action execution');
    }
    const { action } = findMissionAction(mission, association);
    if (action.capabilityId !== capabilityId) throw new RuntimeError('CAPABILITY_DENIED', 'Mission action capability does not match the approved operation');
    if (action.state !== 'OWNER_APPROVAL_REQUIRED' || action.approvalId !== approvalId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Mission approval is stale or does not match the exact pending action');
    }
  }

  public markMissionActionStarted(association: MissionExecutionAssociation): Promise<void> {
    return this.updateMissionAction(association, (mission, task, action, now) => {
      if (mission.orchestratorMode !== association.orchestratorMode) {
        throw new RuntimeError('CAPABILITY_DENIED', `Mission operational orchestrator is ${mission.orchestratorMode}, not ${association.orchestratorMode}`);
      }
      if (action.state !== 'PLANNED' && action.state !== 'OWNER_APPROVAL_REQUIRED') {
        throw new RuntimeError('CAPABILITY_DENIED', 'Mission action is not eligible to start');
      }
      return {
        mission: {
          ...mission,
          updatedAt: now,
          timeline: appendMissionEvent(mission.timeline, missionEvent('ACTION_STARTED', `Governed action started: ${action.capabilityId}`, task.id, action.id, now)),
        },
        action: { ...action, state: 'RUNNING', updatedAt: now },
      };
    });
  }

  public markMissionActionApprovalRequired(association: MissionExecutionAssociation, approvalId: string): Promise<void> {
    normalizeUuidIdentity(approvalId, 'approvalId');
    return this.updateMissionAction(association, (mission, task, action, now) => ({
      mission: {
        ...mission,
        updatedAt: now,
        timeline: appendMissionEvent(mission.timeline, missionEvent('APPROVAL_REQUIRED', 'Owner approval is required before the governed action can execute', task.id, action.id, now)),
      },
      action: {
        ...action,
        state: 'OWNER_APPROVAL_REQUIRED',
        updatedAt: now,
        approvalId,
        result: { status: 'OWNER_REQUIRED', summary: 'Owner approval required', approvalId, completedAt: null, evidence: [] },
      },
    }));
  }

  public markMissionActionSucceeded(
    association: MissionExecutionAssociation,
    capabilityId: CapabilityId,
    value: unknown,
    effectiveEffects: readonly CapabilityEffect[] = [],
  ): Promise<void> {
    return this.updateMissionAction(association, (mission, task, action, now) => ({
      mission: {
        ...mission,
        updatedAt: now,
        timeline: appendMissionEvent(mission.timeline, missionEvent('ACTION_SUCCEEDED', `Governed action succeeded: ${capabilityId}`, task.id, action.id, now)),
      },
      action: {
        ...action,
        state: 'SUCCEEDED',
        updatedAt: now,
        result: {
          status: 'SUCCEEDED',
          summary: 'Governed capability executed successfully',
          approvalId: action.approvalId,
          completedAt: now,
          evidence: missionEvidence(capabilityId, value, effectiveEffects),
        },
      },
    }));
  }

  public appendMissionActionEvidence(
    missionIdInput: string,
    taskIdInput: string,
    actionIdInput: string,
    capabilityId: CapabilityId,
    evidence: MissionEvidence,
  ): Promise<void> {
    const missionId = normalizeUuidIdentity(missionIdInput, 'missionId');
    const taskId = normalizeUuidIdentity(taskIdInput, 'taskId');
    const actionId = normalizeUuidIdentity(actionIdInput, 'actionId');
    if (evidence.id.length === 0 || evidence.id.length > 200 || evidence.id.includes('\0')
      || evidence.label.length === 0 || evidence.label.length > 120 || evidence.label.includes('\0')
      || evidence.summary.length === 0 || evidence.summary.length > 500 || evidence.summary.includes('\0')
      || (evidence.reference !== null && (evidence.reference.length > 2_048 || evidence.reference.includes('\0')))) {
      throw new RuntimeError('INVALID_REQUEST', 'Mission action evidence is invalid');
    }
    return this.serializeMissionMutation(async () => {
      const document = await this.missionStore.read();
      const missionIndex = document.missions.findIndex((mission) => mission.id === missionId);
      if (missionIndex < 0) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission was not found');
      const mission = document.missions[missionIndex]!;
      const task = mission.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission task was not found');
      const action = task.actions.find((candidate) => candidate.id === actionId);
      if (action === undefined) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission action was not found');
      if (action.capabilityId !== capabilityId || action.state !== 'SUCCEEDED' || action.result?.status !== 'SUCCEEDED') {
        throw new RuntimeError('CAPABILITY_DENIED', 'Mission action is not eligible for terminal evidence attachment');
      }
      const existingByReference = evidence.reference === null ? undefined : action.result.evidence.find((item) => item.reference === evidence.reference);
      if (existingByReference !== undefined) {
        if (JSON.stringify(existingByReference) === JSON.stringify(evidence)) return;
        throw new RuntimeError('PRECONDITION_FAILED', 'Mission action evidence reference is already bound to different content');
      }
      if (mission.state === 'COMPLETED' || mission.state === 'FAILED' || mission.state === 'CANCELLED') {
        throw new RuntimeError('CAPABILITY_DENIED', 'Terminal mission cannot accept new action evidence');
      }
      if (action.result.evidence.length >= 64) throw new RuntimeError('CAPABILITY_DENIED', 'Mission action evidence capacity has been reached');
      const now = new Date().toISOString();
      const tasks = mission.tasks.map((candidateTask) => candidateTask.id !== taskId ? candidateTask : {
        ...candidateTask,
        updatedAt: now,
        actions: candidateTask.actions.map((candidateAction) => candidateAction.id !== actionId ? candidateAction : {
          ...candidateAction,
          updatedAt: now,
          result: {
            ...candidateAction.result!,
            evidence: [...candidateAction.result!.evidence, evidence],
          },
        }),
      });
      const missions = [...document.missions];
      missions[missionIndex] = { ...mission, tasks, updatedAt: now };
      await this.missionStore.write({ schemaVersion: 1, missions });
    });
  }

  public markMissionActionDenied(association: MissionExecutionAssociation, summary = 'Governed capability was denied'): Promise<void> {
    return this.updateMissionAction(association, (mission, task, action, now) => ({
      mission: {
        ...mission,
        updatedAt: now,
        timeline: appendMissionEvent(mission.timeline, missionEvent('ACTION_DENIED', summary, task.id, action.id, now)),
      },
      action: {
        ...action,
        state: 'DENIED',
        updatedAt: now,
        result: { status: 'DENIED', summary, approvalId: action.approvalId, completedAt: now, evidence: [] },
      },
    }));
  }

  public markMissionActionFailed(association: MissionExecutionAssociation): Promise<void> {
    return this.updateMissionAction(association, (mission, task, action, now) => ({
      mission: {
        ...mission,
        updatedAt: now,
        timeline: appendMissionEvent(mission.timeline, missionEvent('ACTION_FAILED', 'Governed capability execution failed', task.id, action.id, now)),
      },
      action: {
        ...action,
        state: 'FAILED',
        updatedAt: now,
        result: { status: 'FAILED', summary: 'Governed capability execution failed', approvalId: action.approvalId, completedAt: now, evidence: [] },
      },
    }));
  }

  public createSession(clientIdInput?: string, agentIdInput?: string, agentRoleInput: AgentRole = 'other'): RuntimeSessionSnapshot {
    const clientId = normalizeClientId(clientIdInput ?? randomUUID());
    const agentId = normalizeAgentId(agentIdInput ?? randomUUID());
    const agentRole = normalizeAgentRole(agentRoleInput);
    const now = new Date().toISOString();
    const session: RuntimeSessionSnapshot = {
      id: randomUUID(),
      clientId,
      agentId,
      agentRole,
      createdAt: now,
      currentProjectId: null,
      executionState: 'READY',
      interactions: [],
    };
    this.sessions.set(session.id, session);
    this.submissionBindings.set(session.id, new Map());
    this.clients.set(clientId, { clientId, connected: true, lastSeenAt: now });
    return session;
  }

  public getSessionForClient(sessionId: string, clientIdInput: string): RuntimeSessionSnapshot {
    const clientId = normalizeClientId(clientIdInput);
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new RuntimeError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    if (session.clientId !== clientId) throw new RuntimeError('CONTROL_DENIED', 'Session does not belong to this client');
    if (session.attachmentState === 'CLOSED' || session.attachmentState === 'DETACHED') throw new RuntimeError('CONTROL_DENIED', 'Session is detached or closed; resume before using its authority');
    this.touchClient(clientId);
    return session;
  }

  public deleteSession(sessionId: string, clientIdInput: string): void {
    if (this.durableSessions.has(sessionId)) throw new RuntimeError('INVALID_REQUEST', 'Durable session close requires its requestId');
    const session = this.getSessionForClient(sessionId, clientIdInput);
    if (this.activeSubmissions.has(sessionId)) {
      throw new RuntimeError('SESSION_BUSY', 'Cannot delete a session while its instruction is executing');
    }
    this.sessions.delete(sessionId);
    this.submissionBindings.delete(sessionId);
    if (![...this.sessions.values()].some((candidate) => candidate.clientId === session.clientId)) {
      this.clients.set(session.clientId, {
        clientId: session.clientId,
        connected: false,
        lastSeenAt: new Date().toISOString(),
      });
    }
  }

  public async submitInstruction(
    sessionId: string,
    clientIdInput: string,
    submissionIdInput: string,
    instructionInput: string,
  ): Promise<RuntimeSessionSnapshot> {
    const clientId = normalizeClientId(clientIdInput);
    const submissionId = normalizeSubmissionId(submissionIdInput);
    const instruction = normalizeInstruction(instructionInput);
    const session = this.getSessionForClient(sessionId, clientId);
    const instructionDigest = sessionDigest(instruction);
    const durableSubmission = this.durableSessions.get(sessionId)?.submissions.find((entry) => entry.submissionId === submissionId);
    if (durableSubmission !== undefined) {
      if (durableSubmission.digest !== instructionDigest) throw new RuntimeError('AUTHORITY_CHANGED', 'submissionId is bound to different instruction content');
      if (durableSubmission.state === 'RUNNING' || durableSubmission.state === 'UNCERTAIN') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Instruction outcome requires reconciliation; it will not be replayed');
      return session;
    }
    const bindings = this.submissionBindings.get(sessionId) ?? new Map<string, string>();
    const boundInstruction = bindings.get(submissionId);
    if (boundInstruction !== undefined) {
      if (boundInstruction !== instruction) {
        throw new RuntimeError('INVALID_REQUEST', 'submissionId is already bound to a different instruction');
      }
      return session;
    }
    if (this.activeSubmissions.has(sessionId)) {
      throw new RuntimeError('SESSION_BUSY', 'This session is already executing an instruction');
    }

    const executionId = randomUUID();
    const timestamp = new Date().toISOString();
    const userEvent: SessionInteractionEvent = {
      id: randomUUID(),
      timestamp,
      kind: 'user',
      text: instruction,
      submissionId,
      executionId,
    };
    const working = appendInteraction({ ...session, executionState: 'WORKING' }, userEvent);
    this.activeSubmissions.set(sessionId, submissionId);
    try { await this.persistSessionExecution(working, submissionId, instructionDigest, 'RUNNING'); }
    catch (error) { this.activeSubmissions.delete(sessionId); throw error; }
    bindings.set(submissionId, instruction);
    this.submissionBindings.set(sessionId, bindings);
    this.activeSubmissions.set(sessionId, submissionId);
    this.touchClient(clientId);

    try {
      const project = working.currentProjectId === null
        ? null
        : (await this.listProjects()).find((candidate) => candidate.id === working.currentProjectId) ?? null;
      let result;
      try {
        result = await this.executor.execute({
          executionId,
          submissionId,
          sessionId,
          clientId,
          agentId: working.agentId,
          agentRole: working.agentRole,
          project,
          instruction,
        });
      } catch (error) {
        throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Agent execution failed', { cause: error });
      }
      const text = normalizeExecutorOutput(result.text);
      const current = this.sessions.get(sessionId)!;
      if (this.activeSubmissions.get(sessionId) !== submissionId) {
        throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Session execution ownership changed before completion');
      }
      const assistantEvent: SessionInteractionEvent = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        kind: 'assistant',
        text,
        submissionId,
        executionId,
      };
      const completed = appendInteraction({ ...current, executionState: 'READY' }, assistantEvent);
      await this.persistSessionExecution(completed, submissionId, instructionDigest, 'SUCCEEDED');
      return completed;
    } catch (error) {
      const current = this.sessions.get(sessionId)!;
      const errorEvent: SessionInteractionEvent = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        kind: 'error',
        text: executionFailureMessage(),
        submissionId,
        executionId,
      };
      await this.persistSessionExecution(appendInteraction({ ...current, executionState: 'FAILED' }, errorEvent), submissionId, instructionDigest, 'UNCERTAIN');
      if (error instanceof RuntimeError && error.code === 'AGENT_EXECUTION_FAILED') throw error;
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Agent execution failed', { cause: error });
    } finally {
      if (this.activeSubmissions.get(sessionId) === submissionId) this.activeSubmissions.delete(sessionId);
    }
  }

  public async listProjects(): Promise<readonly ProjectReference[]> {
    return (await this.store.read()).projects;
  }

  public async registerProject(nameInput: string, rootPathInput: string): Promise<ProjectReference> {
    const canonical = await canonicalProjectRoot(rootPathInput);
    return this.registerCanonicalProject(nameInput, canonical);
  }

  public registerCanonicalProject(nameInput: string, canonicalRoot: string): Promise<ProjectReference> {
    return this.serializeMachineMutation(async () => {
      const name = nameInput.trim();
      if (name.length === 0 || name.length > 120 || canonicalRoot.includes('\0') || !path.isAbsolute(canonicalRoot)) {
        throw new RuntimeError('INVALID_PROJECT_PATH', 'Project name and root path are invalid');
      }
      let physical: string;
      try {
        physical = await realpath(canonicalRoot);
        if (physical !== canonicalRoot || !(await stat(physical)).isDirectory() || physical === path.parse(physical).root) {
          throw new Error('project root changed identity');
        }
      } catch (error) {
        throw new RuntimeError('INVALID_PROJECT_PATH', 'Canonical project root is not a stable existing non-root directory', { cause: error });
      }

      const state = await this.store.read();
      const existing = state.projects.find((project) => project.rootPath === canonicalRoot);
      if (existing !== undefined) return existing;
      const project: ProjectReference = { id: randomUUID(), name, rootPath: canonicalRoot };
      await this.store.write({ ...state, projects: [...state.projects, project] });
      return project;
    });
  }

  public async getDefaultProjectId(): Promise<string | null> {
    return (await this.store.read()).defaultProjectId;
  }

  public setDefaultProject(projectId: string | null): Promise<void> {
    return this.serializeMachineMutation(async () => {
      const state = await this.store.read();
      if (projectId !== null && !state.projects.some((project) => project.id === projectId)) {
        throw new RuntimeError('PROJECT_NOT_FOUND', 'Default project does not exist');
      }
      await this.store.write({ ...state, defaultProjectId: projectId });
    });
  }

  public async setSessionCurrentProject(
    sessionId: string,
    clientIdInput: string,
    projectId: string | null,
  ): Promise<RuntimeSessionSnapshot> {
    if (this.durableSessions.has(sessionId)) return this.mutateSession({ operation: 'select', sessionId, clientId: clientIdInput, projectId, requestId: randomUUID() });
    const session = this.getSessionForClient(sessionId, clientIdInput);
    if (projectId !== null && !(await this.listProjects()).some((project) => project.id === projectId)) {
      throw new RuntimeError('PROJECT_NOT_FOUND', 'Current project does not exist');
    }
    const updated: RuntimeSessionSnapshot = { ...session, currentProjectId: projectId };
    this.sessions.set(sessionId, updated);
    this.touchClient(session.clientId);
    return updated;
  }

  private updateControlledMission(
    missionIdInput: string,
    clientIdInput: string,
    sessionIdInput: string,
    update: (mission: MissionSnapshot, now: string) => MissionSnapshot,
  ): Promise<MissionSnapshot> {
    const missionId = normalizeUuidIdentity(missionIdInput, 'missionId');
    const clientId = normalizeClientId(clientIdInput);
    const sessionId = normalizeUuidIdentity(sessionIdInput, 'sessionId');
    this.getSessionForClient(sessionId, clientId);
    return this.serializeMissionMutation(async () => {
      const document = await this.missionStore.read();
      const index = document.missions.findIndex((mission) => mission.id === missionId);
      if (index < 0) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission was not found');
      const mission = document.missions[index]!;
      assertMissionControlIdentity(mission, clientId, sessionId);
      const updated = update(mission, new Date().toISOString());
      const missions = [...document.missions];
      missions[index] = updated;
      await this.missionStore.write({ schemaVersion: 1, missions });
      return updated;
    });
  }

  private updateMissionAction(
    associationInput: MissionExecutionAssociation,
    update: (
      mission: MissionSnapshot,
      task: MissionSnapshot['tasks'][number],
      action: MissionSnapshot['tasks'][number]['actions'][number],
      now: string,
    ) => { mission: MissionSnapshot; action: MissionSnapshot['tasks'][number]['actions'][number] },
  ): Promise<void> {
    const association = normalizeMissionAssociation(associationInput);
    return this.serializeMissionMutation(async () => {
      const document = await this.missionStore.read();
      const missionIndex = document.missions.findIndex((mission) => mission.id === association.missionId);
      if (missionIndex < 0) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission was not found');
      const originalMission = document.missions[missionIndex]!;
      const located = findMissionAction(originalMission, association);
      const changed = update(originalMission, located.task, located.action, new Date().toISOString());
      const tasks = changed.mission.tasks.map((task) => task.id !== located.task.id ? task : {
        ...task,
        updatedAt: changed.action.updatedAt,
        actions: task.actions.map((action) => action.id === located.action.id ? changed.action : action),
      });
      const mission = { ...changed.mission, tasks };
      const missions = [...document.missions];
      missions[missionIndex] = mission;
      await this.missionStore.write({ schemaVersion: 1, missions });
    });
  }

  private serializeMissionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.missionMutationTail.then(operation, operation);
    this.missionMutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private serializeMachineMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private touchClient(clientId: string): void {
    this.clients.set(clientId, { clientId, connected: true, lastSeenAt: new Date().toISOString() });
  }
}

function appendInteraction(session: RuntimeSessionSnapshot, event: SessionInteractionEvent): RuntimeSessionSnapshot {
  const interactions = [...session.interactions, event];
  return {
    ...session,
    interactions: interactions.length > MAX_INTERACTION_EVENTS
      ? interactions.slice(interactions.length - MAX_INTERACTION_EVENTS)
      : interactions,
  };
}

function boundedSessionKey(value: string, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new RuntimeError('INVALID_REQUEST', `${name} must be an explicit bounded identity`);
  return value;
}
function missionRequestIdentity(requestId: string): string {
  const hex = createHash('sha256').update(`iris-mission-create:${requestId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function sessionDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function missionHandoffSafety(mission: MissionSnapshot, externalHandoffSafe: boolean): { safe: boolean; reason: string } {
  if (!externalHandoffSafe) return { safe: false, reason: 'Mission has an active or uncheckpointed orchestrator continuation' };
  if (mission.tasks.some((task) => task.actions.some((action) => action.state === 'RUNNING'))) {
    return { safe: false, reason: 'Mission has a governed action currently running' };
  }
  if (mission.tasks.some((task) => task.actions.some((action) => action.state === 'OWNER_APPROVAL_REQUIRED'))) {
    return { safe: false, reason: 'Mission has a governed action waiting for owner approval' };
  }
  if (mission.state !== 'PLANNED' && mission.state !== 'PAUSED' && mission.state !== 'WAITING_SUPERVISOR' && mission.state !== 'COMPLETED') {
    return { safe: false, reason: `Mission state ${mission.state} is not safe for orchestrator handoff` };
  }
  return { safe: true, reason: mission.state === 'COMPLETED' ? 'Completed mission mode is informational only' : 'Mission is checkpointed or inactive and safe for handoff' };
}

function normalizeMissionText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max || normalized.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', `${label} is invalid`);
  }
  return normalized;
}

function normalizeUuidIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new RuntimeError('INVALID_REQUEST', `${label} is invalid`);
  }
  return normalized;
}

function normalizeMissionAssociation(value: MissionExecutionAssociation): MissionExecutionAssociation {
  if (value.orchestratorMode !== 'HERMES' && value.orchestratorMode !== 'CHATGPT') {
    throw new RuntimeError('INVALID_REQUEST', 'Mission action orchestratorMode is invalid');
  }
  return {
    missionId: normalizeUuidIdentity(value.missionId, 'missionId'),
    taskId: normalizeUuidIdentity(value.taskId, 'taskId'),
    actionId: normalizeUuidIdentity(value.actionId, 'actionId'),
    orchestratorMode: value.orchestratorMode,
  };
}

function assertMissionControlIdentity(mission: MissionSnapshot, clientId: string, sessionId: string): void {
  if (mission.clientId !== clientId || mission.sessionId !== sessionId) {
    throw new RuntimeError('CONTROL_DENIED', 'Mission does not belong to this client/session identity');
  }
}

function assertMissionReviewActionsFinalized(mission: MissionSnapshot): void {
  const pending = mission.tasks.flatMap((task) => task.actions).filter((action) =>
    action.capabilityId === 'code_review.start'
    && action.state !== 'FAILED'
    && action.state !== 'DENIED'
    && !action.result?.evidence.some((item) =>
      (item.label === 'code_review.receipt' || item.label === 'code_review.failure_receipt')
      && typeof item.reference === 'string' && item.reference.startsWith('iris-review-job:')));
  if (pending.length > 0) {
    throw new RuntimeError('PRECONDITION_FAILED', 'Mission has unfinalized native code review actions');
  }
}

function findMissionAction(mission: MissionSnapshot, associationInput: MissionExecutionAssociation) {
  const association = normalizeMissionAssociation(associationInput);
  if (mission.id !== association.missionId) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission identity does not match the action association');
  const task = mission.tasks.find((candidate) => candidate.id === association.taskId);
  if (task === undefined) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission task was not found');
  const action = task.actions.find((candidate) => candidate.id === association.actionId);
  if (action === undefined) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission action was not found');
  return { task, action };
}

function missionEvent(
  kind: MissionSnapshot['timeline'][number]['kind'],
  message: string,
  taskId: string | null,
  actionId: string | null,
  timestamp = new Date().toISOString(),
): MissionSnapshot['timeline'][number] {
  return { id: randomUUID(), timestamp, kind, taskId, actionId, message };
}

function appendMissionEvent(
  events: readonly MissionSnapshot['timeline'][number][],
  event: MissionSnapshot['timeline'][number],
): readonly MissionSnapshot['timeline'][number][] {
  return [...events, event].slice(-1_000);
}

function missionEvidence(capabilityId: CapabilityId, value: unknown, effectiveEffects: readonly CapabilityEffect[] = []): readonly MissionEvidence[] {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const data: Record<string, string | number | boolean | null> = {};
  let reference: string | null = null;
  if (typeof record.targetPath === 'string') reference = record.targetPath.slice(0, 2_048);
  for (const key of ['bytes', 'created', 'deleted', 'passed', 'exitCode', 'timedOut', 'outputTruncated', 'verified'] as const) {
    const item = record[key];
    if (typeof item === 'number' && Number.isFinite(item)) data[key] = item;
    if (typeof item === 'boolean') data[key] = item;
  }
  if (capabilityId === 'file.read' && typeof record.content === 'string') data.bytes = Buffer.byteLength(record.content, 'utf8');
  if (typeof record.operation === 'string') data.operation = record.operation.slice(0, 100);
  if (typeof record.scriptName === 'string') data.scriptName = record.scriptName.slice(0, 100);
  if (typeof record.packageManager === 'string') data.packageManager = record.packageManager.slice(0, 20);
  if (typeof record.branch === 'string') data.branch = record.branch.slice(0, 255);
  if (typeof record.remote === 'string') data.remote = record.remote.slice(0, 100);
  if (typeof record.head === 'string') data.head = record.head.slice(0, 64);
  if (typeof record.localHead === 'string') data.localHead = record.localHead.slice(0, 64);
  if (typeof record.remoteHead === 'string') data.remoteHead = record.remoteHead.slice(0, 64);
  if (effectiveEffects.length > 0) data.effectiveEffects = effectiveEffects.join(',');
  return [{
    id: randomUUID(),
    kind: 'CAPABILITY_RESULT',
    label: capabilityId,
    summary: 'Governed capability result recorded without payload contents',
    reference,
    data,
  }];
}

async function canonicalProjectRoot(rootPathInput: string): Promise<string> {
  const inspected = await inspectRegistrationRoot(rootPathInput);
  if (!inspected.valid || inspected.target === null) {
    throw new RuntimeError('INVALID_PROJECT_PATH', inspected.reason);
  }
  return inspected.target;
}

function normalizeClientId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200 || normalized.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', 'clientId is invalid');
  }
  return normalized;
}

function normalizeAgentId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200 || normalized.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', 'agentId is invalid');
  }
  return normalized;
}

function normalizeAgentRole(value: AgentRole): AgentRole {
  if (value === 'owner' || value === 'planner' || value === 'implementer' || value === 'reviewer'
    || value === 'security' || value === 'explorer' || value === 'other') return value;
  throw new RuntimeError('INVALID_REQUEST', 'agentRole is invalid');
}

function normalizeSubmissionId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200 || normalized.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', 'submissionId is invalid');
  }
  return normalized;
}

function normalizeInstruction(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_INSTRUCTION_CHARS || normalized.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', `instruction must contain 1-${MAX_INSTRUCTION_CHARS} characters`);
  }
  return normalized;
}

function normalizeExecutorOutput(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_EXECUTOR_OUTPUT_CHARS || normalized.includes('\0')) {
    throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Executor returned an invalid bounded response');
  }
  return normalized;
}

function executionFailureMessage(): string {
  return 'Execution could not be completed.';
}
