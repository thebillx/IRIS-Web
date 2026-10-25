import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { CapabilityService } from './capability-service.js';
import { DurableJobManager } from './durable-job-manager.js';
import { DurableMutationJournal } from './durable-mutation-journal.js';
import { DurableMissionLifecycleService } from './durable-mission-service.js';
import { DurableMissionLifecycleStore } from './durable-mission-store.js';
import { loadOrCreateMachineId } from './machine-identity.js';
import { MCP_PROTOCOL_VERSION } from './mcp.js';
import { handleMcpV21Request } from './mcp-v21.js';
import { MissionBrokerService, MissionBrokerStore } from './mission-broker.js';
import { MissionDelegationStore } from './mission-delegation.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore, loadOrCreateOwnerAccessSecret } from './persistence.js';
import { ProjectValidationJobManager } from './project-test.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('rechecks exact write permission for cached retry and read-only mutation status', async () => {
  const f = await fixture();
  const args = f.writeArgs();
  expect((await f.call('fs', args)).isError).toBe(false);
  const filename = f.recordPath(args.requestId);
  const record = JSON.parse(await readFile(filename, 'utf8'));
  expect(record.originalArguments).toEqual(args);
  const before = await readFile(filename);
  const auditBefore = await readFile(path.join(f.dataRoot, 'audit.jsonl'));
  await writeFile(path.join(f.projectRoot, 'proof.txt'), 'external-change');
  expect((await f.call('fs', args)).isError).toBe(false);
  expect((await f.status(record)).structuredContent.state).toBe('COMMITTED');
  await f.settings.setMode('ASK_EVERY_TIME');
  expect((await f.call('fs', args))).toMatchObject({ isError: true, structuredContent: { code: 'CONTROL_DENIED' } });
  expect((await f.status(record))).toMatchObject({ isError: true, structuredContent: { code: 'CONTROL_DENIED' } });
  expect(await readFile(filename)).toEqual(before);
  expect(await readFile(path.join(f.dataRoot, 'audit.jsonl'))).toEqual(auditBefore);
  expect(await readFile(path.join(f.projectRoot, 'proof.txt'), 'utf8')).toBe('external-change');
  await f.settings.setMode('FULL_LOCAL_OWNER');
  expect((await f.status(record)).structuredContent.state).toBe('COMMITTED');
  delete record.originalArguments;
  await writeFile(filename, JSON.stringify(record), { mode: 0o600 });
  const legacy = await readFile(filename);
  expect((await f.status(record))).toMatchObject({ isError: true, structuredContent: { code: 'CONTROL_DENIED' } });
  expect(await readFile(filename)).toEqual(legacy);
});

it('denies revoked workspace and missing project roots without reapplying the mutation', async () => {
  const f = await fixture();
  const scratch = await f.resources.createScratch(f.projectId);
  const args = { ...f.writeArgs(), workspaceId: scratch.workspaceId };
  expect((await f.call('fs', args)).isError).toBe(false);
  const record = JSON.parse(await readFile(f.recordPath(args.requestId), 'utf8'));
  await f.resources.revokeScratch(f.projectId, scratch.workspaceId);
  const before = await readFile(f.recordPath(args.requestId));
  expect((await f.call('fs', args)).isError).toBe(true);
  expect((await f.status(record)).isError).toBe(true);
  expect(await readFile(f.recordPath(args.requestId))).toEqual(before);
  const primaryArgs = f.writeArgs();
  expect((await f.call('fs', primaryArgs)).isError).toBe(false);
  const primaryRecord = JSON.parse(await readFile(f.recordPath(primaryArgs.requestId), 'utf8'));
  const moved = `${f.projectRoot}.moved`; roots.push(moved);
  await rename(f.projectRoot, moved);
  expect((await f.status(primaryRecord)).isError).toBe(true);
});

it('keeps exact detach and close receipts recoverable while denying closed session_open evidence', async () => {
  const f = await fixture();
  const detach = { sessionId: f.sessionId, expectedRevision: 2, requestId: randomUUID() };
  expect((await f.call('session_detach', detach)).isError).toBe(false);
  const detachRecord = JSON.parse(await readFile(f.recordPath(detach.requestId), 'utf8'));
  expect((await f.status(detachRecord)).structuredContent.state).toBe('COMMITTED');
  const close = { sessionId: f.sessionId, expectedRevision: 3, requestId: randomUUID() };
  expect((await f.call('session_close', close)).isError).toBe(false);
  const closeRecord = JSON.parse(await readFile(f.recordPath(close.requestId), 'utf8'));
  const before = await readFile(f.recordPath(close.requestId));
  expect((await f.call('session_close', close)).isError).toBe(false);
  expect((await f.call('session_detach', detach)).isError).toBe(false);
  expect((await f.status(detachRecord)).structuredContent.state).toBe('COMMITTED');
  expect((await f.status(closeRecord)).structuredContent.state).toBe('COMMITTED');
  const openRecord = JSON.parse(await readFile(f.recordPath(f.openArgs.requestId), 'utf8'));
  expect((await f.call('session_open', f.openArgs)).isError).toBe(true);
  expect((await f.status(openRecord))).toMatchObject({ isError: true, structuredContent: { code: 'CONTROL_DENIED' } });
  expect(await readFile(f.recordPath(close.requestId))).toEqual(before);
});

