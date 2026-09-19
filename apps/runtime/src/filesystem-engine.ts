import type { Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type WorkspaceRecord } from '@iris/domain';
import { secureProjectFileEdit, secureProjectMutation } from './macos-safety.js';
import type { VNextResourceRegistry } from './resource-registry.js';
import {
  secureWorkspaceAppend,
  secureWorkspaceCreate,
  secureWorkspaceHash,
  secureWorkspaceReadRange,
  secureWorkspaceReadText,
  secureWorkspaceReplace,
} from './workspace-fs-safety.js';

const DEFAULT_MAX_DEPTH = 4;
const MAX_MAX_DEPTH = 20;
const DEFAULT_MAX_ENTRIES = 200;
const MAX_MAX_ENTRIES = 2_000;
const MAX_SCAN_ENTRIES = 50_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_RANGE_BYTES = 1024 * 1024;
const COMPAT_SEARCH_CHUNK_BYTES = 256 * 1024;
const MAX_COMPAT_SEARCH_BYTES = 64 * 1024 * 1024;
const MAX_COMPAT_LINE_PREFIX_BYTES = 4 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const DEFAULT_FIND_RESULTS = 100;
const MAX_FIND_RESULTS = 1_000;
const PROJECT_IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo']);

export type FsIgnoreMode = 'NONE' | 'PROJECT';
export type FsReadMode = 'TEXT' | 'BYTE_RANGE';
export type FsWriteMode = 'CREATE' | 'REPLACE' | 'APPEND';
export type FsFindMode = 'NAME' | 'TEXT';

export interface FsEntryMetadata {
  readonly relativePath: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly mtime: string;
  readonly mode: number;
  readonly symlink: boolean;
  readonly hardLinkCount: number;
}

export interface FsStatResult extends FsEntryMetadata {
  readonly workspaceId: string;
  readonly physicalIdentity: { readonly device: string; readonly inode: string };
}

export interface FsListOptions {
  readonly recursive?: boolean;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly cursor?: string;
  readonly ignoreMode?: FsIgnoreMode;
  readonly includeHidden?: boolean;
}

export interface FsFindOptions {
  readonly query: string;
  readonly mode?: FsFindMode;
  readonly maxDepth?: number;
  readonly maxResults?: number;
  readonly cursor?: string;
  readonly ignoreMode?: FsIgnoreMode;
  readonly includeHidden?: boolean;
}

export interface ResolvedWorkspaceTarget {
  readonly workspace: WorkspaceRecord;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly metadata: FsEntryMetadata | null;
}

type TargetIntent = 'metadata' | 'directory' | 'file-content' | 'create-file' | 'replace-file' | 'mkdir' | 'delete';

export class WorkspaceFilesystemEngine {
  public constructor(private readonly registry: VNextResourceRegistry) {}

  public async resolveTarget(projectId: string, workspaceId: string, relativePath: string, intent: TargetIntent): Promise<ResolvedWorkspaceTarget> {
    const workspace = await this.registry.getActiveWorkspace(projectId, workspaceId);
    const normalized = normalizeWorkspaceRelativePath(relativePath, intent === 'metadata' || intent === 'directory');
    const absolutePath = normalized === '.' ? workspace.physicalRoot : path.join(workspace.physicalRoot, normalized);
    const inspection = await inspectWorkspaceTarget(workspace.physicalRoot, absolutePath, normalized, intent);
    return { workspace, absolutePath, relativePath: normalized, metadata: inspection };
  }

  public async list(projectId: string, workspaceId: string, root: string, options: FsListOptions = {}) {
    const resolved = await this.resolveTarget(projectId, workspaceId, root, 'directory');
    const settings = normalizeListOptions(options);
    const inventory = await collectInventory(resolved.workspace.physicalRoot, resolved.absolutePath, settings);
    const after = decodeCursor(settings.cursor);
    const eligible = after === null ? inventory.entries : inventory.entries.filter((entry) => entry.relativePath > after);
    const entries = eligible.slice(0, settings.maxEntries);
    const hasMore = eligible.length > entries.length || inventory.scanTruncated;
    return {
      workspaceId: resolved.workspace.workspaceId,
      root: resolved.relativePath,
      entries,
      nextCursor: hasMore && entries.length > 0 ? encodeCursor(entries.at(-1)!.relativePath) : null,
      truncated: hasMore,
      scannedEntries: inventory.scannedEntries,
    };
  }

