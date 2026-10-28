import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  recoverRuntimeWithSourceFallback,
  type RecoveryRuntimeAdapter,
  type RecoverySourceDescriptor,
  type RuntimeObservedStatus,
} from './lifecycle.js';

const exec = promisify(execFile);

async function sourceFixture(label: string): Promise<{ root: string; descriptor: RecoverySourceDescriptor }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `iris-r10-${label}-`));
  const entrypoint = 'entry.mjs';
  await writeFile(path.join(root, entrypoint), `export const source = '${label}';\n`);
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', entrypoint]);
  await exec('git', ['-C', root, '-c', 'user.name=IRIS Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  const { stdout: commitSha } = await exec('git', ['-C', root, 'rev-parse', 'HEAD']);
  const { stdout: treeSha } = await exec('git', ['-C', root, 'rev-parse', 'HEAD^{tree}']);
  const { stdout: blobSha } = await exec('git', ['-C', root, 'hash-object', '--', entrypoint]);
  return {
    root,
    descriptor: {
      commitSha: commitSha.trim(),
      treeSha: treeSha.trim(),
      sourceRoot: root,
      entrypoint,
      entrypointGitBlob: blobSha.trim(),
    },
  };
}

const running = (): RuntimeObservedStatus => ({ state: 'running', endpoint: null, health: { status: 'ready' } as NonNullable<RuntimeObservedStatus['health']> });
const stopped = (): RuntimeObservedStatus => ({ state: 'stopped', endpoint: null, health: null });

async function cleanup(...roots: string[]): Promise<void> {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}

describe('product-owned runtime source fallback', () => {
  it('keeps B untouched when A reaches verified health', async () => {
    const [a, b, data] = await Promise.all([sourceFixture('a'), sourceFixture('b'), mkdtemp(path.join(os.tmpdir(), 'iris-r10-data-'))]);
    const calls: string[] = [];
    let stops = 0;
    let expectedSourceIdentity: unknown;
    const runtime: RecoveryRuntimeAdapter = {
      status: async () => stopped(),
      start: async (options) => { expectedSourceIdentity = options.expectedSourceIdentity; calls.push(options.sourceRoot ?? 'missing'); return running(); },
      stop: async () => { stops += 1; return stopped(); },
    };
    try {
      const receipt = await recoverRuntimeWithSourceFallback({ requestId: 'r10-a', dataRoot: data, receiptPath: path.join(data, 'receipt.json'), sourceA: a.descriptor, sourceB: b.descriptor, runtime });
      expect(receipt.outcome).toBe('COMMITTED');
      expect(receipt.selectedSource).toBe('A');
      expect(calls).toEqual([a.root]);
      expect(stops).toBe(0);
      expect(expectedSourceIdentity).toBeDefined();
      expect(JSON.parse(await readFile(path.join(data, 'receipt.json'), 'utf8')).sourceAFailure).toBeNull();
      expect(JSON.parse(await readFile(path.join(data, 'receipt.json.intent'), 'utf8')).state).toBe('FINALIZED');
    } finally { await cleanup(a.root, b.root, data); }
  });

  it('selects B only after A failure and proven cleanup', async () => {
    const [a, b, data] = await Promise.all([sourceFixture('a'), sourceFixture('b'), mkdtemp(path.join(os.tmpdir(), 'iris-r10-data-'))]);
    const calls: string[] = [];
    let stops = 0;
    const runtime: RecoveryRuntimeAdapter = {
      status: async () => stopped(),
      start: async (options) => { calls.push(options.sourceRoot ?? 'missing'); if (calls.length === 1) throw new Error('A health failed'); return running(); },
      stop: async () => { stops += 1; return stopped(); },
    };
    try {
      const receipt = await recoverRuntimeWithSourceFallback({ requestId: 'r10-b', dataRoot: data, receiptPath: path.join(data, 'receipt.json'), sourceA: a.descriptor, sourceB: b.descriptor, runtime });
      expect(receipt.selectedSource).toBe('B');
      expect(calls).toEqual([a.root, b.root]);
      expect(stops).toBe(1);
      const saved = JSON.parse(await readFile(path.join(data, 'receipt.json'), 'utf8')) as { sourceAFailure: string; sourceBFailure: null };
      expect(saved.sourceAFailure).toBe('A health failed');
      expect(saved.sourceBFailure).toBeNull();
    } finally { await cleanup(a.root, b.root, data); }
  });

  it('persists reconciliation and refuses replay after unknown cleanup', async () => {
    const [a, b, data] = await Promise.all([sourceFixture('a'), sourceFixture('b'), mkdtemp(path.join(os.tmpdir(), 'iris-r10-data-'))]);
    const receiptPath = path.join(data, 'receipt.json');
    let starts = 0;
    const runtime: RecoveryRuntimeAdapter = {
      status: async () => stopped(),
      start: async () => { starts += 1; throw new Error('A health failed'); },
      stop: async () => { throw new Error('unknown stop outcome'); },
    };
    try {
      await expect(recoverRuntimeWithSourceFallback({ requestId: 'r10-unknown', dataRoot: data, receiptPath, sourceA: a.descriptor, sourceB: b.descriptor, runtime })).rejects.toThrow('unknown stop outcome');
      const saved = JSON.parse(await readFile(receiptPath, 'utf8')) as { outcome: string };
      expect(saved.outcome).toBe('RECONCILIATION_REQUIRED');
      await expect(recoverRuntimeWithSourceFallback({ requestId: 'r10-unknown', dataRoot: data, receiptPath, sourceA: a.descriptor, sourceB: b.descriptor, runtime })).rejects.toThrow('explicit reconciliation');
      expect(starts).toBe(1);
    } finally { await cleanup(a.root, b.root, data); }
  });

  it('rejects a drifted B before fallback startup', async () => {
    const [a, b, data] = await Promise.all([sourceFixture('a'), sourceFixture('b'), mkdtemp(path.join(os.tmpdir(), 'iris-r10-data-'))]);
    const calls: string[] = [];
    let stops = 0;
    const runtime: RecoveryRuntimeAdapter = {
      status: async () => stopped(),
      start: async (options) => {
        calls.push(options.sourceRoot ?? 'missing');
        await writeFile(path.join(b.root, b.descriptor.entrypoint), 'drifted\n');
        throw new Error('A health failed');
      },
      stop: async () => { stops += 1; return stopped(); },
    };
    try {
      await expect(recoverRuntimeWithSourceFallback({ requestId: 'r10-drift', dataRoot: data, receiptPath: path.join(data, 'receipt.json'), sourceA: a.descriptor, sourceB: b.descriptor, runtime })).rejects.toThrow('Recovery source attestation changed');
      expect(calls).toEqual([a.root]);
    } finally { await cleanup(a.root, b.root, data); }
  });
  it('rejects identical source descriptors and receipt escape', async () => {
    const [a, data] = await Promise.all([sourceFixture('same'), mkdtemp(path.join(os.tmpdir(), 'iris-r10-data-'))]);
    try {
      await expect(recoverRuntimeWithSourceFallback({
        requestId: 'r10-identical', dataRoot: data, receiptPath: path.join(data, 'receipt.json'),
        sourceA: a.descriptor, sourceB: a.descriptor, runtime: { status: async () => stopped(), start: async () => running(), stop: async () => stopped() },
      })).rejects.toThrow('distinct immutable identities');
      await expect(recoverRuntimeWithSourceFallback({
        requestId: 'r10-escape', dataRoot: data, receiptPath: path.join(data, '..', 'receipt.json'),
        sourceA: a.descriptor, sourceB: { ...a.descriptor, commitSha: '0000000000000000000000000000000000000000' },
        runtime: { status: async () => stopped(), start: async () => running(), stop: async () => stopped() },
      })).rejects.toThrow();
    } finally { await cleanup(a.root, data); }
  });

  it('allows one durable claim and refuses an existing in-progress claim', async () => {
    const [a, b, data] = await Promise.all([sourceFixture('a'), sourceFixture('b'), mkdtemp(path.join(os.tmpdir(), 'iris-r10-data-'))]);
    const input = { requestId: 'r10-claim', dataRoot: data, receiptPath: path.join(data, 'receipt.json'), sourceA: a.descriptor, sourceB: b.descriptor };
    let release!: () => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime: RecoveryRuntimeAdapter = {
      status: async () => stopped(),
      start: async () => { enteredResolve(); await gate; return running(); },
      stop: async () => stopped(),
    };
    try {
      const first = recoverRuntimeWithSourceFallback({ ...input, runtime });
      await entered;
      await expect(recoverRuntimeWithSourceFallback({ ...input, runtime })).rejects.toThrow('intent already exists');
      release();
      await first;
    } finally { release(); await cleanup(a.root, b.root, data); }
  });

});
