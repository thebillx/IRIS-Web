import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError } from '@iris/domain';

const execFileAsync = promisify(execFile);
const MAX_QUERY_CHARS = 500;
const MAX_SEARCH_OUTPUT = 256 * 1024;
const MAX_RESULTS = 100;

export interface ProjectSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export async function searchProjectText(projectRoot: string, queryInput: string): Promise<{ matches: readonly ProjectSearchMatch[]; truncated: boolean }> {
  const query = queryInput.trim();
  if (query.length === 0 || query.length > MAX_QUERY_CHARS || query.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', 'Search query must be between 1 and 500 characters');
  }

  let stdout = '';
  try {
    const result = await execFileAsync('/usr/bin/grep', [
      '-r', '-n', '-I', '-F',
      '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=build',
      '--exclude-dir=coverage', '--exclude-dir=.next', '--exclude-dir=.turbo', '--', query, '.',
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: MAX_SEARCH_OUTPUT,
      env: { PATH: '/usr/bin:/bin' },
    });
    stdout = result.stdout;
  } catch (error) {
    if (isNoMatches(error)) return { matches: [], truncated: false };
    if (isMaxBuffer(error)) return parseMatches(String((error as { stdout?: unknown }).stdout ?? ''), true);
    throw new RuntimeError('CAPABILITY_DENIED', 'Project search could not be completed safely', { cause: error });
  }
  return parseMatches(stdout, false);
}

function parseMatches(stdout: string, outputTruncated: boolean): { matches: readonly ProjectSearchMatch[]; truncated: boolean } {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  const matches = lines.slice(0, MAX_RESULTS).flatMap((entry) => {
    const match = /^\.\/([^:]+):(\d+):(.*)$/.exec(entry);
    if (match === null) return [];
    return [{ path: match[1]!.split(path.sep).join('/'), line: Number(match[2]), text: match[3]!.slice(0, 500) }];
  });
  return { matches, truncated: outputTruncated || lines.length > MAX_RESULTS };
}

function isNoMatches(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 1;
}

function isMaxBuffer(error: unknown): boolean {
  return error instanceof Error && error.message.includes('maxBuffer');
}
