import { access, chmod, copyFile, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir, tmpdir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { RuntimeError, type CapabilityEffect, type WorkspaceRecord } from '@iris/domain';
import { canonicalNodeRuntime, node24Path } from './node-runtime.js';
import { parseAndVerifyReviewLaunchSpec } from './code-review-launch.js';

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
  readonly cleanupPaths: readonly string[];
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
  readonly argvPolicy: 'NODE_SCRIPT' | 'PYTHON_SCRIPT' | 'ROBOT_SCRIPT' | 'PNPM_SCRIPT' | 'NPM_SCRIPT' | 'FFMPEG' | 'FFPROBE' | 'PROJECT_TOOL' | 'CODEX_REVIEW';
  readonly serverOnly?: boolean;
}

const MAX_ARGV = 128;
const MAX_ARG_BYTES = 16 * 1024;
const MAX_ENV_OVERRIDES = 32;
const MAX_ENV_VALUE = 8 * 1024;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const CONSERVATIVE_EFFECTS = ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const satisfies readonly CapabilityEffect[];
const CODE_REVIEW_EFFECTS = ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const satisfies readonly CapabilityEffect[];
const PROJECT_TOOL_EFFECTS = ['READ', 'WRITE', 'EXECUTE', 'DESTRUCTIVE'] as const satisfies readonly CapabilityEffect[];
const PROJECT_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,119}$/;
const SYSTEM_PROJECT_TOOLS = new Set([
  'node','python3','python','ruby','perl','java','javac','go','swift','xcodebuild','clang','clang++','cc','c++',
  'make','cmake','ninja','adb','ffmpeg','ffprobe','robot','pytest','jq','yq','grep','sed','awk','find','ls','cat',
  'head','tail','wc','sort','uniq','cut','tr','xargs','mkdir','cp','mv','rm','touch','pwd','printf','echo','tar',
  'gzip','gunzip','zip','unzip',
]);
const PROJECT_TOOL_DENIED_EXECUTABLES = new Set(['git','gh','sudo','su','open','osascript','launchctl','security','profiles','installer','defaults']);
const PROJECT_TOOL_PROCESS_DENY = [
  '/usr/bin/sudo','/usr/bin/su','/usr/bin/open','/usr/bin/osascript','/bin/launchctl','/usr/bin/security',
  '/usr/bin/profiles','/usr/sbin/installer','/usr/bin/defaults','/usr/sbin/systemsetup','/usr/sbin/networksetup',
  '/usr/bin/git','/opt/homebrew/bin/git','/usr/local/bin/git','/opt/homebrew/bin/gh','/usr/local/bin/gh',
] as const;
const CODE_REVIEW_RUNNER_CANDIDATES = [
  fileURLToPath(new URL('./code-review-runner.mjs', import.meta.url)),
  fileURLToPath(new URL('./code-review-runner.mts', import.meta.url)),
] as const;

