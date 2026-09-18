import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError } from '@iris/domain';
import { pathIsWithin } from './project-path.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;

export const ACTIVATION_FINGERPRINT_ALGORITHM = 'sha256:sorted-tracked-path-content-v1' as const;

export interface ActivationSourceIdentity {
  readonly head: string;
  readonly candidateFingerprint: string;
  readonly trackedModifiedCount: number;
  readonly fingerprintAlgorithm: typeof ACTIVATION_FINGERPRINT_ALGORITHM;
}

export async function inspectActivationSourceIdentity(root: string): Promise<ActivationSourceIdentity> {
  const headBefore = await gitHead(root);
  await assertNoUntrackedWorkloadSource(root);
  const fingerprint = await trackedCandidateFingerprint(root);
  const headAfter = await gitHead(root);
  if (headAfter !== headBefore) {
    throw new RuntimeError('PRECONDITION_FAILED', 'Candidate HEAD changed while source identity was being inspected');
  }
  return {
    head: headBefore,
    candidateFingerprint: fingerprint.sha256,
    trackedModifiedCount: fingerprint.trackedModifiedCount,
    fingerprintAlgorithm: ACTIVATION_FINGERPRINT_ALGORITHM,
  };
}

export async function assertActivationSourceIdentity(
  root: string,
  expected: ActivationSourceIdentity,
  message = 'Candidate source identity changed',
): Promise<ActivationSourceIdentity> {
  validateExpectedIdentity(expected);
  const current = await inspectActivationSourceIdentity(root);
  if (current.head !== expected.head
    || current.candidateFingerprint !== expected.candidateFingerprint
    || current.trackedModifiedCount !== expected.trackedModifiedCount
    || current.fingerprintAlgorithm !== expected.fingerprintAlgorithm) {
    throw new RuntimeError('PRECONDITION_FAILED', message);
  }
  return current;
}

async function assertNoUntrackedWorkloadSource(root: string): Promise<void> {
  const untracked = splitNul(await boundedGit(root, [
    'ls-files', '--others', '--exclude-standard', '-z', '--', 'apps/runtime', 'apps/web',
  ]));
  if (untracked.length > 0) {
    throw new RuntimeError(
      'PRECONDITION_FAILED',
      'Candidate workload source contains untracked files under apps/runtime or apps/web',
    );
  }
}

async function gitHead(root: string): Promise<string> {
  const value = (await boundedGit(root, ['rev-parse', 'HEAD'])).trim();
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new RuntimeError('CAPABILITY_DENIED', 'Candidate HEAD is not a full Git commit identity');
  return value.toLowerCase();
}

async function trackedCandidateFingerprint(root: string): Promise<{ readonly sha256: string; readonly trackedModifiedCount: number }> {
  const changed = splitNul(await boundedGit(root, ['diff', '--name-only', '-z', '--diff-filter=ACMRTUXB', 'HEAD', '--']));
  const deleted = splitNul(await boundedGit(root, ['diff', '--name-only', '-z', '--diff-filter=D', 'HEAD', '--']));
  const rows: string[] = [];
  for (const relative of [...new Set(changed)].sort()) {
    const absolute = await verifyContainedRegularFile(root, relative);
    const sha = createHash('sha256').update(await readFile(absolute)).digest('hex');
    rows.push(`F\0${relative}\0${sha}\n`);
  }
  for (const relative of [...new Set(deleted)].sort()) rows.push(`D\0${relative}\0\n`);
  rows.sort();
  return {
    sha256: createHash('sha256').update(rows.join('')).digest('hex'),
    trackedModifiedCount: rows.length,
  };
}

async function verifyContainedRegularFile(root: string, relative: string): Promise<string> {
  if (relative.length === 0 || relative.includes('\0') || path.isAbsolute(relative)) throw new RuntimeError('CAPABILITY_DENIED', 'Candidate tracked path is invalid');
  const normalized = path.normalize(relative);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new RuntimeError('CAPABILITY_DENIED', 'Candidate tracked path escapes workspace');
  const absolute = path.resolve(root, normalized);
  const metadata = await lstat(absolute).catch((error: unknown) => {
    throw new RuntimeError('CAPABILITY_DENIED', 'Candidate tracked file is unavailable', { cause: error });
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new RuntimeError('CAPABILITY_DENIED', 'Candidate fingerprint accepts only physical tracked regular files');
  const physical = await realpath(absolute);
  if (physical !== absolute || !pathIsWithin(root, physical)) throw new RuntimeError('CAPABILITY_DENIED', 'Candidate tracked file changed through a filesystem alias');
  return physical;
}

async function boundedGit(root: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', [...args], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: MAX_GIT_OUTPUT });
    return result.stdout;
  } catch (error) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Bounded activation Git identity inspection failed', { cause: error });
  }
}

function validateExpectedIdentity(value: ActivationSourceIdentity): void {
  if (!/^[0-9a-f]{40}$/.test(value.head)
    || !/^[0-9a-f]{64}$/.test(value.candidateFingerprint)
    || !Number.isSafeInteger(value.trackedModifiedCount) || value.trackedModifiedCount < 0
    || value.fingerprintAlgorithm !== ACTIVATION_FINGERPRINT_ALGORITHM) {
    throw new RuntimeError('INVALID_REQUEST', 'Expected activation source identity is invalid');
  }
}

function splitNul(value: string): string[] {
  return value.split('\0').filter((item) => item.length > 0);
}
