import { describe, expect, it } from 'vitest';
import { KeepAwakeLeaseManager, type KeepAwakeProvider, type KeepAwakeProviderSession } from './keep-awake.js';

class DisposableProvider implements KeepAwakeProvider {
  public readonly id = 'test-disposable';
  public starts = 0;
  public stops = 0;
  private active: KeepAwakeProviderSession | null = null;
  private next = 0;

  public async probe(): Promise<{ readonly supported: boolean }> { return { supported: true }; }
  public async start(): Promise<KeepAwakeProviderSession> {
    this.starts += 1;
    this.active = { providerSessionId: `fixture-${++this.next}` };
    return this.active;
  }
  public async stop(session: KeepAwakeProviderSession): Promise<void> {
    if (this.active?.providerSessionId !== session.providerSessionId) throw new Error('wrong session');
    this.stops += 1;
    this.active = null;
  }
  public async observe(session: KeepAwakeProviderSession): Promise<boolean> {
    return this.active?.providerSessionId === session.providerSessionId;
  }
}

describe('KeepAwakeLeaseManager', () => {
  it('shares one provider session and stops only after the final owned lease releases', async () => {
    const provider = new DisposableProvider();
    const manager = new KeepAwakeLeaseManager(provider);
    const [first, second] = await Promise.all([manager.request('runtime'), manager.request('session')]);
    expect(provider.starts).toBe(1);
    expect((await manager.snapshot()).leaseCount).toBe(2);
    await first.release();
    expect(provider.stops).toBe(0);
    expect((await manager.snapshot()).observed).toBe('ACTIVE');
    await second.release();
    expect(provider.stops).toBe(1);
    expect((await manager.snapshot()).observed).toBe('OFF');
  });

  it('is idempotent and releaseAll cannot affect an unowned provider session', async () => {
    const provider = new DisposableProvider();
    const manager = new KeepAwakeLeaseManager(provider);
    const lease = await manager.request('runtime');
    await lease.release();
    await lease.release();
    await manager.release('unknown');
    await manager.releaseAll();
    expect(provider.stops).toBe(1);
    expect((await manager.snapshot()).leaseCount).toBe(0);
  });

  it('replaces a provider session that disappeared before the next lease request', async () => {
    const provider = new DisposableProvider();
    const manager = new KeepAwakeLeaseManager(provider);
    await manager.request('runtime');
    await provider.stop({ providerSessionId: 'fixture-1' });
    await manager.request('session');
    expect(provider.starts).toBe(2);
    expect((await manager.snapshot()).observed).toBe('ACTIVE');
  });
});
