import { randomBytes, randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type ProjectReference } from '@iris/domain';
import { inspectPrivateRegularFile } from './private-fs.js';

const RUNTIME_ID_FILE = 'runtime-id.json';
const STATE_FILE = 'state.json';
const ENDPOINT_FILE = 'endpoint.json';
const CONTROL_FILE = 'control.json';
const OWNER_ACCESS_FILE = 'owner-access.json';

interface RuntimeIdDocument {
  readonly schemaVersion: 1;
  readonly runtimeId: string;
}

export interface FoundationStateDocument {
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
}

export interface RuntimeControlDocument {
  readonly schemaVersion: 1;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly secret: string;
}

export interface OwnerAccessDocument {
  readonly schemaVersion: 1;
  readonly secret: string;
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
    if (concurrent === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime identity was created concurrently but is unreadable');
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
  const inspected = await inspectPrivateRegularFile(filename, 'Runtime identity document');
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  try {
    const parsed = JSON.parse(inspected.content) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isUuid(parsed.runtimeId)) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime identity document is invalid');
    }
    return parsed.runtimeId;
  } catch (error: unknown) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime identity document is invalid JSON', { cause: error });
  }
}

export async function loadOrCreateOwnerAccessSecret(dataRoot: string): Promise<string> {
  const filename = path.join(dataRoot, OWNER_ACCESS_FILE);
  const existing = await readOwnerAccessSecret(dataRoot);
  if (existing !== null) return existing;
  const secret = randomBytes(32).toString('base64url');
  const handle = await open(filename, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return null;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Could not create owner access credential', { cause: error });
  });
  if (handle === null) {
    const concurrent = await readOwnerAccessSecret(dataRoot);
    if (concurrent === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Owner access credential was created concurrently but is unreadable');
    return concurrent;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, secret } satisfies OwnerAccessDocument)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return secret;
}

export async function readOwnerAccessSecret(dataRoot: string): Promise<string | null> {
  const inspected = await inspectPrivateRegularFile(path.join(dataRoot, OWNER_ACCESS_FILE), 'Owner access credential');
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  try {
    const parsed = JSON.parse(inspected.content) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.secret !== 'string' || !isPrivateSecret(parsed.secret)) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Owner access credential is invalid');
    }
    return parsed.secret;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Owner access credential contains invalid JSON', { cause: error });
  }
}

export class FoundationStateStore {
  public constructor(public readonly dataRoot: string) {}

  public async read(): Promise<FoundationStateDocument> {
    const filename = path.join(this.dataRoot, STATE_FILE);
    const inspected = await inspectPrivateRegularFile(filename, 'Project registry');
    if (inspected.state === 'missing') return { schemaVersion: 1, projects: [], defaultProjectId: null };
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      const parsed = JSON.parse(inspected.content) as unknown;
      if (!isStateDocument(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Project registry is invalid');
      return parsed;
    } catch (error: unknown) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Project registry is invalid JSON', { cause: error });
    }
  }

