/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerControlPanel } from './owner-control.js';
import { App } from './App.js';

const token = 'A'.repeat(43);
const key = 'iris.web.runtimeRestartRequestId';
let root: Root | undefined;
type Call = { name: string; arguments: Record<string, unknown> };
type Reply = Record<string, unknown> | Response;
let calls: Call[];
let running: boolean;
let preference: boolean;
let respond: (call: Call) => Promise<Reply>;

function status(name: string): Record<string, unknown> {
  if (name === 'supervisor_status') return { controlOnlyReadiness: 'READY', controlOnlyReadinessCode: 'READY', fullStackReadiness: running ? 'READY' : 'DEGRADED', workloadState: running ? 'RUNNING' : 'OFF', supervisorProcessId: 100 };
  if (name === 'runtime_status') return { state: running ? 'running' : 'stopped', endpoint: running ? { pid: 200 } : null };
  if (name === 'keep_awake_status') return { preferenceEnabled: preference, requested: preference, observed: preference ? 'UNAVAILABLE' : 'OFF' };
  if (name === 'supervisor_doctor') return { CODE: 'RUNTIME_STOPPED', ACTION: 'Start Runtime when ready.' };
  throw new Error(`Unhandled fixture method ${name}`);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  sessionStorage.clear();
  sessionStorage.setItem('iris.web.ownerToken', token);
  calls = []; running = false; preference = false;
  respond = async (call) => status(call.name);
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input) === '/health') return new Response(null, { status: 503 });
    expect(String(input)).toBe('/control/mcp');
    expect(String(input)).not.toContain(token);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(new Headers(init.headers).get('mcp-protocol-version')).toBe('2026-07-28');
    const body = JSON.parse(String(init.body)) as { id: string; method: string; params: Call };
    expect(body.method).toBe('tools/call');
    calls.push(body.params);
    const value = await respond(body.params);
    return value instanceof Response ? value : Response.json({ jsonrpc: '2.0', id: body.id, result: { isError: false, structuredContent: value } });
  }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(app = false) {
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(app ? createElement(App) : createElement(OwnerControlPanel, { ownerAccessToken: token })); });
}
function button(name: string) { return [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === name)!; }
async function click(name: string) { await act(async () => button(name).click()); }

