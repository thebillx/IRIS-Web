import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { catalogIdentity } from './mcp-catalog.js';
import { PRO_TOOL_NAMES, proMcpToolDefinitions } from './mcp.js';
import { fullMcpToolDefinitionsV21, fullMcpToolNames } from './mcp-v21.js';
import { inspectPrivateRegularFile } from './private-fs.js';
import { writePrivateJsonAtomic } from './credentials.js';

const REGISTRY_FILE = 'connector-registry.json';
const TUNNEL_ID_PATTERN = /^tunnel_[a-f0-9]{32}$/;

export type ConnectorMode = 'FULL' | 'PRO';

export interface ConnectorBinding {
  readonly connectorId: string;
  readonly label: 'IRIS FULL' | 'IRIS PRO';
  readonly mode: ConnectorMode;
  readonly tunnelId: string;
  readonly runtime: 'iris-local-runtime';
  readonly mcpProfile: 'FULL' | 'READ_ONLY';
  readonly mcpPath: '/mcp' | '/mcp-pro';
  readonly expectedToolNames: readonly string[];
  readonly catalogFingerprint: string;
  readonly catalogHash: string;
  readonly healthPort: number;
  readonly managedProfilePath: string;
  readonly runtimeId: string | null;
  readonly deploymentEpoch: number;
}

export interface ConnectorRegistryDocument {
  readonly schemaVersion: 2;
  readonly deploymentEpoch: number;
  readonly updatedAt: string;
  readonly connectors: readonly ConnectorBinding[];
}

export interface ConnectorRegistryReconciliation {
  readonly registry: ConnectorRegistryDocument;
  readonly changed: boolean;
  readonly previousDeploymentEpoch: number;
}

export interface ConnectorRegistryInspection {
  readonly registry: ConnectorRegistryDocument;
  readonly changed: boolean;
  readonly staleConnectorIds: readonly string[];
}

interface RawConnectorBinding {
  readonly connectorId: string;
  readonly label: 'IRIS FULL' | 'IRIS PRO';
  readonly mode: ConnectorMode;
  readonly tunnelId: string;
  readonly runtime: 'iris-local-runtime';
  readonly mcpProfile: 'FULL' | 'READ_ONLY';
  readonly mcpPath: '/mcp' | '/mcp-pro';
  readonly expectedToolNames?: unknown;
  readonly catalogFingerprint?: unknown;
  readonly catalogHash?: unknown;
  readonly healthPort: number;
  readonly managedProfilePath: string;
  readonly runtimeId?: string | null;
  readonly deploymentEpoch?: unknown;
}

export interface ConnectorSeed {
  readonly fullTunnelId: string;
  readonly proTunnelId: string;
  readonly fullHealthPort?: number;
  readonly proHealthPort?: number;
}

export interface LegacyProfileObservation {
  readonly path: string;
  readonly tunnelId: string | null;
  readonly mcpUrl: string | null;
  readonly healthPort: number | null;
  readonly usesLegacyCredentialReferences: boolean;
}

export function connectorRegistryPath(dataRoot: string): string {
  return path.join(dataRoot, REGISTRY_FILE);
}

export async function readConnectorRegistry(dataRoot: string): Promise<ConnectorRegistryDocument | null> {
  const parsed = await readParsedRegistry(dataRoot);
  return parsed?.registry ?? null;
}

export async function inspectConnectorRegistry(dataRoot: string): Promise<ConnectorRegistryInspection | null> {
  const parsed = await readParsedRegistry(dataRoot);
  return parsed === null ? null : { registry: parsed.registry, changed: parsed.changed, staleConnectorIds: parsed.staleConnectorIds };
}

export async function reconcileConnectorRegistry(dataRoot: string): Promise<ConnectorRegistryReconciliation | null> {
  const parsed = await readParsedRegistry(dataRoot);
  if (parsed === null) return null;
  if (!parsed.changed) return { registry: parsed.registry, changed: false, previousDeploymentEpoch: parsed.registry.deploymentEpoch };
  const previousDeploymentEpoch = parsed.registry.deploymentEpoch;
  const deploymentEpoch = previousDeploymentEpoch + 1;
  if (!Number.isSafeInteger(deploymentEpoch) || deploymentEpoch <= 0) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'IRIS connector deployment epoch overflowed');
  }
  const registry: ConnectorRegistryDocument = {
    ...parsed.registry,
    schemaVersion: 2,
    deploymentEpoch,
    updatedAt: new Date().toISOString(),
    connectors: parsed.registry.connectors.map((connector) => ({ ...connector, deploymentEpoch })),
  };
  await writePrivateJsonAtomic(connectorRegistryPath(dataRoot), registry);
  return { registry, changed: true, previousDeploymentEpoch };
}

