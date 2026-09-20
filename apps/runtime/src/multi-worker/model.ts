import type {
  OrchestrationRun,
  Worker,
  WorkerAssignment,
  WorkerResult,
  WorkerReview,
  WorkerTask,
} from '@iris/domain';

export interface MultiWorkerDocument {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly runs: readonly OrchestrationRun[];
  readonly workers: readonly Worker[];
  readonly tasks: readonly WorkerTask[];
  readonly assignments: readonly WorkerAssignment[];
  readonly results: readonly WorkerResult[];
  readonly reviews: readonly WorkerReview[];
}

export function emptyMultiWorkerDocument(): MultiWorkerDocument {
  return {
    schemaVersion: 1,
    generation: 0,
    runs: [],
    workers: [],
    tasks: [],
    assignments: [],
    results: [],
    reviews: [],
  };
}

export function replaceRun(
  document: MultiWorkerDocument,
  run: OrchestrationRun,
): MultiWorkerDocument {
  const existing = document.runs.some((entry) => entry.id === run.id);
  return {
    ...document,
    runs: existing
      ? document.runs.map((entry) => entry.id === run.id ? run : entry)
      : [...document.runs, run],
  };
}