const PROFILES: readonly ProfileDefinition[] = [
  { id: 'node-script', executable: 'node', candidates: () => [canonicalNodeRuntime().path], minTimeoutMs: 100, maxTimeoutMs: 30 * 60_000, envAllowlist: ['CI','NODE_ENV','API_TOKEN','AUTH_TOKEN','PASSWORD'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'NODE_SCRIPT' },
  { id: 'python3-script', executable: 'python3', candidates: () => ['/usr/bin/python3','/opt/homebrew/bin/python3','/usr/local/bin/python3'], minTimeoutMs: 100, maxTimeoutMs: 30 * 60_000, envAllowlist: ['CI','PYTHONUNBUFFERED','API_TOKEN','AUTH_TOKEN','PASSWORD'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'PYTHON_SCRIPT' },
  { id: 'robot', executable: 'robot', candidates: () => ['/opt/homebrew/bin/robot','/usr/local/bin/robot'], minTimeoutMs: 100, maxTimeoutMs: 60 * 60_000, envAllowlist: ['CI','API_TOKEN','AUTH_TOKEN','PASSWORD'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'ROBOT_SCRIPT' },
  { id: 'pnpm-script', executable: 'pnpm', candidates: () => nodePackageManagerCandidates('pnpm', ['/opt/homebrew/bin/pnpm','/usr/local/bin/pnpm']), minTimeoutMs: 100, maxTimeoutMs: 60 * 60_000, envAllowlist: ['CI','NODE_ENV','API_TOKEN','AUTH_TOKEN','PASSWORD'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'PNPM_SCRIPT' },
  { id: 'npm-script', executable: 'npm', candidates: () => nodePackageManagerCandidates('npm', ['/opt/homebrew/bin/npm','/usr/local/bin/npm','/usr/bin/npm']), minTimeoutMs: 100, maxTimeoutMs: 60 * 60_000, envAllowlist: ['CI','NODE_ENV','API_TOKEN','AUTH_TOKEN','PASSWORD'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'NPM_SCRIPT' },
  { id: 'ffmpeg', executable: 'ffmpeg', candidates: () => ['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg'], minTimeoutMs: 100, maxTimeoutMs: 60 * 60_000, envAllowlist: ['CI'], effectEnvelope: CONSERVATIVE_EFFECTS, argvPolicy: 'FFMPEG' },
  { id: 'ffprobe', executable: 'ffprobe', candidates: () => ['/opt/homebrew/bin/ffprobe','/usr/local/bin/ffprobe'], minTimeoutMs: 100, maxTimeoutMs: 30 * 60_000, envAllowlist: ['CI'], effectEnvelope: ['READ','EXECUTE'], argvPolicy: 'FFPROBE' },
  { id: 'project-tool', executable: '*', candidates: () => [], minTimeoutMs: 100, maxTimeoutMs: 60 * 60_000, envAllowlist: ['CI','NODE_ENV','PYTHONUNBUFFERED','API_TOKEN','AUTH_TOKEN','PASSWORD'], effectEnvelope: PROJECT_TOOL_EFFECTS, argvPolicy: 'PROJECT_TOOL' },
  { id: 'codex-review', executable: 'node', candidates: () => [canonicalNodeRuntime().path], minTimeoutMs: 10_000, maxTimeoutMs: 30 * 60_000, envAllowlist: [], effectEnvelope: CODE_REVIEW_EFFECTS, argvPolicy: 'CODEX_REVIEW', serverOnly: true },
] as const;

function nodePackageManagerCandidates(name: 'pnpm' | 'npm', fallbacks: readonly string[]): readonly string[] {
  return [path.join(path.dirname(canonicalNodeRuntime().path), name), ...fallbacks];
}

export function executionProfileEffects(profileId: string): readonly CapabilityEffect[] | null {
  const profile = PROFILES.find((candidate) => candidate.id === profileId);
  return profile === undefined || profile.serverOnly === true ? null : profile.effectEnvelope;
}

export function codeReviewExecutionEffects(): readonly CapabilityEffect[] {
  return CODE_REVIEW_EFFECTS;
}

export async function resolveExecutionProfile(input: ResolveExecutionInput): Promise<ExecutionProfilePlan> {
  return resolveExecutionProfileInternal(input, false);
}

export async function resolveServerOwnedCodeReviewExecutionProfile(input: ResolveExecutionInput): Promise<ExecutionProfilePlan> {
  if (input.executionProfile !== 'codex-review') throw new RuntimeError('CAPABILITY_DENIED', 'Server-owned code-review resolver accepts only codex-review');
  return resolveExecutionProfileInternal(input, true);
}

async function resolveExecutionProfileInternal(input: ResolveExecutionInput, allowServerOnly: boolean): Promise<ExecutionProfilePlan> {
  const profile = PROFILES.find((candidate) => candidate.id === input.executionProfile);
  if (profile === undefined || (profile.serverOnly === true && !allowServerOnly)) throw new RuntimeError('CAPABILITY_DENIED', 'UNKNOWN_EXECUTION_PROFILE: execution profile is not caller-selectable');
  const projectTool = profile.argvPolicy === 'PROJECT_TOOL';
  if (!projectTool && input.executable !== profile.executable) throw new RuntimeError('CAPABILITY_DENIED', 'UNKNOWN_EXECUTABLE: executable does not match the selected server-owned profile');
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < profile.minTimeoutMs || input.timeoutMs > profile.maxTimeoutMs) {
    throw new RuntimeError('INVALID_REQUEST', `timeoutMs must be from ${profile.minTimeoutMs} through ${profile.maxTimeoutMs} for this profile`);
  }
  validateArgvShape(input.argv);
  const cwd = await resolveWorkspaceDirectory(input.workspace, input.cwd);
  const targetExecutableIdentity = projectTool
    ? await resolveProjectToolExecutable(input.workspace, cwd, input.executable)
    : await resolveExecutable(profile.candidates());
  await validateArgvPolicy(profile.argvPolicy, input.argv, input.workspace, cwd);
  const codexExecutableIdentity = profile.argvPolicy === 'CODEX_REVIEW' ? await resolveCodexExecutable() : null;
  const codeReviewRuntime = profile.argvPolicy === 'CODEX_REVIEW'
    ? await prepareCodeReviewRuntimeHome(input.workspace, input.stdinPath ?? null)
    : null;
  let environment: Readonly<Record<string, string>>;
  let redactionValues: readonly string[];
  try {
    ({ environment, redactionValues } = buildEnvironment(
      profile,
      input.workspace,
      input.envOverrides,
      codexExecutableIdentity,
      codeReviewRuntime?.codexHome ?? null,
    ));
  } catch (error) {
    if (codeReviewRuntime !== null) await cleanupPreparedCodeReviewDirectory(codeReviewRuntime.codexHome, 'CODEX_HOME');
    throw error;
  }

  if (projectTool) {
    const sandboxExecutable = await resolveExecutable(['/usr/bin/sandbox-exec']);
    environment = {
      ...environment,
      PATH: projectToolPath(input.workspace, cwd),
      HOME: input.workspace.physicalRoot,
      TMPDIR: input.workspace.physicalRoot,
    };
    return {
      profileId: profile.id,
      executableIdentity: sandboxExecutable,
      argv: ['-p', projectToolSandboxPolicy(input.workspace), targetExecutableIdentity, ...input.argv],
      cwd,
      environment,
      redactionValues,
      timeoutMs: input.timeoutMs,
      effectEnvelope: profile.effectEnvelope,
      stdinPath: input.stdinPath ?? null,
      cleanupPaths: [],
    };
  }

  return {
    profileId: profile.id,
    executableIdentity: targetExecutableIdentity,
    argv: [...input.argv],
    cwd,
    environment,
    redactionValues,
    timeoutMs: input.timeoutMs,
    effectEnvelope: profile.effectEnvelope,
    stdinPath: input.stdinPath ?? null,
    cleanupPaths: codeReviewRuntime === null ? [] : [codeReviewRuntime.codexHome],
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
  if (policy === 'PROJECT_TOOL') return;
  if (policy === 'CODEX_REVIEW') {
    if (argv.length !== 1) throw new RuntimeError('CAPABILITY_DENIED', 'codex-review accepts only the server-owned review runner');
    let physical: string;
    try { physical = await realpath(argv[0]!); } catch (error) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Server-owned code-review runner is unavailable', { cause: error });
    }
    if (physical !== await resolveCodeReviewRunnerPath()) {
      throw new RuntimeError('CAPABILITY_DENIED', 'codex-review runner identity is not server-owned');
    }
    return;
  }
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

async function resolveProjectToolExecutable(workspace: WorkspaceRecord, cwd: string, executable: string): Promise<string> {
  if (process.platform !== 'darwin') throw new RuntimeError('CAPABILITY_DENIED', 'project-tool is supported only by the macOS sandbox runtime');
  if (!PROJECT_TOOL_NAME.test(executable) || PROJECT_TOOL_DENIED_EXECUTABLES.has(executable)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'PROJECT_TOOL_EXECUTABLE_DENIED: executable is not eligible for project-tool');
  }
  const localCandidates = [
    path.join(cwd, 'node_modules', '.bin', executable),
    path.join(workspace.physicalRoot, 'node_modules', '.bin', executable),
    path.join(cwd, 'bin', executable),
    path.join(workspace.physicalRoot, 'bin', executable),
  ];
  for (const candidate of uniquePaths(localCandidates)) {
    try {
      const lexical = await lstat(candidate);
      if (!lexical.isFile() && !lexical.isSymbolicLink()) continue;
      const physical = await realpath(candidate);
      if (!pathIsWithin(workspace.physicalRoot, physical)) continue;
      const metadata = await lstat(physical);
      if (!metadata.isFile()) continue;
      await access(physical, constants.X_OK);
      return physical;
    } catch {
      // Try the next workspace-local candidate.
    }
  }
  if (!SYSTEM_PROJECT_TOOLS.has(executable)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'PROJECT_TOOL_NOT_FOUND: executable is not a verified project-local or allowlisted system tool');
  }
  if (executable === 'node') return canonicalNodeRuntime().path;
  return resolveExecutable([
    `/opt/homebrew/bin/${executable}`,
    `/usr/local/bin/${executable}`,
    `/usr/bin/${executable}`,
    `/bin/${executable}`,
    `/usr/sbin/${executable}`,
    `/sbin/${executable}`,
  ]);
}

function projectToolPath(workspace: WorkspaceRecord, cwd: string): string {
  return uniquePaths([
    path.join(cwd, 'node_modules', '.bin'),
    path.join(workspace.physicalRoot, 'node_modules', '.bin'),
    path.dirname(canonicalNodeRuntime().path),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]).join(path.delimiter);
}

function projectToolSandboxPolicy(workspace: WorkspaceRecord): string {
  const usersRoot = '/Users';
  const root = workspace.physicalRoot;
  if (!pathIsWithin(usersRoot, root) || root === usersRoot) {
    throw new RuntimeError('CAPABILITY_DENIED', 'PROJECT_TOOL_SCOPE_UNSUPPORTED: workspace must be inside /Users for the macOS project sandbox');
  }
  const relative = path.relative(usersRoot, root);
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  let current = usersRoot;
  const ancestors = [usersRoot];
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    ancestors.push(current);
  }
  const readExemptions = ancestors.map((candidate) => `    (require-not (literal ${JSON.stringify(candidate)}))`).join('\n');
  const processDeny = PROJECT_TOOL_PROCESS_DENY.map((candidate) => `(deny process-exec (literal ${JSON.stringify(candidate)}))`).join('\n');
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny appleevent-send)',
    '(deny file-read*',
    '  (require-all',
    `    (subpath ${JSON.stringify(usersRoot)})`,
    `    (require-not (subpath ${JSON.stringify(root)}))`,
    readExemptions,
    '  )',
    ')',
    '(deny file-write*',
    '  (require-all',
    `    (require-not (subpath ${JSON.stringify(root)}))`,
    '    (require-not (literal "/dev/null"))',
    '    (require-not (literal "/dev/tty"))',
    '    (require-not (subpath "/dev/fd"))',
    '  )',
    ')',
    '(deny file-read* (subpath "/Volumes"))',
    '(deny file-read* (subpath "/private/tmp"))',
    '(deny file-read* (subpath "/private/var/tmp"))',
    '(deny file-read* (subpath "/private/var/folders"))',
    processDeny,
    '',
  ].join('\n');
}

