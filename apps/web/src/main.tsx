import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Health = { status: string; runtimeId: string; instanceId: string; pid: number; uptimeMs: number; authority: string; connectedClients: number; connectedSessions: number; apiUrl: string; mcpUrl: string };
type Project = { id: string; name: string; rootPath: string };
type Session = { id: string; clientId: string; currentProjectId: string | null };

const WEB_CLIENT_ID_KEY = 'iris.web.clientId';

function webClientId(): string {
  const existing = window.sessionStorage.getItem(WEB_CLIENT_ID_KEY);
  if (existing !== null) return existing;
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(WEB_CLIENT_ID_KEY, created);
  return created;
}

function App() {
  const [clientId] = useState(webClientId);
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [healthResponse, projectsResponse] = await Promise.all([fetch('/health'), fetch('/projects')]);
      if (!healthResponse.ok || !projectsResponse.ok) throw new Error('Runtime unavailable');
      setHealth(await healthResponse.json() as Health);
      const projectBody = await projectsResponse.json() as { projects: Project[] };
      setProjects(projectBody.projects);
      setError('');
    } catch (cause) { setHealth(null); setError(cause instanceof Error ? cause.message : 'Runtime unavailable'); }
  }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 3_000); return () => window.clearInterval(timer); }, [refresh]);

  const createSession = async () => {
    const response = await fetch('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId }),
    });
    if (!response.ok) throw new Error('Could not create session');
    setSession(await response.json() as Session);
    await refresh();
  };

  const registerProject = async () => {
    const response = await fetch('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, rootPath }) });
    if (!response.ok) throw new Error((await response.json() as { error?: { message?: string } }).error?.message ?? 'Could not register project');
    setName(''); setRootPath(''); await refresh();
  };

  const selectProject = async (projectId: string) => {
    if (session === null) return;
    const response = await fetch(`/sessions/${encodeURIComponent(session.id)}/current-project`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-iris-client-id': session.clientId },
      body: JSON.stringify({ projectId: projectId || null }),
    });
    if (!response.ok) throw new Error('Could not update current project');
    setSession(await response.json() as Session);
  };

  const run = (operation: () => Promise<void>) => { void operation().catch((cause) => setError(cause instanceof Error ? cause.message : 'Operation failed')); };

  return <main>
    <p className="eyebrow">IRIS Local Runtime</p>
    <h1>IRIS</h1>
    <p className={`status ${health ? 'status--connected' : 'status--unavailable'}`}><span />{health ? health.status : 'unavailable'}</p>
    {error && <p className="error">{error}</p>}
    {health && <section><h2>Runtime</h2><dl>
      <dt>Runtime</dt><dd>{health.runtimeId}</dd><dt>Instance</dt><dd>{health.instanceId}</dd><dt>PID</dt><dd>{health.pid}</dd><dt>Uptime</dt><dd>{Math.floor(health.uptimeMs / 1000)}s</dd><dt>Authority</dt><dd>{health.authority}</dd><dt>API</dt><dd>{health.apiUrl}</dd><dt>MCP</dt><dd>{health.mcpUrl}</dd><dt>Sessions</dt><dd>{health.connectedSessions}</dd>
    </dl></section>}
    <section><h2>Session</h2>{session === null ? <button onClick={() => run(createSession)}>Create Web session</button> : <><p><code>{session.id}</code></p><label>Current project<select value={session.currentProjectId ?? ''} onChange={(event) => run(() => selectProject(event.target.value))}><option value="">None</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></>}</section>
    <section><h2>Projects</h2>{projects.length === 0 ? <p>No registered projects.</p> : <ul>{projects.map((project) => <li key={project.id}><strong>{project.name}</strong><br/><code>{project.rootPath}</code></li>)}</ul>}
      <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Absolute path<input value={rootPath} onChange={(event) => setRootPath(event.target.value)} /></label><button onClick={() => run(registerProject)}>Register project</button>
    </section>
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(<StrictMode><App /></StrictMode>);
