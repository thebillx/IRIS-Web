import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RuntimeError } from '@iris/domain';
import { createPhysicalRepositoryObservation, validatePhysicalRepositoryObservation, type LogicalRepositoryAuthority, type PhysicalRepositoryEvidence } from './repository-physical-observation.js';

const authority = (): LogicalRepositoryAuthority => ({
  projectId: randomUUID(), repositoryId: randomUUID() as LogicalRepositoryAuthority['repositoryId'],
  primaryWorkspaceId: randomUUID() as LogicalRepositoryAuthority['primaryWorkspaceId'],
  commonGitDir: '/tmp/iris-repository/.git', commonGitDirDevice: '16777234', commonGitDirInode: '1234',
});

const evidence = (logical: LogicalRepositoryAuthority): PhysicalRepositoryEvidence => ({
  projectId: logical.projectId, primaryWorkspaceId: logical.primaryWorkspaceId, commonGitDir: logical.commonGitDir,
  commonGitDirDevice: '16777230', commonGitDirInode: logical.commonGitDirInode,
  physicalRoot: '/tmp/iris-repository', physicalRootDevice: '16777230', physicalRootInode: '5678',
  head: 'a'.repeat(40), tree: 'b'.repeat(40), ref: 'refs/heads/main', sourceSha: 'c'.repeat(40), sourceTree: 'd'.repeat(40),
  objectIntegritySha256: 'e'.repeat(64),
});

describe('non-authoritative physical repository observations', () => {
  it('records device drift without changing logical authority or granting capabilities', () => {
    const logical = authority();
    const observation = createPhysicalRepositoryObservation(logical, evidence(logical), '2026-10-17T00:00:00.000Z');
    expect(observation).toMatchObject({ authority: 'OBSERVATION_ONLY', projectId: logical.projectId,
      logicalRepositoryId: logical.repositoryId, registeredCommonGitDirDevice: '16777234', observedCommonGitDirDevice: '16777230' });
    expect(observation).not.toHaveProperty('workspaceIds');
    expect(observation).not.toHaveProperty('capability');
    validatePhysicalRepositoryObservation(observation);
  });

  it.each([
    ['foreign project', (logical: LogicalRepositoryAuthority, physical: PhysicalRepositoryEvidence) => ({ ...physical, projectId: randomUUID() })],
    ['foreign common directory', (logical: LogicalRepositoryAuthority, physical: PhysicalRepositoryEvidence) => ({ ...physical, commonGitDir: '/tmp/foreign/.git' })],
    ['inode mismatch', (logical: LogicalRepositoryAuthority, physical: PhysicalRepositoryEvidence) => ({ ...physical, commonGitDirInode: '9999' })],
    ['invalid object evidence', (logical: LogicalRepositoryAuthority, physical: PhysicalRepositoryEvidence) => ({ ...physical, objectIntegritySha256: 'bad' })],
  ])('rejects %s without producing an authority record', (_name, mutate) => {
    const logical = authority();
    expect(() => createPhysicalRepositoryObservation(logical, mutate(logical, evidence(logical)))).toThrow(RuntimeError);
  });

  it('rejects tampered persisted evidence', () => {
    const logical = authority();
    const observation = createPhysicalRepositoryObservation(logical, evidence(logical));
    expect(() => validatePhysicalRepositoryObservation({ ...observation, observedCommonGitDirDevice: '1' })).toThrow('hash does not match');
  });
});
