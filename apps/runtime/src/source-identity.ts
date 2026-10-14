import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { inspectActivationSourceIdentity, type ActivationSourceIdentity } from './activation-source-identity.js';

const execFileAsync = promisify(execFile);

export interface RuntimeSourceIdentity {
  readonly state: 'VERIFIED' | 'SOURCE_IDENTITY_UNVERIFIED';
  readonly sourceRoot: string | null;
  readonly branch: string | null;
  readonly commitSha: string | null;
  readonly sourceTreeSha: string | null;
  readonly candidateFingerprint: string | null;
  readonly trackedModifiedCount: number | null;
  readonly fingerprintAlgorithm: ActivationSourceIdentity['fingerprintAlgorithm'] | null;
  readonly reason?: string;
}

/** Read source identity without changing the worktree or trusting caller input. */
export async function readRuntimeSourceIdentity(root: string): Promise<RuntimeSourceIdentity> {
  try {
    const sourceRoot = await realpath(root);
    const [commitSha, sourceTreeSha, branch, activation] = await Promise.all([
      git(root, ['rev-parse', '--verify', 'HEAD']),
      git(root, ['rev-parse', '--verify', 'HEAD^{tree}']),
      git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      inspectActivationSourceIdentity(root),
    ]);
    if (!/^[0-9a-f]{40}$/i.test(commitSha) || !/^[0-9a-f]{40}$/i.test(sourceTreeSha) || branch.length === 0) {
      throw new Error('Git source identity is incomplete');
    }
    return {
      state: 'VERIFIED',
      sourceRoot,
      branch,
      commitSha: commitSha.toLowerCase(),
      sourceTreeSha: sourceTreeSha.toLowerCase(),
      candidateFingerprint: activation.candidateFingerprint,
      trackedModifiedCount: activation.trackedModifiedCount,
      fingerprintAlgorithm: activation.fingerprintAlgorithm,
    };
  } catch (error: unknown) {
    return {
      state: 'SOURCE_IDENTITY_UNVERIFIED',
      sourceRoot: null,
      branch: null,
      commitSha: null,
      sourceTreeSha: null,
      candidateFingerprint: null,
      trackedModifiedCount: null,
      fingerprintAlgorithm: null,
      reason: error instanceof Error ? error.message : 'Git source identity inspection failed',
    };
  }
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}
