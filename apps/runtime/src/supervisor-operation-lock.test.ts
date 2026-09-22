import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { observeProcessStartMock } = vi.hoisted(() => ({
  observeProcessStartMock: vi.fn(),
}));

vi.mock('./macos-safety.js', async () => {
  const actual = await vi.importActual<typeof import('./macos-safety.js')>('./macos-safety.js');
  return { ...actual, observeProcessStart: observeProcessStartMock };
});

import { createSupervisor } from './supervisor.js';

const roots: string[] = [];

afterEach(async () => {
  observeProcessStartMock.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('supervisor operation lock initialization', () => {
  it('does not leave a zero-byte lock when process-start identity cannot be measured', async () => {
    observeProcessStartMock.mockReturnValue({ state: 'indeterminate' });
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-lock-init-'));
    roots.push(dataRoot);

    const supervisor = await createSupervisor({ dataRoot, sourceRoot: '/Users/example/iris' });
    await expect(supervisor.up()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });

    const entries = await readdir(path.join(dataRoot, 'supervisor'));
    expect(entries).not.toContain('operation.lock');
  });

  it('treats a briefly empty in-progress lock as contention after initialization completes', async () => {
    const marker = '123:123456';
    observeProcessStartMock.mockReturnValue({ state: 'live', marker });
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-lock-race-'));
    roots.push(dataRoot);
    const supervisor = await createSupervisor({ dataRoot, sourceRoot: '/Users/example/iris' });
    const supervisorDirectory = path.join(dataRoot, 'supervisor');
    await mkdir(supervisorDirectory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(supervisorDirectory, 'operation.lock');
    await writeFile(lockPath, '', { mode: 0o600 });

    const initialized = JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      operation: 'replace-workload-source',
      processStartMarker: marker,
    }) + '\n';
    const publish = setTimeout(() => {
      void writeFile(lockPath, initialized, 'utf8');
    }, 5);

    try {
      await expect((supervisor as unknown as {
        withOperationLock<T>(operation: string, work: () => Promise<T>): Promise<T>;
      }).withOperationLock('automatic-recovery', async () => undefined)).rejects.toMatchObject({ code: 'SUPERVISOR_BUSY' });
    } finally {
      clearTimeout(publish);
    }
  });
});
