import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IRIS_PORTS, irisPortEnvironment, parseIrisPortSet, validateIrisPortSet } from './port-config.js';
import { createSupervisor } from './supervisor.js';

const isolated = {
  runtime: 46_110,
  supervisorAdmin: 46_111,
  supervisorControl: 46_112,
  supervisorTunnelHealth: 46_113,
  fullTunnelHealth: 46_114,
  proTunnelHealth: 46_115,
  web: 46_116,
};

describe('acceptance port configuration', () => {
  it('keeps production defaults when no acceptance set is configured', () => {
    expect(parseIrisPortSet(undefined)).toEqual(DEFAULT_IRIS_PORTS);
  });

  it('requires the complete unique bounded port set', () => {
    expect(parseIrisPortSet(JSON.stringify(isolated))).toEqual(isolated);
    expect(() => parseIrisPortSet(JSON.stringify({ ...isolated, web: undefined }))).toThrow(/complete isolated port set/);
    expect(() => validateIrisPortSet({ ...isolated, web: isolated.runtime })).toThrow(/unique/);
    expect(() => validateIrisPortSet({ ...isolated, web: 0 })).toThrow(/1 through 65535/);
  });

  it('propagates one set through the existing child environment contract', () => {
    expect(irisPortEnvironment(isolated)).toMatchObject({
      IRIS_ACCEPTANCE_PORTS: JSON.stringify(isolated),
      IRIS_RUNTIME_PORT: '46110',
      IRIS_SUPERVISOR_ADMIN_PORT: '46111',
      IRIS_SUPERVISOR_CONTROL_PORT: '46112',
      IRIS_SUPERVISOR_TUNNEL_HEALTH_PORT: '46113',
      IRIS_FULL_TUNNEL_HEALTH_PORT: '46114',
      IRIS_PRO_TUNNEL_HEALTH_PORT: '46115',
      IRIS_WEB_PORT: '46116',
    });
  });

  it('binds Supervisor initialization to the same explicit port set', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-port-config-'));
    try {
      const supervisor = await createSupervisor({
        dataRoot,
        sourceRoot: process.cwd(),
        runtimePort: isolated.runtime,
        adminPort: isolated.supervisorAdmin,
        supervisorControlPort: isolated.supervisorControl,
        adminTunnelHealthPort: isolated.supervisorTunnelHealth,
        fullTunnelHealthPort: isolated.fullTunnelHealth,
        proTunnelHealthPort: isolated.proTunnelHealth,
        webPort: isolated.web,
      });
      expect((supervisor as unknown as { ports: typeof isolated }).ports).toEqual(isolated);
      const registry = await supervisor.initializeUnified('tunnel_0123456789abcdef0123456789abcdef');
      expect(registry.connectors[0]?.healthPort).toBe(isolated.fullTunnelHealth);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
