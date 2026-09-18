import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSupportedNodeVersion, canonicalNodeRuntime, node24PathEntries, nodeVersionMajor } from './node-runtime.js';

describe('IRIS Node runtime selection', () => {
  it('requires Node 24 or newer before runtime initialization', () => {
    expect(nodeVersionMajor('v22.23.2')).toBe(22);
    expect(() => assertSupportedNodeVersion('v22.23.2')).toThrowError(/requires Node\.js >=24/);
    expect(() => assertSupportedNodeVersion('v22.23.2')).toThrowError(expect.objectContaining({ code: 'NODE_VERSION_UNSUPPORTED' }));
    expect(() => assertSupportedNodeVersion('v24.19.0')).not.toThrow();
  });

  it('resolves an installed Node 24 executable and ignores ambient HOME when building deterministic child PATH', () => {
    const runtime = canonicalNodeRuntime();
    const originalHome = process.env.HOME;
    process.env.HOME = '/tmp/iris-governed-workspace-home';
    try {
      const entries = node24PathEntries(runtime.path);
      expect(runtime.major).toBeGreaterThanOrEqual(24);
      expect(runtime.version).toMatch(/^v24\./);
      expect(entries[0]).toBe(runtime.path.replace(/\/node$/, ''));
      expect(entries).toContain(path.join(os.userInfo().homedir, '.local', 'bin'));
      expect(entries).not.toContain('/tmp/iris-governed-workspace-home/.local/bin');
      expect(entries.join(':')).not.toContain('/.hermes/node/bin');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
