import type { ChildProcess } from 'node:child_process';
import { RuntimeError } from '@iris/domain';

export class DefiniteSpawnFailure extends RuntimeError {
  public constructor() { super('SUPERVISOR_NOT_RUNNING', 'OS rejected child launch before process creation completed'); }
}

// A missing PID alone is not proof: require the OS spawn error as well.
export function confirmChildSpawn(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, pid?: number) => {
      clearTimeout(deadline);
      child.removeListener('spawn', spawned);
      child.removeListener('error', failed);
      if (error !== undefined) reject(error);
      else resolve(pid!);
    };
    const spawned = () => {
      if (child.pid === undefined || child.pid <= 0) finish(new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Child spawn event did not establish a PID'));
      else finish(undefined, child.pid);
    };
    const failed = (error: NodeJS.ErrnoException) => {
      const definite = child.pid === undefined && typeof error.syscall === 'string' && error.syscall.startsWith('spawn ')
        && ['ENOENT', 'EACCES', 'ENOEXEC', 'ENOTDIR', 'E2BIG'].includes(error.code ?? '');
      finish(definite ? new DefiniteSpawnFailure() : new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Child launch outcome is uncertain'));
    };
    const deadline = setTimeout(() => finish(new RuntimeError('PROCESS_OWNERSHIP_AMBIGUOUS', 'Child launch observation deadline expired')), 2_000);
    child.once('spawn', spawned);
    child.once('error', failed);
  });
}