async function readParsedRegistry(dataRoot: string): Promise<{ readonly registry: ConnectorRegistryDocument; readonly changed: boolean; readonly staleConnectorIds: readonly string[] } | null> {
  const inspected = await inspectPrivateRegularFile(connectorRegistryPath(dataRoot), 'IRIS connector registry');
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
  try {
    const value = JSON.parse(inspected.content) as unknown;
    const parsed = normalizeRegistry(value, dataRoot);
    return parsed;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'IRIS connector registry is invalid', { cause: error });
  }
}

export async function initializeConnectorRegistry(dataRoot: string, seed: ConnectorSeed): Promise<ConnectorRegistryDocument> {
  const existing = await readConnectorRegistry(dataRoot);
  if (existing !== null) return existing;
  validateTunnelId(seed.fullTunnelId, 'fullTunnelId');
  validateTunnelId(seed.proTunnelId, 'proTunnelId');
  const document = createConnectorRegistry(dataRoot, seed, 1);
  await writePrivateJsonAtomic(connectorRegistryPath(dataRoot), document);
  return document;
}

export function createConnectorRegistry(dataRoot: string, seed: ConnectorSeed, deploymentEpoch: number): ConnectorRegistryDocument {
  validateTunnelId(seed.fullTunnelId, 'fullTunnelId');
  validateTunnelId(seed.proTunnelId, 'proTunnelId');
  if (!Number.isSafeInteger(deploymentEpoch) || deploymentEpoch <= 0) throw new RuntimeError('INVALID_REQUEST', 'Connector deployment epoch is invalid');
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    deploymentEpoch,
    updatedAt: now,
    connectors: [
      {
        connectorId: 'iris-full', label: 'IRIS FULL', mode: 'FULL', tunnelId: seed.fullTunnelId,
        runtime: 'iris-local-runtime', mcpProfile: 'FULL', mcpPath: '/mcp', expectedToolNames: fullMcpToolNames(), catalogFingerprint: catalogFingerprint(fullMcpToolNames()), catalogHash: catalogIdentity('FULL', fullMcpToolDefinitionsV21()).catalogHash,
        healthPort: seed.fullHealthPort ?? 8080, managedProfilePath: path.join(dataRoot, 'tunnel-profiles', 'iris-full.yaml'),
        runtimeId: null, deploymentEpoch,
      },
      {
        connectorId: 'iris-pro', label: 'IRIS PRO', mode: 'PRO', tunnelId: seed.proTunnelId,
        runtime: 'iris-local-runtime', mcpProfile: 'READ_ONLY', mcpPath: '/mcp-pro', expectedToolNames: [...PRO_TOOL_NAMES], catalogFingerprint: catalogFingerprint(PRO_TOOL_NAMES), catalogHash: catalogIdentity('PRO', proMcpToolDefinitions()).catalogHash,
        healthPort: seed.proHealthPort ?? 8081, managedProfilePath: path.join(dataRoot, 'tunnel-profiles', 'iris-pro.yaml'),
        runtimeId: null, deploymentEpoch,
      },
    ],
  };
}

export async function updateConnectorRuntime(dataRoot: string, runtimeId: string): Promise<ConnectorRegistryDocument> {
  const current = await requireConnectorRegistry(dataRoot);
  const nextEpoch = current.deploymentEpoch + 1;
  const next: ConnectorRegistryDocument = {
    ...current,
    deploymentEpoch: nextEpoch,
    updatedAt: new Date().toISOString(),
    connectors: current.connectors.map((connector) => ({ ...connector, runtimeId, deploymentEpoch: nextEpoch })),
  };
  await writePrivateJsonAtomic(connectorRegistryPath(dataRoot), next);
  return next;
}

export async function bindConnectorRuntime(dataRoot: string, runtimeId: string): Promise<ConnectorRegistryDocument> {
  const current = await requireConnectorRegistry(dataRoot);
  if (current.connectors.every((connector) => connector.runtimeId === runtimeId)) return current;
  const deploymentEpoch = current.deploymentEpoch + 1;
  const next: ConnectorRegistryDocument = {
    ...current,
    deploymentEpoch,
    updatedAt: new Date().toISOString(),
    connectors: current.connectors.map((connector) => ({ ...connector, runtimeId, deploymentEpoch })),
  };
  await writePrivateJsonAtomic(connectorRegistryPath(dataRoot), next);
  return next;
}

