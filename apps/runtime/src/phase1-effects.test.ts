import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { assertExpectedEffects, deriveCapabilityEffects } from './capability-effects.js';
import { CapabilityService } from './capability-service.js';
import { DurableJobManager } from './durable-job-manager.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { ProjectValidationJobManager } from './project-test.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('IRIS vNext Phase 1 capability effects', () => {
  it('AC-SEC-001 derives deterministic combined server effects independently of riskClass', () => {
    expect(deriveCapabilityEffects('file.read')).toEqual(['READ']);
    expect(deriveCapabilityEffects('file.edit')).toEqual(['READ', 'WRITE', 'DESTRUCTIVE']);
    expect(deriveCapabilityEffects('project.validation.start')).toEqual(['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE']);
    expect(deriveCapabilityEffects('code_review.start')).toEqual(['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE']);
    expect(deriveCapabilityEffects('code_review.status')).toEqual(['READ']);
    expect(deriveCapabilityEffects('code_review.result')).toEqual(['READ', 'WRITE']);
    expect(deriveCapabilityEffects('git.local', { operation: 'status' })).toEqual(['READ', 'EXECUTE']);
    expect(deriveCapabilityEffects('git.local', { operation: 'commit' })).toEqual(['READ', 'WRITE', 'EXECUTE']);
  });

  it('AC-SEC-002 rejects a downgraded expectedEffects assertion before any mutation and audits the derived effects', async () => {
    const fixture = await serviceFixture();
    const target = path.join(fixture.projectRoot, 'blocked.txt');
    const outcome = await fixture.service.execute({
      capabilityId: 'file.write',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      targetPath: target,
      content: 'must-not-exist',
      expectedEffects: ['WRITE'],
    });
    expect(outcome).toMatchObject({ status: 'denied', reason: expect.stringContaining('EFFECT_MISMATCH') });
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const events = await fixture.audit.recent(20);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capabilityId: 'file.write',
        decision: 'DENY',
        result: 'DENIED',
        decisionCode: 'EFFECT_MISMATCH',
        effectiveEffects: ['WRITE', 'DESTRUCTIVE'],
      }),
    ]));
  });

  it('preserves legacy callers without expectedEffects and records effects on successful execution', async () => {
    const fixture = await serviceFixture();
    const target = path.join(fixture.projectRoot, 'legacy.txt');
    const outcome = await fixture.service.execute({
      capabilityId: 'file.write',
      clientId: fixture.session.clientId,
      sessionId: fixture.session.id,
      projectId: fixture.project.id,
      targetPath: target,
      content: 'legacy-compatible',
    });
    expect(outcome.status).toBe('executed');
    await expect(readFile(target, 'utf8')).resolves.toBe('legacy-compatible');
    const events = await fixture.audit.recent(20);
    expect(events.some((event) => event.capabilityId === 'file.write' && event.result === 'SUCCESS'
      && event.effectiveEffects?.join(',') === 'WRITE,DESTRUCTIVE')).toBe(true);
  });

  it('AC-SEC-003 keeps NETWORK independent from WRITE', () => {
    expect(deriveCapabilityEffects('remote.publish')).toContain('NETWORK');
    expect(deriveCapabilityEffects('remote.publish')).toContain('WRITE');
    expect(deriveCapabilityEffects('file.write')).not.toContain('NETWORK');
    expect(deriveCapabilityEffects('project.default.set')).toEqual(['WRITE']);
  });

  it('AC-SEC-004 keeps DESTRUCTIVE independent from WRITE', () => {
    expect(deriveCapabilityEffects('file.delete')).toEqual(['WRITE', 'DESTRUCTIVE']);
    expect(deriveCapabilityEffects('directory.delete')).toEqual(['WRITE', 'DESTRUCTIVE']);
    expect(deriveCapabilityEffects('directory.create')).toEqual(['WRITE']);
    expect(deriveCapabilityEffects('project.default.set')).toEqual(['WRITE']);
  });

  it('AC-SEC-005 fails closed for unknown capability/effect derivation and unknown asserted effects', () => {
    expect(deriveCapabilityEffects('not.registered')).toBeNull();
    expect(deriveCapabilityEffects('git.local', { operation: 'reset' })).toBeNull();
    expect(assertExpectedEffects(['READ'], ['READ', 'FUTURE_UNKNOWN'])).toMatchObject({ valid: false, code: 'UNKNOWN_EFFECT' });
  });

  it('accepting a superset assertion does not grant authority or add server-derived effects', async () => {
    const fixture = await serviceFixture();
    const target = path.join(fixture.projectRoot, 'read-only.txt');
    await fixture.service.execute({
      capabilityId: 'file.write', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: target, content: 'source',
    });
    const read = await fixture.service.execute({
      capabilityId: 'file.read', clientId: fixture.session.clientId, projectId: fixture.project.id, targetPath: target,
      expectedEffects: ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'],
    });
    expect(read.status).toBe('executed');
    await expect(readFile(target, 'utf8')).resolves.toBe('source');
    const events = await fixture.audit.recent(20);
    const latestRead = [...events].reverse().find((event) => event.capabilityId === 'file.read' && event.result === 'SUCCESS');
    expect(latestRead?.effectiveEffects).toEqual(['READ']);
  });

  it('does not let a superset expectedEffects bypass an existing owner approval requirement', async () => {
    const fixture = await serviceFixture();
    await fixture.settings.setMode('ASK_EVERY_TIME');
    const target = path.join(fixture.projectRoot, 'still-owner-gated.txt');
    const pending = await fixture.service.execute({
      capabilityId: 'file.write', clientId: fixture.session.clientId, sessionId: fixture.session.id,
      projectId: fixture.project.id, targetPath: target, content: 'owner-gated',
      expectedEffects: ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'],
    });
    expect(pending.status).toBe('owner_required');
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function serviceFixture() {
  const sourceRoot = await realpath(await temp('iris-phase1-source-'));
  const dataRoot = await realpath(await temp('iris-phase1-data-'));
  const legacyRoot = await realpath(await temp('iris-phase1-legacy-'));
  const projectRoot = path.join(sourceRoot, 'project');
  await mkdir(projectRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Phase1 Project', projectRoot);
  const session = state.createSession('phase1-client', 'phase1-agent', 'security');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, legacyRoot);
  const audit = new PermissionAuditStore(dataRoot);
  const resources = new VNextResourceRegistry(state, dataRoot);
  const jobs = new DurableJobManager(dataRoot, resources);
  const service = new CapabilityService(state, policy, audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1,
    agentExecutorType: 'local-development-executor', productionModelConnected: false,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }), new ProjectValidationJobManager(dataRoot), resources, jobs);
  return { sourceRoot, dataRoot, legacyRoot, projectRoot, state, project, session, settings, audit, service };
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
