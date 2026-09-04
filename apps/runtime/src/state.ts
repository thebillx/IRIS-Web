import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type ProjectReference, type RuntimeClientState, type RuntimeSession } from '@iris/domain';
import { FoundationStateStore } from './persistence.js';

export class RuntimeState {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly clients = new Map<string, RuntimeClientState>();

  public constructor(private readonly store: FoundationStateStore) {}

  public listSessions(): readonly RuntimeSession[] {
    return [...this.sessions.values()];
  }

  public listClients(): readonly RuntimeClientState[] {
    return [...this.clients.values()];
  }

  public createSession(clientIdInput?: string): RuntimeSession {
    const clientId = normalizeClientId(clientIdInput ?? randomUUID());
    const now = new Date().toISOString();
    const session: RuntimeSession = {
      id: randomUUID(),
      clientId,
      createdAt: now,
      currentProjectId: null,
    };
    this.sessions.set(session.id, session);
    this.clients.set(clientId, { clientId, connected: true, lastSeenAt: now });
    return session;
  }

  public getSession(id: string): RuntimeSession {
    const session = this.sessions.get(id);
    if (session === undefined) throw new RuntimeError('SESSION_NOT_FOUND', `Session not found: ${id}`);
    return session;
  }

  public getSessionForClient(id: string, clientIdInput: string): RuntimeSession {
    const clientId = normalizeClientId(clientIdInput);
    const session = this.getSession(id);
    if (session.clientId !== clientId) throw new RuntimeError('CONTROL_DENIED', 'Session does not belong to this client');
    this.touchClient(clientId);
    return session;
  }

  public deleteSession(id: string, clientIdInput: string): void {
    const session = this.getSessionForClient(id, clientIdInput);
    this.sessions.delete(id);
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
    const name = nameInput.trim();
    if (name.length === 0 || name.length > 120 || rootPathInput.includes('\0') || !path.isAbsolute(rootPathInput)) {
      throw new RuntimeError('INVALID_PROJECT_PATH', 'Project name and root path are invalid');
    }

    let canonical: string;
    try {
      canonical = await realpath(rootPathInput);
      if (!(await stat(canonical)).isDirectory()) throw new Error('not directory');
      if (canonical === path.parse(canonical).root) throw new Error('filesystem root');
    } catch (error) {
      throw new RuntimeError('INVALID_PROJECT_PATH', 'Project root must be an existing non-root directory', { cause: error });
    }

    return this.store.transact((state) => {
      const existing = state.projects.find((project) => project.rootPath === canonical);
      if (existing !== undefined) return { state, result: existing };
      const project: ProjectReference = { id: randomUUID(), name, rootPath: canonical };
      return {
        state: { ...state, projects: [...state.projects, project] },
        result: project,
      };
    });
  }

  public async getDefaultProjectId(): Promise<string | null> {
    return (await this.store.read()).defaultProjectId;
  }

  public async setDefaultProject(projectId: string | null): Promise<void> {
    await this.store.transact((state) => {
      if (projectId !== null && !state.projects.some((project) => project.id === projectId)) {
        throw new RuntimeError('PROJECT_NOT_FOUND', 'Default project does not exist');
      }
      return { state: { ...state, defaultProjectId: projectId }, result: undefined };
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

  private touchClient(clientId: string): void {
    this.clients.set(clientId, { clientId, connected: true, lastSeenAt: new Date().toISOString() });
  }
}

function normalizeClientId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200 || normalized.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', 'clientId is invalid');
  }
  return normalized;
}
