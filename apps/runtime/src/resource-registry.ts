import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rename, rmdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  RuntimeError,
  type ArtifactId,
  type ArtifactRecord,
  type ArtifactRetentionPolicy,
  type ArtifactSensitivity,
  type JobId,
  type RepositoryId,
  type RepositoryRecord,
  type WorkspaceId,
  type WorkspaceRecord,
} from '@iris/domain';
import { inspectPrivateRegularFile, privateDirectoryProblem } from './private-fs.js';
import { observeProcessStart } from './macos-safety.js';
import type { RuntimeState } from './state.js';
import type { SafetyWriterGate } from './production-safety.js';

const RESOURCE_FILE = 'vnext-resources.json';
const RECONCILIATION_FILE = 'vnext-registry-reconciliation.json';
const MUTATION_LOCK_FILE = 'vnext-registry-mutation.lock';
const SCRATCH_ROOT = 'scratch';
const PRIMARY_CREATED_AT = '1970-01-01T00:00:00.000Z';

interface LegacyResourceDocument {
  readonly schemaVersion: 1;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly artifacts: readonly ArtifactRecord[];
}

interface ResourceDocument {
  readonly schemaVersion: 2;
  readonly repositories: readonly RepositoryRecord[];
  readonly workspaces: readonly WorkspaceRecord[];
  readonly artifacts: readonly ArtifactRecord[];
}

export interface RepositoryRegistrationInput {
  readonly repositoryId: RepositoryId;
  readonly projectId: string;
  readonly primaryWorkspaceId: WorkspaceId;
  readonly commonGitDir: string;
  readonly commonGitDirDevice: string;
  readonly commonGitDirInode: string;
}

export interface RepositoryReconciliationInput {
  readonly projectId: string;
  readonly previousRepositoryId: string;
  readonly previousDevice: string;
  readonly expectedRepositoryId: string;
  readonly expectedHead: string;
  readonly expectedTree: string;
  readonly expectedWorktrees: readonly RepositoryWorktreeExpectation[];
  readonly registryTransaction?: RegistryTransactionInput;
}

export interface RegistryTransactionInput {
  readonly requestId: string;
  readonly expectedBeforeSha256: string;
  readonly staleWorkspaceIds: readonly string[];
  readonly existingWorktrees: readonly ExistingWorktreeExpectation[];
}

export interface ExistingWorktreeExpectation extends RepositoryWorktreeExpectation {
  readonly physicalRoot: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly gitAdminDevice: string;
  readonly gitAdminInode: string;
  readonly disposition: 'PRESERVE_UNTIL_RECOVERY_HANDOFF' | 'RETIRE_AFTER_EVIDENCE';
  readonly authorizedAt: string;
}

type RegistryTransactionState = 'PREPARED' | 'APPLYING' | 'COMMITTED' | 'FAILED' | 'RECONCILIATION_REQUIRED';

interface RegistryTransactionRecord {
  readonly requestId: string;
  readonly state: RegistryTransactionState;
  readonly fingerprint: string;
  readonly requestSha256: string;
  readonly beforeImageFile: string;
  readonly beforeSha256: string;
  readonly applyingSha256: string;
  readonly afterSha256: string;
  readonly staleWorkspaceIds: readonly string[];
  readonly importedWorkspaceIds: readonly string[];
  readonly existingWorktreeDispositions: readonly {
    readonly workspaceId: string;
    readonly disposition: ExistingWorktreeExpectation['disposition'];
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly errorCode: string | null;
}

interface RegistryTransactionDocument {
  readonly schemaVersion: 1;
  readonly transactions: readonly RegistryTransactionRecord[];
}

interface RegistryMutationLock {
  readonly schemaVersion: 1;
  readonly lockId: string;
  readonly pid: number;
  readonly processStartMarker: string;
  readonly createdAt: string;
}

export interface RepositoryWorktreeExpectation {
  readonly workspaceId: string;
  readonly head: string;
  readonly tree: string;
  readonly ref: string;
}

export interface WorktreeAuthorizationInput {
  readonly projectId: string;
  readonly repositoryId: RepositoryId;
  readonly physicalRoot: string;
  readonly createdByAction: string | null;
}

export interface ArtifactRegistrationInput {
  readonly projectId: string;
  readonly workspaceId: WorkspaceId;
  readonly physicalPath: string;
  readonly producerJobId?: JobId | null;
  readonly producerActionId?: string | null;
  readonly mime: string;
  readonly artifactType: string;
  readonly size: number;
  readonly sha256: string;
  readonly sensitivity: ArtifactSensitivity;
  readonly retentionPolicy: ArtifactRetentionPolicy;
}

export class VNextResourceRegistry {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly state: RuntimeState,
    public readonly dataRoot: string,
    private readonly safety?: SafetyWriterGate,
  ) {}

  public async listWorkspaces(projectId?: string): Promise<readonly WorkspaceRecord[]> {
    const projects = await this.state.listProjects();
    const document = await this.readDocument();
    const primaries = projects.map((project) => {
      const workspaceId = primaryWorkspaceId(project.id);
      const repository = document.repositories.find((candidate) => candidate.projectId === project.id && candidate.primaryWorkspaceId === workspaceId);
      return primaryWorkspace(project.id, project.rootPath, repository?.repositoryId ?? null);
    });
    const combined = [...primaries, ...document.workspaces.filter((workspace) => workspace.lifecycleState !== 'DELETED')];
    return projectId === undefined ? combined : combined.filter((workspace) => workspace.projectId === projectId);
  }

  public async getWorkspace(projectId: string, workspaceId: string): Promise<WorkspaceRecord> {
    assertUuid(projectId, 'projectId');
    assertUuid(workspaceId, 'workspaceId');
    const workspace = (await this.listWorkspaces(projectId)).find((entry) => entry.workspaceId === workspaceId);
    if (workspace === undefined) throw new RuntimeError('WORKSPACE_NOT_FOUND', 'Workspace was not found for the selected project');
    return workspace;
  }

  public async getActiveWorkspace(projectId: string, workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = await this.getWorkspace(projectId, workspaceId);
    if (workspace.lifecycleState !== 'ACTIVE') throw new RuntimeError('CAPABILITY_DENIED', 'Workspace is not ACTIVE');
    await verifyWorkspacePhysicalIdentity(workspace);
    return workspace;
  }

  public async primaryWorkspace(projectId: string): Promise<WorkspaceRecord> {
    assertUuid(projectId, 'projectId');
    const project = (await this.state.listProjects()).find((entry) => entry.id === projectId);
    if (project === undefined) throw new RuntimeError('PROJECT_NOT_FOUND', 'Project is not registered');
    const document = await this.readDocument();
    const workspaceId = primaryWorkspaceId(project.id);
    const repository = document.repositories.find((candidate) => candidate.projectId === project.id && candidate.primaryWorkspaceId === workspaceId);
    const workspace = primaryWorkspace(project.id, project.rootPath, repository?.repositoryId ?? null);
    await verifyWorkspacePhysicalIdentity(workspace);
    return workspace;
  }

  public createScratch(projectId: string, createdByAction: string | null = null): Promise<WorkspaceRecord> {
    return this.serializeMutation(async () => {
      assertUuid(projectId, 'projectId');
      if (createdByAction !== null) assertUuid(createdByAction, 'createdByAction');
      if (!(await this.state.listProjects()).some((project) => project.id === projectId)) {
        throw new RuntimeError('PROJECT_NOT_FOUND', 'Project is not registered');
      }
      const parent = await this.ensureScratchParent(projectId);
      const workspaceId = randomUUID() as WorkspaceId;
      const physicalRoot = path.join(parent, workspaceId);
      let created = false;
      try {
        await mkdir(physicalRoot, { mode: 0o700 });
        created = true;
        const physical = await realpath(physicalRoot);
        if (physical !== physicalRoot || await privateDirectoryProblem(physicalRoot, 'Scratch workspace') !== null) {
          throw new RuntimeError('CAPABILITY_DENIED', 'Scratch workspace physical identity could not be verified');
        }
        const workspace: WorkspaceRecord = {
          workspaceId,
          projectId,
          repositoryId: null,
          physicalRoot,
          role: 'SCRATCH',
          authorizationSource: 'SYSTEM_SCRATCH',
          createdByAction,
          lifecycleState: 'ACTIVE',
          createdAt: new Date().toISOString(),
        };
        const document = await this.readDocument();
        await this.writeDocument({ ...document, workspaces: [...document.workspaces, workspace] });
        return workspace;
      } catch (error) {
        if (created) await removeExactEmptyDirectory(physicalRoot).catch(() => undefined);
        throw error;
      }
    });
  }

