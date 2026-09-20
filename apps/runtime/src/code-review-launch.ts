import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { parseJsonRejectDuplicateKeys } from './code-review-contract.js';

export interface ReviewGitMetadataIdentity {
  readonly root: string;
  readonly device: string;
  readonly inode: string;
}

export interface ReviewLaunchSpec {
  readonly schemaVersion: 1;
  readonly workspaceRoot: string;
  readonly context: string;
  readonly contextSha256: string;
  readonly reviewerProfileSha256: string;
  readonly gitMetadata: ReviewGitMetadataIdentity | null;
}

const MAX_CONTEXT_BYTES = 256 * 1024;
const LAUNCH_KEYS = ['context','contextSha256','gitMetadata','reviewerProfileSha256','schemaVersion','workspaceRoot'] as const;
const GIT_KEYS = ['device','inode','root'] as const;

export async function parseAndVerifyReviewLaunchSpec(raw: string, expectedWorkspace: string): Promise<ReviewLaunchSpec> {
  let value: unknown;
  try { value = parseJsonRejectDuplicateKeys(raw); }
  catch (error) { throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Review launch spec is not valid unambiguous JSON', { cause: error }); }
  if (!isRecord(value) || value.schemaVersion !== 1 || !hasExactKeys(value, LAUNCH_KEYS)) fail('Review launch spec schema is invalid');
  const workspaceRoot = boundedAbsolutePath(value.workspaceRoot, 'workspaceRoot');
  if (workspaceRoot !== expectedWorkspace) fail('Review launch workspace does not match the governed job cwd');
  const context = boundedString(value.context, 'context', MAX_CONTEXT_BYTES);
  const contextSha256 = sha256(value.contextSha256, 'contextSha256');
  if (createHash('sha256').update(context).digest('hex') !== contextSha256) fail('Review context hash does not match the launch spec');
  const reviewerProfileSha256 = sha256(value.reviewerProfileSha256, 'reviewerProfileSha256');

  let gitMetadata: ReviewGitMetadataIdentity | null = null;
  if (value.gitMetadata !== null) {
    if (!isRecord(value.gitMetadata) || !hasExactKeys(value.gitMetadata, GIT_KEYS)) fail('Review Git metadata identity is invalid');
    const root = boundedAbsolutePath(value.gitMetadata.root, 'gitMetadata.root');
    const device = numericIdentity(value.gitMetadata.device, 'gitMetadata.device');
    const inode = numericIdentity(value.gitMetadata.inode, 'gitMetadata.inode');
    let physical: string;
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      physical = await realpath(root);
      metadata = await lstat(root, { bigint: true });
    } catch (error) {
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Review Git metadata root is unavailable', { cause: error });
    }
    if (physical !== root || !metadata.isDirectory() || metadata.isSymbolicLink()
      || metadata.dev.toString() !== device || metadata.ino.toString() !== inode) {
      fail('Review Git metadata physical identity changed before permission activation');
    }
    gitMetadata = { root, device, inode };
  }

  return { schemaVersion: 1, workspaceRoot, context, contextSha256, reviewerProfileSha256, gitMetadata };
}

function boundedAbsolutePath(value: unknown, label: string): string {
  const item = boundedString(value, label, 4_000);
  if (!path.isAbsolute(item) || path.resolve(item) !== item) fail(`${label} is invalid`);
  return item;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxLength || value.includes('\0')) fail(`${label} is invalid`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} is invalid`);
  return value;
}

function numericIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) fail(`${label} is invalid`);
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function fail(message: string): never {
  throw new RuntimeError('AGENT_EXECUTION_FAILED', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
