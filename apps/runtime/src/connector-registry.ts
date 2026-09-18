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
import { loadOrCreateMachineId } from './machine-identity.js';

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
  readonly machineId: string | null;
  readonly runtimeId: string | null;
  readonly deploymentEpoch: number;
  readonly leaseGeneration: number;
}

export interface AdminConnectorBinding {
  readonly connectorId: 'iris-admin';
  readonly label: 'IRIS ADMIN';
  readonly mode: 'ADMIN';
  readonly tunnelId: string;
  readonly managedProfilePath: string;
  readonly machineId: string | null;
  readonly leaseGeneration: number;
}

export interface ConnectorRegistryDocument {
  readonly schemaVersion: 3;
  readonly deploymentEpoch: number;
  readonly updatedAt: string;
  readonly connectors: readonly ConnectorBinding[];
  readonly admin: AdminConnectorBinding | null;
}

export interface ConnectorRegistryReconciliation {
  readonly registry: ConnectorRegistryDocument;
  readonly changed: boolean;
  readonly previousDeploymentEpoch: number;
}

export interface ConnectorCatalogProfileManifest {
  readonly expectedToolNames: readonly string[];
  readonly catalogHash: string;
}

export interface ConnectorCatalogManifest {
  readonly full: ConnectorCatalogProfileManifest;
  readonly pro: ConnectorCatalogProfileManifest;
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
  readonly machineId?: string | null;
  readonly runtimeId?: string | null;
  readonly deploymentEpoch?: unknown;
  readonly leaseGeneration?: unknown;
}

interface RawAdminConnectorBinding {
  readonly connectorId: 'iris-admin';
  readonly label: 'IRIS ADMIN';
  readonly mode: 'ADMIN';
  readonly tunnelId: string;
  readonly managedProfilePath: string;
  readonly machineId?: string | null;
  readonly leaseGeneration?: unknown;
}

export interface ConnectorSeed {
  readonly fullTunnelId: string;
  readonly proTunnelId: string;
  readonly adminTunnelId?: string;
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
  const currentTools = new Map([
    ['iris-full', { names: fullMcpToolNames(), hash: catalogIdentity('FULL', fullMcpToolDefinitionsV21()).catalogHash }],
    ['iris-pro', { names: [...PRO_TOOL_NAMES], hash: catalogIdentity('PRO', proMcpToolDefinitions()).catalogHash }],
  ]);
  const registry: ConnectorRegistryDocument = {
    ...parsed.registry,
    schemaVersion: 3,
    deploymentEpoch,
    updatedAt: new Date().toISOString(),
    connectors: parsed.registry.connectors.map((connector) => {
      const current = currentTools.get(connector.connectorId);
      if (current === undefined) throw new RuntimeError('PERSISTENCE_FAILURE', 'Connector catalog reconciliation encountered an unknown connector identity');
      return {
        ...connector,
        expectedToolNames: current.names,
        catalogFingerprint: catalogFingerprint(current.names),
        catalogHash: current.hash,
        deploymentEpoch,
      };
    }),
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
    return normalizeRegistry(value, dataRoot);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'IRIS connector registry is invalid', { cause: error });
  }
}

export async function initializeConnectorRegistry(dataRoot: string, seed: ConnectorSeed): Promise<ConnectorRegistryDocument> {
  const existing = await readConnectorRegistry(dataRoot);
  if (existing !== null) return existing;
  validateSeedTunnelIds(seed);
  const machineId = await loadOrCreateMachineId(dataRoot);
  const document = createConnectorRegistry(dataRoot, seed, 1, machineId, 1);
  await writePrivateJsonAtomic(connectorRegistryPath(dataRoot), document);
  return document;
}

