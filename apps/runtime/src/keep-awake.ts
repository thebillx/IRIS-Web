import { access } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { RuntimeError } from '@iris/domain';

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
    const child = spawn(this.executable, ['-dimsu'], { stdio: 'ignore', detached: false });
    const sessionId = randomUUID();
    this.child = child;
    this.sessionId = sessionId;
    child.once('exit', () => {
      if (this.sessionId === sessionId) this.child = null;
    });
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
