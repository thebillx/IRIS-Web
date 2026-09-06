import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { MissionBrokerService, MissionBrokerStore } from './mission-broker.js';
import { MissionLedgerStore } from './mission-store.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-orchestrator-source-')); roots.push(sourceRoot);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-orchestrator-data-')); roots.push(dataRoot);
  const projectRoot = path.join(sourceRoot, 'project'); await mkdir(projectRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Orchestrator Fixture', projectRoot);
  const session = state.createSession('orchestrator-client', 'chatgpt-direct-orchestrator', 'owner');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const settings = new PermissionSettingsStore(dataRoot); await settings.initialize();
  const audit = new PermissionAuditStore(dataRoot);
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, path.join(sourceRoot, 'legacy'));
  const service = new CapabilityService(
    state,
    policy,
    audit,
    () => ({ status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid, uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1, agentExecutorType: 'local-development-executor', productionModelConnected: false, apiUrl: '', mcpUrl: '' }),
  );
  const broker = new MissionBrokerService(state, new MissionBrokerStore(dataRoot));
  return { sourceRoot, dataRoot, projectRoot: project.rootPath, state, project, session, settings, policy, audit, service, broker };
}

async function prepared(f: Awaited<ReturnType<typeof fixture>>, mode: 'HERMES' | 'CHATGPT' = 'HERMES') {
  let mission = await f.state.createMission(f.session.clientId, f.session.id, `${mode} mission`, mode);
  mission = await f.state.createMissionTask(mission.id, f.session.clientId, f.session.id, 'Task');
  const taskId = mission.tasks[0]!.id;
  mission = await f.state.prepareMissionAction(mission.id, taskId, f.session.clientId, f.session.id, 'file.write', 'Write once');
  return { mission, taskId, actionId: mission.tasks[0]!.actions[0]!.id };
}