export function createConnectorRegistry(
  dataRoot: string,
  seed: ConnectorSeed,
  deploymentEpoch: number,
  machineId: string | null = null,
  leaseGeneration = machineId === null ? 0 : 1,
): ConnectorRegistryDocument {
  validateSeedTunnelIds(seed);
  if (!Number.isSafeInteger(deploymentEpoch) || deploymentEpoch <= 0) throw new RuntimeError('INVALID_REQUEST', 'Connector deployment epoch is invalid');
  if (machineId !== null && !isUuid(machineId)) throw new RuntimeError('INVALID_REQUEST', 'Connector machine identity is invalid');
  if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 0 || (machineId === null && leaseGeneration !== 0) || (machineId !== null && leaseGeneration <= 0)) {
    throw new RuntimeError('INVALID_REQUEST', 'Connector lease generation is invalid');
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    deploymentEpoch,
    updatedAt: now,
    connectors: [
      {
        connectorId: 'iris-full', label: 'IRIS FULL', mode: 'FULL', tunnelId: seed.fullTunnelId,
        runtime: 'iris-local-runtime', mcpProfile: 'FULL', mcpPath: '/mcp', expectedToolNames: fullMcpToolNames(), catalogFingerprint: catalogFingerprint(fullMcpToolNames()), catalogHash: catalogIdentity('FULL', fullMcpToolDefinitionsV21()).catalogHash,
        healthPort: seed.fullHealthPort ?? 8080, managedProfilePath: path.join(dataRoot, 'tunnel-profiles', 'iris-full.yaml'),
        machineId, runtimeId: null, deploymentEpoch, leaseGeneration,
      },
      {
        connectorId: 'iris-pro', label: 'IRIS PRO', mode: 'PRO', tunnelId: seed.proTunnelId,
        runtime: 'iris-local-runtime', mcpProfile: 'READ_ONLY', mcpPath: '/mcp-pro', expectedToolNames: [...PRO_TOOL_NAMES], catalogFingerprint: catalogFingerprint(PRO_TOOL_NAMES), catalogHash: catalogIdentity('PRO', proMcpToolDefinitions()).catalogHash,
        healthPort: seed.proHealthPort ?? 8081, managedProfilePath: path.join(dataRoot, 'tunnel-profiles', 'iris-pro.yaml'),
        machineId, runtimeId: null, deploymentEpoch, leaseGeneration,
      },
    ],
    admin: seed.adminTunnelId === undefined ? null : {
      connectorId: 'iris-admin',
      label: 'IRIS ADMIN',
      mode: 'ADMIN',
      tunnelId: seed.adminTunnelId,
      managedProfilePath: path.join(dataRoot, 'tunnel-profiles', 'iris-admin.yaml'),
      machineId,
      leaseGeneration,
    },
  };
}

export async function updateConnectorRuntime(dataRoot: string, runtimeId: string): Promise<ConnectorRegistryDocument> {
  return bindConnectorRuntime(dataRoot, runtimeId);
}

export async function bindAdminTunnelIdentity(dataRoot: string, tunnelId: string): Promise<ConnectorRegistryDocument> {
  validateTunnelId(tunnelId, 'adminTunnelId');
  const current = await requireConnectorRegistry(dataRoot);
  if (current.connectors.some((connector) => connector.tunnelId === tunnelId)) {
    throw new RuntimeError('PRECONDITION_FAILED', 'ADMIN tunnel identity must be distinct from FULL and PRO tunnel identities');
  }
  const machineId = await loadOrCreateMachineId(dataRoot);
  if (!isUuid(machineId)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Local machine identity is invalid');
  if (current.admin !== null) {
    if (current.admin.machineId !== null && current.admin.machineId !== machineId) {
      throw new RuntimeError('TUNNEL_OWNERSHIP_CONFLICT', `Tunnel ${current.admin.tunnelId} is fenced to another machine identity; refusing takeover`);
    }
    if (current.admin.tunnelId !== tunnelId) {
      throw new RuntimeError('PRECONDITION_FAILED', 'A dedicated ADMIN tunnel identity is already bound; replacement requires an explicit migration');
    }
    if (current.admin.machineId === machineId && current.admin.leaseGeneration > 0) return current;
  }
  const next: ConnectorRegistryDocument = {
    ...current,
    updatedAt: new Date().toISOString(),
    admin: {
      connectorId: 'iris-admin',
      label: 'IRIS ADMIN',
      mode: 'ADMIN',
      tunnelId,
      managedProfilePath: path.join(dataRoot, 'tunnel-profiles', 'iris-admin.yaml'),
      machineId,
      leaseGeneration: nextLeaseGeneration(current.admin?.leaseGeneration ?? 0),
    },
  };
  await writePrivateJsonAtomic(connectorRegistryPath(dataRoot), next);
  return next;
}

export async function advanceConnectorDeploymentEpoch(dataRoot: string): Promise<ConnectorRegistryDocument> {
  const current = await requireConnectorRegistry(dataRoot);
  const deploymentEpoch = current.deploymentEpoch + 1;
  if (!Number.isSafeInteger(deploymentEpoch) || deploymentEpoch <= 0) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'IRIS connector deployment epoch overflowed');
  }
  const next: ConnectorRegistryDocument = {
    ...current,
    deploymentEpoch,
    updatedAt: new Date().toISOString(),
    connectors: current.connectors.map((connector) => ({ ...connector, deploymentEpoch })),
  };
  await writePrivateJsonAtomic(connectorRegistryPath(dataRoot), next);
  return next;
}

