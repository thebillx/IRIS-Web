import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceId, WorkspaceRecord } from '@iris/domain';
import { resolveExecutionProfile } from './execution-profiles.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 8 package-manager compatibility execution profiles', () => {
  it('accepts only the bounded server-owned pnpm lifecycle-suppression form', async () => {
    const workspace = await fixture();

    const plan = await resolveExecutionProfile({
      workspace,
      executable: 'pnpm',
      argv: ['--config.ignore-scripts=true', '--config.enable-pre-post-scripts=false', 'run', 'compat:pass'],
      cwd: '.',
      executionProfile: 'pnpm-script',
      envOverrides: {},
      timeoutMs: 60_000,
    });
    expect(plan.argv).toEqual([
      '--config.ignore-scripts=true',
      '--config.enable-pre-post-scripts=false',
      'run',
      'compat:pass',
    ]);
    expect(plan.environment.npm_config_ignore_scripts).toBe('true');

    await expect(resolveExecutionProfile({
      workspace,
      executable: 'pnpm',
      argv: ['--config.enable-pre-post-scripts=true', 'run', 'compat:pass'],
      cwd: '.',
      executionProfile: 'pnpm-script',
      envOverrides: {},
      timeoutMs: 60_000,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await expect(resolveExecutionProfile({
      workspace,
      executable: 'pnpm',
      argv: ['--config.ignore-scripts=true', '--config.enable-pre-post-scripts=false', 'run', 'compat:pass', '--', '--extra'],
      cwd: '.',
      executionProfile: 'pnpm-script',
      envOverrides: {},
      timeoutMs: 60_000,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('accepts the bounded npm ignore-scripts form and prevents caller override of server-owned lifecycle policy', async () => {
    const workspace = await fixture();

    const plan = await resolveExecutionProfile({
      workspace,
      executable: 'npm',
      argv: ['run', '--ignore-scripts', 'compat:pass'],
      cwd: '.',
      executionProfile: 'npm-script',
      envOverrides: {},
      timeoutMs: 60_000,
    });
    expect(plan.argv).toEqual(['run', '--ignore-scripts', 'compat:pass']);
    expect(plan.environment.npm_config_ignore_scripts).toBe('true');

    await expect(resolveExecutionProfile({
      workspace,
      executable: 'npm',
      argv: ['run', '--ignore-scripts', 'compat:pass'],
      cwd: '.',
      executionProfile: 'npm-script',
      envOverrides: { npm_config_ignore_scripts: 'false' },
      timeoutMs: 60_000,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });
});

async function fixture(): Promise<WorkspaceRecord> {
  const lexicalRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-phase8-profile-'));
  roots.push(lexicalRoot);
  const root = await realpath(lexicalRoot);
  return {
    workspaceId: '11111111-1111-4111-8111-111111111111' as WorkspaceId,
    projectId: '22222222-2222-4222-8222-222222222222',
    repositoryId: null,
    physicalRoot: root,
    role: 'PRIMARY',
    authorizationSource: 'PROJECT_REGISTRATION',
    createdByAction: null,
    lifecycleState: 'ACTIVE',
    createdAt: new Date(0).toISOString(),
  };
}
