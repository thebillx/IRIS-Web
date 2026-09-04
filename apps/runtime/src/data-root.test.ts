import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureRuntimeDataRoot, resolveRuntimeDataRoot, runtimeDataRootWritable } from './data-root.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('runtime data root', () => {
  it('defaults outside the source checkout and creates writable machine-local state', async () => {
    const source = await temp('iris-source-');
    const home = await temp('iris-home-');
    const dataRoot = await resolveRuntimeDataRoot({}, source, home);
    expect(dataRoot.endsWith(path.join('Library', 'Application Support', 'IRIS'))).toBe(true);
    expect(dataRoot.startsWith(`${source}${path.sep}`)).toBe(false);
    await ensureRuntimeDataRoot(dataRoot);
    expect(await runtimeDataRootWritable(dataRoot)).toBe(true);
  });

  it('rejects a configured runtime data root inside the source checkout', async () => {
    const source = await temp('iris-source-');
    const nested = path.join(source, '.runtime');
    await mkdir(nested);
    await expect(resolveRuntimeDataRoot({ IRIS_RUNTIME_DATA_ROOT: nested }, source)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
  });
});