export async function replaceConnectorCatalogManifest(
  dataRoot: string,
  manifest: ConnectorCatalogManifest,
): Promise<ConnectorRegistryDocument> {
  validateCatalogProfileManifest(manifest.full, 'FULL');
  validateCatalogProfileManifest(manifest.pro, 'PRO');
  const current = await requireConnectorRegistry(dataRoot);
  const deploymentEpoch = current.deploymentEpoch + 1;
  if (!Number.isSafeInteger(deploymentEpoch) || deploymentEpoch <= 0) {
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Connector deployment epoch overflowed');
  }
  const next: ConnectorRegistryDocument = {
    ...current,
    deploymentEpoch,
    updatedAt: new Date().toISOString(),
    connectors: current.connectors.map((connector) => {
      const target = connector.mode === 'FULL' ? manifest.full : manifest.pro;
      const expectedToolNames = [...target.expectedToolNames];
      return {
        ...connector,
        expectedToolNames,
        catalogFingerprint: catalogFingerprint(expectedToolNames),
        catalogHash: target.catalogHash,
        deploymentEpoch,
      };
    }),
  };
  await writePrivateJsonAtomic(connectorRegistryPath(dataRoot), next);
  return next;
}

export async function bindConnectorRuntime(dataRoot: string, runtimeId: string, machineIdOverride?: string): Promise<ConnectorRegistryDocument> {
  const current = await requireConnectorRegistry(dataRoot);
  const machineId = machineIdOverride ?? await loadOrCreateMachineId(dataRoot);
  if (!isUuid(machineId)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Local machine identity is invalid');
  const foreign = current.connectors.find((connector) => connector.machineId !== null && connector.machineId !== machineId);
  if (foreign !== undefined) {
    throw new RuntimeError('TUNNEL_OWNERSHIP_CONFLICT', `Tunnel ${foreign.tunnelId} is fenced to another machine identity; refusing takeover`);
  }
  if (current.admin !== null && current.admin.machineId !== null && current.admin.machineId !== machineId) {
    throw new RuntimeError('TUNNEL_OWNERSHIP_CONFLICT', `Tunnel ${current.admin.tunnelId} is fenced to another machine identity; refusing takeover`);
  }
  if (current.connectors.every((connector) => connector.machineId === machineId && connector.runtimeId === runtimeId && connector.leaseGeneration > 0)) return current;
  const deploymentEpoch = current.deploymentEpoch + 1;
  if (!Number.isSafeInteger(deploymentEpoch) || deploymentEpoch <= 0) throw new RuntimeError('PERSISTENCE_FAILURE', 'Connector deployment epoch overflowed');
  const next: ConnectorRegistryDocument = {
    ...current,
    schemaVersion: 3,
    deploymentEpoch,
    updatedAt: new Date().toISOString(),
    connectors: current.connectors.map((connector) => ({
      ...connector,
      machineId,
      runtimeId,
      deploymentEpoch,
      leaseGeneration: nextLeaseGeneration(connector.leaseGeneration),
    })),
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

function validateSeedTunnelIds(seed: ConnectorSeed): void {
  validateTunnelId(seed.fullTunnelId, 'fullTunnelId');
  validateTunnelId(seed.proTunnelId, 'proTunnelId');
  if (seed.fullTunnelId === seed.proTunnelId) {
    throw new RuntimeError('INVALID_REQUEST', 'FULL and PRO tunnel identities must be distinct');
  }
  if (seed.adminTunnelId !== undefined) {
    validateTunnelId(seed.adminTunnelId, 'adminTunnelId');
    if (seed.adminTunnelId === seed.fullTunnelId || seed.adminTunnelId === seed.proTunnelId) {
      throw new RuntimeError('INVALID_REQUEST', 'ADMIN tunnel identity must be distinct from FULL and PRO tunnel identities');
    }
  }
}

function validateTunnelId(value: string, name: string): void {
  if (!TUNNEL_ID_PATTERN.test(value)) throw new RuntimeError('INVALID_REQUEST', `${name} is not a valid tunnel ID`);
}

function normalizeRegistry(value: unknown, dataRoot: string): { readonly registry: ConnectorRegistryDocument; readonly changed: boolean; readonly staleConnectorIds: readonly string[] } {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) || !isPositiveSafeInteger(value.deploymentEpoch)
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
      && (candidate.machineId === undefined || candidate.machineId === null || isUuid(candidate.machineId))
      && (candidate.runtimeId === undefined || candidate.runtimeId === null || isRuntimeId(candidate.runtimeId))
      && (candidate.deploymentEpoch === undefined || (isPositiveSafeInteger(candidate.deploymentEpoch) && candidate.deploymentEpoch === deploymentEpoch))
      && (candidate.leaseGeneration === undefined || isNonNegativeSafeInteger(candidate.leaseGeneration));
  });
  const rawConnectors = value.connectors.filter(isRawConnector);
  const full = rawConnectors.find((candidate) => candidate.connectorId === 'iris-full');
  const pro = rawConnectors.find((candidate) => candidate.connectorId === 'iris-pro');
  const rawAdmin = value.admin === undefined || value.admin === null ? null : isRawAdminConnector(value.admin) ? value.admin : undefined;
  if (!validShape || full === undefined || pro === undefined
    || !isExpectedBinding(full, 'iris-full', 'IRIS FULL', 'FULL', '/mcp')
    || !isExpectedBinding(pro, 'iris-pro', 'IRIS PRO', 'PRO', '/mcp-pro') || rawAdmin === undefined) {
    throw new Error('invalid connector identity');
  }
  if (rawAdmin !== null) {
    if (rawAdmin.tunnelId === full.tunnelId || rawAdmin.tunnelId === pro.tunnelId) throw new Error('admin tunnel identity overlaps workload connector');
    if (!path.isAbsolute(rawAdmin.managedProfilePath)
      || !samePhysicalPath(rawAdmin.managedProfilePath, path.join(dataRoot, 'tunnel-profiles', 'iris-admin.yaml'))) {
      throw new Error('invalid admin connector profile path');
    }
  }
  const ownedMachines = new Set([
    ...rawConnectors.flatMap((candidate) => candidate.machineId === undefined || candidate.machineId === null ? [] : [candidate.machineId]),
    ...(rawAdmin === null || rawAdmin.machineId === undefined || rawAdmin.machineId === null ? [] : [rawAdmin.machineId]),
  ]);
  if (ownedMachines.size > 1) throw new Error('split connector machine identity');
  const fullTools = fullMcpToolNames();
  const proTools = [...PRO_TOOL_NAMES];
  const currentTools = new Map([
    ['iris-full', { names: fullTools, hash: catalogIdentity('FULL', fullMcpToolDefinitionsV21()).catalogHash }],
    ['iris-pro', { names: proTools, hash: catalogIdentity('PRO', proMcpToolDefinitions()).catalogHash }],
  ]);
  const connectors = rawConnectors.map((candidate) => {
    const current = currentTools.get(candidate.connectorId)!;
    const machineId = candidate.machineId ?? null;
    const leaseGeneration = candidate.leaseGeneration === undefined ? (machineId === null ? 0 : 1) : Number(candidate.leaseGeneration);
    if ((machineId === null && leaseGeneration !== 0) || (machineId !== null && leaseGeneration <= 0)) throw new Error('invalid connector fencing identity');
    const expectedToolNames = isCatalogToolNameArray(candidate.expectedToolNames) ? [...candidate.expectedToolNames] : current.names;
    const catalogFingerprintValue = typeof candidate.catalogFingerprint === 'string' && /^[0-9a-f]{64}$/.test(candidate.catalogFingerprint)
      ? candidate.catalogFingerprint
      : catalogFingerprint(expectedToolNames);
    const catalogHash = typeof candidate.catalogHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(candidate.catalogHash)
      ? candidate.catalogHash
      : current.hash;
    return {
      connectorId: candidate.connectorId,
      label: candidate.label,
      mode: candidate.mode,
      tunnelId: candidate.tunnelId,
      runtime: candidate.runtime,
      mcpProfile: candidate.mcpProfile,
      mcpPath: candidate.mcpPath,
      expectedToolNames,
      catalogFingerprint: catalogFingerprintValue,
      catalogHash,
      healthPort: candidate.healthPort,
      managedProfilePath: candidate.managedProfilePath,
      machineId,
      runtimeId: candidate.runtimeId ?? null,
      deploymentEpoch,
      leaseGeneration,
    } satisfies ConnectorBinding;
  });
  const admin: AdminConnectorBinding | null = rawAdmin === null ? null : (() => {
    const machineId = rawAdmin.machineId ?? null;
    const leaseGeneration = rawAdmin.leaseGeneration === undefined ? (machineId === null ? 0 : 1) : Number(rawAdmin.leaseGeneration);
    if ((machineId === null && leaseGeneration !== 0) || (machineId !== null && leaseGeneration <= 0)) throw new Error('invalid admin connector fencing identity');
    return {
      connectorId: 'iris-admin',
      label: 'IRIS ADMIN',
      mode: 'ADMIN',
      tunnelId: rawAdmin.tunnelId,
      managedProfilePath: rawAdmin.managedProfilePath,
      machineId,
      leaseGeneration,
    };
  })();
  const registry: ConnectorRegistryDocument = {
    schemaVersion: 3,
    deploymentEpoch,
    updatedAt: value.updatedAt,
    connectors,
    admin,
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
  const ownershipMigrationRequired = value.schemaVersion !== 3
    || rawConnectors.some((candidate) => candidate.machineId === undefined || candidate.leaseGeneration === undefined);
  return { registry, changed: ownershipMigrationRequired || staleConnectorIds.length > 0, staleConnectorIds };
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
    && (value.machineId === undefined || value.machineId === null || isUuid(value.machineId))
    && (value.runtimeId === undefined || value.runtimeId === null || isRuntimeId(value.runtimeId));
}

function isCatalogToolNameArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  const names = value.filter((item): item is string => typeof item === 'string');
  return names.length === value.length
    && new Set(names).size === names.length
    && names.every((name) => name.length > 0 && name.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(name));
}

