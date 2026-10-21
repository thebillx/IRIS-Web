import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateOwnerAccessSecret } from './persistence.js';
import {
  archiveRecoveryPolicyHistory,
  finalizeRecoveryPolicyOperation,
  issueRecoveryAuthorizationPolicy,
  readRecoveryAuthorizationPolicy,
  reserveRecoveryPolicyOperation,
  reconcileRecoveryPolicyLock,
  resolveFailedAdminTunnelStart,
  revokeRecoveryAuthorizationPolicy,
  recoveryPolicyPath,
} from './recovery-policy.js';
import type { RecoveryPolicyIssueInput } from './recovery-policy.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const sourceTree = '89abcdef0123456789abcdef0123456789abcdef';
const metadataSha = 'a'.repeat(64);
const plistSha = 'b'.repeat(64);
const sourceBinding = {
  sourceSha,
  sourceTree,
  sourceRoot: '/tmp/source',
  controlScript: '/tmp/source/control.ts',
  executable: '/usr/bin/node',
  executableArguments: ['--loader', 'loader.mjs'],
  runtimePreflightSha256: 'c'.repeat(64),
  runtimeLoaderSha256: 'd'.repeat(64),
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-recovery-policy-'));
  roots.push(root);
  await mkdir(path.join(root, 'launchd'), { mode: 0o700 });
  await loadOrCreateOwnerAccessSecret(root);
  return root;
}

