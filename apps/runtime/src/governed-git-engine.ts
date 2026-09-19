import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  RuntimeError,
  type RepositoryId,
  type RepositoryRecord,
  type WorkspaceRecord,
} from '@iris/domain';
import { node24Environment } from './node-runtime.js';
import { VNextResourceRegistry, primaryWorkspaceId } from './resource-registry.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const NETWORK_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER = 1024 * 1024;
const MAX_OUTPUT = 16 * 1024;
const MAX_CAT_CONTENT = 64 * 1024;
const MAX_REF_ENTRIES = 200;
const MAX_LOG_ENTRIES = 100;
const MAX_GIT_PATHS = 24;
const MAX_COMPAT_GIT_PATHS = 100;
const PROTECTED_BRANCH = /^(main|master|release(?:[-/].*)?)$/i;
const SAFE_PUSH_BRANCH = /^(feature|fix|hotfix|chore|codex)\/[A-Za-z0-9._/-]+$/i;
const BRANCH_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const REF_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+/-]{0,199}$/;
const REMOTE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const COMMIT_MESSAGE = /^[^\0\r\n]{1,200}$/;

export type GitCompatibilityOperation = 'status' | 'head' | 'diff' | 'diff-check' | 'diff-name-only' | 'add' | 'commit';

export interface GitCompatibilityInput {
  readonly operation: GitCompatibilityOperation;
  readonly paths?: readonly string[];
  readonly message?: string;
}

export type Phase4GitOperationName =
  | 'status'
  | 'head'
  | 'diff'
  | 'log'
  | 'show'
  | 'cat_file'
  | 'merge_base'
  | 'ancestry'
  | 'refs'
  | 'branch_list'
  | 'worktree_list'
  | 'branch_create'
  | 'worktree_add'
  | 'worktree_remove'
  | 'add'
  | 'commit'
  | 'fetch'
  | 'push';

interface GitRequestBase {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly repositoryId?: string | undefined;
}

export type Phase4GitRequest =
  | (GitRequestBase & { readonly operation: 'status' | 'head' | 'worktree_list' })
  | (GitRequestBase & { readonly operation: 'diff'; readonly paths?: readonly string[] | undefined })
  | (GitRequestBase & { readonly operation: 'log'; readonly ref?: string | undefined; readonly maxCount?: number | undefined })
  | (GitRequestBase & { readonly operation: 'show'; readonly ref: string })
  | (GitRequestBase & { readonly operation: 'cat_file'; readonly object: string })
  | (GitRequestBase & { readonly operation: 'merge_base'; readonly left: string; readonly right: string })
  | (GitRequestBase & { readonly operation: 'ancestry'; readonly ancestor: string; readonly descendant: string })
  | (GitRequestBase & { readonly operation: 'refs' | 'branch_list'; readonly maxEntries?: number | undefined })
  | (GitRequestBase & { readonly operation: 'branch_create'; readonly repositoryId: string; readonly branchName: string; readonly baseRef: string })
  | (GitRequestBase & { readonly operation: 'worktree_add'; readonly repositoryId: string; readonly branchName: string; readonly baseRef: string; readonly destinationPath: string })
  | (GitRequestBase & { readonly operation: 'worktree_remove'; readonly repositoryId: string })
  | (GitRequestBase & { readonly operation: 'add'; readonly repositoryId: string; readonly paths: readonly string[] })
  | (GitRequestBase & { readonly operation: 'commit'; readonly repositoryId: string; readonly paths: readonly string[]; readonly message: string })
  | (GitRequestBase & { readonly operation: 'fetch'; readonly repositoryId: string; readonly remote: string })
  | (GitRequestBase & { readonly operation: 'push'; readonly repositoryId: string; readonly remote: string; readonly branch: string });

export interface GitRepositoryIdentity {
  readonly repositoryId: RepositoryId;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workspaceRole: 'PRIMARY' | 'WORKTREE';
  readonly workspaceRoot: string;
  readonly primaryWorkspaceId: RepositoryRecord['primaryWorkspaceId'];
  readonly commonGitDir: string;
  readonly commonGitDirDevice: string;
  readonly commonGitDirInode: string;
}

export interface Phase4GitPreflight {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly target: string;
}

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
}

export class GovernedGitEngine {
  public constructor(private readonly resources: VNextResourceRegistry) {}

  public async preflight(request: Phase4GitRequest): Promise<Phase4GitPreflight> {
    validateOperationInput(request);
    const identity = await this.inspectRepository(request.projectId, request.workspaceId, request.repositoryId);
    if (request.operation === 'worktree_add') await this.verifyWorktreeDestinationPolicy(request.projectId, request.destinationPath);
    if (request.operation === 'worktree_remove' && identity.workspaceRole !== 'WORKTREE') {
      throw new RuntimeError('CAPABILITY_DENIED', 'git.worktree_remove requires an authorized WORKTREE workspace');
    }
    if ((request.operation === 'add' || request.operation === 'commit') && request.paths.length > 0) {
      await validateExistingWorkspacePaths(identity.workspaceRoot, request.paths);
    }
    return {
      workspaceId: identity.workspaceId,
      repositoryId: identity.repositoryId,
      target: request.operation === 'worktree_add' ? request.destinationPath : identity.commonGitDir,
    };
  }

