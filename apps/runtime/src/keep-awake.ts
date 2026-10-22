import { access } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { writePrivateJsonAtomic } from './credentials.js';
import { inspectPrivateRegularFile } from './private-fs.js';

export type KeepAwakeObservedState = 'UNAVAILABLE' | 'OFF' | 'ACTIVE';

export interface KeepAwakeProviderSession {
  readonly providerSessionId: string;
}

export interface KeepAwakeProvider {
  readonly id: string;
  probe(): Promise<{ readonly supported: boolean; readonly reason?: string }>;
  start(): Promise<KeepAwakeProviderSession>;
  stop(session: KeepAwakeProviderSession): Promise<void>;
  observe(session: KeepAwakeProviderSession): Promise<boolean>;
}

export interface KeepAwakeSnapshot {
  readonly requested: boolean;
  readonly leaseCount: number;
  readonly observed: KeepAwakeObservedState;
  readonly providerId: string;
  readonly providerSessionId: string | null;
}

export interface KeepAwakeLease {
  readonly id: string;
  readonly owner: string;
  release(): Promise<void>;
}

const KEEP_AWAKE_PREFERENCE_FILE = 'keep-awake.json';

export interface KeepAwakePreference {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

/** Persists the Owner preference separately from provider sessions and leases. */
export class KeepAwakePreferenceStore {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly dataRoot: string) {}

  public async initialize(): Promise<KeepAwakePreference> {
    const filename = this.filename();
    const inspected = await inspectPrivateRegularFile(filename, 'Keep-awake preference');
    if (inspected.state === 'missing') {
      const initial = emptyKeepAwakePreference();
      await writePrivateJsonAtomic(filename, initial);
      return initial;
    }
    return this.read();
  }

  public async read(): Promise<KeepAwakePreference> {
    const inspected = await inspectPrivateRegularFile(this.filename(), 'Keep-awake preference');
    if (inspected.state === 'missing') throw new RuntimeError('PERSISTENCE_FAILURE', 'Keep-awake preference disappeared after initialization');
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      const parsed = JSON.parse(inspected.content) as unknown;
      if (!isKeepAwakePreference(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Keep-awake preference is invalid');
      return parsed;
    } catch (error: unknown) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Keep-awake preference contains invalid JSON', { cause: error });
    }
  }

