import { describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawnSync: spawnSyncMock };
});

import { observeProcessStart } from './macos-safety.js';

describe('macOS process identity observation', () => {
  it('retries a transient helper failure but still requires a valid live marker', () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: null, stdout: '', stderr: '', error: new Error('timeout') })
      .mockReturnValueOnce({ status: 0, stdout: '123:456789\n', stderr: '' });

    expect(observeProcessStart(process.pid)).toEqual({ state: 'live', marker: '123:456789' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });
});
