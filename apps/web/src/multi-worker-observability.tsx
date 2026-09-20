import type { ReactElement } from 'react';

export type MultiWorkerObservability = {
  schemaVersion: 1;
  generatedAt: string;
  run: {
    id: string;
    missionId: string;
    projectId: string;
    state: string;
    revision: number;
    elapsedMs: number;
    taskCount: number;
    workerCount: number;
    activeAssignmentCount: number;
    resultCount: number;
    reviewCount: number;
  };
  tasks: Array<{
    id: string;
    title: string;
    state: string;
    dependencyTaskIds: string[];
    blockingReason: string | null;
    elapsedMs: number;
    workspaceId: string;
    worker: null | {
      id: string;
      role: string;
      workerType: string;
      state: string;
      adapterWorkerId: string | null;
      resumable: boolean;
    };
    assignment: null | {
      id: string;
      active: boolean;
      assignedAt: string;
      releasedAt: string | null;
    };
    activeExecution: null | {
      adapterWorkerId: string | null;
      capabilityId: null;
      jobId: null;
    };
    result: null | {
      id: string;
      status: string;
      summary: string;
      evidenceRefs: string[];
      artifactIds: string[];
      filesReadCount: number;
      filesChangedCount: number;
      commandsExecutedCount: number;
      validationResults: Array<{ name: string; status: string; summary: string }>;
      risks: string[];
      blockers: string[];
      recommendedNextActions: string[];
      createdAt: string;
    };
    review: null | {
      id: string;
      decision: string;
      instruction: string;
      requestedEvidence: string[];
      reviewedByOrchestratorId: string;
      basedOnRunRevision: number;
      createdAt: string;
    };
  }>;
};

export function MultiWorkerObservabilityPanel(props: {
  observability: MultiWorkerObservability | null;
  missionTitle: string;
}): ReactElement | null {
  const view = props.observability;
  if (view === null) return null;

  return <section className="mission-checkpoint multi-worker-observability" aria-label={'Multi-worker orchestration for ' + props.missionTitle}>
    <div className="section-title-row">
      <strong>Multi-worker orchestration</strong>
      <span>{view.run.state}</span>
    </div>
    <div className="mission-meta broker-meta">
      <div><span>Run revision</span><strong>{view.run.revision}</strong></div>
      <div><span>Workers</span><strong>{view.run.workerCount}</strong></div>
      <div><span>Tasks</span><strong>{view.run.taskCount}</strong></div>
      <div><span>Active assignments</span><strong>{view.run.activeAssignmentCount}</strong></div>
      <div><span>Results</span><strong>{view.run.resultCount}</strong></div>
      <div><span>Reviews</span><strong>{view.run.reviewCount}</strong></div>
      <div><span>Elapsed</span><strong>{formatDuration(view.run.elapsedMs)}</strong></div>
    </div>

    <div className="mission-tasks" aria-label="Multi-worker task tree">
      {view.tasks.map((task) => <article key={task.id}>
        <header><strong>{task.title}</strong><span>{task.state}</span></header>
        <p>
          <strong>Worker:</strong> {task.worker === null ? 'Not assigned' : task.worker.role + ' · ' + task.worker.workerType + ' · ' + task.worker.state}
          {' · '}<strong>Elapsed:</strong> {formatDuration(task.elapsedMs)}
        </p>
        {task.dependencyTaskIds.length > 0 ? <p><strong>Dependencies:</strong> {task.dependencyTaskIds.length}</p> : null}
        {task.blockingReason === null ? null : <p><strong>Waiting/block reason:</strong> {task.blockingReason}</p>}
        {task.activeExecution !== null ? <p>
          <strong>Active execution:</strong> worker {task.activeExecution.adapterWorkerId ?? 'logical/unbound'}
          {' · '}capability/job correlation {task.activeExecution.capabilityId === null && task.activeExecution.jobId === null ? 'not currently recorded' : 'recorded'}
        </p> : null}
        {task.result !== null ? <div>
          <p><strong>Result:</strong> {task.result.status} · {task.result.summary}</p>
          <p><strong>Evidence:</strong> {task.result.evidenceRefs.length} refs · {task.result.artifactIds.length} artifacts · {task.result.filesReadCount} files read · {task.result.filesChangedCount} files changed · {task.result.commandsExecutedCount} governed commands</p>
          {task.result.validationResults.length > 0 ? <ul>{task.result.validationResults.map((validation, index) => <li key={(task.result?.id ?? task.id) + '-validation-' + String(index)}>
            <strong>{validation.name}</strong> · {validation.status} · {validation.summary}
          </li>)}</ul> : null}
          {task.result.blockers.length > 0 ? <p><strong>Blockers:</strong> {task.result.blockers.join(' · ')}</p> : null}
          {task.result.risks.length > 0 ? <p><strong>Risks:</strong> {task.result.risks.join(' · ')}</p> : null}
        </div> : null}
        {task.review !== null ? <p><strong>Orchestrator review:</strong> {task.review.decision} · {task.review.instruction}</p> : null}
      </article>)}
    </div>
    <p className="mission-help">This panel is read-only. It displays daemon-projected worker state and does not grant capability, job, or mutation authority.</p>
  </section>;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return String(seconds) + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return String(minutes) + 'm ' + String(seconds % 60) + 's';
  const hours = Math.floor(minutes / 60);
  return String(hours) + 'h ' + String(minutes % 60) + 'm';
}
