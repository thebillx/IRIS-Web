import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { RuntimeError, type RepositoryId, type WorkspaceId } from '@iris/domain';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^[0-9]+$/;

export interface LogicalRepositoryAuthority {
  readonly projectId: string;
  readonly repositoryId: RepositoryId;
  readonly primaryWorkspaceId: WorkspaceId;
  readonly commonGitDir: string;
  readonly commonGitDirDevice: string;
  readonly commonGitDirInode: string;
}

export interface PhysicalRepositoryEvidence {
  readonly projectId: string;
  readonly primaryWorkspaceId: WorkspaceId;
  readonly commonGitDir: string;
  readonly commonGitDirDevice: string;
  readonly commonGitDirInode: string;
  readonly physicalRoot: string;
  readonly physicalRootDevice: string;
  readonly physicalRootInode: string;
  readonly head: string;
  readonly tree: string;
  readonly ref: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly objectIntegritySha256: string;
}

export interface PhysicalRepositoryObservation {
  readonly schemaVersion: 1;
  readonly observationId: string;
  readonly authority: 'OBSERVATION_ONLY';
  readonly projectId: string;
  readonly logicalRepositoryId: RepositoryId;
  readonly primaryWorkspaceId: WorkspaceId;
  readonly commonGitDir: string;
  readonly registeredCommonGitDirDevice: string;
  readonly registeredCommonGitDirInode: string;
  readonly observedCommonGitDirDevice: string;
  readonly observedCommonGitDirInode: string;
  readonly physicalRoot: string;
  readonly physicalRootDevice: string;
  readonly physicalRootInode: string;
  readonly head: string;
  readonly tree: string;
  readonly ref: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly objectIntegritySha256: string;
  readonly observedAt: string;
  readonly provenance: 'GOVERNED_GIT_INSPECTION';
  readonly evidenceSha256: string;
}

/**
 * Records physical continuity without changing logical workspace or repository authority.
 * The returned value is evidence only; it is deliberately not a repository binding.
 */
export function createPhysicalRepositoryObservation(
  logical: LogicalRepositoryAuthority,
  physical: PhysicalRepositoryEvidence,
  observedAt = new Date().toISOString(),
): PhysicalRepositoryObservation {
  validateAuthority(logical);
  validatePhysicalEvidence(physical);
  if (logical.projectId !== physical.projectId || logical.primaryWorkspaceId !== physical.primaryWorkspaceId
    || logical.commonGitDir !== physical.commonGitDir || logical.commonGitDirInode !== physical.commonGitDirInode) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Physical observation does not match the existing logical repository authority');
  }
  if (!Number.isFinite(Date.parse(observedAt))) throw new RuntimeError('INVALID_REQUEST', 'Observation timestamp is invalid');

  const evidence = {
    projectId: logical.projectId,
    logicalRepositoryId: logical.repositoryId,
    primaryWorkspaceId: logical.primaryWorkspaceId,
    commonGitDir: physical.commonGitDir,
    registeredCommonGitDirDevice: logical.commonGitDirDevice,
    registeredCommonGitDirInode: logical.commonGitDirInode,
    observedCommonGitDirDevice: physical.commonGitDirDevice,
    observedCommonGitDirInode: physical.commonGitDirInode,
    physicalRoot: physical.physicalRoot,
    physicalRootDevice: physical.physicalRootDevice,
    physicalRootInode: physical.physicalRootInode,
    head: physical.head,
    tree: physical.tree,
    ref: physical.ref,
    sourceSha: physical.sourceSha,
    sourceTree: physical.sourceTree,
    objectIntegritySha256: physical.objectIntegritySha256,
    observedAt,
  };
  return {
    schemaVersion: 1,
    observationId: randomUUID(),
    authority: 'OBSERVATION_ONLY',
    ...evidence,
    provenance: 'GOVERNED_GIT_INSPECTION',
    evidenceSha256: sha256(JSON.stringify(evidence)),
  };
}

