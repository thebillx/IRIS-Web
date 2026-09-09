import { RuntimeError } from '@iris/domain';
import type {
  WorkerAdapter,
  WorkerCheckpointReceipt,
  WorkerStartReceipt,
  WorkerStatusReceipt,
} from './durable-mission-lifecycle.js';

export class WorkerAdapterRegistry {
  private readonly adapters = new Map<string, WorkerAdapter>();

  public constructor(adapters: readonly WorkerAdapter[] = [new LogicalWorkerAdapter()]) {
    for (const adapter of adapters) this.register(adapter);
  }

  public register(adapter: WorkerAdapter): void {
    const workerType = boundedIdentity(adapter.workerType, 'workerType');
    if (this.adapters.has(workerType)) throw new RuntimeError('INVALID_REQUEST', `Worker adapter already registered: ${workerType}`);
    this.adapters.set(workerType, adapter);
  }

  public get(workerTypeInput: string): WorkerAdapter {
    const workerType = boundedIdentity(workerTypeInput, 'workerType');
    const adapter = this.adapters.get(workerType);
    if (adapter === undefined) throw new RuntimeError('CAPABILITY_DENIED', `Worker adapter is not registered: ${workerType}`);
    return adapter;
  }
}

export class LogicalWorkerAdapter implements WorkerAdapter {
  public readonly workerType = 'IRIS_LOGICAL';

  public async start(input: Parameters<WorkerAdapter['start']>[0]): Promise<WorkerStartReceipt> {
    return { workerId: `logical-${input.operationId}`, resumeToken: input.operationId, resumable: true };
  }

  public async checkpoint(input: Parameters<WorkerAdapter['checkpoint']>[0]): Promise<WorkerCheckpointReceipt> {
    return {
      workerStateRef: `logical:${input.binding.workerId}:${input.operationId}`,
      resumeMetadata: { operationId: input.operationId, resumable: input.binding.resumable },
    };
  }

  public async resume(input: Parameters<WorkerAdapter['resume']>[0]): Promise<WorkerStartReceipt> {
    return { workerId: input.binding.workerId, resumeToken: input.binding.resumeToken, resumable: true };
  }

  public async cancel(): Promise<void> {}

  public async status(input: Parameters<WorkerAdapter['status']>[0]): Promise<WorkerStatusReceipt> {
    return {
      state: input.binding.resumable ? 'RESUMABLE' : 'STOPPED',
      workerId: input.binding.workerId,
      resumeToken: input.binding.resumeToken,
      resumable: input.binding.resumable,
    };
  }
}

export function normalizeWorkerStartReceipt(value: WorkerStartReceipt): WorkerStartReceipt {
  return {
    workerId: boundedIdentity(value.workerId, 'workerId'),
    resumeToken: value.resumeToken === null ? null : boundedIdentity(value.resumeToken, 'resumeToken'),
    resumable: strictBoolean(value.resumable, 'resumable'),
  };
}

export function normalizeWorkerCheckpointReceipt(value: WorkerCheckpointReceipt): WorkerCheckpointReceipt {
  if (!isScalarRecord(value.resumeMetadata)) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Worker resume metadata is invalid');
  return {
    workerStateRef: boundedText(value.workerStateRef, 'workerStateRef', 2_048),
    resumeMetadata: { ...value.resumeMetadata },
  };
}

export function normalizeWorkerStatusReceipt(value: WorkerStatusReceipt): WorkerStatusReceipt {
  if (value.state !== 'RUNNING' && value.state !== 'RESUMABLE' && value.state !== 'STOPPED'
    && value.state !== 'FAILED' && value.state !== 'UNKNOWN') {
    throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Worker status is invalid');
  }
  return {
    state: value.state,
    workerId: boundedIdentity(value.workerId, 'workerId'),
    resumeToken: value.resumeToken === null ? null : boundedIdentity(value.resumeToken, 'resumeToken'),
    resumable: strictBoolean(value.resumable, 'resumable'),
  };
}

function boundedIdentity(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200 || normalized.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', `${name} is invalid`);
  }
  return normalized;
}

function boundedText(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max || normalized.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', `${name} is invalid`);
  }
  return normalized;
}

function strictBoolean(value: boolean, name: string): boolean {
  if (typeof value !== 'boolean') throw new RuntimeError('INVALID_REQUEST', `${name} must be boolean`);
  return value;
}

function isScalarRecord(value: unknown): value is Readonly<Record<string, string | number | boolean | null>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length > 24) return false;
  return Object.entries(value).every(([key, item]) => key.length > 0 && key.length <= 120
    && (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
      || (typeof item === 'string' && item.length <= 2_048 && !item.includes('\0'))));
}
