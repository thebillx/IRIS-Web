import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
} from '@iris/domain';
import { LocalDevelopmentAgentExecutor, type AgentExecutor } from './agent-executor.js';
import { FoundationStateStore } from './persistence.js';
import { MissionLedgerStore, missionArchiveEligible } from './mission-store.js';
import { inspectRegistrationRoot } from './project-path.js';
import type { ProductionSafetyController } from './production-safety.js';
import { primaryWorkspaceId, VNextResourceRegistry } from './resource-registry.js';

const MAX_INSTRUCTION_CHARS = 8_000;
const MAX_INTERACTION_EVENTS = 200;
const MAX_EXECUTOR_OUTPUT_CHARS = 12_000;
const SESSION_FILE = 'sessions.json';

export interface MissionRebindInput {
  readonly missionId: string;
  readonly clientId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly expectedBindingRevision: number;
  readonly reason: string;
  readonly principal?: 'owner' | 'tunnel-service';
}

interface PersistedSession {
  readonly snapshot: RuntimeSessionSnapshot;
  readonly submissions: readonly { readonly id: string; readonly instruction: string }[];
  readonly binding?: SessionBinding;
}

interface SessionDocument {
  readonly schemaVersion: 2;
  readonly authority: SessionAuthority | null;
  readonly sessions: readonly PersistedSession[];
}

export interface SessionBinding {
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}

export interface SessionAuthority {
  readonly machineId: string;
  readonly runtimeId: string;
}

export class RuntimeState {
  private readonly sessions = new Map<string, RuntimeSessionSnapshot>();
  private readonly clients = new Map<string, RuntimeClientState>();
  private readonly activeSubmissions = new Map<string, string>();
  private readonly submissionBindings = new Map<string, Map<string, string>>();
  private readonly sessionBindings = new Map<string, SessionBinding>();
  private readonly invalidSessionBindings = new Set<string>();
  private mutationTail: Promise<void> = Promise.resolve();
  private missionMutationTail: Promise<void> = Promise.resolve();
  private sessionsNeedPersistence = false;

  public readonly dataRoot: string;

  public constructor(
    private readonly store: FoundationStateStore,
    private readonly executor: AgentExecutor = new LocalDevelopmentAgentExecutor(),
    private readonly missionStore: MissionLedgerStore = new MissionLedgerStore(store.dataRoot),
    private readonly safety?: ProductionSafetyController,
    private readonly sessionAuthority?: SessionAuthority,
  ) {
    this.dataRoot = store.dataRoot;
    this.restoreSessions();
  }

