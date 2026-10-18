import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateOwnerAccessSecret, FoundationStateStore } from './persistence.js';
import { MissionDelegationStore, readVerifiedSourceIdentity } from './mission-delegation.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('mission-scoped owner delegation', () => {
  it('authorizes one bounded operation, rejects replay and preserves an authenticated audit document', async () => {
    const root = await temp('iris-delegation-');
    await loadOrCreateOwnerAccessSecret(root);
    const store = new MissionDelegationStore(root);
    const missionId = '11111111-1111-4111-8111-111111111111';
    const ownerSessionId = '22222222-2222-4222-8222-222222222222';
    const issued = await store.issue({
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      missionId, ownerClientId: 'chatgpt-client', ownerSessionId,
      trustedAgentIds: ['codex-executor'], allowedCapabilities: ['file.write'], projectIds: ['project-a'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1,
    });
    const allowed = await store.authorize({ missionId, clientId: 'chatgpt-client', sessionId: ownerSessionId, agentId: 'codex-executor', capabilityId: 'file.write', projectId: 'project-a', operationId: '33333333-3333-4333-8333-333333333333', riskClass: 'MODERATE' });
    expect(allowed.status).toBe('allowed');
    if (allowed.status !== 'allowed') return;
    expect(allowed.record.delegationId).toBe(issued.delegationId);
    await expect(store.authorize({ missionId, clientId: 'chatgpt-client', sessionId: ownerSessionId, agentId: 'codex-executor', capabilityId: 'file.write', projectId: 'project-a', operationId: '33333333-3333-4333-8333-333333333333', riskClass: 'MODERATE' })).resolves.toMatchObject({ status: 'blocked' });
    await expect(readFile(path.join(root, 'mission-delegations.json'), 'utf8')).resolves.toMatch(/"consumedOperationIds"\s*:\s*\[\s*"33333333-3333-4333-8333-333333333333"/);
  });

  it('makes a matching mission action automatic while keeping out-of-scope work denied', async () => {
    const sourceRoot = await realpath(await temp('iris-delegation-source-'));
    const dataRoot = await realpath(await temp('iris-delegation-data-'));
    const projectRoot = path.join(sourceRoot, 'project');
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, 'input.txt'), 'input');
    await loadOrCreateOwnerAccessSecret(dataRoot);
    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    const project = await state.registerProject('Project', projectRoot);
    const session = state.createSession('chatgpt-client', 'codex-executor', 'implementer');
    await state.setSessionCurrentProject(session.id, session.clientId, project.id);
    const missionId = '44444444-4444-4444-8444-444444444444';
    const delegations = new MissionDelegationStore(dataRoot);
    await delegations.issue({ requestId: 'abababab-abab-4bab-8bab-abababababab', missionId, ownerClientId: session.clientId, ownerSessionId: session.id, trustedAgentIds: [session.agentId], allowedCapabilities: ['file.write'], projectIds: [project.id], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 });
    const settings = new PermissionSettingsStore(dataRoot);
    await settings.initialize();
    const engine = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, path.join(sourceRoot, 'legacy'), delegations);
    await expect(engine.evaluate({ capabilityId: 'file.write', clientId: session.clientId, sessionId: session.id, missionId, taskId: '55555555-5555-4555-8555-555555555555', actionId: '66666666-6666-4666-8666-666666666666', projectId: project.id, targetPath: path.join(projectRoot, 'input.txt') })).resolves.toMatchObject({ decision: 'ALLOW_AUTO', authorityDigest: expect.any(String) });
    await expect(engine.evaluate({ capabilityId: 'file.write', clientId: session.clientId, sessionId: session.id, missionId, taskId: '55555555-5555-4555-8555-555555555555', actionId: '77777777-7777-4777-8777-777777777777', projectId: 'other-project', targetPath: path.join(projectRoot, 'other.txt') })).resolves.toMatchObject({ decision: 'DENY' });
  });

  it('does not let a delegation bypass high-risk authority', async () => {
    const root = await temp('iris-delegation-high-');
    await loadOrCreateOwnerAccessSecret(root);
    const store = new MissionDelegationStore(root);
    await store.issue({ requestId: '88888880-8888-4888-8888-888888888888', missionId: '88888888-8888-4888-8888-888888888888', ownerClientId: 'owner', ownerSessionId: '99999999-9999-4999-8999-999999999999', trustedAgentIds: ['agent'], allowedCapabilities: ['system.sudo'], projectIds: ['project-a'], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 });
    await expect(store.authorize({ missionId: '88888888-8888-4888-8888-888888888888', clientId: 'owner', sessionId: '99999999-9999-4999-8999-999999999999', agentId: 'agent', capabilityId: 'system.sudo', operationId: 'aaaaaaa0-aaaa-4aaa-8aaa-aaaaaaaaaaaa', riskClass: 'SYSTEM' })).resolves.toMatchObject({ status: 'blocked' });
  });

  it('fails closed for expiry, revocation, and tampered durable state', async () => {
    const root = await temp('iris-delegation-revocation-');
    await loadOrCreateOwnerAccessSecret(root);
    const store = new MissionDelegationStore(root);
    const spec = { requestId: 'bbbbbbb0-bbbb-4bbb-8bbb-bbbbbbbbbbbb', missionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerClientId: 'owner', ownerSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', trustedAgentIds: ['agent'], allowedCapabilities: ['file.read'], projectIds: ['project-a'], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 };
    const issued = await store.issue(spec);
    await store.revoke(issued.delegationId, spec.ownerClientId, spec.ownerSessionId);
    await expect(store.authorize({ missionId: spec.missionId, clientId: spec.ownerClientId, sessionId: spec.ownerSessionId, agentId: 'agent', capabilityId: 'file.read', operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', riskClass: 'LOW' })).resolves.toMatchObject({ status: 'blocked' });
    const filename = path.join(root, 'mission-delegations.json');
    const original = await readFile(filename, 'utf8');
    await writeFile(filename, original.replace('"mac":', '"mac":"tampered", "ignored":'));
    await expect(store.authorize({ missionId: spec.missionId, clientId: spec.ownerClientId, sessionId: spec.ownerSessionId, agentId: 'agent', capabilityId: 'file.read', operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', riskClass: 'LOW' })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('rejects an expired grant without consuming authority', async () => {
    const root = await temp('iris-delegation-expiry-');
    await loadOrCreateOwnerAccessSecret(root);
    const store = new MissionDelegationStore(root);
    const now = Date.now();
    const grant = await store.issue({ requestId: randomUUID(), missionId: randomUUID(), ownerClientId: 'owner', ownerSessionId: randomUUID(), trustedAgentIds: ['agent'], allowedCapabilities: ['file.read'], projectIds: ['project-a'], expiresAt: new Date(now + 60_000).toISOString(), maxExecutions: 1 });
    const before = await readFile(path.join(root, 'mission-delegations.json'), 'utf8');
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    await expect(store.authorize({ missionId: grant.missionId, clientId: grant.ownerClientId, sessionId: grant.ownerSessionId, agentId: 'agent', capabilityId: 'file.read', projectId: 'project-a', operationId: randomUUID(), riskClass: 'LOW' })).resolves.toMatchObject({ status: 'blocked', reason: expect.stringContaining('expired') });
    await expect(readFile(path.join(root, 'mission-delegations.json'), 'utf8')).resolves.toBe(before);
  });

  it('rejects foreign project, workspace, agent and owner identities without consuming a valid grant', async () => {
    const root = await temp('iris-delegation-scopes-');
    await loadOrCreateOwnerAccessSecret(root);
    const store = new MissionDelegationStore(root);
    const grant = await store.issue({ requestId: randomUUID(), missionId: randomUUID(), ownerClientId: 'owner', ownerSessionId: randomUUID(), trustedAgentIds: ['agent'], allowedCapabilities: ['fs.read'], projectIds: ['project-a'], workspaceIds: ['workspace-a'], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 });
    const input = { missionId: grant.missionId, clientId: grant.ownerClientId, sessionId: grant.ownerSessionId, agentId: 'agent', capabilityId: 'fs.read', projectId: 'project-a', workspaceId: 'workspace-a', operationId: randomUUID(), riskClass: 'LOW' as const };
    for (const mismatch of [{ projectId: 'foreign' }, { workspaceId: 'foreign' }, { agentId: 'foreign' }, { sessionId: randomUUID() }, { clientId: 'foreign' }]) {
      await expect(store.authorize({ ...input, ...mismatch })).resolves.toMatchObject({ status: 'blocked' });
    }
    await expect(store.authorize(input)).resolves.toMatchObject({ status: 'allowed' });
  });

  it('requires an exact source pair when a delegation is source-bound', async () => {
    const root = await temp('iris-delegation-source-bound-');
    await loadOrCreateOwnerAccessSecret(root);
    const store = new MissionDelegationStore(root);
    const spec = { requestId: '12121210-1212-4121-8121-121212121212', missionId: '12121212-1212-4121-8121-121212121212', ownerClientId: 'owner', ownerSessionId: '13131313-1313-4131-8131-131313131313', trustedAgentIds: ['agent'], allowedCapabilities: ['file.read'], projectIds: ['project-a'], sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sourceTree: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 };
    await store.issue(spec);
    await expect(store.authorize({ missionId: spec.missionId, clientId: spec.ownerClientId, sessionId: spec.ownerSessionId, agentId: 'agent', capabilityId: 'file.read', sourceSha: 'cccccccccccccccccccccccccccccccccccccccc', sourceTree: spec.sourceTree, operationId: '14141414-1414-4141-8141-141414141414', riskClass: 'LOW' })).resolves.toMatchObject({ status: 'blocked' });
  });

  it('serializes concurrent consumption and rejects replayed request ids', async () => {
    const root = await temp('iris-delegation-concurrent-');
    await loadOrCreateOwnerAccessSecret(root);
    const store = new MissionDelegationStore(root);
    const spec = { requestId: '15151510-1515-4151-8151-151515151515', missionId: '15151515-1515-4151-8151-151515151515', ownerClientId: 'owner', ownerSessionId: '16161616-1616-4161-8161-161616161616', trustedAgentIds: ['worker-a'], allowedCapabilities: ['file.write'], projectIds: ['project-a'], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 };
    const issued = await store.issue(spec);
    await expect(store.issue(spec)).resolves.toMatchObject({ delegationId: issued.delegationId, digest: issued.digest });
    const results = await Promise.all([
      store.authorize({ missionId: spec.missionId, clientId: spec.ownerClientId, sessionId: spec.ownerSessionId, agentId: 'worker-a', capabilityId: 'file.write', projectId: 'project-a', operationId: '17171717-1717-4171-8171-171717171717', riskClass: 'MODERATE' }),
      store.authorize({ missionId: spec.missionId, clientId: spec.ownerClientId, sessionId: spec.ownerSessionId, agentId: 'worker-a', capabilityId: 'file.write', projectId: 'project-a', operationId: '18181818-1818-4181-8181-181818181818', riskClass: 'MODERATE' }),
    ]);
    expect(results.filter((result) => result.status === 'allowed')).toHaveLength(1);
    const reloaded = new MissionDelegationStore(root);
    await expect(reloaded.authorize({ missionId: spec.missionId, clientId: spec.ownerClientId, sessionId: spec.ownerSessionId, agentId: 'worker-a', capabilityId: 'file.write', projectId: 'project-a', operationId: '19191919-1919-4191-8191-191919191919', riskClass: 'MODERATE' })).resolves.toMatchObject({ status: 'blocked' });
    await expect(reloaded.revoke(issued.delegationId, spec.ownerClientId, spec.ownerSessionId)).resolves.toBeUndefined();
  });

  it('requires explicit workspace scope for filesystem capabilities', async () => {
    const root = await temp('iris-delegation-workspace-');
    await loadOrCreateOwnerAccessSecret(root);
    const store = new MissionDelegationStore(root);
    await expect(store.issue({ requestId: '19191919-1919-4191-8191-191919191919', missionId: '20202020-2020-4202-8202-202020202020', ownerClientId: 'owner', ownerSessionId: '21212121-2121-4212-8212-212121212121', trustedAgentIds: ['agent'], allowedCapabilities: ['fs.read'], projectIds: ['project-a'], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('compacts terminal delegation records while retaining authenticated history digests', async () => {
    const root = await temp('iris-delegation-compaction-');
    await loadOrCreateOwnerAccessSecret(root);
    const store = new MissionDelegationStore(root);
    for (let index = 0; index < 128; index += 1) {
      const id = `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;
      const missionId = `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;
      const issued = await store.issue({ requestId: id, missionId, ownerClientId: 'owner', ownerSessionId: '31313131-3131-4131-8131-313131313131', trustedAgentIds: ['agent'], allowedCapabilities: ['file.read'], projectIds: ['project-a'], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 });
      await store.revoke(issued.delegationId, 'owner', '31313131-3131-4131-8131-313131313131');
    }
    const issued = await store.issue({ requestId: '32323232-3232-4232-8232-323232323232', missionId: '33333333-3333-4333-8333-333333333333', ownerClientId: 'owner', ownerSessionId: '34343434-3434-4434-8434-343434343434', trustedAgentIds: ['agent'], allowedCapabilities: ['file.read'], projectIds: ['project-a'], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 });
    expect(issued.delegationId).toMatch(/[0-9a-f-]{36}/);
    const document = JSON.parse(await readFile(path.join(root, 'mission-delegations.json'), 'utf8')) as { archivedDelegations?: readonly { requestId: string; specificationDigest: string; terminalDigest: string }[] };
    expect(document.archivedDelegations).toHaveLength(128);
    expect(document.archivedDelegations?.[0]).toMatchObject({ requestId: expect.any(String), specificationDigest: expect.stringMatching(/^[a-f0-9]{64}$/), terminalDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('does not reuse a retired request id after compaction', async () => {
    const root = await temp('iris-delegation-tombstone-');
    await loadOrCreateOwnerAccessSecret(root);
    const store = new MissionDelegationStore(root);
    const ownerSessionId = '38383838-3838-4383-8383-383838383838';
    const original = { requestId: '39393939-3939-4393-8393-393939393939', missionId: '40404040-4040-4404-8404-404040404040', ownerClientId: 'owner', ownerSessionId, trustedAgentIds: ['agent'], allowedCapabilities: ['file.read'], projectIds: ['project-a'], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 };
    const first = await store.issue(original);
    await store.revoke(first.delegationId, 'owner', ownerSessionId);
    for (let index = 0; index < 128; index += 1) {
      const issued = await store.issue({ ...original, requestId: `${String(index).padStart(8, '0')}-2222-4222-8222-222222222222`, missionId: `${String(index).padStart(8, '0')}-3333-4333-8333-333333333333` });
      await store.revoke(issued.delegationId, 'owner', ownerSessionId);
    }
    await expect(store.issue({ ...original, requestId: '42424242-4242-4424-8424-424242424242', missionId: '43434343-4343-4434-8434-434343434343' })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await expect(store.issue({ ...original, projectIds: ['project-b'] })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });

  it('derives source identity from the configured repository instead of trusting the issuer', async () => {
    const root = await temp('iris-delegation-source-');
    await loadOrCreateOwnerAccessSecret(root);
    const store = new MissionDelegationStore(root, process.cwd());
    const base = { requestId: '35353535-3535-4353-8353-353535353535', missionId: '36363636-3636-4363-8363-363636363636', ownerClientId: 'owner', ownerSessionId: '37373737-3737-4373-8373-373737373737', trustedAgentIds: ['agent'], allowedCapabilities: ['file.read'], projectIds: ['project-a'], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 };
    await expect(store.issue({ ...base, sourceSha: 'a'.repeat(40), sourceTree: 'b'.repeat(40) })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    const issued = await store.issue(base);
    expect(issued.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(issued.sourceTree).toMatch(/^[0-9a-f]{40}$/);
    const actual = await readVerifiedSourceIdentity(process.cwd());
    const drifted = new MissionDelegationStore(root, process.cwd(), { sha: 'a'.repeat(40), tree: actual.tree });
    await expect(drifted.issue({ ...base, requestId: '41414141-4141-4414-8414-414141414141' })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    const unavailable = new MissionDelegationStore(root, process.cwd(), undefined, true);
    await expect(unavailable.issue({ ...base, requestId: '42424242-4242-4424-8424-424242424242' })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('binds worker execution to the verified worker identity', async () => {
    const sourceRoot = await realpath(await temp('iris-delegation-worker-source-'));
    const dataRoot = await realpath(await temp('iris-delegation-worker-data-'));
    const projectRoot = path.join(sourceRoot, 'project');
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, 'input.txt'), 'input');
    await loadOrCreateOwnerAccessSecret(dataRoot);
    const state = new RuntimeState(new FoundationStateStore(dataRoot));
    const project = await state.registerProject('Project', projectRoot);
    const session = state.createSession('chatgpt-client', 'session-agent', 'implementer');
    await state.setSessionCurrentProject(session.id, session.clientId, project.id);
    const missionId = '22222222-2222-4222-8222-222222222222';
    const delegations = new MissionDelegationStore(dataRoot);
    await delegations.issue({ requestId: '23232323-2323-4232-8232-232323232323', missionId, ownerClientId: session.clientId, ownerSessionId: session.id, trustedAgentIds: ['worker-a'], allowedCapabilities: ['file.write'], projectIds: [project.id], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxExecutions: 1 });
    const settings = new PermissionSettingsStore(dataRoot);
    await settings.initialize();
    const engine = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, path.join(sourceRoot, 'legacy'), delegations);
    await expect(engine.evaluate({ capabilityId: 'file.write', clientId: session.clientId, sessionId: session.id, workerId: 'worker-a', missionId, actionId: '24242424-2424-4242-8242-242424242424', projectId: project.id, targetPath: path.join(projectRoot, 'input.txt') })).resolves.toMatchObject({ decision: 'ALLOW_AUTO' });
    await expect(engine.evaluate({ capabilityId: 'file.write', clientId: session.clientId, sessionId: session.id, workerId: 'foreign-worker', missionId, actionId: '25252525-2525-4252-8252-252525252525', projectId: project.id, targetPath: path.join(projectRoot, 'input.txt') })).resolves.toMatchObject({ decision: 'DENY' });
  });
});

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
