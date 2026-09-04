import { describe, expect, it } from 'vitest';
import { validatePathWithinRoot } from './index.js';

describe('validatePathWithinRoot', () => {
  it('accepts the root and descendants', () => {
    expect(validatePathWithinRoot('/tmp/iris/project', '/tmp/iris')).toBe('/tmp/iris/project');
  });

  it('rejects traversal beyond the root', () => {
    expect(() => validatePathWithinRoot('/tmp/iris/../outside', '/tmp/iris')).toThrow();
  });
});
