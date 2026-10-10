import { describe, expect, it } from 'vitest';
import config, { validateSupervisorWebRequest } from '../vite.config.js';

describe('Vite runtime proxy', () => {
  it('proxies mission routes to the runtime', () => {
    expect(config).toMatchObject({
      server: {
        proxy: {
          '/missions': expect.any(String),
        },
      },
    });
    expect(config.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'iris-supervisor-owner-bridge' })]));
  });

  it('allows only the five owner workload calls and requires matching MCP headers', () => {
    const request = { method: 'tools/call', params: { name: 'workload_on', arguments: {} } };
    expect(validateSupervisorWebRequest(request, { method: 'tools/call', name: 'workload_on' })).toBeNull();
    expect(validateSupervisorWebRequest({ ...request, params: { name: 'admin_recycle', arguments: {} } }, { method: 'tools/call', name: 'admin_recycle' })).toContain('not available');
    expect(validateSupervisorWebRequest(request, { method: 'tools/call', name: 'workload_off' })).toContain('headers');
    expect(validateSupervisorWebRequest({ method: 'tools/list' }, { method: 'tools/list', name: undefined })).toContain('only tools/call');
  });
});