  public executorDescriptor() {
    return this.executor.descriptor;
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
      if (mission.bindingRevision !== input.expectedBindingRevision) {
        throw new RuntimeError('INVALID_REQUEST', 'Mission binding revision is stale');
      }
      if (mission.clientId === clientId && mission.sessionId === sessionId) return mission;
      if (this.activeSubmissions.has(mission.sessionId) || mission.tasks.some((task) => task.actions.some((action) => action.state === 'RUNNING' || action.state === 'OWNER_APPROVAL_REQUIRED'))) {
        throw new RuntimeError('SESSION_BUSY', 'Mission has active mutation authority and cannot be rebound yet');
      }
      const now = new Date().toISOString();
      const bindingRevision = mission.bindingRevision + 1;
      const audit: MissionRebindAuditEvent = {
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
      if (existing.clientId !== mission.clientId || existing.currentProjectId !== mission.projectId) {
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
    return this.serializeMachineMutation(async () => {
      const current = this.sessions.get(mission.sessionId);
      if (current !== undefined) return current;
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
      this.sessionBindings.set(session.id, {
        projectId: mission.projectId,
        workspaceId: mission.projectId === null ? null : primaryWorkspaceId(mission.projectId),
      });
      this.clients.set(session.clientId, { clientId: session.clientId, connected: true, lastSeenAt: now });
      this.persistSessions();
      return session;
    });
  }

  public createMission(clientIdInput: string, sessionIdInput: string, titleInput: string, orchestratorMode: OrchestratorMode = 'HERMES'): Promise<MissionSnapshot> {
    const clientId = normalizeClientId(clientIdInput);
    const sessionId = normalizeUuidIdentity(sessionIdInput, 'sessionId');
    const title = normalizeMissionText(titleInput, 'mission title', 240);
    const session = this.getSessionForClient(sessionId, clientId);
    return this.serializeMissionMutation(async () => {
      let document = await this.missionStore.read();
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
        id: randomUUID(),
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
    const session = this.createSessionInMemory(clientIdInput, agentIdInput, agentRoleInput);
    if (this.safety === undefined) this.persistSessions();
    else void this.serializeMachineMutation(async () => { this.persistSessions(); }).catch(() => undefined); // shortcut: legacy synchronous callers cannot await the fence; production capability routes use the durable API
    return session;
  }

  public createSessionDurable(clientIdInput?: string, agentIdInput?: string, agentRoleInput: AgentRole = 'other'): Promise<RuntimeSessionSnapshot> {
    return this.serializeMachineMutation(async () => {
      const session = this.createSessionInMemory(clientIdInput, agentIdInput, agentRoleInput);
      try {
        this.persistSessions();
      } catch (error) {
        this.sessions.delete(session.id);
        this.submissionBindings.delete(session.id);
        this.sessionBindings.delete(session.id);
        this.invalidSessionBindings.delete(session.id);
        if (![...this.sessions.values()].some((candidate) => candidate.clientId === session.clientId)) this.clients.delete(session.clientId);
        throw error;
      }
      return session;
    });
  }

  public ensureSessionForProjectDurable(
    clientIdInput: string,
    agentIdInput: string,
    agentRoleInput: AgentRole,
    projectId: string,
  ): Promise<RuntimeSessionSnapshot> {
    return this.serializeMachineMutation(async () => {
      const clientId = normalizeClientId(clientIdInput);
      const existing = [...this.sessions.values()]
        .filter((session) => session.clientId === clientId && session.agentId === agentIdInput && session.currentProjectId === projectId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (existing !== undefined) return existing;
      if (!(await this.listProjects()).some((project) => project.id === projectId)) {
        throw new RuntimeError('PROJECT_NOT_FOUND', 'Current project does not exist');
      }
      const previousClient = this.clients.get(clientId);
      const created = this.createSessionInMemory(clientId, agentIdInput, agentRoleInput);
      const session = { ...created, currentProjectId: projectId };
      this.sessions.set(session.id, session);
      this.sessionBindings.set(session.id, { projectId, workspaceId: primaryWorkspaceId(projectId) });
      try {
        this.persistSessions();
      } catch (error) {
        this.sessions.delete(session.id);
        this.submissionBindings.delete(session.id);
        this.sessionBindings.delete(session.id);
        this.invalidSessionBindings.delete(session.id);
        if (previousClient === undefined) this.clients.delete(clientId);
        else this.clients.set(clientId, previousClient);
        throw error;
      }
      return session;
    });
  }

  private createSessionInMemory(clientIdInput?: string, agentIdInput?: string, agentRoleInput: AgentRole = 'other'): RuntimeSessionSnapshot {
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
    this.sessionBindings.set(session.id, { projectId: null, workspaceId: null });
    this.clients.set(clientId, { clientId, connected: true, lastSeenAt: now });
    return session;
  }

  public getSessionForClient(sessionId: string, clientIdInput: string): RuntimeSessionSnapshot {
    const clientId = normalizeClientId(clientIdInput);
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new RuntimeError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    if (session.clientId !== clientId) throw new RuntimeError('CONTROL_DENIED', 'Session does not belong to this client');
    if (this.invalidSessionBindings.has(sessionId)) throw new RuntimeError('AUTHORITY_CHANGED', 'Session project or workspace binding is no longer authorized');
    this.touchClient(clientId);
    return session;
  }

  public getSessionForDetach(sessionId: string, clientIdInput: string): RuntimeSessionSnapshot {
    const clientId = normalizeClientId(clientIdInput);
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new RuntimeError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    if (session.clientId !== clientId) throw new RuntimeError('CONTROL_DENIED', 'Session does not belong to this client');
    this.touchClient(clientId);
    return session;
  }

  public async revalidateSessionBindings(): Promise<void> {
    const projects = await this.listProjects();
    const resources = new VNextResourceRegistry(this, this.dataRoot);
    for (const session of this.sessions.values()) {
      const binding = this.sessionBindings.get(session.id);
      if (binding === undefined || binding.projectId === null) {
        this.invalidSessionBindings.delete(session.id);
        continue;
      }
      if (!projects.some((project) => project.id === binding.projectId)) {
        this.invalidSessionBindings.add(session.id);
        continue;
      }
      try {
        const workspace = await resources.getActiveWorkspace(binding.projectId, binding.workspaceId ?? '');
        if (workspace.projectId !== binding.projectId || workspace.workspaceId !== binding.workspaceId) {
          this.invalidSessionBindings.add(session.id);
          continue;
        }
        this.invalidSessionBindings.delete(session.id);
      } catch {
        this.invalidSessionBindings.add(session.id);
      }
    }
  }

  public getSessionWorkspaceBinding(sessionId: string, clientIdInput: string): SessionBinding {
    const session = this.getSessionForClient(sessionId, clientIdInput);
    return { ...(this.sessionBindings.get(session.id) ?? { projectId: session.currentProjectId, workspaceId: null }) };
  }

  public async assertSessionWorkspace(
    sessionId: string,
    clientIdInput: string,
    projectId: string,
    workspaceId: string,
  ): Promise<void> {
    const session = this.getSessionForClient(sessionId, clientIdInput);
    const binding = this.sessionBindings.get(session.id);
    if (session.currentProjectId !== projectId || binding?.projectId !== projectId || binding.workspaceId !== workspaceId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Session is not authorized for the requested workspace');
    }
    try {
      const workspace = await new VNextResourceRegistry(this, this.dataRoot).getActiveWorkspace(projectId, workspaceId);
      if (workspace.projectId !== projectId || workspace.workspaceId !== workspaceId) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Session workspace binding changed before use');
      }
    } catch (error) {
      this.invalidSessionBindings.add(session.id);
      if (error instanceof RuntimeError && error.code === 'AUTHORITY_CHANGED') throw error;
      throw new RuntimeError('AUTHORITY_CHANGED', 'Session workspace binding is no longer authorized', { cause: error });
    }
  }

  public async bindSessionWorkspace(
    sessionId: string,
    clientIdInput: string,
    projectId: string,
    workspaceId: string,
  ): Promise<RuntimeSessionSnapshot> {
    return this.serializeMachineMutation(async () => {
      const session = this.getSessionForClient(sessionId, clientIdInput);
      if (session.currentProjectId !== projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace binding does not match the selected session project');
      const workspace = await new VNextResourceRegistry(this, this.dataRoot).getActiveWorkspace(projectId, workspaceId);
      const previous = this.sessionBindings.get(sessionId);
      const previousInvalid = this.invalidSessionBindings.has(sessionId);
      this.sessionBindings.set(sessionId, { projectId, workspaceId: workspace.workspaceId });
      this.invalidSessionBindings.delete(sessionId);
      try {
        this.persistSessions();
      } catch (error) {
        if (previous === undefined) this.sessionBindings.delete(sessionId);
        else this.sessionBindings.set(sessionId, previous);
        if (previousInvalid) this.invalidSessionBindings.add(sessionId);
        else this.invalidSessionBindings.delete(sessionId);
        throw error;
      }
      return session;
    });
  }

  public async selectSessionWorkspace(
    sessionId: string,
    clientIdInput: string,
    projectId: string,
    workspaceId: string,
  ): Promise<RuntimeSessionSnapshot> {
    return this.serializeMachineMutation(async () => {
      const session = this.getSessionForClient(sessionId, clientIdInput);
      if (!(await this.listProjects()).some((project) => project.id === projectId)) {
        throw new RuntimeError('PROJECT_NOT_FOUND', 'Current project does not exist');
      }
      const workspace = await new VNextResourceRegistry(this, this.dataRoot).getActiveWorkspace(projectId, workspaceId);
      const previousBinding = this.sessionBindings.get(sessionId);
      const previousInvalid = this.invalidSessionBindings.has(sessionId);
      const previousClient = this.clients.get(session.clientId);
      const updated = { ...session, currentProjectId: projectId };
      this.sessions.set(sessionId, updated);
      this.sessionBindings.set(sessionId, { projectId, workspaceId: workspace.workspaceId });
      this.invalidSessionBindings.delete(sessionId);
      this.touchClient(session.clientId);
      try {
        this.persistSessions();
      } catch (error) {
        this.sessions.set(sessionId, session);
        if (previousBinding === undefined) this.sessionBindings.delete(sessionId);
        else this.sessionBindings.set(sessionId, previousBinding);
        if (previousInvalid) this.invalidSessionBindings.add(sessionId);
        else this.invalidSessionBindings.delete(sessionId);
        if (previousClient === undefined) this.clients.delete(session.clientId);
        else this.clients.set(session.clientId, previousClient);
        throw error;
      }
      return updated;
    });
  }

  public deleteSession(sessionId: string, clientIdInput: string): void {
    this.deleteSessionInMemory(sessionId, clientIdInput);
    if (this.safety === undefined) this.persistSessions();
    else void this.serializeMachineMutation(async () => { this.persistSessions(); }).catch(() => undefined); // shortcut: legacy synchronous callers cannot await the fence; production capability routes use the durable API
  }

  public deleteSessionDurable(sessionId: string, clientIdInput: string): Promise<void> {
    return this.serializeMachineMutation(async () => {
      const session = this.getSessionForDetach(sessionId, clientIdInput);
      const binding = this.sessionBindings.get(sessionId);
      const submissions = this.submissionBindings.get(sessionId);
      const invalid = this.invalidSessionBindings.has(sessionId);
      const client = this.clients.get(session.clientId);
      this.deleteSessionInMemory(sessionId, clientIdInput);
      try {
        this.persistSessions();
      } catch (error) {
        this.sessions.set(sessionId, session);
        if (submissions !== undefined) this.submissionBindings.set(sessionId, submissions);
        if (binding !== undefined) this.sessionBindings.set(sessionId, binding);
        if (invalid) this.invalidSessionBindings.add(sessionId);
        if (client !== undefined) this.clients.set(session.clientId, client);
        else this.clients.delete(session.clientId);
        throw error;
      }
    });
  }

  private deleteSessionInMemory(sessionId: string, clientIdInput: string): void {
    const session = this.getSessionForDetach(sessionId, clientIdInput);
    if (this.activeSubmissions.has(sessionId)) {
      throw new RuntimeError('SESSION_BUSY', 'Cannot delete a session while its instruction is executing');
    }
    this.sessions.delete(sessionId);
    this.submissionBindings.delete(sessionId);
    this.sessionBindings.delete(sessionId);
    this.invalidSessionBindings.delete(sessionId);
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
    const started = this.safety === undefined
      ? this.startInstructionInMemory(sessionId, clientId, submissionId, instruction)
      : await this.serializeMachineMutation(async () => this.startInstructionInMemory(sessionId, clientId, submissionId, instruction));
    if (started.duplicate !== null) return started.duplicate;
    if (started.executionId === undefined || started.working === undefined) throw new RuntimeError('PERSISTENCE_FAILURE', 'Session execution admission returned an incomplete record');
    const { executionId, working } = started;

    try {
      const project = working.currentProjectId === null
        ? null
        : (await this.listProjects()).find((candidate) => candidate.id === working.currentProjectId) ?? null;
      if (working.currentProjectId !== null && project === null) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Session project binding is no longer registered');
      }
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
      return await this.serializeMachineMutation(async () => {
        const current = this.getSessionForClient(sessionId, clientId);
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
        this.sessions.set(sessionId, completed);
        try {
          this.persistSessions();
        } catch (error) {
          const uncertainEvent: SessionInteractionEvent = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            kind: 'error',
            text: 'Execution completed but publication was uncertain; verify durable state before retrying',
            submissionId,
            executionId,
          };
          this.sessions.set(sessionId, appendInteraction({ ...current, executionState: 'UNCERTAIN' }, uncertainEvent));
          throw new RuntimeError('PERSISTENCE_FAILURE', 'Executor completed but session completion publication failed; execution outcome is uncertain', { cause: error });
        }
        return completed;
      });
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'PERSISTENCE_FAILURE') throw error;
      await this.serializeMachineMutation(async () => {
        const current = this.getSessionForClient(sessionId, clientId);
        const errorEvent: SessionInteractionEvent = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          kind: 'error',
          text: executionFailureMessage(),
          submissionId,
          executionId,
        };
        this.sessions.set(sessionId, appendInteraction({ ...current, executionState: 'FAILED' }, errorEvent));
        this.persistSessions();
      });
      if (error instanceof RuntimeError && (error.code === 'AGENT_EXECUTION_FAILED' || error.code === 'AUTHORITY_CHANGED')) throw error;
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Agent execution failed', { cause: error });
    } finally {
      if (this.activeSubmissions.get(sessionId) === submissionId) this.activeSubmissions.delete(sessionId);
    }
  }

  private startInstructionInMemory(
    sessionId: string,
    clientId: string,
    submissionId: string,
    instruction: string,
  ): { readonly duplicate: RuntimeSessionSnapshot | null; readonly executionId?: string; readonly working?: RuntimeSessionSnapshot } {
    const session = this.getSessionForClient(sessionId, clientId);
    const previousBindings = this.submissionBindings.get(sessionId);
    const previousClient = this.clients.get(clientId);
    const previousActiveSubmission = this.activeSubmissions.get(sessionId);
    const bindings = new Map(this.submissionBindings.get(sessionId) ?? new Map<string, string>());
    const boundInstruction = bindings.get(submissionId);
    if (boundInstruction !== undefined) {
      if (boundInstruction !== instruction) {
        throw new RuntimeError('INVALID_REQUEST', 'submissionId is already bound to a different instruction');
      }
      return { duplicate: session as RuntimeSessionSnapshot };
    }
    if (session.executionState === 'UNCERTAIN') {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Session execution outcome is uncertain; verify durable state before submitting new work');
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
    this.sessions.set(sessionId, working);
    bindings.set(submissionId, instruction);
    this.submissionBindings.set(sessionId, bindings);
    this.activeSubmissions.set(sessionId, submissionId);
    this.touchClient(clientId);
    try {
      this.persistSessions();
    } catch (error) {
      this.sessions.set(sessionId, session);
      if (previousBindings === undefined) this.submissionBindings.delete(sessionId);
      else this.submissionBindings.set(sessionId, previousBindings);
      if (previousActiveSubmission === undefined) this.activeSubmissions.delete(sessionId);
      else this.activeSubmissions.set(sessionId, previousActiveSubmission);
      if (previousClient === undefined) this.clients.delete(clientId);
      else this.clients.set(clientId, previousClient);
      throw error;
    }
    return { duplicate: null, executionId, working };
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
    return this.serializeMachineMutation(async () => {
      if (projectId !== null && !(await this.listProjects()).some((project) => project.id === projectId)) {
        throw new RuntimeError('PROJECT_NOT_FOUND', 'Current project does not exist');
      }
      const session = this.getSessionForClient(sessionId, clientIdInput);
      const updated: RuntimeSessionSnapshot = { ...session, currentProjectId: projectId };
      const previousBinding = this.sessionBindings.get(sessionId);
      const previousInvalid = this.invalidSessionBindings.has(sessionId);
      const previousClient = this.clients.get(session.clientId);
      this.sessions.set(sessionId, updated);
      this.sessionBindings.set(sessionId, {
        projectId,
        workspaceId: projectId === null ? null : primaryWorkspaceId(projectId),
      });
      this.touchClient(session.clientId);
      try {
        this.persistSessions();
      } catch (error) {
        this.sessions.set(sessionId, session);
        if (previousBinding === undefined) this.sessionBindings.delete(sessionId);
        else this.sessionBindings.set(sessionId, previousBinding);
        if (previousInvalid) this.invalidSessionBindings.add(sessionId);
        else this.invalidSessionBindings.delete(sessionId);
        if (previousClient === undefined) this.clients.delete(session.clientId);
        else this.clients.set(session.clientId, previousClient);
        throw error;
      }
      return updated;
    });
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
    const result = this.missionMutationTail.then(() => this.withSafety('mission-state', operation), () => this.withSafety('mission-state', operation));
    this.missionMutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private serializeMachineMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(() => this.withSafety('runtime-state', operation), () => this.withSafety('runtime-state', operation));
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withSafety<T>(writer: string, operation: () => Promise<T>): Promise<T> {
    const lease = this.safety === undefined ? null : await this.safety.beginMutation(writer);
    try { return await operation(); } finally { await lease?.release(); }
  }

  private restoreSessions(): void {
    const filename = path.join(this.dataRoot, SESSION_FILE);
    let content: string;
    try {
      const inspected = lstatSync(filename);
      if (!inspected.isFile() || inspected.isSymbolicLink()) throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime session store is not a regular file');
      if (typeof process.getuid === 'function' && inspected.uid !== process.getuid()) throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime session store is not owned by the current user');
      if ((inspected.mode & 0o077) !== 0) throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime session store is not private');
      content = readFileSync(filename, 'utf8');
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime session store is unreadable', { cause: error });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(content) as unknown; } catch (error) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime session store is invalid JSON', { cause: error });
    }
    if (!isSessionDocument(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime session store is invalid');
    if (this.sessionAuthority !== undefined) {
      const persistedAuthority = parsed.authority ?? null;
      if (persistedAuthority === null || persistedAuthority.machineId !== this.sessionAuthority.machineId || persistedAuthority.runtimeId !== this.sessionAuthority.runtimeId) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Persisted session authority belongs to another machine or runtime');
      }
    }
    const seen = new Set<string>();
    let recovered = false;
    for (const persisted of parsed.sessions) {
      const session = persisted.snapshot.executionState === 'WORKING'
        ? { ...persisted.snapshot, executionState: 'UNCERTAIN' as const }
        : persisted.snapshot;
      recovered ||= session !== persisted.snapshot;
      if (seen.has(session.id)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime session store contains duplicate session identity');
      seen.add(session.id);
      const binding = persisted.binding ?? {
        projectId: session.currentProjectId,
        workspaceId: session.currentProjectId === null ? null : primaryWorkspaceId(session.currentProjectId),
      };
      if (binding.projectId !== session.currentProjectId || (binding.projectId === null ? binding.workspaceId !== null : binding.workspaceId === null)) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Persisted session project/workspace binding is inconsistent');
      }
      this.sessions.set(session.id, session);
      this.submissionBindings.set(session.id, new Map(persisted.submissions.map((submission) => [submission.id, submission.instruction])));
      this.sessionBindings.set(session.id, binding);
      this.clients.set(session.clientId, { clientId: session.clientId, connected: false, lastSeenAt: session.createdAt });
    }
    if (recovered) {
      if (this.safety === undefined) this.persistSessions();
      else this.sessionsNeedPersistence = true;
    }
  }

  public reconcileSessionPersistence(): Promise<void> {
    if (!this.sessionsNeedPersistence) return Promise.resolve();
    return this.serializeMachineMutation(async () => {
      if (!this.sessionsNeedPersistence) return;
      this.persistSessions();
      this.sessionsNeedPersistence = false;
    });
  }

  private persistSessions(): void {
    const document: SessionDocument = {
      schemaVersion: 2,
      authority: this.sessionAuthority ?? null,
      sessions: [...this.sessions.values()].map((snapshot) => ({
        snapshot,
        submissions: [...(this.submissionBindings.get(snapshot.id) ?? new Map())].map(([id, instruction]) => ({ id, instruction })),
        binding: this.sessionBindings.get(snapshot.id) ?? {
          projectId: snapshot.currentProjectId,
          workspaceId: snapshot.currentProjectId === null ? null : primaryWorkspaceId(snapshot.currentProjectId),
        },
      })),
    };
    const filename = path.join(this.dataRoot, SESSION_FILE);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, filename);
    } catch (error: unknown) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime session state publication failed', { cause: error });
    }
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

function isSessionDocument(value: unknown): value is SessionDocument {
  return isRecord(value)
    && (value.schemaVersion === 1 || value.schemaVersion === 2)
    && (value.schemaVersion === 1 || value.authority === null || isSessionAuthority(value.authority))
    && Array.isArray(value.sessions)
    && value.sessions.every(isPersistedSession)
    && new Set(value.sessions.map((session) => session.snapshot.id)).size === value.sessions.length;
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!isRecord(value) || !isRuntimeSessionSnapshot(value.snapshot) || !Array.isArray(value.submissions)) return false;
  if (value.binding !== undefined && !isSessionBinding(value.binding)) return false;
  const ids = new Set<string>();
  return value.submissions.every((submission) => {
    if (!isRecord(submission) || !isBoundedIdentity(submission.id) || !isBoundedText(submission.instruction, MAX_INSTRUCTION_CHARS) || ids.has(submission.id)) return false;
    ids.add(submission.id);
    return true;
  });
}

function isSessionBinding(value: unknown): value is SessionBinding {
  return isRecord(value)
    && (value.projectId === null || isUuid(value.projectId))
    && (value.workspaceId === null || isUuid(value.workspaceId));
}

function isSessionAuthority(value: unknown): value is SessionAuthority {
  return isRecord(value) && isUuid(value.machineId) && isUuid(value.runtimeId);
}

function isRuntimeSessionSnapshot(value: unknown): value is RuntimeSessionSnapshot {
  if (!isRecord(value)
    || !isUuid(value.id)
    || !isBoundedIdentity(value.clientId)
    || !isBoundedIdentity(value.agentId)
    || !isAgentRole(value.agentRole)
    || !isIsoDate(value.createdAt)
    || (value.currentProjectId !== null && !isUuid(value.currentProjectId))
    || !isSessionExecutionState(value.executionState)
    || !Array.isArray(value.interactions)
    || value.interactions.length > MAX_INTERACTION_EVENTS
    || !value.interactions.every(isSessionInteractionEvent)) return false;
  return true;
}

function isSessionInteractionEvent(value: unknown): value is SessionInteractionEvent {
  return isRecord(value)
    && isUuid(value.id)
    && isIsoDate(value.timestamp)
    && (value.kind === 'user' || value.kind === 'assistant' || value.kind === 'error')
    && isBoundedText(value.text, MAX_EXECUTOR_OUTPUT_CHARS)
    && isBoundedIdentity(value.submissionId)
    && isUuid(value.executionId);
}

function isAgentRole(value: unknown): value is AgentRole {
  return value === 'owner' || value === 'planner' || value === 'implementer' || value === 'reviewer'
    || value === 'security' || value === 'explorer' || value === 'other';
}

function isSessionExecutionState(value: unknown): value is RuntimeSessionSnapshot['executionState'] {
  return value === 'READY' || value === 'WORKING' || value === 'FAILED' || value === 'UNCERTAIN';
}

function isBoundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0') && value === value.trim();
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