  public async stat(projectId: string, workspaceId: string, relativePath: string): Promise<FsStatResult> {
    const resolved = await this.resolveTarget(projectId, workspaceId, relativePath, 'metadata');
    const metadata = await lstat(resolved.absolutePath);
    return {
      ...(resolved.metadata ?? entryMetadata(resolved.relativePath, metadata)),
      workspaceId: resolved.workspace.workspaceId,
      physicalIdentity: { device: String(metadata.dev), inode: String(metadata.ino) },
    };
  }

  public async hash(projectId: string, workspaceId: string, relativePath: string) {
    const resolved = await this.resolveTarget(projectId, workspaceId, relativePath, 'file-content');
    const result = await secureWorkspaceHash(resolved.workspace.physicalRoot, resolved.absolutePath);
    return { workspaceId: resolved.workspace.workspaceId, relativePath: resolved.relativePath, ...result, algorithm: 'sha256' as const };
  }

  public async readText(projectId: string, workspaceId: string, relativePath: string, maxBytes = MAX_TEXT_BYTES, encoding: 'utf-8' = 'utf-8') {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_TEXT_BYTES) throw new RuntimeError('INVALID_REQUEST', 'maxBytes is outside Phase 2 text-read bounds');
    const resolved = await this.resolveTarget(projectId, workspaceId, relativePath, 'file-content');
    const result = await secureWorkspaceReadText(resolved.workspace.physicalRoot, resolved.absolutePath, maxBytes, encoding);
    return { workspaceId: resolved.workspace.workspaceId, relativePath: resolved.relativePath, mode: 'TEXT' as const, ...result };
  }

  public async readRange(projectId: string, workspaceId: string, relativePath: string, offset: number, length: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > MAX_RANGE_BYTES) {
      throw new RuntimeError('INVALID_REQUEST', 'BYTE_RANGE offset/length is outside Phase 2 bounds');
    }
    const resolved = await this.resolveTarget(projectId, workspaceId, relativePath, 'file-content');
    const result = await secureWorkspaceReadRange(resolved.workspace.physicalRoot, resolved.absolutePath, offset, length);
    return { workspaceId: resolved.workspace.workspaceId, relativePath: resolved.relativePath, mode: 'BYTE_RANGE' as const, ...result };
  }

  public async write(
    projectId: string,
    workspaceId: string,
    relativePath: string,
    mode: FsWriteMode,
    content: string,
    expectedSize?: number,
    expectedSha256?: string,
  ) {
    const payload = Buffer.from(content, 'utf8');
    if (payload.length > MAX_WRITE_BYTES) throw new RuntimeError('CAPABILITY_DENIED', 'Phase 2 fs.write payload exceeds the bounded write size');
    if (mode === 'CREATE') {
      const resolved = await this.resolveTarget(projectId, workspaceId, relativePath, 'create-file');
      const result = await secureWorkspaceCreate(resolved.workspace.physicalRoot, resolved.absolutePath, payload);
      return { workspaceId: resolved.workspace.workspaceId, relativePath: resolved.relativePath, ...result };
    }
    if (mode === 'REPLACE') {
      const resolved = await this.resolveTarget(projectId, workspaceId, relativePath, 'replace-file');
      const revalidated = await this.resolveTarget(projectId, workspaceId, relativePath, 'replace-file');
      if (!samePhysicalIdentity(resolved.metadata, revalidated.metadata)) throw new RuntimeError('PRECONDITION_FAILED', 'Replace target identity changed before publication');
      const result = await secureWorkspaceReplace(revalidated.workspace.physicalRoot, revalidated.absolutePath, payload);
      return { workspaceId: revalidated.workspace.workspaceId, relativePath: revalidated.relativePath, ...result };
    }
    if (mode === 'APPEND') {
      if (!Number.isSafeInteger(expectedSize) || (expectedSize as number) < 0) throw new RuntimeError('INVALID_REQUEST', 'APPEND requires non-negative expectedSize');
      if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(expectedSha256)) throw new RuntimeError('INVALID_REQUEST', 'expectedSha256 must be a SHA-256 hex digest');
      const resolved = await this.resolveTarget(projectId, workspaceId, relativePath, 'replace-file');
      const result = await secureWorkspaceAppend(resolved.workspace.physicalRoot, resolved.absolutePath, payload, expectedSize as number, expectedSha256);
      return { workspaceId: resolved.workspace.workspaceId, relativePath: resolved.relativePath, ...result };
    }
    throw new RuntimeError('UNKNOWN_EFFECT', 'Unknown fs.write mode fails closed');
  }

  public async edit(projectId: string, workspaceId: string, relativePath: string, find: string, replace: string, expectedSha256: string, dryRun = false) {
    if (find.length === 0 || Buffer.byteLength(find, 'utf8') > MAX_TEXT_BYTES || Buffer.byteLength(replace, 'utf8') > MAX_TEXT_BYTES || !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
      throw new RuntimeError('INVALID_REQUEST', 'fs.edit requires bounded UTF-8 text and expectedSha256');
    }
    const resolved = await this.resolveTarget(projectId, workspaceId, relativePath, 'file-content');
    try {
      const result = await secureProjectFileEdit(resolved.workspace.physicalRoot, resolved.absolutePath, find, replace, expectedSha256, dryRun);
      return { workspaceId: resolved.workspace.workspaceId, relativePath: resolved.relativePath, ...result };
    } catch (error) {
      if (error instanceof RuntimeError && /precondition/i.test(error.message)) throw new RuntimeError('PRECONDITION_FAILED', error.message, { cause: error });
      throw error;
    }
  }

  public async mkdir(projectId: string, workspaceId: string, relativePath: string) {
    const resolved = await this.resolveTarget(projectId, workspaceId, relativePath, 'mkdir');
    const result = await secureProjectMutation('mkdir', resolved.workspace.physicalRoot, resolved.absolutePath);
    if (result.created !== true) throw new RuntimeError('PRECONDITION_FAILED', 'Directory target appeared before creation');
    return { workspaceId: resolved.workspace.workspaceId, relativePath: resolved.relativePath, created: true };
  }

  public async delete(projectId: string, workspaceId: string, relativePath: string) {
    const resolved = await this.resolveTarget(projectId, workspaceId, relativePath, 'delete');
    if (resolved.metadata === null) throw new RuntimeError('CAPABILITY_DENIED', 'Delete target metadata is unavailable');
    const operation = resolved.metadata.type === 'directory' ? 'rmdir' : 'unlink';
    const result = await secureProjectMutation(operation, resolved.workspace.physicalRoot, resolved.absolutePath);
    return { workspaceId: resolved.workspace.workspaceId, relativePath: resolved.relativePath, deleted: result.deleted === true, type: resolved.metadata.type };
  }

  public async compatibilityTextSearch(projectId: string, workspaceId: string, queryInput: string) {
    const query = queryInput.trim();
    if (query.length === 0 || query.length > 500 || query.includes('\0')) {
      throw new RuntimeError('INVALID_REQUEST', 'Search query must be between 1 and 500 characters');
    }
    const resolved = await this.resolveTarget(projectId, workspaceId, '.', 'directory');
    const settings = normalizeListOptions({
      recursive: true,
      maxDepth: MAX_MAX_DEPTH,
      maxEntries: MAX_MAX_ENTRIES,
      ignoreMode: 'PROJECT',
      includeHidden: true,
    });
    const inventory = await collectInventory(resolved.workspace.physicalRoot, resolved.absolutePath, settings);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const queryBytes = Buffer.from(query, 'utf8');
    let overflow = false;
    let incomplete = false;
    let scannedBytes = 0;

    for (const entry of inventory.entries) {
      if (entry.type !== 'file' || entry.size === 0) continue;
      if (entry.size > MAX_COMPAT_SEARCH_BYTES - scannedBytes) {
        incomplete = true;
        continue;
      }
      scannedBytes += entry.size;
      try {
        const remaining = Math.max(0, 100 - matches.length);
        const file = await this.compatibilityFileMatches(
          projectId,
          workspaceId,
          entry.relativePath,
          entry.size,
          queryBytes,
          remaining + 1,
        );
        if (file.binary) continue;
        matches.push(...file.matches.slice(0, remaining));
        if (file.matches.length > remaining) {
          overflow = true;
          break;
        }
      } catch {
        // Aliased/ineligible or concurrently changed content is omitted, but
        // compatibility output must say the search was not exhaustive.
        incomplete = true;
      }
    }
    return { matches, truncated: overflow || incomplete || inventory.scanTruncated };
  }

  private async compatibilityFileMatches(
    projectId: string,
    workspaceId: string,
    relativePath: string,
    fileSize: number,
    queryBytes: Buffer,
    matchLimit: number,
  ): Promise<{ readonly binary: boolean; readonly matches: readonly { path: string; line: number; text: string }[] }> {
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const normalizedPath = relativePath.split(path.sep).join('/');
    const tailBytes = Math.max(0, queryBytes.length - 1);
    let offset = 0;
    let lineNumber = 1;
    let lineMatched = false;
    let lineOpen = false;
    let searchTail = Buffer.alloc(0);
    let prefix = Buffer.alloc(0);

    const appendPrefix = (segment: Buffer): void => {
      if (prefix.length >= MAX_COMPAT_LINE_PREFIX_BYTES || segment.length === 0) return;
      const remaining = MAX_COMPAT_LINE_PREFIX_BYTES - prefix.length;
      prefix = Buffer.concat([prefix, segment.subarray(0, remaining)]);
    };
    const observe = (segment: Buffer): void => {
      if (segment.length > 0) lineOpen = true;
      if (!lineMatched) {
        const candidate = searchTail.length === 0 ? segment : Buffer.concat([searchTail, segment]);
        if (candidate.indexOf(queryBytes) >= 0) lineMatched = true;
        searchTail = tailBytes === 0
          ? Buffer.alloc(0)
          : Buffer.from(candidate.subarray(Math.max(0, candidate.length - tailBytes)));
      }
      appendPrefix(segment);
    };
    const finishLine = (): void => {
      if (lineMatched && matches.length < matchLimit) {
        matches.push({
          path: normalizedPath,
          line: lineNumber,
          text: prefix.toString('utf8').slice(0, 500),
        });
      }
      lineNumber += 1;
      lineMatched = false;
      lineOpen = false;
      searchTail = Buffer.alloc(0);
      prefix = Buffer.alloc(0);
    };

    while (offset < fileSize) {
      const length = Math.min(COMPAT_SEARCH_CHUNK_BYTES, fileSize - offset);
      const range = await this.readRange(projectId, workspaceId, relativePath, offset, length);
      const chunk = Buffer.from(range.base64, 'base64');
      if (chunk.length !== range.bytes || range.offset !== offset || range.fileSize !== fileSize || chunk.includes(0)) {
        if (chunk.includes(0)) return { binary: true, matches: [] };
        throw new RuntimeError('PRECONDITION_FAILED', 'Compatibility search byte-range identity changed');
      }
      if (chunk.length === 0) throw new RuntimeError('PRECONDITION_FAILED', 'Compatibility search made no byte-range progress');

      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline < 0) {
          observe(chunk.subarray(start));
          break;
        }
        observe(chunk.subarray(start, newline));
        finishLine();
        start = newline + 1;
      }
      offset += chunk.length;
      if (range.eof && offset < fileSize) {
        throw new RuntimeError('PRECONDITION_FAILED', 'Compatibility search reached EOF before the inventoried file size');
      }
    }
    if (lineOpen || lineMatched || prefix.length > 0 || searchTail.length > 0) finishLine();
    return { binary: false, matches };
  }

  public async find(projectId: string, workspaceId: string, root: string, options: FsFindOptions) {
    const query = options.query.trim();
    if (query.length === 0 || query.length > 500 || query.includes('\0')) throw new RuntimeError('INVALID_REQUEST', 'fs.find query must contain 1-500 characters');
    const mode = options.mode ?? 'NAME';
    if (mode !== 'NAME' && mode !== 'TEXT') throw new RuntimeError('INVALID_REQUEST', 'fs.find mode must be NAME or TEXT');
    const maxResults = boundedInteger(options.maxResults ?? DEFAULT_FIND_RESULTS, 1, MAX_FIND_RESULTS, 'maxResults');
    const resolved = await this.resolveTarget(projectId, workspaceId, root, 'directory');
    const listOptions: FsListOptions = {
      recursive: true,
      maxEntries: MAX_MAX_ENTRIES,
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
      ...(options.ignoreMode === undefined ? {} : { ignoreMode: options.ignoreMode }),
      ...(options.includeHidden === undefined ? {} : { includeHidden: options.includeHidden }),
    };
    const settings = normalizeListOptions(listOptions);
    const inventory = await collectInventory(resolved.workspace.physicalRoot, resolved.absolutePath, settings);
    const after = decodeCursor(options.cursor);
    const candidates = after === null ? inventory.entries : inventory.entries.filter((entry) => entry.relativePath > after);
    const results: Array<Record<string, unknown>> = [];
    let lastExamined: string | null = null;
    for (const entry of candidates) {
      lastExamined = entry.relativePath;
      if (mode === 'NAME') {
        if (entry.relativePath.includes(query)) results.push({ relativePath: entry.relativePath, type: entry.type });
      } else if (entry.type === 'file' && entry.size <= 256 * 1024) {
        try {
          const text = await this.readText(projectId, workspaceId, entry.relativePath, Math.max(1, entry.size));
          const lines = text.text.split('\n');
          for (let index = 0; index < lines.length; index += 1) {
            if (lines[index]!.includes(query)) {
              results.push({ relativePath: entry.relativePath, line: index + 1, text: lines[index]!.slice(0, 500) });
              break;
            }
          }
        } catch {
          // Ineligible content is not a text-search result.
        }
      }
      if (results.length >= maxResults) break;
    }
    const hasMore = lastExamined !== null && (candidates.some((entry) => entry.relativePath > lastExamined!) || inventory.scanTruncated);
    return {
      workspaceId: resolved.workspace.workspaceId,
      root: resolved.relativePath,
      mode,
      results,
      nextCursor: hasMore && lastExamined !== null ? encodeCursor(lastExamined) : null,
      truncated: hasMore,
    };
  }
}

