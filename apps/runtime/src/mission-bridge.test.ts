import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionBrokerService, MissionBrokerStore } from './mission-broker.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';
import { HermesSessionResumeAdapter, type HermesCommandRunner } from './hermes-session-adapter.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { startRuntimeServer, type RuntimeServerHandle } from './server.js';

const roots: string[] = [];
let server: RuntimeServerHandle | undefined;
afterEach(async () => {
  await server?.close(); server = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-v2-bridge-source-')); roots.push(sourceRoot);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-v2-bridge-data-')); roots.push(dataRoot);
  const projectRoot = path.join(sourceRoot, 'project'); await mkdir(projectRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('Bridge Project', projectRoot);
  const session = state.createSession('chatgpt-supervisor', 'hermes-loop-engineer', 'implementer');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const mission = await state.createMission(session.clientId, session.id, 'Bridge proof mission');
  const broker = new MissionBrokerService(state, new MissionBrokerStore(dataRoot));
  const mapping = await broker.bindHermesSession({ missionId: mission.id, hermesSessionId: '20260905_120000_bridge01', worktreePath: project.rootPath, branch: 'proof' });
  return { sourceRoot, dataRoot, projectRoot, state, project, session, mission, broker, mapping };
}

function directive(missionId: string, expectedVersion = 1, sequence = 1, decision: 'CONTINUE' | 'COMPLETE' = 'CONTINUE') {
  return {
    missionId, expectedVersion, directiveId: randomUUID(), directiveSequence: sequence, decision,
    instruction: decision === 'COMPLETE' ? 'Mark the proof mission complete.' : 'Report the branch and clean/dirty state using the governed IRIS tool.',
    authorizedScope: ['read-only project Git status'], doNot: ['do not mutate files', 'do not run git directly'], successCriteria: ['return bounded structured checkpoint'],
  } as const;
}

