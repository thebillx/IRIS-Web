import { RuntimeError } from '@iris/domain';

export interface IrisPortSet {
  readonly runtime: number;
  readonly supervisorAdmin: number;
  readonly supervisorControl: number;
  readonly supervisorTunnelHealth: number;
  readonly fullTunnelHealth: number;
  readonly proTunnelHealth: number;
  readonly web: number;
}

export const DEFAULT_IRIS_PORTS: IrisPortSet = Object.freeze({
  runtime: 43_110,
  supervisorAdmin: 43_111,
  supervisorControl: 43_112,
  supervisorTunnelHealth: 43_113,
  fullTunnelHealth: 8_080,
  proTunnelHealth: 8_081,
  web: 5_173,
});

const PORT_KEYS = Object.keys(DEFAULT_IRIS_PORTS) as Array<keyof IrisPortSet>;

export function parseIrisPortSet(raw: string | undefined): IrisPortSet {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_IRIS_PORTS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new RuntimeError('INVALID_REQUEST', 'IRIS_ACCEPTANCE_PORTS must be valid JSON', { cause: error });
  }
  if (!isRecord(value) || Object.keys(value).length !== PORT_KEYS.length || PORT_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new RuntimeError('INVALID_REQUEST', 'IRIS_ACCEPTANCE_PORTS must contain the complete isolated port set');
  }
  const ports = Object.fromEntries(PORT_KEYS.map((key) => [key, value[key]])) as unknown as IrisPortSet;
  validateIrisPortSet(ports);
  return ports;
}

export function validateIrisPortSet(ports: IrisPortSet): void {
  const values = PORT_KEYS.map((key) => ports[key]);
  if (values.some((port) => !Number.isSafeInteger(port) || port <= 0 || port > 65_535)) {
    throw new RuntimeError('INVALID_REQUEST', 'Every IRIS port must be an integer from 1 through 65535');
  }
  if (new Set(values).size !== values.length) {
    throw new RuntimeError('INVALID_REQUEST', 'IRIS ports must be unique');
  }
}

export function irisPortEnvironment(ports: IrisPortSet): Record<string, string> {
  validateIrisPortSet(ports);
  return {
    IRIS_ACCEPTANCE_PORTS: JSON.stringify(ports),
    IRIS_RUNTIME_PORT: String(ports.runtime),
    IRIS_SUPERVISOR_ADMIN_PORT: String(ports.supervisorAdmin),
    IRIS_SUPERVISOR_CONTROL_PORT: String(ports.supervisorControl),
    IRIS_SUPERVISOR_TUNNEL_HEALTH_PORT: String(ports.supervisorTunnelHealth),
    IRIS_FULL_TUNNEL_HEALTH_PORT: String(ports.fullTunnelHealth),
    IRIS_PRO_TUNNEL_HEALTH_PORT: String(ports.proTunnelHealth),
    IRIS_WEB_PORT: String(ports.web),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