async function inspectWorkspaceTarget(workspaceRoot: string, absolutePath: string, relativePath: string, intent: TargetIntent): Promise<FsEntryMetadata | null> {
  const rootMetadata = await lstat(workspaceRoot).catch((error: unknown) => {
    throw new RuntimeError('CAPABILITY_DENIED', 'Workspace root metadata is unavailable', { cause: error });
  });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace root is not a physical directory');
  if (relativePath === '.') {
    if (intent !== 'metadata' && intent !== 'directory') throw new RuntimeError('CAPABILITY_DENIED', 'Workspace root itself is not a valid content/mutation target');
    return entryMetadata('.', rootMetadata);
  }
  const relative = path.relative(workspaceRoot, absolutePath);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new RuntimeError('CAPABILITY_DENIED', 'Target escapes workspace root');
  const parts = relative.split(path.sep);
  let current = workspaceRoot;
  for (let index = 0; index < parts.length; index += 1) {
    const currentRelative = parts.slice(0, index + 1).join(path.sep);
    const next = path.join(current, parts[index]!);
    const final = index === parts.length - 1;
    let metadata: Stats;
    try {
      metadata = await lstat(next);
    } catch (error: unknown) {
      if (!isNotFound(error)) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace target metadata is unreadable', { cause: error });
      if (!final || (intent !== 'create-file' && intent !== 'mkdir')) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace target does not exist');
      return null;
    }
    if (!final && (metadata.isSymbolicLink() || !metadata.isDirectory())) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace target parent is not a physical directory');
    if (final) {
      const result = entryMetadata(currentRelative, metadata);
      if (intent === 'create-file' || intent === 'mkdir') throw new RuntimeError('PRECONDITION_FAILED', 'Workspace create target already exists');
      if (intent === 'directory' && (!metadata.isDirectory() || metadata.isSymbolicLink())) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace target must be a physical directory');
      if (intent === 'file-content' || intent === 'replace-file') {
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace content target must be a physical regular file');
        if (metadata.nlink !== 1) throw new RuntimeError('CAPABILITY_DENIED', 'Hard-linked files are outside the safe workspace content model');
      }
      if (intent === 'delete') {
        if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) throw new RuntimeError('CAPABILITY_DENIED', 'Delete target must be one physical regular file or directory');
        if (metadata.isFile() && metadata.nlink !== 1) throw new RuntimeError('CAPABILITY_DENIED', 'Hard-linked files are outside the safe workspace delete model');
      }
      return result;
    }
    current = next;
  }
  throw new RuntimeError('CAPABILITY_DENIED', 'Workspace target inspection did not resolve an entry');
}