describe('durable V2 mission broker', () => {
  it('persists exact Hermes session mapping and requires explicit versioned rebind', async () => {
    const f = await fixture();
    const reloaded = new MissionBrokerService(new RuntimeState(new FoundationStateStore(f.dataRoot)), new MissionBrokerStore(f.dataRoot));
    await expect(reloaded.get(f.mission.id)).resolves.toMatchObject({ hermesSessionId: f.mapping.hermesSessionId, worktreePath: f.project.rootPath, branch: 'proof', missionVersion: 1 });
    await expect(f.broker.bindHermesSession({ missionId: f.mission.id, hermesSessionId: 'other-session', worktreePath: f.project.rootPath, branch: 'proof' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.broker.rebindHermesSession({ missionId: f.mission.id, expectedVersion: 9, hermesSessionId: 'other-session', worktreePath: f.project.rootPath, branch: 'proof' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const rebound = await f.broker.rebindHermesSession({ missionId: f.mission.id, expectedVersion: 1, hermesSessionId: 'other-session', worktreePath: f.project.rootPath, branch: 'proof' });
    expect(rebound).toMatchObject({ hermesSessionId: 'other-session', missionVersion: 2 });
  });

  it('persists structured checkpoint and durable supervisor-waiting state', async () => {
    const f = await fixture();
    const accepted = await f.broker.acceptDirective(directive(f.mission.id));
    const checkpointId = randomUUID();
    const checkpoint = await f.broker.recordCheckpoint({
      checkpointId, missionId: f.mission.id, missionVersion: accepted.missionVersion, state: 'WAITING_SUPERVISOR', currentPhase: 'git-status',
      summary: 'Hermes obtained governed project Git status.', evidenceRefs: ['project_git_status:proof:clean'], blockers: [],
      hermesAssessment: 'The worktree is clean.', proposedNextAction: 'Supervisor may complete the proof.', decisionRequired: true, createdAt: new Date().toISOString(),
    });
    expect(checkpoint).toMatchObject({ state: 'AWAITING_SUPERVISOR', lastCheckpointId: checkpointId });
    const reloaded = new MissionBrokerService(new RuntimeState(new FoundationStateStore(f.dataRoot)), new MissionBrokerStore(f.dataRoot));
    await expect(reloaded.get(f.mission.id)).resolves.toMatchObject({ state: 'AWAITING_SUPERVISOR', lastCheckpointId: checkpointId, missionVersion: 2 });
  });

  it('enforces directive version, idempotency, conflict, and ordering without granting permission', async () => {
    const f = await fixture();
    const first = directive(f.mission.id);
    const accepted = await f.broker.acceptDirective(first);
    expect(accepted.missionVersion).toBe(2);
    const duplicate = await f.broker.acceptDirective(first);
    expect(duplicate.missionVersion).toBe(2);
    await expect(f.broker.acceptDirective({ ...first, instruction: 'different content' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.broker.acceptDirective(directive(f.mission.id, 1, 2))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.broker.acceptDirective(directive(f.mission.id, 2, 3))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const second = await f.broker.acceptDirective(directive(f.mission.id, 2, 2, 'COMPLETE'));
    expect(second.missionVersion).toBe(3);
  });

  it('resumes only the exact mapped Hermes session and fails stale mappings intentionally', async () => {
    const f = await fixture();
    const accepted = await f.broker.acceptDirective(directive(f.mission.id));
    const latest = accepted.directives.at(-1)!;
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const runner: HermesCommandRunner = {
      run: async (args, cwd) => {
        calls.push({ args, cwd });
        return { exitCode: 0, stdout: JSON.stringify({ currentPhase: 'git-status', summary: 'done', evidenceRefs: ['project_git_status:proof:clean'], blockers: [], hermesAssessment: 'clean', proposedNextAction: 'supervisor decision', decisionRequired: true, missionComplete: false }), stderr: `↻ Resumed session ${accepted.hermesSessionId} "proof"\nsession_id: ${accepted.hermesSessionId}\n` };
      },
    };
    const receipt = await new HermesSessionResumeAdapter(runner).resumeExact(accepted, latest);
    expect(receipt.evidenceRefs).toContain('project_git_status:proof:clean');
    const resume = calls.find((call) => call.args.includes('--resume'))!;
    expect(resume.args).toContain(accepted.hermesSessionId);
    expect(resume.args).not.toContain('latest');
    expect(resume.cwd).toBe(accepted.worktreePath);
    expect(resume.args).toContain('iris_v2_bridge_proof');
    expect(resume.args).not.toContain('iris_v2_bridge_proof:project_git_status');
    expect(calls).toHaveLength(1);

    const malformedRunner: HermesCommandRunner = {
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ currentPhase: 'git-status', summary: 'done', evidenceRefs: [], blockers: [], hermesAssessment: 'clean', proposedNextAction: 'supervisor decision', decisionRequired: 'Supervisor review', missionComplete: false }),
        stderr: `↻ Resumed session ${accepted.hermesSessionId} "proof"\nsession_id: ${accepted.hermesSessionId}\n`,
      }),
    };
    await expect(new HermesSessionResumeAdapter(malformedRunner).resumeExact(accepted, latest)).rejects.toMatchObject({
      code: 'AGENT_EXECUTION_FAILED',
      message: 'Hermes checkpoint decisionRequired must be boolean',
    });

    const repairCalls: { args: readonly string[]; cwd: string }[] = [];
    const repairRunner: HermesCommandRunner = {
      run: async (args, cwd) => {
        repairCalls.push({ args, cwd });
        return {
          exitCode: 0,
          stdout: JSON.stringify({ currentPhase: 'delegated-read', summary: 'child proof preserved', evidenceRefs: ['delegation:proof', 'project_git_status:clean'], blockers: [], hermesAssessment: 'governed delegation succeeded', proposedNextAction: 'supervisor review', decisionRequired: true, missionComplete: false }),
          stderr: `↻ Resumed session ${accepted.hermesSessionId} "proof"\nsession_id: ${accepted.hermesSessionId}\n`,
        };
      },
    };
    const repaired = await new HermesSessionResumeAdapter(repairRunner).repairCheckpointReceipt(accepted, 'delegation proof and governed project_git_status already completed');
    expect(repaired).toMatchObject({ decisionRequired: true, missionComplete: false });
    expect(repairCalls).toHaveLength(1);
    expect(repairCalls[0]!.args).toContain(accepted.hermesSessionId);
    expect(repairCalls[0]!.args.join(' ')).toContain('Do NOT call tools');
    expect(repairCalls[0]!.args.join(' ')).toContain('--max-turns 2');

    const staleRunner: HermesCommandRunner = { run: async () => ({ exitCode: 1, stdout: '', stderr: `Session not found: ${accepted.hermesSessionId}\n` }) };
    await expect(new HermesSessionResumeAdapter(staleRunner).resumeExact(accepted, latest)).rejects.toMatchObject({ code: 'MISSION_NOT_FOUND' });
  });

  it('completes only after a COMPLETE directive and refuses replay after completion', async () => {
    const f = await fixture();
    await f.broker.acceptDirective(directive(f.mission.id));
    const final = await f.broker.acceptDirective(directive(f.mission.id, 2, 2, 'COMPLETE'));
    const completed = await f.broker.markCompleted(f.mission.id, final.hermesSessionId, final.missionVersion);
    expect(completed.state).toBe('COMPLETED');
    const runner: HermesCommandRunner = { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) };
    await expect(new HermesSessionResumeAdapter(runner).resumeExact(completed, completed.directives.at(-1)!)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const reloaded = new MissionBrokerService(new RuntimeState(new FoundationStateStore(f.dataRoot)), new MissionBrokerStore(f.dataRoot));
    await expect(reloaded.get(f.mission.id)).resolves.toMatchObject({ state: 'COMPLETED', missionVersion: 3, lastDirectiveSequence: 2 });
  });

  it('accepts a ChatGPT-style directive through the owner-authenticated broker HTTP ingress', async () => {
    const f = await fixture();
    const settings = new PermissionSettingsStore(f.dataRoot); await settings.initialize();
    const capabilities = new CapabilityService(f.state, new PermissionPolicyEngine(f.state, settings, f.sourceRoot, f.dataRoot), new PermissionAuditStore(f.dataRoot), () => ({
      status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: randomUUID(), instanceId: randomUUID(), pid: process.pid, uptimeMs: 1,
      authority: 'owned', connectedClients: 1, connectedSessions: 1, agentExecutorType: 'local-development-executor', productionModelConnected: false, apiUrl: '', mcpUrl: '',
    }));
    const ownerSecret = 'bridge-owner-access-secret-with-sufficient-length';
    server = await startRuntimeServer({
      identity: { runtimeId: randomUUID(), instanceId: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), platform: 'darwin', version: '0.0.0' },
      state: f.state, capabilities, missionBroker: f.broker,
      health: () => ({ status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'r', instanceId: 'i', pid: process.pid, uptimeMs: 1, authority: 'owned', connectedClients: 1, connectedSessions: 1, agentExecutorType: 'local-development-executor', productionModelConnected: false, apiUrl: '', mcpUrl: '' }),
      doctor: async () => ({ status: 'pass', checks: [] }), isShuttingDown: () => false, controlSecret: 'control-secret-with-sufficient-length', ownerAccessSecret: ownerSecret, requestShutdown: () => undefined,
    }, 0);
    const input = directive(f.mission.id);
    const response = await fetch(`${server.apiUrl}/missions/${f.mission.id}/directives`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSecret}` }, body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ missionVersion: 2, lastDirectiveSequence: 1, lastDirectiveId: input.directiveId });
  });
});
