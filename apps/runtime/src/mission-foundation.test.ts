import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function fixture() {
  const sourceRoot = await temp('iris-v2-mission-source-');
  const dataRoot = await temp('iris-v2-mission-data-');
  const projectRoot = path.join(sourceRoot, 'project');
  await mkdir(projectRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Mission Project', projectRoot);
  const session = state.createSession('hermes-client', 'hermes-loop-engineer', 'implementer');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, path.join(sourceRoot, 'legacy-reference'));
  const audit = new PermissionAuditStore(dataRoot);
  const service = new CapabilityService(state, policy, audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1,
    agentExecutorType: 'local-development-executor', productionModelConnected: false,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }));
  return { sourceRoot, dataRoot, projectRoot: project.rootPath, state, project, session, settings, policy, audit, service };
}

async function preparedMission(f: Awaited<ReturnType<typeof fixture>>, capabilityId: 'file.read' | 'file.write' = 'file.write') {
  let mission = await f.state.createMission(f.session.clientId, f.session.id, 'V2 mission foundation');
  mission = await f.state.createMissionTask(mission.id, f.session.clientId, f.session.id, 'Execute governed action');
  const taskId = mission.tasks[0]!.id;
  mission = await f.state.prepareMissionAction(mission.id, taskId, f.session.clientId, f.session.id, capabilityId, 'Perform one bounded governed action');
  return { mission, taskId, actionId: mission.tasks[0]!.actions[0]!.id };
}

