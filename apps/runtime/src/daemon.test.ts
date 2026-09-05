import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeRuntimeAuthority } from './authority.js';
import { startDaemon } from './daemon.js';
import { readEndpoint, readRuntimeControl } from './persistence.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('daemon startup cleanup', () => {
  it('releases runtime authority when permission initialization fails', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-daemon-init-failure-'));
    roots.push(dataRoot);
    await writeFile(path.join(dataRoot, 'permissions.json'), '{not-json', { mode: 0o600 });

    await expect(startDaemon({ dataRoot, preferredPort: 0 })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await expect(probeRuntimeAuthority(dataRoot)).resolves.toEqual({ state: 'unowned' });
    await expect(readEndpoint(dataRoot)).resolves.toBeNull();
    await expect(readRuntimeControl(dataRoot)).resolves.toBeNull();
  });

  it('rehydrates only active broker-bound mission sessions across daemon restart and does not replay completed missions', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-daemon-mission-recovery-'));
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-daemon-mission-project-'));
    roots.push(dataRoot, projectRoot);
    await mkdir(path.join(projectRoot, 'fixture'));

    const first = await startDaemon({ dataRoot, preferredPort: 0 });
    const project = await first.state.registerProject('Mission Project', projectRoot);
    const session = first.state.createSession('chatgpt-supervisor', 'hermes-loop-engineer', 'implementer');
    await first.state.setSessionCurrentProject(session.id, session.clientId, project.id);
    const mission = await first.state.createMission(session.clientId, session.id, 'Restart-safe broker mission');
    await first.missionBroker.bindHermesSession({ missionId: mission.id, hermesSessionId: '20260905_210500_restart', worktreePath: project.rootPath, branch: 'proof' });
    const firstDirective = await first.missionBroker.acceptDirective({
      missionId: mission.id, expectedVersion: 1, directiveId: randomUUID(), directiveSequence: 1, decision: 'CONTINUE',
      instruction: 'Checkpoint before restart.', authorizedScope: ['mission only'], doNot: ['no permission grant'], successCriteria: ['restart recovery'],
    });
    await first.missionBroker.recordCheckpoint({
      checkpointId: randomUUID(), missionId: mission.id, missionVersion: firstDirective.missionVersion, state: 'WAITING_SUPERVISOR', currentPhase: 'restart-proof',
      summary: 'Checkpoint persisted before restart.', evidenceRefs: ['restart:before'], blockers: [], hermesAssessment: 'Ready to restart.', proposedNextAction: 'Resume same mission.', decisionRequired: true, createdAt: new Date().toISOString(),
    });
    await first.close();

    const second = await startDaemon({ dataRoot, preferredPort: 0 });
    expect(second.state.getSessionForClient(session.id, session.clientId)).toMatchObject({ id: session.id, clientId: session.clientId, currentProjectId: project.id, agentId: 'hermes-loop-engineer' });
    const recovered = await second.missionBroker.get(mission.id);
    expect(recovered).toMatchObject({ state: 'AWAITING_SUPERVISOR', missionVersion: 2, hermesSessionId: '20260905_210500_restart', lastDirectiveSequence: 1 });
    const completeDirective = await second.missionBroker.acceptDirective({
      missionId: mission.id, expectedVersion: 2, directiveId: randomUUID(), directiveSequence: 2, decision: 'COMPLETE',
      instruction: 'Complete after recovery.', authorizedScope: ['mission only'], doNot: ['no replay'], successCriteria: ['completed once'],
    });
    await second.missionBroker.markCompleted(mission.id, recovered.hermesSessionId, completeDirective.missionVersion);
    await second.close();

    const third = await startDaemon({ dataRoot, preferredPort: 0 });
    expect(() => third.state.getSessionForClient(session.id, session.clientId)).toThrowError(/Session not found/);
    await expect(third.missionBroker.get(mission.id)).resolves.toMatchObject({ state: 'COMPLETED', missionVersion: 3, lastDirectiveSequence: 2 });
    await third.close();
  });
});
