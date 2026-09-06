import { describe, expect, it } from 'vitest';
import config from '../vite.config.js';

describe('Vite runtime proxy', () => {
  it('proxies mission routes to the runtime', () => {
    expect(config).toMatchObject({
      server: {
        proxy: {
          '/missions': expect.any(String),
        },
      },
    });
  });
});
