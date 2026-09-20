import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAdoRuntimeBindingProvider, adoBindingPath, adoCredentialPath, persistAdoCredential, persistAdoRuntimeBinding, readAdoBindingStatus } from './runtime-binding.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('ADO protected runtime binding', () => {
  it('resolves one exact project-bound private credential without exposing secret in grant metadata', async () => {
    const root = await dataRoot();
    await writeBinding(root, 'iris-project', 'cred-main');
    await writeCredential(root, 'cred-main');

    const resolved = await new FileAdoRuntimeBindingProvider(root).resolve('iris-project');

    expect(resolved.identity).toMatchObject({
      organization: { id: 'org-id', name: 'org' },
      project: { id: 'project-id', name: 'Project' },
      team: { id: 'team-id', name: 'Team' },
      board: { id: 'board-id', name: 'Stories' },
    });
    expect(resolved.grant).toMatchObject({
      projectId: 'iris-project',
      connectorBindingId: 'ado-binding',
      credentialRef: 'cred-main',
      tokenScopes: ['vso.work'],
      policy: { mode: 'READ_ONLY' },
    });
    expect(JSON.stringify(resolved.grant)).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
    expect(resolved.auth.secret).toBe('abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('fails closed when the selected project has no protected binding', async () => {
    const root = await dataRoot();
    await expect(new FileAdoRuntimeBindingProvider(root).resolve('missing-project'))
      .rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' });
  });

  it('rejects a binding file that is readable by group/other', async () => {
    const root = await dataRoot();
    await writeBinding(root, 'iris-project', 'cred-main');
    await writeCredential(root, 'cred-main');
    await chmod(adoBindingPath(root, 'iris-project'), 0o644);

    await expect(new FileAdoRuntimeBindingProvider(root).resolve('iris-project'))
      .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  });

  it('rejects a credential whose internal reference does not match the protected binding', async () => {
    const root = await dataRoot();
    await writeBinding(root, 'iris-project', 'cred-main');
    await ensureDirs(root);
    await writeFile(
      adoCredentialPath(root, 'cred-main'),
      JSON.stringify({
        schemaVersion: 1,
        credentialRef: 'different-ref',
        kind: 'PAT',
        secret: 'abcdefghijklmnopqrstuvwxyz1234567890',
      }),
      { mode: 0o600 },
    );

    await expect(new FileAdoRuntimeBindingProvider(root).resolve('iris-project'))
      .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  });

  it('provisions private credential and binding state without printing or persisting secret in binding metadata', async () => {
    const root = await bareDataRoot();
    await persistAdoCredential(root, {
      credentialRef: 'cred-provisioned',
      kind: 'PAT',
      secret: 'abcdefghijklmnopqrstuvwxyz1234567890',
    });
    await persistAdoRuntimeBinding(root, bindingManifest('iris-project', 'cred-provisioned'));

    const status = await readAdoBindingStatus(root, 'iris-project');

    expect(status).toMatchObject({
      configured: true,
      irisProjectId: 'iris-project',
      connectorBindingId: 'ado-binding',
      credentialRef: 'cred-provisioned',
      credentialPresent: true,
      credentialKind: 'PAT',
      revoked: false,
    });
    expect(JSON.stringify(status)).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('rejects extra manifest fields so credentials cannot be smuggled into binding metadata', async () => {
    const root = await bareDataRoot();
    const invalid = {
      ...bindingManifest('iris-project', 'cred-main'),
      secret: 'must-never-enter-binding',
    } as unknown as Parameters<typeof persistAdoRuntimeBinding>[1];

    await expect(persistAdoRuntimeBinding(root, invalid))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

async function bareDataRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-ado-binding-bare-'));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

function bindingManifest(irisProjectId: string, credentialRef: string): Parameters<typeof persistAdoRuntimeBinding>[1] {
  return {
    schemaVersion: 1,
    irisProjectId,
    connectorBindingId: 'ado-binding',
    credentialRef,
    sessionRef: 'ado-session',
    organization: { id: 'org-id', name: 'org' },
    project: { id: 'project-id', name: 'Project' },
    team: { id: 'team-id', name: 'Team' },
    board: { id: 'board-id', name: 'Stories' },
    network: 'allowed',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revoked: false,
    tokenScopes: ['vso.work'],
    resources: ['board','scope','backlogs','query','workItems','comments','links'],
    limits: {
      timeoutMs: 5000,
      maxResponseBytes: 1048576,
      maxPageItems: 100,
      maxPages: 4,
      maxBatchItems: 100,
      rateLimitRequests: 100,
      rateLimitWindowMs: 60000,
      maxRetryAfterMs: 10000,
    },
  };
}

async function dataRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-ado-binding-'));
  roots.push(root);
  await chmod(root, 0o700);
  await ensureDirs(root);
  return root;
}

async function ensureDirs(root: string): Promise<void> {
  for (const directory of [
    path.join(root, 'integrations'),
    path.join(root, 'integrations', 'ado'),
    path.join(root, 'integrations', 'ado', 'bindings'),
    path.join(root, 'credentials'),
    path.join(root, 'credentials', 'ado'),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

async function writeBinding(root: string, irisProjectId: string, credentialRef: string): Promise<void> {
  await ensureDirs(root);
  await writeFile(adoBindingPath(root, irisProjectId), JSON.stringify({
    schemaVersion: 1,
    irisProjectId,
    connectorBindingId: 'ado-binding',
    credentialRef,
    sessionRef: 'ado-session',
    organization: { id: 'org-id', name: 'org' },
    project: { id: 'project-id', name: 'Project' },
    team: { id: 'team-id', name: 'Team' },
    board: { id: 'board-id', name: 'Stories' },
    network: 'allowed',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revoked: false,
    tokenScopes: ['vso.work'],
    resources: ['board','scope','backlogs','query','workItems','comments','links'],
    limits: {
      timeoutMs: 5000,
      maxResponseBytes: 1048576,
      maxPageItems: 100,
      maxPages: 4,
      maxBatchItems: 100,
      rateLimitRequests: 100,
      rateLimitWindowMs: 60000,
      maxRetryAfterMs: 10000,
    },
  }), { mode: 0o600 });
  await chmod(adoBindingPath(root, irisProjectId), 0o600);
}

async function writeCredential(root: string, credentialRef: string): Promise<void> {
  await ensureDirs(root);
  await writeFile(adoCredentialPath(root, credentialRef), JSON.stringify({
    schemaVersion: 1,
    credentialRef,
    kind: 'PAT',
    secret: 'abcdefghijklmnopqrstuvwxyz1234567890',
  }), { mode: 0o600 });
  await chmod(adoCredentialPath(root, credentialRef), 0o600);
}
