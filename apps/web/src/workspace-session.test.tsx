/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  App,
  RuntimePage,
  approvalBelongsToSessionContext,
  reconcileSelectedSessionId,
  webClientId,
  type PendingApproval,
  type Session,
} from './App.js';

const projectA = { id: 'project-a', name: 'IRIS', rootPath: '/Users/bill/iris' };
const projectB = { id: 'project-b', name: 'Sandbox', rootPath: '/Users/bill/sandbox' };
const sessionA: Session = {
  id: 'session-a', clientId: 'web-client', agentId: 'owner-web', agentRole: 'owner',
  createdAt: '2026-09-05T06:00:00.000Z', currentProjectId: projectA.id, executionState: 'READY', interactions: [],
};
const sessionB: Session = {
  id: 'session-b', clientId: 'web-client', agentId: 'owner-web', agentRole: 'owner',
  createdAt: '2026-09-05T06:05:00.000Z', currentProjectId: projectB.id, executionState: 'READY', interactions: [],
};
const ownerToken = 'o'.repeat(48);

const health = {
  status: 'ready', runtimeId: 'runtime', instanceId: 'instance', pid: 123, uptimeMs: 60_000,
  authority: 'owned', connectedClients: 1, connectedSessions: 2,
  agentExecutorType: 'local-development-executor' as const, productionModelConnected: false,
  apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
};

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.sessionStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
    HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  }
  if (typeof HTMLDialogElement.prototype.close !== 'function') {
    HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); };
  }
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderWorkspace(selectedSession: Session | null, sessions: Session[] = [sessionA, sessionB], missions: Parameters<typeof RuntimePage>[0]['missions'] = []): string {
  return renderToStaticMarkup(createElement(RuntimePage, {
    health,
    projects: [projectA, projectB],
    defaultProject: projectA,
    activeProject: selectedSession?.currentProjectId === projectA.id ? projectA : selectedSession?.currentProjectId === projectB.id ? projectB : null,
    sessions,
    missions,
    selectedSession,
    sessionActivity: [],
    pendingApprovalCount: 0,
    instruction: '',
    isSubmitting: false,
    name: '',
    rootPath: '',
    setName: () => undefined,
    setRootPath: () => undefined,
    setInstruction: () => undefined,
    onCreateSession: () => undefined,
    onSubmitInstruction: () => undefined,
    onSelectSession: () => undefined,
    onRegisterProject: () => undefined,
    onSelectProject: () => undefined,
  }));
}

