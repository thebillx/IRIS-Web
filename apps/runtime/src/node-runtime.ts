import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';

export const MINIMUM_NODE_MAJOR = 24 as const;

const VERSIONED_NODE_CANDIDATES = [
  '/opt/homebrew/opt/node@24/bin/node',
  '/usr/local/opt/node@24/bin/node',
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
] as const;

export interface CanonicalNodeRuntime {
  readonly path: string;
  readonly version: string;
  readonly major: number;
}

export function assertSupportedNodeVersion(version = process.version): void {
  const major = nodeVersionMajor(version);
  if (major === null || major < MINIMUM_NODE_MAJOR) {
    throw new RuntimeError('NODE_VERSION_UNSUPPORTED', `IRIS requires Node.js >=${MINIMUM_NODE_MAJOR}; found ${version} at ${process.execPath}`);
  }
}

export function nodeVersionMajor(version: string): number | null {
  const match = /^v?(\d+)(?:\.\d+){0,2}(?:[-+].*)?$/.exec(version.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : null;
}

export function canonicalNodeRuntime(candidates: readonly string[] = [...VERSIONED_NODE_CANDIDATES, process.execPath]): CanonicalNodeRuntime {
  const checked: string[] = [];
  for (const candidate of unique(candidates)) {
    if (!path.isAbsolute(candidate)) continue;
    const executable = path.resolve(candidate);
    checked.push(executable);
    try {
      const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const major = nodeVersionMajor(version);
      if (major !== null && major >= MINIMUM_NODE_MAJOR) return { path: executable, version, major };
    } catch {
      // Continue to the next trusted installation candidate.
    }
  }
  throw new RuntimeError('NODE_VERSION_UNSUPPORTED', `IRIS requires an installed Node.js >=${MINIMUM_NODE_MAJOR}; checked ${checked.join(', ') || 'no absolute candidates'}`);
}

export function node24PathEntries(nodePath = canonicalNodeRuntime().path): readonly string[] {
  return unique([
    path.dirname(nodePath),
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]);
}

export function node24Path(nodePath = canonicalNodeRuntime().path): string {
  return node24PathEntries(nodePath).join(path.delimiter);
}

export function node24Environment(
  source: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source, ...extra, PATH: node24Path() };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return environment;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
