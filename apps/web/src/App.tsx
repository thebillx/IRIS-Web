import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

type Health = {
  status: string;
  runtimeId: string;
  instanceId: string;
  pid: number;
  uptimeMs: number;
  authority: string;
  connectedClients: number;
  connectedSessions: number;
  agentExecutorType: 'local-development-executor' | 'production-provider-executor' | 'other';
  productionModelConnected: boolean;
  apiUrl: string;
  mcpUrl: string;
};

type Project = { id: string; name: string; rootPath: string };
type SessionExecutionState = 'READY' | 'WORKING' | 'FAILED';
type SessionInteraction = {
  id: string;
  timestamp: string;
  kind: 'user' | 'assistant' | 'error';
  text: string;
  submissionId: string;
  executionId: string;
};
export type Session = {
  id: string;
  clientId: string;
  agentId: string;
  agentRole: string;
  createdAt: string;
  currentProjectId: string | null;
  executionState: SessionExecutionState;
  interactions: SessionInteraction[];
};
type MissionActionResult = {
  status: 'SUCCEEDED' | 'OWNER_REQUIRED' | 'DENIED' | 'FAILED';
  summary: string;
  approvalId: string | null;
  completedAt: string | null;
  evidence: Array<{ id: string; kind: string; label: string; summary: string; reference: string | null; data: Record<string, string | number | boolean | null> }>;
};
type MissionAction = { id: string; capabilityId: string; summary: string; state: string; createdAt: string; updatedAt: string; approvalId: string | null; result: MissionActionResult | null };
type MissionTask = { id: string; title: string; state: string; createdAt: string; updatedAt: string; actions: MissionAction[] };
type Mission = {
  id: string;
  title: string;
  state: string;
  clientId: string;
  sessionId: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  supervisorGate: { state: string; reason: string | null; updatedAt: string };
  tasks: MissionTask[];
  timeline: Array<{ id: string; timestamp: string; kind: string; taskId: string | null; actionId: string | null; message: string }>;
};
type PermissionMode = 'ASK_EVERY_TIME' | 'AUTO_APPROVE_LOW_RISK' | 'AUTO_APPROVE_PROJECT_SCOPED' | 'FULL_LOCAL_OWNER';
type RiskClass = 'LOW' | 'MODERATE' | 'HIGH' | 'SYSTEM';
type PolicyDecision = 'ALLOW_AUTO' | 'ALLOW_ONCE' | 'DENY' | 'OWNER_REQUIRED';
type Capability = { id: string; title: string; riskClass: RiskClass; requiredScope: string; mutation: boolean; implemented: boolean };
type AuditEvent = {
  id: string;
  timestamp: string;
  clientId: string | null;
  sessionId: string | null;
  agentId: string | null;
  capabilityId: string;
  riskClass: RiskClass;
  projectId: string | null;
  target: string | null;
  decision: PolicyDecision;
  reason: string;
  result: string;
};
export type PendingApproval = Omit<AuditEvent, 'result'> & {
  exactAction: string;
  canAlwaysAllowProject: boolean;
};
type PermissionSnapshot = {
  mode: PermissionMode;
  approvedRoots: string[];
  autoApprovedCategories: string[];
  ownerRequiredCategories: string[];
  capabilities: Capability[];
  recentDecisions: AuditEvent[];
  pendingApprovals: PendingApproval[];
};
type View = 'runtime' | 'permissions' | 'approvals';
type ApprovalChoice = 'ALLOW_ONCE' | 'ALWAYS_ALLOW_PROJECT' | 'DENY';

const WEB_CLIENT_ID_KEY = 'iris.web.clientId';
const WEB_OWNER_TOKEN_KEY = 'iris.web.ownerToken';
const WEB_SELECTED_SESSION_KEY = 'iris.web.selectedSessionId';