describe('persistent Owner controls', () => {
  it('keeps real controls visible and reads their status when App workload health is off', async () => {
    await mount(true);
    expect(document.body.textContent).toContain('Runtime unavailable');
    expect(document.body.textContent).toContain('Runtime and connection');
    expect(button('Runtime On').disabled).toBe(false);
    expect(button('Runtime Off').disabled).toBe(true);
    expect(calls.map((call) => call.name)).toEqual(expect.arrayContaining(['supervisor_status', 'runtime_status', 'keep_awake_status']));
    expect(calls.some((call) => ['runtime_on', 'runtime_off', 'runtime_restart', 'keep_awake_set'].includes(call.name))).toBe(false);
  });

  it('runs Owner lifecycle, doctor and keep-awake controls and separates preference from observation', async () => {
    respond = async (call) => {
      if (call.name === 'runtime_on') { expect(call.arguments).toEqual({}); running = true; return { state: 'RUNNING' }; }
      if (call.name === 'runtime_off') { expect(call.arguments).toEqual({}); running = false; return { state: 'OFF' }; }
      if (call.name === 'keep_awake_set') { expect(call.arguments).toEqual({ enabled: true }); preference = true; return status('keep_awake_status'); }
      return status(call.name);
    };
    await mount();
    await click('Runtime On');
    expect(button('Runtime Off').disabled).toBe(false);
    await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(document.body.textContent).toContain('Preference: On · Requested: Yes · Observed: UNAVAILABLE');
    await click('Check connection');
    expect(document.body.textContent).toContain('Start Runtime when ready.');
    await click('Runtime Off');
    expect(button('Runtime On').disabled).toBe(false);
    expect(document.body.textContent).not.toContain(token);
  });

  it.each(['wrong-auth', 'malformed-json', 'wrong-rpc-id', 'incomplete-status'])('fails closed on %s without hiding the panel', async (failure) => {
    respond = async (call) => {
      if (failure === 'wrong-auth') return new Response(token, { status: 401 });
      if (failure === 'malformed-json') return new Response('{');
      if (failure === 'wrong-rpc-id') return Response.json({ jsonrpc: '2.0', id: 'unrelated', result: { isError: false, structuredContent: status(call.name) } });
      return {};
    };
    await mount();
    expect(button('Runtime On').disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Runtime and connection');
    expect(document.body.textContent).not.toContain(token);
  });

  it('reports MCP denial codes without rendering credential-bearing diagnostic text', async () => {
    await mount();
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { isError: true, structuredContent: { error: { code: 'CONTROL_DENIED', message: `secret=${token}` } } } });
    }));
    await click('Runtime On');
    expect(document.body.textContent).toContain('CONTROL_DENIED');
    expect(document.body.textContent).not.toContain(token);
    expect(button('Runtime On').disabled).toBe(true);
  });

  it('retains an unknown restart across reload and reconciles its original identity before any retry', async () => {
    running = true;
    let original: string | undefined;
    respond = async (call) => {
      if (call.name === 'runtime_restart') { original = String(call.arguments.requestId); throw new Error('lost response'); }
      if (call.name === 'runtime_restart_status') { expect(call.arguments).toEqual({ requestId: original, reconcile: true }); return { requestId: original, workloadOnly: true, state: 'RUNNING' }; }
      return status(call.name);
    };
    await mount();
    await click('Restart Runtime');
    expect(sessionStorage.getItem(key)).toBe(original);
    expect(button('Restart Runtime').disabled).toBe(true);
    expect(document.body.textContent).toContain('original request is retained');
    await act(async () => root!.unmount()); root = undefined;
    await mount();
    expect(calls.filter((call) => call.name === 'runtime_restart')).toHaveLength(1);
    await click('Check restart outcome');
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(document.body.textContent).toContain('Runtime restart completed.');
    expect(calls.filter((call) => call.name === 'runtime_restart')).toHaveLength(1);
  });

  it('retains a malformed saved restart identity without issuing another mutation', async () => {
    running = true;
    sessionStorage.setItem(key, 'invalid-saved-request');
    await mount();
    expect(button('Restart Runtime').disabled).toBe(true);
    await click('Check restart outcome');
    expect(sessionStorage.getItem(key)).toBe('invalid-saved-request');
    expect(document.body.textContent).toContain('saved restart identity is invalid');
    expect(calls.some((call) => call.name.startsWith('runtime_restart'))).toBe(false);
  });

  it('only retries the original restart after explicit NOT_FOUND evidence', async () => {
    running = true;
    let restarts = 0;
    let requestId: unknown;
    respond = async (call) => {
      if (call.name === 'runtime_restart') {
        restarts += 1;
        if (restarts === 1) { requestId = call.arguments.requestId; throw new Error('lost request'); }
        expect(call.arguments.requestId).toBe(requestId);
        return { requestId, workloadOnly: true, state: 'RUNNING' };
      }
      if (call.name === 'runtime_restart_status') return { requestId, workloadOnly: true, state: 'NOT_FOUND' };
      return status(call.name);
    };
    await mount(); await click('Restart Runtime');
    expect(button('Retry original restart')).toBeUndefined();
    await click('Check restart outcome'); await click('Retry original restart');
    expect(restarts).toBe(2);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it.each(['PENDING', 'RECONCILIATION_REQUIRED', 'FAILED', 'wrong-request', 'malformed'])('reports restart %s without claiming success', async (state) => {
    running = true;
    respond = async (call) => call.name === 'runtime_restart'
      ? { requestId: state === 'wrong-request' ? crypto.randomUUID() : call.arguments.requestId, workloadOnly: state !== 'malformed', state }
      : status(call.name);
    await mount(); await click('Restart Runtime');
    expect(document.body.textContent).not.toContain('Runtime restart completed.');
    expect(sessionStorage.getItem(key) === null).toBe(state === 'FAILED');
    if (state !== 'FAILED') expect(button('Restart Runtime').disabled).toBe(true);
  });
});