async function collectInventory(
  workspaceRoot: string,
  physicalRoot: string,
  settings: ReturnType<typeof normalizeListOptions>,
): Promise<{ entries: readonly FsEntryMetadata[]; scannedEntries: number; scanTruncated: boolean }> {
  const entries: FsEntryMetadata[] = [];
  let scannedEntries = 0;
  let scanTruncated = false;
  const recurse = async (directory: string, depth: number): Promise<void> => {
    if (scanTruncated) return;
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (scanTruncated) break;
      if (!settings.includeHidden && name.startsWith('.')) continue;
      if (settings.ignoreMode === 'PROJECT' && PROJECT_IGNORED_NAMES.has(name)) continue;
      const absolute = path.join(directory, name);
      const relative = path.relative(workspaceRoot, absolute);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new RuntimeError('CAPABILITY_DENIED', 'Inventory target escaped workspace root');
      const metadata = await lstat(absolute).catch((error: unknown) => {
        throw new RuntimeError('CAPABILITY_DENIED', 'Inventory entry metadata became unavailable', { cause: error });
      });
      scannedEntries += 1;
      if (scannedEntries > MAX_SCAN_ENTRIES) {
        scanTruncated = true;
        break;
      }
      entries.push(entryMetadata(relative, metadata));
      if (settings.recursive && metadata.isDirectory() && !metadata.isSymbolicLink() && depth < settings.maxDepth) await recurse(absolute, depth + 1);
    }
  };
  await recurse(physicalRoot, 1);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { entries, scannedEntries: Math.min(scannedEntries, MAX_SCAN_ENTRIES), scanTruncated };
}

