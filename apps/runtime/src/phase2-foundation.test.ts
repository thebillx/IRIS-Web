import { createHash, randomUUID } from 'node:crypto';
import { access, link, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceRecord } from '@iris/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionAuditStore } from './audit.js';
import { deriveCapabilityEffects } from './capability-effects.js';
import { CapabilityService, type CapabilityOutcome } from './capability-service.js';
import { executePhase2GroupedTool } from './mcp-phase2.js';
import { PermissionSettingsStore } from './permission-store.js';
import { PermissionPolicyEngine } from './permissions.js';
import { FoundationStateStore } from './persistence.js';
import { ProjectValidationJobManager } from './project-test.js';
import { primaryWorkspaceId, VNextResourceRegistry } from './resource-registry.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
const LARGE_SPARSE_BYTES = 256 * 1024 * 1024;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('IRIS vNext Phase 2 workspace, filesystem, and artifact foundation', () => {
  it('AC-SEC-007 migrates PRIMARY deterministically and keeps SCRATCH parent/sibling/other-project/inactive scope denied', async () => {
    const fixture = await serviceFixture();
    const primaryA = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    const primaryAAgain = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    const primaryB = await fixture.resources.primaryWorkspace(fixture.projectB.id);

    expect(primaryA.workspaceId).toBe(primaryWorkspaceId(fixture.projectA.id));
    expect(primaryAAgain.workspaceId).toBe(primaryA.workspaceId);
    expect(primaryA).toMatchObject({
      projectId: fixture.projectA.id,
      physicalRoot: fixture.projectARoot,
      role: 'PRIMARY',
      authorizationSource: 'PROJECT_REGISTRATION',
      lifecycleState: 'ACTIVE',
    });
    expect(primaryB.workspaceId).not.toBe(primaryA.workspaceId);

    const scratch = executedValue<WorkspaceRecord>(await fixture.service.execute({
      capabilityId: 'workspace.create_scratch',
      clientId: fixture.sessionA.clientId,
      sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id,
      expectedEffects: ['WRITE'],
    }));
    expect(scratch).toMatchObject({ projectId: fixture.projectA.id, role: 'SCRATCH', lifecycleState: 'ACTIVE' });
    expect(scratch.physicalRoot).toContain(path.join(fixture.dataRoot, 'scratch', fixture.projectA.id));
    expect(scratch.physicalRoot).not.toBe(path.dirname(scratch.physicalRoot));

    const inside = await fixture.service.execute({
      capabilityId: 'fs.write', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: scratch.workspaceId,
      path: 'inside.md', mode: 'CREATE', content: '# safe\n', expectedEffects: ['WRITE'],
    });
    expect(inside.status).toBe('executed');
    await expect(readFile(path.join(scratch.physicalRoot, 'inside.md'), 'utf8')).resolves.toBe('# safe\n');

    await expect(fixture.service.execute({
      capabilityId: 'fs.read', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: scratch.workspaceId,
      path: '../sibling.md', mode: 'TEXT', expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(fixture.service.execute({
      capabilityId: 'fs.read', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: scratch.workspaceId,
      path: path.join(path.dirname(scratch.physicalRoot), 'outside.md'), mode: 'TEXT', expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(fixture.service.execute({
      capabilityId: 'fs.stat', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primaryB.workspaceId, path: '.', expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

    const revoked = executedValue<WorkspaceRecord>(await fixture.service.execute({
      capabilityId: 'workspace.revoke_scratch', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: scratch.workspaceId, expectedEffects: ['WRITE', 'DESTRUCTIVE'],
    }));
    expect(revoked.lifecycleState).toBe('REVOKED');
    await expect(fixture.service.execute({
      capabilityId: 'fs.stat', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: scratch.workspaceId, path: 'inside.md', expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('AC-BBL-001 + AC-RDJ-003 recursively inventories a synthetic Obsidian vault with bounded pagination and never follows symlink escape', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    const vault = path.join(fixture.projectARoot, 'vault');
    const outside = path.join(fixture.sourceRoot, 'outside-vault');
    await mkdir(path.join(vault, '.obsidian', 'plugins'), { recursive: true });
    await mkdir(path.join(vault, 'research', 'deep'), { recursive: true });
    await mkdir(path.join(vault, 'node_modules', 'ignored'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(vault, '.obsidian', 'app.json'), '{"theme":"dark"}\n');
    await writeFile(path.join(vault, '.obsidian', 'plugins', 'manifest.json'), '{}\n');
    await writeFile(path.join(vault, 'index.md'), '# index\n');
    await writeFile(path.join(vault, 'research', 'note.md'), '# note\n');
    await writeFile(path.join(vault, 'research', 'deep', 'deep-note.md'), '# deep\n');
    await writeFile(path.join(vault, 'node_modules', 'ignored', 'package.txt'), 'ignore me\n');
    await writeFile(path.join(outside, 'secret.md'), 'outside\n');
    await symlink(outside, path.join(vault, 'escape'));

    const collected: Array<{ relativePath: string; type: string; symlink: boolean }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const outcome = await fixture.service.execute({
        capabilityId: 'fs.list', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
        projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'vault',
        recursive: true, maxDepth: 6, maxEntries: 2, includeHidden: true, ignoreMode: 'PROJECT',
        ...(cursor === undefined ? {} : { cursor }), expectedEffects: ['READ'],
      });
      const value = executedValue<{ entries: typeof collected; nextCursor: string | null; truncated: boolean }>(outcome);
      collected.push(...value.entries);
      if (value.nextCursor === null) break;
      cursor = value.nextCursor;
    }

    expect(collected.some((entry) => entry.relativePath === 'vault/.obsidian/app.json')).toBe(true);
    expect(collected.some((entry) => entry.relativePath === 'vault/.obsidian/plugins/manifest.json')).toBe(true);
    expect(collected.some((entry) => entry.relativePath === 'vault/escape' && entry.type === 'symlink' && entry.symlink)).toBe(true);
    expect(collected.some((entry) => entry.relativePath.startsWith('vault/escape/'))).toBe(false);
    expect(collected.some((entry) => entry.relativePath.includes('node_modules'))).toBe(false);
    expect(new Set(collected.map((entry) => entry.relativePath)).size).toBe(collected.length);

    const hiddenOff = executedValue<{ entries: Array<{ relativePath: string }> }>(await fixture.service.execute({
      capabilityId: 'fs.list', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'vault',
      recursive: true, maxDepth: 6, maxEntries: 200, includeHidden: false, ignoreMode: 'PROJECT', expectedEffects: ['READ'],
    }));
    expect(hiddenOff.entries.some((entry) => entry.relativePath.includes('.obsidian'))).toBe(false);

    const shallow = executedValue<{ entries: Array<{ relativePath: string }> }>(await fixture.service.execute({
      capabilityId: 'fs.list', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'vault',
      recursive: true, maxDepth: 1, maxEntries: 200, includeHidden: true, ignoreMode: 'PROJECT', expectedEffects: ['READ'],
    }));
    expect(shallow.entries.some((entry) => entry.relativePath === 'vault/research/deep/deep-note.md')).toBe(false);

    const found = executedValue<{ results: Array<{ relativePath: string }> }>(await fixture.service.execute({
      capabilityId: 'fs.find', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, root: 'vault', query: 'deep-note', mode: 'NAME',
      maxDepth: 6, maxResults: 10, ignoreMode: 'PROJECT', includeHidden: true, expectedEffects: ['READ'],
    }));
    expect(found.results).toEqual(expect.arrayContaining([expect.objectContaining({ relativePath: 'vault/research/deep/deep-note.md' })]));
  });

  it('AC-BBL-002 + AC-NINJA-001 stats/hashes a 256MiB sparse source by metadata/streaming and exposes only an artifact reference', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    const target = path.join(fixture.projectARoot, 'synthetic-media.bin');
    const handle = await open(target, 'w', 0o600);
    try {
      await handle.truncate(LARGE_SPARSE_BYTES);
      await handle.write(Buffer.from('IRIS'), 0, 4, LARGE_SPARSE_BYTES - 4);
    } finally {
      await handle.close();
    }

    const metadata = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'fs.stat', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'synthetic-media.bin', expectedEffects: ['READ'],
    }));
    expect(metadata).toMatchObject({ type: 'file', size: LARGE_SPARSE_BYTES, symlink: false, hardLinkCount: 1 });
    expect(metadata).not.toHaveProperty('content');
    expect(metadata).not.toHaveProperty('base64');

    const hashed = executedValue<{ sha256: string; size: number }>(await fixture.service.execute({
      capabilityId: 'fs.hash', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'synthetic-media.bin', expectedEffects: ['READ'],
    }));
    expect(hashed.size).toBe(LARGE_SPARSE_BYTES);
    expect(hashed.sha256).toMatch(/^[0-9a-f]{64}$/);

    const artifact = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'artifact.register_existing', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'synthetic-media.bin',
      mime: 'application/octet-stream', artifactType: 'synthetic-media', sensitivity: 'INTERNAL', retentionPolicy: 'MISSION',
      expectedEffects: ['READ', 'WRITE'],
    }));
    expect(artifact).toMatchObject({ projectId: fixture.projectA.id, workspaceId: primary.workspaceId, size: LARGE_SPARSE_BYTES, sha256: hashed.sha256 });
    expect(artifact).not.toHaveProperty('physicalPath');
    expect(artifact).not.toHaveProperty('content');

    const ref = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'artifact.open_ref', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, artifactId: artifact.artifactId as string, expectedEffects: ['READ'],
    }));
    expect(ref.reference).toBe(`iris-artifact:${String(artifact.artifactId)}`);
    expect(ref).not.toHaveProperty('physicalPath');
    expect(ref).not.toHaveProperty('content');
    expect(ref).not.toHaveProperty('base64');
  }, 30_000);

  it('AC-RDJ-001 + AC-RDJ-002 provides atomic APPEND with size/hash preconditions and zero partial bytes on stale conflicts', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    const target = path.join(fixture.projectARoot, 'knowledge.md');

    const created = await fixture.service.execute({
      capabilityId: 'fs.write', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'knowledge.md', mode: 'CREATE', content: '# Knowledge\n', expectedEffects: ['WRITE'],
    });
    expect(created.status).toBe('executed');
    const initial = await readFile(target);
    const initialHash = createHash('sha256').update(initial).digest('hex');

    const appended = executedValue<{ bytesAppended: number; sizeBefore: number; sizeAfter: number }>(await fixture.service.execute({
      capabilityId: 'fs.write', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'knowledge.md', mode: 'APPEND', content: '- item\n',
      expectedSize: initial.length, expectedSha256: initialHash, expectedEffects: ['WRITE'],
    }));
    expect(appended.sizeBefore).toBe(initial.length);
    expect(await readFile(target, 'utf8')).toBe('# Knowledge\n- item\n');
    const afterSuccess = await readFile(target);

    await expect(fixture.service.execute({
      capabilityId: 'fs.write', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'knowledge.md', mode: 'APPEND', content: 'stale-size\n',
      expectedSize: initial.length, expectedEffects: ['WRITE'],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await readFile(target)).toEqual(afterSuccess);

    await expect(fixture.service.execute({
      capabilityId: 'fs.write', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'knowledge.md', mode: 'APPEND', content: 'stale-hash\n',
      expectedSize: afterSuccess.length, expectedSha256: '0'.repeat(64), expectedEffects: ['WRITE'],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await readFile(target)).toEqual(afterSuccess);
  });

  it('enforces CREATE/REPLACE/TEXT/BYTE_RANGE/exact-edit/delete contracts without recursive or binary widening', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    const target = path.join(fixture.projectARoot, 'edit.txt');

    expect((await fixture.service.execute({
      capabilityId: 'fs.write', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'edit.txt', mode: 'CREATE', content: 'alpha beta\n', expectedEffects: ['WRITE'],
    })).status).toBe('executed');
    await expect(fixture.service.execute({
      capabilityId: 'fs.write', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'edit.txt', mode: 'CREATE', content: 'overwrite', expectedEffects: ['WRITE'],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(fixture.service.execute({
      capabilityId: 'fs.write', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'missing.txt', mode: 'REPLACE', content: 'missing', expectedEffects: ['WRITE', 'DESTRUCTIVE'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const current = await readFile(target);
    const expectedSha256 = createHash('sha256').update(current).digest('hex');
    expect((await fixture.service.execute({
      capabilityId: 'fs.edit', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'edit.txt', find: 'beta', replace: 'gamma', expectedSha256, expectedEffects: ['READ', 'WRITE', 'DESTRUCTIVE'],
    })).status).toBe('executed');
    expect(await readFile(target, 'utf8')).toBe('alpha gamma\n');

    const range = executedValue<{ base64: string; bytes: number }>(await fixture.service.execute({
      capabilityId: 'fs.read', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'edit.txt', mode: 'BYTE_RANGE', offset: 6, length: 5, expectedEffects: ['READ'],
    }));
    expect(Buffer.from(range.base64, 'base64').toString('utf8')).toBe('gamma');
    await expect(fixture.service.execute({
      capabilityId: 'fs.read', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'edit.txt', mode: 'BYTE_RANGE', offset: 0, length: 1048577, expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await writeFile(path.join(fixture.projectARoot, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255]));
    await expect(fixture.service.execute({
      capabilityId: 'fs.read', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'binary.bin', mode: 'TEXT', maxBytes: 100, expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await mkdir(path.join(fixture.projectARoot, 'nonempty'));
    await writeFile(path.join(fixture.projectARoot, 'nonempty', 'child.txt'), 'child\n');
    await expect(fixture.service.execute({
      capabilityId: 'fs.delete', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'nonempty', expectedEffects: ['WRITE', 'DESTRUCTIVE'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(access(path.join(fixture.projectARoot, 'nonempty', 'child.txt'))).resolves.toBeUndefined();
  });

  it('denies symlink traversal and hard-link content aliases while still reporting link metadata', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    const outside = path.join(fixture.sourceRoot, 'outside-link');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret\n');
    await symlink(path.join(outside, 'secret.txt'), path.join(fixture.projectARoot, 'alias.txt'));

    const linkStat = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'fs.stat', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'alias.txt', expectedEffects: ['READ'],
    }));
    expect(linkStat).toMatchObject({ type: 'symlink', symlink: true });
    await expect(fixture.service.execute({
      capabilityId: 'fs.read', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'alias.txt', mode: 'TEXT', expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const original = path.join(fixture.projectARoot, 'hard-original.txt');
    const hardAlias = path.join(fixture.projectARoot, 'hard-alias.txt');
    await writeFile(original, 'hard-link-source\n');
    await link(original, hardAlias);
    const hardStat = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'fs.stat', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'hard-original.txt', expectedEffects: ['READ'],
    }));
    expect(hardStat.hardLinkCount).toBe(2);
    await expect(fixture.service.execute({
      capabilityId: 'fs.hash', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'hard-original.txt', expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(fixture.service.execute({
      capabilityId: 'artifact.register_existing', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'hard-original.txt', mime: 'text/plain', artifactType: 'hard-link', sensitivity: 'INTERNAL', retentionPolicy: 'PROJECT', expectedEffects: ['READ', 'WRITE'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('AC-SEC-008 + AC-RDJ-004 + AC-RDJ-005 binds artifacts to project/workspace identity and rejects cross-project/forged dereference', async () => {
    const fixture = await serviceFixture();
    const primaryA = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    await mkdir(path.join(fixture.projectARoot, 'sources'));
    await writeFile(path.join(fixture.projectARoot, 'sources', 'evidence.dat'), 'artifact-evidence\n');
    const workspaceCountBefore = (await fixture.resources.listWorkspaces(fixture.projectA.id)).length;

    const artifact = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'artifact.register_existing', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primaryA.workspaceId, path: 'sources/evidence.dat', mime: 'application/octet-stream',
      artifactType: 'source-evidence', sensitivity: 'SENSITIVE', retentionPolicy: 'PROJECT', expectedEffects: ['READ', 'WRITE'],
    }));
    expect(artifact).toMatchObject({ projectId: fixture.projectA.id, workspaceId: primaryA.workspaceId, sensitivity: 'SENSITIVE' });
    expect(artifact).not.toHaveProperty('physicalPath');
    expect(JSON.stringify(artifact)).not.toContain('artifact-evidence');
    expect((await fixture.resources.listWorkspaces(fixture.projectA.id)).length).toBe(workspaceCountBefore);

    await expect(fixture.service.execute({
      capabilityId: 'artifact.open_ref', clientId: fixture.sessionB.clientId, sessionId: fixture.sessionB.id,
      projectId: fixture.projectB.id, artifactId: artifact.artifactId as string, expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(fixture.service.execute({
      capabilityId: 'artifact.stat', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, artifactId: randomUUID(), expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
    await expect(fixture.service.execute({
      capabilityId: 'fs.read', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: artifact.artifactId as string, path: 'sources/evidence.dat', mode: 'TEXT', expectedEffects: ['READ'],
    })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

    const released = executedValue<Record<string, unknown>>(await fixture.service.execute({
      capabilityId: 'artifact.release', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, artifactId: artifact.artifactId as string, expectedEffects: ['WRITE', 'DESTRUCTIVE'],
    }));
    expect(released).toMatchObject({ released: true, physicalFileDeleted: false });
    await expect(readFile(path.join(fixture.projectARoot, 'sources', 'evidence.dat'), 'utf8')).resolves.toBe('artifact-evidence\n');
  });

  it('keeps Phase 2 effects server-owned and rejects a downgraded expectedEffects assertion before CREATE side effects', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    expect(deriveCapabilityEffects('fs.write', { operation: 'CREATE' })).toEqual(['WRITE']);
    expect(deriveCapabilityEffects('fs.write', { operation: 'APPEND' })).toEqual(['WRITE']);
    expect(deriveCapabilityEffects('fs.write', { operation: 'REPLACE' })).toEqual(['WRITE', 'DESTRUCTIVE']);
    expect(deriveCapabilityEffects('fs.edit')).toEqual(['READ', 'WRITE', 'DESTRUCTIVE']);
    expect(deriveCapabilityEffects('fs.write', { operation: 'FUTURE_MODE' })).toBeNull();

    const target = path.join(fixture.projectARoot, 'effect-blocked.txt');
    const denied = await fixture.service.execute({
      capabilityId: 'fs.write', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, workspaceId: primary.workspaceId, path: 'effect-blocked.txt', mode: 'CREATE', content: 'must-not-exist', expectedEffects: [],
    });
    expect(denied).toMatchObject({ status: 'denied', reason: expect.stringContaining('EFFECT_MISMATCH') });
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const audits = await fixture.audit.recent(30);
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: 'fs.write', decision: 'DENY', result: 'DENIED', effectiveEffects: ['WRITE'], workspaceId: primary.workspaceId }),
    ]));
  });

  it('routes grouped Phase 2 transport through CapabilityService and preserves legacy file wrappers in the same runtime', async () => {
    const fixture = await serviceFixture();
    const primary = await fixture.resources.primaryWorkspace(fixture.projectA.id);
    const request = new Request('http://127.0.0.1/mcp', { headers: { 'x-iris-client-id': fixture.sessionA.clientId } });
    const grouped = await executePhase2GroupedTool('fs', {
      operation: 'write', sessionId: fixture.sessionA.id, projectId: fixture.projectA.id, workspaceId: primary.workspaceId,
      path: 'grouped.txt', writeMode: 'CREATE', content: 'grouped\n', expectedEffects: ['WRITE'],
    }, request, fixture.service, fixture.state);
    expect(grouped.status).toBe('executed');
    await expect(readFile(path.join(fixture.projectARoot, 'grouped.txt'), 'utf8')).resolves.toBe('grouped\n');

    const legacyTarget = path.join(fixture.projectARoot, 'legacy-phase2.txt');
    expect((await fixture.service.execute({
      capabilityId: 'file.write', clientId: fixture.sessionA.clientId, sessionId: fixture.sessionA.id,
      projectId: fixture.projectA.id, targetPath: legacyTarget, content: 'legacy-compatible\n',
    })).status).toBe('executed');
    const legacyRead = executedValue<{ content: string }>(await fixture.service.execute({
      capabilityId: 'file.read', clientId: fixture.sessionA.clientId, projectId: fixture.projectA.id, targetPath: legacyTarget,
    }));
    expect(legacyRead.content).toBe('legacy-compatible\n');
  });
});

async function serviceFixture() {
  const sourceRoot = await realpath(await temp('iris-phase2-source-'));
  const dataRoot = await realpath(await temp('iris-phase2-data-'));
  const legacyRoot = await realpath(await temp('iris-phase2-legacy-'));
  const projectARoot = path.join(sourceRoot, 'project-a');
  const projectBRoot = path.join(sourceRoot, 'project-b');
  await mkdir(projectARoot);
  await mkdir(projectBRoot);
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const projectA = await state.registerProject('Phase2 Project A', projectARoot);
  const projectB = await state.registerProject('Phase2 Project B', projectBRoot);
  const sessionA = state.createSession('phase2-client-a', 'phase2-agent-a', 'security');
  const sessionB = state.createSession('phase2-client-b', 'phase2-agent-b', 'security');
  await state.setSessionCurrentProject(sessionA.id, sessionA.clientId, projectA.id);
  await state.setSessionCurrentProject(sessionB.id, sessionB.clientId, projectB.id);
  const settings = new PermissionSettingsStore(dataRoot);
  await settings.initialize();
  const policy = new PermissionPolicyEngine(state, settings, sourceRoot, dataRoot, legacyRoot);
  const audit = new PermissionAuditStore(dataRoot);
  const resources = new VNextResourceRegistry(state, dataRoot);
  const service = new CapabilityService(state, policy, audit, () => ({
    status: 'ready', version: '0.0.0', platform: 'darwin', runtimeId: 'runtime', instanceId: 'instance', pid: process.pid,
    uptimeMs: 1, authority: 'owned', connectedClients: 2, connectedSessions: 2,
    agentExecutorType: 'local-development-executor', productionModelConnected: false,
    apiUrl: 'http://127.0.0.1:43110', mcpUrl: 'http://127.0.0.1:43110/mcp',
  }), new ProjectValidationJobManager(dataRoot), resources);
  return { sourceRoot, dataRoot, legacyRoot, projectARoot, projectBRoot, state, projectA, projectB, sessionA, sessionB, settings, audit, resources, service };
}

function executedValue<T>(outcome: CapabilityOutcome): T {
  if (outcome.status !== 'executed') throw new Error(`Expected executed outcome, received ${outcome.status}`);
  return outcome.value as T;
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