  public revokeScratch(projectId: string, workspaceId: string): Promise<WorkspaceRecord> {
    return this.serializeMutation(async () => {
      assertUuid(projectId, 'projectId');
      assertUuid(workspaceId, 'workspaceId');
      const document = await this.readDocument();
      const index = document.workspaces.findIndex((workspace) => workspace.workspaceId === workspaceId && workspace.projectId === projectId);
      if (index < 0) throw new RuntimeError('WORKSPACE_NOT_FOUND', 'Scratch workspace was not found for the selected project');
      const current = document.workspaces[index]!;
      if (current.role !== 'SCRATCH') throw new RuntimeError('CAPABILITY_DENIED', 'Only SCRATCH workspaces may be revoked by the Phase 2 lifecycle');
      if (current.lifecycleState === 'REVOKED') return current;
      if (current.lifecycleState !== 'ACTIVE') throw new RuntimeError('CAPABILITY_DENIED', 'Scratch workspace lifecycle is not eligible for revocation');
      const updated: WorkspaceRecord = { ...current, lifecycleState: 'REVOKED' };
      const workspaces = [...document.workspaces];
      workspaces[index] = updated;
      await this.writeDocument({ ...document, workspaces });
      return updated;
    });
  }

  public async findRepository(projectId: string, repositoryId: string): Promise<RepositoryRecord | null> {
    assertUuid(projectId, 'projectId');
    assertUuid(repositoryId, 'repositoryId');
    const repository = (await this.readDocument()).repositories.find((candidate) => candidate.repositoryId === repositoryId) ?? null;
    if (repository !== null && repository.projectId !== projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Repository does not belong to the selected project');
    return repository;
  }

  public async verifiedRepositoryForWorkspace(projectId: string, workspaceId: string): Promise<RepositoryRecord | null> {
    const workspace = await this.getActiveWorkspace(projectId, workspaceId);
    if (workspace.repositoryId === null) return null;
    const repository = await this.findRepository(projectId, workspace.repositoryId);
    if (repository === null) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace repository binding is no longer registered');
    await verifyRepositoryDirectoryIdentity(repository.commonGitDir, repository.commonGitDirDevice, repository.commonGitDirInode);
    return repository;
  }

  public ensureRepository(input: RepositoryRegistrationInput): Promise<RepositoryRecord> {
    return this.serializeMutation(async () => {
      assertUuid(input.projectId, 'projectId');
      assertUuid(input.repositoryId, 'repositoryId');
      assertUuid(input.primaryWorkspaceId, 'primaryWorkspaceId');
      if (input.primaryWorkspaceId !== primaryWorkspaceId(input.projectId)) throw new RuntimeError('CAPABILITY_DENIED', 'Repository binding does not target the project PRIMARY workspace');
      const primary = await this.primaryWorkspace(input.projectId);
      if (primary.workspaceId !== input.primaryWorkspaceId) throw new RuntimeError('CAPABILITY_DENIED', 'Repository PRIMARY workspace identity is inconsistent');
      await verifyRepositoryDirectoryIdentity(input.commonGitDir, input.commonGitDirDevice, input.commonGitDirInode);
      const document = await this.readDocument();
      const existing = document.repositories.find((candidate) => candidate.repositoryId === input.repositoryId);
      if (existing !== undefined) {
        if (!sameRepositoryIdentity(existing, input)) throw new RuntimeError('CAPABILITY_DENIED', 'repositoryId is already bound to a different physical Git repository');
        return existing;
      }
      if (document.repositories.some((candidate) => candidate.projectId === input.projectId && candidate.primaryWorkspaceId === input.primaryWorkspaceId)) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Project PRIMARY workspace is already bound to another repository identity');
      }
      const repository: RepositoryRecord = { ...input, createdAt: new Date().toISOString() };
      await this.writeDocument({ ...document, repositories: [...document.repositories, repository] });
      return repository;
    });
  }