describe('V2 selectable mission orchestrator mode', () => {
  it('defaults new missions to HERMES and persists the durable mode/version', async () => {
    const f = await fixture();
    const mission = await f.state.createMission(f.session.clientId, f.session.id, 'Default mission');
    expect(mission).toMatchObject({ orchestratorMode: 'HERMES', orchestratorVersion: 1, lastOrchestratorHandoff: null, orchestratorHandoffIds: [] });
    const restarted = new RuntimeState(new FoundationStateStore(f.dataRoot));
    await expect(restarted.getMission(mission.id)).resolves.toMatchObject({ orchestratorMode: 'HERMES', orchestratorVersion: 1, orchestratorHandoffIds: [] });
  });

  it('reads legacy mission records without orchestrator fields as HERMES and rejects ambiguous invalid mode values', async () => {
    const f = await fixture();
    const mission = await f.state.createMission(f.session.clientId, f.session.id, 'Legacy shape');
    const raw = JSON.parse(await readFile(path.join(f.dataRoot, 'missions.json'), 'utf8')) as { schemaVersion: 1; missions: Record<string, unknown>[] };
    const legacy = { ...raw.missions[0] };
    delete legacy.orchestratorMode; delete legacy.orchestratorVersion; delete legacy.lastOrchestratorHandoff; delete legacy.orchestratorHandoffIds;
    await writeFile(path.join(f.dataRoot, 'missions.json'), `${JSON.stringify({ schemaVersion: 1, missions: [legacy] }, null, 2)}\n`, { mode: 0o600 });
    await expect(new MissionLedgerStore(f.dataRoot).read()).resolves.toMatchObject({ missions: [{ id: mission.id, orchestratorMode: 'HERMES', orchestratorVersion: 1, lastOrchestratorHandoff: null, orchestratorHandoffIds: [] }] });
    await writeFile(path.join(f.dataRoot, 'missions.json'), `${JSON.stringify({ schemaVersion: 1, missions: [{ ...legacy, orchestratorMode: 'OTHER' }] }, null, 2)}\n`, { mode: 0o600 });
    await expect(new MissionLedgerStore(f.dataRoot).read()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await writeFile(path.join(f.dataRoot, 'missions.json'), `${JSON.stringify({ schemaVersion: 1, missions: [{ ...legacy, orchestratorVersion: 'invalid' }] }, null, 2)}\n`, { mode: 0o600 });
    await expect(new MissionLedgerStore(f.dataRoot).read()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await writeFile(path.join(f.dataRoot, 'missions.json'), `${JSON.stringify({ schemaVersion: 1, missions: [{ ...legacy, orchestratorHandoffIds: 'invalid' }] }, null, 2)}\n`, { mode: 0o600 });
    await expect(new MissionLedgerStore(f.dataRoot).read()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await writeFile(path.join(f.dataRoot, 'missions.json'), `${JSON.stringify({ schemaVersion: 1, missions: [{ ...legacy, orchestratorMode: 'HERMES' }] }, null, 2)}\n`, { mode: 0o600 });
    await expect(new MissionLedgerStore(f.dataRoot).read()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('allows a safe checkpointed HERMES to CHATGPT handoff exactly once and rejects stale/conflicting duplicates', async () => {
    const f = await fixture();
    const mission = await f.state.createMission(f.session.clientId, f.session.id, 'Safe handoff');
    await f.broker.bindHermesSession({ missionId: mission.id, hermesSessionId: '20260906_010000_handoff', worktreePath: f.projectRoot, branch: 'acceptance' });
    await f.broker.recordCheckpoint({ checkpointId: crypto.randomUUID(), missionId: mission.id, missionVersion: 1, state: 'WAITING_SUPERVISOR', currentPhase: 'handoff', summary: 'Checkpointed', evidenceRefs: ['checkpoint:ready'], blockers: [], hermesAssessment: 'Safe to hand off', proposedNextAction: 'Switch orchestrator', decisionRequired: true, createdAt: new Date().toISOString() });
    await f.state.setMissionState(mission.id, f.session.clientId, f.session.id, 'WAITING_SUPERVISOR');
    const handoffId = crypto.randomUUID();
    const switched = await f.broker.changeOrchestrator({ missionId: mission.id, targetMode: 'CHATGPT', expectedVersion: 1, handoffId });
    expect(switched).toMatchObject({ orchestratorMode: 'CHATGPT', orchestratorVersion: 2, lastOrchestratorHandoff: { handoffId, from: 'HERMES', to: 'CHATGPT' } });
    await expect(f.broker.changeOrchestrator({ missionId: mission.id, targetMode: 'CHATGPT', expectedVersion: 1, handoffId })).resolves.toMatchObject({ orchestratorMode: 'CHATGPT', orchestratorVersion: 2 });
    await expect(f.broker.changeOrchestrator({ missionId: mission.id, targetMode: 'HERMES', expectedVersion: 1, handoffId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.broker.changeOrchestrator({ missionId: mission.id, targetMode: 'HERMES', expectedVersion: 1, handoffId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects reuse of an older accepted handoff ID after a later orchestrator transition', async () => {
    const f = await fixture();
    const mission = await f.state.createMission(f.session.clientId, f.session.id, 'Handoff replay history');
    await f.state.setMissionState(mission.id, f.session.clientId, f.session.id, 'PAUSED');
    const firstId = crypto.randomUUID();
    const first = await f.broker.changeOrchestrator({ missionId: mission.id, targetMode: 'CHATGPT', expectedVersion: 1, handoffId: firstId });
    const secondId = crypto.randomUUID();
    const second = await f.broker.changeOrchestrator({ missionId: mission.id, targetMode: 'HERMES', expectedVersion: first.orchestratorVersion, handoffId: secondId });
    expect(second.orchestratorHandoffIds).toEqual([firstId, secondId]);
    await expect(f.broker.changeOrchestrator({ missionId: mission.id, targetMode: 'CHATGPT', expectedVersion: second.orchestratorVersion, handoffId: firstId }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.state.getMission(mission.id)).resolves.toMatchObject({ orchestratorMode: 'HERMES', orchestratorVersion: 3, orchestratorHandoffIds: [firstId, secondId] });
  });

  it('serializes broker quiescence revalidation against a concurrent supervisor directive', async () => {
    const f = await fixture();
    const store = new MissionBrokerStore(f.dataRoot);
    const broker = new MissionBrokerService(f.state, store);
    const mission = await f.state.createMission(f.session.clientId, f.session.id, 'Concurrent handoff safety');
    await broker.bindHermesSession({ missionId: mission.id, hermesSessionId: '20260906_011000_race', worktreePath: f.projectRoot, branch: 'acceptance' });
    const first = await broker.acceptDirective({ missionId: mission.id, expectedVersion: 1, directiveId: crypto.randomUUID(), directiveSequence: 1, decision: 'CONTINUE', instruction: 'Checkpoint first', authorizedScope: ['fixture'], doNot: ['bypass'], successCriteria: ['checkpoint'] });
    await broker.recordCheckpoint({ checkpointId: crypto.randomUUID(), missionId: mission.id, missionVersion: first.missionVersion, state: 'WAITING_SUPERVISOR', currentPhase: 'race', summary: 'Safe before concurrent directive', evidenceRefs: ['race:ready'], blockers: [], hermesAssessment: 'Checkpointed', proposedNextAction: 'Wait', decisionRequired: true, createdAt: new Date().toISOString() });
    await f.state.setMissionState(mission.id, f.session.clientId, f.session.id, 'WAITING_SUPERVISOR');

    let releaseWrite!: () => void;
    let directiveWriteObserved!: () => void;
    const holdWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeObserved = new Promise<void>((resolve) => { directiveWriteObserved = resolve; });
    const originalWrite = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (document) => {
      if (document.records[0]?.lastDirectiveSequence === 2) {
        directiveWriteObserved();
        await holdWrite;
      }
      await originalWrite(document);
    });

    const directive = broker.acceptDirective({ missionId: mission.id, expectedVersion: first.missionVersion, directiveId: crypto.randomUUID(), directiveSequence: 2, decision: 'CONTINUE', instruction: 'Resume Hermes now', authorizedScope: ['fixture'], doNot: ['handoff'], successCriteria: ['continue'] });
    await writeObserved;
    const handoff = broker.changeOrchestrator({ missionId: mission.id, targetMode: 'CHATGPT', expectedVersion: 1, handoffId: crypto.randomUUID() });
    releaseWrite();

    await expect(directive).resolves.toMatchObject({ state: 'ACTIVE', lastDirectiveSequence: 2 });
    await expect(handoff).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(f.state.getMission(mission.id)).resolves.toMatchObject({ orchestratorMode: 'HERMES', orchestratorVersion: 1 });
  });

  it('blocks handoff during RUNNING action, pending owner approval, or active uncheckpointed Hermes continuation', async () => {
    const running = await fixture();
    const r = await prepared(running, 'HERMES');
    await running.state.markMissionActionStarted({ missionId: r.mission.id, taskId: r.taskId, actionId: r.actionId, orchestratorMode: 'HERMES' });
    await expect(running.broker.changeOrchestrator({ missionId: r.mission.id, targetMode: 'CHATGPT', expectedVersion: 1, handoffId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const approval = await fixture();
    await approval.settings.setMode('ASK_EVERY_TIME');
    const a = await prepared(approval, 'HERMES');
    const pending = await approval.service.execute({ capabilityId: 'file.write', clientId: approval.session.clientId, sessionId: approval.session.id, projectId: approval.project.id, targetPath: path.join(approval.projectRoot, 'pending.txt'), content: 'pending', mission: { missionId: a.mission.id, taskId: a.taskId, actionId: a.actionId, orchestratorMode: 'HERMES' } });
    expect(pending.status).toBe('owner_required');
    await expect(approval.broker.changeOrchestrator({ missionId: a.mission.id, targetMode: 'CHATGPT', expectedVersion: 1, handoffId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const active = await fixture();
    const m = await active.state.createMission(active.session.clientId, active.session.id, 'Active Hermes');
    await active.broker.bindHermesSession({ missionId: m.id, hermesSessionId: '20260906_010100_active', worktreePath: active.projectRoot, branch: 'acceptance' });
    const mapping = await active.broker.acceptDirective({ missionId: m.id, expectedVersion: 1, directiveId: crypto.randomUUID(), directiveSequence: 1, decision: 'CONTINUE', instruction: 'Continue', authorizedScope: ['fixture'], doNot: ['bypass'], successCriteria: ['checkpoint'] });
    expect(mapping.state).toBe('ACTIVE');
    await expect(active.broker.changeOrchestrator({ missionId: m.id, targetMode: 'CHATGPT', expectedVersion: 1, handoffId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('revalidates the durable orchestrator when claiming an action after asynchronous policy evaluation', async () => {
    const f = await fixture();
    const p = await prepared(f, 'CHATGPT');
    const target = path.join(f.projectRoot, 'handoff-during-policy.txt');
    const originalEvaluate = f.policy.evaluate.bind(f.policy);
    let releaseEvaluation!: () => void;
    let evaluationStarted!: () => void;
    const holdEvaluation = new Promise<void>((resolve) => { releaseEvaluation = resolve; });
    const started = new Promise<void>((resolve) => { evaluationStarted = resolve; });
    vi.spyOn(f.policy, 'evaluate').mockImplementation(async (request) => {
      evaluationStarted();
      await holdEvaluation;
      return originalEvaluate(request);
    });

    const execution = f.service.execute({
      capabilityId: 'file.write', clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id,
      targetPath: target, content: 'must-not-run', mission: { missionId: p.mission.id, taskId: p.taskId, actionId: p.actionId, orchestratorMode: 'CHATGPT' },
    });
    await started;
    await f.broker.changeOrchestrator({ missionId: p.mission.id, targetMode: 'HERMES', expectedVersion: 1, handoffId: crypto.randomUUID() });
    releaseEvaluation();

    await expect(execution).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(f.state.getMission(p.mission.id)).resolves.toMatchObject({ orchestratorMode: 'HERMES', tasks: [{ actions: [{ state: 'PLANNED' }] }] });
  });

  it('enforces exactly one operational orchestrator at governed action execution and approval continuation', async () => {
    const f = await fixture();
    const p = await prepared(f, 'CHATGPT');
    const target = path.join(f.projectRoot, 'chatgpt.txt');
    await expect(f.service.execute({ capabilityId: 'file.write', clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id, targetPath: target, content: 'wrong-source', mission: { missionId: p.mission.id, taskId: p.taskId, actionId: p.actionId, orchestratorMode: 'HERMES' } })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    const result = await f.service.execute({ capabilityId: 'file.write', clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id, targetPath: target, content: 'chatgpt-only', mission: { missionId: p.mission.id, taskId: p.taskId, actionId: p.actionId, orchestratorMode: 'CHATGPT' } });
    expect(result.status).toBe('executed');
    await expect(readFile(target, 'utf8')).resolves.toBe('chatgpt-only');
  });

  it('supports CHATGPT to HERMES handoff only from a safe state and requires explicit exact Hermes binding', async () => {
    const f = await fixture();
    const mission = await f.state.createMission(f.session.clientId, f.session.id, 'ChatGPT direct', 'CHATGPT');
    await f.state.setMissionState(mission.id, f.session.clientId, f.session.id, 'PAUSED');
    const switched = await f.broker.changeOrchestrator({ missionId: mission.id, targetMode: 'HERMES', expectedVersion: 1, handoffId: crypto.randomUUID() });
    expect(switched.orchestratorMode).toBe('HERMES');
    await expect(f.broker.get(mission.id)).rejects.toMatchObject({ code: 'MISSION_NOT_FOUND' });
    const bound = await f.broker.bindHermesSession({ missionId: mission.id, hermesSessionId: '20260906_010200_exact', worktreePath: f.projectRoot, branch: 'acceptance' });
    expect(bound.hermesSessionId).toBe('20260906_010200_exact');
  });

  it('never replays a completed action after handoff and preserves one mode across restart', async () => {
    const f = await fixture();
    const p = await prepared(f, 'CHATGPT');
    const target = path.join(f.projectRoot, 'once.txt');
    await f.service.execute({ capabilityId: 'file.write', clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id, targetPath: target, content: 'once', mission: { missionId: p.mission.id, taskId: p.taskId, actionId: p.actionId, orchestratorMode: 'CHATGPT' } });
    await f.state.setMissionState(p.mission.id, f.session.clientId, f.session.id, 'PAUSED');
    await f.broker.changeOrchestrator({ missionId: p.mission.id, targetMode: 'HERMES', expectedVersion: 1, handoffId: crypto.randomUUID() });
    const restarted = new RuntimeState(new FoundationStateStore(f.dataRoot));
    const persisted = await restarted.getMission(p.mission.id);
    expect(persisted).toMatchObject({ orchestratorMode: 'HERMES', orchestratorVersion: 2 });
    const resumedSession = await restarted.rehydrateBrokerMissionSession(p.mission.id);
    await expect(new CapabilityService(restarted, new PermissionPolicyEngine(restarted, f.settings, f.sourceRoot, f.dataRoot, path.join(f.sourceRoot, 'legacy')), f.audit, () => ({ status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid, uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1, agentExecutorType: 'local-development-executor', productionModelConnected: false, apiUrl: '', mcpUrl: '' })).execute({ capabilityId: 'file.write', clientId: resumedSession.clientId, sessionId: resumedSession.id, projectId: f.project.id, targetPath: target, content: 'replay', mission: { missionId: p.mission.id, taskId: p.taskId, actionId: p.actionId, orchestratorMode: 'HERMES' } })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(readFile(target, 'utf8')).resolves.toBe('once');
  });
});
