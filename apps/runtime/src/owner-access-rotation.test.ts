import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateOwnerAccessSecret, readOwnerAccessSecret, rotateOwnerAccessSecret } from './persistence.js';
import { Supervisor } from './supervisor.js';

const roots: string[] = [];
const ports = {
  runtime: 58_120,
  supervisorAdmin: 58_121,
  supervisorControl: 58_122,
  supervisorTunnelHealth: 58_123,
  fullTunnelHealth: 58_124,
  proTunnelHealth: 58_125,
  web: 58_126,
} as const;

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Owner Access Secret replacement', () => {
  it('atomically publishes a replacement without returning either credential value', async () => {
    const root = await fixture();
    const oldSecret = await loadOrCreateOwnerAccessSecret(root);
    const replacement = 'synthetic-owner-replacement-012345678901234567890123';

    const result = await rotateOwnerAccessSecret(root, replacement);
    const newSecret = await readOwnerAccessSecret(root);

    expect(result).toEqual({ status: 'ROTATED', credentialType: 'OWNER_ACCESS_SECRET' });
    expect(newSecret).toBe(replacement);
    expect(newSecret).not.toBe(oldSecret);
    expect(JSON.stringify(result)).not.toContain(oldSecret);
    expect(JSON.stringify(result)).not.toContain(newSecret);
    expect(JSON.parse(await readFile(path.join(root, 'owner-access.json'), 'utf8'))).toMatchObject({ schemaVersion: 1 });
  });

  it('rotates through the Supervisor only after a complete OFF/DOWN stopped proof', async () => {
    const root = await stoppedFixture();
    const oldSecret = await readOwnerAccessSecret(root);
    const replacement = 'synthetic-supervisor-replacement-012345678901234567';
    const supervisor = new Supervisor(root, root, '/usr/bin/false', ports, true);

    await expect(supervisor.rotateOwnerAccessCredential(replacement)).resolves.toEqual({ status: 'ROTATED', credentialType: 'OWNER_ACCESS_SECRET' });
    await expect(readOwnerAccessSecret(root)).resolves.not.toBe(oldSecret);
  });

  it('rejects an active desired state without changing the credential', async () => {
    const root = await fixture();
    const oldSecret = await loadOrCreateOwnerAccessSecret(root);
    const replacement = 'synthetic-active-replacement-012345678901234567890';
    await writeSupervisorState(root, { workloadDesiredState: 'ON', stackDesiredState: 'UP' });
    const supervisor = new Supervisor(root, root, '/usr/bin/false', ports, true);

    await expect(supervisor.rotateOwnerAccessCredential(replacement)).rejects.toMatchObject({ code: 'PROCESS_OWNERSHIP_AMBIGUOUS' });
    await expect(readOwnerAccessSecret(root)).resolves.toBe(oldSecret);
  });

  it('rejects stale process metadata without reclaiming it or changing the credential', async () => {
    const root = await fixture();
    const oldSecret = await loadOrCreateOwnerAccessSecret(root);
    const replacement = 'synthetic-stale-replacement-012345678901234567890';
    await writeSupervisorState(root, {
      workloadDesiredState: 'OFF',
      stackDesiredState: 'DOWN',
      runtime: {
        component: 'runtime',
        pid: 999_999,
        startedAt: new Date(0).toISOString(),
        executable: '/usr/bin/false',
        profilePath: null,
        tunnelId: null,
        marker: root,
        processStartTimeMs: null,
        runtimeId: randomUUID(),
        instanceId: randomUUID(),
        deploymentEpoch: null,
        profileDigest: null,
        workingDirectory: root,
        environmentDigest: null,
      },
    });
    const supervisor = new Supervisor(root, root, '/usr/bin/false', ports, true);

    await expect(supervisor.rotateOwnerAccessCredential(replacement)).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
    await expect(readOwnerAccessSecret(root)).resolves.toBe(oldSecret);
  });
});

async function fixture(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), 'iris-owner-rotation-'));
  const root = await realpath(created);
  roots.push(root);
  return root;
}

async function stoppedFixture(): Promise<string> {
  const root = await fixture();
  await loadOrCreateOwnerAccessSecret(root);
  await writeSupervisorState(root, { workloadDesiredState: 'OFF', stackDesiredState: 'DOWN' });
  return root;
}

async function writeSupervisorState(
  root: string,
  overrides: {
    readonly workloadDesiredState: 'ON' | 'OFF';
    readonly stackDesiredState: 'UP' | 'DOWN';
    readonly runtime?: Record<string, unknown>;
  },
): Promise<void> {
  const supervisorRoot = path.join(root, 'supervisor');
  await mkdir(supervisorRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(supervisorRoot, 'state.json'), `${JSON.stringify({
    schemaVersion: 3,
    supervisorId: randomUUID(),
    updatedAt: new Date().toISOString(),
    workloadSourceRoot: root,
    workloadDesiredState: overrides.workloadDesiredState,
    stackDesiredState: overrides.stackDesiredState,
    runtime: overrides.runtime ?? null,
    web: null,
    admin: null,
    adminTunnel: null,
    tunnels: { full: null, pro: null },
    recovery: { attempts: 0, terminal: false, lastFailureCode: null, nextAttemptAt: null, windowStartedAt: null },
  })}\n`, { mode: 0o600 });
}
