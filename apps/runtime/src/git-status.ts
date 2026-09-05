import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RuntimeError } from '@iris/domain';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 128 * 1024;

export interface ProjectGitStatus {
  readonly branch: string;
  readonly clean: boolean;
  readonly stagedChanges: number;
  readonly trackedChanges: number;
  readonly untrackedChanges: number;
}

export async function inspectProjectGitStatus(projectRoot: string): Promise<ProjectGitStatus> {
  let stdout: string;
  try {
    const result = await execFileAsync('/usr/bin/git', ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: MAX_GIT_OUTPUT,
      env: { PATH: '/usr/bin:/bin' },
    });
    stdout = result.stdout;
  } catch (error) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Project Git status could not be inspected safely', { cause: error });
  }
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  const branchLine = lines[0] ?? '';
  if (!branchLine.startsWith('## ')) throw new RuntimeError('CAPABILITY_DENIED', 'Git status response did not contain a branch header');
  const rawBranch = branchLine.slice(3).split('...')[0]!.trim();
  const unbornPrefix = 'No commits yet on ';
  const branch = rawBranch.startsWith(unbornPrefix)
    ? rawBranch.slice(unbornPrefix.length).trim()
    : rawBranch === 'HEAD (no branch)' || rawBranch.length === 0 ? 'DETACHED' : rawBranch;
  const changes = lines.slice(1);
  let stagedChanges = 0;
  let trackedChanges = 0;
  let untrackedChanges = 0;
  for (const line of changes) {
    if (line.startsWith('??')) {
      untrackedChanges += 1;
      continue;
    }
    if (line.length < 2) throw new RuntimeError('CAPABILITY_DENIED', 'Git status response contained malformed change metadata');
    if (line[0] !== ' ') stagedChanges += 1;
    trackedChanges += 1;
  }
  return { branch, clean: changes.length === 0, stagedChanges, trackedChanges, untrackedChanges };
}