function entryMetadata(relativePath: string, metadata: Stats): FsEntryMetadata {
  const type: FsEntryMetadata['type'] = metadata.isSymbolicLink() ? 'symlink' : metadata.isFile() ? 'file' : metadata.isDirectory() ? 'directory' : 'other';
  return {
    relativePath: relativePath.split(path.sep).join('/'),
    type,
    size: metadata.size,
    mtime: metadata.mtime.toISOString(),
    mode: metadata.mode & 0o7777,
    symlink: metadata.isSymbolicLink(),
    hardLinkCount: metadata.nlink,
  };
}

function normalizeWorkspaceRelativePath(value: string, allowRoot: boolean): string {
  if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value)) throw new RuntimeError('INVALID_REQUEST', 'Workspace target must be a relative path');
  if (value === '.' && allowRoot) return '.';
  if (value.length === 0 || value === '.' || value.endsWith(path.sep) || path.normalize(value) !== value) throw new RuntimeError('INVALID_REQUEST', 'Workspace target path is ambiguous or non-canonical');
  const parts = value.split(path.sep);
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) throw new RuntimeError('INVALID_REQUEST', 'Workspace target path contains traversal or ambiguous components');
  return value;
}

function normalizeListOptions(options: FsListOptions) {
  const recursive = options.recursive ?? false;
  const maxDepth = boundedInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, 1, MAX_MAX_DEPTH, 'maxDepth');
  const maxEntries = boundedInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 1, MAX_MAX_ENTRIES, 'maxEntries');
  const ignoreMode = options.ignoreMode ?? 'PROJECT';
  if (ignoreMode !== 'NONE' && ignoreMode !== 'PROJECT') throw new RuntimeError('INVALID_REQUEST', 'ignoreMode must be NONE or PROJECT');
  return { recursive, maxDepth, maxEntries, cursor: options.cursor, ignoreMode, includeHidden: options.includeHidden ?? false };
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RuntimeError('INVALID_REQUEST', `${label} must be an integer from ${min} through ${max}`);
  return value;
}

function encodeCursor(relativePath: string): string {
  return Buffer.from(`v1:${relativePath}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  if (cursor.length === 0 || cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new RuntimeError('INVALID_REQUEST', 'Cursor is invalid');
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch (error) {
    throw new RuntimeError('INVALID_REQUEST', 'Cursor is invalid', { cause: error });
  }
  if (!decoded.startsWith('v1:') || decoded.includes('\0')) throw new RuntimeError('INVALID_REQUEST', 'Cursor is invalid');
  return decoded.slice(3);
}

function samePhysicalIdentity(left: FsEntryMetadata | null, right: FsEntryMetadata | null): boolean {
  if (left === null || right === null) return false;
  return left.type === right.type && left.size === right.size && left.mtime === right.mtime && left.hardLinkCount === right.hardLinkCount;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
