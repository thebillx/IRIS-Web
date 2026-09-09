/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { V21MissionLifecycle } from './mission-control-v21.js';

const ownerToken = 'v'.repeat(48);
const project = { id: 'project-iris', name: 'IRIS', rootPath: '/Users/bill/iris' };
const health = {
  status: 'ready', runtimeId: 'runtime', instanceId: 'instance', pid: 123, uptimeMs: 60_000,
  authority: 'owned', connectedClients: 1, connectedSessions: 0,
  agentExecutorType: 'local-development-executor' as const, productionModelConnected: false,
  apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
};

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.sessionStorage.clear();
  window.sessionStorage.setItem('iris.web.clientId', 'web-v21-client');
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

describe('V2.1 Mission Control acceptance', () => {
  it('shows durable lifecycle data and submits only revision-bound owner resume/cancel actions with authoritative refresh', async () => {
    let lifecycle = lifecycleSnapshot('WAITING_FOR_SUPERVISOR', 6, [evidence('evidence-1', 'Checkpoint proof', 'Initial durable proof')]);
    const actionCalls: Array<{ action: string; expectedRevision: number; requestId: string; authorization: string | null }> = [];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      if (url === '/health') return jsonResponse(health);
      if (url === '/projects') return jsonResponse({ projects: [project], defaultProjectId: project.id });
      if (url === '/sessions' && method === 'GET') return jsonResponse({ sessions: [] });
      if (url === '/permissions') return jsonResponse(permissionSnapshot());
      if (url === '/missions' && method === 'GET') return jsonResponse({ missions: [missionSnapshot(lifecycle)] });
      if (url === '/missions/mission-v21/lifecycle/resume' && method === 'POST') {
        const body = JSON.parse(String(init.body)) as { expectedRevision: number; requestId: string };
        actionCalls.push({ action: 'resume', expectedRevision: body.expectedRevision, requestId: body.requestId, authorization: headers.get('authorization') });
        lifecycle = {
          ...lifecycle,
          state: 'RUNNING',
          revision: 8,
          directives: lifecycle.directives.map((directive) => ({ ...directive, status: 'APPLIED' as const, appliedAt: '2026-09-08T15:01:00.000Z' })),
          evidence: [...lifecycle.evidence, evidence('evidence-2', 'Resume proof', 'Authoritative resume evidence')],
          updatedAt: '2026-09-08T15:01:00.000Z',
        };
        return jsonResponse(lifecycle);
      }
      if (url === '/missions/mission-v21/lifecycle/cancel' && method === 'POST') {
        const body = JSON.parse(String(init.body)) as { expectedRevision: number; requestId: string };
        actionCalls.push({ action: 'cancel', expectedRevision: body.expectedRevision, requestId: body.requestId, authorization: headers.get('authorization') });
        lifecycle = { ...lifecycle, state: 'CANCELLED', revision: 10, updatedAt: '2026-09-08T15:02:00.000Z' };
        return jsonResponse(lifecycle);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    await mountApp();
    await settleApp();

    const panel = lifecyclePanel();
    expect(panel.textContent).toContain('WAITING_FOR_SUPERVISOR');
    expect(panel.textContent).toContain('Revision6');
    expect(panel.textContent).toContain('IRIS_LOGICAL');
    expect(panel.textContent).toContain('Durable checkpoint before supervisor review.');
    expect(panel.textContent).toContain('checkpoint-evidence:pass');
    expect(panel.textContent).toContain('ACCEPTED');
    expect(panel.textContent).toContain('Continue from the durable checkpoint.');
    expect(panel.textContent).toContain('Checkpoint proof');
    expect(panel.textContent).toContain('Initial durable proof');
    expect([...panel.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(['Resume mission', 'Cancel mission']);
    expect(panel.textContent).not.toContain('Start mission');
    expect(panel.textContent).not.toContain('Execute command');

    await clickButton('Resume mission');
    await settleApp();

    expect(actionCalls[0]).toMatchObject({ action: 'resume', expectedRevision: 6, authorization: `Bearer ${ownerToken}` });
    expect(actionCalls[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(lifecyclePanel().textContent).toContain('RUNNING');
    expect(lifecyclePanel().textContent).toContain('Revision8');
    expect(lifecyclePanel().textContent).toContain('Resume proof');
    expect(lifecyclePanel().textContent).toContain('Authoritative resume evidence');
    expect(button('Resume mission').disabled).toBe(true);
    expect(button('Cancel mission').disabled).toBe(false);

    await clickButton('Cancel mission');
    await settleApp();

    expect(actionCalls[1]).toMatchObject({ action: 'cancel', expectedRevision: 8, authorization: `Bearer ${ownerToken}` });
    expect(actionCalls[1]?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(lifecyclePanel().textContent).toContain('CANCELLED');
    expect(lifecyclePanel().textContent).toContain('Revision10');
    expect(button('Resume mission').disabled).toBe(true);
    expect(button('Cancel mission').disabled).toBe(true);
  });
});

function lifecycleSnapshot(
  state: V21MissionLifecycle['state'],
  revision: number,
  durableEvidence: V21MissionLifecycle['evidence'],
): V21MissionLifecycle {
  return {
    missionId: 'mission-v21',
    projectId: project.id,
    title: 'IRIS V2.1 UI mission',
    goal: 'Show lifecycle truth without granting authority.',
    state,
    revision,
    workerBinding: {
      workerType: 'IRIS_LOGICAL', workerId: 'logical-worker-1', resumeToken: 'resume-token-1',
      missionId: 'mission-v21', projectId: project.id,
      createdAt: '2026-09-08T15:00:00.000Z', lastSeenAt: '2026-09-08T15:00:00.000Z', resumable: true,
    },
    checkpoints: [{
      checkpointId: 'checkpoint-v21', missionId: 'mission-v21', projectId: project.id,
      sequence: 1, revision: 5, workerStateRef: 'logical:state:5',
      summary: 'Durable checkpoint before supervisor review.', evidenceRefs: ['checkpoint-evidence:pass'],
      createdAt: '2026-09-08T15:00:00.000Z', resumeMetadata: { resumable: true },
    }],
    directives: [{
      directiveId: 'directive-v21', missionId: 'mission-v21', projectId: project.id,
      basedOnRevision: 5, directive: 'Continue from the durable checkpoint.',
      createdAt: '2026-09-08T15:00:30.000Z', appliedAt: null, status: 'ACCEPTED',
    }],
    evidence: durableEvidence,
    createdAt: '2026-09-08T15:00:00.000Z',
    updatedAt: '2026-09-08T15:00:30.000Z',
  };
}

function missionSnapshot(lifecycle: V21MissionLifecycle) {
  return {
    id: 'mission-v21', title: 'IRIS V2.1 UI mission', state: 'WAITING_SUPERVISOR',
    orchestratorMode: 'CHATGPT', orchestratorVersion: 1,
    lastOrchestratorHandoff: null, orchestratorHandoff: { safe: true, reason: 'Safe to hand off.' },
    clientId: 'web-v21-client', sessionId: 'session-v21', projectId: project.id,
    createdAt: '2026-09-08T15:00:00.000Z', updatedAt: lifecycle.updatedAt,
    supervisorGate: { state: 'PENDING', reason: 'Awaiting owner push approval.', updatedAt: '2026-09-08T15:00:00.000Z' },
    tasks: [], timeline: [], broker: null, lifecycle,
  };
}

function evidence(id: string, label: string, summary: string): V21MissionLifecycle['evidence'][number] {
  return { id, kind: 'OBSERVATION', label, summary, reference: `v21:${id}`, data: { passed: true } };
}

function permissionSnapshot() {
  return {
    mode: 'FULL_LOCAL_OWNER', approvedRoots: ['/Users/bill/iris'], autoApprovedCategories: [], ownerRequiredCategories: [],
    capabilities: [], recentDecisions: [], pendingApprovals: [],
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

function lifecyclePanel(): HTMLElement {
  const panel = document.querySelector('section[aria-label="V2.1 lifecycle for IRIS V2.1 UI mission"]');
  if (!(panel instanceof HTMLElement)) throw new Error('V2.1 lifecycle panel not found');
  return panel;
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return match;
}

async function clickButton(label: string): Promise<void> {
  await act(async () => button(label).click());
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
