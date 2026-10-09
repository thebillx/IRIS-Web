import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindAdminTunnelIdentity, bindConnectorRuntime, createConnectorRegistry, initializeConnectorRegistry, readConnectorRegistry, type ConnectorRegistryDocument } from './connector-registry.js';
import { startDaemon } from './daemon.js';
import { readTunnelServiceSecret } from './credentials.js';
import { loadOrCreateRuntimeId } from './persistence.js';
import { createSupervisor } from './supervisor.js';
import { readSupervisorAdminSnapshot } from './supervisor-admin.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const tunnelId = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('unified IRIS fresh setup', () => {
  it('serializes explicit initialization and refuses to overwrite an existing setup', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-unified-init-'));
    roots.push(dataRoot);
    const supervisor = await createSupervisor({ dataRoot });
    await supervisor.initializeUnified(tunnelId);
    const before = await readFile(path.join(dataRoot, 'connector-registry.json'));
    await expect(supervisor.initializeUnified('tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await readFile(path.join(dataRoot, 'connector-registry.json'))).toEqual(before);
  });

  it('persists one public binding and rejects extra lifecycle or read-only tunnels without mutation', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-unified-registry-'));
    roots.push(dataRoot);
    const registry = await initializeConnectorRegistry(dataRoot, { unified: true, fullTunnelId: tunnelId });
    expect(registry.connectors.map((binding) => [binding.label, binding.mcpPath])).toEqual([['IRIS', '/mcp']]);
    expect(registry.admin).toBeNull();
    const before = await readFile(path.join(dataRoot, 'connector-registry.json'));
    await expect(bindAdminTunnelIdentity(dataRoot, 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await readFile(path.join(dataRoot, 'connector-registry.json'))).toEqual(before);
    expect(await readConnectorRegistry(dataRoot)).toEqual(registry);
    expect(() => createConnectorRegistry(dataRoot, { unified: true, fullTunnelId: tunnelId, proTunnelId: tunnelId }, 1)).toThrow(/one public tunnel/);
  });

  it('serves only the authenticated public MCP route and retains local lifecycle readiness', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-unified-runtime-'));
    roots.push(dataRoot);
    await initializeConnectorRegistry(dataRoot, { unified: true, fullTunnelId: tunnelId });
    const registry = await bindConnectorRuntime(dataRoot, await loadOrCreateRuntimeId(dataRoot));
    const daemon = await startDaemon({ dataRoot, preferredPort: 0 });
    try {
      const secret = await readTunnelServiceSecret(dataRoot);
      const response = await fetch(daemon.apiUrl + '/mcp', {
        method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28', 'x-iris-connector-profile': 'FULL',
          'x-iris-deployment-epoch': String(registry.deploymentEpoch), 'x-iris-runtime-id': daemon.identity.runtimeId,
          'x-iris-client-id': 'unified-fixture' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { result: { tools: unknown[] } }).result.tools).toHaveLength(56);
      expect((await fetch(daemon.apiUrl + '/mcp')).status).toBe(401);
      expect((await fetch(daemon.apiUrl + '/mcp-pro')).status).toBe(404);
      const supervisor = await createSupervisor({ dataRoot, sourceRoot: path.resolve(import.meta.dirname, '../../..') });
      expect((await supervisor.localReadiness()).connectors).toHaveLength(1);
      expect((await supervisor.catalogStatus()).pro).toBeNull();
      expect(await readSupervisorAdminSnapshot(dataRoot)).toMatchObject({ readiness: 'READY', fullToolCount: 56, proToolCount: 0 });
      await (supervisor as unknown as { writeManagedProfiles: (binding: ConnectorRegistryDocument, url: string) => Promise<unknown> }).writeManagedProfiles(registry, daemon.apiUrl);
      expect(await readdir(path.join(dataRoot, 'tunnel-profiles'))).toEqual(['iris-full.yaml']);
    } finally { await daemon.close(); }
  });

  it('keeps two unified machines request-isolated without a fallback connector', async () => {
    const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-unified-machine-a-'));
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-unified-machine-b-'));
    roots.push(firstRoot, secondRoot);
    const [firstRegistry, secondRegistry] = await Promise.all([
      initializeConnectorRegistry(firstRoot, { unified: true, fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      initializeConnectorRegistry(secondRoot, { unified: true, fullTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    ]);
    const [firstDaemon, secondDaemon] = await Promise.all([
      startDaemon({ dataRoot: firstRoot, preferredPort: 0 }),
      startDaemon({ dataRoot: secondRoot, preferredPort: 0 }),
    ]);
    try {
      const firstSecret = await readTunnelServiceSecret(firstRoot);
      const secondSecret = await readTunnelServiceSecret(secondRoot);
      expect(firstSecret).not.toBeNull();
      expect(secondSecret).not.toBeNull();
      const request = (daemon: typeof firstDaemon, registry: ConnectorRegistryDocument, secret: string, pathName = '/mcp') => fetch(daemon.apiUrl + pathName, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'x-iris-connector-profile': 'FULL',
          'x-iris-deployment-epoch': String(registry.deploymentEpoch),
          'x-iris-runtime-id': daemon.identity.runtimeId,
          'x-iris-client-id': 'machine-isolation-fixture',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect((await request(firstDaemon, firstRegistry, secondSecret!)).status).toBe(401);
      expect((await request(secondDaemon, secondRegistry, firstSecret!)).status).toBe(401);
      expect((await fetch(firstDaemon.apiUrl + '/mcp-pro')).status).toBe(404);
      expect((await fetch(secondDaemon.apiUrl + '/mcp-pro')).status).toBe(404);
    } finally {
      await Promise.all([firstDaemon.close(), secondDaemon.close()]);
    }
  });
});