export function App(): ReactElement {
  const [clientId] = useState(webClientId);
  const [ownerAccessToken] = useState(readOwnerAccessToken);
  const [view, setView] = useState<View>('runtime');
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [defaultProjectId, setDefaultProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState(readSelectedSessionId);
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [selectedApproval, setSelectedApproval] = useState<PendingApproval | null>(null);
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [instruction, setInstruction] = useState('');
  const [submittingSessionIds, setSubmittingSessionIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      const healthResponse = await fetch('/health');
      if (!healthResponse.ok) throw new Error('Runtime unavailable');
      setHealth(await healthResponse.json() as Health);
      if (ownerAccessToken.length === 0) {
        setProjects([]);
        setDefaultProjectId(null);
        setSessions([]);
        setMissions([]);
        setPermissions(null);
        setError('Owner access is locked. Open the IRIS_OWNER_URL printed by pnpm dev.');
        return;
      }
      const [projectsResponse, sessionsResponse, missionsResponse, permissionsResponse] = await Promise.all([
        authorizedFetch(ownerAccessToken, '/projects'),
        authorizedFetch(ownerAccessToken, '/sessions', { headers: { 'x-iris-client-id': clientId } }),
        authorizedFetch(ownerAccessToken, '/missions'),
        authorizedFetch(ownerAccessToken, '/permissions'),
      ]);
      if (!projectsResponse.ok || !sessionsResponse.ok || !missionsResponse.ok || !permissionsResponse.ok) {
        throw new Error('Owner access was rejected by the runtime');
      }
      const projectBody = await projectsResponse.json() as { projects: Project[]; defaultProjectId: string | null };
      const sessionBody = await sessionsResponse.json() as { sessions: Session[] };
      const missionBody = await missionsResponse.json() as { missions: Mission[] };
      const nextSelectedSessionId = reconcileSelectedSessionId(readSelectedSessionId(), sessionBody.sessions);
      setProjects(projectBody.projects);
      setDefaultProjectId(projectBody.defaultProjectId);
      setSessions(sessionBody.sessions);
      setMissions(missionBody.missions);
      setSelectedSessionId(nextSelectedSessionId);
      persistSelectedSessionId(nextSelectedSessionId);
      setPermissions(await permissionsResponse.json() as PermissionSnapshot);
      setError('');
    } catch (cause) {
      setHealth(null);
      setError(cause instanceof Error ? cause.message : 'Runtime unavailable');
    }
  }, [clientId, ownerAccessToken]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const selectedSession = sessions.find((candidate) => candidate.id === selectedSessionId) ?? null;
  const visibleApprovals = (permissions?.pendingApprovals ?? []).filter((approval) =>
    approvalBelongsToSessionContext(approval, clientId, selectedSessionId),
  );

  useEffect(() => {
    if (selectedApproval !== null && !approvalBelongsToSessionContext(selectedApproval, clientId, selectedSessionId)) {
      setSelectedApproval(null);
    }
  }, [clientId, selectedApproval, selectedSessionId]);

  useEffect(() => {
    setInstruction('');
  }, [selectedSessionId]);

  const createSession = async () => {
    const response = await authorizedFetch(ownerAccessToken, '/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, agentId: 'owner-web', agentRole: 'owner' }),
    });
    if (response.status === 409) {
      setNotice('Session creation requires an owner decision. It was queued without creating a session.');
      setView('approvals');
      await refresh();
      return;
    }
    if (!response.ok) throw new Error(await responseMessage(response, 'Could not create session'));
    const created = await response.json() as Session;
    persistSelectedSessionId(created.id);
    setSelectedSessionId(created.id);
    setNotice('New session created and selected.');
    await refresh();
  };

  const registerProject = async () => {
    const response = await authorizedFetch(ownerAccessToken, '/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, rootPath }),
    });
    if (response.status === 409) {
      setNotice('Project registration requires an owner decision. It was queued without changing runtime authority.');
      setView('approvals');
      await refresh();
      return;
    }
    if (!response.ok) throw new Error(await responseMessage(response, 'Could not register project'));
    setName('');
    setRootPath('');
    setNotice('Project registered.');
    await refresh();
  };

  const selectProject = async (projectId: string) => {
    if (selectedSession === null) return;
    const response = await authorizedFetch(ownerAccessToken, `/sessions/${encodeURIComponent(selectedSession.id)}/current-project`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-iris-client-id': selectedSession.clientId },
      body: JSON.stringify({ projectId: projectId || null }),
    });
    if (response.status === 409) {
      setNotice('Changing the session project requires an owner decision. The existing session was left unchanged.');
      setView('approvals');
      await refresh();
      return;
    }
    if (!response.ok) throw new Error(await responseMessage(response, 'Could not update current project'));
    const updated = await response.json() as Session;
    setSessions((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
    await refresh();
  };

  const submitInstruction = async () => {
    const targetSession = selectedSession;
    const text = instruction.trim();
    if (targetSession === null) throw new Error('Select or create a session before sending an instruction.');
    if (health === null) throw new Error('Runtime is unavailable. The instruction was not sent.');
    if (text.length === 0) return;
    if (targetSession.executionState === 'WORKING' || submittingSessionIds.has(targetSession.id)) return;

    const submissionId = crypto.randomUUID();
    setSubmittingSessionIds((current) => new Set(current).add(targetSession.id));
    setInstruction('');
    try {
      const response = await authorizedFetch(ownerAccessToken, `/sessions/${encodeURIComponent(targetSession.id)}/instructions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-iris-client-id': targetSession.clientId },
        body: JSON.stringify({ submissionId, instruction: text }),
      });
      if (!response.ok) {
        const failure = await responseErrorDetails(response, 'Could not execute instruction');
        if (failure.code === 'OWNER_DECISION_REQUIRED') {
          setNotice('This instruction requires an owner decision before execution.');
          setView('approvals');
          await refresh();
          return;
        }
        if (failure.code === 'SESSION_BUSY' || failure.code === 'AGENT_EXECUTION_FAILED') {
          await refresh();
          return;
        }
        throw new Error(failure.message);
      }
      const updated = await response.json() as Session;
      setSessions((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      await refresh();
    } finally {
      setSubmittingSessionIds((current) => {
        const next = new Set(current);
        next.delete(targetSession.id);
        return next;
      });
    }
  };

  const requestMode = async (mode: PermissionMode) => {
    const response = await authorizedFetch(ownerAccessToken, '/permissions/mode', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(selectedSession === null ? {} : { 'x-iris-client-id': selectedSession.clientId, 'x-iris-session-id': selectedSession.id }),
      },
      body: JSON.stringify({ mode }),
    });
    if (response.status === 409) {
      setNotice('Permission-mode changes are owner decisions and were queued without changing policy.');
      setView('approvals');
      await refresh();
      return;
    }
    if (!response.ok) throw new Error(await responseMessage(response, 'Could not request permission mode'));
    await refresh();
  };

  const resolveApproval = async (approval: PendingApproval, decision: ApprovalChoice) => {
    if (!approvalBelongsToSessionContext(approval, clientId, selectedSessionId)) {
      throw new Error('Switch to the session that owns this approval before resolving it.');
    }
    const response = await authorizedFetch(ownerAccessToken, `/approvals/${encodeURIComponent(approval.id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }),
    });
    const denialApplied = decision === 'DENY' && await isAppliedOwnerDenial(response);
    if (!response.ok && !denialApplied) throw new Error(await responseMessage(response, 'Could not resolve approval'));
    if (!denialApplied && response.ok && approval.clientId === clientId && approval.capabilityId === 'session.create') {
      const created = await response.json() as Session;
      persistSelectedSessionId(created.id);
      setSelectedSessionId(created.id);
    } else if (!denialApplied && response.ok && approval.clientId === clientId && approval.capabilityId === 'session.current_project.set') {
      const updated = await response.json() as Session;
      setSessions((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
    }
    setSelectedApproval(null);
    setNotice(decision === 'DENY' ? 'Action denied. Nothing was executed.' : 'Owner decision applied to the exact pending action.');
    await refresh();
  };

  const selectSession = (sessionId: string) => {
    if (!sessions.some((candidate) => candidate.id === sessionId)) return;
    setSelectedApproval(null);
    persistSelectedSessionId(sessionId);
    setSelectedSessionId(sessionId);
    setNotice('Session resumed.');
  };

  const run = (operation: () => Promise<void>) => {
    setError('');
    void operation().catch((cause) => setError(cause instanceof Error ? cause.message : 'Operation failed'));
  };

  const activeProject = selectedSession?.currentProjectId === null || selectedSession === null
    ? null
    : projects.find((project) => project.id === selectedSession.currentProjectId) ?? null;
  const defaultProject = defaultProjectId === null ? null : projects.find((project) => project.id === defaultProjectId) ?? null;
  const currentSessionActivity = selectedSession === null
    ? []
    : (permissions?.recentDecisions ?? []).filter((event) => event.sessionId === selectedSession.id).slice(0, 5);
  const productStatus = health === null
    ? 'Disconnected'
    : visibleApprovals.length > 0
      ? 'Approval required'
      : selectedSession?.executionState === 'WORKING'
        ? 'Working'
        : selectedSession?.executionState === 'FAILED'
          ? 'Error'
          : health.status === 'ready' ? 'Ready' : 'Working';

  return <div className="app-frame">
    <header className="web-header">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">I</span>
        <div><strong>IRIS</strong><small>Local Workspace</small></div>
      </div>
      <nav aria-label="IRIS sections">
        <button className={view === 'runtime' ? 'is-active' : ''} onClick={() => setView('runtime')}>Workspace</button>
        <button className={view === 'permissions' ? 'is-active' : ''} onClick={() => setView('permissions')}>Settings · Permissions</button>
        <button className={view === 'approvals' ? 'is-active' : ''} onClick={() => setView('approvals')}>
          Approval Center{visibleApprovals.length > 0 ? ` (${visibleApprovals.length})` : ''}
        </button>
      </nav>
      <span className={`header-status ${health ? 'is-online' : ''}`}>{productStatus}</span>
    </header>

    <main>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {view === 'runtime' && <RuntimePage
        health={health}
        projects={projects}
        defaultProject={defaultProject}
        activeProject={activeProject}
        sessions={sessions}
        missions={missions}
        selectedSession={selectedSession}
        sessionActivity={currentSessionActivity}
        pendingApprovalCount={visibleApprovals.length}
        instruction={instruction}
        isSubmitting={selectedSession !== null && submittingSessionIds.has(selectedSession.id)}
        name={name}
        rootPath={rootPath}
        setName={setName}
        setRootPath={setRootPath}
        setInstruction={setInstruction}
        onCreateSession={() => run(createSession)}
        onSubmitInstruction={() => run(submitInstruction)}
        onSelectSession={selectSession}
        onRegisterProject={() => run(registerProject)}
        onSelectProject={(projectId) => run(() => selectProject(projectId))}
      />}
      {view === 'permissions' && <PermissionsPage permissions={permissions} onRequestMode={(mode) => run(() => requestMode(mode))} />}
      {view === 'approvals' && <ApprovalCenter approvals={visibleApprovals} selectedSession={selectedSession} onReview={setSelectedApproval} />}
    </main>

    <ApprovalReview
      approval={selectedApproval}
      onCancel={() => setSelectedApproval(null)}
      onDecision={(approval, choice) => run(() => resolveApproval(approval, choice))}
    />
  </div>;
}

export function RuntimePage(props: {
  health: Health | null;
  projects: Project[];
  defaultProject: Project | null;
  activeProject: Project | null;
  sessions: Session[];
  missions: Mission[];
  selectedSession: Session | null;
  sessionActivity: AuditEvent[];
  pendingApprovalCount: number;
  instruction: string;
  isSubmitting: boolean;
  name: string;
  rootPath: string;
  setName(value: string): void;
  setRootPath(value: string): void;
  setInstruction(value: string): void;
  onCreateSession(): void;
  onSubmitInstruction(): void;
  onSelectSession(sessionId: string): void;
  onRegisterProject(): void;
  onSelectProject(projectId: string): void;
}): ReactElement {
  const sessionState = props.health === null
    ? 'Disconnected'
    : props.pendingApprovalCount > 0
      ? 'Approval required'
      : props.selectedSession?.executionState === 'WORKING'
        ? 'Working'
        : props.selectedSession?.executionState === 'FAILED' ? 'Failed' : 'Ready';

  return <>
    <div className="page-heading"><div><p className="eyebrow">Daily workspace</p><h1>IRIS</h1><p>One local daemon, your projects, and resumable browser sessions.</p></div></div>
    <div className="workspace-grid">
      <aside className="workspace-rail">
        <section className="active-project-card" aria-labelledby="active-project-heading">
          <p className="section-label">Active Project</p>
          <h2 id="active-project-heading">{props.activeProject?.name ?? 'No active project'}</h2>
          {props.activeProject === null
            ? <p>{props.selectedSession === null ? 'Create or resume a session to choose a project.' : 'This session is not attached to a project yet.'}</p>
            : <><code className="project-path">{props.activeProject.rootPath}</code><span className="project-status">Available locally</span></>}
          {props.defaultProject !== null && props.defaultProject.id !== props.activeProject?.id
            ? <p className="muted">Machine default: <strong>{props.defaultProject.name}</strong></p>
            : null}
        </section>

        <section className="sessions-card" aria-labelledby="sessions-heading">
          <div className="section-title-row"><div><p className="section-label">Sessions</p><h2 id="sessions-heading">Your sessions</h2></div><button onClick={props.onCreateSession}>+ New</button></div>
          {props.sessions.length === 0
            ? <div className="empty-state"><p>No sessions yet.</p><span>Start one to work with a project. Sessions live in the local daemon and resume across browser refreshes while that daemon is running.</span></div>
            : <div className="session-list">{props.sessions.map((session, index) => {
              const selected = session.id === props.selectedSession?.id;
              const project = session.currentProjectId === null ? null : props.projects.find((candidate) => candidate.id === session.currentProjectId) ?? null;
              return <button key={session.id} className={`session-row ${selected ? 'is-selected' : ''}`} onClick={() => props.onSelectSession(session.id)} aria-pressed={selected}>
                <span><strong>Session {index + 1}</strong><small>{session.agentRole} · {project?.name ?? 'No project'}</small></span>
                <span className="session-action">{selected ? 'Current' : 'Resume'}</span>
              </button>;
            })}</div>}
        </section>
      </aside>

      <div className="workspace-main">
        <section className="current-session-card" aria-labelledby="current-session-heading">
          <div className="section-title-row"><div><p className="section-label">Current Session</p><h2 id="current-session-heading">{props.selectedSession === null ? 'Nothing selected' : 'Session workspace'}</h2></div><span className={`session-state ${sessionState === 'Ready' ? 'is-ready' : ''}`}>{sessionState}</span></div>
          {props.selectedSession === null
            ? <div className="empty-state prominent"><p>Create a session or resume one from the list.</p><button onClick={props.onCreateSession}>Create session</button></div>
            : <>
              <div className="session-summary"><div><span>Role</span><strong>{props.selectedSession.agentRole}</strong></div><div><span>Agent</span><strong>{humanAgentName(props.selectedSession.agentId)}</strong></div><div><span>Started</span><strong><time dateTime={props.selectedSession.createdAt}>{formatSessionTime(props.selectedSession.createdAt)}</time></strong></div></div>
              <label>Active project<select value={props.selectedSession.currentProjectId ?? ''} onChange={(event) => props.onSelectProject(event.target.value)}><option value="">No active project</option>{props.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
              {props.health?.agentExecutorType === 'local-development-executor' && !props.health.productionModelConnected
                ? <p className="executor-note">Development executor active · no production model connected.</p>
                : null}
              <div className="conversation" aria-live="polite">
                <h3>Conversation</h3>
                {props.selectedSession.interactions.length === 0
                  ? <div className="empty-state"><p>No instructions yet.</p><span>Send one instruction to begin this session.</span></div>
                  : <ol className="conversation-list">{props.selectedSession.interactions.map((interaction) => <li key={interaction.id} className={`conversation-message is-${interaction.kind}`}>
                    <div><strong>{interactionLabel(interaction.kind)}</strong><time dateTime={interaction.timestamp}>{formatSessionTime(interaction.timestamp)}</time></div>
                    <p>{interaction.text}</p>
                  </li>)}</ol>}
                {props.pendingApprovalCount > 0 ? <p className="conversation-approval">Approval required for this session. Review the exact action in Approval Center.</p> : null}
              </div>
              <form className="instruction-composer" onSubmit={(event) => { event.preventDefault(); props.onSubmitInstruction(); }}>
                <label htmlFor="session-instruction">Instruction</label>
                <textarea
                  id="session-instruction"
                  aria-label="Session instruction"
                  value={props.instruction}
                  maxLength={8000}
                  rows={3}
                  placeholder={props.health === null ? 'Runtime unavailable' : 'Tell IRIS what to do…'}
                  disabled={props.health === null || props.selectedSession.executionState === 'WORKING' || props.isSubmitting}
                  onChange={(event) => props.setInstruction(event.target.value)}
                />
                <div className="composer-actions"><span>{props.selectedSession.executionState === 'WORKING' ? 'Runtime is working on this session.' : 'Enter sends only when you choose Send.'}</span><button type="submit" disabled={props.health === null || props.selectedSession.executionState === 'WORKING' || props.isSubmitting || props.instruction.trim().length === 0}>{props.isSubmitting ? 'Sending…' : 'Send'}</button></div>
              </form>
              <details className="session-runtime-activity"><summary>Runtime activity</summary>{props.sessionActivity.length === 0 ? <p>No recorded runtime activity in this session yet.</p> : <ul>{props.sessionActivity.map((event) => <li key={event.id}><strong>{humanCapability(event.capabilityId)}</strong><span>{event.result.toLowerCase()}</span></li>)}</ul>}</details>
            </>}
        </section>

        <MissionControl missions={props.missions} projects={props.projects} />

        <section className="projects-card"><div className="section-title-row"><div><p className="section-label">Projects</p><h2>Registered locally</h2></div></div>
          {props.projects.length === 0 ? <div className="empty-state"><p>No registered projects.</p><span>Register an existing local folder. IRIS never scans your filesystem implicitly.</span></div> : <ul className="project-list">{props.projects.map((project) => <li key={project.id}><div><strong>{project.name}</strong><code>{project.rootPath}</code></div>{project.id === props.defaultProject?.id ? <span>Default</span> : null}</li>)}</ul>}
          <div className="project-register"><label>Name<input value={props.name} onChange={(event) => props.setName(event.target.value)} /></label><label>Absolute path<input value={props.rootPath} onChange={(event) => props.setRootPath(event.target.value)} /></label><button onClick={props.onRegisterProject}>Register project</button></div>
        </section>

        {props.health && <details className="runtime-details"><summary>Runtime details</summary><dl>
          <dt>Status</dt><dd>{props.health.status}</dd><dt>Uptime</dt><dd>{Math.floor(props.health.uptimeMs / 1000)}s</dd><dt>Authority</dt><dd>{props.health.authority}</dd>
          <dt>Executor</dt><dd>{props.health.agentExecutorType}</dd><dt>Production model</dt><dd>{props.health.productionModelConnected ? 'connected' : 'not connected'}</dd>
          <dt>API</dt><dd>{props.health.apiUrl}</dd><dt>MCP</dt><dd>{props.health.mcpUrl}</dd><dt>Daemon sessions</dt><dd>{props.health.connectedSessions}</dd>
        </dl></details>}
      </div>
    </div>
  </>;
}

function MissionControl(props: { missions: Mission[]; projects: Project[] }): ReactElement {
  return <section className="mission-control" aria-labelledby="mission-control-heading">
    <div className="section-title-row"><div><p className="section-label">Mission Control</p><h2 id="mission-control-heading">Hermes execution ledger</h2></div><span className="mission-count">{props.missions.length} mission{props.missions.length === 1 ? '' : 's'}</span></div>
    <p className="mission-help">Hermes owns orchestration. IRIS records governed action state, evidence, approvals, and supervisor-gate representation. Supervisor transport is not connected here.</p>
    {props.missions.length === 0
      ? <div className="empty-state"><p>No missions recorded yet.</p><span>Mission records appear when an orchestrator registers work through the governed IRIS mission tools.</span></div>
      : <div className="mission-list">{props.missions.map((mission) => {
        const project = mission.projectId === null ? null : props.projects.find((candidate) => candidate.id === mission.projectId) ?? null;
        const actionCount = mission.tasks.reduce((total, task) => total + task.actions.length, 0);
        return <details key={mission.id} className="mission-item">
          <summary><span><strong>{mission.title}</strong><small>{project?.name ?? 'No project'} · {mission.tasks.length} tasks · {actionCount} actions</small></span><span className="mission-state">{mission.state}</span></summary>
          <div className="mission-meta"><div><span>Supervisor gate</span><strong>{mission.supervisorGate.state}</strong></div><div><span>Updated</span><strong>{formatSessionTime(mission.updatedAt)}</strong></div></div>
          {mission.supervisorGate.reason !== null ? <p className="mission-gate-reason">{mission.supervisorGate.reason}</p> : null}
          <div className="mission-tasks">{mission.tasks.map((task) => <article key={task.id}>
            <header><strong>{task.title}</strong><span>{task.state}</span></header>
            {task.actions.length === 0 ? <p>No governed actions prepared.</p> : <ul>{task.actions.map((action) => <li key={action.id}>
              <div><strong>{humanCapability(action.capabilityId)}</strong><span>{action.summary}</span></div>
              <div className="mission-action-status"><span>{action.state}</span>{action.approvalId !== null ? <small>Approval associated</small> : null}</div>
              {action.result !== null ? <p>{action.result.summary}{action.result.evidence.length > 0 ? ` · ${action.result.evidence.length} evidence item${action.result.evidence.length === 1 ? '' : 's'}` : ''}</p> : null}
            </li>)}</ul>}
          </article>)}</div>
          <details className="mission-timeline"><summary>Recent timeline</summary><ol>{mission.timeline.slice(-8).reverse().map((event) => <li key={event.id}><time dateTime={event.timestamp}>{formatSessionTime(event.timestamp)}</time><span>{event.message}</span></li>)}</ol></details>
        </details>;
      })}</div>}
  </section>;
}

function PermissionsPage(props: { permissions: PermissionSnapshot | null; onRequestMode(mode: PermissionMode): void }): ReactElement {
  if (props.permissions === null) return <section><h1>Permissions</h1><p>Runtime permission state is unavailable.</p></section>;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Settings</p><h1>Permissions</h1><p>Daemon policy is authoritative. UI state never grants execution authority.</p></div></div>
    <section className="permission-hero"><h2>Current mode</h2><strong className="mode-chip">{props.permissions.mode}</strong><p>During development through V1.3, project-scoped LOW and MODERATE operations are automatically allowed only after live scope validation.</p></section>
    <div className="permission-grid">
      <section><h2>Approved roots</h2><ul className="path-list">{props.permissions.approvedRoots.map((root) => <li key={root}><code>{root}</code></li>)}</ul></section>
      <section><h2>Auto-approved action categories</h2><ul>{props.permissions.autoApprovedCategories.map((item) => <li key={item}>{item}</li>)}</ul></section>
      <section><h2>Owner-required categories</h2><ul>{props.permissions.ownerRequiredCategories.map((item) => <li key={item}>{item}</li>)}</ul></section>
      <section><h2>Change mode</h2><p>Changing machine permission policy is itself a HIGH-risk owner decision.</p><select aria-label="Requested permission mode" defaultValue={props.permissions.mode} onChange={(event) => props.onRequestMode(event.target.value as PermissionMode)}>
        <option value="FULL_LOCAL_OWNER">FULL_LOCAL_OWNER</option><option value="AUTO_APPROVE_PROJECT_SCOPED">AUTO_APPROVE_PROJECT_SCOPED</option><option value="AUTO_APPROVE_LOW_RISK">AUTO_APPROVE_LOW_RISK</option><option value="ASK_EVERY_TIME">ASK_EVERY_TIME</option>
      </select></section>
    </div>
    <section><h2>Recent decisions</h2><AuditTable events={props.permissions.recentDecisions} /></section>
  </>;
}

function ApprovalCenter(props: { approvals: PendingApproval[]; selectedSession: Session | null; onReview(approval: PendingApproval): void }): ReactElement {
  return <>
    <div className="page-heading"><div><p className="eyebrow">Owner decisions</p><h1>Approval Center</h1><p>{props.selectedSession === null ? 'Showing machine or browser-client decisions that are not tied to another session.' : 'Showing decisions for the current session plus machine-level decisions for this browser client.'}</p></div></div>
    <section>{props.approvals.length === 0 ? <p>No pending owner decisions in this session context.</p> : <div className="approval-list">{props.approvals.map((approval) => <article key={approval.id} className="approval-row">
      <div><strong>{humanCapability(approval.capabilityId)}</strong><span className={`risk risk-${approval.riskClass.toLowerCase()}`}>{approval.riskClass}</span><p>{approval.reason}</p><code>{approval.target ?? 'No filesystem target'}</code></div>
      <button onClick={() => props.onReview(approval)}>Review exact action</button>
    </article>)}</div>}</section>
  </>;
}

export function ApprovalReview(props: {
  approval: PendingApproval | null;
  onCancel(): void;
  onDecision(approval: PendingApproval, choice: ApprovalChoice): void;
}): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (props.approval !== null && !dialog.open) dialog.showModal();
    if (props.approval === null && dialog.open) dialog.close();
  }, [props.approval]);

  const approval = props.approval;
  return <dialog
    ref={ref}
    className="approval-dialog"
    aria-labelledby="approval-title"
    onCancel={(event) => { event.preventDefault(); props.onCancel(); }}
    onClose={props.onCancel}
  >
    {approval === null ? null : <div className="approval-surface">
      <header className="approval-header"><div><p className="eyebrow">Exact owner decision</p><h2 id="approval-title">{approval.capabilityId}</h2></div><span className={`risk risk-${approval.riskClass.toLowerCase()}`}>{approval.riskClass}</span></header>
      <div className="approval-body" data-testid="approval-scroll-body">
        <dl><dt>Decision</dt><dd>{approval.decision}</dd><dt>Client</dt><dd>{approval.clientId ?? '—'}</dd><dt>Session</dt><dd>{approval.sessionId ?? '—'}</dd><dt>Agent</dt><dd>{approval.agentId ?? '—'}</dd><dt>Project</dt><dd>{approval.projectId ?? '—'}</dd><dt>Target</dt><dd><code>{approval.target ?? '—'}</code></dd><dt>Reason</dt><dd>{approval.reason}</dd></dl>
        <h3>Exact action</h3><pre className="exact-action" data-testid="exact-action">{approval.exactAction}</pre>
      </div>
      <footer className="approval-footer">
        <button autoFocus onClick={props.onCancel}>Cancel</button>
        <button className="danger-button" onClick={() => props.onDecision(approval, 'DENY')}>Deny</button>
        {approval.canAlwaysAllowProject && <button onClick={() => props.onDecision(approval, 'ALWAYS_ALLOW_PROJECT')}>Always allow matching project policy</button>}
        <button className="primary-button" onClick={() => props.onDecision(approval, 'ALLOW_ONCE')}>Allow once</button>
      </footer>
    </div>}
  </dialog>;
}

