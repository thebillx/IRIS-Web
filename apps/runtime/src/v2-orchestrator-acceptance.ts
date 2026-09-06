import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeError, type PendingApprovalView } from '@iris/domain';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { MCP_PROTOCOL_VERSION } from './mcp.js';
import { readOwnerAccessSecret } from './persistence.js';
import { hermesMissionAccessToken } from './server.js';

interface RpcEnvelope<T> {
  readonly result?: { readonly isError: boolean; readonly structuredContent: T };
  readonly error?: { readonly code: number; readonly message: string };
}

interface AcceptanceMission {
  readonly id: string;
  readonly orchestratorMode: 'HERMES' | 'CHATGPT';
  readonly orchestratorVersion: number;
  readonly state: string;
  readonly tasks: readonly { readonly id: string; readonly actions: readonly { readonly id: string; readonly capabilityId: string; readonly state: string; readonly result: unknown }[] }[];
}

export interface V2OrchestratorAcceptanceReport {
  readonly chatgptMissionId: string;
  readonly chatgptModeNoHermesRequired: boolean;
  readonly chatgptGovernedRead: boolean;
  readonly chatgptInitialTestFailed: boolean;
  readonly chatgptGovernedMutationApproved: boolean;
  readonly chatgptFinalTestPassed: boolean;
  readonly chatgptMissionCompleted: boolean;
  readonly chatgptRestartDurable: boolean;
  readonly hermesToChatgptHandoff: boolean;
  readonly hermesDisabledAfterHandoff: boolean;
  readonly chatgptContinuedSameMission: boolean;
  readonly chatgptToHermesHandoff: boolean;
  readonly exactHermesSessionBinding: boolean;
  readonly chatgptDisabledAfterReverseHandoff: boolean;
  readonly doubleOrchestrationObserved: boolean;
}

