import { chmod, mkdir, mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialPaths, inspectCredentialStatus, loadOrCreateTunnelServiceSecret, migrateLegacyProfileCredential, readTunnelServiceSecret, rotateTunnelServiceSecret } from './credentials.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('persistent IRIS credentials', () => {
  it('creates private service credentials atomically and rotates them independently', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-credentials-'));
    roots.push(dataRoot);
    const first = await loadOrCreateTunnelServiceSecret(dataRoot);
    const paths = credentialPaths(dataRoot);
    expect((await stat(paths.directory)).mode & 0o077).toBe(0);
    expect((await stat(paths.tunnelServiceAuthorization)).mode & 0o077).toBe(0);
    expect(await readTunnelServiceSecret(dataRoot)).toBe(first);
    await rotateTunnelServiceSecret(dataRoot);
    expect(await readTunnelServiceSecret(dataRoot)).not.toBe(first);
    expect((await readFile(paths.tunnelServiceAuthorization, 'utf8')).trim()).not.toContain('Bearer ' + first);
  });

  it('rejects malformed service credentials and migrates a profile only when explicitly selected', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-credentials-invalid-'));
    const configHome = await mkdtemp(path.join(os.tmpdir(), 'iris-legacy-config-'));
    roots.push(dataRoot, configHome);
    const profileDirectory = path.join(configHome, 'tunnel-client');
    await mkdir(profileDirectory);
    const profilePath = path.join(profileDirectory, 'iris.yaml');
    await writeFile(profilePath, 'control_plane:\n  api_key: "credential-for-explicit-migration-only-12345"\n');
    await mkdir(credentialPaths(dataRoot).directory, { mode: 0o700 });
    await writeFile(credentialPaths(dataRoot).tunnelServiceAuthorization, 'not-a-bearer\n', { mode: 0o600 });
    await expect(readTunnelServiceSecret(dataRoot)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    await chmod(credentialPaths(dataRoot).tunnelServiceAuthorization, 0o600);
    await rm(credentialPaths(dataRoot).tunnelServiceAuthorization, { force: true });
    const status = await migrateLegacyProfileCredential(dataRoot, profilePath, { XDG_CONFIG_HOME: configHome });
    expect(status.controlPlaneApiKeyPresent).toBe(true);
    expect(status.tunnelServicePresent).toBe(true);
    const inspected = await inspectCredentialStatus(dataRoot, { XDG_CONFIG_HOME: configHome });
    expect(inspected.legacy.detected).toBe(true);
    expect(inspected.legacy.migrationRequired).toBe(false);
  });
});
