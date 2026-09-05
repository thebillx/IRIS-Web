import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

export type PrivateFileInspection =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly reason: string }
  | { readonly state: 'ok'; readonly content: string };

export async function inspectPrivateRegularFile(filename: string, label: string): Promise<PrivateFileInspection> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error: unknown) {
    return isNotFound(error)
      ? { state: 'missing' }
      : { state: 'invalid', reason: `${label} could not be opened as a physical file` };
  }
  try {
    const problem = privateFileMetadataProblem(await handle.stat(), label);
    if (problem !== null) return { state: 'invalid', reason: problem };
    return { state: 'ok', content: await handle.readFile('utf8') };
  } catch {
    return { state: 'invalid', reason: `${label} is unreadable` };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function openPrivateAppendFile(filename: string, label: string): Promise<Awaited<ReturnType<typeof open>>> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filename, flags, 0o600);
  } catch (error) {
    throw new Error(`${label} could not be opened safely`, { cause: error });
  }
  try {
    const problem = privateFileMetadataProblem(await handle.stat(), label);
    if (problem !== null) throw new Error(problem);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function privateDirectoryProblem(directory: string, label: string): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch {
    return `${label} metadata is unreadable`;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return `${label} is not a physical directory`;
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) return `${label} is not owned by the current user`;
  if ((metadata.mode & 0o077) !== 0) return `${label} permissions grant group or other access`;
  return null;
}

function privateFileMetadataProblem(metadata: Stats, label: string): string | null {
  if (!metadata.isFile()) return `${label} is not a physical regular file`;
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) return `${label} is not owned by the current user`;
  if ((metadata.mode & 0o077) !== 0) return `${label} permissions grant group or other access`;
  return null;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
