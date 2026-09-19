import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { RuntimeError, type CapabilityEffect, type WorkspaceRecord } from '@iris/domain';
import { canonicalNodeRuntime, node24Path } from './node-runtime.js';

export interface ExecutionProfilePlan {
  readonly profileId: string;
  readonly executableIdentity: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly redactionValues: readonly string[];
  readonly timeoutMs: number;
  readonly effectEnvelope: readonly CapabilityEffect[];
  readonly stdinPath: string | null;
}

export interface ResolveExecutionInput {
  readonly workspace: WorkspaceRecord;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly executionProfile: string;
  readonly envOverrides: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stdinPath?: string | null;
}

interface ProfileDefinition {
  readonly id: string;
  readonly executable: string;
  readonly candidates: () => readonly string[];
  readonly minTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly envAllowlist: readonly string[];
  readonly effectEnvelope: readonly CapabilityEffect[];
  readonly argvPolicy: 'NODE_SCRIPT' | 'PYTHON_SCRIPT' | 'ROBOT_SCRIPT' | 'PNPM_SCRIPT' | 'NPM_SCRIPT' | 'FFMPEG' | 'FFPROBE';
}

const MAX_ARGV = 128;
const MAX_ARG_BYTES = 16 * 1024;
const MAX_ENV_OVERRIDES = 32;
const MAX_ENV_VALUE = 8 * 1024;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const CONSERVATIVE_EFFECTS = ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const satisfies readonly CapabilityEffect[];

