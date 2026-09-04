import { lstat, readFile } from 'node:fs/promises';

export type PrivateFileInspection =
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly reason: string }
  | { readonly state: 'ok'; readonly content: string };

export async function inspectPrivateRegularFile(filename: string, label: string): Promise<PrivateFileInspection> {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error: unknown) {
    return isNotFound(error)
      ? { state: 'missing' }
      : { state: 'invalid', reason: `${label} metadata is unreadable` };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return { state: 'invalid', reason: `${label} is not a physical regular file` };
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    return { state: 'invalid', reason: `${label} is not owned by the current user` };
  }
  if ((metadata.mode & 0o077) !== 0) {
    return { state: 'invalid', reason: `${label} permissions grant group or other access` };
  }
  try {
    return { state: 'ok', content: await readFile(filename, 'utf8') };
  } catch (error: unknown) {
    return isNotFound(error)
      ? { state: 'missing' }
      : { state: 'invalid', reason: `${label} is unreadable` };
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

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