  public reconcileRepository(
    input: RepositoryReconciliationInput,
    inspect: (repository: RepositoryRecord, workspaces: readonly WorkspaceRecord[], staleWorkspaces: readonly WorkspaceRecord[]) => Promise<{
      identity: RepositoryRegistrationInput;
      evidence: unknown;
    }>,
    approvedFingerprint?: string,
  ) {
    return this.serializeMutation(async () => {
      assertUuid(input.projectId, 'projectId');
      assertUuid(input.previousRepositoryId, 'previousRepositoryId');
      assertUuid(input.expectedRepositoryId, 'expectedRepositoryId');
      if (!/^[0-9]+$/.test(input.previousDevice)) throw new RuntimeError('INVALID_REQUEST', 'previousDevice must be a decimal device number');
      assertGitObjectId(input.expectedHead, 'expectedHead');
      assertGitObjectId(input.expectedTree, 'expectedTree');
      if (!Array.isArray(input.expectedWorktrees) || input.expectedWorktrees.length === 0 || input.expectedWorktrees.length > 128) {
        throw new RuntimeError('INVALID_REQUEST', 'expectedWorktrees must be a bounded non-empty list');
      }
      const expectationIds = new Set<string>();
      for (const expectation of input.expectedWorktrees) {
        if (!isRecord(expectation) || typeof expectation.workspaceId !== 'string'
          || typeof expectation.head !== 'string' || typeof expectation.tree !== 'string'
          || typeof expectation.ref !== 'string') {
          throw new RuntimeError('INVALID_REQUEST', 'expectedWorktrees contains an invalid entry');
        }
        assertUuid(expectation.workspaceId, 'expectedWorktrees.workspaceId');
        assertGitObjectId(expectation.head, 'expectedWorktrees.head');
        assertGitObjectId(expectation.tree, 'expectedWorktrees.tree');
        if (expectation.ref.length === 0 || expectation.ref.length > 1024 || expectation.ref.includes('\0') || /[\r\n]/.test(expectation.ref)) {
          throw new RuntimeError('INVALID_REQUEST', 'expectedWorktrees.ref is invalid');
        }
        if (expectationIds.has(expectation.workspaceId)) throw new RuntimeError('INVALID_REQUEST', 'expectedWorktrees contains a duplicate workspace');
        expectationIds.add(expectation.workspaceId);
      }
      const transaction = input.registryTransaction;
      if (transaction !== undefined) validateRegistryTransactionInput(transaction);
      const requestSha256 = registryRequestSha256(input);
      const transactionDocument = transaction === undefined ? null : await this.readTransactionDocument();
      const priorTransaction = transaction === undefined ? undefined
        : transactionDocument?.transactions.find((entry) => entry.requestId === transaction.requestId);
      if (priorTransaction !== undefined && priorTransaction.requestSha256 !== requestSha256) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Registry transaction requestId is already bound to another request');
      }
      if (priorTransaction !== undefined) {
        const current = await this.readDocumentSnapshot();
        if (priorTransaction.state === 'COMMITTED' || current.sha256 === priorTransaction.afterSha256) {
          if (approvedFingerprint !== undefined && approvedFingerprint !== priorTransaction.fingerprint) {
            throw new RuntimeError('CAPABILITY_DENIED', 'Registry recovery fingerprint differs from the durable transaction');
          }
          if (approvedFingerprint !== undefined && priorTransaction.state !== 'COMMITTED') {
            await this.upsertTransaction(transactionDocument!, { ...priorTransaction, state: 'COMMITTED',
              updatedAt: new Date().toISOString(), errorCode: null });
          }
          const beforeImage = JSON.parse(await readPrivateBeforeImage(this.dataRoot, priorTransaction)) as unknown;
          if (!isResourceDocument(beforeImage)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry transaction before-image is invalid');
          const originalRepository = beforeImage.repositories.find((entry) => entry.projectId === input.projectId
            && entry.repositoryId === input.previousRepositoryId);
          if (originalRepository === undefined) throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry transaction repository authority is missing');
          const currentRepository = current.document.repositories.find((entry) => entry.projectId === input.projectId);
          return { operation: 'repository_reconcile', projectId: input.projectId,
            previousRepositoryId: input.previousRepositoryId, repositoryId: input.expectedRepositoryId,
            workspaceIds: currentRepository === undefined ? priorTransaction.importedWorkspaceIds
              : current.document.workspaces.filter((entry) => entry.projectId === input.projectId
                && entry.repositoryId === currentRepository.repositoryId && entry.lifecycleState === 'ACTIVE')
                .map((entry) => entry.workspaceId),
            commonGitDir: originalRepository.commonGitDir, fingerprint: priorTransaction.fingerprint, changed: true,
            source: { head: input.expectedHead, tree: input.expectedTree, worktrees: input.expectedWorktrees },
            registryTransaction: { requestId: transaction!.requestId,
              staleWorkspaceIds: transaction!.staleWorkspaceIds,
              importedWorkspaceIds: priorTransaction.importedWorkspaceIds } };
        }
      }
      let document = await this.readDocument();
      if (priorTransaction !== undefined) {
        const beforeImage = await readPrivateBeforeImage(this.dataRoot, priorTransaction);
        const parsed = JSON.parse(beforeImage) as unknown;
        if (!isResourceDocument(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry transaction before-image is invalid');
        document = parsed;
      }
      const candidates = document.repositories.filter((entry) => entry.projectId === input.projectId);
      if (candidates.length > 1) throw new RuntimeError('CAPABILITY_DENIED', 'Repository registration is ambiguous');
      const repository = candidates[0];
      if (repository === undefined) throw new RuntimeError('CAPABILITY_DENIED', 'Repository reconciliation requires an existing binding');
      if (repository.repositoryId !== input.previousRepositoryId && repository.repositoryId !== input.expectedRepositoryId) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Repository binding changed since recovery was requested');
      }
      if (repository.repositoryId === input.previousRepositoryId && repository.commonGitDirDevice !== input.previousDevice) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Previous device does not match the registered binding');
      }
      const workspaces = document.workspaces.filter((entry) => entry.repositoryId === repository.repositoryId);
      if (workspaces.some((entry) => entry.projectId !== input.projectId || entry.role !== 'WORKTREE'
        || (entry.lifecycleState !== 'ACTIVE' && entry.lifecycleState !== 'DELETED'))) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Repository workspace ownership or lifecycle is ambiguous');
      }
      const staleWorkspaceIds = new Set(transaction?.staleWorkspaceIds ?? []);
      const staleWorkspaces = workspaces.filter((entry) => staleWorkspaceIds.has(entry.workspaceId));
      if (transaction !== undefined) {
        if (staleWorkspaces.length !== staleWorkspaceIds.size
          || staleWorkspaces.some((entry) => entry.lifecycleState !== 'ACTIVE' || entry.role !== 'WORKTREE')) {
          throw new RuntimeError('CAPABILITY_DENIED', 'Stale workspace set does not exactly match ACTIVE WORKTREE authority');
        }
        for (const workspace of staleWorkspaces) await assertMissing(workspace.physicalRoot, 'Stale workspace root still exists');
      }
      const projects = await this.state.listProjects();
      const existingWorkspaceIds = new Set<string>([
        ...projects.map((entry) => primaryWorkspaceId(entry.id)),
        ...document.workspaces.map((entry) => entry.workspaceId),
      ]);
      const existingWorkspaceRoots = document.workspaces.map((entry) => path.resolve(entry.physicalRoot));
      if (transaction?.existingWorktrees.some((entry) => existingWorkspaceIds.has(entry.workspaceId)
        || existingWorkspaceRoots.some((root) => pathsOverlap(root, path.resolve(entry.physicalRoot))))) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Existing worktree conflicts with registered workspace authority');
      }
      const governedWorkspaces = transaction?.existingWorktrees.map((entry) => ({
        workspaceId: entry.workspaceId as WorkspaceId,
        projectId: input.projectId,
        repositoryId: repository.repositoryId,
        physicalRoot: entry.physicalRoot,
        role: 'WORKTREE' as const,
        authorizationSource: 'OWNER_APPROVAL' as const,
        createdByAction: null,
        lifecycleState: 'ACTIVE' as const,
        createdAt: entry.authorizedAt,
      })) ?? [];
      const importedWorkspaceIds = new Set(transaction?.existingWorktrees
        .filter((entry) => entry.disposition === 'PRESERVE_UNTIL_RECOVERY_HANDOFF').map((entry) => entry.workspaceId) ?? []);
      const importedWorkspaces = governedWorkspaces.filter((entry) => importedWorkspaceIds.has(entry.workspaceId));
      if (importedWorkspaces.some((candidate) => document.workspaces.some((entry) => entry.workspaceId === candidate.workspaceId
        || (entry.physicalRoot === candidate.physicalRoot && entry.lifecycleState !== 'DELETED')))) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Existing worktree import conflicts with registered workspace authority');
      }
      const registeredWorkspaces = [
        ...workspaces.filter((entry) => entry.lifecycleState === 'ACTIVE' && !staleWorkspaceIds.has(entry.workspaceId)),
        ...importedWorkspaces,
      ];
      const governedInventory = [
        ...workspaces.filter((entry) => entry.lifecycleState === 'ACTIVE' && !staleWorkspaceIds.has(entry.workspaceId)),
        ...governedWorkspaces,
      ];
      const expectedWorkspaceIds = new Set<string>([repository.primaryWorkspaceId, ...governedInventory.map((entry) => entry.workspaceId)]);
      if (expectationIds.size !== expectedWorkspaceIds.size
        || [...expectationIds].some((workspaceId) => !expectedWorkspaceIds.has(workspaceId))) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Expected worktree source bindings do not match the active repository inventory');
      }
      const expectedPrimary = input.expectedWorktrees.find((entry) => entry.workspaceId === repository.primaryWorkspaceId);
      if (expectedPrimary?.head !== input.expectedHead || expectedPrimary.tree !== input.expectedTree) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Expected primary source identity is inconsistent');
      }
      const project = projects.find((entry) => entry.id === input.projectId);
      if (project === undefined) throw new RuntimeError('CAPABILITY_DENIED', 'Repository project registration is unavailable');
      const targetRoots = await Promise.all([project.rootPath, ...governedInventory.map((entry) => entry.physicalRoot)]
        .map((root) => verifyPhysicalDirectory(root, 'Repository recovery target root')));
      for (let left = 0; left < targetRoots.length; left += 1) {
        for (let right = left + 1; right < targetRoots.length; right += 1) {
          if (pathsOverlap(targetRoots[left]!, targetRoots[right]!)) {
            throw new RuntimeError('CAPABILITY_DENIED', 'Repository recovery worktree roots overlap');
          }
        }
      }
      const otherRoots = await Promise.all(projects.filter((entry) => entry.id !== input.projectId)
        .map((entry) => verifyPhysicalDirectory(entry.rootPath, 'Other registered project root')));
      if (targetRoots.some((target) => otherRoots.some((other) => pathsOverlap(target, other)))) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Repository recovery overlaps another registered project');
      }
      const { identity, evidence } = await inspect(repository, governedInventory, staleWorkspaces);
      if (identity.repositoryId !== input.expectedRepositoryId || identity.projectId !== input.projectId
        || identity.primaryWorkspaceId !== repository.primaryWorkspaceId
        || identity.commonGitDir !== repository.commonGitDir || identity.commonGitDirInode !== repository.commonGitDirInode) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Recovery permits only device-number drift of the existing repository');
      }
      if (document.repositories.some((entry) => entry !== repository
        && (entry.repositoryId === identity.repositoryId || entry.commonGitDir === identity.commonGitDir))) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Repository recovery conflicts with another registration');
      }
      // Normalize the old binding so a retry after atomic publication has the same fingerprint.
      const before = await this.readDocumentSnapshot();
      const allowedTransactionHashes = priorTransaction === undefined
        ? [transaction?.expectedBeforeSha256]
        : [priorTransaction.beforeSha256, priorTransaction.applyingSha256, priorTransaction.afterSha256];
      if (transaction !== undefined && !allowedTransactionHashes.includes(before.sha256)) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Registry before-image changed since recovery was requested');
      }
      const fingerprint = createHash('sha256').update(JSON.stringify({
        repository: { ...repository, repositoryId: input.previousRepositoryId, commonGitDirDevice: input.previousDevice },
        workspaces: workspaces.map((entry) => ({ ...entry, repositoryId: input.previousRepositoryId })),
        identity, evidence, transaction: transaction ?? null,
        ...(transaction === undefined ? {} : { beforeSha256: transaction.expectedBeforeSha256 }),
      })).digest('hex');
      const changed = transaction !== undefined
        || repository.repositoryId !== identity.repositoryId
        || repository.commonGitDirDevice !== identity.commonGitDirDevice;
      if (approvedFingerprint !== undefined) {
        if (approvedFingerprint !== fingerprint) throw new RuntimeError('CAPABILITY_DENIED', 'Repository recovery evidence changed after owner approval');
        if (transaction === undefined) {
          if (changed) await this.writeDocument({
            ...document,
            repositories: document.repositories.map((entry) => entry === repository ? { ...entry, ...identity } : entry),
            workspaces: document.workspaces.map((entry) => entry.repositoryId === repository.repositoryId ? { ...entry, repositoryId: identity.repositoryId } : entry),
          });
        } else {
          await this.publishRegistryTransaction(document, repository, identity, staleWorkspaces, importedWorkspaces,
            transaction, fingerprint, requestSha256);
        }
      }
      return { operation: 'repository_reconcile', projectId: input.projectId,
        previousRepositoryId: input.previousRepositoryId, repositoryId: identity.repositoryId,
        workspaceIds: [repository.primaryWorkspaceId, ...registeredWorkspaces.map((entry) => entry.workspaceId)],
        commonGitDir: identity.commonGitDir, fingerprint, changed,
        source: { head: input.expectedHead, tree: input.expectedTree, worktrees: input.expectedWorktrees },
        registryTransaction: transaction === undefined ? null : { requestId: transaction.requestId,
          staleWorkspaceIds: transaction.staleWorkspaceIds, importedWorkspaceIds: importedWorkspaces.map((entry) => entry.workspaceId) } };
    }, input.registryTransaction?.requestId, approvedFingerprint !== undefined);
  }

  private async publishRegistryTransaction(
    document: ResourceDocument,
    repository: RepositoryRecord,
    identity: RepositoryRegistrationInput,
    staleWorkspaces: readonly WorkspaceRecord[],
    importedWorkspaces: readonly WorkspaceRecord[],
    transaction: RegistryTransactionInput,
    fingerprint: string,
    requestSha256: string,
  ): Promise<void> {
    const stale = new Set(staleWorkspaces.map((entry) => entry.workspaceId));
    const applying: ResourceDocument = { ...document, workspaces: document.workspaces.map((entry) => stale.has(entry.workspaceId)
      ? { ...entry, lifecycleState: 'DELETING' as const } : entry) };
    const committed: ResourceDocument = {
      ...document,
      repositories: document.repositories.map((entry) => entry === repository ? { ...entry, ...identity } : entry),
      workspaces: [
        ...document.workspaces.map((entry) => stale.has(entry.workspaceId)
          ? { ...entry, repositoryId: identity.repositoryId, lifecycleState: 'DELETED' as const }
          : entry.repositoryId === repository.repositoryId ? { ...entry, repositoryId: identity.repositoryId } : entry),
        ...importedWorkspaces.map((entry) => ({ ...entry, repositoryId: identity.repositoryId })),
      ],
    };
    const applyingSha256 = documentSha256(applying);
    const afterSha256 = documentSha256(committed);
    const transactions = await this.readTransactionDocument();
    const existing = transactions.transactions.find((entry) => entry.requestId === transaction.requestId);
    if (existing !== undefined && (existing.fingerprint !== fingerprint || existing.beforeSha256 !== transaction.expectedBeforeSha256
      || existing.applyingSha256 !== applyingSha256 || existing.afterSha256 !== afterSha256)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Registry transaction requestId is already bound to different evidence');
    }
    const current = await this.readDocumentSnapshot();
    if (existing?.state === 'COMMITTED') {
      if (current.sha256 !== afterSha256) throw new RuntimeError('PERSISTENCE_FAILURE', 'Committed registry transaction no longer matches registry bytes');
      return;
    }
    if (![transaction.expectedBeforeSha256, applyingSha256, afterSha256].includes(current.sha256)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Registry changed outside the approved transaction');
    }
    const now = new Date().toISOString();
    const beforeImageFile = `registry-reconciliation-${transaction.requestId}.before.json`;
    const base: RegistryTransactionRecord = existing ?? {
      requestId: transaction.requestId, state: 'PREPARED', fingerprint, requestSha256, beforeImageFile,
      beforeSha256: transaction.expectedBeforeSha256, applyingSha256, afterSha256,
      staleWorkspaceIds: transaction.staleWorkspaceIds,
      importedWorkspaceIds: importedWorkspaces.map((entry) => entry.workspaceId),
      existingWorktreeDispositions: transaction.existingWorktrees.map((entry) => ({
        workspaceId: entry.workspaceId,
        disposition: entry.disposition,
      })),
      createdAt: now, updatedAt: now, errorCode: null,
    };
    await writePrivateBeforeImage(this.dataRoot, base, current.content);
    await this.upsertTransaction(transactions, { ...base, state: 'PREPARED', updatedAt: now, errorCode: null });
    try {
      await this.upsertTransaction(await this.readTransactionDocument(), { ...base, state: 'APPLYING', updatedAt: new Date().toISOString(), errorCode: null });
      if (current.sha256 === transaction.expectedBeforeSha256) await this.writeDocument(applying);
      const afterApplying = await this.readDocumentSnapshot();
      if (afterApplying.sha256 === applyingSha256) await this.writeDocument(committed);
      const final = await this.readDocumentSnapshot();
      if (final.sha256 !== afterSha256) throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry transaction publication outcome is unknown');
      await this.upsertTransaction(await this.readTransactionDocument(), { ...base, state: 'COMMITTED', updatedAt: new Date().toISOString(), errorCode: null });
    } catch (error) {
      const observed = await this.readDocumentSnapshot().catch(() => null);
      const state: RegistryTransactionState = observed?.sha256 === transaction.expectedBeforeSha256 ? 'FAILED' : 'RECONCILIATION_REQUIRED';
      await this.upsertTransaction(await this.readTransactionDocument(), { ...base, state, updatedAt: new Date().toISOString(),
        errorCode: error instanceof RuntimeError ? error.code : 'PERSISTENCE_FAILURE' }).catch(() => undefined);
      throw error;
    }
  }

  public authorizeWorktree(input: WorktreeAuthorizationInput): Promise<WorkspaceRecord> {
    return this.serializeMutation(async () => {
      assertUuid(input.projectId, 'projectId');
      assertUuid(input.repositoryId, 'repositoryId');
      if (input.createdByAction !== null) assertUuid(input.createdByAction, 'createdByAction');
      if (!path.isAbsolute(input.physicalRoot) || input.physicalRoot.includes('\0') || path.resolve(input.physicalRoot) !== input.physicalRoot) {
        throw new RuntimeError('INVALID_REQUEST', 'WORKTREE physical root must be a normalized absolute path');
      }
      await verifyPhysicalDirectory(input.physicalRoot, 'WORKTREE physical root');
      const document = await this.readDocument();
      const repository = document.repositories.find((candidate) => candidate.repositoryId === input.repositoryId && candidate.projectId === input.projectId);
      if (repository === undefined) throw new RuntimeError('CAPABILITY_DENIED', 'WORKTREE repository binding is not registered');
      const project = (await this.state.listProjects()).find((candidate) => candidate.id === input.projectId);
      if (project === undefined) throw new RuntimeError('PROJECT_NOT_FOUND', 'Project is not registered');
      if (project.rootPath === input.physicalRoot) throw new RuntimeError('CAPABILITY_DENIED', 'PRIMARY project root cannot be re-authorized as WORKTREE');
      const existing = document.workspaces.find((candidate) => candidate.physicalRoot === input.physicalRoot && candidate.lifecycleState !== 'DELETED');
      if (existing !== undefined) {
        if (existing.projectId === input.projectId && existing.repositoryId === input.repositoryId && existing.role === 'WORKTREE' && existing.lifecycleState === 'ACTIVE') return existing;
        throw new RuntimeError('CAPABILITY_DENIED', 'WORKTREE physical root is already associated with another workspace authority');
      }
      const workspace: WorkspaceRecord = {
        workspaceId: randomUUID() as WorkspaceId,
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        physicalRoot: input.physicalRoot,
        role: 'WORKTREE',
        authorizationSource: 'GIT_WORKTREE_ADD',
        createdByAction: input.createdByAction,
        lifecycleState: 'ACTIVE',
        createdAt: new Date().toISOString(),
      };
      await this.writeDocument({ ...document, workspaces: [...document.workspaces, workspace] });
      return workspace;
    });
  }

  public beginWorktreeRemoval(projectId: string, workspaceId: string, repositoryId: string): Promise<WorkspaceRecord> {
    return this.transitionWorktree(projectId, workspaceId, repositoryId, 'ACTIVE', 'DELETING');
  }

  public completeWorktreeRemoval(projectId: string, workspaceId: string, repositoryId: string): Promise<WorkspaceRecord> {
    return this.transitionWorktree(projectId, workspaceId, repositoryId, 'DELETING', 'DELETED');
  }

  public restoreWorktreeActive(projectId: string, workspaceId: string, repositoryId: string): Promise<WorkspaceRecord> {
    return this.transitionWorktree(projectId, workspaceId, repositoryId, 'DELETING', 'ACTIVE');
  }

  private transitionWorktree(projectId: string, workspaceId: string, repositoryId: string, from: WorkspaceRecord['lifecycleState'], to: WorkspaceRecord['lifecycleState']): Promise<WorkspaceRecord> {
    return this.serializeMutation(async () => {
      assertUuid(projectId, 'projectId');
      assertUuid(workspaceId, 'workspaceId');
      assertUuid(repositoryId, 'repositoryId');
      const document = await this.readDocument();
      const index = document.workspaces.findIndex((candidate) => candidate.projectId === projectId && candidate.workspaceId === workspaceId);
      if (index < 0) throw new RuntimeError('WORKSPACE_NOT_FOUND', 'WORKTREE workspace was not found');
      const current = document.workspaces[index]!;
      if (current.role !== 'WORKTREE' || current.repositoryId !== repositoryId) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace is not the requested authorized WORKTREE');
      if (current.lifecycleState !== from) throw new RuntimeError('CAPABILITY_DENIED', `WORKTREE lifecycle must be ${from} before transition to ${to}`);
      const updated: WorkspaceRecord = { ...current, lifecycleState: to };
      const workspaces = [...document.workspaces];
      workspaces[index] = updated;
      await this.writeDocument({ ...document, workspaces });
      return updated;
    });
  }

  public async listArtifacts(projectId?: string): Promise<readonly ArtifactRecord[]> {
    const artifacts = (await this.readDocument()).artifacts;
    return projectId === undefined ? artifacts : artifacts.filter((artifact) => artifact.projectId === projectId);
  }

  public async getArtifact(projectId: string, artifactId: string): Promise<ArtifactRecord> {
    assertUuid(projectId, 'projectId');
    assertUuid(artifactId, 'artifactId');
    const artifact = (await this.readDocument()).artifacts.find((entry) => entry.artifactId === artifactId);
    if (artifact === undefined) throw new RuntimeError('ARTIFACT_NOT_FOUND', 'Artifact was not found');
    if (artifact.projectId !== projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Artifact does not belong to the selected project');
    const workspace = await this.getActiveWorkspace(projectId, artifact.workspaceId);
    if (!pathIsWithin(workspace.physicalRoot, artifact.physicalPath) || artifact.physicalPath === workspace.physicalRoot) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Artifact path is no longer contained by its workspace');
    }
    return artifact;
  }

  public registerArtifact(input: ArtifactRegistrationInput): Promise<ArtifactRecord> {
    return this.serializeMutation(async () => {
      assertUuid(input.projectId, 'projectId');
      assertUuid(input.workspaceId, 'workspaceId');
      if (input.producerJobId !== undefined && input.producerJobId !== null) assertUuid(input.producerJobId, 'producerJobId');
      if (input.producerActionId !== undefined && input.producerActionId !== null) assertUuid(input.producerActionId, 'producerActionId');
      const workspace = await this.getActiveWorkspace(input.projectId, input.workspaceId);
      if (!path.isAbsolute(input.physicalPath) || input.physicalPath.includes('\0') || !pathIsWithin(workspace.physicalRoot, input.physicalPath) || input.physicalPath === workspace.physicalRoot) {
        throw new RuntimeError('CAPABILITY_DENIED', 'Artifact path must identify a contained workspace entry');
      }
      if (!Number.isSafeInteger(input.size) || input.size < 0 || !/^[0-9a-f]{64}$/.test(input.sha256)) {
        throw new RuntimeError('INVALID_REQUEST', 'Artifact size/hash metadata is invalid');
      }
      const mime = boundedToken(input.mime, 'mime', 200);
      const artifactType = boundedToken(input.artifactType, 'artifactType', 120);
      const artifact: ArtifactRecord = {
        artifactId: randomUUID() as ArtifactId,
        physicalPath: input.physicalPath,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        producerJobId: input.producerJobId ?? null,
        producerActionId: input.producerActionId ?? null,
        mime,
        artifactType,
        size: input.size,
        sha256: input.sha256,
        sensitivity: input.sensitivity,
        createdAt: new Date().toISOString(),
        retentionPolicy: input.retentionPolicy,
      };
      const document = await this.readDocument();
      await this.writeDocument({ ...document, artifacts: [...document.artifacts, artifact] });
      return artifact;
    });
  }

  public releaseArtifact(projectId: string, artifactId: string): Promise<ArtifactRecord> {
    return this.serializeMutation(async () => {
      assertUuid(projectId, 'projectId');
      assertUuid(artifactId, 'artifactId');
      const document = await this.readDocument();
      const index = document.artifacts.findIndex((artifact) => artifact.artifactId === artifactId);
      if (index < 0) throw new RuntimeError('ARTIFACT_NOT_FOUND', 'Artifact was not found');
      const artifact = document.artifacts[index]!;
      if (artifact.projectId !== projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Artifact does not belong to the selected project');
      const artifacts = document.artifacts.filter((_, itemIndex) => itemIndex !== index);
      await this.writeDocument({ ...document, artifacts });
      return artifact;
    });
  }

  private async ensureScratchParent(projectId: string): Promise<string> {
    const scratchRoot = path.join(this.dataRoot, SCRATCH_ROOT);
    await mkdirVerifiedPrivateDirectory(scratchRoot, 'IRIS scratch root');
    const projectRoot = path.join(scratchRoot, projectId);
    await mkdirVerifiedPrivateDirectory(projectRoot, 'Project scratch root');
    return projectRoot;
  }

  private async readDocument(): Promise<ResourceDocument> {
    const filename = path.join(this.dataRoot, RESOURCE_FILE);
    const inspected = await inspectPrivateRegularFile(filename, 'vNext resource registry');
    if (inspected.state === 'missing') return emptyDocument();
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      const parsed = JSON.parse(inspected.content) as unknown;
      if (isResourceDocument(parsed)) return parsed;
      if (isLegacyResourceDocument(parsed)) {
        return { schemaVersion: 2, repositories: [], workspaces: parsed.workspaces, artifacts: parsed.artifacts };
      }
      throw new RuntimeError('PERSISTENCE_FAILURE', 'vNext resource registry is invalid');
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'vNext resource registry is invalid JSON', { cause: error });
    }
  }

  private async readDocumentSnapshot(): Promise<{ readonly document: ResourceDocument; readonly sha256: string; readonly content: string }> {
    const filename = path.join(this.dataRoot, RESOURCE_FILE);
    const inspected = await inspectPrivateRegularFile(filename, 'vNext resource registry');
    if (inspected.state === 'missing') throw new RuntimeError('PERSISTENCE_FAILURE', 'vNext resource registry is unavailable');
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    const parsed = JSON.parse(inspected.content) as unknown;
    if (!isResourceDocument(parsed)) throw new RuntimeError('PERSISTENCE_FAILURE', 'vNext resource registry is invalid');
    return { document: parsed, sha256: createHash('sha256').update(inspected.content).digest('hex'), content: inspected.content };
  }

  private async readTransactionDocument(): Promise<RegistryTransactionDocument> {
    const inspected = await inspectPrivateRegularFile(path.join(this.dataRoot, RECONCILIATION_FILE), 'registry reconciliation journal');
    if (inspected.state === 'missing') return { schemaVersion: 1, transactions: [] };
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    try {
      const parsed = JSON.parse(inspected.content) as unknown;
      if (!isRegistryTransactionDocument(parsed)) throw new Error('schema');
      return parsed;
    } catch (error) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry reconciliation journal is invalid', { cause: error });
    }
  }

  private async upsertTransaction(document: RegistryTransactionDocument, record: RegistryTransactionRecord): Promise<void> {
    const transactions = [...document.transactions];
    const index = transactions.findIndex((entry) => entry.requestId === record.requestId);
    if (index >= 0) transactions[index] = record;
    else {
      if (transactions.length >= 64) {
        const terminal = transactions.findIndex((entry) => entry.state === 'COMMITTED' || entry.state === 'FAILED');
        if (terminal < 0) throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry reconciliation journal is full of unresolved transactions');
        transactions.splice(terminal, 1);
      }
      transactions.push(record);
    }
    const write = () => writePrivateJson(path.join(this.dataRoot, RECONCILIATION_FILE), { schemaVersion: 1, transactions });
    if (this.safety === undefined) await write();
    else await this.safety.runMutation('resource-registry', write);
  }

  private async writeDocument(document: ResourceDocument): Promise<void> {
    if (!isResourceDocument(document)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to write invalid vNext resource registry');
    const write = () => writePrivateJson(path.join(this.dataRoot, RESOURCE_FILE), document);
    if (this.safety === undefined) await write();
    else await this.safety.runMutation('resource-registry', write);
  }

  private serializeMutation<T>(operation: () => Promise<T>, reconciliationRequestId?: string, lockPersistentState = true): Promise<T> {
    const guarded = async () => {
      if (!lockPersistentState) {
        await this.assertMutationLockForPlanning();
        await this.assertTransactionFence(reconciliationRequestId);
        return operation();
      }
      const release = await this.acquireMutationLock(reconciliationRequestId !== undefined);
      try {
        await this.assertTransactionFence(reconciliationRequestId);
        return await operation();
      } finally {
        await release();
      }
    };
    const result = this.mutationTail.then(guarded, guarded);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async assertMutationLockForPlanning(): Promise<void> {
    const inspected = await inspectPrivateRegularFile(path.join(this.dataRoot, MUTATION_LOCK_FILE), 'registry mutation lock');
    if (inspected.state === 'missing') return;
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    const owner = parseRegistryMutationLock(inspected.content);
    const state = observeProcessStart(owner.pid);
    if (state.state === 'indeterminate') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Registry mutation lock owner is ambiguous');
    if (state.state === 'live' && state.marker === owner.processStartMarker) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Another verified registry writer is active');
    }
  }

  private async assertTransactionFence(requestId: string | undefined): Promise<void> {
    const unresolved = (await this.readTransactionDocument()).transactions.filter((entry) =>
      entry.state === 'PREPARED' || entry.state === 'APPLYING' || entry.state === 'RECONCILIATION_REQUIRED');
    if (unresolved.length === 0) return;
    if (requestId !== undefined && unresolved.length === 1 && unresolved[0]!.requestId === requestId) return;
    throw new RuntimeError('CAPABILITY_DENIED', 'Registry has an unresolved reconciliation transaction');
  }

  private async acquireMutationLock(allowDeadOwnerReconciliation: boolean): Promise<() => Promise<void>> {
    const observed = observeProcessStart(process.pid);
    if (observed.state !== 'live') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Registry writer process identity is unavailable');
    const filename = path.join(this.dataRoot, MUTATION_LOCK_FILE);
    const lock: RegistryMutationLock = { schemaVersion: 1, lockId: randomUUID(), pid: process.pid,
      processStartMarker: observed.marker, createdAt: new Date().toISOString() };
    const content = `${JSON.stringify(lock, null, 2)}\n`;
    const temporary = `${filename}.${lock.lockId}.tmp`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let published = false;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await link(temporary, filename);
        published = true;
        await rm(temporary);
        await syncDirectory(this.dataRoot);
        return async () => {
          const current = await inspectPrivateRegularFile(filename, 'registry mutation lock');
          if (current.state !== 'ok' || current.content !== content) {
            throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry mutation lock ownership changed before release');
          }
          await rm(filename);
          await syncDirectory(this.dataRoot);
        };
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        if (published) {
          const current = await inspectPrivateRegularFile(filename, 'registry mutation lock');
          if (current.state === 'ok' && current.content === content) {
            await rm(filename);
            await syncDirectory(this.dataRoot);
          }
          throw error;
        }
        if (!isNodeErrorCode(error, 'EEXIST')) throw error;
        const current = await inspectPrivateRegularFile(filename, 'registry mutation lock');
        if (current.state !== 'ok') throw new RuntimeError('PERSISTENCE_FAILURE', current.state === 'invalid' ? current.reason : 'Registry mutation lock disappeared');
        const owner = parseRegistryMutationLock(current.content);
        const ownerState = observeProcessStart(owner.pid);
        if (ownerState.state === 'indeterminate') throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Registry mutation lock owner is ambiguous');
        if (ownerState.state === 'live' && ownerState.marker === owner.processStartMarker) {
          throw new RuntimeError('CAPABILITY_DENIED', 'Another verified registry writer is active');
        }
        if (!allowDeadOwnerReconciliation) throw new RuntimeError('CAPABILITY_DENIED', 'Registry mutation lock requires reconciliation');
        const unchanged = await inspectPrivateRegularFile(filename, 'registry mutation lock');
        if (unchanged.state !== 'ok' || unchanged.content !== current.content) {
          throw new RuntimeError('AUTHORITY_INDETERMINATE', 'Registry mutation lock changed during reconciliation');
        }
        await rm(filename);
        await syncDirectory(this.dataRoot);
      }
    }
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry mutation lock could not be acquired');
  }
}