function AuditTable(props: { events: AuditEvent[] }): ReactElement {
  if (props.events.length === 0) return <p>No permission decisions recorded yet.</p>;
  return <div className="audit-list">{props.events.map((event) => <article key={event.id}><div><strong>{event.capabilityId}</strong><span>{event.decision} · {event.result}</span></div><code>{event.target ?? 'no target'}</code></article>)}</div>;
}

export function reconcileSelectedSessionId(preferredSessionId: string | null, sessions: readonly Session[]): string | null {
  if (preferredSessionId !== null && sessions.some((session) => session.id === preferredSessionId)) return preferredSessionId;
  return sessions[0]?.id ?? null;
}

export function approvalBelongsToSessionContext(
  approval: PendingApproval,
  clientId: string,
  selectedSessionId: string | null,
): boolean {
  if (approval.sessionId !== null) {
    return selectedSessionId !== null
      && approval.sessionId === selectedSessionId
      && (approval.clientId === null || approval.clientId === clientId);
  }
  return approval.clientId === null || approval.clientId === clientId;
}

function readSelectedSessionId(): string | null {
  const value = window.sessionStorage.getItem(WEB_SELECTED_SESSION_KEY);
  return value !== null && value.length > 0 && value.length <= 200 && !value.includes('\0') ? value : null;
}

