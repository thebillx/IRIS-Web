import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  RuntimeError,
  type AgentRole,
  type ProjectReference,
  type RuntimeClientState,
  type RuntimeSessionSnapshot,
  type SessionInteractionEvent,
} from '@iris/domain';
import { LocalDevelopmentAgentExecutor, type AgentExecutor } from './agent-executor.js';
import { FoundationStateStore } from './persistence.js';
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

  public constructor(
    private readonly store: FoundationStateStore,
    private readonly executor: AgentExecutor = new LocalDevelopmentAgentExecutor(),
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