  public setEnabled(enabled: boolean): Promise<KeepAwakePreference> {
    let result!: KeepAwakePreference;
    const operation = this.mutationTail.then(async () => {
      const current = await this.read();
      result = { schemaVersion: 1, enabled, updatedAt: new Date().toISOString() };
      if (current.enabled === enabled) result = current;
      await writePrivateJsonAtomic(this.filename(), result);
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation.then(() => result);
  }

  private filename(): string { return path.join(this.dataRoot, KEEP_AWAKE_PREFERENCE_FILE); }
}

/**
 * Owns only provider sessions created by this manager. It never discovers or
 * terminates a user's pre-existing Amphetamine/caffeinate process.
 */
export class KeepAwakeLeaseManager {
  private readonly leases = new Map<string, string>();
  private providerSession: KeepAwakeProviderSession | null = null;
  private observed: KeepAwakeObservedState = 'OFF';
  private mutation: Promise<void> = Promise.resolve();

  public constructor(private readonly provider: KeepAwakeProvider) {}

  public async request(owner: string): Promise<KeepAwakeLease> {
    if (owner.trim().length === 0) throw new RuntimeError('INVALID_REQUEST', 'Keep-awake lease owner is required');
    let lease!: KeepAwakeLease;
    await this.serial(async () => {
      const capability = await this.provider.probe();
      if (!capability.supported) {
        this.observed = 'UNAVAILABLE';
        throw new RuntimeError('CAPABILITY_DENIED', capability.reason ?? 'Keep-awake provider is unavailable');
      }
      if (this.providerSession !== null && !await this.provider.observe(this.providerSession)) {
        this.providerSession = null;
        this.observed = 'OFF';
      }
      if (this.providerSession === null) {
        this.providerSession = await this.provider.start();
        this.observed = 'ACTIVE';
      }
      const id = randomUUID();
      this.leases.set(id, owner);
      lease = { id, owner, release: () => this.release(id) };
    });
    return lease;
  }

  public async release(id: string): Promise<void> {
    await this.serial(async () => {
      if (!this.leases.delete(id)) return;
      if (this.leases.size > 0 || this.providerSession === null) return;
      const session = this.providerSession;
      await this.provider.stop(session);
      this.providerSession = null;
      this.observed = 'OFF';
    });
  }

  public async releaseAll(): Promise<void> {
    await this.serial(async () => {
      this.leases.clear();
      if (this.providerSession === null) {
        this.observed = 'OFF';
        return;
      }
      const session = this.providerSession;
      await this.provider.stop(session);
      this.providerSession = null;
      this.observed = 'OFF';
    });
  }

  public async snapshot(): Promise<KeepAwakeSnapshot> {
    let result!: KeepAwakeSnapshot;
    await this.serial(async () => {
      if (this.providerSession !== null) {
        const alive = await this.provider.observe(this.providerSession);
        this.observed = alive ? 'ACTIVE' : 'OFF';
      }
      result = {
        requested: this.leases.size > 0,
        leaseCount: this.leases.size,
        observed: this.observed,
        providerId: this.provider.id,
        providerSessionId: this.providerSession?.providerSessionId ?? null,
      };
    });
    return result;
  }

  private async serial(operation: () => Promise<void>): Promise<void> {
    const previous = this.mutation;
    let complete!: () => void;
    this.mutation = new Promise<void>((resolve) => { complete = resolve; });
    await previous;
    try { await operation(); } finally { complete(); }
  }
}

export class MacOSCaffeinateProvider implements KeepAwakeProvider {
  public readonly id = 'macos-caffeinate';
  private child: ChildProcess | null = null;
  private sessionId: string | null = null;

  public constructor(private readonly executable = '/usr/bin/caffeinate') {}

  public async probe(): Promise<{ readonly supported: boolean; readonly reason?: string }> {
    if (process.platform !== 'darwin') return { supported: false, reason: 'Keep-awake is implemented for macOS only' };
    try {
      await access(this.executable);
      return { supported: true };
    } catch {
      return { supported: false, reason: 'macOS caffeinate executable is unavailable' };
    }
  }

  public async start(): Promise<KeepAwakeProviderSession> {
    if (this.child !== null || this.sessionId !== null) throw new RuntimeError('PRECONDITION_FAILED', 'Keep-awake provider session is already active');
    const capability = await this.probe();
    if (!capability.supported) throw new RuntimeError('CAPABILITY_DENIED', capability.reason ?? 'Keep-awake provider is unavailable');
    const child = spawn(this.executable, caffeinateArguments(process.pid), { stdio: 'ignore', detached: false });
    const sessionId = randomUUID();
    this.child = child;
    this.sessionId = sessionId;
    const clearSession = () => {
      if (this.sessionId === sessionId) {
        this.child = null;
        this.sessionId = null;
      }
    };
    child.once('error', clearSession);
    child.once('exit', clearSession);
    return { providerSessionId: sessionId };
  }

  public async stop(session: KeepAwakeProviderSession): Promise<void> {
    if (this.sessionId === null || this.child === null) return;
    if (session.providerSessionId !== this.sessionId) throw new RuntimeError('PRECONDITION_FAILED', 'Keep-awake provider session identity changed');
    const child = this.child;
    this.child = null;
    this.sessionId = null;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }

  public async observe(session: KeepAwakeProviderSession): Promise<boolean> {
    return this.sessionId === session.providerSessionId && this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }
}

export function caffeinateArguments(supervisorPid: number): readonly string[] {
  return ['-dimsu', '-w', String(supervisorPid)];
}

function emptyKeepAwakePreference(): KeepAwakePreference {
  return { schemaVersion: 1, enabled: false, updatedAt: new Date(0).toISOString() };
}

function isKeepAwakePreference(value: unknown): value is KeepAwakePreference {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (value as { schemaVersion?: unknown }).schemaVersion === 1
    && typeof (value as { enabled?: unknown }).enabled === 'boolean'
    && typeof (value as { updatedAt?: unknown }).updatedAt === 'string'
    && Number.isFinite(Date.parse((value as { updatedAt: string }).updatedAt));
}
