import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeError, type MissionSnapshot } from '@iris/domain';
import type { AgentExecutor } from './agent-executor.js';
import { MissionLedgerStore, missionArchiveEligible } from './mission-store.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('runtime machine, client, and session state', () => {
  it('keeps default project machine-shared and current project session-scoped', async () => {
    const dataRoot = await temp('iris-state-data-');
    const firstRoot = await temp('iris-state-project-a-');
    const secondRoot = await temp('iris-state-project-b-');
    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    const firstProject = await state.registerProject('First', firstRoot);
    const secondProject = await state.registerProject('Second', secondRoot);
    await state.setDefaultProject(firstProject.id);

    const firstSession = state.createSession('client-a');
    const secondSession = state.createSession('client-b');
    await state.setSessionCurrentProject(firstSession.id, 'client-a', firstProject.id);
    await state.setSessionCurrentProject(secondSession.id, 'client-b', secondProject.id);

    expect(await state.getDefaultProjectId()).toBe(firstProject.id);
    expect(state.getSessionForClient(firstSession.id, 'client-a').currentProjectId).toBe(firstProject.id);
    expect(state.getSessionForClient(secondSession.id, 'client-b').currentProjectId).toBe(secondProject.id);
    expect(state.listClients()).toHaveLength(2);
  });

  it('supports concurrent agent roles on one daemon without sharing session identity', async () => {
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-agent-state-')));
    const roles = ['planner', 'implementer', 'reviewer', 'security', 'explorer'] as const;
    const sessions = roles.map((role) => state.createSession(`client-${role}`, `agent-${role}`, role));

    expect(new Set(sessions.map((session) => session.agentId))).toEqual(new Set(roles.map((role) => `agent-${role}`)));
    expect(new Set(sessions.map((session) => session.agentRole))).toEqual(new Set(roles));
    expect(new Set(sessions.map((session) => session.id)).size).toBe(roles.length);
    expect(state.listClients()).toHaveLength(roles.length);
  });

  it('lists only sessions owned by the requesting client so reconnect can resume without cross-client leakage', async () => {
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-state-data-')));
    const first = state.createSession('client-a', 'owner-web', 'owner');
    const second = state.createSession('client-a', 'owner-web', 'owner');
    state.createSession('client-b', 'other-web', 'owner');

    expect(state.listSessionsForClient('client-a').map((session) => session.id)).toEqual([first.id, second.id]);
    expect(state.listSessionsForClient('client-b')).toHaveLength(1);
  });

  it('records one authoritative instruction/result pair and deduplicates the same submission id', async () => {
    let executions = 0;
    const executor: AgentExecutor = {
      descriptor: { type: 'other', productionModelConnected: false },
      execute: async ({ instruction }) => {
        executions += 1;
        return { text: `result:${instruction}` };
      },
    };
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-agent-interaction-')), executor);
    const session = state.createSession('client-a', 'owner-web', 'owner');

    const completed = await state.submitInstruction(session.id, session.clientId, 'submission-1', 'Do the bounded thing');
    expect(completed.executionState).toBe('READY');
    expect(completed.interactions.map((event) => [event.kind, event.text])).toEqual([
      ['user', 'Do the bounded thing'],
      ['assistant', 'result:Do the bounded thing'],
    ]);
    const duplicate = await state.submitInstruction(session.id, session.clientId, 'submission-1', 'Do the bounded thing');
    expect(executions).toBe(1);
    expect(duplicate.interactions).toHaveLength(2);

    await expect(state.submitInstruction(session.id, session.clientId, 'submission-1', 'Do a different thing'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(executions).toBe(1);
    expect(state.getSessionForClient(session.id, session.clientId).interactions).toEqual(completed.interactions);
  });

  it('keeps overlapping execution, duplicate protection, and outputs isolated per session', async () => {
    const resolvers = new Map<string, (value: { text: string }) => void>();
    const executor: AgentExecutor = {
      descriptor: { type: 'other', productionModelConnected: false },
      execute: ({ sessionId }) => new Promise((resolve) => { resolvers.set(sessionId, resolve); }),
    };
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-agent-overlap-')), executor);
    const sessionA = state.createSession('client-a', 'agent-a', 'implementer');
    const sessionB = state.createSession('client-b', 'agent-b', 'planner');

    const pendingA = state.submitInstruction(sessionA.id, sessionA.clientId, 'a-1', 'Instruction A');
    const pendingB = state.submitInstruction(sessionB.id, sessionB.clientId, 'b-1', 'Instruction B');
    expect(state.getSessionForClient(sessionA.id, sessionA.clientId).executionState).toBe('WORKING');
    expect(state.getSessionForClient(sessionB.id, sessionB.clientId).executionState).toBe('WORKING');

    const duplicateA = await state.submitInstruction(sessionA.id, sessionA.clientId, 'a-1', 'Instruction A');
    expect(duplicateA.interactions.filter((event) => event.kind === 'user')).toHaveLength(1);
    await expect(state.submitInstruction(sessionA.id, sessionA.clientId, 'a-1', 'Conflicting A'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(state.getSessionForClient(sessionA.id, sessionA.clientId).interactions.filter((event) => event.kind === 'user')).toHaveLength(1);
    await expect(state.submitInstruction(sessionA.id, sessionA.clientId, 'a-2', 'Second A')).rejects.toMatchObject({ code: 'SESSION_BUSY' });

    resolvers.get(sessionB.id)?.({ text: 'Output B' });
    await pendingB;
    expect(state.getSessionForClient(sessionB.id, sessionB.clientId).interactions.at(-1)?.text).toBe('Output B');
    expect(state.getSessionForClient(sessionA.id, sessionA.clientId).executionState).toBe('WORKING');
    expect(state.getSessionForClient(sessionA.id, sessionA.clientId).interactions.some((event) => event.text === 'Output B')).toBe(false);

    resolvers.get(sessionA.id)?.({ text: 'Output A' });
    await pendingA;
    expect(state.getSessionForClient(sessionA.id, sessionA.clientId).interactions.at(-1)?.text).toBe('Output A');
    expect(state.getSessionForClient(sessionB.id, sessionB.clientId).interactions.some((event) => event.text === 'Output A')).toBe(false);
  });

  it('scopes submission bindings to the authoritative session instead of globally', async () => {
    const executions: string[] = [];
    const executor: AgentExecutor = {
      descriptor: { type: 'other', productionModelConnected: false },
      execute: async ({ sessionId, instruction }) => {
        executions.push(`${sessionId}:${instruction}`);
        return { text: `result:${instruction}` };
      },
    };
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-agent-submission-scope-')), executor);
    const sessionA = state.createSession('client-a');
    const sessionB = state.createSession('client-b');

    const completedA = await state.submitInstruction(sessionA.id, sessionA.clientId, 'shared-submission', 'Instruction A');
    const completedB = await state.submitInstruction(sessionB.id, sessionB.clientId, 'shared-submission', 'Instruction B');

    expect(executions).toHaveLength(2);
    expect(completedA.interactions.at(-1)?.text).toBe('result:Instruction A');
    expect(completedB.interactions.at(-1)?.text).toBe('result:Instruction B');
  });

  it('records only a product-safe executor failure on the originating session and permits later retry', async () => {
    let fail = true;
    const sensitiveDiagnostic = 'provider failed api_key=secret internal_path=/private/example';
    const executor: AgentExecutor = {
      descriptor: { type: 'other', productionModelConnected: false },
      execute: async ({ instruction }) => {
        if (fail) throw new Error(sensitiveDiagnostic);
        return { text: `recovered:${instruction}` };
      },
    };
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-agent-failure-')), executor);
    const failedSession = state.createSession('client-a');
    const otherSession = state.createSession('client-b');

    const failure = state.submitInstruction(failedSession.id, failedSession.clientId, 'failure-1', 'Fail once');
    await expect(failure).rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED', message: 'Agent execution failed' });
    const failed = state.getSessionForClient(failedSession.id, failedSession.clientId);
    expect(failed.executionState).toBe('FAILED');
    expect(failed.interactions.map((event) => event.kind)).toEqual(['user', 'error']);
    expect(failed.interactions.at(-1)?.text).toBe('Execution could not be completed.');
    expect(JSON.stringify(failed.interactions)).not.toContain('api_key=secret');
    expect(JSON.stringify(failed.interactions)).not.toContain('/private/example');
    expect(state.getSessionForClient(otherSession.id, otherSession.clientId).interactions).toEqual([]);

    fail = false;
    const recovered = await state.submitInstruction(failedSession.id, failedSession.clientId, 'recovery-1', 'Try again');
    expect(recovered.executionState).toBe('READY');
    expect(recovered.interactions.at(-1)?.text).toBe('recovered:Try again');
  });

  it.each([
    ['runtime error', new RuntimeError('AGENT_EXECUTION_FAILED', 'provider failed api_key=secret internal_path=/private/example')],
    ['plain error', new Error('provider failed api_key=secret internal_path=/private/example')],
    ['arbitrary value', { diagnostic: 'api_key=secret', internalPath: '/private/example' }],
  ])('sanitizes executor-originated %s before it crosses the product boundary', async (_label, thrownValue) => {
    const executor: AgentExecutor = {
      descriptor: { type: 'other', productionModelConnected: false },
      execute: async () => { throw thrownValue; },
    };
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-agent-executor-sanitize-')), executor);
    const session = state.createSession('client-a');

    const failure = state.submitInstruction(session.id, session.clientId, 'sanitize-1', 'Fail safely');
    await expect(failure).rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED', message: 'Agent execution failed' });

    const failed = state.getSessionForClient(session.id, session.clientId);
    expect(failed.executionState).toBe('FAILED');
    expect(failed.interactions.at(-1)?.text).toBe('Execution could not be completed.');
    const productHistory = JSON.stringify(failed.interactions);
    expect(productHistory).not.toContain('api_key=secret');
    expect(productHistory).not.toContain('/private/example');
  });

  it('prevents one client from operating another client session', async () => {
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-state-data-')));
    const session = state.createSession('client-a');
    expect(() => state.getSessionForClient(session.id, 'client-b')).toThrowError(expect.objectContaining({ code: 'CONTROL_DENIED' }));
    await expect(state.setSessionCurrentProject(session.id, 'client-b', null)).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  });

  it('registers canonical existing non-root directories only and never scans implicitly', async () => {
    const dataRoot = await temp('iris-state-data-');
    const projectRoot = await temp('iris-state-project-');
    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    await expect(state.registerProject('Project', 'relative/path')).rejects.toMatchObject({ code: 'INVALID_PROJECT_PATH' });
    await expect(state.registerProject('Root', path.parse(projectRoot).root)).rejects.toMatchObject({ code: 'INVALID_PROJECT_PATH' });
    const project = await state.registerProject('Project', projectRoot);
    expect((await state.listProjects()).map((entry) => entry.id)).toEqual([project.id]);
    expect((await state.registerProject('Duplicate name ignored', projectRoot)).id).toBe(project.id);
  });

  it('publishes mission archive records idempotently without rewriting the first immutable receipt', async () => {
    const dataRoot = await temp('iris-mission-archive-idempotent-');
    const store = new MissionLedgerStore(dataRoot);
    const mission = seededMission(randomUUID(), 0, 'COMPLETED');

    await store.archiveForCapacity(mission);
    const filename = path.join(dataRoot, 'mission-archive', `${mission.id}.json`);
    const first = await readFile(filename, 'utf8');
    await store.archiveForCapacity(mission);
    const second = await readFile(filename, 'utf8');

    expect(second).toBe(first);
    await expect(store.readArchived(mission.id)).resolves.toMatchObject({ id: mission.id, state: 'COMPLETED' });
  });

  it('fails closed when the mission archive parent is replaced by a symlink', async () => {
    const dataRoot = await temp('iris-mission-archive-symlink-');
    const external = await temp('iris-mission-archive-external-');
    await symlink(external, path.join(dataRoot, 'mission-archive'));
    const store = new MissionLedgerStore(dataRoot);

    await expect(store.readArchived(randomUUID())).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('does not archive a completed native code-review action until terminal review evidence is attached', () => {
    const base = seededMission(randomUUID(), 0, 'COMPLETED');
    const timestamp = base.updatedAt;
    const candidate: MissionSnapshot = {
      ...base,
      tasks: [{
        id: randomUUID(),
        title: 'Native review',
        state: 'COMPLETED',
        createdAt: timestamp,
        updatedAt: timestamp,
        actions: [{
          id: randomUUID(),
          capabilityId: 'code_review.start',
          summary: 'Review without finalized receipt',
          state: 'SUCCEEDED',
          createdAt: timestamp,
          updatedAt: timestamp,
          approvalId: null,
          result: {
            status: 'SUCCEEDED',
            summary: 'Governed capability executed successfully',
            approvalId: null,
            completedAt: timestamp,
            evidence: [{
              id: randomUUID(),
              kind: 'CAPABILITY_RESULT',
              label: 'code_review.start',
              summary: 'Review job started',
              reference: null,
              data: {},
            }],
          },
        }],
      }],
    };
    expect(missionArchiveEligible(candidate)).toBe(false);
  });

  it('archives one safe completed mission when the active ledger reaches capacity and preserves retrieval by id', async () => {
    const dataRoot = await temp('iris-mission-capacity-archive-');
    const store = new MissionLedgerStore(dataRoot);
    const state = new RuntimeState(new FoundationStateStore(dataRoot), undefined, store);
    const session = state.createSession('client-a', 'owner-web', 'owner');
    const archived = seededMission(session.id, 0, 'COMPLETED');
    const active = Array.from({ length: 99 }, (_, index) => seededMission(session.id, index + 1, 'PLANNED'));
    await store.write({ schemaVersion: 1, missions: [archived, ...active] });

    const created = await state.createMission(session.clientId, session.id, 'Mission after capacity archival', 'CHATGPT');

    const missions = await state.listMissions();
    expect(missions).toHaveLength(100);
    expect(missions.some((mission) => mission.id === archived.id)).toBe(false);
    expect(missions.some((mission) => mission.id === created.id)).toBe(true);
    await expect(state.getMission(archived.id)).resolves.toMatchObject({
      id: archived.id,
      title: archived.title,
      state: 'COMPLETED',
    });
    const record = JSON.parse(await readFile(path.join(dataRoot, 'mission-archive', `${archived.id}.json`), 'utf8')) as {
      reason: string;
      mission: { id: string };
    };
    expect(record).toMatchObject({
      reason: 'ACTIVE_LEDGER_CAPACITY',
      mission: { id: archived.id },
    });
  });

  it('fails closed at mission capacity when the only completed record still has pending execution authority', async () => {
    const dataRoot = await temp('iris-mission-capacity-no-safe-archive-');
    const store = new MissionLedgerStore(dataRoot);
    const state = new RuntimeState(new FoundationStateStore(dataRoot), undefined, store);
    const session = state.createSession('client-a', 'owner-web', 'owner');
    const unsafeCompleted = seededMission(session.id, 0, 'COMPLETED', true);
    const active = Array.from({ length: 99 }, (_, index) => seededMission(session.id, index + 1, 'PLANNED'));
    await store.write({ schemaVersion: 1, missions: [unsafeCompleted, ...active] });

    await expect(state.createMission(session.clientId, session.id, 'Must remain blocked', 'CHATGPT'))
      .rejects.toMatchObject({
        code: 'CAPABILITY_DENIED',
        message: 'Mission ledger capacity has been reached and no safely archivable completed mission exists',
      });
    expect(await state.listMissions()).toHaveLength(100);
    await expect(readFile(path.join(dataRoot, 'mission-archive', `${unsafeCompleted.id}.json`), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent machine-shared registry mutations without lost updates', async () => {
    const dataRoot = await temp('iris-state-data-');
    const firstRoot = await temp('iris-concurrent-project-a-');
    const secondRoot = await temp('iris-concurrent-project-b-');
    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    const [first, second] = await Promise.all([
      state.registerProject('First', firstRoot),
      state.registerProject('Second', secondRoot),
    ]);
    expect(new Set((await state.listProjects()).map((project) => project.id))).toEqual(new Set([first.id, second.id]));
  });
});

function seededMission(
  sessionId: string,
  index: number,
  state: MissionSnapshot['state'],
  pendingAuthority = false,
): MissionSnapshot {
  const timestamp = new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString();
  const taskId = randomUUID();
  const actionId = randomUUID();
  const approvalId = randomUUID();
  return {
    id: randomUUID(),
    title: `Seed mission ${index}`,
    state,
    orchestratorMode: 'CHATGPT',
    orchestratorVersion: 1,
    lastOrchestratorHandoff: null,
    orchestratorHandoffIds: [],
    ownerClientId: 'client-a',
    bindingRevision: 1,
    rebindAudit: [],
    clientId: 'client-a',
    sessionId,
    projectId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    supervisorGate: { state: 'NOT_REQUIRED', reason: null, updatedAt: timestamp },
    tasks: pendingAuthority ? [{
      id: taskId,
      title: 'Pending authority',
      state: 'COMPLETED',
      createdAt: timestamp,
      updatedAt: timestamp,
      actions: [{
        id: actionId,
        capabilityId: 'file.write',
        summary: 'Pending owner-approved mutation',
        state: 'OWNER_APPROVAL_REQUIRED',
        createdAt: timestamp,
        updatedAt: timestamp,
        approvalId,
        result: {
          status: 'OWNER_REQUIRED',
          summary: 'Owner approval required',
          approvalId,
          completedAt: null,
          evidence: [],
        },
      }],
    }] : [],
    timeline: [{
      id: randomUUID(),
      timestamp,
      kind: 'MISSION_CREATED',
      taskId: null,
      actionId: null,
      message: 'Seed mission',
    }],
  };
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
