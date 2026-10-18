import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateOwnerAccessSecret } from './persistence.js';
import {
  finalizeRecoveryPolicyOperation,
  issueRecoveryAuthorizationPolicy,
  readRecoveryAuthorizationPolicy,
  reserveRecoveryPolicyOperation,
  reconcileRecoveryPolicyLock,
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

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('recovery authorization policy', () => {
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
    await expect(readRecoveryAuthorizationPolicy(dataRoot)).rejects.toThrow('authentication');
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