export async function requireConnectorRegistry(dataRoot: string): Promise<ConnectorRegistryDocument> {
  const registry = await readConnectorRegistry(dataRoot);
  if (registry === null) throw new RuntimeError('MIGRATION_REQUIRED', 'IRIS connector registry is not initialized; run iris credentials migrate');
  return registry;
}

export async function observeLegacyProfiles(environment: NodeJS.ProcessEnv = process.env): Promise<readonly LegacyProfileObservation[]> {
  const configHome = environment.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return Promise.all([
    observeLegacyProfile(path.join(configHome, 'tunnel-client', 'iris.yaml')),
    observeLegacyProfile(path.join(configHome, 'tunnel-client', 'iris-pro.yaml')),
  ]);
}

export async function seedFromLegacyProfiles(dataRoot: string, environment: NodeJS.ProcessEnv = process.env): Promise<ConnectorRegistryDocument> {
  const observations = await observeLegacyProfiles(environment);
  const full = observations[0];
  const pro = observations[1];
  if (full?.tunnelId === null || full?.tunnelId === undefined || pro?.tunnelId === null || pro?.tunnelId === undefined) {
    throw new RuntimeError('MIGRATION_REQUIRED', 'Both iris and iris-pro tunnel IDs are required to initialize connector bindings');
  }
  return initializeConnectorRegistry(dataRoot, {
    fullTunnelId: full.tunnelId,
    proTunnelId: pro.tunnelId,
    fullHealthPort: full.healthPort ?? 8080,
    proHealthPort: pro.healthPort ?? 8081,
  });
}

async function observeLegacyProfile(filename: string): Promise<LegacyProfileObservation> {
  const content = await readFile(filename, 'utf8').catch(() => null);
  if (content === null) return { path: filename, tunnelId: null, mcpUrl: null, healthPort: null, usesLegacyCredentialReferences: false };
  return {
    path: filename,
    tunnelId: scalar(content, 'tunnel_id'),
    mcpUrl: scalar(content, 'url'),
    healthPort: parseHealthPort(content),
    usesLegacyCredentialReferences: /env:CONTROL_PLANE_API_KEY|env:IRIS_OWNER_AUTH_HEADER/.test(content),
  };
}