function uniquePaths(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export async function resolveCodeReviewRunnerPath(): Promise<string> {
  for (const candidate of CODE_REVIEW_RUNNER_CANDIDATES) {
    try {
      const physical = await realpath(candidate);
      const metadata = await lstat(physical);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) continue;
      return physical;
    } catch {
      // Source runtime resolves .mts; built runtime resolves emitted .mjs.
    }
  }
  throw new RuntimeError('CAPABILITY_DENIED', 'Server-owned code-review runner is unavailable');
}

async function resolveCodexExecutable(): Promise<string> {
  const configured = process.env.IRIS_CODEX_EXECUTABLE?.trim();
  const home = homedir();
  const candidates = [
    ...(configured && path.isAbsolute(configured) ? [configured] : []),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    path.join(home, '.volta', 'bin', 'codex'),
  ];
  return resolveExecutable(candidates);
}

async function resolveCodexAuthSource(): Promise<string> {
  const configured = process.env.IRIS_CODEX_AUTH_FILE?.trim();
  let candidate: string;
  if (configured !== undefined && configured.length > 0) {
    if (!path.isAbsolute(configured) || configured.includes('\0') || path.resolve(configured) !== configured) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Configured Codex auth source path is invalid');
    }
    candidate = configured;
  } else {
    let ownerHome: string;
    try {
      ownerHome = userInfo().homedir;
    } catch (error) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Operating-system owner home could not be resolved for Codex auth', { cause: error });
    }
    if (!path.isAbsolute(ownerHome) || path.resolve(ownerHome) !== ownerHome) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Operating-system owner home is invalid for Codex auth');
    }
    candidate = path.join(ownerHome, '.codex', 'auth.json');
  }

  let lexicalMetadata;
  let physical: string;
  try {
    lexicalMetadata = await lstat(candidate);
    physical = await realpath(candidate);
  } catch (error) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Codex auth source is unavailable', { cause: error });
  }
  if (!lexicalMetadata.isFile() || lexicalMetadata.isSymbolicLink() || lexicalMetadata.nlink !== 1
    || lexicalMetadata.size < 1 || lexicalMetadata.size > 1024 * 1024
    || (typeof process.getuid === 'function' && lexicalMetadata.uid !== process.getuid())
    || (lexicalMetadata.mode & 0o077) !== 0
    || physical !== candidate) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Codex auth source is not a private physical owner file');
  }
  return physical;
}