const PROFILES: readonly ProfileDefinition[] = [
  { id: 'node-script', executable: 'node', candidates: () => [canonicalNodeRuntime().path], minTimeoutMs: 100, maxTimeoutMs: 30 * 60_000, envAllowlist: ['CI','NODE_ENV','API_TOKEN','AUTH_TOKEN','PASSWORD'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'NODE_SCRIPT' },
  { id: 'python3-script', executable: 'python3', candidates: () => ['/usr/bin/python3','/opt/homebrew/bin/python3','/usr/local/bin/python3'], minTimeoutMs: 100, maxTimeoutMs: 30 * 60_000, envAllowlist: ['CI','PYTHONUNBUFFERED','API_TOKEN','AUTH_TOKEN','PASSWORD'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'PYTHON_SCRIPT' },
  { id: 'robot', executable: 'robot', candidates: () => ['/opt/homebrew/bin/robot','/usr/local/bin/robot'], minTimeoutMs: 100, maxTimeoutMs: 60 * 60_000, envAllowlist: ['CI','API_TOKEN','AUTH_TOKEN','PASSWORD'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'ROBOT_SCRIPT' },
  { id: 'pnpm-script', executable: 'pnpm', candidates: () => ['/opt/homebrew/bin/pnpm','/usr/local/bin/pnpm'], minTimeoutMs: 100, maxTimeoutMs: 60 * 60_000, envAllowlist: ['CI','NODE_ENV','API_TOKEN','AUTH_TOKEN','PASSWORD'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'PNPM_SCRIPT' },
  { id: 'npm-script', executable: 'npm', candidates: () => ['/opt/homebrew/bin/npm','/usr/local/bin/npm','/usr/bin/npm'], minTimeoutMs: 100, maxTimeoutMs: 60 * 60_000, envAllowlist: ['CI','NODE_ENV','API_TOKEN','AUTH_TOKEN','PASSWORD'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'NPM_SCRIPT' },
  { id: 'ffmpeg', executable: 'ffmpeg', candidates: () => ['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg'], minTimeoutMs: 100, maxTimeoutMs: 60 * 60_000, envAllowlist: ['CI'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'FFMPEG' },
  { id: 'ffprobe', executable: 'ffprobe', candidates: () => ['/opt/homebrew/bin/ffprobe','/usr/local/bin/ffprobe'], minTimeoutMs: 100, maxTimeoutMs: 30 * 60_000, envAllowlist: ['CI'], effectEnvelope: ['READ','EXECUTE'], argvPolicy: 'FFPROBE' },
] as const;

export function executionProfileEffects(profileId: string): readonly CapabilityEffect[] | null {
  return PROFILES.find((profile) => profile.id === profileId)?.effectEnvelope ?? null;
}

export async function resolveExecutionProfile(input: ResolveExecutionInput): Promise<ExecutionProfilePlan> {
  const profile = PROFILES.find((candidate) => candidate.id === input.executionProfile);
  if (profile === undefined) throw new RuntimeError('CAPABILITY_DENIED', 'UNKNOWN_EXECUTION_PROFILE: execution profile is not server-approved');
  if (input.executable !== profile.executable) throw new RuntimeError('CAPABILITY_DENIED', 'UNKNOWN_EXECUTABLE: executable does not match the selected server-owned profile');
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < profile.minTimeoutMs || input.timeoutMs > profile.maxTimeoutMs) {
    throw new RuntimeError('INVALID_REQUEST', `timeoutMs must be from ${profile.minTimeoutMs} through ${profile.maxTimeoutMs} for this profile`);
  }
  validateArgvShape(input.argv);
  const executableIdentity = await resolveExecutable(profile.candidates());
  const cwd = await resolveWorkspaceDirectory(input.workspace, input.cwd);
  await validateArgvPolicy(profile.argvPolicy, input.argv, input.workspace, cwd);
  const { environment, redactionValues } = buildEnvironment(profile, input.workspace, input.envOverrides);
  return {
    profileId: profile.id,
    executableIdentity,
    argv: [...input.argv],
    cwd,
    environment,
    redactionValues,
    timeoutMs: input.timeoutMs,
    effectEnvelope: profile.effectEnvelope,
    stdinPath: input.stdinPath ?? null,
  };
}

function validateArgvShape(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length > MAX_ARGV) throw new RuntimeError('INVALID_REQUEST', 'argv exceeds the bounded argument count');
  let bytes = 0;
  for (const item of argv) {
    if (typeof item !== 'string' || item.includes('\0')) throw new RuntimeError('INVALID_REQUEST', 'argv contains an invalid argument');
    bytes += Buffer.byteLength(item, 'utf8');
  }
  if (bytes > MAX_ARG_BYTES) throw new RuntimeError('INVALID_REQUEST', 'argv exceeds the bounded byte limit');
}

async function resolveExecutable(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      const physical = await realpath(candidate);
      const metadata = await lstat(physical);
      if (!metadata.isFile()) continue;
      await access(physical, constants.X_OK);
      return physical;
    } catch {
      // Try the next server-owned candidate. Caller PATH is never consulted.
    }
  }
  throw new RuntimeError('CAPABILITY_DENIED', 'UNKNOWN_EXECUTABLE: approved executable is not installed at a server-owned path');
}

async function resolveWorkspaceDirectory(workspace: WorkspaceRecord, relativeCwd: string): Promise<string> {
  if (typeof relativeCwd !== 'string' || relativeCwd.length === 0 || relativeCwd.length > 4000 || relativeCwd.includes('\0') || path.isAbsolute(relativeCwd)) {
    throw new RuntimeError('INVALID_REQUEST', 'cwd must be a bounded workspace-relative path');
  }
  const lexical = path.resolve(workspace.physicalRoot, relativeCwd);
  if (!pathIsWithin(workspace.physicalRoot, lexical)) throw new RuntimeError('CAPABILITY_DENIED', 'cwd escapes the selected workspace');
  let physical: string;
  try {
    const metadata = await lstat(lexical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('not a physical directory');
    physical = await realpath(lexical);
  } catch (error) {
    throw new RuntimeError('CAPABILITY_DENIED', 'cwd is not an existing physical workspace directory', { cause: error });
  }
  if (!pathIsWithin(workspace.physicalRoot, physical)) throw new RuntimeError('CAPABILITY_DENIED', 'cwd resolves outside the selected workspace');
  return physical;
}

async function validateArgvPolicy(policy: ProfileDefinition['argvPolicy'], argv: readonly string[], workspace: WorkspaceRecord, cwd: string): Promise<void> {
  rejectInlineInterpreterForms(argv);
  if (policy === 'NODE_SCRIPT') {
    if (argv.length < 1 || argv[0]!.startsWith('-')) throw new RuntimeError('CAPABILITY_DENIED', 'node-script requires a physical project script as argv[0]');
    await verifyPhysicalScript(workspace, cwd, argv[0]!, ['.js','.mjs','.cjs']);
    return;
  }
  if (policy === 'PYTHON_SCRIPT') {
    if (argv.length < 1 || argv[0]!.startsWith('-')) throw new RuntimeError('CAPABILITY_DENIED', 'python3-script requires a physical .py project script as argv[0]');
    await verifyPhysicalScript(workspace, cwd, argv[0]!, ['.py']);
    return;
  }
  if (policy === 'ROBOT_SCRIPT') {
    const candidate = [...argv].reverse().find((item) => !item.startsWith('-'));
    if (candidate === undefined) throw new RuntimeError('CAPABILITY_DENIED', 'robot profile requires a physical .robot project file');
    await verifyPhysicalScript(workspace, cwd, candidate, ['.robot']);
    return;
  }
  if (policy === 'PNPM_SCRIPT') {
    const regular = argv.length >= 2 && argv[0] === 'run' && SCRIPT_NAME.test(argv[1]!);
    const compatibility = argv.length === 4
      && argv[0] === '--config.ignore-scripts=true'
      && argv[1] === '--config.enable-pre-post-scripts=false'
      && argv[2] === 'run'
      && SCRIPT_NAME.test(argv[3]!);
    if (!regular && !compatibility) {
      throw new RuntimeError('CAPABILITY_DENIED', 'pnpm-script only allows run <declared-script-name> or the server-owned ignore-scripts compatibility form');
    }
    return;
  }
  if (policy === 'NPM_SCRIPT') {
    const regular = argv.length >= 2 && argv[0] === 'run' && SCRIPT_NAME.test(argv[1]!);
    const compatibility = argv.length === 3
      && argv[0] === 'run'
      && argv[1] === '--ignore-scripts'
      && SCRIPT_NAME.test(argv[2]!);
    if (!regular && !compatibility) {
      throw new RuntimeError('CAPABILITY_DENIED', 'npm-script only allows run <declared-script-name> or the server-owned ignore-scripts compatibility form');
    }
    return;
  }
  for (const item of argv) {
    if (item.startsWith('/') && !pathIsWithin(workspace.physicalRoot, path.resolve(item))) {
      throw new RuntimeError('CAPABILITY_DENIED', 'media profile absolute path argument escapes the selected workspace');
    }
  }
}

function rejectInlineInterpreterForms(argv: readonly string[]): void {
  for (const item of argv) {
    if (item === '-c' || item === '-e' || item === '--eval' || item === '--execute' || item === '/c' || item === '-Command') {
      throw new RuntimeError('CAPABILITY_DENIED', 'Inline interpreter/shell command forms are disabled by default');
    }
  }
}

async function verifyPhysicalScript(workspace: WorkspaceRecord, cwd: string, scriptArgument: string, extensions: readonly string[]): Promise<void> {
  if (path.isAbsolute(scriptArgument)) throw new RuntimeError('CAPABILITY_DENIED', 'Project script arguments must be workspace-relative');
  const lexical = path.resolve(cwd, scriptArgument);
  if (!pathIsWithin(workspace.physicalRoot, lexical)) throw new RuntimeError('CAPABILITY_DENIED', 'Project script path escapes the selected workspace');
  let physical: string;
  try {
    const metadata = await lstat(lexical);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error('script is not a unique physical regular file');
    physical = await realpath(lexical);
  } catch (error) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Project script is unavailable or aliased', { cause: error });
  }
  if (!pathIsWithin(workspace.physicalRoot, physical) || !extensions.some((extension) => physical.endsWith(extension))) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Project script does not satisfy the selected execution profile');
  }
}

function buildEnvironment(profile: ProfileDefinition, workspace: WorkspaceRecord, overrides: Readonly<Record<string, string>>) {
  const entries = Object.entries(overrides);
  if (entries.length > MAX_ENV_OVERRIDES) throw new RuntimeError('INVALID_REQUEST', 'envOverrides exceeds the bounded entry count');
  const environment: Record<string, string> = {
    PATH: node24Path(),
    HOME: workspace.physicalRoot,
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
    LC_ALL: '',
    CI: '1',
    ...((profile.argvPolicy === 'PNPM_SCRIPT' || profile.argvPolicy === 'NPM_SCRIPT')
      ? { npm_config_ignore_scripts: 'true' }
      : {}),
  };
  const redactionValues: string[] = [];
  for (const [key, value] of entries) {
    if (!profile.envAllowlist.includes(key)) throw new RuntimeError('CAPABILITY_DENIED', `Environment override ${key} is not allowlisted by the execution profile`);
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE || value.includes('\0')) throw new RuntimeError('INVALID_REQUEST', `Environment override ${key} is invalid`);
    environment[key] = value;
    if (isSecretKey(key) && value.length > 0) redactionValues.push(value);
  }
  return { environment, redactionValues };
}

export function isSecretKey(key: string): boolean {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTH|CREDENTIAL)/i.test(key);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