function parseHealthPort(content: string): number | null {
  const value = scalar(content, 'listen_addr');
  if (value === null) return null;
  const match = /:(\d+)$/.exec(value);
  if (match === null) return null;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function scalar(content: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}:\\s*["']?([^"'\\s#]+)`, 'm').exec(content);
  return match?.[1] ?? null;
}

function validateTunnelId(value: string, name: string): void {
  if (!TUNNEL_ID_PATTERN.test(value)) throw new RuntimeError('INVALID_REQUEST', `${name} is not a valid tunnel ID`);
}

function normalizeRegistry(value: unknown, dataRoot: string): { readonly registry: ConnectorRegistryDocument; readonly changed: boolean; readonly staleConnectorIds: readonly string[] } {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || !isPositiveSafeInteger(value.deploymentEpoch)
    || typeof value.updatedAt !== 'string' || !Array.isArray(value.connectors) || value.connectors.length !== 2) {
    throw new Error('invalid registry schema');
  }
  const deploymentEpoch = value.deploymentEpoch as number;
  const ids = new Set<string>();
  const validShape = value.connectors.every((candidate): candidate is RawConnectorBinding => {
    if (!isRawConnector(candidate) || ids.has(candidate.connectorId)) return false;
    ids.add(candidate.connectorId);
    return (candidate.label === 'IRIS FULL' || candidate.label === 'IRIS PRO')
      && (candidate.mode === 'FULL' || candidate.mode === 'PRO')
      && typeof candidate.tunnelId === 'string' && TUNNEL_ID_PATTERN.test(candidate.tunnelId)
      && candidate.runtime === 'iris-local-runtime'
      && ((candidate.mode === 'FULL' && candidate.mcpProfile === 'FULL') || (candidate.mode === 'PRO' && candidate.mcpProfile === 'READ_ONLY'))
      && (candidate.mcpPath === '/mcp' || candidate.mcpPath === '/mcp-pro')
      && isPort(candidate.healthPort)
      && typeof candidate.managedProfilePath === 'string' && path.isAbsolute(candidate.managedProfilePath)
      && samePhysicalPath(candidate.managedProfilePath, path.join(dataRoot, 'tunnel-profiles', `${candidate.connectorId}.yaml`))
      && (candidate.runtimeId === null || isRuntimeId(candidate.runtimeId))
      && (candidate.deploymentEpoch === undefined || (isPositiveSafeInteger(candidate.deploymentEpoch) && candidate.deploymentEpoch === value.deploymentEpoch));
  });
  const rawConnectors = value.connectors.filter(isRawConnector);
  const full = rawConnectors.find((candidate) => candidate.connectorId === 'iris-full');
  const pro = rawConnectors.find((candidate) => candidate.connectorId === 'iris-pro');
  if (!validShape || !isExpectedBinding(full, 'iris-full', 'IRIS FULL', 'FULL', '/mcp')
    || !isExpectedBinding(pro, 'iris-pro', 'IRIS PRO', 'PRO', '/mcp-pro')) {
    throw new Error('invalid connector identity');
  }
  const fullTools = fullMcpToolNames();
  const proTools = [...PRO_TOOL_NAMES];
  const currentTools = new Map([
    ['iris-full', { names: fullTools, hash: catalogIdentity('FULL', fullMcpToolDefinitionsV21()).catalogHash }],
    ['iris-pro', { names: proTools, hash: catalogIdentity('PRO', proMcpToolDefinitions()).catalogHash }],
  ]);
  const connectors = rawConnectors.map((candidate) => {
    const current = currentTools.get(candidate.connectorId)!;
    return {
      connectorId: candidate.connectorId,
      label: candidate.label,
      mode: candidate.mode,
      tunnelId: candidate.tunnelId,
      runtime: candidate.runtime,
      mcpProfile: candidate.mcpProfile,
      mcpPath: candidate.mcpPath,
      expectedToolNames: current.names,
      catalogFingerprint: catalogFingerprint(current.names),
      catalogHash: current.hash,
      healthPort: candidate.healthPort,
      managedProfilePath: candidate.managedProfilePath,
      runtimeId: candidate.runtimeId ?? null,
      deploymentEpoch,
    } satisfies ConnectorBinding;
  });
  const registry: ConnectorRegistryDocument = {
    schemaVersion: 2,
    deploymentEpoch,
    updatedAt: value.updatedAt,
    connectors,
  };
  const staleConnectorIds = rawConnectors.filter((candidate) => {
    const current = registry.connectors.find((connector) => connector.connectorId === candidate.connectorId)!;
    return !Array.isArray(candidate.expectedToolNames)
      || candidate.expectedToolNames.length !== current.expectedToolNames.length
      || candidate.expectedToolNames.some((name, index) => name !== current.expectedToolNames[index])
      || candidate.catalogFingerprint !== current.catalogFingerprint
      || candidate.catalogHash !== current.catalogHash
      || candidate.deploymentEpoch !== deploymentEpoch;
  }).map((candidate) => candidate.connectorId);
  return { registry, changed: value.schemaVersion !== 2 || staleConnectorIds.length > 0, staleConnectorIds };
}

function isRawConnector(value: unknown): value is RawConnectorBinding {
  return isRecord(value)
    && typeof value.connectorId === 'string'
    && (value.label === 'IRIS FULL' || value.label === 'IRIS PRO')
    && (value.mode === 'FULL' || value.mode === 'PRO')
    && typeof value.tunnelId === 'string'
    && value.runtime === 'iris-local-runtime'
    && (value.mcpProfile === 'FULL' || value.mcpProfile === 'READ_ONLY')
    && (value.mcpPath === '/mcp' || value.mcpPath === '/mcp-pro')
    && isPort(value.healthPort)
    && typeof value.managedProfilePath === 'string'
    && (value.runtimeId === undefined || value.runtimeId === null || isRuntimeId(value.runtimeId));
}

function isExpectedBinding(value: RawConnectorBinding | undefined, connectorId: string, label: string, mode: string, mcpPath: string): boolean {
  return value !== undefined && value.connectorId === connectorId && value.label === label && value.mode === mode && value.mcpPath === mcpPath;
}

export function catalogFingerprint(tools: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex');
}

function samePhysicalPath(left: string, right: string): boolean {
  return canonicalExistingPath(left) === canonicalExistingPath(right);
}

function canonicalExistingPath(filename: string): string {
  const suffix: string[] = [];
  let current = path.resolve(filename);
  for (;;) {
    try { return path.join(realpathSync(current), ...suffix.reverse()); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(filename);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRuntimeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