  public async execute(request: Phase4GitRequest, createdByAction: string | null = null): Promise<Record<string, unknown>> {
    validateOperationInput(request);
    const identity = await this.inspectRepository(request.projectId, request.workspaceId, request.repositoryId);
    if (request.operation === 'status') return this.status(identity);
    if (request.operation === 'head') return this.head(identity);
    if (request.operation === 'diff') return this.diff(identity, request.paths);
    if (request.operation === 'log') return this.log(identity, request.ref, request.maxCount);
    if (request.operation === 'show') return this.show(identity, request.ref);
    if (request.operation === 'cat_file') return this.catFile(identity, request.object);
    if (request.operation === 'merge_base') return this.mergeBase(identity, request.left, request.right);
    if (request.operation === 'ancestry') return this.ancestry(identity, request.ancestor, request.descendant);
    if (request.operation === 'refs') return this.refs(identity, request.maxEntries);
    if (request.operation === 'branch_list') return this.branchList(identity, request.maxEntries);
    if (request.operation === 'worktree_list') return this.worktreeList(identity);

    await this.ensureRepositoryBinding(identity);
    if (request.operation === 'branch_create') return this.branchCreate(identity, request.branchName, request.baseRef);
    if (request.operation === 'worktree_add') return this.worktreeAdd(identity, request.branchName, request.baseRef, request.destinationPath, createdByAction);
    if (request.operation === 'worktree_remove') return this.worktreeRemove(identity);
    if (request.operation === 'add') return this.add(identity, request.paths);
    if (request.operation === 'commit') return this.commit(identity, request.paths, request.message);
    if (request.operation === 'fetch') return this.fetch(identity, request.remote);
    if (request.operation === 'push') return this.push(identity, request.remote, request.branch);
    throw new RuntimeError('CAPABILITY_DENIED', 'Unsupported governed Git operation');
  }