  public async write(state: FoundationStateDocument): Promise<void> {
    if (!isStateDocument(state)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to write invalid project registry');
    await writeJsonAtomic(path.join(this.dataRoot, STATE_FILE), state);
  }
}

export async function writeEndpoint(dataRoot: string, endpoint: EndpointDocument): Promise<void> {
  if (!isEndpointDocument(endpoint)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to publish invalid runtime endpoint metadata');
  await writeJsonAtomic(path.join(dataRoot, ENDPOINT_FILE), endpoint);
}

export async function readEndpoint(dataRoot: string): Promise<EndpointDocument | null> {
  const inspected = await inspectPrivateRegularFile(path.join(dataRoot, ENDPOINT_FILE), 'Runtime endpoint metadata');
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  try {
    const parsed = JSON.parse(inspected.content) as unknown;
    if (!isEndpointDocument(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime endpoint metadata is invalid');
    return parsed;
  } catch (error: unknown) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime endpoint metadata is invalid JSON', { cause: error });
  }
}

export async function removeEndpointIfInstance(dataRoot: string, instanceId: string): Promise<void> {
  const current = await readEndpoint(dataRoot);
  if (current === null) return;
  if (current.instanceId !== instanceId) throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime endpoint identity changed before cleanup');
  await rm(path.join(dataRoot, ENDPOINT_FILE));
}

export async function writeRuntimeControl(dataRoot: string, control: RuntimeControlDocument): Promise<void> {
  if (!isRuntimeControlDocument(control)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to publish invalid runtime control metadata');
  await writeJsonAtomic(path.join(dataRoot, CONTROL_FILE), control);
}

export async function readRuntimeControl(dataRoot: string): Promise<RuntimeControlDocument | null> {
  const inspected = await inspectPrivateRegularFile(path.join(dataRoot, CONTROL_FILE), 'Runtime control metadata');
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  try {
    const parsed = JSON.parse(inspected.content) as unknown;
    if (!isRuntimeControlDocument(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime control metadata is invalid');
    return parsed;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Runtime control metadata is unreadable', { cause: error });
  }
}

export async function removeRuntimeControlIfInstance(dataRoot: string, instanceId: string): Promise<void> {
  const current = await readRuntimeControl(dataRoot);
  if (current === null) return;
  if (current.instanceId !== instanceId) throw new RuntimeError('AUTHORITY_CHANGED', 'Runtime control identity changed before cleanup');
  await rm(path.join(dataRoot, CONTROL_FILE));
}

async function writeJsonAtomic(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Atomic state publication failed', { cause: error });
  }
}

function isStateDocument(value: unknown): value is FoundationStateDocument {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.projects)
    || !value.projects.every(isProjectReference)
    || (value.defaultProjectId !== null && typeof value.defaultProjectId !== 'string')) return false;
  const projects = value.projects as ProjectReference[];
  const ids = new Set(projects.map((project) => project.id));
  const roots = new Set(projects.map((project) => project.rootPath));
  return ids.size === projects.length
    && roots.size === projects.length
    && (value.defaultProjectId === null || ids.has(value.defaultProjectId));
}

function isProjectReference(value: unknown): value is ProjectReference {
  return isRecord(value)
    && isUuid(value.id)
    && typeof value.name === 'string'
    && value.name.length > 0
    && value.name.length <= 120
    && value.name === value.name.trim()
    && typeof value.rootPath === 'string'
    && path.isAbsolute(value.rootPath)
    && !value.rootPath.includes('\0')
    && path.normalize(path.resolve(value.rootPath)) === value.rootPath;
}

function isEndpointDocument(value: unknown): value is EndpointDocument {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isUuid(value.runtimeId)
    || !isUuid(value.instanceId)
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.startedAt !== 'string'
    || !Number.isFinite(Date.parse(value.startedAt))
    || typeof value.apiUrl !== 'string'
    || typeof value.mcpUrl !== 'string') return false;
  try {
    const api = new URL(value.apiUrl);
    const mcp = new URL(value.mcpUrl);
    return isSafeLoopbackUrl(api, '/')
      && isSafeLoopbackUrl(mcp, '/mcp')
      && api.origin === mcp.origin;
  } catch {
    return false;
  }
}

function isRuntimeControlDocument(value: unknown): value is RuntimeControlDocument {
  return isRecord(value)
    && value.schemaVersion === 1
    && isUuid(value.runtimeId)
    && isUuid(value.instanceId)
    && typeof value.secret === 'string'
    && isPrivateSecret(value.secret);
}

function isPrivateSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,128}$/.test(value);
}

function isSafeLoopbackUrl(url: URL, pathname: string): boolean {
  return url.protocol === 'http:'
    && url.hostname === '127.0.0.1'
    && url.username === ''
    && url.password === ''
    && url.pathname === pathname
    && url.search === ''
    && url.hash === '';
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
