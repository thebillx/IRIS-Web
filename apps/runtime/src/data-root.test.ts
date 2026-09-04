import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureRuntimeDataRoot, resolveRuntimeDataRoot, runtimeDataRootWritable } from './data-root.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('runtime data root', () => {
  it('defaults outside the source checkout and creates private writable machine-local state', async () => {
    const source = await temp('iris-source-');
    const home = await temp('iris-home-');
    const dataRoot = await resolveRuntimeDataRoot({}, source, home);
    expect(dataRoot).toBe(path.join(await realpath(home), 'Library', 'Application Support', 'IRIS'));
    expect(dataRoot.startsWith(`${source}${path.sep}`)).toBe(false);
    await ensureRuntimeDataRoot(dataRoot);
    await expect(runtimeDataRootWritable(dataRoot)).resolves.toBe(true);
  });

  it('rejects a configured runtime data root inside the source checkout', async () => {
    const source = await temp('iris-source-');
    await expect(resolveRuntimeDataRoot({ IRIS_RUNTIME_DATA_ROOT: path.join(source, '.runtime') }, source)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });

  it('fails closed when an existing runtime data root grants group or other access', async () => {
    const source = await temp('iris-source-');
    const dataRoot = await temp('iris-insecure-data-');
    await chmod(dataRoot, 0o755);
    await expect(ensureRuntimeDataRoot(dataRoot)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
    await expect(runtimeDataRootWritable(dataRoot)).resolves.toBe(false);
    expect(dataRoot.startsWith(`${source}${path.sep}`)).toBe(false);
  });
});

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