export function validatePhysicalRepositoryObservation(value: unknown): asserts value is PhysicalRepositoryObservation {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.authority !== 'OBSERVATION_ONLY'
    || value.provenance !== 'GOVERNED_GIT_INSPECTION') {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Physical repository observation is invalid');
  }
  for (const field of ['observationId', 'projectId', 'logicalRepositoryId', 'primaryWorkspaceId'] as const) {
    if (typeof value[field] !== 'string' || !UUID.test(value[field])) throw new RuntimeError('PERSISTENCE_FAILURE', `Observation ${field} is invalid`);
  }
  for (const field of ['commonGitDir', 'physicalRoot'] as const) {
    if (typeof value[field] !== 'string') throw new RuntimeError('PERSISTENCE_FAILURE', `Observation ${field} is invalid`);
    assertAbsolute(value[field], `Observation ${field}`);
  }
  for (const field of ['registeredCommonGitDirDevice', 'registeredCommonGitDirInode', 'observedCommonGitDirDevice',
    'observedCommonGitDirInode', 'physicalRootDevice', 'physicalRootInode'] as const) {
    if (typeof value[field] !== 'string' || !DECIMAL.test(value[field])) throw new RuntimeError('PERSISTENCE_FAILURE', `Observation ${field} is invalid`);
  }
  for (const field of ['head', 'tree', 'sourceSha', 'sourceTree'] as const) {
    if (typeof value[field] !== 'string' || !SHA1.test(value[field])) throw new RuntimeError('PERSISTENCE_FAILURE', `Observation ${field} is invalid`);
  }
  if (typeof value.objectIntegritySha256 !== 'string' || !SHA256.test(value.objectIntegritySha256)
    || typeof value.evidenceSha256 !== 'string' || !SHA256.test(value.evidenceSha256)
    || typeof value.ref !== 'string' || value.ref.length === 0 || value.ref.length > 1024
    || /[\0\r\n]/.test(value.ref) || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Physical repository observation evidence is invalid');
  }
  const evidenceSha256 = value.evidenceSha256;
  const evidence = {
    projectId: value.projectId,
    logicalRepositoryId: value.logicalRepositoryId,
    primaryWorkspaceId: value.primaryWorkspaceId,
    commonGitDir: value.commonGitDir,
    registeredCommonGitDirDevice: value.registeredCommonGitDirDevice,
    registeredCommonGitDirInode: value.registeredCommonGitDirInode,
    observedCommonGitDirDevice: value.observedCommonGitDirDevice,
    observedCommonGitDirInode: value.observedCommonGitDirInode,
    physicalRoot: value.physicalRoot,
    physicalRootDevice: value.physicalRootDevice,
    physicalRootInode: value.physicalRootInode,
    head: value.head,
    tree: value.tree,
    ref: value.ref,
    sourceSha: value.sourceSha,
    sourceTree: value.sourceTree,
    objectIntegritySha256: value.objectIntegritySha256,
    observedAt: value.observedAt,
  };
  if (typeof evidenceSha256 !== 'string') throw new RuntimeError('PERSISTENCE_FAILURE', 'Observation evidence hash is invalid');
  if (sha256(JSON.stringify(evidence)) !== evidenceSha256) throw new RuntimeError('PERSISTENCE_FAILURE', 'Physical repository observation evidence hash does not match');
}

function validateAuthority(value: LogicalRepositoryAuthority): void {
  if (!UUID.test(value.projectId) || !UUID.test(value.repositoryId) || !UUID.test(value.primaryWorkspaceId)) {
    throw new RuntimeError('INVALID_REQUEST', 'Logical repository authority identity is invalid');
  }
  assertAbsolute(value.commonGitDir, 'Logical common Git directory');
  for (const field of ['commonGitDirDevice', 'commonGitDirInode'] as const) {
    if (!DECIMAL.test(value[field])) throw new RuntimeError('INVALID_REQUEST', `Logical ${field} is invalid`);
  }
}

function validatePhysicalEvidence(value: PhysicalRepositoryEvidence): void {
  if (!UUID.test(value.projectId) || !UUID.test(value.primaryWorkspaceId)) throw new RuntimeError('INVALID_REQUEST', 'Physical repository identity is invalid');
  assertAbsolute(value.commonGitDir, 'Physical common Git directory');
  assertAbsolute(value.physicalRoot, 'Physical repository root');
  for (const field of ['commonGitDirDevice', 'commonGitDirInode', 'physicalRootDevice', 'physicalRootInode'] as const) {
    if (!DECIMAL.test(value[field])) throw new RuntimeError('INVALID_REQUEST', `Physical ${field} is invalid`);
  }
  for (const field of ['head', 'tree', 'sourceSha', 'sourceTree'] as const) {
    if (!SHA1.test(value[field])) throw new RuntimeError('INVALID_REQUEST', `Physical ${field} is invalid`);
  }
  if (!SHA256.test(value.objectIntegritySha256) || typeof value.ref !== 'string' || value.ref.length === 0
    || value.ref.length > 1024 || /[\0\r\n]/.test(value.ref)) {
    throw new RuntimeError('INVALID_REQUEST', 'Physical repository evidence is invalid');
  }
}

function assertAbsolute(value: string, label: string): void {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes('\0')) throw new RuntimeError('INVALID_REQUEST', `${label} must be a normalized absolute path`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
