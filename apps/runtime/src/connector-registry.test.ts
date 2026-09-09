import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindConnectorRuntime, catalogFingerprint, createConnectorRegistry, initializeConnectorRegistry, readConnectorRegistry, reconcileConnectorRegistry } from './connector-registry.js';
import { fullMcpToolNames } from './mcp-v21.js';
import { PRO_TOOL_NAMES } from './mcp.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('connector registry', () => {
  it('persists distinct FULL and PRO bindings and bumps deployment when runtime ownership changes', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-registry-'));
    roots.push(dataRoot);
    const seed = { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    const created = await initializeConnectorRegistry(dataRoot, seed);
    expect(created.connectors.map((connector) => [connector.label, connector.mcpPath])).toEqual([['IRIS FULL', '/mcp'], ['IRIS PRO', '/mcp-pro']]);
    const bound = await bindConnectorRuntime(dataRoot, 'runtime-a');
    expect(bound.deploymentEpoch).toBe(created.deploymentEpoch + 1);
    expect(bound.connectors.every((connector) => connector.runtimeId === 'runtime-a')).toBe(true);
    expect((await stat(path.join(dataRoot, 'connector-registry.json'))).mode & 0o077).toBe(0);
    expect(await readConnectorRegistry(dataRoot)).toEqual(bound);
  });

  it('rejects invalid tunnel/profile identities', () => {
    expect(() => createConnectorRegistry('/private/iris', { fullTunnelId: 'not-a-tunnel', proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, 1)).toThrowError(/tunnel ID/);
  });

  it('forward-migrates stale derived catalogs without changing tunnel identity', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-registry-migrate-'));
    roots.push(dataRoot);
    const created = await initializeConnectorRegistry(dataRoot, { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const old = JSON.parse(await readFile(path.join(dataRoot, 'connector-registry.json'), 'utf8')) as Record<string, unknown>;
    const oldConnectors = (old.connectors as Record<string, unknown>[]).map((connector) => {
      const withoutFingerprint = { ...connector };
      delete withoutFingerprint.catalogFingerprint;
      return { ...withoutFingerprint, expectedToolNames: ['old_tool'] };
    });
    await writeFile(path.join(dataRoot, 'connector-registry.json'), JSON.stringify({ ...old, schemaVersion: 1, connectors: oldConnectors }), { mode: 0o600 });

    const readable = await readConnectorRegistry(dataRoot);
    expect(readable?.connectors[0]?.expectedToolNames).toEqual(fullMcpToolNames());
    const reconciled = await reconcileConnectorRegistry(dataRoot);
    expect(reconciled?.changed).toBe(true);
    expect(reconciled?.registry.deploymentEpoch).toBe(created.deploymentEpoch + 1);
    expect(reconciled?.registry.connectors.map((connector) => connector.tunnelId)).toEqual([
      'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    expect(reconciled?.registry.connectors[0]?.catalogFingerprint).toBe(catalogFingerprint(fullMcpToolNames()));
    expect(reconciled?.registry.connectors[1]?.catalogFingerprint).toBe(catalogFingerprint(PRO_TOOL_NAMES));
  });

  it('rejects malformed identity and unknown connector injection while ignoring stale derived names', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-registry-invalid-'));
    roots.push(dataRoot);
    const created = createConnectorRegistry(dataRoot, { fullTunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', proTunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, 1);
    await writeFile(path.join(dataRoot, 'connector-registry.json'), JSON.stringify({ ...created, connectors: [...created.connectors, { ...created.connectors[0], connectorId: 'attacker' }] }), { mode: 0o600 });
    await expect(readConnectorRegistry(dataRoot)).rejects.toThrow('IRIS connector registry is invalid');
  });
});
