import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError, type MissionBrokerSnapshot, type PendingApprovalView, type SupervisorDirective } from '@iris/domain';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { HermesCliRunner, HermesSessionResumeAdapter, type HermesCheckpointReceipt } from './hermes-session-adapter.js';
import { MCP_PROTOCOL_VERSION } from './mcp.js';
import { readOwnerAccessSecret } from './persistence.js';
import { hermesMissionAccessToken } from './server.js';

const execFileAsync = promisify(execFile);
const HERMES_STATE_DB = path.join(os.homedir(), '.hermes', 'state.db');
const HERMES_BIN = process.env.IRIS_HERMES_BIN?.trim() || '/Users/bill/.local/bin/hermes';
const HERMES_PYTHON = path.join(os.homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python');
const HERMES_AGENT_ROOT = path.join(os.homedir(), '.hermes', 'hermes-agent');
const MAX_COMMAND_BUFFER = 128 * 1024;
const CHILD_WAIT_MS = 60_000;

interface McpToolEnvelope<T> {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: {
    readonly isError: boolean;
    readonly structuredContent: T;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

interface AcceptanceProjectShape {
  readonly id: string;
  readonly rootPath: string;
}

interface AcceptanceSessionShape {
  readonly id: string;
  readonly clientId: string;
}

interface AcceptanceMissionShape {
  readonly id: string;
  readonly clientId: string;
  readonly sessionId: string;
  readonly tasks: readonly {
    readonly id: string;
    readonly actions: readonly {
      readonly id: string;
      readonly capabilityId: string;
      readonly state: string;
      readonly approvalId: string | null;
      readonly result: unknown;
    }[];
  }[];
}

export interface V2AcceptanceReport {
  readonly missionId: string;
  readonly hermesSessionId: string;
  readonly childSessionId: string;
  readonly mcpServerName: string;
  readonly fixtureRoot: string;
  readonly dataRoot: string;
  readonly initialTestFailed: boolean;
  readonly governedWriteApprovalRequired: boolean;
  readonly approvalExecutedOnce: boolean;
  readonly childUsedIrisMcp: boolean;
  readonly directProjectBypassObserved: boolean;
  readonly finalTestPassed: boolean;
  readonly supervisorCheckpointDurable: boolean;
  readonly supervisorStateTransferredWithoutCopyPaste: boolean;
  readonly sameHermesSessionResumed: boolean;
  readonly missionCompleted: boolean;
  readonly restartRecovery: boolean;
  readonly replayPrevented: boolean;
  readonly finalCheckpoint: HermesCheckpointReceipt;
}

export async function runV2Acceptance(): Promise<V2AcceptanceReport> {
  if (process.platform !== 'darwin') throw new RuntimeError('CAPABILITY_DENIED', 'V2 acceptance is macOS-only');

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-v2-acceptance-project-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-v2-acceptance-data-'));
  await writeFixture(fixtureRoot);
  await runProcess('/usr/bin/git', ['init', '-b', 'acceptance'], fixtureRoot);

  let daemon: DaemonHandle | undefined;
  let mcpServerName: string | undefined;
  let mcpRegistered = false;
  try {
    daemon = await startDaemon({ dataRoot, preferredPort: 0 });
    const ownerSecret = await readOwnerAccessSecret(dataRoot);
    if (ownerSecret === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Acceptance runtime owner credential is unavailable');

    const project = await ownerMutation<AcceptanceProjectShape>(
      daemon.apiUrl, ownerSecret, 'POST', '/projects',
      { name: 'IRIS V2 Acceptance Fixture', rootPath: fixtureRoot },
    );
    const session = await ownerMutation<AcceptanceSessionShape>(
      daemon.apiUrl, ownerSecret, 'POST', '/sessions',
      { clientId: 'chatgpt-v2-acceptance', agentId: 'hermes-loop-engineer', agentRole: 'implementer' },
    );
    await ownerMutation(
      daemon.apiUrl, ownerSecret, 'PUT', `/sessions/${encodeURIComponent(session.id)}/current-project`,
      { projectId: project.id }, { 'x-iris-client-id': session.clientId },
    );

    await assertSupervisorMcpDiscovery(daemon.apiUrl, ownerSecret);
    const mission = await supervisorTool<AcceptanceMissionShape>(daemon.apiUrl, ownerSecret, 'mission_create', {
      title: 'V2 real acceptance: recover a failing disposable fixture through governed Hermes execution',
    }, session.clientId, session.id);

    const hermesSessionId = await seedHermesSession(fixtureRoot);
    await ownerPost(daemon.apiUrl, ownerSecret, `/missions/${mission.id}/broker`, {
      hermesSessionId,
      worktreePath: project.rootPath,
      branch: 'acceptance',
    });

    await ownerMutation(daemon.apiUrl, ownerSecret, 'POST', '/permissions/mode', { mode: 'AUTO_APPROVE_LOW_RISK' });
    const setupTestApproval = await daemon.capabilities.execute({
      capabilityId: 'project.test.run', clientId: session.clientId, sessionId: session.id, projectId: project.id,
    });
    if (setupTestApproval.status !== 'owner_required' || !setupTestApproval.approval.canAlwaysAllowProject) {
      throw new RuntimeError('OWNER_DECISION_REQUIRED', 'Acceptance could not establish the governed project test policy through IRIS approval');
    }
    const setupTestResult = await ownerPost<{ passed: boolean }>(
      daemon.apiUrl, ownerSecret, `/approvals/${encodeURIComponent(setupTestApproval.approval.id)}`, { decision: 'ALWAYS_ALLOW_PROJECT' },
    );
    if (setupTestResult.passed !== false) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Acceptance fixture must begin with a failing governed project test');

    mcpServerName = `iris_v2_acceptance_${mission.id.slice(0, 8)}`;
    const missionBridgeToken = hermesMissionAccessToken(ownerSecret, mission.id);
    await addHermesMcpServer(mcpServerName, `${daemon.apiUrl}/hermes-mcp/${encodeURIComponent(mission.id)}`, missionBridgeToken);
    mcpRegistered = true;

    const firstDirectiveInput = {
      missionId: mission.id,
      expectedVersion: 1,
      directiveId: randomUUID(),
      directiveSequence: 1,
      decision: 'CONTINUE' as const,
      instruction: [
        'Operate as the Hermes Loop Engineer using only delegation plus the mission-bound IRIS MCP tools.',
        'Inspect package.json, test.mjs, and value.txt through IRIS reads.',
        'Create one mission task. Prepare and run one project.test.run action and observe the expected initial failure.',
        'Call delegate_task exactly once with role leaf. The child must use only inherited IRIS MCP read tools to inspect the fixture and recommend the smallest correction; it must not use native terminal, shell, git, or file mutation tools.',
        'Then prepare one file.write action that changes value.txt to exactly "fixed\\n" and attempt project_file_write once.',
        'If IRIS returns OWNER_DECISION_REQUIRED, do not retry or bypass it. Return the bounded structured receipt immediately.',
      ].join(' '),
      authorizedScope: ['disposable acceptance fixture only', 'one leaf subagent', 'IRIS governed reads/test/file.write only'],
      doNot: ['no native project terminal/shell/git/file mutation', 'no second subagent', 'no permission bypass', 'no write retry after OWNER_DECISION_REQUIRED'],
      successCriteria: ['initial test fails through IRIS', 'one child uses inherited IRIS reads', 'one exact file.write reaches IRIS owner approval'],
    };
    const afterFirstDirective = await supervisorTool<MissionBrokerSnapshot>(daemon.apiUrl, ownerSecret, 'mission_directive', firstDirectiveInput);
    const firstDirective = latestDirective(afterFirstDirective);
    const adapter = new HermesSessionResumeAdapter(new HermesCliRunner(HERMES_BIN), `delegation,${mcpServerName}`);
    const firstReceipt = await adapter.resumeExact(afterFirstDirective, firstDirective);
    if (firstReceipt.missionComplete) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Acceptance mission completed before owner approval and validation');

    const pending = (await ownerGet<{ approvals: readonly PendingApprovalView[] }>(daemon.apiUrl, ownerSecret, '/approvals')).approvals;
    if (pending.length !== 1 || pending[0]!.capabilityId !== 'file.write'
      || pending[0]!.missionId !== mission.id || pending[0]!.taskId === null || pending[0]!.actionId === null) {
      throw new RuntimeError('OWNER_DECISION_REQUIRED', 'Acceptance expected exactly one mission-bound file.write approval');
    }
    const approval = pending[0]!;
    await ownerPost(daemon.apiUrl, ownerSecret, `/approvals/${encodeURIComponent(approval.id)}`, { decision: 'ALLOW_ONCE' });
    if (await readFile(path.join(fixtureRoot, 'value.txt'), 'utf8') !== 'fixed\n') {
      throw new RuntimeError('CAPABILITY_DENIED', 'Approved acceptance write did not produce the exact bounded fixture correction');
    }

    const child = await waitForSingleCompletedChild(hermesSessionId, mcpServerName);
    const operationalEvidence = [
      `owner-approval:${approval.id}:executed-once`,
      `child-session:${child.sessionId}`,
      `child-iris-tools:${child.mcpToolNames.join(',')}`,
      'approved-file-write:value.txt',
    ].join('; ');
    const afterOperational = await daemon.missionBroker.get(mission.id);
    const finalCheckpoint = await adapter.continueAfterOperationalEvent(afterOperational, operationalEvidence);
    if (!finalCheckpoint.decisionRequired || finalCheckpoint.missionComplete) {
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Acceptance operational continuation did not open the supervisor gate correctly');
    }

    await ownerPost(daemon.apiUrl, ownerSecret, `/missions/${mission.id}/checkpoints`, {
      checkpointId: randomUUID(),
      missionVersion: afterOperational.missionVersion,
      state: 'WAITING_SUPERVISOR',
      currentPhase: finalCheckpoint.currentPhase,
      summary: finalCheckpoint.summary,
      evidenceRefs: finalCheckpoint.evidenceRefs,
      blockers: finalCheckpoint.blockers,
      hermesAssessment: finalCheckpoint.hermesAssessment,
      proposedNextAction: finalCheckpoint.proposedNextAction,
      decisionRequired: finalCheckpoint.decisionRequired,
      createdAt: new Date().toISOString(),
    });

    const waiting = await supervisorTool<{ missions: readonly { mission: AcceptanceMissionShape; broker: MissionBrokerSnapshot }[] }>(
      daemon.apiUrl, ownerSecret, 'mission_list_waiting_supervisor', {},
    );
    const waitingEntry = waiting.missions.find((entry) => entry.mission.id === mission.id);
    if (waitingEntry === undefined || waitingEntry.broker.state !== 'AWAITING_SUPERVISOR') {
      throw new RuntimeError('MISSION_NOT_FOUND', 'Acceptance checkpoint is not discoverable through the supervisor bridge');
    }
    const supervisorMission = await supervisorTool<AcceptanceMissionShape & { broker: MissionBrokerSnapshot | null }>(
      daemon.apiUrl, ownerSecret, 'mission_get', { missionId: mission.id },
    );
    const supervisorEvents = await supervisorTool<{ missionId: string; events: readonly unknown[] }>(
      daemon.apiUrl, ownerSecret, 'mission_events', { missionId: mission.id },
    );
    if (supervisorMission.broker?.lastCheckpointId === null || supervisorEvents.events.length === 0) {
      throw new RuntimeError('MISSION_NOT_FOUND', 'Supervisor bridge did not return durable checkpoint evidence');
    }

    const completeDirectiveInput = {
      missionId: mission.id,
      expectedVersion: waitingEntry.broker.missionVersion,
      directiveId: randomUUID(),
      directiveSequence: waitingEntry.broker.lastDirectiveSequence + 1,
      decision: 'COMPLETE' as const,
      instruction: 'Review the durable acceptance evidence. If the governed correction and focused validation succeeded, mark the mission complete. Do not perform any new project mutation.',
      authorizedScope: ['mission completion decision only', 'read-only mission evidence if needed'],
      doNot: ['no new project mutation', 'no native project shell/git/file tools', 'no permission grant'],
      successCriteria: ['missionComplete=true only if the existing governed evidence proves success'],
    };
    const completing = await supervisorTool<MissionBrokerSnapshot>(daemon.apiUrl, ownerSecret, 'mission_directive', completeDirectiveInput);
    const completionReceipt = await adapter.resumeExact(completing, latestDirective(completing));
    if (!completionReceipt.missionComplete) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Hermes did not accept the supervisor COMPLETE decision');
    await ownerPost(daemon.apiUrl, ownerSecret, `/missions/${mission.id}/complete`, {
      hermesSessionId,
      expectedVersion: completing.missionVersion,
    });

    const missionAfter = await daemon.state.getMission(mission.id) as AcceptanceMissionShape;
    const allActions = missionAfter.tasks.flatMap((task) => task.actions);
    const testActions = allActions.filter((action) => action.capabilityId === 'project.test.run');
    const writeActions = allActions.filter((action) => action.capabilityId === 'file.write');
    const initialTestFailed = testActions.some((action) => actionTestPassed(action.result) === false);
    const finalTestPassed = testActions.some((action) => actionTestPassed(action.result) === true);
    if (!initialTestFailed || !finalTestPassed || writeActions.length !== 1 || writeActions[0]!.state !== 'SUCCEEDED') {
      throw new RuntimeError('CAPABILITY_DENIED', 'Acceptance mission did not preserve one governed write and successful final validation');
    }

    await daemon.close();
    daemon = await startDaemon({ dataRoot, preferredPort: 0 });
    const recovered = await daemon.missionBroker.get(mission.id);
    if (recovered.state !== 'COMPLETED' || recovered.hermesSessionId !== hermesSessionId) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Completed acceptance mission did not survive daemon restart');
    }
    let replayPrevented = false;
    try {
      daemon.state.getSessionForClient(session.id, session.clientId);
    } catch (error) {
      replayPrevented = error instanceof RuntimeError && error.code === 'SESSION_NOT_FOUND';
    }
    if (!replayPrevented) throw new RuntimeError('PERSISTENCE_FAILURE', 'Completed acceptance session was rehydrated and could replay');
    const parentDirectBypassObserved = await sessionHasDirectProjectBypass(hermesSessionId);
    if (parentDirectBypassObserved) throw new RuntimeError('CAPABILITY_DENIED', 'Acceptance parent used a direct project execution tool outside IRIS');

    return {
      missionId: mission.id,
      hermesSessionId,
      childSessionId: child.sessionId,
      mcpServerName,
      fixtureRoot,
      dataRoot,
      initialTestFailed,
      governedWriteApprovalRequired: true,
      approvalExecutedOnce: writeActions.length === 1 && writeActions[0]!.approvalId === approval.id,
      childUsedIrisMcp: child.mcpToolNames.length > 0,
      directProjectBypassObserved: child.directBypassObserved || parentDirectBypassObserved,
      finalTestPassed,
      supervisorCheckpointDurable: recovered.lastCheckpointId !== null,
      supervisorStateTransferredWithoutCopyPaste: true,
      sameHermesSessionResumed: recovered.hermesSessionId === hermesSessionId,
      missionCompleted: recovered.state === 'COMPLETED',
      restartRecovery: true,
      replayPrevented,
      finalCheckpoint,
    };
  } finally {
    if (mcpRegistered && mcpServerName !== undefined) await removeHermesMcpServer(mcpServerName).catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeFixture(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ private: true, scripts: { test: 'node test.mjs' } }, null, 2)}\n`);
  await writeFile(path.join(root, 'test.mjs'), [
    "import { readFileSync } from 'node:fs';",
    "const value = readFileSync(new URL('./value.txt', import.meta.url), 'utf8').trim();",
    "if (value !== 'fixed') { console.error(`V2_ACCEPTANCE_EXPECTED_FIXED actual=${value}`); process.exit(1); }",
    "console.log('V2_ACCEPTANCE_TEST_PASS');",
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'value.txt'), 'broken\n');
}

async function seedHermesSession(worktree: string): Promise<string> {
  const runner = new HermesCliRunner(HERMES_BIN);
  const result = await runner.run([
    'chat', '-Q', '--in', worktree, '--source', 'tool', '--max-turns', '2', '--pass-session-id',
    '-q', 'Do not call tools. Reply exactly with: V2_ACCEPTANCE_SESSION_READY',
  ], worktree);
  if (result.exitCode !== 0 || result.stdout.trim() !== 'V2_ACCEPTANCE_SESSION_READY') {
    throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Could not seed the bounded Hermes acceptance session');
  }
  const match = /session_id:\s*([A-Za-z0-9_-]+)/.exec(result.stderr);
  if (match === null) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Hermes did not emit a stable acceptance session ID');
  return match[1]!;
}

async function addHermesMcpServer(name: string, url: string, missionToken: string): Promise<void> {
  const script = [
    'import os, sys',
    `sys.path.insert(0, ${JSON.stringify(HERMES_AGENT_ROOT)})`,
    'from hermes_cli.mcp_config import _get_mcp_servers, _save_bearer_auth_token, _save_mcp_server',
    'name, url = sys.argv[1], sys.argv[2]',
    'existing = _get_mcp_servers()',
    'if name in existing: raise SystemExit(17)',
    'headers = _save_bearer_auth_token(name, os.environ["IRIS_MISSION_BRIDGE_TOKEN"])',
    'ok = _save_mcp_server(name, {"url": url, "enabled": True, "connect_timeout": 10, "headers": headers})',
    'raise SystemExit(0 if ok else 18)',
  ].join('\n');
  await runProcess(HERMES_PYTHON, ['-c', script, name, url], process.cwd(), { IRIS_MISSION_BRIDGE_TOKEN: missionToken });
}

async function removeHermesMcpServer(name: string): Promise<void> {
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(HERMES_AGENT_ROOT)})`,
    'from hermes_cli.config import remove_env_value',
    'from hermes_cli.mcp_config import _env_key_for_server, _remove_mcp_server',
    'name = sys.argv[1]',
    '_remove_mcp_server(name)',
    'remove_env_value(_env_key_for_server(name))',
  ].join('\n');
  await runProcess(HERMES_PYTHON, ['-c', script, name], process.cwd());
}

async function assertSupervisorMcpDiscovery(apiUrl: string, ownerSecret: string): Promise<void> {
  const response = await fetch(`${apiUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSecret}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
  });
  if (!response.ok) throw new RuntimeError('CONTROL_DENIED', 'Supervisor MCP discovery failed');
  const body = await response.json() as { result?: { protocolVersion?: string } };
  if (body.result?.protocolVersion !== MCP_PROTOCOL_VERSION) throw new RuntimeError('CONTROL_DENIED', 'Supervisor MCP protocol version mismatch');
}

async function supervisorTool<T>(
  apiUrl: string,
  ownerSecret: string,
  name: string,
  args: Record<string, unknown>,
  clientId?: string,
  sessionId?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${ownerSecret}`,
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    'Mcp-Method': 'tools/call',
    'Mcp-Name': name,
  };
  if (clientId !== undefined) headers['x-iris-client-id'] = clientId;
  if (sessionId !== undefined) headers['x-iris-session-id'] = sessionId;
  const response = await fetch(`${apiUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!response.ok) throw new RuntimeError('CONTROL_DENIED', `Supervisor MCP ${name} returned HTTP ${response.status}`);
  const envelope = await response.json() as McpToolEnvelope<T>;
  if (envelope.error !== undefined || envelope.result === undefined || envelope.result.isError) {
    throw new RuntimeError('CONTROL_DENIED', `Supervisor MCP ${name} failed safely`);
  }
  return envelope.result.structuredContent;
}

async function ownerMutation<T = unknown>(
  apiUrl: string,
  ownerSecret: string,
  method: 'POST' | 'PUT',
  pathname: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSecret}`, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as unknown;
  if (response.status === 409 && isRecord(payload) && isRecord(payload.approval) && typeof payload.approval.id === 'string') {
    return ownerPost<T>(apiUrl, ownerSecret, `/approvals/${encodeURIComponent(payload.approval.id)}`, { decision: 'ALLOW_ONCE' });
  }
  if (!response.ok) throw new RuntimeError('CONTROL_DENIED', `Owner bridge request ${pathname} returned HTTP ${response.status}`);
  return payload as T;
}

async function ownerGet<T>(apiUrl: string, ownerSecret: string, pathname: string): Promise<T> {
  const response = await fetch(`${apiUrl}${pathname}`, {
    headers: { authorization: `Bearer ${ownerSecret}` },
  });
  if (!response.ok) throw new RuntimeError('CONTROL_DENIED', `Owner bridge request ${pathname} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function ownerPost<T = unknown>(apiUrl: string, ownerSecret: string, pathname: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSecret}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new RuntimeError('CONTROL_DENIED', `Owner bridge request ${pathname} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function latestDirective(mapping: MissionBrokerSnapshot): SupervisorDirective {
  const directive = mapping.directives.at(-1);
  if (directive === undefined || mapping.lastDirectiveId !== directive.directiveId) {
    throw new RuntimeError('INVALID_REQUEST', 'Acceptance broker lost its latest directive identity');
  }
  return directive;
}

async function waitForSingleCompletedChild(parentSessionId: string, mcpServerName: string) {
  const deadline = Date.now() + CHILD_WAIT_MS;
  let childSessionId: string | null = null;
  while (Date.now() < deadline) {
    const rows = (await sqlite(`select id from sessions where parent_session_id='${sqlLiteral(parentSessionId)}' order by started_at;`))
      .split('\n').map((value) => value.trim()).filter(Boolean);
    if (rows.length > 1) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Acceptance parent created more than one Hermes subagent');
    if (rows.length === 1) {
      childSessionId = rows[0]!;
      const completed = Number(await sqlite(`select count(*) from messages where session_id='${sqlLiteral(childSessionId)}' and role='assistant' and finish_reason='stop';`));
      if (completed > 0) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (childSessionId === null) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Acceptance Hermes subagent was not created');
  const completed = Number(await sqlite(`select count(*) from messages where session_id='${sqlLiteral(childSessionId)}' and role='assistant' and finish_reason='stop';`));
  if (completed === 0) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Acceptance Hermes subagent did not complete within the bounded wait');

  const toolNames = (await sqlite(`select coalesce(tool_name,'') from messages where session_id='${sqlLiteral(childSessionId)}' and role='tool' order by id;`))
    .split('\n').map((value) => value.trim()).filter(Boolean);
  const mcpPrefix = `mcp__${mcpServerName}__`;
  const mcpToolNames = toolNames.filter((name) => name.startsWith(mcpPrefix));
  if (mcpToolNames.length === 0) throw new RuntimeError('CAPABILITY_DENIED', 'Acceptance child did not use the inherited mission-bound IRIS MCP');
  const directBypassObserved = toolNames.some((name) => isDirectProjectExecutionTool(name));
  if (directBypassObserved) throw new RuntimeError('CAPABILITY_DENIED', 'Acceptance child used a direct project execution tool outside IRIS');
  return { sessionId: childSessionId, mcpToolNames, directBypassObserved };
}

async function sessionHasDirectProjectBypass(sessionId: string): Promise<boolean> {
  const toolNames = (await sqlite(`select coalesce(tool_name,'') from messages where session_id='${sqlLiteral(sessionId)}' and role='tool' order by id;`))
    .split('\n').map((value) => value.trim()).filter(Boolean);
  const delegateCount = toolNames.filter((name) => name === 'delegate_task').length;
  if (delegateCount !== 1) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Acceptance parent must delegate exactly one subagent');
  return toolNames.some((name) => isDirectProjectExecutionTool(name));
}

function isDirectProjectExecutionTool(name: string): boolean {
  return name === 'terminal' || name === 'shell' || name === 'git' || name === 'patch' || name === 'write_file'
    || name === 'file_write' || name === 'file_delete' || name === 'apply_patch'
    || name === 'read_file' || name === 'read_files' || name === 'read_many_files'
    || name === 'search_files' || name === 'search_text';
}

async function sqlite(query: string): Promise<string> {
  const result = await runProcess('/usr/bin/sqlite3', [HERMES_STATE_DB, query], process.cwd());
  return result.stdout.trim();
}

function sqlLiteral(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new RuntimeError('INVALID_REQUEST', 'Hermes session identity is invalid');
  return value.replaceAll("'", "''");
}

async function runProcess(executable: string, args: readonly string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  try {
    const result = await execFileAsync(executable, [...args], {
      cwd,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: { ...process.env, ...extraEnv },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    void candidate;
    throw new RuntimeError('AGENT_EXECUTION_FAILED', `Acceptance helper process failed: ${path.basename(executable)}`, { cause: error });
  }
}

function actionTestPassed(result: unknown): boolean | null {
  if (!isRecord(result) || !Array.isArray(result.evidence)) return null;
  for (const evidence of result.evidence) {
    if (!isRecord(evidence) || !isRecord(evidence.data) || typeof evidence.data.passed !== 'boolean') continue;
    return evidence.data.passed;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runV2Acceptance()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'V2 acceptance failed';
      process.stderr.write(`${JSON.stringify({ status: 'BLOCKED', error: message })}\n`);
      process.exitCode = 1;
    });
}
