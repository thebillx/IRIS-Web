import { describe, expect, it } from 'vitest';
import { assertSupportedNodeVersion, canonicalNodeRuntime, node24PathEntries, nodeVersionMajor } from './node-runtime.js';

describe('IRIS Node runtime selection', () => {
  it('requires Node 24 or newer before runtime initialization', () => {
    expect(nodeVersionMajor('v22.23.2')).toBe(22);
    expect(() => assertSupportedNodeVersion('v22.23.2')).toThrowError(/requires Node\.js >=24/);
    expect(() => assertSupportedNodeVersion('v22.23.2')).toThrowError(expect.objectContaining({ code: 'NODE_VERSION_UNSUPPORTED' }));
    expect(() => assertSupportedNodeVersion('v24.19.0')).not.toThrow();
  });

  it('resolves an installed Node 24 executable and puts it first in deterministic child PATH', () => {
    const runtime = canonicalNodeRuntime();
    expect(runtime.major).toBeGreaterThanOrEqual(24);
    expect(runtime.version).toMatch(/^v24\./);
    expect(node24PathEntries(runtime.path)[0]).toBe(runtime.path.replace(/\/node$/, ''));
    expect(node24PathEntries(runtime.path).join(':')).not.toContain('/.hermes/node/bin');
  });
});
