/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MultiWorkerObservabilityPanel, type MultiWorkerObservability } from './multi-worker-observability.js';

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => root?.unmount());
    root = undefined;
  }
});

describe('M10 multi-worker Mission Control observability', () => {
  it('renders daemon-projected run/task/worker/result/review state as a read-only tree', async () => {
    const container = document.getElementById('root');
    if (container === null) throw new Error('Missing root');
    root = createRoot(container);
    await act(async () => root?.render(createElement(MultiWorkerObservabilityPanel, {
      observability: fixture(),
      missionTitle: 'Multi-worker mission',
    })));

    const panel = document.querySelector('section[aria-label="Multi-worker orchestration for Multi-worker mission"]');
    if (!(panel instanceof HTMLElement)) throw new Error('Panel not found');
    expect(panel.textContent).toContain('Multi-worker orchestration');
    expect(panel.textContent).toContain('RUNNING');
    expect(panel.textContent).toContain('Workers2');
    expect(panel.textContent).toContain('Tasks2');
    expect(panel.textContent).toContain('CODE · IRIS_LOGICAL · RUNNING');
    expect(panel.textContent).toContain('capability/job correlation not currently recorded');
    expect(panel.textContent).toContain('Waiting/block reason: Waiting for 1 dependency');
    expect(panel.textContent).toContain('Result: SUCCEEDED · Safe reviewed summary');
    expect(panel.textContent).toContain('Orchestrator review: ACCEPT · Accepted by orchestrator');
    expect(panel.textContent).toContain('read-only');
    expect(panel.querySelectorAll('button')).toHaveLength(0);
    expect(panel.querySelectorAll('input, textarea, select')).toHaveLength(0);
  });
});

function fixture(): MultiWorkerObservability {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-20T02:00:00.000Z',
    run: {
      id: 'run-1',
      missionId: 'mission-1',
      projectId: 'project-1',
      state: 'RUNNING',
      revision: 8,
      elapsedMs: 3_661_000,
      taskCount: 2,
      workerCount: 2,
      activeAssignmentCount: 1,
      resultCount: 1,
      reviewCount: 1,
    },
    tasks: [
      {
        id: 'task-running',
        title: 'Code worker',
        state: 'RUNNING',
        dependencyTaskIds: [],
        blockingReason: null,
        elapsedMs: 61_000,
        workspaceId: 'workspace-1',
        worker: {
          id: 'worker-1',
          role: 'CODE',
          workerType: 'IRIS_LOGICAL',
          state: 'RUNNING',
          adapterWorkerId: 'logical-1',
          resumable: true,
        },
        assignment: {
          id: 'assignment-1',
          active: true,
          assignedAt: '2026-09-20T01:59:00.000Z',
          releasedAt: null,
        },
        activeExecution: {
          adapterWorkerId: 'logical-1',
          capabilityId: null,
          jobId: null,
        },
        result: null,
        review: null,
      },
      {
        id: 'task-waiting',
        title: 'QA worker',
        state: 'WAITING',
        dependencyTaskIds: ['task-running'],
        blockingReason: 'Waiting for 1 dependency',
        elapsedMs: 30_000,
        workspaceId: 'workspace-1',
        worker: {
          id: 'worker-2',
          role: 'QA',
          workerType: 'IRIS_LOGICAL',
          state: 'SUCCEEDED',
          adapterWorkerId: 'logical-2',
          resumable: false,
        },
        assignment: {
          id: 'assignment-2',
          active: false,
          assignedAt: '2026-09-20T01:58:00.000Z',
          releasedAt: '2026-09-20T01:59:00.000Z',
        },
        activeExecution: null,
        result: {
          id: 'result-2',
          status: 'SUCCEEDED',
          summary: 'Safe reviewed summary',
          evidenceRefs: ['evidence-1'],
          artifactIds: ['artifact-1'],
          filesReadCount: 3,
          filesChangedCount: 0,
          commandsExecutedCount: 1,
          validationResults: [{ name: 'focused', status: 'PASSED', summary: 'Validation passed' }],
          risks: [],
          blockers: [],
          recommendedNextActions: [],
          createdAt: '2026-09-20T01:59:00.000Z',
        },
        review: {
          id: 'review-2',
          decision: 'ACCEPT',
          instruction: 'Accepted by orchestrator',
          requestedEvidence: [],
          reviewedByOrchestratorId: 'chatgpt-orchestrator',
          basedOnRunRevision: 7,
          createdAt: '2026-09-20T01:59:30.000Z',
        },
      },
    ],
  };
}