function persistSelectedSessionId(sessionId: string | null): void {
  if (sessionId === null) {
    window.sessionStorage.removeItem(WEB_SELECTED_SESSION_KEY);
    return;
  }
  window.sessionStorage.setItem(WEB_SELECTED_SESSION_KEY, sessionId);
}

function humanAgentName(agentId: string): string {
  return agentId === 'owner-web' ? 'Owner Web' : agentId;
}

function formatSessionTime(createdAt: string): string {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return 'Unknown';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function humanCapability(capabilityId: string): string {
  return capabilityId.split('.').map((part) => part.replaceAll('_', ' ')).join(' · ');
}

function interactionLabel(kind: SessionInteraction['kind']): string {
  if (kind === 'user') return 'You';
  if (kind === 'assistant') return 'IRIS';
  return 'Execution failed';
}

function readOwnerAccessToken(): string {
  const hash = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash);
  const supplied = hash.get('owner');
  if (supplied !== null && /^[A-Za-z0-9_-]{40,128}$/.test(supplied)) {
    window.sessionStorage.setItem(WEB_OWNER_TOKEN_KEY, supplied);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    return supplied;
  }
  return window.sessionStorage.getItem(WEB_OWNER_TOKEN_KEY) ?? '';
}

function authorizedFetch(token: string, input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) return Promise.resolve(new Response(null, { status: 401 }));
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

export function webClientId(): string {
  const existing = window.sessionStorage.getItem(WEB_CLIENT_ID_KEY);
  if (existing !== null) {
    const normalized = existing.trim();
    if (normalized.length > 0 && normalized.length <= 200 && !normalized.includes('\0')) {
      if (normalized !== existing) window.sessionStorage.setItem(WEB_CLIENT_ID_KEY, normalized);
      return normalized;
    }
    window.sessionStorage.removeItem(WEB_CLIENT_ID_KEY);
  }
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(WEB_CLIENT_ID_KEY, created);
  return created;
}

export async function isAppliedOwnerDenial(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const body = await response.clone().json() as { error?: { code?: string } };
    return body.error?.code === 'CAPABILITY_DENIED';
  } catch {
    return false;
  }
}

async function responseErrorDetails(response: Response, fallback: string): Promise<{ code: string | null; message: string }> {
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } };
    return { code: body.error?.code ?? null, message: body.error?.message ?? fallback };
  } catch {
    return { code: null, message: fallback };
  }
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}