async function sourceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-recovery-source-'));
  roots.push(root);
  await execFileAsync('/usr/bin/git', ['init', '-q', root]);
  await execFileAsync('/usr/bin/git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  await execFileAsync('/usr/bin/git', ['-C', root, 'config', 'user.name', 'IRIS test']);
  await writeFile(path.join(root, 'control.ts'), 'export {};\n');
  await execFileAsync('/usr/bin/git', ['-C', root, 'add', 'control.ts']);
  await execFileAsync('/usr/bin/git', ['-C', root, 'commit', '-q', '-m', 'fixture']);
  const { stdout: sourceShaOutput } = await execFileAsync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD']);
  const { stdout: sourceTreeOutput } = await execFileAsync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD^{tree}']);
  return { root: await realpath(root), sourceSha: sourceShaOutput.trim(), sourceTree: sourceTreeOutput.trim() };
}

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('recovery authorization policy', () => {
  it('requires a real terminal predecessor for explicit rollover', async () => {
    const dataRoot = await fixture();
    await expect(issueRecoveryAuthorizationPolicy({
      dataRoot,
      sourceBindings: [sourceBinding],
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      allowedOperations: ['SOURCE_MIGRATION'],
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      supersedesPolicyId: crypto.randomUUID(),
    })).rejects.toThrow('predecessor does not exist');
  });

  it('enrolls one bounded policy and journals dependent operations', async () => {
    const dataRoot = await fixture();
    const policy = await issueRecoveryAuthorizationPolicy({
      dataRoot,
      sourceBindings: [sourceBinding],
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      allowedOperations: ['MIGRATION_APPROVAL', 'SOURCE_MIGRATION'],
      maxOperationCount: 2,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const requestId = crypto.randomUUID();
    const reserved = await reserveRecoveryPolicyOperation({ dataRoot, policyId: policy.policyId, operation: 'MIGRATION_APPROVAL', requestId, ...sourceBinding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha });
    const committed = await finalizeRecoveryPolicyOperation({ dataRoot, policyId: policy.policyId, operation: 'MIGRATION_APPROVAL', requestId, transactionId: reserved.transactionId, state: 'COMMITTED', ...sourceBinding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha });
    expect(committed.operations[0]?.state).toBe('COMMITTED');

    const next = await reserveRecoveryPolicyOperation({
      dataRoot,
      policyId: policy.policyId,
      operation: 'SOURCE_MIGRATION',
      requestId,
      ...sourceBinding,
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
    });
    expect(next.state).toBe('RESERVED');
    await expect(
      reserveRecoveryPolicyOperation({
        dataRoot,
        policyId: crypto.randomUUID(),
        operation: 'SOURCE_MIGRATION',
        requestId: crypto.randomUUID(),
        ...sourceBinding,
        beforeMetadataSha256: metadataSha,
        beforePlistSha256: plistSha,
      }),
    ).rejects.toThrow('policy identity');
  });

  it('rejects tampering, scope drift and unresolved continuation', async () => {
    const dataRoot = await fixture();
    const policy = await issueRecoveryAuthorizationPolicy({ dataRoot, sourceBindings: [sourceBinding], beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, allowedOperations: ['SOURCE_MIGRATION'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const requestId = crypto.randomUUID();
    const reservation = await reserveRecoveryPolicyOperation({ dataRoot, policyId: policy.policyId, operation: 'SOURCE_MIGRATION', requestId, ...sourceBinding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha });
    await expect(reserveRecoveryPolicyOperation({ dataRoot, policyId: policy.policyId, operation: 'SOURCE_MIGRATION', requestId: crypto.randomUUID(), ...sourceBinding, sourceSha: sourceSha.slice(0, 39) + '0', beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha })).rejects.toThrow('source binding');
    await finalizeRecoveryPolicyOperation({ dataRoot, policyId: policy.policyId, operation: 'SOURCE_MIGRATION', requestId, transactionId: reservation.transactionId, state: 'RECONCILIATION_REQUIRED', ...sourceBinding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha });
    await expect(revokeRecoveryAuthorizationPolicy(dataRoot)).rejects.toThrow('unresolved');
    const policyFile = recoveryPolicyPath(dataRoot);
    const raw = await readFile(policyFile, 'utf8');
    await writeFile(policyFile, raw.replace('SOURCE_MIGRATION', 'MIGRATION_APPROVAL'));
    await expect(readRecoveryAuthorizationPolicy(dataRoot)).rejects.toThrow(/integrity|authentication/);
  });

  it('requires an explicit Supervisor bootstrap operation and preserves its journal boundary', async () => {
    const dataRoot = await fixture();
    const machineId = crypto.randomUUID();
    const bootstrapBinding = { ...sourceBinding, executableSha256: 'e'.repeat(64) };
    const policy = await issueRecoveryAuthorizationPolicy({
      dataRoot,
      sourceBindings: [bootstrapBinding],
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      allowedOperations: ['SUPERVISOR_BOOTSTRAP'],
      machineId,
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const requestId = crypto.randomUUID();
    await expect(reserveRecoveryPolicyOperation({
      dataRoot,
      policyId: policy.policyId,
      operation: 'SOURCE_MIGRATION',
      requestId,
      ...bootstrapBinding,
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      machineId,
    })).rejects.toThrow('does not authorize this operation');
    const reserved = await reserveRecoveryPolicyOperation({
      dataRoot,
      policyId: policy.policyId,
      operation: 'SUPERVISOR_BOOTSTRAP',
      requestId,
      ...bootstrapBinding,
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      machineId,
    });
    const committed = await finalizeRecoveryPolicyOperation({
      dataRoot,
      policyId: policy.policyId,
      operation: 'SUPERVISOR_BOOTSTRAP',
      requestId,
      transactionId: reserved.transactionId,
      state: 'COMMITTED',
      ...bootstrapBinding,
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      machineId,
    });
    expect(committed.operations).toHaveLength(1);
    expect(committed.operations[0]).toMatchObject({ operation: 'SUPERVISOR_BOOTSTRAP', state: 'COMMITTED', requestId });
    await expect(reserveRecoveryPolicyOperation({
      dataRoot,
      policyId: policy.policyId,
      operation: 'SUPERVISOR_BOOTSTRAP',
      requestId: crypto.randomUUID(),
      ...bootstrapBinding,
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      machineId,
    })).rejects.toThrow('operation limit');
  });

  it('uses a distinct bounded operation for the dedicated ADMIN tunnel', async () => {
    const dataRoot = await fixture();
    const machineId = crypto.randomUUID();
    const binding = { ...sourceBinding, executableSha256: 'f'.repeat(64) };
    const policy = await issueRecoveryAuthorizationPolicy({
      dataRoot,
      sourceBindings: [binding],
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      allowedOperations: ['ADMIN_TUNNEL_START'],
      machineId,
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const requestId = crypto.randomUUID();
    const reserved = await reserveRecoveryPolicyOperation({
      dataRoot,
      policyId: policy.policyId,
      operation: 'ADMIN_TUNNEL_START',
      requestId,
      ...binding,
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      machineId,
    });
    const committed = await finalizeRecoveryPolicyOperation({
      dataRoot,
      policyId: policy.policyId,
      operation: 'ADMIN_TUNNEL_START',
      requestId,
      transactionId: reserved.transactionId,
      state: 'COMMITTED',
      ...binding,
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      machineId,
    });
    expect(committed.operations[0]).toMatchObject({ operation: 'ADMIN_TUNNEL_START', state: 'COMMITTED' });
    await expect(reserveRecoveryPolicyOperation({
      dataRoot,
      policyId: policy.policyId,
      operation: 'SUPERVISOR_BOOTSTRAP',
      requestId: crypto.randomUUID(),
      ...binding,
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      machineId,
    })).rejects.toThrow('does not authorize this operation');
  });

  it('rejects expired and revoked bootstrap authority before any transaction is reserved', async () => {
    const expiredRoot = await fixture();
    const expiredMachineId = crypto.randomUUID();
    const bootstrapBinding = { ...sourceBinding, executableSha256: 'e'.repeat(64) };
    const expired = await issueRecoveryAuthorizationPolicy({
      dataRoot: expiredRoot,
      sourceBindings: [bootstrapBinding],
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      allowedOperations: ['SUPERVISOR_BOOTSTRAP'],
      machineId: expiredMachineId,
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 300).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(reserveRecoveryPolicyOperation({
      dataRoot: expiredRoot,
      policyId: expired.policyId,
      operation: 'SUPERVISOR_BOOTSTRAP',
      requestId: crypto.randomUUID(),
      ...bootstrapBinding,
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      machineId: expiredMachineId,
    })).rejects.toThrow('expired or revoked');

    const revokedRoot = await fixture();
    const revokedMachineId = crypto.randomUUID();
    const revoked = await issueRecoveryAuthorizationPolicy({
      dataRoot: revokedRoot,
      sourceBindings: [bootstrapBinding],
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      allowedOperations: ['SUPERVISOR_BOOTSTRAP'],
      machineId: revokedMachineId,
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await revokeRecoveryAuthorizationPolicy(revokedRoot);
    await expect(reserveRecoveryPolicyOperation({
      dataRoot: revokedRoot,
      policyId: revoked.policyId,
      operation: 'SUPERVISOR_BOOTSTRAP',
      requestId: crypto.randomUUID(),
      ...bootstrapBinding,
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      machineId: revokedMachineId,
    })).rejects.toThrow('expired or revoked');
  });

  it('supports explicit rollover while preserving signed history and replay tombstones', async () => {
    const dataRoot = await fixture();
    const policyA = await issueRecoveryAuthorizationPolicy({
      dataRoot,
      sourceBindings: [sourceBinding],
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      allowedOperations: ['SOURCE_MIGRATION'],
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const requestId = crypto.randomUUID();
    const reserved = await reserveRecoveryPolicyOperation({ dataRoot, policyId: policyA.policyId, operation: 'SOURCE_MIGRATION', requestId, ...sourceBinding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha });
    await finalizeRecoveryPolicyOperation({ dataRoot, policyId: policyA.policyId, operation: 'SOURCE_MIGRATION', requestId, transactionId: reserved.transactionId, state: 'COMMITTED', ...sourceBinding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha });
    await revokeRecoveryAuthorizationPolicy(dataRoot);

    await expect(issueRecoveryAuthorizationPolicy({
      dataRoot,
      sourceBindings: [{ ...sourceBinding, sourceRoot: '/tmp/source-b' }],
      beforeMetadataSha256: 'e'.repeat(64),
      beforePlistSha256: 'f'.repeat(64),
      allowedOperations: ['SOURCE_MIGRATION'],
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })).rejects.toThrow('requires explicit reconciliation');

    const policyB = await issueRecoveryAuthorizationPolicy({
      dataRoot,
      sourceBindings: [{ ...sourceBinding, sourceRoot: '/tmp/source-b' }],
      beforeMetadataSha256: 'e'.repeat(64),
      beforePlistSha256: 'f'.repeat(64),
      allowedOperations: ['SOURCE_MIGRATION'],
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      supersedesPolicyId: policyA.policyId,
    });
    expect(policyB.policyId).not.toBe(policyA.policyId);
    expect(policyB.supersedesPolicyId).toBe(policyA.policyId);
    expect(policyB.retiredPolicies).toHaveLength(1);
    expect(policyB.retiredPolicies?.[0]).toMatchObject({ policyId: policyA.policyId, state: 'REVOKED' });
    expect(policyB.retiredPolicies?.[0]).not.toHaveProperty('signature');
    expect(policyB.retiredPolicies?.[0]?.operations[0]?.requestId).toBe(requestId);
    const persisted = JSON.parse(await readFile(recoveryPolicyPath(dataRoot), 'utf8')) as { retiredPolicies?: Array<{ signature?: string }> };
    expect(persisted.retiredPolicies?.[0]?.signature).toMatch(/^[a-f0-9]{64}$/);
    await expect(reserveRecoveryPolicyOperation({ dataRoot, policyId: policyB.policyId, operation: 'SOURCE_MIGRATION', requestId, ...sourceBinding, sourceRoot: '/tmp/source-b', beforeMetadataSha256: 'e'.repeat(64), beforePlistSha256: 'f'.repeat(64) })).rejects.toThrow('retired policy history');
    await expect(readRecoveryAuthorizationPolicy(dataRoot)).resolves.toMatchObject({ policyId: policyB.policyId, supersedesPolicyId: policyA.policyId });

    const tampered = JSON.parse(await readFile(recoveryPolicyPath(dataRoot), 'utf8')) as { retiredPolicies: Array<{ signature: string }> };
    tampered.retiredPolicies[0]!.signature = `${tampered.retiredPolicies[0]!.signature[0] === '0' ? '1' : '0'}${tampered.retiredPolicies[0]!.signature.slice(1)}`;
    await writeFile(recoveryPolicyPath(dataRoot), `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(readRecoveryAuthorizationPolicy(dataRoot)).rejects.toThrow(/integrity|authentication/);
  });

  it('archives the 8/8 terminal history and preserves rollover replay protection', async () => {
    const dataRoot = await fixture();
    const source = await sourceFixture();
    const metadata = JSON.stringify({ schemaVersion: 3, sourceRoot: source.root });
    const plist = '<plist>fixture</plist>\n';
    const migration = JSON.stringify({ schemaVersion: 1, state: 'COMMITTED', targetSourceRoot: source.root, targetSourceSha: source.sourceSha, targetSourceTree: source.sourceTree });
    await writeFile(path.join(dataRoot, 'launchd', 'com.iris.supervisor.plist.metadata.json'), metadata, { mode: 0o600 });
    await writeFile(path.join(dataRoot, 'launchd', 'com.iris.supervisor.plist'), plist, { mode: 0o600 });
    await writeFile(path.join(dataRoot, 'launchd', 'com.iris.supervisor.source-binding-migration.json'), migration, { mode: 0o600 });
    const currentMetadataSha = createHash('sha256').update(metadata).digest('hex');
    const currentPlistSha = createHash('sha256').update(plist).digest('hex');
    const binding = { ...sourceBinding, sourceSha: source.sourceSha, sourceTree: source.sourceTree, sourceRoot: source.root };
    let policy = await issueRecoveryAuthorizationPolicy({ dataRoot, sourceBindings: [binding], beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, allowedOperations: ['SOURCE_MIGRATION'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const requestId = crypto.randomUUID();
    const reserved = await reserveRecoveryPolicyOperation({ dataRoot, policyId: policy.policyId, operation: 'SOURCE_MIGRATION', requestId, ...binding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha });
    await finalizeRecoveryPolicyOperation({ dataRoot, policyId: policy.policyId, operation: 'SOURCE_MIGRATION', requestId, transactionId: reserved.transactionId, state: 'COMMITTED', ...binding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha });
    for (let index = 0; index < 8; index += 1) {
      await revokeRecoveryAuthorizationPolicy(dataRoot);
      policy = await issueRecoveryAuthorizationPolicy({ dataRoot, sourceBindings: [binding], beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, allowedOperations: ['SOURCE_MIGRATION'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), supersedesPolicyId: policy.policyId });
    }
    await revokeRecoveryAuthorizationPolicy(dataRoot);
    expect(policy.retiredPolicies).toHaveLength(8);
    const archived = await archiveRecoveryPolicyHistory({ dataRoot, policyId: policy.policyId, sourceSha: source.sourceSha, sourceTree: source.sourceTree, sourceRoot: source.root, beforeMetadataSha256: currentMetadataSha, beforePlistSha256: currentPlistSha });
    expect(archived.retiredPolicies).toEqual([]);
    expect(archived.retiredPoliciesArchive?.policyIds).toHaveLength(9);
    await expect(archiveRecoveryPolicyHistory({ dataRoot, policyId: policy.policyId, sourceSha: source.sourceSha, sourceTree: source.sourceTree, sourceRoot: source.root, beforeMetadataSha256: currentMetadataSha, beforePlistSha256: currentPlistSha })).resolves.toMatchObject({ retiredPoliciesArchive: archived.retiredPoliciesArchive });
    const next = await issueRecoveryAuthorizationPolicy({ dataRoot, sourceBindings: [binding], beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, allowedOperations: ['SOURCE_MIGRATION'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), supersedesPolicyId: policy.policyId });
    expect(next.retiredPolicies).toHaveLength(1);
    await expect(reserveRecoveryPolicyOperation({ dataRoot, policyId: next.policyId, operation: 'SOURCE_MIGRATION', requestId, ...binding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha })).rejects.toThrow('retired policy history');
    await revokeRecoveryAuthorizationPolicy(dataRoot);
    const afterSecondRollover = await issueRecoveryAuthorizationPolicy({ dataRoot, sourceBindings: [binding], beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, allowedOperations: ['SOURCE_MIGRATION'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), supersedesPolicyId: next.policyId });
    expect(afterSecondRollover.retiredPolicies).toHaveLength(1);
    await expect(reserveRecoveryPolicyOperation({ dataRoot, policyId: afterSecondRollover.policyId, operation: 'SOURCE_MIGRATION', requestId, ...binding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha })).rejects.toThrow('retired policy history');
    await revokeRecoveryAuthorizationPolicy(dataRoot);
    const rearchived = await archiveRecoveryPolicyHistory({ dataRoot, policyId: afterSecondRollover.policyId, sourceSha: source.sourceSha, sourceTree: source.sourceTree, sourceRoot: source.root, beforeMetadataSha256: currentMetadataSha, beforePlistSha256: currentPlistSha });
    expect(rearchived.retiredPoliciesArchive?.policyIds[0]).toBe(afterSecondRollover.policyId);
    await expect(readRecoveryAuthorizationPolicy(dataRoot)).resolves.toMatchObject({ policyId: afterSecondRollover.policyId });
    const archiveFilename = path.join(dataRoot, 'launchd', rearchived.retiredPoliciesArchive!.filename);
    const archiveContent = await readFile(archiveFilename, 'utf8');
    await rm(archiveFilename);
    await expect(readRecoveryAuthorizationPolicy(dataRoot)).rejects.toThrow();
    await writeFile(archiveFilename, archiveContent, { mode: 0o600 });
    const tampered = JSON.parse(archiveContent) as { signature: string };
    tampered.signature = `${tampered.signature[0] === '0' ? '1' : '0'}${tampered.signature.slice(1)}`;
    await writeFile(archiveFilename, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    await expect(readRecoveryAuthorizationPolicy(dataRoot)).rejects.toThrow(/integrity|authentication/);
  });

  it('refuses rollover while the predecessor has unresolved work', async () => {
    const dataRoot = await fixture();
    const policyA = await issueRecoveryAuthorizationPolicy({ dataRoot, sourceBindings: [sourceBinding], beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, allowedOperations: ['SOURCE_MIGRATION'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const requestId = crypto.randomUUID();
    const reserved = await reserveRecoveryPolicyOperation({ dataRoot, policyId: policyA.policyId, operation: 'SOURCE_MIGRATION', requestId, ...sourceBinding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha });
    await finalizeRecoveryPolicyOperation({ dataRoot, policyId: policyA.policyId, operation: 'SOURCE_MIGRATION', requestId, transactionId: reserved.transactionId, state: 'RECONCILIATION_REQUIRED', ...sourceBinding, beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha });
    await expect(issueRecoveryAuthorizationPolicy({ dataRoot, sourceBindings: [{ ...sourceBinding, sourceRoot: '/tmp/source-b' }], beforeMetadataSha256: 'e'.repeat(64), beforePlistSha256: 'f'.repeat(64), allowedOperations: ['SOURCE_MIGRATION'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), supersedesPolicyId: policyA.policyId })).rejects.toThrow('unresolved operations');
  });

  it('terminally records a verified failed ADMIN tunnel start without committing it', async () => {
    const dataRoot = await fixture();
    const policy = await issueRecoveryAuthorizationPolicy({ dataRoot, sourceBindings: [{ ...sourceBinding, executableSha256: 'e'.repeat(64) }], beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, allowedOperations: ['ADMIN_TUNNEL_START'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), machineId: crypto.randomUUID() });
    const requestId = crypto.randomUUID();
    const operation = { dataRoot, policyId: policy.policyId, operation: 'ADMIN_TUNNEL_START' as const, requestId, transactionId: crypto.randomUUID(), ...sourceBinding, executableSha256: 'e'.repeat(64), beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, machineId: policy.machineId! };
    const reserved = await reserveRecoveryPolicyOperation(operation);
    await finalizeRecoveryPolicyOperation({ ...operation, transactionId: reserved.transactionId, state: 'RECONCILIATION_REQUIRED' });
    const failed = await resolveFailedAdminTunnelStart({ ...operation, transactionId: reserved.transactionId });
    expect(failed.operations[0]).toMatchObject({ operation: 'ADMIN_TUNNEL_START', state: 'FAILED', transactionId: reserved.transactionId });
    expect(failed.operations[0]?.state).not.toBe('COMMITTED');
    await expect(revokeRecoveryAuthorizationPolicy(dataRoot)).resolves.toMatchObject({ state: 'REVOKED' });
  });

  it('does not resolve a reserved ADMIN tunnel start directly as failed', async () => {
    const dataRoot = await fixture();
    const policy = await issueRecoveryAuthorizationPolicy({ dataRoot, sourceBindings: [{ ...sourceBinding, executableSha256: 'e'.repeat(64) }], beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, allowedOperations: ['ADMIN_TUNNEL_START'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), machineId: crypto.randomUUID() });
    const requestId = crypto.randomUUID();
    const operation = { dataRoot, policyId: policy.policyId, operation: 'ADMIN_TUNNEL_START' as const, requestId, transactionId: crypto.randomUUID(), ...sourceBinding, executableSha256: 'e'.repeat(64), beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, machineId: policy.machineId! };
    const reserved = await reserveRecoveryPolicyOperation(operation);
    await expect(resolveFailedAdminTunnelStart({ ...operation, transactionId: reserved.transactionId })).rejects.toThrow('reconciliation-required');
  });

  it('preserves an expired predecessor as expired while validating its original signature', async () => {
    const dataRoot = await fixture();
    const policyA = await issueRecoveryAuthorizationPolicy({
      dataRoot,
      sourceBindings: [sourceBinding],
      beforeMetadataSha256: metadataSha,
      beforePlistSha256: plistSha,
      allowedOperations: ['SOURCE_MIGRATION'],
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 1_500).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const policyB = await issueRecoveryAuthorizationPolicy({
      dataRoot,
      sourceBindings: [{ ...sourceBinding, sourceRoot: '/tmp/source-b' }],
      beforeMetadataSha256: 'e'.repeat(64),
      beforePlistSha256: 'f'.repeat(64),
      allowedOperations: ['SOURCE_MIGRATION'],
      maxOperationCount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      supersedesPolicyId: policyA.policyId,
    });
    expect(policyB.retiredPolicies?.[0]).toMatchObject({ policyId: policyA.policyId, state: 'EXPIRED' });
    await expect(readRecoveryAuthorizationPolicy(dataRoot)).resolves.toMatchObject({ policyId: policyB.policyId });
  });

  it('reconciles only an exact lock owned by a dead or reused process', async () => {
    const dataRoot = await fixture();
    const lockId = crypto.randomUUID();
    const lock = `${recoveryPolicyPath(dataRoot)}.lock`;
    await writeFile(lock, `${JSON.stringify({ schemaVersion: 1, lockId, pid: 999999, processStartMarker: '1:000001' })}\n`, { mode: 0o600 });
    const attempts = await Promise.allSettled([
      reconcileRecoveryPolicyLock(dataRoot, lockId, 999999, '1:000001'),
      reconcileRecoveryPolicyLock(dataRoot, lockId, 999999, '1:000001'),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects symlink and unsafe-mode advisory lock anchors before policy mutation', async () => {
    const dataRoot = await fixture();
    const anchor = `${recoveryPolicyPath(dataRoot)}.lock.flock`;
    const target = path.join(dataRoot, 'redirected-lock');
    await writeFile(target, '', { mode: 0o600 });
    await symlink(target, anchor);
    await expect(issueRecoveryAuthorizationPolicy({ dataRoot, sourceBindings: [sourceBinding], beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, allowedOperations: ['SOURCE_MIGRATION'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow();
    await rm(anchor);
    await writeFile(anchor, '', { mode: 0o666 });
    await chmod(anchor, 0o666);
    await expect(issueRecoveryAuthorizationPolicy({ dataRoot, sourceBindings: [sourceBinding], beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, allowedOperations: ['SOURCE_MIGRATION'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow();
  });

  it('does not let a contended helper acquire after its Node parent dies', async () => {
    const dataRoot = await fixture();
    const anchor = `${recoveryPolicyPath(dataRoot)}.lock.flock`;
    const holder = spawn('/usr/bin/python3', ['-I', '-S', '-c', "import fcntl, os, sys; fd=os.open(sys.argv[1], os.O_CREAT|os.O_RDWR, 0o600); fcntl.flock(fd, fcntl.LOCK_EX); print('READY', flush=True); sys.stdin.read()", anchor], { stdio: ['pipe', 'pipe', 'ignore'] });
    let holderOutput = '';
    await new Promise<void>((resolve, reject) => {
      holder.stdout?.on('data', (chunk) => { holderOutput += String(chunk); if (holderOutput.includes('READY')) resolve(); });
      holder.once('error', reject);
    });
    const script = path.join(dataRoot, 'contender.ts');
    const policyInput = { dataRoot, sourceBindings: [sourceBinding], beforeMetadataSha256: metadataSha, beforePlistSha256: plistSha, allowedOperations: ['SOURCE_MIGRATION'], maxOperationCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() } satisfies RecoveryPolicyIssueInput;
    const runtimeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    await writeFile(script, `import { issueRecoveryAuthorizationPolicy } from ${JSON.stringify(path.join(runtimeDirectory, 'src/recovery-policy.ts'))};\n(async () => { process.stdout.write('STARTED\\n'); await issueRecoveryAuthorizationPolicy(${JSON.stringify(policyInput)}); process.stdout.write('ACQUIRED\\n'); })().catch((error) => { console.error(error); process.exit(1); });\n`);
    const tsxDirectory = path.join(runtimeDirectory, 'node_modules/tsx/dist');
    const child = spawn(process.execPath, ['--require', path.join(tsxDirectory, 'preflight.cjs'), '--import', pathToFileURL(path.join(tsxDirectory, 'loader.mjs')).href, script], { cwd: runtimeDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
    let childOutput = '';
    let childError = '';
    child.stderr?.on('data', (chunk) => { childError += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', (chunk) => { childOutput += String(chunk); if (childOutput.includes('STARTED')) resolve(); });
      child.once('error', reject);
      setTimeout(() => reject(new Error(`contender did not start: ${childOutput} ${childError}`)), 2_000).unref();
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(childOutput).not.toContain('ACQUIRED');
    let helperObserved = false;
    let lastProcessList = '';
    for (let attempt = 0; attempt < 100 && !helperObserved; attempt += 1) {
      const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,args=']);
      lastProcessList = stdout;
      helperObserved = stdout.split('\n').some((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match !== null && match[2] === String(child.pid) && match[3] !== undefined && /python3|Python/.test(match[3]);
      });
      if (!helperObserved) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(helperObserved, lastProcessList.split('\n').filter((line) => line.includes(String(child.pid)) || line.includes(anchor)).join(' | ')).toBe(true);
    child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    holder.stdin?.end();
    if (holder.exitCode === null && holder.signalCode === null) await once(holder, 'exit');
    await expect(issueRecoveryAuthorizationPolicy(policyInput)).resolves.toMatchObject({ state: 'ISSUED' });
  });
});