describe('daily workspace session experience', () => {
  it('renders the authoritative session list and marks the selected session', () => {
    const markup = renderWorkspace(sessionA);
    expect(markup).toContain('Your sessions');
    expect(markup).toContain('Session 1');
    expect(markup).toContain('Session 2');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('IRIS');
    expect(markup).toContain('/Users/bill/iris');
  });

  it('renders the correct active project when switching the selected runtime session', () => {
    const first = renderWorkspace(sessionA);
    const second = renderWorkspace(sessionB);
    expect(first).toContain('/Users/bill/iris');
    expect(second).toContain('/Users/bill/sandbox');
    expect(second).toContain('Sandbox');
  });

  it('restores a selected session across refresh only while that authoritative session still exists', () => {
    expect(reconcileSelectedSessionId(sessionB.id, [sessionA, sessionB])).toBe(sessionB.id);
    expect(reconcileSelectedSessionId('stale-session', [sessionA, sessionB])).toBe(sessionA.id);
    expect(reconcileSelectedSessionId(sessionA.id, [])).toBeNull();
  });

  it('regenerates malformed persisted browser client identity before runtime listing', () => {
    window.sessionStorage.setItem('iris.web.clientId', '   ');
    const generated = webClientId();
    expect(generated).not.toBe('   ');
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.length).toBeLessThanOrEqual(200);
    expect(window.sessionStorage.getItem('iris.web.clientId')).toBe(generated);

    window.sessionStorage.setItem('iris.web.clientId', ` ${'a'.repeat(12)} `);
    expect(webClientId()).toBe('a'.repeat(12));
    expect(window.sessionStorage.getItem('iris.web.clientId')).toBe('a'.repeat(12));
  });

  it('mounts App, restores authoritative state, reconnects without duplication, creates and switches sessions with the correct client identity', async () => {
    window.sessionStorage.setItem('iris.web.clientId', 'web-client');
    window.sessionStorage.setItem('iris.web.ownerToken', ownerToken);
    window.sessionStorage.setItem('iris.web.selectedSessionId', sessionB.id);

    const runtimeSessions: Session[] = [sessionA, sessionB];
    const calls: Array<{ url: string; method: string; clientId: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      calls.push({ url, method, clientId: headers.get('x-iris-client-id') });

      if (url === '/health') return jsonResponse(health);
      if (url === '/projects' && method === 'GET') return jsonResponse({ projects: [projectA, projectB], defaultProjectId: projectA.id });
      if (url === '/missions') return jsonResponse({ missions: [] });
      if (url === '/permissions') return jsonResponse(permissionSnapshot([]));
      if (url === '/sessions' && method === 'GET') return jsonResponse({ sessions: [...runtimeSessions] });
      if (url === '/sessions' && method === 'POST') {
        const body = JSON.parse(String(init.body)) as { clientId: string };
        expect(body.clientId).toBe('web-client');
        const created: Session = {
          id: 'session-c', clientId: body.clientId, agentId: 'owner-web', agentRole: 'owner',
          createdAt: '2026-09-05T06:10:00.000Z', currentProjectId: null, executionState: 'READY', interactions: [],
        };
        runtimeSessions.push(created);
        return jsonResponse(created, 201);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    await mountApp();
    await settleApp();

    expect(document.body.textContent).toContain('Sandbox');
    expect(window.sessionStorage.getItem('iris.web.selectedSessionId')).toBe(sessionB.id);
    expect(calls.find((call) => call.url === '/sessions' && call.method === 'GET')?.clientId).toBe('web-client');

    const initialSessionGets = calls.filter((call) => call.url === '/sessions' && call.method === 'GET').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await settleApp();
    expect(runtimeSessions).toHaveLength(2);
    expect(calls.filter((call) => call.url === '/sessions' && call.method === 'GET').length).toBeGreaterThan(initialSessionGets);

    await clickButton('+ New');
    await settleApp();
    expect(runtimeSessions).toHaveLength(3);
    expect(window.sessionStorage.getItem('iris.web.selectedSessionId')).toBe('session-c');
    expect(document.body.textContent).toContain('Session 3');

    await clickButtonStartingWith('Session 1');
    expect(window.sessionStorage.getItem('iris.web.selectedSessionId')).toBe(sessionA.id);
    expect(document.body.textContent).toContain('/Users/bill/iris');
  });

  it('mounts App and clears stale selection when a restarted daemon reports no transient sessions while persisted projects remain', async () => {
    window.sessionStorage.setItem('iris.web.clientId', 'web-client');
    window.sessionStorage.setItem('iris.web.ownerToken', ownerToken);
    window.sessionStorage.setItem('iris.web.selectedSessionId', sessionA.id);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (url === '/health') return jsonResponse({ ...health, instanceId: 'restarted-instance', connectedSessions: 0 });
      if (url === '/projects' && method === 'GET') return jsonResponse({ projects: [projectA], defaultProjectId: projectA.id });
      if (url === '/sessions' && method === 'GET') return jsonResponse({ sessions: [] });
      if (url === '/missions') return jsonResponse({ missions: [] });
      if (url === '/permissions') return jsonResponse(permissionSnapshot([]));
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    await mountApp();
    await settleApp();

    expect(window.sessionStorage.getItem('iris.web.selectedSessionId')).toBeNull();
    expect(document.body.textContent).toContain('No sessions yet.');
    expect(document.body.textContent).toContain('IRIS');
    expect(document.body.textContent).toContain('/Users/bill/iris');
  });

  it('binds approval UI to the selected session and drops the prior session approval when switching context', async () => {
    window.sessionStorage.setItem('iris.web.clientId', 'web-client');
    window.sessionStorage.setItem('iris.web.ownerToken', ownerToken);
    window.sessionStorage.setItem('iris.web.selectedSessionId', sessionA.id);
    const approvalA = approval({ id: 'approval-a', sessionId: sessionA.id, clientId: 'web-client' });
    const approvalB = approval({ id: 'approval-b', sessionId: sessionB.id, clientId: 'web-client', exactAction: 'session-b-action' });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (url === '/health') return jsonResponse(health);
      if (url === '/projects' && method === 'GET') return jsonResponse({ projects: [projectA, projectB], defaultProjectId: projectA.id });
      if (url === '/sessions' && method === 'GET') return jsonResponse({ sessions: [sessionA, sessionB] });
      if (url === '/missions') return jsonResponse({ missions: [] });
      if (url === '/permissions') return jsonResponse(permissionSnapshot([approvalA, approvalB]));
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    await mountApp();
    await settleApp();
    await clickButton('Approval Center (1)');
    expect(document.body.textContent).toContain('session · current project · set');
    expect(document.body.textContent).not.toContain('session-b-action');
    await clickButton('Review exact action');
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(document.body.textContent).toContain('session.current_project.set');

    await clickButton('Workspace');
    await clickButtonStartingWith('Session 2');
    await settleApp();
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    await clickButton('Approval Center (1)');
    await clickButton('Review exact action');
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(document.body.textContent).toContain('session-b-action');
  });

  it('associates pending approvals only with the selected session or current browser-client machine context', () => {
    const sessionApproval = approval({ sessionId: sessionA.id, clientId: 'web-client' });
    const otherSessionApproval = approval({ sessionId: sessionB.id, clientId: 'web-client' });
    const browserClientApproval = approval({ sessionId: null, clientId: 'web-client' });
    const otherClientApproval = approval({ sessionId: null, clientId: 'other-client' });

    expect(approvalBelongsToSessionContext(sessionApproval, 'web-client', sessionA.id)).toBe(true);
    expect(approvalBelongsToSessionContext(otherSessionApproval, 'web-client', sessionA.id)).toBe(false);
    expect(approvalBelongsToSessionContext(browserClientApproval, 'web-client', sessionA.id)).toBe(true);
    expect(approvalBelongsToSessionContext(otherClientApproval, 'web-client', sessionA.id)).toBe(false);
  });

  it('renders mission control state, approval association, evidence count, and recent timeline read-only', () => {
    const mission: Parameters<typeof RuntimePage>[0]['missions'][number] = {
      id: '11111111-1111-4111-8111-111111111111', title: 'Hermes mission', state: 'WAITING_APPROVAL',
      clientId: 'web-client', sessionId: sessionA.id, projectId: projectA.id,
      createdAt: '2026-09-05T06:00:00.000Z', updatedAt: '2026-09-05T06:10:00.000Z',
      supervisorGate: { state: 'PENDING', reason: 'Await supervisor directive', updatedAt: '2026-09-05T06:09:00.000Z' },
      tasks: [{
        id: '22222222-2222-4222-8222-222222222222', title: 'Governed write', state: 'BLOCKED',
        createdAt: '2026-09-05T06:01:00.000Z', updatedAt: '2026-09-05T06:08:00.000Z',
        actions: [{
          id: '33333333-3333-4333-8333-333333333333', capabilityId: 'file.write', summary: 'Write bounded artifact',
          state: 'OWNER_APPROVAL_REQUIRED', createdAt: '2026-09-05T06:02:00.000Z', updatedAt: '2026-09-05T06:08:00.000Z',
          approvalId: '44444444-4444-4444-8444-444444444444',
          result: { status: 'OWNER_REQUIRED', summary: 'Owner approval required', approvalId: '44444444-4444-4444-8444-444444444444', completedAt: null, evidence: [{ id: '55555555-5555-4555-8555-555555555555', kind: 'OBSERVATION', label: 'scope', summary: 'Bounded observation', reference: null, data: {} }] },
        }],
      }],
      timeline: [{ id: '66666666-6666-4666-8666-666666666666', timestamp: '2026-09-05T06:08:00.000Z', kind: 'APPROVAL_REQUIRED', taskId: '22222222-2222-4222-8222-222222222222', actionId: '33333333-3333-4333-8333-333333333333', message: 'Owner approval is required before the governed action can execute' }],
    };
    const markup = renderWorkspace(sessionA, [sessionA], [mission]);
    expect(markup).toContain('Mission Control');
    expect(markup).toContain('Hermes execution ledger');
    expect(markup).toContain('Hermes mission');
    expect(markup).toContain('WAITING_APPROVAL');
    expect(markup).toContain('PENDING');
    expect(markup).toContain('Approval associated');
    expect(markup).toContain('1 evidence item');
    expect(markup).toContain('Owner approval is required before the governed action can execute');
  });

  it('shows intentional empty states when there is no session or active project', () => {
    const markup = renderWorkspace(null, []);
    expect(markup).toContain('No active project');
    expect(markup).toContain('No sessions yet.');
    expect(markup).toContain('Nothing selected');
    expect(markup).toContain('Create session');
  });
});

async function mountApp(): Promise<void> {
  const container = document.getElementById('root');
  if (container === null) throw new Error('Missing root');
  root = createRoot(container);
  await act(async () => root?.render(createElement(App)));
}

async function settleApp(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function clickButton(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  await act(async () => button.click());
}

async function clickButtonStartingWith(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim().startsWith(label));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found with prefix: ${label}`);
  await act(async () => button.click());
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function permissionSnapshot(pendingApprovals: PendingApproval[]) {
  return {
    mode: 'FULL_LOCAL_OWNER',
    approvedRoots: ['/Users/bill/iris'],
    autoApprovedCategories: [],
    ownerRequiredCategories: [],
    capabilities: [],
    recentDecisions: [],
    pendingApprovals,
  };
}

function approval(overrides: Partial<PendingApproval>): PendingApproval {
  return {
    id: 'approval', timestamp: '2026-09-05T06:00:00.000Z', clientId: 'web-client', sessionId: sessionA.id,
    agentId: 'owner-web', capabilityId: 'session.current_project.set', riskClass: 'LOW', projectId: projectA.id,
    target: null, decision: 'OWNER_REQUIRED', reason: 'Owner decision required', exactAction: 'session.current_project.set',
    canAlwaysAllowProject: false,
    ...overrides,
  };
}