it('rechecks cached authorization inside the serialized journal duplicate path', async () => {
  const f = await fixture();
  const args = f.writeArgs();
  expect((await f.call('fs', args)).isError).toBe(false);
  const record = JSON.parse(await readFile(f.recordPath(args.requestId), 'utf8'));
  await f.settings.setMode('ASK_EVERY_TIME');
  let effects = 0;
  await expect(f.journal.execute(record.requestId, record.fingerprint, async () => { effects += 1; }, record.binding, record.logicalFingerprint, record.originalArguments,
    (cached) => f.capabilities.authorizeMutationReceipt(cached.binding!, cached.originalArguments!, cached.result))).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  expect(effects).toBe(0);
});

it('authorizes recovered mission creation against its durable source receipt before read-only disclosure', async () => {
  const f = await fixture();
  const args = { sessionId: f.sessionId, requestId: randomUUID(), title: 'Recover original mission', goal: 'Retain exact source evidence', orchestratorMode: 'CHATGPT' };
  const created = await f.call('mission_create', args);
  expect(created.isError).toBe(false);
  const missionId = created.structuredContent.id;
  const filename = f.recordPath(args.requestId);
  const record = JSON.parse(await readFile(filename, 'utf8'));
  const unresolved = { ...record, state: 'APPLYING', result: null };
  await writeFile(filename, JSON.stringify(unresolved), { mode: 0o600 });
  const before = await readFile(filename);
  const auditBefore = await readFile(path.join(f.dataRoot, 'audit.jsonl'));
  await f.settings.setMode('ASK_EVERY_TIME');
  expect((await f.status(unresolved))).toMatchObject({ isError: true, structuredContent: { code: 'CONTROL_DENIED' } });
  expect((await f.call('mission_create', args))).toMatchObject({ isError: true, structuredContent: { code: 'CONTROL_DENIED' } });
  expect(await readFile(filename)).toEqual(before);
  await f.settings.setMode('FULL_LOCAL_OWNER');
  expect((await f.status(unresolved))).toMatchObject({ isError: false, structuredContent: { state: 'COMMITTED', journalState: 'APPLYING', source: 'durable-operation-receipt', evidence: { id: missionId } } });
  expect(await readFile(filename)).toEqual(before);
  expect(await readFile(path.join(f.dataRoot, 'audit.jsonl'))).toEqual(auditBefore);
  const recovered = await f.call('mission_create', args);
  expect(recovered).toMatchObject({ isError: false, structuredContent: { id: missionId } });
  expect(JSON.parse(await readFile(filename, 'utf8')).state).toBe('COMMITTED');
  expect((await f.state.listMissions()).filter((mission) => mission.id === missionId)).toHaveLength(1);
});