function validateCatalogProfileManifest(manifest: ConnectorCatalogProfileManifest, label: string): void {
  if (!isCatalogToolNameArray(manifest.expectedToolNames) || manifest.expectedToolNames.length === 0) {
    throw new RuntimeError('INVALID_REQUEST', `${label} catalog tool manifest is invalid`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(manifest.catalogHash)) {
    throw new RuntimeError('INVALID_REQUEST', `${label} catalog hash is invalid`);
  }
}

function isRawAdminConnector(value: unknown): value is RawAdminConnectorBinding {
  return isRecord(value)
    && value.connectorId === 'iris-admin'
    && value.label === 'IRIS ADMIN'
    && value.mode === 'ADMIN'
    && typeof value.tunnelId === 'string' && TUNNEL_ID_PATTERN.test(value.tunnelId)
    && typeof value.managedProfilePath === 'string'
    && (value.machineId === undefined || value.machineId === null || isUuid(value.machineId))
    && (value.leaseGeneration === undefined || isNonNegativeSafeInteger(value.leaseGeneration));
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

function nextLeaseGeneration(current: number): number {
  const next = current + 1;
  if (!Number.isSafeInteger(next) || next <= 0) throw new RuntimeError('PERSISTENCE_FAILURE', 'Connector lease generation overflowed');
  return next;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRuntimeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
