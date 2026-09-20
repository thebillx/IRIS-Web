import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
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

export async function assertActivationWorkloadReady(root: string): Promise<void> {
  const physicalRoot = await realpath(root).catch((error: unknown) => {
    throw new RuntimeError('PRECONDITION_FAILED', 'Activation candidate root is unavailable', { cause: error });
  });
  const sourceEntrypoint = path.join(physicalRoot, 'apps', 'runtime', 'src', 'main.ts');
  const sourceMode = await lstat(sourceEntrypoint).then((metadata) => metadata.isFile(), () => false);
  if (sourceMode) {
    await verifyRuntimeDependency(physicalRoot, 'apps/runtime/node_modules/tsx/dist/preflight.cjs');
    await verifyRuntimeDependency(physicalRoot, 'apps/runtime/node_modules/tsx/dist/loader.mjs');
  } else {
    await verifyRuntimeDependency(physicalRoot, 'apps/runtime/dist/main.js');
  }
  await verifyRuntimeDependency(physicalRoot, 'apps/runtime/node_modules/@iris/domain/package.json');
  await verifyRuntimeDependency(physicalRoot, 'apps/runtime/node_modules/@iris/domain/src/index.ts');
  await verifyRuntimeDependency(physicalRoot, 'apps/runtime/node_modules/@iris/ado/package.json');
  await verifyRuntimeDependency(physicalRoot, 'apps/runtime/node_modules/@iris/ado/src/index.ts');
  await verifyRuntimeDependency(physicalRoot, 'packages/ado/node_modules/parse5/package.json');
  await verifyRuntimePackageDependency(physicalRoot, 'packages/ado/node_modules/parse5', 'entities');
  await verifyRuntimeDependency(physicalRoot, 'apps/web/node_modules/.bin/vite', true);
  await verifyRuntimeDependency(physicalRoot, 'apps/web/node_modules/vite/package.json');
  await verifyRuntimeDependency(physicalRoot, 'apps/web/node_modules/@vitejs/plugin-react/package.json');
  await verifyRuntimeDependency(physicalRoot, 'apps/web/node_modules/react/package.json');
  await verifyRuntimeDependency(physicalRoot, 'apps/web/node_modules/react-dom/package.json');
}

async function verifyRuntimeDependency(root: string, relative: string, executable = false): Promise<void> {
  const lexical = path.resolve(root, relative);
  if (!pathIsWithin(root, lexical)) throw new RuntimeError('PRECONDITION_FAILED', 'Activation runtime dependency escapes candidate root');
  const physical = await realpath(lexical).catch((error: unknown) => {
    throw new RuntimeError('PRECONDITION_FAILED', `Activation candidate is not runtime-ready: missing ${relative}`, { cause: error });
  });
  await verifyPhysicalRuntimeDependency(root, physical, relative, executable);
}

async function verifyRuntimePackageDependency(
  root: string,
  packageRelative: string,
  dependencyName: string,
): Promise<void> {
  const lexicalPackage = path.resolve(root, packageRelative);
  if (!pathIsWithin(root, lexicalPackage)) {
    throw new RuntimeError('PRECONDITION_FAILED', 'Activation runtime package dependency escapes candidate root');
  }
  const physicalPackage = await realpath(lexicalPackage).catch((error: unknown) => {
    throw new RuntimeError('PRECONDITION_FAILED', `Activation candidate is not runtime-ready: missing ${packageRelative}`, { cause: error });
  });
  if (!pathIsWithin(root, physicalPackage)) {
    throw new RuntimeError('PRECONDITION_FAILED', `Activation runtime package resolves outside candidate root: ${packageRelative}`);
  }
  // pnpm places a package's dependencies beside its physical package root in the
  // virtual store. npm-style layouts resolve through the same sibling shape.
  const dependency = path.join(path.dirname(physicalPackage), dependencyName, 'package.json');
  const physicalDependency = await realpath(dependency).catch((error: unknown) => {
    throw new RuntimeError(
      'PRECONDITION_FAILED',
      `Activation candidate is not runtime-ready: missing dependency ${dependencyName} for ${packageRelative}`,
      { cause: error },
    );
  });
  await verifyPhysicalRuntimeDependency(root, physicalDependency, `${packageRelative} -> ${dependencyName}/package.json`);
}

async function verifyPhysicalRuntimeDependency(
  root: string,
  physical: string,
  label: string,
  executable = false,
): Promise<void> {
  if (!pathIsWithin(root, physical)) {
    throw new RuntimeError('PRECONDITION_FAILED', `Activation runtime dependency resolves outside candidate root: ${label}`);
  }
  const metadata = await lstat(physical).catch((error: unknown) => {
    throw new RuntimeError('PRECONDITION_FAILED', `Activation runtime dependency metadata is unavailable: ${label}`, { cause: error });
  });
  if (!metadata.isFile()) throw new RuntimeError('PRECONDITION_FAILED', `Activation runtime dependency is not a regular file: ${label}`);
  if (executable) {
    await access(physical, fsConstants.X_OK).catch((error: unknown) => {
      throw new RuntimeError('PRECONDITION_FAILED', `Activation runtime dependency is not executable: ${label}`, { cause: error });
    });
  }
}

async function assertNoUntrackedWorkloadSource(root: string): Promise<void> {
  const untracked = splitNul(await boundedGit(root, [
    'ls-files', '--others', '--exclude-standard', '-z', '--',
    'apps/runtime', 'apps/web', 'packages/domain', 'packages/ado',
  ]));
  if (untracked.length > 0) {
    throw new RuntimeError(
      'PRECONDITION_FAILED',
      'Candidate workload source contains untracked files under apps/runtime, apps/web, packages/domain, or packages/ado',
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