export function primaryWorkspaceId(projectId: string): WorkspaceId {
  assertUuid(projectId, 'projectId');
  const digest = createHash('sha256').update(`iris-primary-workspace:${projectId}`).digest('hex').slice(0, 32).split('');
  digest[12] = '5';
  digest[16] = ['8', '9', 'a', 'b'][Number.parseInt(digest[16]!, 16) % 4]!;
  return `${digest.slice(0, 8).join('')}-${digest.slice(8, 12).join('')}-${digest.slice(12, 16).join('')}-${digest.slice(16, 20).join('')}-${digest.slice(20).join('')}` as WorkspaceId;
}

function primaryWorkspace(projectId: string, physicalRoot: string, repositoryId: RepositoryId | null = null): WorkspaceRecord {
  return {
    workspaceId: primaryWorkspaceId(projectId),
    projectId,
    repositoryId,
    physicalRoot,
    role: 'PRIMARY',
    authorizationSource: 'PROJECT_REGISTRATION',
    createdByAction: null,
    lifecycleState: 'ACTIVE',
    createdAt: PRIMARY_CREATED_AT,
  };
}

async function verifyWorkspacePhysicalIdentity(workspace: WorkspaceRecord): Promise<void> {
  let physical: string;
  try {
    const metadata = await lstat(workspace.physicalRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('workspace root is not a physical directory');
    physical = await realpath(workspace.physicalRoot);
  } catch (error) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Workspace physical root is unavailable', { cause: error });
  }
  if (physical !== workspace.physicalRoot) throw new RuntimeError('CAPABILITY_DENIED', 'Workspace root changed through a filesystem alias');
}