export async function runV2OrchestratorAcceptance(): Promise<V2OrchestratorAcceptanceReport> {
  if (process.platform !== 'darwin') throw new RuntimeError('CAPABILITY_DENIED', 'V2 orchestrator acceptance is macOS-only');
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-v2-orchestrator-project-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-v2-orchestrator-data-'));
  await writeFixture(fixtureRoot);
  let daemon: DaemonHandle | undefined;
  try {
    daemon = await startDaemon({ dataRoot, preferredPort: 0 });
    const ownerSecret = await readOwnerAccessSecret(dataRoot);
    if (ownerSecret === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Acceptance owner credential is unavailable');
    const project = await ownerMutation<{ id: string; rootPath: string }>(daemon.apiUrl, ownerSecret, '/projects', 'POST', { name: 'V2 Orchestrator Acceptance', rootPath: fixtureRoot });
    const session = await ownerMutation<{ id: string; clientId: string }>(daemon.apiUrl, ownerSecret, '/sessions', 'POST', { clientId: 'chatgpt-orchestrator-acceptance', agentId: 'chatgpt-direct-orchestrator', agentRole: 'owner' });
    await ownerMutation(daemon.apiUrl, ownerSecret, `/sessions/${encodeURIComponent(session.id)}/current-project`, 'PUT', { projectId: project.id }, { 'x-iris-client-id': session.clientId });
    await ownerMutation(daemon.apiUrl, ownerSecret, '/permissions/mode', 'POST', { mode: 'AUTO_APPROVE_LOW_RISK' });

    const chatgpt = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_create', { title: 'ChatGPT direct V2 acceptance', orchestratorMode: 'CHATGPT' });
    if (chatgpt.orchestratorMode !== 'CHATGPT') throw new RuntimeError('CAPABILITY_DENIED', 'CHATGPT acceptance mission did not persist the requested orchestrator mode');
    let mission = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_task_create', { missionId: chatgpt.id, title: 'Recover disposable fixture directly through IRIS' });
    const taskId = mission.tasks[0]!.id;

    mission = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_action_prepare', { missionId: chatgpt.id, taskId, capabilityId: 'file.read', summary: 'Read current fixture value' });
    const readActionId = mission.tasks[0]!.actions.at(-1)!.id;
    const read = await mcpTool<{ targetPath: string; content: string }>(daemon, ownerSecret, session, 'file_read', { projectId: project.id, targetPath: path.join(project.rootPath, 'value.txt'), missionId: chatgpt.id, taskId, actionId: readActionId });
    const chatgptGovernedRead = read.content === 'broken\n';

    mission = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_action_prepare', { missionId: chatgpt.id, taskId, capabilityId: 'project.test.run', summary: 'Confirm the fixture initially fails' });
    const initialTestActionId = mission.tasks[0]!.actions.at(-1)!.id;
    const initialPending = await mcpRaw<Record<string, unknown>>(daemon, ownerSecret, session, 'project_test_run', { projectId: project.id, missionId: chatgpt.id, taskId, actionId: initialTestActionId });
    const initialApproval = pendingApproval(initialPending);
    const initialTest = await ownerApprove<{ passed: boolean; exitCode: number | null }>(daemon.apiUrl, ownerSecret, initialApproval.id, 'ALWAYS_ALLOW_PROJECT');
    const chatgptInitialTestFailed = initialTest.passed === false && initialTest.exitCode !== 0;

    mission = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_action_prepare', { missionId: chatgpt.id, taskId, capabilityId: 'file.write', summary: 'Apply one exact fixture correction' });
    const writeActionId = mission.tasks[0]!.actions.at(-1)!.id;
    const writePending = await mcpRaw<Record<string, unknown>>(daemon, ownerSecret, session, 'file_write', { projectId: project.id, targetPath: path.join(project.rootPath, 'value.txt'), content: 'fixed\n', missionId: chatgpt.id, taskId, actionId: writeActionId });
    const writeApproval = pendingApproval(writePending);
    await ownerApprove(daemon.apiUrl, ownerSecret, writeApproval.id, 'ALLOW_ONCE');
    const chatgptGovernedMutationApproved = await readFile(path.join(project.rootPath, 'value.txt'), 'utf8') === 'fixed\n';

    mission = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_action_prepare', { missionId: chatgpt.id, taskId, capabilityId: 'project.test.run', summary: 'Validate the corrected fixture' });
    const finalTestActionId = mission.tasks[0]!.actions.at(-1)!.id;
    const finalTest = await mcpTool<{ passed: boolean; exitCode: number | null }>(daemon, ownerSecret, session, 'project_test_run', { projectId: project.id, missionId: chatgpt.id, taskId, actionId: finalTestActionId });
    const chatgptFinalTestPassed = finalTest.passed === true && finalTest.exitCode === 0;
    const completed = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_state_set', { missionId: chatgpt.id, state: 'COMPLETED' });
    const chatgptMissionCompleted = completed.state === 'COMPLETED';

    const hermesMission = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_create', { title: 'Hermes to ChatGPT handoff acceptance' });
    const exactHermesBefore = '20260906_011500_handoff_a';
    await daemon.missionBroker.bindHermesSession({ missionId: hermesMission.id, hermesSessionId: exactHermesBefore, worktreePath: project.rootPath, branch: 'acceptance' });
    await daemon.missionBroker.recordCheckpoint({ checkpointId: randomUUID(), missionId: hermesMission.id, missionVersion: 1, state: 'WAITING_SUPERVISOR', currentPhase: 'SAFE_HANDOFF', summary: 'Hermes is checkpointed for orchestrator handoff.', evidenceRefs: ['handoff:quiescent'], blockers: [], hermesAssessment: 'No active action or continuation remains.', proposedNextAction: 'Switch to ChatGPT Direct.', decisionRequired: true, createdAt: new Date().toISOString() });
    const handedToChatgpt = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_orchestrator_handoff', { missionId: hermesMission.id, targetMode: 'CHATGPT', expectedVersion: 1, handoffId: randomUUID() });
    const hermesToChatgptHandoff = handedToChatgpt.orchestratorMode === 'CHATGPT' && handedToChatgpt.orchestratorVersion === 2;
    const hermesDisabled = await hermesToolRejected(daemon, ownerSecret, hermesMission.id, 'runtime_status');
    const continued = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_task_create', { missionId: hermesMission.id, title: 'ChatGPT continues same durable mission' });
    const chatgptContinuedSameMission = continued.id === hermesMission.id && continued.tasks.length === 1;

    const reverseMission = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_create', { title: 'ChatGPT to Hermes handoff acceptance', orchestratorMode: 'CHATGPT' });
    await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_state_set', { missionId: reverseMission.id, state: 'PAUSED' });
    const handedToHermes = await mcpTool<AcceptanceMission>(daemon, ownerSecret, session, 'mission_orchestrator_handoff', { missionId: reverseMission.id, targetMode: 'HERMES', expectedVersion: 1, handoffId: randomUUID() });
    const exactHermesAfter = '20260906_011600_handoff_b';
    const bound = await daemon.missionBroker.bindHermesSession({ missionId: reverseMission.id, hermesSessionId: exactHermesAfter, worktreePath: project.rootPath, branch: 'acceptance' });
    const rejectedChatgpt = await mcpToolRejected(daemon, ownerSecret, session, 'mission_task_create', { missionId: reverseMission.id, title: 'Must not execute after reverse handoff' });
    const chatgptToHermesHandoff = handedToHermes.orchestratorMode === 'HERMES' && handedToHermes.orchestratorVersion === 2;
    const exactHermesSessionBinding = bound.hermesSessionId === exactHermesAfter;

    await daemon.close();
    daemon = await startDaemon({ dataRoot, preferredPort: 0 });
    const restartedChatgpt = await daemon.state.getMission(chatgpt.id);
    const replayRejectedAfterRestart = await mcpToolRejected(daemon, ownerSecret, session, 'file_write', {
      projectId: project.id,
      targetPath: path.join(project.rootPath, 'value.txt'),
      content: 'must-not-replay\n',
      missionId: chatgpt.id,
      taskId,
      actionId: writeActionId,
    });
    const chatgptRestartDurable = restartedChatgpt.orchestratorMode === 'CHATGPT'
      && restartedChatgpt.state === 'COMPLETED'
      && replayRejectedAfterRestart
      && await readFile(path.join(project.rootPath, 'value.txt'), 'utf8') === 'fixed\n';

    const report: V2OrchestratorAcceptanceReport = {
      chatgptMissionId: chatgpt.id,
      chatgptModeNoHermesRequired: (await daemon.missionBroker.list()).every((record) => record.missionId !== chatgpt.id),
      chatgptGovernedRead,
      chatgptInitialTestFailed,
      chatgptGovernedMutationApproved,
      chatgptFinalTestPassed,
      chatgptMissionCompleted,
      chatgptRestartDurable,
      hermesToChatgptHandoff,
      hermesDisabledAfterHandoff: hermesDisabled,
      chatgptContinuedSameMission,
      chatgptToHermesHandoff,
      exactHermesSessionBinding,
      chatgptDisabledAfterReverseHandoff: rejectedChatgpt,
      doubleOrchestrationObserved: !hermesDisabled || !rejectedChatgpt,
    };
    if (Object.entries(report).some(([key, value]) => key !== 'chatgptMissionId' && (key === 'doubleOrchestrationObserved' ? value !== false : value !== true))) {
      throw new RuntimeError('CAPABILITY_DENIED', `V2 orchestrator acceptance report contains a failed invariant: ${JSON.stringify(report)}`);
    }
    return report;
  } finally {
    await daemon?.close().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeFixture(root: string): Promise<void> {
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ private: true, scripts: { test: 'node test.mjs' } }, null, 2)}\n`);
  await writeFile(path.join(root, 'test.mjs'), "import { readFileSync } from 'node:fs'; const value=readFileSync('value.txt','utf8'); if(value!=='fixed\\n'){ console.error('V2_CHATGPT_TEST_FAIL'); process.exit(1); } console.log('V2_CHATGPT_TEST_PASS');\n");
  await writeFile(path.join(root, 'value.txt'), 'broken\n');
}

async function mcpTool<T>(daemon: DaemonHandle, ownerSecret: string, session: { id: string; clientId: string }, name: string, args: Record<string, unknown>): Promise<T> {
  const envelope = await mcpRaw<T>(daemon, ownerSecret, session, name, args);
  if (envelope.result === undefined || envelope.result.isError || envelope.error !== undefined) {
    const detail = envelope.result?.structuredContent;
    const safeDetail = typeof detail === 'object' && detail !== null && 'code' in detail && 'message' in detail
      ? `${String((detail as { code: unknown }).code)}: ${String((detail as { message: unknown }).message)}`
      : 'bounded tool error';
    throw new RuntimeError('CAPABILITY_DENIED', `MCP tool ${name} failed safely (${safeDetail})`);
  }
  return envelope.result.structuredContent;
}

async function mcpRaw<T>(daemon: DaemonHandle, ownerSecret: string, session: { id: string; clientId: string }, name: string, args: Record<string, unknown>): Promise<RpcEnvelope<T>> {
  const response = await fetch(`${daemon.apiUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSecret}`, 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'Mcp-Method': 'tools/call', 'Mcp-Name': name, 'x-iris-client-id': session.clientId, 'x-iris-session-id': session.id },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!response.ok) throw new RuntimeError('CONTROL_DENIED', `MCP tool ${name} returned HTTP ${response.status}`);
  return response.json() as Promise<RpcEnvelope<T>>;
}

async function mcpToolRejected(daemon: DaemonHandle, ownerSecret: string, session: { id: string; clientId: string }, name: string, args: Record<string, unknown>): Promise<boolean> {
  const envelope = await mcpRaw<Record<string, unknown>>(daemon, ownerSecret, session, name, args);
  return envelope.result?.isError === true;
}

function pendingApproval(envelope: RpcEnvelope<Record<string, unknown>>): PendingApprovalView {
  const value = envelope.result?.structuredContent;
  if (envelope.result?.isError !== true || value === undefined || value.code !== 'OWNER_DECISION_REQUIRED' || typeof value.approval !== 'object' || value.approval === null) {
    throw new RuntimeError('OWNER_DECISION_REQUIRED', 'Acceptance expected an exact owner approval');
  }
  return value.approval as PendingApprovalView;
}

async function ownerMutation<T = unknown>(apiUrl: string, ownerSecret: string, pathname: string, method: 'POST' | 'PUT', body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`${apiUrl}${pathname}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSecret}`, ...headers }, body: JSON.stringify(body) });
  if (response.status === 409) {
    const pending = await response.json() as { approval?: PendingApprovalView };
    if (pending.approval === undefined) throw new RuntimeError('OWNER_DECISION_REQUIRED', `Owner mutation ${pathname} did not expose its pending approval`);
    return ownerApprove<T>(apiUrl, ownerSecret, pending.approval.id, 'ALLOW_ONCE');
  }
  if (!response.ok) throw new RuntimeError('CONTROL_DENIED', `Owner mutation ${pathname} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function ownerApprove<T = unknown>(apiUrl: string, ownerSecret: string, approvalId: string, decision: 'ALLOW_ONCE' | 'ALWAYS_ALLOW_PROJECT'): Promise<T> {
  const response = await fetch(`${apiUrl}/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSecret}` }, body: JSON.stringify({ decision }) });
  if (!response.ok) throw new RuntimeError('CONTROL_DENIED', `Owner approval ${approvalId} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function hermesToolRejected(daemon: DaemonHandle, ownerSecret: string, missionId: string, name: string): Promise<boolean> {
  const token = hermesMissionAccessToken(ownerSecret, missionId);
  const response = await fetch(`${daemon.apiUrl}/hermes-mcp/${encodeURIComponent(missionId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
  });
  if (!response.ok) return false;
  const envelope = await response.json() as RpcEnvelope<Record<string, unknown>>;
  return envelope.result?.isError === true && envelope.result.structuredContent.code === 'CAPABILITY_DENIED';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runV2OrchestratorAcceptance()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({ status: 'BLOCKED', error: error instanceof Error ? error.message : 'V2 orchestrator acceptance failed' })}\n`);
      process.exitCode = 1;
    });
}