async function prepareCodeReviewRuntimeHome(workspace: WorkspaceRecord, stdinPath: string | null): Promise<{ readonly codexHome: string }> {
  if (stdinPath === null) throw new RuntimeError('CAPABILITY_DENIED', 'Native code review requires a server-generated launch spec');
  let raw: string;
  try { raw = await readFile(stdinPath, 'utf8'); }
  catch (error) { throw new RuntimeError('CAPABILITY_DENIED', 'Native code-review launch spec is unavailable', { cause: error }); }
  const launch = await parseAndVerifyReviewLaunchSpec(raw.trim(), workspace.physicalRoot);
  const tempRoot = await realpath(tmpdir());
  const created = await mkdtemp(path.join(tempRoot, 'iris-code-review-'));
  let codexHome = created;
  try {
    codexHome = await realpath(created);
    if (codexHome !== created) throw new RuntimeError('PERSISTENCE_FAILURE', 'Native code-review CODEX_HOME changed through an alias');
    await chmod(codexHome, 0o700);
    const authPhysical = await resolveCodexAuthSource();
    await copyFile(authPhysical, path.join(codexHome, 'auth.json'));
    await chmod(path.join(codexHome, 'auth.json'), 0o600);
    const gitMetadataReadRoot = launch.gitMetadata !== null && !pathIsWithin(workspace.physicalRoot, launch.gitMetadata.root)
      ? launch.gitMetadata.root
      : null;
    await writeFile(path.join(codexHome, 'config.toml'), permissionConfig(gitMetadataReadRoot), { mode: 0o600, flag: 'wx' });
    return { codexHome };
  } catch (error) {
    await cleanupPreparedCodeReviewDirectory(codexHome, 'CODEX_HOME');
    throw error;
  }
}

