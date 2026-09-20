import { RuntimeError, type WorkerTask } from '@iris/domain';
import type { MultiWorkerDocument } from './model.js';

export interface MutablePathConflict {
  readonly workspaceId: string;
  readonly candidateTaskId: string;
  readonly ownerTaskId: string;
  readonly candidateGrant: string;
  readonly ownerGrant: string;
}

/**
 * Enforce exclusive mutable path ownership across all active worker assignments in one workspace.
 *
 * Read-only overlap is intentionally allowed. Mutable grants are immutable task authority, so an
 * orchestrator resolves a collision by completing/cancelling the current owner or creating a newly
 * scoped task; no worker can override ownership itself.
 */
export function findMutablePathConflicts(
  document: MultiWorkerDocument,
  candidateTask: WorkerTask,
): readonly MutablePathConflict[] {
  if (candidateTask.authority.mutablePaths.length === 0) return [];
  const conflicts: MutablePathConflict[] = [];
  for (const assignment of document.assignments) {
    if (assignment.releasedAt !== null || assignment.taskId === candidateTask.id) continue;
    const ownerTask = document.tasks.find((task) => task.id === assignment.taskId);
    if (ownerTask === undefined) throw new RuntimeError('PERSISTENCE_FAILURE', 'Active path owner task is missing');
    if (ownerTask.authority.workspaceId !== candidateTask.authority.workspaceId
      || !['ASSIGNED', 'STARTING', 'RUNNING', 'WAITING'].includes(ownerTask.state)) continue;

    for (const candidateGrant of candidateTask.authority.mutablePaths) {
      for (const ownerGrant of ownerTask.authority.mutablePaths) {
        if (pathGrantsOverlap(candidateGrant, ownerGrant)) {
          conflicts.push(Object.freeze({
            workspaceId: String(candidateTask.authority.workspaceId),
            candidateTaskId: candidateTask.id,
            ownerTaskId: ownerTask.id,
            candidateGrant,
            ownerGrant,
          }));
        }
      }
    }
  }
  return Object.freeze(conflicts.sort((left, right) =>
    left.ownerTaskId !== right.ownerTaskId
      ? (left.ownerTaskId < right.ownerTaskId ? -1 : 1)
      : left.ownerGrant !== right.ownerGrant
        ? (left.ownerGrant < right.ownerGrant ? -1 : 1)
        : left.candidateGrant < right.candidateGrant ? -1 : left.candidateGrant > right.candidateGrant ? 1 : 0));
}

export function assertMutablePathOwnershipAvailable(
  document: MultiWorkerDocument,
  candidateTask: WorkerTask,
): void {
  const conflicts = findMutablePathConflicts(document, candidateTask);
  if (conflicts.length === 0) return;
  const first = conflicts[0]!;
  throw new RuntimeError(
    'CONTROL_DENIED',
    `Mutable path ownership collision: candidate task ${first.candidateTaskId} overlaps active owner task ${first.ownerTaskId}`,
  );
}

export function pathGrantsOverlap(leftInput: string, rightInput: string): boolean {
  const left = parseGrant(leftInput);
  const right = parseGrant(rightInput);
  if (left.all || right.all) return true;
  if (!left.tree && !right.tree) return left.base === right.base;
  if (left.tree && right.tree) return contained(left.base, right.base) || contained(right.base, left.base);
  if (left.tree) return contained(left.base, right.base);
  return contained(right.base, left.base);
}

function parseGrant(value: string): { readonly all: boolean; readonly tree: boolean; readonly base: string } {
  if (value === '**') return { all: true, tree: true, base: '' };
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\') || value.includes('\0')
    || value === '.' || value === '..' || value.startsWith('../')) {
    throw new RuntimeError('INVALID_REQUEST', 'Mutable path ownership grant is invalid');
  }
  if (value.endsWith('/**')) {
    const base = value.slice(0, -3);
    if (base.length === 0 || base.includes('*')) throw new RuntimeError('INVALID_REQUEST', 'Mutable path ownership grant is invalid');
    return { all: false, tree: true, base };
  }
  if (value.includes('*')) throw new RuntimeError('INVALID_REQUEST', 'Mutable path ownership grant is invalid');
  return { all: false, tree: false, base: value };
}

function contained(treeBase: string, candidate: string): boolean {
  return candidate === treeBase || candidate.startsWith(`${treeBase}/`);
}
