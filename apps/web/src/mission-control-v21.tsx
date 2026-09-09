import type { ReactElement } from 'react';

export type V21MissionLifecycleState =
  | 'CREATED'
  | 'READY'
  | 'RUNNING'
  | 'CHECKPOINTED'
  | 'WAITING_FOR_SUPERVISOR'
  | 'RESUMING'
  | 'VALIDATING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type V21MissionLifecycle = {
  missionId: string;
  projectId: string;
  title: string;
  goal: string;
  state: V21MissionLifecycleState;
  revision: number;
  workerBinding: {
    workerType: string;
    workerId: string;
    resumeToken: string | null;
    missionId: string;
    projectId: string;
    createdAt: string;
    lastSeenAt: string;
    resumable: boolean;
  } | null;
  checkpoints: Array<{
    checkpointId: string;
    missionId: string;
    projectId: string;
    sequence: number;
    revision: number;
    workerStateRef: string;
    summary: string;
    evidenceRefs: string[];
    createdAt: string;
    resumeMetadata: Record<string, string | number | boolean | null>;
  }>;
  directives: Array<{
    directiveId: string;
    missionId: string;
    projectId: string;
    basedOnRevision: number;
    directive: string;
    createdAt: string;
    appliedAt: string | null;
    status: 'ACCEPTED' | 'APPLIED';
  }>;
  evidence: Array<{
    id: string;
    kind: string;
    label: string;
    summary: string;
    reference: string | null;
    data: Record<string, string | number | boolean | null>;
  }>;
  createdAt: string;
  updatedAt: string;
};

export function V21MissionLifecyclePanel(props: {
  lifecycle: V21MissionLifecycle | null;
  missionTitle: string;
  onResume(): void;
  onCancel(): void;
}): ReactElement | null {
  const lifecycle = props.lifecycle;
  if (lifecycle === null) return null;

  const latestCheckpoint = lifecycle.checkpoints.at(-1) ?? null;
  const latestDirective = lifecycle.directives.at(-1) ?? null;
  const hasAcceptedDirective = lifecycle.directives.some((directive) => directive.status === 'ACCEPTED');
  const canResume = (lifecycle.state === 'WAITING_FOR_SUPERVISOR' || lifecycle.state === 'CHECKPOINTED')
    && lifecycle.checkpoints.length > 0
    && hasAcceptedDirective;
  const canCancel = lifecycle.state !== 'COMPLETED' && lifecycle.state !== 'FAILED' && lifecycle.state !== 'CANCELLED';

  return <section className="mission-checkpoint" aria-label={`V2.1 lifecycle for ${props.missionTitle}`}>
    <div className="section-title-row">
      <strong>V2.1 durable lifecycle</strong>
      <span>{lifecycle.state}</span>
    </div>
    <div className="mission-meta broker-meta">
      <div><span>Lifecycle state</span><strong>{lifecycle.state}</strong></div>
      <div><span>Revision</span><strong>{lifecycle.revision}</strong></div>
      <div><span>Worker</span><strong>{lifecycle.workerBinding?.workerType ?? 'Not bound'}</strong></div>
      <div><span>Resumable</span><strong>{lifecycle.workerBinding?.resumable ? 'Yes' : 'No'}</strong></div>
    </div>
    {lifecycle.workerBinding !== null ? <p><strong>Worker ID:</strong> {lifecycle.workerBinding.workerId}</p> : null}
    <p><strong>Goal:</strong> {lifecycle.goal}</p>

    {latestCheckpoint !== null ? <div aria-label="Latest V2.1 checkpoint">
      <p><strong>Checkpoint #{latestCheckpoint.sequence} · revision {latestCheckpoint.revision}:</strong> {latestCheckpoint.summary}</p>
      <p><strong>Worker state:</strong> {latestCheckpoint.workerStateRef}</p>
      {latestCheckpoint.evidenceRefs.length > 0 ? <p><strong>Checkpoint evidence:</strong> {latestCheckpoint.evidenceRefs.join(' · ')}</p> : null}
    </div> : null}

    {latestDirective !== null ? <p className="mission-last-directive">
      <strong>Latest V2.1 directive:</strong> {latestDirective.status} · based on revision {latestDirective.basedOnRevision} · {latestDirective.directive}
    </p> : null}

    <div aria-label="V2.1 durable evidence">
      <strong>Durable evidence ({lifecycle.evidence.length})</strong>
      {lifecycle.evidence.length === 0 ? <p>No durable V2.1 evidence recorded.</p> : <ul>{lifecycle.evidence.map((evidence) => <li key={evidence.id}>
        <strong>{evidence.label}</strong> · {evidence.summary}{evidence.reference === null ? '' : ` · ${evidence.reference}`}
      </li>)}</ul>}
    </div>

    <div className="composer-actions">
      <span>Lifecycle controls submit only revision-bound owner API requests; they do not grant execution authority.</span>
      <button type="button" disabled={!canResume} onClick={props.onResume}>Resume mission</button>
      <button type="button" className="danger-button" disabled={!canCancel} onClick={props.onCancel}>Cancel mission</button>
    </div>
  </section>;
}
