import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService, type CapabilityOutcome } from './capability-service.js';
import { DurableJobManager } from './durable-job-manager.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { ProjectValidationJobManager } from './project-test.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 8 validation compatibility convergence', () => {
  it('AC-COMPAT-003 preserves synchronous declared-script results through shell.run semantics and keeps lifecycle scripts disabled', async () => {
    const fixture = await serviceFixture();

    const validation = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'project.command.run',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      scriptName: 'compat:pass',
    }));
    expect(validation).toMatchObject({
      scriptName: 'compat:pass',
      packageManager: 'pnpm',
      passed: true,
      exitCode: 0,
      timedOut: false,
      outputTruncated: false,
    });
    expect(String(validation.stdout)).toContain('VALIDATION_COMPAT_PASS ignore=true');
    expect(validation).not.toHaveProperty('executionId');
    expect(validation).not.toHaveProperty('workspaceId');
    await expect(access(path.join(fixture.projectRoot, 'pre-ran.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(fixture.projectRoot, 'post-ran.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    const projectTest = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'project.test.run',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
    }));
    expect(projectTest).toMatchObject({ scriptName: 'test', packageManager: 'pnpm', passed: true, exitCode: 0 });
  }, 15_000);

  it('AC-COMPAT-003 maps project_validation_start/job onto DurableJobManager with idempotency and restart-safe legacy views', async () => {
    const fixture = await serviceFixture();
    const first = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'project.validation.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      scriptName: 'compat:pass',
      requestId: 'phase8-validation-request-1',
    }));
    const retry = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'project.validation.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      scriptName: 'compat:pass',
      requestId: 'phase8-validation-request-1',
    }));
    expect(retry.jobId).toBe(first.jobId);
    expect(first).toMatchObject({
      requestId: 'phase8-validation-request-1',
      scriptName: 'compat:pass',
      packageManager: 'pnpm',
      source: 'root-package.json',
      status: 'RUNNING',
      result: null,
    });

    const terminal = await waitForTerminal(fixture.service, fixture, String(first.jobId));
    expect(terminal).toMatchObject({ status: 'PASSED', result: { passed: true, exitCode: 0, timedOut: false } });

    const terminalRetry = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'project.validation.start',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      scriptName: 'compat:pass',
      requestId: 'phase8-validation-request-1',
    }));
    expect(terminalRetry).toMatchObject({
      jobId: first.jobId,
      requestId: 'phase8-validation-request-1',
      status: 'PASSED',
      result: { passed: true, exitCode: 0, timedOut: false },
    });

    const logs = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'project.validation.job.read',
      clientId: fixture.session.clientId,
      projectId: fixture.project.id,
      jobId: String(first.jobId),
      view: 'logs',
    }));
    expect(logs).toMatchObject({ jobId: first.jobId, status: 'PASSED' });
    expect(String(logs.stdout)).toContain('VALIDATION_COMPAT_PASS ignore=true');

    const durableAfterRestart = new DurableJobManager(fixture.dataRoot, fixture.resources);
    await durableAfterRestart.recover();
    const restartedService = capabilityService(fixture, durableAfterRestart, fixture.legacyJobs);
    const afterRestart = executedValue<Record<string, unknown>>(await restartedService.execute({
      capabilityId: 'project.validation.job.read',
      clientId: fixture.session.clientId,
      projectId: fixture.project.id,
      jobId: String(first.jobId),
      view: 'result',
    }));
    expect(afterRestart).toMatchObject({ jobId: first.jobId, status: 'PASSED', result: { passed: true, exitCode: 0 } });
  }, 15_000);

  it('keeps pre-Phase-8 persisted validation jobs readable through the legacy fallback after convergence', async () => {
    const fixture = await serviceFixture();
    const legacy = await fixture.legacyJobs.start(fixture.projectRoot, 'compat:pass', 'legacy-validation-before-phase8');
    const terminal = await waitLegacyTerminal(fixture.legacyJobs, legacy.jobId);
    expect(terminal).toMatchObject({ status: 'PASSED' });

    const result = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'project.validation.job.read',
      clientId: fixture.session.clientId,
      projectId: fixture.project.id,
      jobId: legacy.jobId,
      view: 'result',
    }));
    expect(result).toMatchObject({ jobId: legacy.jobId, status: 'PASSED', result: { passed: true, exitCode: 0 } });
  });
});

async function serviceFixture() {
  const sourceRoot = await realpath(await temp('iris-phase8-validation-source-'));
  const dataRoot = await realpath(await temp('iris-phase8-validation-data-'));
  const legacyRoot = await realpath(await temp('iris-phase8-validation-legacy-'));
  const projectRoot = path.join(sourceRoot, 'project');
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    packageManager: 'pnpm@10.15.0',
    scripts: {
      test: 'node compat-pass.mjs',
      'compat:pass': 'node compat-pass.mjs',
      'precompat:pass': 'node pre.mjs',
      'postcompat:pass': 'node post.mjs',
    },
  }, null, 2));
  await writeFile(path.join(projectRoot, 'compat-pass.mjs'), "console.log('VALIDATION_COMPAT_PASS ignore=' + process.env.npm_config_ignore_scripts)\n");
  await writeFile(path.join(projectRoot, 'pre.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('pre-ran.txt','yes')\n");
  await writeFile(path.join(projectRoot, 'post.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('post-ran.txt','yes')\n");

  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Phase8 validation', projectRoot);
  const session = state.createSession('phase8-validation-client', 'phase8-validation-agent', 'implementer');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, legacyRoot);
  const audit = new PermissionAuditStore(dataRoot);
  const resources = new VNextResourceRegistry(state, dataRoot);
  const durableJobs = new DurableJobManager(dataRoot, resources);
  const legacyJobs = new ProjectValidationJobManager(dataRoot);
  const fixture = { sourceRoot, dataRoot, legacyRoot, projectRoot, state, project, session, settings, policy, audit, resources, durableJobs, legacyJobs };
  const service = capabilityService(fixture, durableJobs, legacyJobs);
  return { ...fixture, service };
}

function capabilityService(
  fixture: {
    state: RuntimeState;
    policy: PermissionPolicyEngine;
    audit: PermissionAuditStore;
    resources: VNextResourceRegistry;
  },
  jobs: DurableJobManager,
  legacyJobs: ProjectValidationJobManager,
) {
  return new CapabilityService(fixture.state, fixture.policy, fixture.audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: fixture.state.listClients().length, connectedSessions: fixture.state.listSessions().length,
    agentExecutorType: 'local-development-executor', productionModelConnected: false,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }), legacyJobs, fixture.resources, jobs);
}

function executedValue<T>(outcome: CapabilityOutcome): T {
  if (outcome.status !== 'executed') throw new Error(`Expected executed outcome, received ${outcome.status}`);
  return outcome.value as T;
}

async function waitForTerminal(service: CapabilityService, fixture: Awaited<ReturnType<typeof serviceFixture>>, jobId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = executedValue<Record<string, unknown>>(await service.execute({
      capabilityId: 'project.validation.job.read',
      clientId: fixture.session.clientId,
      projectId: fixture.project.id,
      jobId,
      view: 'status',
    }));
    if (snapshot.status !== 'RUNNING') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('durable validation job did not finish within the test bound');
}

async function waitLegacyTerminal(manager: ProjectValidationJobManager, jobId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await manager.read(jobId, 'status') as { readonly status: string };
    if (snapshot.status !== 'RUNNING') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('legacy validation job did not finish within the test bound');
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