  public async compatibilityProjectStatus(projectId: string, workspaceId: string): Promise<Record<string, unknown>> {
    const identity = await this.inspectRepository(projectId, workspaceId);
    const result = await requireGit(identity.workspaceRoot, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'], 'compatibility status');
    return parseCompatibilityProjectStatus(result.stdout);
  }

  public async compatibilityLocal(projectId: string, workspaceId: string, input: GitCompatibilityInput): Promise<Record<string, unknown>> {
    const identity = await this.inspectRepository(projectId, workspaceId);
    if (input.operation === 'status') {
      const result = await requireGit(identity.workspaceRoot, ['status', '--short', '--branch', '--untracked-files=all'], 'compatibility status');
      return {
        ...boundedOutput('status', result),
        ...await compatibilityUntrackedInventory(identity.workspaceRoot, input.paths),
        trackedDiffOnly: true,
      };
    }
    if (input.operation === 'head') {
      const result = await requireGit(identity.workspaceRoot, ['rev-parse', 'HEAD'], 'compatibility HEAD');
      return { operation: 'head', head: result.stdout.trim() };
    }
    if (input.operation === 'diff') {
      const result = await requireGit(identity.workspaceRoot, ['diff', 'HEAD', '--no-ext-diff', ...compatibilityDiffPathspec(identity.workspaceRoot, input.paths)], 'compatibility diff');
      return {
        ...boundedOutput('diff', result),
        ...await compatibilityUntrackedInventory(identity.workspaceRoot, input.paths),
        paths: input.paths ?? [],
        trackedOnly: true,
      };
    }
    if (input.operation === 'diff-check') {
      const result = await runGit(identity.workspaceRoot, ['diff', 'HEAD', '--check', ...compatibilityDiffPathspec(identity.workspaceRoot, input.paths)]);
      if (result.exitCode === 2 && !result.timedOut && !result.outputLimitExceeded) {
        return {
          ...boundedOutput('diff-check', result),
          ...await compatibilityUntrackedInventory(identity.workspaceRoot, input.paths),
          status: 'whitespace_issues',
          passed: false,
          whitespaceIssues: true,
          trackedOnly: true,
        };
      }
      if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) throw gitFailure('compatibility diff-check', result);
      return {
        ...boundedOutput('diff-check', result),
        ...await compatibilityUntrackedInventory(identity.workspaceRoot, input.paths),
        status: 'passed',
        passed: true,
        whitespaceIssues: false,
        trackedOnly: true,
      };
    }
    if (input.operation === 'diff-name-only') {
      const result = await requireGit(identity.workspaceRoot, ['diff', 'HEAD', '--name-only', ...compatibilityDiffPathspec(identity.workspaceRoot, input.paths)], 'compatibility diff-name-only');
      return {
        ...boundedOutput('diff-name-only', result),
        ...await compatibilityUntrackedInventory(identity.workspaceRoot, input.paths),
        paths: input.paths ?? [],
        trackedOnly: true,
      };
    }

    await this.ensureRepositoryBinding(identity);
    if (input.operation === 'add') {
      const selected = validateCompatibilityPaths(identity.workspaceRoot, input.paths);
      await requireGit(identity.workspaceRoot, ['add', '--', ...selected], 'compatibility add');
      return { operation: 'add', paths: selected };
    }
    if (input.operation === 'commit') {
      if (typeof input.message !== 'string' || !COMMIT_MESSAGE.test(input.message.trim())) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Commit message must be one bounded single line');
      }
      await requireGit(identity.workspaceRoot, [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'commit.gpgSign=false',
        'commit', '-m', input.message.trim(),
      ], 'compatibility commit');
      const head = (await requireGit(identity.workspaceRoot, ['rev-parse', 'HEAD'], 'compatibility commit HEAD')).stdout.trim();
      return { operation: 'commit', head };
    }
    throw new RuntimeError('CAPABILITY_DENIED', 'Unsupported compatibility Git operation');
  }

  public async compatibilityRemotePublish(projectId: string, workspaceId: string): Promise<Record<string, unknown>> {
    const identity = await this.inspectRepository(projectId, workspaceId);
    await this.ensureRepositoryBinding(identity);
    const branch = (await requireGit(identity.workspaceRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'compatibility publish branch')).stdout.trim();
    if (branch.length === 0 || PROTECTED_BRANCH.test(branch)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Remote publish rejects protected or detached branches');
    }
    const remote = await requireConfiguredRemote(identity.workspaceRoot, 'origin');
    const defaultRef = await optionalGit(identity.workspaceRoot, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
    if (defaultRef.stdout.trim() === `${remote}/${branch}`) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Remote publish rejects the configured default branch');
    }
    const localHead = (await requireGit(identity.workspaceRoot, ['rev-parse', 'HEAD'], 'compatibility publish HEAD')).stdout.trim();
    await requireGit(identity.workspaceRoot, ['push', '--porcelain', remote, `refs/heads/${branch}:refs/heads/${branch}`], 'compatibility feature branch push', NETWORK_TIMEOUT_MS);
    const remoteHeadResult = await requireGit(identity.workspaceRoot, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], 'compatibility remote HEAD verification', NETWORK_TIMEOUT_MS);
    const remoteHead = remoteHeadResult.stdout.trim().split(/\s+/)[0] ?? '';
    if (remoteHead !== localHead) throw new RuntimeError('CAPABILITY_DENIED', 'Remote branch HEAD verification failed after compatibility publish');
    return { operation: 'push-current-feature-branch', branch, remote, localHead, remoteHead, verified: true };
  }

  public async inspectRepository(projectId: string, workspaceId: string, expectedRepositoryId?: string): Promise<GitRepositoryIdentity> {
    const workspace = await this.resources.getActiveWorkspace(projectId, workspaceId);
    if (workspace.role === 'SCRATCH') throw new RuntimeError('CAPABILITY_DENIED', 'SCRATCH workspace is not a Git repository authority');
    const identity = await inspectRepositoryPhysicalIdentity(projectId, workspace);
    if (expectedRepositoryId !== undefined && identity.repositoryId !== expectedRepositoryId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'repositoryId does not match the verified Git common-directory physical identity');
    }
    if (workspace.repositoryId !== null && workspace.repositoryId !== identity.repositoryId) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Workspace repository identity no longer matches its authorized repository');
    }
    const binding = await this.resources.findRepository(projectId, identity.repositoryId);
    if (binding !== null) verifyRepositoryBinding(binding, identity);
    return identity;
  }

  private async ensureRepositoryBinding(identity: GitRepositoryIdentity): Promise<RepositoryRecord> {
    return this.resources.ensureRepository({
      repositoryId: identity.repositoryId,
      projectId: identity.projectId,
      primaryWorkspaceId: identity.primaryWorkspaceId,
      commonGitDir: identity.commonGitDir,
      commonGitDirDevice: identity.commonGitDirDevice,
      commonGitDirInode: identity.commonGitDirInode,
    });
  }

  private async status(identity: GitRepositoryIdentity): Promise<Record<string, unknown>> {
    const result = await requireGit(identity.workspaceRoot, ['status', '--short', '--branch', '--untracked-files=all'], 'status');
    return { ...repositoryView(identity), ...boundedOutput('status', result) };
  }

  private async head(identity: GitRepositoryIdentity): Promise<Record<string, unknown>> {
    const head = (await requireGit(identity.workspaceRoot, ['rev-parse', 'HEAD'], 'HEAD')).stdout.trim();
    return { ...repositoryView(identity), operation: 'head', head };
  }

  private async diff(identity: GitRepositoryIdentity, paths: readonly string[] | undefined): Promise<Record<string, unknown>> {
    const pathspec = paths === undefined ? [] : ['--', ...validateRelativePaths(paths)];
    const result = await requireGit(identity.workspaceRoot, ['diff', 'HEAD', '--no-ext-diff', ...pathspec], 'diff');
    return { ...repositoryView(identity), ...boundedOutput('diff', result), paths: paths ?? [], trackedOnly: true };
  }

  private async log(identity: GitRepositoryIdentity, ref: string | undefined, maxCount: number | undefined): Promise<Record<string, unknown>> {
    const selectedRef = ref === undefined ? 'HEAD' : validateRef(ref, 'ref');
    const count = boundedInteger(maxCount ?? 20, 1, MAX_LOG_ENTRIES, 'maxCount');
    const result = await requireGit(identity.workspaceRoot, ['log', `--max-count=${count}`, '--format=%H%x09%P%x09%ct%x09%s', selectedRef], 'log');
    const commits = result.stdout.split('\n').filter(Boolean).map((line) => {
      const [sha = '', parents = '', timestamp = '', ...subjectParts] = line.split('\t');
      return { sha, parents: parents.length === 0 ? [] : parents.split(' '), timestamp: Number(timestamp), subject: subjectParts.join('\t').slice(0, 500) };
    });
    return { ...repositoryView(identity), operation: 'log', ref: selectedRef, commits, outputTruncated: result.outputLimitExceeded };
  }

  private async show(identity: GitRepositoryIdentity, ref: string): Promise<Record<string, unknown>> {
    const selectedRef = validateRef(ref, 'ref');
    const result = await requireGit(identity.workspaceRoot, ['show', '--no-ext-diff', '--no-color', '--format=fuller', '--stat', selectedRef], 'show');
    return { ...repositoryView(identity), ...boundedOutput('show', result), ref: selectedRef };
  }

  private async catFile(identity: GitRepositoryIdentity, object: string): Promise<Record<string, unknown>> {
    const selected = validateRef(object, 'object');
    const type = (await requireGit(identity.workspaceRoot, ['cat-file', '-t', selected], 'cat-file type')).stdout.trim();
    const sizeText = (await requireGit(identity.workspaceRoot, ['cat-file', '-s', selected], 'cat-file size')).stdout.trim();
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw new RuntimeError('CAPABILITY_DENIED', 'Git object size was not a safe integer');
    if (size > MAX_CAT_CONTENT || type === 'blob') {
      return { ...repositoryView(identity), operation: 'cat_file', object: selected, objectType: type, size, content: null, contentTruncated: size > MAX_CAT_CONTENT, binaryOrBlobContentOmitted: type === 'blob' };
    }
    const contentResult = await requireGit(identity.workspaceRoot, ['cat-file', '-p', selected], 'cat-file content');
    const content = bounded(contentResult.stdout);
    return { ...repositoryView(identity), operation: 'cat_file', object: selected, objectType: type, size, content: content.value, contentTruncated: content.truncated, binaryOrBlobContentOmitted: false };
  }

  private async mergeBase(identity: GitRepositoryIdentity, left: string, right: string): Promise<Record<string, unknown>> {
    const a = validateRef(left, 'left');
    const b = validateRef(right, 'right');
    const mergeBase = (await requireGit(identity.workspaceRoot, ['merge-base', a, b], 'merge-base')).stdout.trim();
    return { ...repositoryView(identity), operation: 'merge_base', left: a, right: b, mergeBase };
  }

  private async ancestry(identity: GitRepositoryIdentity, ancestor: string, descendant: string): Promise<Record<string, unknown>> {
    const a = validateRef(ancestor, 'ancestor');
    const b = validateRef(descendant, 'descendant');
    const result = await runGit(identity.workspaceRoot, ['merge-base', '--is-ancestor', a, b]);
    if (result.timedOut || result.outputLimitExceeded || (result.exitCode !== 0 && result.exitCode !== 1)) throw gitFailure('ancestry', result);
    return { ...repositoryView(identity), operation: 'ancestry', ancestor: a, descendant: b, isAncestor: result.exitCode === 0 };
  }

  private async refs(identity: GitRepositoryIdentity, maxEntries: number | undefined): Promise<Record<string, unknown>> {
    const count = boundedInteger(maxEntries ?? 100, 1, MAX_REF_ENTRIES, 'maxEntries');
    const result = await requireGit(identity.workspaceRoot, ['for-each-ref', `--count=${count}`, '--format=%(refname)%09%(objectname)%09%(objecttype)', 'refs/heads', 'refs/remotes', 'refs/tags'], 'refs');
    const refs = result.stdout.split('\n').filter(Boolean).map((line) => {
      const [refName = '', objectName = '', objectType = ''] = line.split('\t');
      return { refName, objectName, objectType };
    });
    return { ...repositoryView(identity), operation: 'refs', refs, truncated: refs.length >= count };
  }

  private async branchList(identity: GitRepositoryIdentity, maxEntries: number | undefined): Promise<Record<string, unknown>> {
    const count = boundedInteger(maxEntries ?? 100, 1, MAX_REF_ENTRIES, 'maxEntries');
    const current = await optionalGit(identity.workspaceRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const result = await requireGit(identity.workspaceRoot, ['for-each-ref', `--count=${count}`, '--format=%(refname:short)%09%(objectname)', 'refs/heads'], 'branch-list');
    const branches = result.stdout.split('\n').filter(Boolean).map((line) => {
      const [name = '', head = ''] = line.split('\t');
      return { name, head, current: name === current.stdout.trim() };
    });
    return { ...repositoryView(identity), operation: 'branch_list', currentBranch: current.stdout.trim() || null, detached: current.stdout.trim().length === 0, branches, truncated: branches.length >= count };
  }

  private async worktreeList(identity: GitRepositoryIdentity): Promise<Record<string, unknown>> {
    const result = await requireGit(identity.workspaceRoot, ['worktree', 'list', '--porcelain'], 'worktree-list');
    const authorized = await this.resources.listWorkspaces(identity.projectId);
    const worktrees = parseWorktreePorcelain(result.stdout).map((entry) => {
      const authorization = authorized.find((workspace) => workspace.lifecycleState === 'ACTIVE' && workspace.repositoryId === identity.repositoryId && workspace.physicalRoot === entry.path);
      return { ...entry, authorized: authorization !== undefined, workspaceId: authorization?.workspaceId ?? null };
    });
    return { ...repositoryView(identity), operation: 'worktree_list', worktrees };
  }

  private async branchCreate(identity: GitRepositoryIdentity, branchName: string, baseRef: string): Promise<Record<string, unknown>> {
    const branch = await validateBranch(identity.workspaceRoot, branchName);
    const base = await resolveCommit(identity.workspaceRoot, baseRef);
    if (await localBranchExists(identity.workspaceRoot, branch)) throw new RuntimeError('PRECONDITION_FAILED', 'Requested branch already exists');
    await requireGit(identity.workspaceRoot, ['branch', '--no-track', branch, base], 'branch-create');
    const created = (await requireGit(identity.workspaceRoot, ['rev-parse', `refs/heads/${branch}`], 'created branch')).stdout.trim();
    return { ...repositoryView(identity), operation: 'branch_create', branch, baseCommit: base, head: created };
  }

  private async worktreeAdd(identity: GitRepositoryIdentity, branchName: string, baseRef: string, destinationPath: string, createdByAction: string | null): Promise<Record<string, unknown>> {
    if (identity.workspaceRole !== 'PRIMARY' && identity.workspaceRole !== 'WORKTREE') throw new RuntimeError('CAPABILITY_DENIED', 'Source workspace is not eligible for worktree creation');
    const destination = await this.verifyWorktreeDestinationPolicy(identity.projectId, destinationPath);
    const branch = await validateBranch(identity.workspaceRoot, branchName);
    const base = await resolveCommit(identity.workspaceRoot, baseRef);
    if (await localBranchExists(identity.workspaceRoot, branch)) throw new RuntimeError('PRECONDITION_FAILED', 'Requested worktree branch already exists');
    await assertMissing(destination, 'Worktree destination already exists');
    await requireGit(identity.workspaceRoot, ['worktree', 'add', '-b', branch, destination, base], 'worktree-add');

    const createdIdentity = await inspectUnregisteredWorktreeIdentity(identity.projectId, destination);
    if (createdIdentity.repositoryId !== identity.repositoryId || createdIdentity.commonGitDir !== identity.commonGitDir
      || createdIdentity.commonGitDirDevice !== identity.commonGitDirDevice || createdIdentity.commonGitDirInode !== identity.commonGitDirInode) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Created worktree does not resolve to the authorized repository common directory');
    }
    const gitFile = await lstat(path.join(destination, '.git')).catch((error: unknown) => {
      throw new RuntimeError('CAPABILITY_DENIED', 'Created worktree .git indirection is unavailable', { cause: error });
    });
    if (!gitFile.isFile() || gitFile.isSymbolicLink()) throw new RuntimeError('CAPABILITY_DENIED', 'Created worktree must use a physical .git indirection file');
    const actualBranch = (await requireGit(destination, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'created worktree branch')).stdout.trim();
    if (actualBranch !== branch) throw new RuntimeError('CAPABILITY_DENIED', 'Created worktree branch identity does not match the approved branch');
    const workspace = await this.resources.authorizeWorktree({
      projectId: identity.projectId,
      repositoryId: identity.repositoryId,
      physicalRoot: destination,
      createdByAction,
    });
    return { ...repositoryView(identity), operation: 'worktree_add', branch, baseCommit: base, workspace, status: 'BASE_VERIFIED_AND_ISOLATED_WORKTREE_CREATED' };
  }

  private async worktreeRemove(identity: GitRepositoryIdentity): Promise<Record<string, unknown>> {
    const workspace = await this.resources.getActiveWorkspace(identity.projectId, identity.workspaceId);
    if (workspace.role !== 'WORKTREE') throw new RuntimeError('CAPABILITY_DENIED', 'PRIMARY workspace cannot be removed by git.worktree_remove');
    const status = await requireGit(identity.workspaceRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'worktree dirty check');
    if (status.stdout.trim().length > 0) throw new RuntimeError('PRECONDITION_FAILED', 'Dirty WORKTREE removal is denied without force');
    const repository = await this.requirePersistedRepository(identity);
    const primary = await this.resources.getActiveWorkspace(identity.projectId, repository.primaryWorkspaceId);
    const primaryIdentity = await this.inspectRepository(identity.projectId, primary.workspaceId, identity.repositoryId);
    await this.resources.beginWorktreeRemoval(identity.projectId, identity.workspaceId, identity.repositoryId);
    try {
      await requireGit(primaryIdentity.workspaceRoot, ['worktree', 'remove', identity.workspaceRoot], 'worktree-remove');
    } catch (error) {
      await this.resources.restoreWorktreeActive(identity.projectId, identity.workspaceId, identity.repositoryId).catch(() => undefined);
      throw error;
    }
    const removed = await this.resources.completeWorktreeRemoval(identity.projectId, identity.workspaceId, identity.repositoryId);
    return { ...repositoryView(identity), operation: 'worktree_remove', workspaceId: removed.workspaceId, removed: true, lifecycleState: removed.lifecycleState };
  }

  private async add(identity: GitRepositoryIdentity, paths: readonly string[]): Promise<Record<string, unknown>> {
    const selected = await validateExistingWorkspacePaths(identity.workspaceRoot, paths);
    await requireGit(identity.workspaceRoot, ['add', '--', ...selected], 'add');
    return { ...repositoryView(identity), operation: 'add', paths: selected };
  }

  private async commit(identity: GitRepositoryIdentity, paths: readonly string[], message: string): Promise<Record<string, unknown>> {
    if (!COMMIT_MESSAGE.test(message.trim())) throw new RuntimeError('INVALID_REQUEST', 'Commit message must be one bounded single line');
    const selected = await validateExistingWorkspacePaths(identity.workspaceRoot, paths);
    await requireGit(identity.workspaceRoot, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--only', '-m', message.trim(), '--', ...selected], 'commit');
    const head = (await requireGit(identity.workspaceRoot, ['rev-parse', 'HEAD'], 'commit HEAD')).stdout.trim();
    return { ...repositoryView(identity), operation: 'commit', head, paths: selected };
  }

  private async fetch(identity: GitRepositoryIdentity, remote: string): Promise<Record<string, unknown>> {
    const selectedRemote = await requireConfiguredRemote(identity.workspaceRoot, remote);
    await requireGit(identity.workspaceRoot, ['fetch', '--no-prune', '--no-recurse-submodules', selectedRemote], 'fetch', NETWORK_TIMEOUT_MS);
    const fetchHead = await optionalGit(identity.workspaceRoot, ['rev-parse', 'FETCH_HEAD']);
    return { ...repositoryView(identity), operation: 'fetch', remote: selectedRemote, fetchHead: fetchHead.stdout.trim() || null, network: true, prune: false };
  }

  private async push(identity: GitRepositoryIdentity, remote: string, branch: string): Promise<Record<string, unknown>> {
    const selectedRemote = await requireConfiguredRemote(identity.workspaceRoot, remote);
    const selectedBranch = await validateBranch(identity.workspaceRoot, branch);
    if (PROTECTED_BRANCH.test(selectedBranch) || !SAFE_PUSH_BRANCH.test(selectedBranch)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Governed push supports only a safe feature/fix/hotfix/chore/codex branch');
    }
    const current = (await requireGit(identity.workspaceRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'push current branch')).stdout.trim();
    if (current !== selectedBranch) throw new RuntimeError('CAPABILITY_DENIED', 'Governed push may publish only the current explicit feature branch');
    const defaultRef = await optionalGit(identity.workspaceRoot, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${selectedRemote}/HEAD`]);
    if (defaultRef.stdout.trim() === `${selectedRemote}/${selectedBranch}`) throw new RuntimeError('CAPABILITY_DENIED', 'Governed push rejects the configured default branch');
    const localHead = (await requireGit(identity.workspaceRoot, ['rev-parse', `refs/heads/${selectedBranch}`], 'push local HEAD')).stdout.trim();
    await requireGit(identity.workspaceRoot, ['push', '--porcelain', selectedRemote, `refs/heads/${selectedBranch}:refs/heads/${selectedBranch}`], 'safe feature branch push', NETWORK_TIMEOUT_MS);
    const remoteHeadResult = await requireGit(identity.workspaceRoot, ['ls-remote', '--heads', selectedRemote, `refs/heads/${selectedBranch}`], 'remote HEAD verification', NETWORK_TIMEOUT_MS);
    const remoteHead = remoteHeadResult.stdout.trim().split(/\s+/)[0] ?? '';
    if (remoteHead !== localHead) throw new RuntimeError('CAPABILITY_DENIED', 'Remote branch HEAD verification failed after governed push');
    return { ...repositoryView(identity), operation: 'push', remote: selectedRemote, branch: selectedBranch, localHead, remoteHead, verified: true, network: true, force: false, delete: false };
  }

  private async requirePersistedRepository(identity: GitRepositoryIdentity): Promise<RepositoryRecord> {
    const repository = await this.resources.findRepository(identity.projectId, identity.repositoryId);
    if (repository === null) throw new RuntimeError('CAPABILITY_DENIED', 'Repository binding is not durably registered');
    verifyRepositoryBinding(repository, identity);
    return repository;
  }

  private async verifyWorktreeDestinationPolicy(projectId: string, destinationPath: string): Promise<string> {
    if (!path.isAbsolute(destinationPath) || destinationPath.includes('\0') || path.resolve(destinationPath) !== destinationPath) {
      throw new RuntimeError('INVALID_REQUEST', 'Worktree destination must be a normalized absolute path');
    }
    const primary = await this.resources.primaryWorkspace(projectId);
    const primaryParent = path.dirname(primary.physicalRoot);
    const destinationParent = path.dirname(destinationPath);
    if (destinationParent !== primaryParent) throw new RuntimeError('CAPABILITY_DENIED', 'Worktree destination must be a sibling of the project PRIMARY root');
    const parentPhysical = await realpath(primaryParent).catch((error: unknown) => {
      throw new RuntimeError('CAPABILITY_DENIED', 'Approved worktree parent physical identity is unavailable', { cause: error });
    });
    if (parentPhysical !== primaryParent) throw new RuntimeError('CAPABILITY_DENIED', 'Approved worktree parent changed through an alias');
    const primaryName = path.basename(primary.physicalRoot);
    const destinationName = path.basename(destinationPath);
    if (!destinationName.startsWith(`${primaryName}-`) || destinationName.length <= primaryName.length + 1 || /[\0\r\n]/.test(destinationName)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Worktree destination name does not match the project-specific sibling policy');
    }
    await assertMissing(destinationPath, 'Worktree destination already exists');
    return destinationPath;
  }
}

function parseCompatibilityProjectStatus(stdout: string): Record<string, unknown> {
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

function compatibilityDiffPathspec(root: string, supplied: readonly string[] | undefined): string[] {
  return supplied === undefined ? [] : ['--', ...validateCompatibilityPaths(root, supplied)];
}

function validateCompatibilityPaths(root: string, supplied: readonly string[] | undefined): string[] {
  if (!Array.isArray(supplied) || supplied.length === 0 || supplied.length > MAX_COMPAT_GIT_PATHS) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Git path selection requires an explicit bounded path list');
  }
  return supplied.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 1000 || item.includes('\0')) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Git path is invalid');
    }
    const absolute = path.resolve(root, item);
    const relative = path.relative(root, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Git path escapes or broadly targets the registered project root');
    }
    return relative;
  });
}

async function compatibilityUntrackedInventory(root: string, paths: readonly string[] | undefined): Promise<Record<string, unknown>> {
  const selection = paths === undefined ? [] : ['--', ...validateCompatibilityPaths(root, paths)];
  const result = await requireGit(root, ['ls-files', '--others', '--exclude-standard', '-z', ...selection], 'compatibility untracked inventory');
  return {
    untrackedFiles: result.stdout.split('\0').filter((item) => item.length > 0),
    untrackedFilesTruncated: result.outputLimitExceeded,
  };
}

async function inspectRepositoryPhysicalIdentity(projectId: string, workspace: WorkspaceRecord): Promise<GitRepositoryIdentity> {
  const dotGit = path.join(workspace.physicalRoot, '.git');
  const dotGitMetadata = await lstat(dotGit).catch((error: unknown) => {
    throw new RuntimeError('CAPABILITY_DENIED', 'Workspace does not expose verifiable Git metadata at its physical root', { cause: error });
  });
  if (dotGitMetadata.isSymbolicLink()) throw new RuntimeError('CAPABILITY_DENIED', 'Git metadata symlink is not accepted as repository authority');

  let commonCandidate: string;
  if (dotGitMetadata.isDirectory()) {
    commonCandidate = dotGit;
  } else if (dotGitMetadata.isFile()) {
    const pointer = await readBoundedText(dotGit, 4096, 'Git worktree indirection');
    const match = /^gitdir:\s*(.+?)\s*$/i.exec(pointer.trim());
    if (match === null || match[1] === undefined || match[1].includes('\0')) throw new RuntimeError('CAPABILITY_DENIED', 'Git worktree indirection file is invalid');
    const adminCandidate = path.isAbsolute(match[1]) ? path.resolve(match[1]) : path.resolve(workspace.physicalRoot, match[1]);
    const adminPhysical = await verifiedDirectoryPhysicalPath(adminCandidate, 'Git worktree administration directory');
    const commondirFile = path.join(adminPhysical, 'commondir');
    const commondirMetadata = await lstat(commondirFile).catch((error: unknown) => {
      throw new RuntimeError('CAPABILITY_DENIED', 'Linked worktree common-directory pointer is unavailable', { cause: error });
    });
    if (!commondirMetadata.isFile() || commondirMetadata.isSymbolicLink()) throw new RuntimeError('CAPABILITY_DENIED', 'Linked worktree common-directory pointer is invalid');
    const commonPointer = (await readBoundedText(commondirFile, 4096, 'Git common-directory pointer')).trim();
    if (commonPointer.length === 0 || commonPointer.includes('\0')) throw new RuntimeError('CAPABILITY_DENIED', 'Git common-directory pointer is empty or invalid');
    commonCandidate = path.isAbsolute(commonPointer) ? path.resolve(commonPointer) : path.resolve(adminPhysical, commonPointer);
  } else {
    throw new RuntimeError('CAPABILITY_DENIED', 'Git metadata must be a physical directory or linked-worktree indirection file');
  }

  const commonGitDir = await verifiedDirectoryPhysicalPath(commonCandidate, 'Git common directory');
  const metadata = await lstat(commonGitDir, { bigint: true });
  const device = metadata.dev.toString();
  const inode = metadata.ino.toString();
  const repositoryId = deterministicRepositoryId(projectId, device, inode);
  return {
    repositoryId,
    projectId,
    workspaceId: workspace.workspaceId,
    workspaceRole: workspace.role as 'PRIMARY' | 'WORKTREE',
    workspaceRoot: workspace.physicalRoot,
    primaryWorkspaceId: primaryWorkspaceId(projectId),
    commonGitDir,
    commonGitDirDevice: device,
    commonGitDirInode: inode,
  };
}

async function inspectUnregisteredWorktreeIdentity(projectId: string, physicalRoot: string): Promise<GitRepositoryIdentity> {
  const root = await verifiedDirectoryPhysicalPath(physicalRoot, 'Created worktree root');
  if (root !== physicalRoot) throw new RuntimeError('CAPABILITY_DENIED', 'Created worktree root changed through an alias');
  const synthetic: WorkspaceRecord = {
    workspaceId: primaryWorkspaceId(projectId),
    projectId,
    repositoryId: null,
    physicalRoot,
    role: 'WORKTREE',
    authorizationSource: 'GIT_WORKTREE_ADD',
    createdByAction: null,
    lifecycleState: 'ACTIVE',
    createdAt: new Date(0).toISOString(),
  };
  return inspectRepositoryPhysicalIdentity(projectId, synthetic);
}

function deterministicRepositoryId(projectId: string, device: string, inode: string): RepositoryId {
  const chars = createHash('sha256').update(`iris-repository:${projectId}:${device}:${inode}`).digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16]!, 16) % 4]!;
  return `${chars.slice(0, 8).join('')}-${chars.slice(8, 12).join('')}-${chars.slice(12, 16).join('')}-${chars.slice(16, 20).join('')}-${chars.slice(20).join('')}` as RepositoryId;
}

function verifyRepositoryBinding(repository: RepositoryRecord, identity: GitRepositoryIdentity): void {
  if (repository.repositoryId !== identity.repositoryId || repository.projectId !== identity.projectId
    || repository.primaryWorkspaceId !== identity.primaryWorkspaceId || repository.commonGitDir !== identity.commonGitDir
    || repository.commonGitDirDevice !== identity.commonGitDirDevice || repository.commonGitDirInode !== identity.commonGitDirInode) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Persisted repository binding no longer matches verified physical Git identity');
  }
}

function repositoryView(identity: GitRepositoryIdentity): Record<string, unknown> {
  return {
    repositoryId: identity.repositoryId,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    workspaceRole: identity.workspaceRole,
    commonGitDirIdentity: {
      path: identity.commonGitDir,
      device: identity.commonGitDirDevice,
      inode: identity.commonGitDirInode,
    },
  };
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  const selected = validateRef(ref, 'baseRef');
  return (await requireGit(cwd, ['rev-parse', '--verify', `${selected}^{commit}`], 'base commit')).stdout.trim();
}

async function validateBranch(cwd: string, branchName: string): Promise<string> {
  const branch = branchName.trim();
  if (!BRANCH_TOKEN.test(branch) || branch.startsWith('-') || branch.includes('..') || branch.endsWith('.') || branch.endsWith('/') || branch.includes('//')) {
    throw new RuntimeError('INVALID_REQUEST', 'Git branch name is invalid');
  }
  await requireGit(cwd, ['check-ref-format', '--branch', branch], 'branch validation');
  return branch;
}

async function localBranchExists(cwd: string, branch: string): Promise<boolean> {
  const result = await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (result.timedOut || result.outputLimitExceeded || (result.exitCode !== 0 && result.exitCode !== 1)) throw gitFailure('branch collision check', result);
  return result.exitCode === 0;
}

async function requireConfiguredRemote(cwd: string, remote: string): Promise<string> {
  const selected = remote.trim();
  if (!REMOTE_TOKEN.test(selected) || selected.startsWith('-')) throw new RuntimeError('INVALID_REQUEST', 'Git remote name is invalid');
  const result = await requireGit(cwd, ['remote'], 'configured remotes');
  if (!result.stdout.split('\n').map((item) => item.trim()).includes(selected)) throw new RuntimeError('CAPABILITY_DENIED', 'Requested Git remote is not configured for this repository');
  return selected;
}

async function validateExistingWorkspacePaths(root: string, supplied: readonly string[]): Promise<string[]> {
  const paths = validateRelativePaths(supplied);
  const selected: string[] = [];
  for (const relative of paths) {
    const absolute = path.join(root, relative);
    const metadata = await lstat(absolute).catch((error: unknown) => {
      throw new RuntimeError('CAPABILITY_DENIED', `Git path is unavailable: ${relative}`, { cause: error });
    });
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new RuntimeError('CAPABILITY_DENIED', 'Initial governed Git add/commit accepts only existing physical regular files');
    const physical = await realpath(absolute);
    const expected = path.resolve(root, relative);
    if (physical !== expected || !pathIsWithin(root, physical) || physical === root) throw new RuntimeError('CAPABILITY_DENIED', 'Git path escapes the authorized workspace through an alias');
    selected.push(relative);
  }
  return selected;
}

function validateRelativePaths(supplied: readonly string[]): string[] {
  if (!Array.isArray(supplied) || supplied.length === 0 || supplied.length > MAX_GIT_PATHS) throw new RuntimeError('INVALID_REQUEST', 'Git path selection requires an explicit bounded path list');
  return supplied.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 1000 || item.includes('\0') || path.isAbsolute(item)) throw new RuntimeError('INVALID_REQUEST', 'Git path must be a bounded workspace-relative path');
    const normalized = path.normalize(item);
    if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new RuntimeError('CAPABILITY_DENIED', 'Git path escapes or broadly targets the workspace');
    return normalized;
  });
}

function validateOperationInput(request: Phase4GitRequest): void {
  if (request.operation === 'branch_create' || request.operation === 'worktree_add') {
    validateSimpleBranchToken(request.branchName);
    validateRef(request.baseRef, 'baseRef');
  }
  if (request.operation === 'show') validateRef(request.ref, 'ref');
  if (request.operation === 'cat_file') validateRef(request.object, 'object');
  if (request.operation === 'merge_base') { validateRef(request.left, 'left'); validateRef(request.right, 'right'); }
  if (request.operation === 'ancestry') { validateRef(request.ancestor, 'ancestor'); validateRef(request.descendant, 'descendant'); }
  if (request.operation === 'log' && request.ref !== undefined) validateRef(request.ref, 'ref');
  if (request.operation === 'add' || request.operation === 'commit' || request.operation === 'diff' && request.paths !== undefined) validateRelativePaths(request.paths ?? []);
  if (request.operation === 'commit' && !COMMIT_MESSAGE.test(request.message.trim())) throw new RuntimeError('INVALID_REQUEST', 'Commit message must be one bounded single line');
  if (request.operation === 'fetch') validateRemoteToken(request.remote);
  if (request.operation === 'push') { validateRemoteToken(request.remote); validateSimpleBranchToken(request.branch); }
}

function validateSimpleBranchToken(value: string): string {
  const branch = value.trim();
  if (!BRANCH_TOKEN.test(branch) || branch.startsWith('-')) throw new RuntimeError('INVALID_REQUEST', 'Git branch name is invalid');
  return branch;
}

function validateRemoteToken(value: string): string {
  const remote = value.trim();
  if (!REMOTE_TOKEN.test(remote) || remote.startsWith('-')) throw new RuntimeError('INVALID_REQUEST', 'Git remote name is invalid');
  return remote;
}

function validateRef(value: string, label: string): string {
  const ref = value.trim();
  if (!REF_TOKEN.test(ref) || ref.startsWith('-') || /[\0\s]/.test(ref)) throw new RuntimeError('INVALID_REQUEST', `${label} is not a bounded Git ref/object expression`);
  return ref;
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RuntimeError('INVALID_REQUEST', `${label} must be an integer from ${min} through ${max}`);
  return value;
}

async function readBoundedText(filename: string, maxBytes: number, label: string): Promise<string> {
  const content = await readFile(filename);
  if (content.byteLength > maxBytes) throw new RuntimeError('CAPABILITY_DENIED', `${label} exceeds the bounded metadata limit`);
  return content.toString('utf8');
}

async function verifiedDirectoryPhysicalPath(candidate: string, label: string): Promise<string> {
  const metadata = await lstat(candidate).catch((error: unknown) => {
    throw new RuntimeError('CAPABILITY_DENIED', `${label} is unavailable`, { cause: error });
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new RuntimeError('CAPABILITY_DENIED', `${label} must be a physical directory`);
  return realpath(candidate).catch((error: unknown) => {
    throw new RuntimeError('CAPABILITY_DENIED', `${label} cannot be resolved physically`, { cause: error });
  });
}

async function assertMissing(target: string, message: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if (isMissing(error)) return;
    throw new RuntimeError('CAPABILITY_DENIED', 'Worktree destination identity could not be inspected', { cause: error });
  }
  throw new RuntimeError('PRECONDITION_FAILED', message);
}

async function requireGit(cwd: string, args: readonly string[], operation: string, timeout = GIT_TIMEOUT_MS): Promise<GitCommandResult> {
  const result = await runGit(cwd, args, timeout);
  if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) throw gitFailure(operation, result);
  return result;
}

async function optionalGit(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
  const result = await runGit(cwd, args);
  return result.exitCode === 0 ? result : { stdout: '', stderr: '', exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded };
}

async function runGit(cwd: string, args: readonly string[], timeout = GIT_TIMEOUT_MS): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      timeout,
      maxBuffer: MAX_BUFFER,
      env: { ...node24Environment(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '0' },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string | null; code?: number | string };
    return {
      stdout: candidate.stdout ?? '',
      stderr: candidate.stderr ?? '',
      exitCode: typeof candidate.code === 'number' ? candidate.code : null,
      signal: candidate.signal ?? null,
      timedOut: candidate.killed === true || candidate.code === 'ETIMEDOUT',
      outputLimitExceeded: candidate.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    };
  }
}

function gitFailure(operation: string, result: GitCommandResult): RuntimeError {
  const reason = result.outputLimitExceeded ? 'output limit exceeded' : result.timedOut ? 'timed out' : `exit=${result.exitCode ?? 'signal'}${result.signal === null ? '' : ` signal=${result.signal}`}`;
  const diagnostics = redact(`${result.stderr}\n${result.stdout}`).trim().slice(-MAX_OUTPUT);
  return new RuntimeError('CAPABILITY_DENIED', `Bounded Git ${operation} failed (${reason})${diagnostics.length === 0 ? '' : `: ${diagnostics}`}`);
}

function boundedOutput(operation: string, result: GitCommandResult): Record<string, unknown> {
  const stdout = bounded(redact(result.stdout));
  const stderr = bounded(redact(result.stderr));
  return {
    operation,
    stdout: stdout.value,
    stderr: stderr.value,
    outputTruncated: stdout.truncated || stderr.truncated,
    stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
    omittedOutputBytes: stdout.omittedBytes + stderr.omittedBytes,
  };
}

function bounded(value: string): { readonly value: string; readonly truncated: boolean; readonly omittedBytes: number } {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= MAX_OUTPUT) return { value, truncated: false, omittedBytes: 0 };
  const valueBytes = Buffer.from(value, 'utf8').subarray(0, MAX_OUTPUT).toString('utf8');
  return { value: `${valueBytes}\n[IRIS_OUTPUT_TRUNCATED]`, truncated: true, omittedBytes: bytes - Buffer.byteLength(valueBytes, 'utf8') };
}

function parseWorktreePorcelain(value: string): Array<Record<string, unknown>> {
  return value.split(/\n\n+/).map((block) => block.trim()).filter(Boolean).map((block) => {
    const result: Record<string, unknown> = { path: '', head: null, branch: null, detached: false, locked: false, prunable: false };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) result.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) result.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) result.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line === 'detached') result.detached = true;
      else if (line.startsWith('locked')) result.locked = true;
      else if (line.startsWith('prunable')) result.prunable = true;
    }
    return result;
  });
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function redact(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+):([^\s/@]+)@/gi, '$1[credentials-redacted]@')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s]+/gi, '$1[REDACTED]');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