it('preserves ordinary and delegated mission-action receipts without consuming delegation again', async () => {
  for (const delegated of [false, true]) {
    const f = await fixture(true);
    const created = await f.call('mission_create', { sessionId: f.sessionId, requestId: randomUUID(), title: 'Receipt action', orchestratorMode: 'CHATGPT' });
    expect(created.isError).toBe(false);
    const missionId = String(created.structuredContent.id);
    const task = await f.state.createMissionTask(missionId, 'fixture-client', f.sessionId, 'Write once');
    const taskId = task.tasks[0]!.id;
    const planned = await f.state.prepareMissionAction(missionId, taskId, 'fixture-client', f.sessionId, 'file.write', 'Write original content');
    const actionId = planned.tasks[0]!.actions[0]!.id;
    const session = f.state.getSessionForClient(f.sessionId, 'fixture-client');
    const grant = delegated ? await f.delegations!.issue({ requestId: randomUUID(), missionId, ownerClientId: session.clientId, ownerSessionId: session.id, trustedAgentIds: [session.agentId], allowedCapabilities: ['file.write'], projectIds: [f.projectId], maxExecutions: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }) : null;
    if (delegated) await f.settings.setMode('ASK_EVERY_TIME');
    const args = { sessionId: f.sessionId, projectId: f.projectId, missionId, taskId, actionId, requestId: randomUUID(), targetPath: path.join(f.projectRoot, 'legacy.txt'), content: 'original' };
    const written = await f.call('file_write', args);
    expect(written.isError, JSON.stringify(written)).toBe(false);
    const filename = f.recordPath(args.requestId);
    const record = JSON.parse(await readFile(filename, 'utf8'));
    const before = await readFile(filename);
    const auditBefore = await readFile(path.join(f.dataRoot, 'audit.jsonl'));
    const delegationFile = path.join(f.dataRoot, 'mission-delegations.json');
    const delegationBefore = delegated ? await readFile(delegationFile) : null;
    await writeFile(args.targetPath, 'external-change');
    expect((await f.call('file_write', args)).isError).toBe(false);
    expect((await f.status(record)).structuredContent.state).toBe('COMMITTED');
    expect(await readFile(filename)).toEqual(before);
    expect(await readFile(path.join(f.dataRoot, 'audit.jsonl'))).toEqual(auditBefore);
    if (delegationBefore !== null) expect(await readFile(delegationFile)).toEqual(delegationBefore);
    if (grant !== null) {
      await f.delegations!.revoke(grant.delegationId, session.clientId, session.id);
      expect((await f.call('file_write', args)).isError).toBe(true);
      expect((await f.status(record)).isError).toBe(true);
    }
    expect(await readFile(args.targetPath, 'utf8')).toBe('external-change');
  }
});

async function fixture(withDelegations = false) {
  const dataRoot = await temp(); const projectRoot = await temp(); const legacyRoot = await temp();
  await loadOrCreateMachineId(dataRoot);
  if (withDelegations) await loadOrCreateOwnerAccessSecret(dataRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const settings = new PermissionSettingsStore(dataRoot); await settings.initialize();
  const resources = new VNextResourceRegistry(state, dataRoot);
  const jobs = new DurableJobManager(dataRoot, resources);
  const delegations = withDelegations ? new MissionDelegationStore(dataRoot) : undefined;
  const health = () => ({ status: 'ready' as const, version: '0.0.0' as const, platform: 'darwin' as const, runtimeId: 'fixture-runtime', instanceId: 'fixture-instance', pid: process.pid, uptimeMs: 1, authority: 'owned' as const, connectedClients: 1, connectedSessions: 1, agentExecutorType: 'local-development-executor' as const, productionModelConnected: false, apiUrl: '', mcpUrl: '' });
  const capabilities = new CapabilityService(state, new PermissionPolicyEngine(state, settings, projectRoot, dataRoot, legacyRoot, delegations), new PermissionAuditStore(dataRoot), health, new ProjectValidationJobManager(dataRoot), resources, jobs, undefined, undefined, delegations);
  const broker = new MissionBrokerService(state, new MissionBrokerStore(dataRoot));
  const lifecycle = new DurableMissionLifecycleService(state, new DurableMissionLifecycleStore(dataRoot));
  const journal = new DurableMutationJournal(dataRoot);
  const call = async (name: string, args: Record<string, unknown>, clientId = 'fixture-client') => {
    const request = new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'x-iris-client-id': clientId }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const response = await handleMcpV21Request(request, capabilities, state, broker, lifecycle, 'tunnel-service', { runtimeId: 'fixture-runtime', instanceId: 'fixture-instance', deploymentEpoch: 1 }, undefined, journal);
    return (await response.json() as { result: { isError: boolean; structuredContent: Record<string, unknown> } }).result;
  };
  const project = await state.registerProject('Receipt authority', projectRoot);
  const openArgs = { conversationId: randomUUID(), requestId: randomUUID() };
  const sessionId = String((await call('session_open', openArgs)).structuredContent.sessionId);
  expect((await call('workspace_select', { sessionId, projectId: project.id, expectedRevision: 1, requestId: randomUUID() })).isError).toBe(false);
  const workspace = await resources.primaryWorkspace(project.id);
  return { state, dataRoot, projectRoot, projectId: project.id, resources, settings, sessionId, openArgs, capabilities, journal, call, delegations,
    recordPath: (requestId: string) => path.join(dataRoot, 'vnext-mutations', `${createHash('sha256').update(requestId).digest('hex')}.json`),
    status: (record: { requestId: string; fingerprint: string; binding: Record<string, unknown> }) => call('mutation_status', { requestId: record.requestId, fingerprint: record.fingerprint, ...record.binding }),
    writeArgs: () => ({ operation: 'write', sessionId, projectId: project.id, workspaceId: workspace.workspaceId, path: 'proof.txt', content: 'first', writeMode: 'CREATE', requestId: randomUUID() }),
  };
}
async function temp() { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-receipt-authority-'))); roots.push(root); return root; }