describe('V2 mission execution foundation', () => {
  it('keeps file.write permission semantics identical when mission correlation metadata is present', async () => {
    const f = await fixture();
    const targetPath = path.join(f.project.rootPath, 'equivalence.txt');
    const base = {
      capabilityId: 'file.write' as const, clientId: f.session.clientId, sessionId: f.session.id,
      projectId: f.project.id, targetPath,
    };
    const correlated = { ...base, missionId: 'mission-correlation', taskId: 'task-correlation', actionId: 'action-correlation' };

    const plainAuto = await f.policy.evaluate(base);
    const missionAuto = await f.policy.evaluate(correlated);
    expect(missionAuto).toMatchObject({
      decision: plainAuto.decision, riskClass: plainAuto.riskClass, projectId: plainAuto.projectId, target: plainAuto.target, reason: plainAuto.reason,
      missionId: 'mission-correlation', taskId: 'task-correlation', actionId: 'action-correlation',
    });
    expect(plainAuto.decision).toBe('ALLOW_AUTO');

    await f.settings.setMode('ASK_EVERY_TIME');
    const plainOwner = await f.policy.evaluate(base);
    const missionOwner = await f.policy.evaluate(correlated);
    expect(missionOwner).toMatchObject({ decision: plainOwner.decision, projectId: plainOwner.projectId, target: plainOwner.target, reason: plainOwner.reason });
    expect(plainOwner.decision).toBe('OWNER_REQUIRED');

    const deniedBase = { ...base, targetPath: path.join(f.sourceRoot, 'outside.txt') };
    const plainDenied = await f.policy.evaluate(deniedBase);
    const missionDenied = await f.policy.evaluate({ ...deniedBase, missionId: 'mission-correlation', taskId: 'task-correlation', actionId: 'action-correlation' });
    expect(missionDenied).toMatchObject({ decision: plainDenied.decision, projectId: plainDenied.projectId, target: plainDenied.target, reason: plainDenied.reason });
    expect(plainDenied.decision).toBe('DENY');
  });
  it('persists mission, task, action, supervisor-gate, and timeline identity independently from transient sessions', async () => {
    const f = await fixture();
    const prepared = await preparedMission(f);
    let mission = await f.state.setMissionState(prepared.mission.id, f.session.clientId, f.session.id, 'RUNNING');
    mission = await f.state.setMissionTaskState(mission.id, prepared.taskId, f.session.clientId, f.session.id, 'RUNNING');
    mission = await f.state.setMissionSupervisorGate(mission.id, f.session.clientId, f.session.id, 'PENDING', 'Await supervisor directive');

    expect(mission.supervisorGate).toMatchObject({ state: 'PENDING', reason: 'Await supervisor directive' });
    expect(mission.timeline.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'MISSION_CREATED', 'TASK_CREATED', 'ACTION_PREPARED', 'MISSION_STATE_CHANGED', 'TASK_STATE_CHANGED', 'SUPERVISOR_GATE_CHANGED',
    ]));

    const restartedState = new RuntimeState(new FoundationStateStore(f.dataRoot));
    const persisted = await restartedState.getMission(mission.id);
    expect(persisted.id).toBe(mission.id);
    expect(persisted.tasks[0]?.id).toBe(prepared.taskId);
    expect(persisted.tasks[0]?.actions[0]?.id).toBe(prepared.actionId);
    expect(persisted.supervisorGate.state).toBe('PENDING');
    expect(restartedState.listSessions()).toEqual([]);
  });

  it('binds a prepared mission action to governed execution, records bounded evidence, and rejects replay', async () => {
    const f = await fixture();
    const prepared = await preparedMission(f);
    const targetPath = path.join(f.projectRoot, 'mission.txt');
    const association = { missionId: prepared.mission.id, taskId: prepared.taskId, actionId: prepared.actionId };

    const outcome = await f.service.execute({
      capabilityId: 'file.write', clientId: f.session.clientId, sessionId: f.session.id,
      projectId: f.project.id, targetPath, content: 'mission-result', mission: association,
    });
    expect(outcome.status, outcome.status === 'denied' ? outcome.reason : undefined).toBe('executed');
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('mission-result');

    const mission = await f.state.getMission(prepared.mission.id);
    const action = mission.tasks[0]!.actions[0]!;
    expect(action.state).toBe('SUCCEEDED');
    expect(action.result).toMatchObject({ status: 'SUCCEEDED', approvalId: null, summary: 'Governed capability executed successfully' });
    expect(action.result?.evidence).toHaveLength(1);
    expect(action.result?.evidence[0]).toMatchObject({ kind: 'CAPABILITY_RESULT', label: 'file.write', reference: targetPath, data: { bytes: 14 } });
    expect(JSON.stringify(action.result)).not.toContain('mission-result');

    await expect(f.service.execute({
      capabilityId: 'file.write', clientId: f.session.clientId, sessionId: f.session.id,
      projectId: f.project.id, targetPath, content: 'must-not-replay', mission: association,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('mission-result');
  });

  it('allows only one concurrent claim of the same prepared mission action', async () => {
    const f = await fixture();
    const prepared = await preparedMission(f);
    const targetPath = path.join(f.projectRoot, 'concurrent-mission.txt');
    const association = { missionId: prepared.mission.id, taskId: prepared.taskId, actionId: prepared.actionId };
    const operation = {
      capabilityId: 'file.write' as const, clientId: f.session.clientId, sessionId: f.session.id,
      projectId: f.project.id, targetPath, content: 'claimed-once', mission: association,
    };

    const attempts = await Promise.allSettled([
      f.service.execute(operation),
      f.service.execute(operation),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({ status: 'fulfilled', value: { status: 'executed' } });
    expect(rejected[0]).toMatchObject({ status: 'rejected', reason: { code: 'CAPABILITY_DENIED' } });
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('claimed-once');

    const mission = await f.state.getMission(prepared.mission.id);
    expect(mission.timeline.filter((event) => event.kind === 'ACTION_STARTED')).toHaveLength(1);
    expect(mission.timeline.filter((event) => event.kind === 'ACTION_SUCCEEDED')).toHaveLength(1);
    const events = await f.audit.recent(100);
    expect(events.filter((event) => event.capabilityId === 'file.write' && event.result === 'SUCCESS')).toHaveLength(1);
  });

  it('creates at most one approval for concurrent attempts to claim the same mission action', async () => {
    const f = await fixture();
    await f.settings.setMode('ASK_EVERY_TIME');
    const prepared = await preparedMission(f);
    const targetPath = path.join(f.projectRoot, 'concurrent-owner-required.txt');
    const association = { missionId: prepared.mission.id, taskId: prepared.taskId, actionId: prepared.actionId };
    const operation = {
      capabilityId: 'file.write' as const, clientId: f.session.clientId, sessionId: f.session.id,
      projectId: f.project.id, targetPath, content: 'owner-required-once', mission: association,
    };

    const attempts = await Promise.allSettled([
      f.service.execute(operation),
      f.service.execute(operation),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({ status: 'fulfilled', value: { status: 'owner_required' } });
    expect(rejected[0]).toMatchObject({ status: 'rejected', reason: { code: 'CAPABILITY_DENIED' } });
    expect(f.service.listPendingApprovals()).toHaveLength(1);
    const mission = await f.state.getMission(prepared.mission.id);
    expect(mission.timeline.filter((event) => event.kind === 'APPROVAL_REQUIRED')).toHaveLength(1);
  });

  it('rejects a stale mission approval if the exact action is no longer approval-eligible', async () => {
    const f = await fixture();
    await f.settings.setMode('ASK_EVERY_TIME');
    const prepared = await preparedMission(f);
    const targetPath = path.join(f.projectRoot, 'stale-approval.txt');
    const association = { missionId: prepared.mission.id, taskId: prepared.taskId, actionId: prepared.actionId };
    const pending = await f.service.execute({
      capabilityId: 'file.write', clientId: f.session.clientId, sessionId: f.session.id,
      projectId: f.project.id, targetPath, content: 'must-not-run', mission: association,
    });
    if (pending.status !== 'owner_required') throw new Error('Expected pending owner approval');

    await f.state.markMissionActionDenied(association, 'Action invalidated before owner approval');
    await expect(f.service.resolveApproval(pending.approval.id, 'ALLOW_ONCE')).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.service.listPendingApprovals()).toHaveLength(0);
  });

  it('associates owner approval with the originating action and resumes that exact action once', async () => {
    const f = await fixture();
    await f.settings.setMode('ASK_EVERY_TIME');
    const prepared = await preparedMission(f);
    const targetPath = path.join(f.projectRoot, 'approved.txt');
    const association = { missionId: prepared.mission.id, taskId: prepared.taskId, actionId: prepared.actionId };

    const pending = await f.service.execute({
      capabilityId: 'file.write', clientId: f.session.clientId, sessionId: f.session.id,
      projectId: f.project.id, targetPath, content: 'approved-once', mission: association,
    });
    expect(pending.status).toBe('owner_required');
    if (pending.status !== 'owner_required') return;
    expect(pending.approval).toMatchObject({ missionId: prepared.mission.id, taskId: prepared.taskId, actionId: prepared.actionId });

    let mission = await f.state.getMission(prepared.mission.id);
    expect(mission.tasks[0]?.actions[0]).toMatchObject({ state: 'OWNER_APPROVAL_REQUIRED', approvalId: pending.approval.id });

    const resolved = await f.service.resolveApproval(pending.approval.id, 'ALLOW_ONCE');
    expect(resolved.status).toBe('executed');
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('approved-once');
    mission = await f.state.getMission(prepared.mission.id);
    expect(mission.tasks[0]?.actions[0]).toMatchObject({ state: 'SUCCEEDED', approvalId: pending.approval.id, result: { status: 'SUCCEEDED', approvalId: pending.approval.id } });
    expect(mission.timeline.filter((event) => event.kind === 'APPROVAL_REQUIRED')).toHaveLength(1);
    expect(mission.timeline.filter((event) => event.kind === 'ACTION_SUCCEEDED')).toHaveLength(1);
  });

  it('does not treat supervisor-gate approval as IRIS execution permission', async () => {
    const f = await fixture();
    await f.settings.setMode('ASK_EVERY_TIME');
    const prepared = await preparedMission(f);
    await f.state.setMissionSupervisorGate(prepared.mission.id, f.session.clientId, f.session.id, 'APPROVED', 'Recorded external supervisor decision');
    const outcome = await f.service.execute({
      capabilityId: 'file.write', clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id,
      targetPath: path.join(f.projectRoot, 'still-governed.txt'), content: 'blocked-until-owner',
      mission: { missionId: prepared.mission.id, taskId: prepared.taskId, actionId: prepared.actionId },
    });
    expect(outcome.status).toBe('owner_required');
  });

  it('fails closed when session/project identity would redirect a prepared mission action', async () => {
    const f = await fixture();
    const prepared = await preparedMission(f);
    const otherRoot = path.join(f.sourceRoot, 'other-project');
    await mkdir(otherRoot);
    const otherProject = await f.state.registerProject('Other Project', otherRoot);
    await f.state.setSessionCurrentProject(f.session.id, f.session.clientId, otherProject.id);

    await expect(f.service.execute({
      capabilityId: 'file.write', clientId: f.session.clientId, sessionId: f.session.id, projectId: otherProject.id,
      targetPath: path.join(otherProject.rootPath, 'redirect.txt'), content: 'must-not-run',
      mission: { missionId: prepared.mission.id, taskId: prepared.taskId, actionId: prepared.actionId },
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });
});
