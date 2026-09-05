import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  RuntimeError,
  type AgentRole,
  type CapabilityId,
  type MissionExecutionAssociation,
  type MissionEvidence,
  type MissionSnapshot,
  type MissionState,
  type MissionTaskState,
  type ProjectReference,
  type SupervisorGateState,
  type RuntimeClientState,
  type RuntimeSessionSnapshot,
  type SessionInteractionEvent,
} from '@iris/domain';
import { LocalDevelopmentAgentExecutor, type AgentExecutor } from './agent-executor.js';
import { FoundationStateStore } from './persistence.js';
import { MissionLedgerStore } from './mission-store.js';
import { inspectRegistrationRoot } from './project-path.js';

const MAX_INSTRUCTION_CHARS = 8_000;
const MAX_INTERACTION_EVENTS = 200;
const MAX_EXECUTOR_OUTPUT_CHARS = 12_000;

export class RuntimeState {
  private readonly sessions = new Map<string, RuntimeSessionSnapshot>();
  private readonly clients = new Map<string, RuntimeClientState>();
  private readonly activeSubmissions = new Map<string, string>();
  private readonly submissionBindings = new Map<string, Map<string, string>>();
  private mutationTail: Promise<void> = Promise.resolve();
  private missionMutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly store: FoundationStateStore,
    private readonly executor: AgentExecutor = new LocalDevelopmentAgentExecutor(),
    private readonly missionStore: MissionLedgerStore = new MissionLedgerStore(store.dataRoot),
  ) {}

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
    if (mission === undefined) throw new RuntimeError('MISSION_NOT_FOUND', 'Mission was not found');
    return mission;
  }

  public createMission(clientIdInput: string, sessionIdInput: string, titleInput: string): Promise<MissionSnapshot> {
    const clientId = normalizeClientId(clientIdInput);
    const sessionId = normalizeUuidIdentity(sessionIdInput, 'sessionId');
    const title = normalizeMissionText(titleInput, 'mission title', 240);
    const session = this.getSessionForClient(sessionId, clientId);
    return this.serializeMissionMutation(async () => {
      const document = await this.missionStore.read();
      if (document.missions.length >= 100) throw new RuntimeError('CAPABILITY_DENIED', 'Mission ledger capacity has been reached');
      const now = new Date().toISOString();
      const mission: MissionSnapshot = {
        id: randomUUID(),
        title,
        state: 'PLANNED',
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
    return this.updateControlledMission(missionIdInput, clientIdInput, sessionIdInput, (mission, now) => ({
      ...mission,
      state,
      updatedAt: now,
      timeline: appendMissionEvent(mission.timeline, missionEvent('MISSION_STATE_CHANGED', `Mission state recorded as ${state}`, null, null, now)),
    }));
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
    if (mission.projectId !== session.currentProjectId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Mission project no longer matches the live session project');
    }
    const { action } = findMissionAction(mission, association);
    if (action.capabilityId !== capabilityId) throw new RuntimeError('CAPABILITY_DENIED', 'Mission action capability does not match the governed operation');
    if (action.state !== 'PLANNED' && action.state !== 'OWNER_APPROVAL_REQUIRED') {
      throw new RuntimeError('CAPABILITY_DENIED', 'Mission action is not eligible for execution');
    }
  }

  public markMissionActionStarted(association: MissionExecutionAssociation): Promise<void> {
    return this.updateMissionAction(association, (mission, task, action, now) => ({
      mission: {
        ...mission,
        updatedAt: now,
        timeline: appendMissionEvent(mission.timeline, missionEvent('ACTION_STARTED', `Governed action started: ${action.capabilityId}`, task.id, action.id, now)),
      },
      action: { ...action, state: 'RUNNING', updatedAt: now },
    }));
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

  public markMissionActionSucceeded(association: MissionExecutionAssociation, capabilityId: CapabilityId, value: unknown): Promise<void> {
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
          evidence: missionEvidence(capabilityId, value),
        },
      },
    }));
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
    this.touchClient(clientId);
    return session;
  }

  public deleteSession(sessionId: string, clientIdInput: string): void {
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
    this.sessions.set(sessionId, working);
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
      return completed;
    } catch (error) {
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
  return {
    missionId: normalizeUuidIdentity(value.missionId, 'missionId'),
    taskId: normalizeUuidIdentity(value.taskId, 'taskId'),
    actionId: normalizeUuidIdentity(value.actionId, 'actionId'),
  };
}

function assertMissionControlIdentity(mission: MissionSnapshot, clientId: string, sessionId: string): void {
  if (mission.clientId !== clientId || mission.sessionId !== sessionId) {
    throw new RuntimeError('CONTROL_DENIED', 'Mission does not belong to this client/session identity');
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

function missionEvidence(capabilityId: CapabilityId, value: unknown): readonly MissionEvidence[] {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const data: Record<string, string | number | boolean | null> = {};
  let reference: string | null = null;
  if (typeof record.targetPath === 'string') reference = record.targetPath.slice(0, 2_048);
  for (const key of ['bytes', 'created', 'deleted'] as const) {
    const item = record[key];
    if (typeof item === 'number' && Number.isFinite(item)) data[key] = item;
    if (typeof item === 'boolean') data[key] = item;
  }
  if (capabilityId === 'file.read' && typeof record.content === 'string') data.bytes = Buffer.byteLength(record.content, 'utf8');
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