async function cleanupPreparedCodeReviewDirectory(candidate: string, label: string): Promise<void> {
  const tempRoot = await realpath(tmpdir());
  if (!path.isAbsolute(candidate) || candidate.includes('\0') || path.resolve(candidate) !== candidate
    || candidate === tempRoot || !pathIsWithin(tempRoot, candidate) || !path.basename(candidate).startsWith('iris-code-review-')) {
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} cleanup path is outside the native-review temp namespace`);
  }
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RuntimeError('PERSISTENCE_FAILURE', `${label} cleanup target is not a physical directory`);
    }
    if (await realpath(candidate) !== candidate) {
      throw new RuntimeError('PERSISTENCE_FAILURE', `${label} cleanup target changed through an alias`);
    }
    await rm(candidate, { recursive: true, force: false });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} cleanup failed`, { cause: error });
  }
}

function permissionConfig(gitMetadataRoot: string | null): string {
  const lines = [
    'approval_policy = "never"',
    'default_permissions = "iris-review"',
    '',
    '[permissions.iris-review]',
    'description = "IRIS exact-worktree read-only LOCAL_NATIVE review"',
    '',
    '[permissions.iris-review.filesystem]',
    '":root" = "deny"',
    '":minimal" = "read"',
  ];
  if (gitMetadataRoot !== null) lines.push(`${JSON.stringify(gitMetadataRoot)} = "read"`);
  lines.push(
    '',
    '[permissions.iris-review.filesystem.":workspace_roots"]',
    '"." = "read"',
    '',
    '[permissions.iris-review.network]',
    'enabled = false',
    '',
  );
  return lines.join('\n');
}

function buildEnvironment(
  profile: ProfileDefinition,
  workspace: WorkspaceRecord,
  overrides: Readonly<Record<string, string>>,
  codexExecutableIdentity: string | null = null,
  codexHome: string | null = null,
) {
  const entries = Object.entries(overrides);
  if (entries.length > MAX_ENV_OVERRIDES) throw new RuntimeError('INVALID_REQUEST', 'envOverrides exceeds the bounded entry count');
  const environment: Record<string, string> = profile.argvPolicy === 'CODEX_REVIEW'
    ? {
        PATH: node24Path(),
        HOME: codexHome ?? '',
        CODEX_HOME: codexHome ?? '',
        TMPDIR: '/tmp',
        LANG: 'en_US.UTF-8',
        LC_ALL: '',
        CI: '1',
        IRIS_CODEX_EXECUTABLE: codexExecutableIdentity ?? '',
      }
    : {
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
