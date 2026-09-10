import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export type ProjectTargetKind = 'file-read' | 'file-write' | 'file-edit' | 'file-delete' | 'directory-create' | 'directory-delete' | 'project-root';

export interface ProjectTargetInspection {
  readonly valid: boolean;
  readonly target: string | null;
  readonly reason: string;
}

export async function inspectRegistrationRoot(candidate: string | null): Promise<ProjectTargetInspection> {
  if (candidate === null || candidate.includes('\0') || !path.isAbsolute(candidate)) {
    return invalid('Project root must be an absolute path');
  }
  try {
    const physical = await realpath(candidate);
    const metadata = await stat(physical);
    if (!metadata.isDirectory()) return invalid('Project root must identify a directory');
    if (physical === path.parse(physical).root) return invalid('Filesystem root cannot be registered as a project');
    return { valid: true, target: physical, reason: 'Project root is a canonical existing directory' };
  } catch {
    return invalid('Project root must be an existing directory');
  }
}

export async function inspectProjectTarget(
  projectRoot: string,
  candidate: string | null,
  kind: Exclude<ProjectTargetKind, 'project-root'>,
): Promise<ProjectTargetInspection> {
  if (candidate === null || candidate.includes('\0') || !path.isAbsolute(candidate)) {
    return invalid('Project target must be an absolute path');
  }

  let physicalRoot: string;
  try {
    physicalRoot = await realpath(projectRoot);
    if (physicalRoot !== projectRoot || !(await stat(physicalRoot)).isDirectory()) {
      return invalid('Registered project root is not a stable physical directory');
    }
  } catch {
    return invalid('Registered project root is unavailable');
  }

  const requested = path.resolve(candidate);
  const relative = path.relative(physicalRoot, requested);
  if (relative === '' || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return invalid(relative === '' ? 'Project root itself is not a valid file-operation target' : 'Target escapes the registered project root');
  }

  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  let current = physicalRoot;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const next = path.join(current, part);
    const final = index === parts.length - 1;
    try {
      const metadata = await lstat(next);
      if (metadata.isSymbolicLink()) return invalid('Symlink components are not eligible for project capability execution');
      if (!final && !metadata.isDirectory()) return invalid('A project target parent component is not a directory');
      if (final) {
        if (kind === 'file-read' || kind === 'file-write' || kind === 'file-edit' || kind === 'file-delete') {
          if (!metadata.isFile()) return invalid('Target must be a regular file');
          if (metadata.nlink !== 1) return invalid('Hard-linked files are outside the safe project capability model');
        }
        if ((kind === 'directory-create' || kind === 'directory-delete') && !metadata.isDirectory()) {
          return invalid('Target must be a directory');
        }
      }
      current = next;
    } catch (error: unknown) {
      if (!isNotFound(error)) return invalid('Project target metadata is unreadable');
      const creationAllowed = kind === 'file-write' || kind === 'directory-create';
      if (!creationAllowed) return invalid('Project target does not exist');
      if (!final) return invalid('Project target parent directory does not exist');
      current = next;
    }
  }

  return { valid: true, target: current, reason: 'Target is physically contained by the registered project root' };
}

export function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function invalid(reason: string): ProjectTargetInspection {
  return { valid: false, target: null, reason };
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