async function verifyPhysicalDirectory(directory: string, label: string): Promise<string> {
  if (!path.isAbsolute(directory) || directory.includes('\0') || path.resolve(directory) !== directory) {
    throw new RuntimeError('CAPABILITY_DENIED', `${label} must be a normalized absolute path`);
  }
  const metadata = await lstat(directory).catch((error: unknown) => {
    throw new RuntimeError('CAPABILITY_DENIED', `${label} is unavailable`, { cause: error });
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new RuntimeError('CAPABILITY_DENIED', `${label} must be a physical directory`);
  const physical = await realpath(directory).catch((error: unknown) => {
    throw new RuntimeError('CAPABILITY_DENIED', `${label} physical identity cannot be resolved`, { cause: error });
  });
  if (physical !== directory) throw new RuntimeError('CAPABILITY_DENIED', `${label} changed through a filesystem alias`);
  return physical;
}

async function verifyRepositoryDirectoryIdentity(commonGitDir: string, device: string, inode: string): Promise<void> {
  await verifyPhysicalDirectory(commonGitDir, 'Repository common Git directory');
  const metadata = await lstat(commonGitDir, { bigint: true });
  if (metadata.dev.toString() !== device || metadata.ino.toString() !== inode) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Repository common Git directory physical identity changed');
  }
}

function sameRepositoryIdentity(existing: RepositoryRecord, input: RepositoryRegistrationInput): boolean {
  return existing.repositoryId === input.repositoryId
    && existing.projectId === input.projectId
    && existing.primaryWorkspaceId === input.primaryWorkspaceId
    && existing.commonGitDir === input.commonGitDir
    && existing.commonGitDirDevice === input.commonGitDirDevice
    && existing.commonGitDirInode === input.commonGitDirInode;
}

async function mkdirVerifiedPrivateDirectory(directory: string, label: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} could not be created`, { cause: error });
  }
  const physical = await realpath(directory).catch((error: unknown) => {
    throw new RuntimeError('PERSISTENCE_FAILURE', `${label} cannot be resolved physically`, { cause: error });
  });
  const problem = await privateDirectoryProblem(directory, label);
  if (physical !== directory || problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem ?? `${label} changed through an alias`);
}

async function removeExactEmptyDirectory(directory: string): Promise<void> {
  const physical = await realpath(directory);
  if (physical !== directory) throw new RuntimeError('CAPABILITY_DENIED', 'Refusing to clean up an aliased scratch workspace');
  await rmdir(directory);
}

function emptyDocument(): ResourceDocument {
  return { schemaVersion: 2, repositories: [], workspaces: [], artifacts: [] };
}

function documentSha256(document: ResourceDocument): string {
  return createHash('sha256').update(`${JSON.stringify(document, null, 2)}\n`).digest('hex');
}

function registryRequestSha256(input: RepositoryReconciliationInput): string {
  return createHash('sha256').update(JSON.stringify({
    projectId: input.projectId,
    previousRepositoryId: input.previousRepositoryId,
    previousDevice: input.previousDevice,
    expectedRepositoryId: input.expectedRepositoryId,
    expectedHead: input.expectedHead,
    expectedTree: input.expectedTree,
    expectedWorktrees: input.expectedWorktrees,
    registryTransaction: input.registryTransaction ?? null,
  })).digest('hex');
}

async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Atomic private JSON publication failed', { cause: error });
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function parseRegistryMutationLock(content: string): RegistryMutationLock {
  let value: unknown;
  try { value = JSON.parse(content) as unknown; }
  catch (error) { throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry mutation lock is invalid JSON', { cause: error }); }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isUuid(value.lockId)
    || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1
    || typeof value.processStartMarker !== 'string' || !/^[1-9]\d*:\d{6}$/.test(value.processStartMarker)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry mutation lock is invalid');
  }
  return value as unknown as RegistryMutationLock;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

async function writePrivateBeforeImage(dataRoot: string, record: RegistryTransactionRecord, content: string): Promise<void> {
  const filename = path.join(dataRoot, record.beforeImageFile);
  try {
    const inspected = await inspectPrivateRegularFile(filename, 'registry reconciliation before-image');
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    if (inspected.state !== 'missing') {
      if (createHash('sha256').update(inspected.content).digest('hex') !== record.beforeSha256) {
        throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry reconciliation before-image changed');
      }
      return;
    }
    if (createHash('sha256').update(content).digest('hex') !== record.beforeSha256) {
      throw new RuntimeError('CAPABILITY_DENIED', 'Registry before-image bytes do not match approved SHA-256');
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(filename, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(dataRoot);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry reconciliation before-image could not be preserved', { cause: error });
  }
}

async function readPrivateBeforeImage(dataRoot: string, record: RegistryTransactionRecord): Promise<string> {
  const expected = `registry-reconciliation-${record.requestId}.before.json`;
  if (record.beforeImageFile !== expected) throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry reconciliation before-image path is invalid');
  const inspected = await inspectPrivateRegularFile(path.join(dataRoot, expected), 'registry reconciliation before-image');
  if (inspected.state !== 'ok') {
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry reconciliation before-image is missing');
  }
  if (createHash('sha256').update(inspected.content).digest('hex') !== record.beforeSha256) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Registry reconciliation before-image hash is invalid');
  }
  return inspected.content;
}

async function assertMissing(target: string, message: string): Promise<void> {
  try {
    await lstat(target);
    throw new RuntimeError('CAPABILITY_DENIED', message);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new RuntimeError('CAPABILITY_DENIED', 'Stale workspace root identity is unavailable', { cause: error });
  }
}

function validateRegistryTransactionInput(input: RegistryTransactionInput): void {
  assertUuid(input.requestId, 'registryTransaction.requestId');
  if (!/^[0-9a-f]{64}$/.test(input.expectedBeforeSha256)) throw new RuntimeError('INVALID_REQUEST', 'Registry before-image SHA-256 is invalid');
  if (!Array.isArray(input.staleWorkspaceIds) || input.staleWorkspaceIds.length === 0 || input.staleWorkspaceIds.length > 128
    || new Set(input.staleWorkspaceIds).size !== input.staleWorkspaceIds.length) {
    throw new RuntimeError('INVALID_REQUEST', 'Stale workspace IDs must be a bounded unique non-empty list');
  }
  for (const workspaceId of input.staleWorkspaceIds) assertUuid(workspaceId, 'registryTransaction.staleWorkspaceIds');
  if (!Array.isArray(input.existingWorktrees) || input.existingWorktrees.length > 128) {
    throw new RuntimeError('INVALID_REQUEST', 'Existing worktree expectations must be bounded');
  }
  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const entry of input.existingWorktrees) {
    assertUuid(entry.workspaceId, 'registryTransaction.existingWorktrees.workspaceId');
    assertGitObjectId(entry.head, 'registryTransaction.existingWorktrees.head');
    assertGitObjectId(entry.tree, 'registryTransaction.existingWorktrees.tree');
    if (ids.has(entry.workspaceId) || roots.has(entry.physicalRoot)) throw new RuntimeError('INVALID_REQUEST', 'Existing worktree expectations contain duplicates');
    ids.add(entry.workspaceId); roots.add(entry.physicalRoot);
    if (!path.isAbsolute(entry.physicalRoot) || path.resolve(entry.physicalRoot) !== entry.physicalRoot || entry.physicalRoot.includes('\0')
      || !/^[0-9]+$/.test(entry.rootDevice) || !/^[0-9]+$/.test(entry.rootInode)
      || !/^[0-9]+$/.test(entry.gitAdminDevice) || !/^[0-9]+$/.test(entry.gitAdminInode)
      || (entry.disposition !== 'PRESERVE_UNTIL_RECOVERY_HANDOFF' && entry.disposition !== 'RETIRE_AFTER_EVIDENCE')
      || !Number.isFinite(Date.parse(entry.authorizedAt))
      || entry.ref.length === 0 || entry.ref.length > 1024 || /[\0\r\n]/.test(entry.ref)) {
      throw new RuntimeError('INVALID_REQUEST', 'Existing worktree expectation is invalid');
    }
  }
}

function isRegistryTransactionDocument(value: unknown): value is RegistryTransactionDocument {
  return isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.transactions)
    && value.transactions.length <= 64 && value.transactions.every((entry) => isRecord(entry)
      && isUuid(entry.requestId)
      && (entry.state === 'PREPARED' || entry.state === 'APPLYING' || entry.state === 'COMMITTED'
        || entry.state === 'FAILED' || entry.state === 'RECONCILIATION_REQUIRED')
      && typeof entry.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(entry.fingerprint)
      && typeof entry.requestSha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.requestSha256)
      && typeof entry.beforeImageFile === 'string' && entry.beforeImageFile === `registry-reconciliation-${entry.requestId}.before.json`
      && typeof entry.beforeSha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.beforeSha256)
      && typeof entry.applyingSha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.applyingSha256)
      && typeof entry.afterSha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.afterSha256)
      && Array.isArray(entry.staleWorkspaceIds) && entry.staleWorkspaceIds.every(isUuid)
      && Array.isArray(entry.importedWorkspaceIds) && entry.importedWorkspaceIds.every(isUuid)
      && Array.isArray(entry.existingWorktreeDispositions) && entry.existingWorktreeDispositions.every((disposition) => isRecord(disposition)
        && isUuid(disposition.workspaceId)
        && (disposition.disposition === 'PRESERVE_UNTIL_RECOVERY_HANDOFF' || disposition.disposition === 'RETIRE_AFTER_EVIDENCE'))
      && typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt))
      && typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt))
      && (entry.errorCode === null || typeof entry.errorCode === 'string'))
    && new Set(value.transactions.map((entry) => isRecord(entry) ? entry.requestId : null)).size === value.transactions.length;
}

function isResourceDocument(value: unknown): value is ResourceDocument {
  if (!isRecord(value) || value.schemaVersion !== 2 || !Array.isArray(value.repositories) || !Array.isArray(value.workspaces) || !Array.isArray(value.artifacts)) return false;
  if (!value.repositories.every(isRepositoryRecord) || !value.workspaces.every(isWorkspaceRecord) || !value.artifacts.every(isArtifactRecord)) return false;
  const repositoryIds = new Set(value.repositories.map((repository) => repository.repositoryId));
  const repositoryPrimaryIds = new Set(value.repositories.map((repository) => `${repository.projectId}:${repository.primaryWorkspaceId}`));
  const workspaceIds = new Set(value.workspaces.map((workspace) => workspace.workspaceId));
  const workspaceRoots = new Set(value.workspaces.map((workspace) => workspace.physicalRoot));
  const artifactIds = new Set(value.artifacts.map((artifact) => artifact.artifactId));
  return repositoryIds.size === value.repositories.length
    && repositoryPrimaryIds.size === value.repositories.length
    && workspaceIds.size === value.workspaces.length
    && workspaceRoots.size === value.workspaces.length
    && artifactIds.size === value.artifacts.length;
}

function isLegacyResourceDocument(value: unknown): value is LegacyResourceDocument {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.workspaces) || !Array.isArray(value.artifacts)) return false;
  return value.workspaces.every(isWorkspaceRecord) && value.artifacts.every(isArtifactRecord);
}

function isRepositoryRecord(value: unknown): value is RepositoryRecord {
  return isRecord(value)
    && isUuid(value.repositoryId)
    && isUuid(value.projectId)
    && isUuid(value.primaryWorkspaceId)
    && typeof value.commonGitDir === 'string'
    && path.isAbsolute(value.commonGitDir)
    && !value.commonGitDir.includes('\0')
    && path.resolve(value.commonGitDir) === value.commonGitDir
    && typeof value.commonGitDirDevice === 'string'
    && /^[0-9]+$/.test(value.commonGitDirDevice)
    && typeof value.commonGitDirInode === 'string'
    && /^[0-9]+$/.test(value.commonGitDirInode)
    && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt));
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  return isRecord(value)
    && isUuid(value.workspaceId)
    && isUuid(value.projectId)
    && (value.repositoryId === null || isUuid(value.repositoryId))
    && typeof value.physicalRoot === 'string'
    && path.isAbsolute(value.physicalRoot)
    && !value.physicalRoot.includes('\0')
    && path.resolve(value.physicalRoot) === value.physicalRoot
    && (value.role === 'PRIMARY' || value.role === 'WORKTREE' || value.role === 'SCRATCH')
    && (value.authorizationSource === 'PROJECT_REGISTRATION' || value.authorizationSource === 'GIT_WORKTREE_ADD' || value.authorizationSource === 'OWNER_APPROVAL' || value.authorizationSource === 'SYSTEM_SCRATCH')
    && (value.createdByAction === null || isUuid(value.createdByAction))
    && (value.lifecycleState === 'ACTIVE' || value.lifecycleState === 'REVOKING' || value.lifecycleState === 'REVOKED' || value.lifecycleState === 'DELETING' || value.lifecycleState === 'DELETED')
    && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt));
}

function isArtifactRecord(value: unknown): value is ArtifactRecord {
  return isRecord(value)
    && isUuid(value.artifactId)
    && isUuid(value.projectId)
    && isUuid(value.workspaceId)
    && (value.producerJobId === null || isUuid(value.producerJobId))
    && (value.producerActionId === null || isUuid(value.producerActionId))
    && typeof value.physicalPath === 'string'
    && path.isAbsolute(value.physicalPath)
    && !value.physicalPath.includes('\0')
    && path.resolve(value.physicalPath) === value.physicalPath
    && typeof value.mime === 'string'
    && value.mime.length > 0
    && value.mime.length <= 200
    && typeof value.artifactType === 'string'
    && value.artifactType.length > 0
    && value.artifactType.length <= 120
    && Number.isSafeInteger(value.size)
    && (value.size as number) >= 0
    && typeof value.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(value.sha256)
    && (value.sensitivity === 'PUBLIC' || value.sensitivity === 'INTERNAL' || value.sensitivity === 'SENSITIVE' || value.sensitivity === 'RESTRICTED')
    && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt))
    && (value.retentionPolicy === 'EPHEMERAL' || value.retentionPolicy === 'SESSION' || value.retentionPolicy === 'MISSION' || value.retentionPolicy === 'PROJECT' || value.retentionPolicy === 'MANUAL');
}

function boundedToken(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || normalized.includes('\0')) throw new RuntimeError('INVALID_REQUEST', `${label} is invalid`);
  return normalized;
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) throw new RuntimeError('INVALID_REQUEST', `${label} is invalid`);
}

function assertGitObjectId(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new RuntimeError('INVALID_REQUEST', `${label} must be a lowercase full Git object ID`);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function pathsOverlap(left: string, right: string): boolean {
  return pathIsWithin(left, right) || pathIsWithin(right, left);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
