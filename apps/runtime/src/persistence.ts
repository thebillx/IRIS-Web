import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type ProjectReference } from '@iris/domain';

const RUNTIME_ID_FILE = 'runtime-id.json';
const STATE_FILE = 'state.json';
const ENDPOINT_FILE = 'endpoint.json';

interface RuntimeIdDocument {
  readonly schemaVersion: 1;
  readonly runtimeId: string;
}

export interface StateDocument {
  readonly schemaVersion: 1;
  readonly projects: readonly ProjectReference[];
  readonly defaultProjectId: string | null;
}

export interface EndpointDocument {
  readonly schemaVersion: 1;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly apiUrl: string;
  readonly mcpUrl: string;
  readonly startedAt: string;
  readonly controlToken: string;
}

interface StateMutation<T> {
  readonly state: StateDocument;
  readonly result: T;
}

export async function loadOrCreateRuntimeId(dataRoot: string): Promise<string> {
  const filename = path.join(dataRoot, RUNTIME_ID_FILE);
  const existing = await readRuntimeId(filename);
  if (existing !== null) return existing;

  const runtimeId = randomUUID();
  const handle = await open(filename, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return null;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Could not create runtime identity', { cause: error });
  });
  if (handle === null) {
    const concurrent = await readRuntimeId(filename);
    if (concurrent === null) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime identity was created concurrently but is unreadable');
    }
    return concurrent;
  }

  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, runtimeId } satisfies RuntimeIdDocument)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return runtimeId;
}

async function readRuntimeId(filename: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(filename, 'utf8')) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.runtimeId !== 'string' || parsed.runtimeId.length < 8) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime identity document is invalid');
    }
    return parsed.runtimeId;
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime identity document is unreadable', { cause: error });
  }
}

export class FoundationStateStore {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly dataRoot: string) {}

  public async read(): Promise<StateDocument> {
    const filename = path.join(this.dataRoot, STATE_FILE);
    try {
      const parsed = JSON.parse(await readFile(filename, 'utf8')) as unknown;
      if (!isStateDocument(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Project registry is invalid');
      return parsed;
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Project registry is unreadable', { cause: error });
      }
      return emptyState();
    }
  }

  public async write(state: StateDocument): Promise<void> {
    await this.transact(() => ({ state, result: undefined }));
  }

  public async transact<T>(mutator: (current: StateDocument) => StateMutation<T> | Promise<StateMutation<T>>): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const current = await this.read();
      const mutation = await mutator(current);
      if (!isStateDocument(mutation.state)) {
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to write invalid project registry');
      }
      await writeJsonAtomic(path.join(this.dataRoot, STATE_FILE), mutation.state);
      return mutation.result;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export async function writeEndpoint(dataRoot: string, endpoint: EndpointDocument): Promise<void> {
  if (!isEndpointDocument(endpoint)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to publish invalid endpoint metadata');
  await writeJsonAtomic(path.join(dataRoot, ENDPOINT_FILE), endpoint);
}

export async function readEndpoint(dataRoot: string): Promise<EndpointDocument | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dataRoot, ENDPOINT_FILE), 'utf8')) as unknown;
    return isEndpointDocument(parsed) ? parsed : null;
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    return null;
  }
}

export async function removeEndpointIfInstance(dataRoot: string, instanceId: string): Promise<void> {
  const current = await readEndpoint(dataRoot);
  if (current?.instanceId !== instanceId) return;
  await rm(path.join(dataRoot, ENDPOINT_FILE), { force: true });
}

async function writeJsonAtomic(filename: string, value: unknown): Promise<void> {
  const temp = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, filename);
  } catch (error) {
    await rm(temp, { force: true });
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Atomic state publication failed', { cause: error });
  }
}

function emptyState(): StateDocument {
  return { schemaVersion: 1, projects: [], defaultProjectId: null };
}

function isStateDocument(value: unknown): value is StateDocument {
  return isRecord(value)
    && value.schemaVersion === 1
    && Array.isArray(value.projects)
    && value.projects.every(isProjectReference)
    && (value.defaultProjectId === null || typeof value.defaultProjectId === 'string')
    && (value.defaultProjectId === null || value.projects.some((project) => isProjectReference(project) && project.id === value.defaultProjectId));
}

function isProjectReference(value: unknown): value is ProjectReference {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.rootPath === 'string'
    && path.isAbsolute(value.rootPath);
}

function isEndpointDocument(value: unknown): value is EndpointDocument {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.runtimeId === 'string'
    && value.runtimeId.length >= 8
    && typeof value.instanceId === 'string'
    && value.instanceId.length >= 8
    && Number.isSafeInteger(value.pid)
    && (value.pid as number) > 0
    && isLoopbackUrl(value.apiUrl)
    && isLoopbackUrl(value.mcpUrl)
    && typeof value.startedAt === 'string'
    && Number.isFinite(Date.parse(value.startedAt))
    && typeof value.controlToken === 'string'
    && value.controlToken.length >= 32;
}

function isLoopbackUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
