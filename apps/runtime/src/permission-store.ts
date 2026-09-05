import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type CapabilityId, type PermissionMode } from '@iris/domain';
import { capabilityDefinition } from './capability-registry.js';
import { inspectPrivateRegularFile } from './private-fs.js';

const PERMISSIONS_FILE = 'permissions.json';

export interface ProjectCapabilityOverride {
  readonly projectId: string;
  readonly capabilityId: CapabilityId;
}

export interface PermissionSettings {
  readonly schemaVersion: 1;
  readonly mode: PermissionMode;
  readonly projectOverrides: readonly ProjectCapabilityOverride[];
}

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'FULL_LOCAL_OWNER';

export class PermissionSettingsStore {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly dataRoot: string) {}

  public async initialize(): Promise<PermissionSettings> {
    const filename = path.join(this.dataRoot, PERMISSIONS_FILE);
    const inspected = await inspectPrivateRegularFile(filename, 'Permission settings');
    if (inspected.state === 'missing') {
      const initial = emptySettings();
      await writePrivateJsonAtomic(filename, initial);
      return initial;
    }
    return this.read();
  }

  public async read(): Promise<PermissionSettings> {
    const inspected = await inspectPrivateRegularFile(path.join(this.dataRoot, PERMISSIONS_FILE), 'Permission settings');
    if (inspected.state === 'missing') throw new RuntimeError('PERSISTENCE_FAILURE', 'Permission settings disappeared after initialization; refusing to infer owner authority');
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      const parsed = JSON.parse(inspected.content) as unknown;
      if (!isPermissionSettings(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Permission settings are invalid');
      return parsed;
    } catch (error: unknown) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Permission settings contain invalid JSON', { cause: error });
    }
  }

  public setMode(mode: PermissionMode): Promise<PermissionSettings> {
    return this.mutate((current) => ({ ...current, mode }));
  }

  public addProjectOverride(projectId: string, capabilityId: CapabilityId): Promise<PermissionSettings> {
    return this.mutate((current) => current.projectOverrides.some((entry) => entry.projectId === projectId && entry.capabilityId === capabilityId)
      ? current
      : { ...current, projectOverrides: [...current.projectOverrides, { projectId, capabilityId }] });
  }

  private async mutate(transform: (current: PermissionSettings) => PermissionSettings): Promise<PermissionSettings> {
    let result!: PermissionSettings;
    const operation = this.mutationTail.then(async () => {
      const next = transform(await this.read());
      if (!isPermissionSettings(next)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to write invalid permission settings');
      await writePrivateJsonAtomic(path.join(this.dataRoot, PERMISSIONS_FILE), next);
      result = next;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }
}

function emptySettings(): PermissionSettings {
  return { schemaVersion: 1, mode: DEFAULT_PERMISSION_MODE, projectOverrides: [] };
}

async function writePrivateJsonAtomic(filename: string, value: unknown): Promise<void> {
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
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Permission settings publication failed', { cause: error });
  }
}

function isPermissionSettings(value: unknown): value is PermissionSettings {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isPermissionMode(value.mode) || !Array.isArray(value.projectOverrides)) return false;
  const keys = new Set<string>();
  for (const override of value.projectOverrides) {
    if (!isRecord(override) || !isUuid(override.projectId) || !isCapabilityId(override.capabilityId)) return false;
    const key = `${override.projectId}:${override.capabilityId}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'ASK_EVERY_TIME'
    || value === 'AUTO_APPROVE_LOW_RISK'
    || value === 'AUTO_APPROVE_PROJECT_SCOPED'
    || value === 'FULL_LOCAL_OWNER';
}

function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === 'string' && capabilityDefinition(value) !== null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
