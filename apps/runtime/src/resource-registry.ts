import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rmdir, rm } from 'node:fs/promises';
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
import type { RuntimeState } from './state.js';

const RESOURCE_FILE = 'vnext-resources.json';
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

  private async writeDocument(document: ResourceDocument): Promise<void> {
    if (!isResourceDocument(document)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Refusing to write invalid vNext resource registry');
    const filename = path.join(this.dataRoot, RESOURCE_FILE);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, filename);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Atomic vNext resource registry publication failed', { cause: error });
    }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
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

async function verifyPhysicalDirectory(directory: string, label: string): Promise<void> {
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

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
