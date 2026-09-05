/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, type PendingApproval, type Session } from './App.js';

const ownerToken = 'o'.repeat(48);
const projectA = { id: 'project-a', name: 'IRIS', rootPath: '/Users/bill/iris' };
const projectB = { id: 'project-b', name: 'Sandbox', rootPath: '/Users/bill/sandbox' };
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
  window.sessionStorage.setItem('iris.web.clientId', 'web-client');
  window.sessionStorage.setItem('iris.web.ownerToken', ownerToken);
  document.body.innerHTML = '<div id="root"></div>';
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

describe('agent interaction conversation execution', () => {
  it('submits one instruction to the selected runtime session and refreshes authoritative history without duplicate execution', async () => {
    window.sessionStorage.setItem('iris.web.selectedSessionId', 'session-a');
    let session = sessionSnapshot('session-a', projectA.id);
    let executions = 0;
    const calls: Array<{ url: string; method: string; clientId: string | null }> = [];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      calls.push({ url, method, clientId: headers.get('x-iris-client-id') });
      if (url === '/health') return jsonResponse(health);
      if (url === '/projects') return jsonResponse({ projects: [projectA], defaultProjectId: projectA.id });
      if (url === '/permissions') return jsonResponse(permissionSnapshot([]));
      if (url === '/sessions' && method === 'GET') return jsonResponse({ sessions: [session] });
      if (url === '/sessions/session-a/instructions' && method === 'POST') {
        executions += 1;
        const body = JSON.parse(String(init.body)) as { submissionId: string; instruction: string };
        expect(headers.get('x-iris-client-id')).toBe('web-client');
        expect(body.instruction).toBe('Summarize this local task');
        session = completedSession(session, body.submissionId, body.instruction, 'Development result A');
        return jsonResponse(session);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    await mountApp();
    await settleApp();
    await setInstruction('Summarize this local task');
    await clickButton('Send');
    await settleApp();

    expect(executions).toBe(1);
    expect(document.querySelectorAll('.conversation-message')).toHaveLength(2);
    expect(document.querySelector('.conversation')?.textContent).toContain('Summarize this local task');
    expect(document.querySelector('.conversation')?.textContent).toContain('Development result A');
    expect(calls.find((call) => call.url === '/sessions' && call.method === 'GET')?.clientId).toBe('web-client');

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await settleApp();
    expect(executions).toBe(1);
    expect(document.querySelectorAll('.conversation-message')).toHaveLength(2);
  });

  it('prevents same-session duplicate submission while allowing another session to execute and keeps outputs isolated after switching', async () => {
    window.sessionStorage.setItem('iris.web.selectedSessionId', 'session-a');
    let sessionA = sessionSnapshot('session-a', projectA.id);
    let sessionB = sessionSnapshot('session-b', projectB.id);
    let executionsA = 0;
    let executionsB = 0;
    let finishA: (() => void) | undefined;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (url === '/health') return Promise.resolve(jsonResponse(health));
      if (url === '/projects') return Promise.resolve(jsonResponse({ projects: [projectA, projectB], defaultProjectId: projectA.id }));
      if (url === '/permissions') return Promise.resolve(jsonResponse(permissionSnapshot([])));
      if (url === '/sessions' && method === 'GET') return Promise.resolve(jsonResponse({ sessions: [sessionA, sessionB] }));
      if (url === '/sessions/session-a/instructions' && method === 'POST') {
        executionsA += 1;
        const body = JSON.parse(String(init.body)) as { submissionId: string; instruction: string };
        sessionA = workingSession(sessionA, body.submissionId, body.instruction);
        return new Promise<Response>((resolve) => {
          finishA = () => {
            sessionA = completedSession(sessionA, body.submissionId, body.instruction, 'Output only A');
            resolve(jsonResponse(sessionA));
          };
        });
      }
      if (url === '/sessions/session-b/instructions' && method === 'POST') {
        executionsB += 1;
        const body = JSON.parse(String(init.body)) as { submissionId: string; instruction: string };
        sessionB = completedSession(sessionB, body.submissionId, body.instruction, 'Output only B');
        return Promise.resolve(jsonResponse(sessionB));
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    await mountApp();
    await settleApp();
    await setInstruction('Instruction only A');
    await clickButton('Send');
    await settleApp();
    expect(executionsA).toBe(1);
    const sending = buttonStartingWith('Sending');
    expect(sending.disabled).toBe(true);
    await act(async () => sending.click());
    expect(executionsA).toBe(1);

    await clickButtonStartingWith('Session 2');
    await setInstruction('Instruction only B');
    await clickButton('Send');
    await settleApp();
    expect(executionsB).toBe(1);
    expect(document.querySelector('.conversation')?.textContent).toContain('Output only B');
    expect(document.querySelector('.conversation')?.textContent).not.toContain('Output only A');

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await settleApp();
    await clickButtonStartingWith('Session 1');
    expect(document.body.textContent).toContain('Working');
    expect(document.querySelector('.conversation')?.textContent).toContain('Instruction only A');
    expect(document.querySelector('.conversation')?.textContent).not.toContain('Output only B');

    await act(async () => finishA?.());
    await settleApp();
    expect(document.querySelector('.conversation')?.textContent).toContain('Output only A');
    expect(document.querySelector('.conversation')?.textContent).not.toContain('Output only B');
  });

  it('renders only the safe authoritative executor failure in the originating session', async () => {
    window.sessionStorage.setItem('iris.web.selectedSessionId', 'session-a');
    let sessionA = sessionSnapshot('session-a', projectA.id);
    const sessionB = sessionSnapshot('session-b', projectB.id);
    const sensitiveDiagnostic = 'provider failed api_key=secret internal_path=/private/example';

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (url === '/health') return jsonResponse(health);
      if (url === '/projects') return jsonResponse({ projects: [projectA, projectB], defaultProjectId: projectA.id });
      if (url === '/permissions') return jsonResponse(permissionSnapshot([]));
      if (url === '/sessions' && method === 'GET') return jsonResponse({ sessions: [sessionA, sessionB] });
      if (url === '/sessions/session-a/instructions' && method === 'POST') {
        const body = JSON.parse(String(init.body)) as { submissionId: string; instruction: string };
        sessionA = failedSession(sessionA, body.submissionId, body.instruction, 'Execution could not be completed.');
        return jsonResponse({ error: { code: 'AGENT_EXECUTION_FAILED', message: 'Agent execution failed' } }, 500);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    await mountApp();
    await settleApp();
    await setInstruction('Fail this A execution');
    await clickButton('Send');
    await settleApp();

    expect(document.body.textContent).toContain('Failed');
    expect(document.querySelector('.conversation')?.textContent).toContain('Execution could not be completed.');
    expect(document.body.textContent).not.toContain(sensitiveDiagnostic);
    expect(document.body.textContent).not.toContain('api_key=secret');
    expect(document.body.textContent).not.toContain('/private/example');
    expect(document.querySelector('[role="alert"]')?.textContent ?? '').not.toContain('Agent execution failed');

    await clickButtonStartingWith('Session 2');
    expect(document.body.textContent).toContain('Ready');
    expect(document.querySelector('.conversation')?.textContent ?? '').not.toContain('Execution could not be completed.');
  });

  it('shows intentional disconnected and no-session states without enabling submission', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/health') return new Response(null, { status: 503 });
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    await mountApp();
    await settleApp();

    expect(document.body.textContent).toContain('Disconnected');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Runtime unavailable');
    expect(document.querySelector('textarea[aria-label="Session instruction"]')).toBeNull();
  });
});

function sessionSnapshot(id: string, currentProjectId: string | null): Session {
  return {
    id,
    clientId: 'web-client',
    agentId: 'owner-web',
    agentRole: 'owner',
    createdAt: '2026-09-05T07:00:00.000Z',
    currentProjectId,
    executionState: 'READY',
    interactions: [],
  };
}

function workingSession(session: Session, submissionId: string, instruction: string): Session {
  return {
    ...session,
    executionState: 'WORKING',
    interactions: [{
      id: `user-${submissionId}`, timestamp: '2026-09-05T07:01:00.000Z', kind: 'user', text: instruction,
      submissionId, executionId: `execution-${submissionId}`,
    }],
  };
}

function completedSession(session: Session, submissionId: string, instruction: string, output: string): Session {
  const user = session.interactions.find((event) => event.submissionId === submissionId && event.kind === 'user') ?? {
    id: `user-${submissionId}`, timestamp: '2026-09-05T07:01:00.000Z', kind: 'user' as const, text: instruction,
    submissionId, executionId: `execution-${submissionId}`,
  };
  return {
    ...session,
    executionState: 'READY',
    interactions: [user, {
      id: `assistant-${submissionId}`, timestamp: '2026-09-05T07:01:01.000Z', kind: 'assistant', text: output,
      submissionId, executionId: `execution-${submissionId}`,
    }],
  };
}

function failedSession(session: Session, submissionId: string, instruction: string, failure: string): Session {
  return {
    ...session,
    executionState: 'FAILED',
    interactions: [
      { id: `user-${submissionId}`, timestamp: '2026-09-05T07:01:00.000Z', kind: 'user', text: instruction, submissionId, executionId: `execution-${submissionId}` },
      { id: `error-${submissionId}`, timestamp: '2026-09-05T07:01:01.000Z', kind: 'error', text: failure, submissionId, executionId: `execution-${submissionId}` },
    ],
  };
}

function permissionSnapshot(pendingApprovals: PendingApproval[]) {
  return {
    mode: 'FULL_LOCAL_OWNER', approvedRoots: ['/Users/bill/iris'], autoApprovedCategories: [], ownerRequiredCategories: [],
    capabilities: [], recentDecisions: [], pendingApprovals,
  };
}

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

async function setInstruction(value: string): Promise<void> {
  const textarea = document.querySelector('textarea[aria-label="Session instruction"]');
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Instruction textarea not found');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('Textarea value setter unavailable');
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickButton(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  await act(async () => button.click());
}

async function clickButtonStartingWith(label: string): Promise<void> {
  await act(async () => buttonStartingWith(label).click());
}

function buttonStartingWith(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim().startsWith(label));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found with prefix: ${label}`);
  return button;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
