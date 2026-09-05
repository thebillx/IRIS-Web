import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type AgentRole, type ProjectReference, type RuntimeClientState, type RuntimeSession } from '@iris/domain';
import { FoundationStateStore } from './persistence.js';
import { inspectRegistrationRoot } from './project-path.js';

export class RuntimeState {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly clients = new Map<string, RuntimeClientState>();
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly store: FoundationStateStore) {}

  public listSessions(): readonly RuntimeSession[] {
    return [...this.sessions.values()];
  }

  public listSessionsForClient(clientIdInput: string): readonly RuntimeSession[] {
    const clientId = normalizeClientId(clientIdInput);
    return [...this.sessions.values()].filter((session) => session.clientId === clientId);
  }

  public listClients(): readonly RuntimeClientState[] {
    return [...this.clients.values()];
  }

  public createSession(clientIdInput?: string, agentIdInput?: string, agentRoleInput: AgentRole = 'other'): RuntimeSession {
    const clientId = normalizeClientId(clientIdInput ?? randomUUID());
    const agentId = normalizeAgentId(agentIdInput ?? randomUUID());
    const agentRole = normalizeAgentRole(agentRoleInput);
    const now = new Date().toISOString();
    const session: RuntimeSession = {
      id: randomUUID(),
      clientId,
      agentId,
      agentRole,
      createdAt: now,
      currentProjectId: null,
    };
    this.sessions.set(session.id, session);
    this.clients.set(clientId, { clientId, connected: true, lastSeenAt: now });
    return session;
  }

  public getSessionForClient(sessionId: string, clientIdInput: string): RuntimeSession {
    const clientId = normalizeClientId(clientIdInput);
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new RuntimeError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    if (session.clientId !== clientId) throw new RuntimeError('CONTROL_DENIED', 'Session does not belong to this client');
    this.touchClient(clientId);
    return session;
  }

  public deleteSession(sessionId: string, clientIdInput: string): void {
    const session = this.getSessionForClient(sessionId, clientIdInput);
    this.sessions.delete(sessionId);
    if (![...this.sessions.values()].some((candidate) => candidate.clientId === session.clientId)) {
      this.clients.set(session.clientId, {
        clientId: session.clientId,
        connected: false,
        lastSeenAt: new Date().toISOString(),
      });
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
  ): Promise<RuntimeSession> {
    const session = this.getSessionForClient(sessionId, clientIdInput);
    if (projectId !== null && !(await this.listProjects()).some((project) => project.id === projectId)) {
      throw new RuntimeError('PROJECT_NOT_FOUND', 'Current project does not exist');
    }
    const updated: RuntimeSession = { ...session, currentProjectId: projectId };
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
