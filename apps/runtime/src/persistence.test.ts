import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEndpoint, readRuntimeControl, writeEndpoint, writeRuntimeControl } from './persistence.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('runtime endpoint persistence', () => {
  it('accepts only same-origin IPv4-loopback API and MCP endpoints', async () => {
    const root = await fixture();
    const endpoint = {
      schemaVersion: 1 as const,
      runtimeId: randomUUID(),
      instanceId: randomUUID(),
      pid: process.pid,
      apiUrl: 'http://127.0.0.1:43110',
      mcpUrl: 'http://127.0.0.1:43110/mcp',
      startedAt: new Date().toISOString(),
    };
    await writeEndpoint(root, endpoint);
    await expect(readEndpoint(root)).resolves.toEqual(endpoint);
  });

  it('fails closed for malformed or non-loopback endpoint metadata', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'endpoint.json'), JSON.stringify({
      schemaVersion: 1,
      runtimeId: randomUUID(),
      instanceId: randomUUID(),
      pid: process.pid,
      apiUrl: 'http://example.test:43110',
      mcpUrl: 'http://example.test:43110/mcp',
      startedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    await expect(readEndpoint(root)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('fails closed when endpoint metadata is symlinked or grants group access', async () => {
    const root = await fixture();
    const outsideRoot = await fixture();
    const outside = path.join(outsideRoot, 'endpoint.json');
    await writeFile(outside, '{}', { mode: 0o600 });
    await symlink(outside, path.join(root, 'endpoint.json'));
    await expect(readEndpoint(root)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });

    await rm(path.join(root, 'endpoint.json'));
    await writeFile(path.join(root, 'endpoint.json'), '{}', { mode: 0o600 });
    await chmod(path.join(root, 'endpoint.json'), 0o644);
    await expect(readEndpoint(root)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('stores the instance-bound runtime control credential only in a private no-follow metadata file', async () => {
    const root = await fixture();
    const control = { schemaVersion: 1 as const, runtimeId: randomUUID(), instanceId: randomUUID(), secret: 'a'.repeat(43) };
    await writeRuntimeControl(root, control);
    await expect(readRuntimeControl(root)).resolves.toEqual(control);

    const outsideRoot = await fixture();
    const outside = path.join(outsideRoot, 'control.json');
    await writeFile(outside, JSON.stringify(control), { mode: 0o600 });
    await rm(path.join(root, 'control.json'));
    await symlink(outside, path.join(root, 'control.json'));
    await expect(readRuntimeControl(root)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-persistence-'));
  roots.push(root);
  return root;
}
