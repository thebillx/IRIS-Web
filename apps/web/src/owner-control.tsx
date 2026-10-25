import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

const RESTART_KEY = 'iris.web.runtimeRestartRequestId';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ObjectValue = Record<string, unknown>;
type ControlStatus = { controlOnlyReadiness: string; controlOnlyReadinessCode: string; fullStackReadiness: string; workloadState: string; supervisorProcessId?: number };
type RuntimeStatus = { state: 'running' | 'stopped' | 'stale' | 'indeterminate'; endpoint?: { pid?: number } | null };
type AwakeStatus = { preferenceEnabled: boolean; requested: boolean; observed: 'ACTIVE' | 'OFF' | 'UNAVAILABLE' };
type RestartStatus = { requestId: string; state: string };

function isObject(value: unknown): value is ObjectValue { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function textField(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200; }
function readRestartRequest(): string | null {
  try { return sessionStorage.getItem(RESTART_KEY); } catch { return null; }
}

async function controlCall(token: string, name: string, args: ObjectValue = {}): Promise<ObjectValue> {
  if (token.length === 0) throw new Error('Owner access is locked. Open your local Owner link.');
  const id = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch('/control/mcp', {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch { throw new Error('Owner controls are unavailable. The operation outcome is unknown.'); }
  if (response.status === 401 || response.status === 403) throw new Error('Owner access was rejected. Open a current local Owner link.');
  if (!response.ok) throw new Error(`Owner controls returned HTTP ${response.status}. The operation outcome is unknown.`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error('Owner controls returned an unreadable response. The operation outcome is unknown.'); }
  if (!isObject(body) || body.jsonrpc !== '2.0' || body.id !== id || !isObject(body.result)) throw new Error('Owner controls returned an invalid response. The operation outcome is unknown.');
  const result = body.result;
  if (result.isError === true) {
    const detail = isObject(result.structuredContent) && isObject(result.structuredContent.error) ? result.structuredContent.error : null;
    const code = typeof detail?.code === 'string' && /^[A-Z_]{1,80}$/.test(detail.code) ? detail.code : 'REQUEST_FAILED';
    throw new Error(`Owner control request failed (${code}). Refresh status before continuing.`);
  }
  if (result.isError !== false || !isObject(result.structuredContent)) throw new Error('Owner controls returned an invalid result. The operation outcome is unknown.');
  return result.structuredContent;
}

function controlStatus(value: ObjectValue): ControlStatus {
  if (![value.controlOnlyReadiness, value.controlOnlyReadinessCode, value.fullStackReadiness, value.workloadState].every(textField)) throw new Error('Control status is incomplete.');
  return value as ControlStatus;
}
function runtimeStatus(value: ObjectValue): RuntimeStatus {
  if (!['running', 'stopped', 'stale', 'indeterminate'].includes(String(value.state))) throw new Error('Runtime status is incomplete.');
  return value as RuntimeStatus;
}
function awakeStatus(value: ObjectValue): AwakeStatus {
  if (typeof value.preferenceEnabled !== 'boolean' || typeof value.requested !== 'boolean' || !['ACTIVE', 'OFF', 'UNAVAILABLE'].includes(String(value.observed))) throw new Error('Keep-awake status is incomplete.');
  return value as AwakeStatus;
}

export function OwnerControlPanel({ ownerAccessToken }: { readonly ownerAccessToken: string }): ReactElement {
  const [control, setControl] = useState<ControlStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [awake, setAwake] = useState<AwakeStatus | null>(null);
  const [doctor, setDoctor] = useState<ObjectValue | null>(null);
  const [statusError, setStatusError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [restartRequest, setRestartRequest] = useState(readRestartRequest);
  const [restart, setRestart] = useState<RestartStatus | null>(null);
  const active = useRef(true);
  const refreshGeneration = useRef(0);
  const mutation = useRef(false);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const reads = await Promise.allSettled([
      controlCall(ownerAccessToken, 'supervisor_status').then(controlStatus),
      controlCall(ownerAccessToken, 'runtime_status').then(runtimeStatus),
      controlCall(ownerAccessToken, 'keep_awake_status').then(awakeStatus),
    ]);
    if (!active.current || generation !== refreshGeneration.current) return;
    setControl(reads[0].status === 'fulfilled' ? reads[0].value : null);
    setRuntime(reads[1].status === 'fulfilled' ? reads[1].value : null);
    setAwake(reads[2].status === 'fulfilled' ? reads[2].value : null);
    const failure = reads.find((result) => result.status === 'rejected');
    setStatusError(failure?.status === 'rejected' ? message(failure.reason) : '');
  }, [ownerAccessToken]);

  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => { active.current = false; window.clearInterval(timer); };
  }, [refresh]);

  const acceptRestart = (value: ObjectValue, requestId: string) => {
    if (value.requestId !== requestId || value.workloadOnly !== true || !['RUNNING', 'FAILED', 'PENDING', 'RECONCILIATION_REQUIRED', 'NOT_FOUND'].includes(String(value.state))) throw new Error('Restart status does not match the original request. Its outcome is unknown.');
    setRestart({ requestId, state: String(value.state) });
    if (value.state === 'RUNNING' || value.state === 'FAILED') {
      sessionStorage.removeItem(RESTART_KEY);
      setRestartRequest(null);
      setNotice(value.state === 'RUNNING' ? 'Runtime restart completed.' : 'Runtime restart failed. Check status before starting another operation.');
    } else setNotice('Restart is unresolved. Check its outcome before trying again.');
  };

  const run = async (operation: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');
    try { await operation(); } catch (cause) { setActionError(message(cause)); }
    finally { await refresh(); mutation.current = false; setBusy(false); }
  };

  const startRestart = async () => {
    const requestId = restartRequest ?? crypto.randomUUID();
    // Persist the identity before sending: a lost response must never create a second restart.
    sessionStorage.setItem(RESTART_KEY, requestId);
    setRestartRequest(requestId);
    setRestart(null);
    acceptRestart(await controlCall(ownerAccessToken, 'runtime_restart', { requestId }), requestId);
  };
  const checkRestart = async () => {
    if (restartRequest !== null) {
      if (!UUID.test(restartRequest)) throw new Error('The saved restart identity is invalid. It was retained and no new restart was sent.');
      acceptRestart(await controlCall(ownerAccessToken, 'runtime_restart_status', { requestId: restartRequest, reconcile: true }), restartRequest);
    }
  };
  const ready = ownerAccessToken.length > 0 && control !== null && runtime !== null && statusError.length === 0;
  const mutationDisabled = !ready || busy || restartRequest !== null;

  return <section className="owner-control" aria-labelledby="owner-control-heading" aria-busy={busy}>
    <div className="section-title-row"><div><p className="section-label">Owner controls</p><h2 id="owner-control-heading">Runtime and connection</h2></div><button disabled={busy} onClick={() => void refresh()}>Refresh control status</button></div>
    <p>These controls stay available while Runtime is off.</p>
    <dl className="owner-control-status">
      <div><dt>Control connection</dt><dd>{control?.controlOnlyReadiness ?? 'Unknown'}</dd></div>
      <div><dt>Runtime</dt><dd>{runtime?.state === 'running' ? 'On' : runtime?.state === 'stopped' ? 'Off' : runtime?.state ?? 'Unknown'}</dd></div>
      <div><dt>Workload</dt><dd>{control?.workloadState ?? 'Unknown'}</dd></div>
      <div><dt>Full service</dt><dd>{control?.fullStackReadiness ?? 'Unknown'}</dd></div>
    </dl>
    <div className="owner-control-actions">
      <button disabled={mutationDisabled || runtime?.state !== 'stopped'} onClick={() => void run(async () => { await controlCall(ownerAccessToken, 'runtime_on'); setNotice('Runtime On request completed. Status is being checked.'); })}>Runtime On</button>
      <button disabled={mutationDisabled || runtime?.state !== 'running'} onClick={() => void run(async () => { await controlCall(ownerAccessToken, 'runtime_off'); setNotice('Runtime Off request completed. Status is being checked.'); })}>Runtime Off</button>
      <button disabled={mutationDisabled || runtime?.state !== 'running'} onClick={() => void run(startRestart)}>Restart Runtime</button>
      <button disabled={busy || ownerAccessToken.length === 0} onClick={() => void run(async () => { const result = await controlCall(ownerAccessToken, 'supervisor_doctor'); if (!textField(result.CODE) || !textField(result.ACTION)) throw new Error('Health check returned an incomplete result.'); setDoctor(result); })}>Check connection</button>
    </div>
    <div className="owner-control-awake">
      <label><input type="checkbox" checked={awake?.preferenceEnabled ?? false} disabled={mutationDisabled || awake === null} onChange={(event) => { const enabled = event.target.checked; void run(async () => { setAwake(awakeStatus(await controlCall(ownerAccessToken, 'keep_awake_set', { enabled }))); setNotice('Keep-awake preference saved.'); }); }} /> Keep this Mac awake</label>
      <p>Preference: {awake === null ? 'Unknown' : awake.preferenceEnabled ? 'On' : 'Off'} · Requested: {awake === null ? 'Unknown' : awake.requested ? 'Yes' : 'No'} · Observed: {awake?.observed ?? 'Unknown'}</p>
    </div>
    {restartRequest !== null && <div className="notice" role="status"><p>Restart outcome: {restart?.state ?? 'Unknown'}. The original request is retained.</p><button disabled={busy || ownerAccessToken.length === 0} onClick={() => void run(checkRestart)}>Check restart outcome</button>{restart?.state === 'NOT_FOUND' && <button disabled={busy || !ready} onClick={() => void run(startRestart)}>Retry original restart</button>}</div>}
    {doctor !== null && <p role="status">Last connection check: {String(doctor.CODE)}. {String(doctor.ACTION)}</p>}
    {notice && <p role="status">{notice}</p>}
    {statusError && <p className="error" role="alert">{statusError}</p>}
    {actionError && <p className="error" role="alert">{actionError}</p>}
    <details><summary>Control details</summary><p>Readiness: {control?.controlOnlyReadinessCode ?? 'Unknown'}</p><p>Supervisor process: {Number.isSafeInteger(control?.supervisorProcessId) ? control?.supervisorProcessId : 'Unknown'} · Runtime process: {Number.isSafeInteger(runtime?.endpoint?.pid) ? runtime?.endpoint?.pid : 'None observed'}</p></details>
  </section>;
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Owner control request failed.'; }
