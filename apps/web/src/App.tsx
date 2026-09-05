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
  apiUrl: string;
  mcpUrl: string;
};

type Project = { id: string; name: string; rootPath: string };
type Session = { id: string; clientId: string; agentId: string; agentRole: string; currentProjectId: string | null };
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

export function App(): ReactElement {
  const [clientId] = useState(webClientId);
  const [ownerAccessToken] = useState(readOwnerAccessToken);
  const [view, setView] = useState<View>('runtime');
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [selectedApproval, setSelectedApproval] = useState<PendingApproval | null>(null);
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      const healthResponse = await fetch('/health');
      if (!healthResponse.ok) throw new Error('Runtime unavailable');
      setHealth(await healthResponse.json() as Health);
      if (ownerAccessToken.length === 0) {
        setProjects([]);
        setPermissions(null);
        setError('Owner access is locked. Open the IRIS_OWNER_URL printed by pnpm dev.');
        return;
      }
      const [projectsResponse, permissionsResponse] = await Promise.all([
        authorizedFetch(ownerAccessToken, '/projects'),
        authorizedFetch(ownerAccessToken, '/permissions'),
      ]);
      if (!projectsResponse.ok || !permissionsResponse.ok) throw new Error('Owner access was rejected by the runtime');
      const projectBody = await projectsResponse.json() as { projects: Project[] };
      setProjects(projectBody.projects);
      setPermissions(await permissionsResponse.json() as PermissionSnapshot);
      setError('');
    } catch (cause) {
      setHealth(null);
      setError(cause instanceof Error ? cause.message : 'Runtime unavailable');
    }
  }, [ownerAccessToken]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

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
    setSession(await response.json() as Session);
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
    if (session === null) return;
    const response = await authorizedFetch(ownerAccessToken, `/sessions/${encodeURIComponent(session.id)}/current-project`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-iris-client-id': session.clientId },
      body: JSON.stringify({ projectId: projectId || null }),
    });
    if (response.status === 409) {
      setNotice('Changing the session project requires an owner decision. The existing session was left unchanged.');
      setView('approvals');
      await refresh();
      return;
    }
    if (!response.ok) throw new Error(await responseMessage(response, 'Could not update current project'));
    setSession(await response.json() as Session);
    await refresh();
  };

  const requestMode = async (mode: PermissionMode) => {
    const response = await authorizedFetch(ownerAccessToken, '/permissions/mode', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(session === null ? {} : { 'x-iris-client-id': session.clientId, 'x-iris-session-id': session.id }),
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
    const response = await authorizedFetch(ownerAccessToken, `/approvals/${encodeURIComponent(approval.id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }),
    });
    const denialApplied = decision === 'DENY' && await isAppliedOwnerDenial(response);
    if (!response.ok && !denialApplied) throw new Error(await responseMessage(response, 'Could not resolve approval'));
    if (!denialApplied
      && response.ok
      && approval.clientId === clientId
      && (approval.capabilityId === 'session.create' || approval.capabilityId === 'session.current_project.set')) {
      setSession(await response.json() as Session);
    }
    setSelectedApproval(null);
    setNotice(decision === 'DENY' ? 'Action denied. Nothing was executed.' : 'Owner decision applied to the exact pending action.');
    await refresh();
  };

  const run = (operation: () => Promise<void>) => {
    setError('');
    void operation().catch((cause) => setError(cause instanceof Error ? cause.message : 'Operation failed'));
  };

  return <div className="app-frame">
    <header className="web-header">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">I</span>
        <div><strong>IRIS</strong><small>Local Runtime</small></div>
      </div>
      <nav aria-label="IRIS sections">
        <button className={view === 'runtime' ? 'is-active' : ''} onClick={() => setView('runtime')}>Runtime</button>
        <button className={view === 'permissions' ? 'is-active' : ''} onClick={() => setView('permissions')}>Settings · Permissions</button>
        <button className={view === 'approvals' ? 'is-active' : ''} onClick={() => setView('approvals')}>
          Approval Center{permissions?.pendingApprovals.length ? ` (${permissions.pendingApprovals.length})` : ''}
        </button>
      </nav>
      <span className={`header-status ${health ? 'is-online' : ''}`}>{health ? 'Local daemon online' : 'Runtime unavailable'}</span>
    </header>

    <main>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {view === 'runtime' && <RuntimePage
        health={health} projects={projects} session={session} name={name} rootPath={rootPath}
        setName={setName} setRootPath={setRootPath} onCreateSession={() => run(createSession)}
        onRegisterProject={() => run(registerProject)} onSelectProject={(projectId) => run(() => selectProject(projectId))}
      />}
      {view === 'permissions' && <PermissionsPage permissions={permissions} onRequestMode={(mode) => run(() => requestMode(mode))} />}
      {view === 'approvals' && <ApprovalCenter permissions={permissions} onReview={setSelectedApproval} />}
    </main>

    <ApprovalReview
      approval={selectedApproval}
      onCancel={() => setSelectedApproval(null)}
      onDecision={(approval, choice) => run(() => resolveApproval(approval, choice))}
    />
  </div>;
}

function RuntimePage(props: {
  health: Health | null; projects: Project[]; session: Session | null; name: string; rootPath: string;
  setName(value: string): void; setRootPath(value: string): void; onCreateSession(): void; onRegisterProject(): void; onSelectProject(projectId: string): void;
}): ReactElement {
  return <>
    <div className="page-heading"><div><p className="eyebrow">Machine-local authority</p><h1>IRIS Local Runtime</h1></div></div>
    <p className={`status ${props.health ? 'status--connected' : 'status--unavailable'}`}><span />{props.health ? props.health.status : 'unavailable'}</p>
    {props.health && <section><h2>Runtime</h2><dl>
      <dt>Runtime</dt><dd>{props.health.runtimeId}</dd><dt>Instance</dt><dd>{props.health.instanceId}</dd><dt>PID</dt><dd>{props.health.pid}</dd>
      <dt>Uptime</dt><dd>{Math.floor(props.health.uptimeMs / 1000)}s</dd><dt>Authority</dt><dd>{props.health.authority}</dd>
      <dt>API</dt><dd>{props.health.apiUrl}</dd><dt>MCP</dt><dd>{props.health.mcpUrl}</dd><dt>Sessions</dt><dd>{props.health.connectedSessions}</dd>
    </dl></section>}
    <section><h2>Session</h2>{props.session === null
      ? <button onClick={props.onCreateSession}>Create Web session</button>
      : <><p>Session <code>{props.session.id}</code></p><p>Agent <code>{props.session.agentId}</code> · {props.session.agentRole}</p><label>Current project<select value={props.session.currentProjectId ?? ''} onChange={(event) => props.onSelectProject(event.target.value)}><option value="">None</option>{props.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></>}</section>
    <section><h2>Projects</h2>{props.projects.length === 0 ? <p>No registered projects.</p> : <ul>{props.projects.map((project) => <li key={project.id}><strong>{project.name}</strong><br/><code>{project.rootPath}</code></li>)}</ul>}
      <label>Name<input value={props.name} onChange={(event) => props.setName(event.target.value)} /></label>
      <label>Absolute path<input value={props.rootPath} onChange={(event) => props.setRootPath(event.target.value)} /></label>
      <button onClick={props.onRegisterProject}>Register project</button>
    </section>
  </>;
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

function ApprovalCenter(props: { permissions: PermissionSnapshot | null; onReview(approval: PendingApproval): void }): ReactElement {
  const approvals = props.permissions?.pendingApprovals ?? [];
  return <>
    <div className="page-heading"><div><p className="eyebrow">Owner decisions</p><h1>Approval Center</h1><p>Only genuine trust or authority expansion appears here. Auto-approved project work never blocks on this screen.</p></div></div>
    <section>{approvals.length === 0 ? <p>No pending owner decisions.</p> : <div className="approval-list">{approvals.map((approval) => <article key={approval.id} className="approval-row">
      <div><strong>{approval.capabilityId}</strong><span className={`risk risk-${approval.riskClass.toLowerCase()}`}>{approval.riskClass}</span><p>{approval.reason}</p><code>{approval.target ?? 'No filesystem target'}</code></div>
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

function webClientId(): string {
  const existing = window.sessionStorage.getItem(WEB_CLIENT_ID_KEY);
  if (existing !== null) return existing;
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

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}
