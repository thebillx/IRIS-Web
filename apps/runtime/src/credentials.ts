import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { inspectPrivateRegularFile, privateDirectoryProblem } from './private-fs.js';

const CREDENTIALS_DIRECTORY = 'credentials';
const CONTROL_PLANE_KEY_FILE = 'control-plane-api-key';
const TUNNEL_SERVICE_AUTHORIZATION_FILE = 'tunnel-service-authorization';
const TUNNEL_SERVICE_METADATA_FILE = 'tunnel-service.json';

export const TUNNEL_SERVICE_PRINCIPAL = 'iris-tunnel-service' as const;

interface TunnelServiceMetadata {
  readonly schemaVersion: 1;
  readonly principal: typeof TUNNEL_SERVICE_PRINCIPAL;
  readonly generation: number;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
}

export interface CredentialPaths {
  readonly directory: string;
  readonly controlPlaneApiKey: string;
  readonly tunnelServiceAuthorization: string;
  readonly tunnelServiceMetadata: string;
}

export interface LegacyConfigStatus {
  readonly detected: boolean;
  readonly paths: readonly string[];
  readonly migrationRequired: boolean;
}

export interface CredentialStatus {
  readonly controlPlaneApiKeyPresent: boolean;
  readonly tunnelServicePresent: boolean;
  readonly tunnelServiceGeneration: number | null;
  readonly legacy: LegacyConfigStatus;
}

export function credentialPaths(dataRoot: string): CredentialPaths {
  const directory = path.join(dataRoot, CREDENTIALS_DIRECTORY);
  return {
    directory,
    controlPlaneApiKey: path.join(directory, CONTROL_PLANE_KEY_FILE),
    tunnelServiceAuthorization: path.join(directory, TUNNEL_SERVICE_AUTHORIZATION_FILE),
    tunnelServiceMetadata: path.join(directory, TUNNEL_SERVICE_METADATA_FILE),
  };
}

export async function ensureCredentialDirectory(dataRoot: string): Promise<CredentialPaths> {
  const paths = credentialPaths(dataRoot);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const problem = await privateDirectoryProblem(paths.directory, 'IRIS credential directory');
  if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
  return paths;
}

export async function loadOrCreateTunnelServiceSecret(dataRoot: string): Promise<string> {
  const paths = await ensureCredentialDirectory(dataRoot);
  const existing = await readTunnelServiceSecret(dataRoot);
  if (existing !== null) return existing;

  const secret = randomBytes(32).toString('base64url');
  const createdAt = new Date().toISOString();
  const created = await createPrivateFile(paths.tunnelServiceAuthorization, `Bearer ${secret}\n`, 'tunnel service credential');
  if (!created) {
    const concurrent = await readTunnelServiceSecret(dataRoot);
    if (concurrent === null) throw new RuntimeError('CREDENTIAL_INVALID', 'Tunnel service credential was created concurrently but is unreadable');
    return concurrent;
  }
  try {
    await writePrivateJsonAtomic(paths.tunnelServiceMetadata, {
      schemaVersion: 1,
      principal: TUNNEL_SERVICE_PRINCIPAL,
      generation: 1,
      createdAt,
      rotatedAt: null,
    } satisfies TunnelServiceMetadata);
  } catch (error) {
    await rm(paths.tunnelServiceAuthorization, { force: true }).catch(() => undefined);
    throw error;
  }
  return secret;
}

export async function readTunnelServiceSecret(dataRoot: string): Promise<string | null> {
  const paths = credentialPaths(dataRoot);
  const inspected = await inspectPrivateRegularFile(paths.tunnelServiceAuthorization, 'IRIS tunnel service credential');
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('CREDENTIAL_INVALID', inspected.reason);
  const value = inspected.content.trim();
  if (!value.startsWith('Bearer ')) throw new RuntimeError('CREDENTIAL_INVALID', 'IRIS tunnel service credential is not a bearer value');
  const secret = value.slice('Bearer '.length).trim();
  if (!isPrivateSecret(secret)) throw new RuntimeError('CREDENTIAL_INVALID', 'IRIS tunnel service credential is invalid');
  return secret;
}

export async function rotateTunnelServiceSecret(dataRoot: string): Promise<void> {
  const paths = await ensureCredentialDirectory(dataRoot);
  const current = await readTunnelServiceSecret(dataRoot);
  if (current === null) {
    await loadOrCreateTunnelServiceSecret(dataRoot);
    return;
  }
  const metadata = await readTunnelServiceMetadata(dataRoot);
  const next = randomBytes(32).toString('base64url');
  await writePrivateFileAtomic(paths.tunnelServiceAuthorization, `Bearer ${next}\n`);
  await writePrivateJsonAtomic(paths.tunnelServiceMetadata, {
    ...metadata,
    generation: metadata.generation + 1,
    rotatedAt: new Date().toISOString(),
  } satisfies TunnelServiceMetadata);
}

export async function readControlPlaneApiKey(dataRoot: string): Promise<string | null> {
  const paths = credentialPaths(dataRoot);
  const inspected = await inspectPrivateRegularFile(paths.controlPlaneApiKey, 'Control-plane API key');
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'invalid') throw new RuntimeError('CREDENTIAL_INVALID', inspected.reason);
  const value = inspected.content.trim();
  if (!isCredentialValue(value)) throw new RuntimeError('CREDENTIAL_INVALID', 'Control-plane API key is invalid');
  return value;
}

export async function persistControlPlaneApiKey(dataRoot: string, value: string): Promise<void> {
  const paths = await ensureCredentialDirectory(dataRoot);
  const normalized = value.trim();
  if (!isCredentialValue(normalized)) throw new RuntimeError('CREDENTIAL_INVALID', 'Control-plane API key is invalid');
  await writePrivateFileAtomic(paths.controlPlaneApiKey, `${normalized}\n`);
}

export async function writePrivateTextAtomic(filename: string, content: string): Promise<void> {
  await writePrivateFileAtomic(filename, content);
}

export async function inspectCredentialStatus(dataRoot: string, environment: NodeJS.ProcessEnv = process.env): Promise<CredentialStatus> {
  const controlPlaneApiKey = await readControlPlaneApiKey(dataRoot);
  const tunnelService = await readTunnelServiceSecret(dataRoot);
  const legacy = await detectLegacyConfig(environment);
  let generation: number | null = null;
  if (tunnelService !== null) generation = (await readTunnelServiceMetadata(dataRoot)).generation;
  return {
    controlPlaneApiKeyPresent: controlPlaneApiKey !== null,
    tunnelServicePresent: tunnelService !== null,
    tunnelServiceGeneration: generation,
    legacy: { ...legacy, migrationRequired: !controlPlaneApiKey && legacy.detected },
  };
}

export async function migrateLegacyCredentials(dataRoot: string, environment: NodeJS.ProcessEnv = process.env): Promise<CredentialStatus> {
  const value = environment.CONTROL_PLANE_API_KEY?.trim();
  if (value === undefined || !isCredentialValue(value)) {
    throw new RuntimeError('CREDENTIAL_MISSING', 'CONTROL_PLANE_API_KEY must be supplied for explicit credential migration');
  }
  await persistControlPlaneApiKey(dataRoot, value);
  await loadOrCreateTunnelServiceSecret(dataRoot);
  return inspectCredentialStatus(dataRoot, environment);
}

export async function migrateLegacyProfileCredential(dataRoot: string, profilePath: string, environment: NodeJS.ProcessEnv = process.env): Promise<CredentialStatus> {
  const configuredHome = environment.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  const absolutePath = path.isAbsolute(profilePath) ? profilePath : path.join(configuredHome, 'tunnel-client', profilePath);
  const content = await readFile(absolutePath, 'utf8').catch(() => null);
  if (content === null) throw new RuntimeError('MIGRATION_REQUIRED', 'The selected tunnel profile does not exist');
  const value = legacyScalar(content, 'api_key');
  if (value === null) throw new RuntimeError('CREDENTIAL_MISSING', 'The selected tunnel profile has no control-plane api_key');
  if (value.startsWith('env:') || value.startsWith('file:')) {
    throw new RuntimeError('MIGRATION_REQUIRED', 'Resolve the selected profile credential explicitly before migration; references are not copied automatically');
  }
  await persistControlPlaneApiKey(dataRoot, value);
  await loadOrCreateTunnelServiceSecret(dataRoot);
  return inspectCredentialStatus(dataRoot, environment);
}

async function detectLegacyConfig(environment: NodeJS.ProcessEnv): Promise<LegacyConfigStatus> {
  const configHome = environment.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  const paths = [path.join(configHome, 'tunnel-client', 'iris.yaml'), path.join(configHome, 'tunnel-client', 'iris-pro.yaml')];
  const detected: string[] = [];
  for (const filename of paths) {
    const content = await readFile(filename, 'utf8').catch(() => null);
    if (content !== null && /(?:env:CONTROL_PLANE_API_KEY|env:IRIS_OWNER_AUTH_HEADER|^\s*api_key:\s*(?!env:|file:)|^\s*Authorization:\s*(?!env:|file:))/m.test(content)) detected.push(filename);
  }
  return { detected: detected.length > 0, paths: detected, migrationRequired: false };
}

async function readTunnelServiceMetadata(dataRoot: string): Promise<TunnelServiceMetadata> {
  const paths = credentialPaths(dataRoot);
  const inspected = await inspectPrivateRegularFile(paths.tunnelServiceMetadata, 'IRIS tunnel service metadata');
  if (inspected.state !== 'ok') throw new RuntimeError('CREDENTIAL_INVALID', inspected.state === 'missing' ? 'IRIS tunnel service metadata is missing' : inspected.reason);
  try {
    const value = JSON.parse(inspected.content) as unknown;
    if (!isTunnelServiceMetadata(value)) throw new Error('invalid metadata');
    return value;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('CREDENTIAL_INVALID', 'IRIS tunnel service metadata is invalid', { cause: error });
  }
}

async function createPrivateFile(filename: string, content: string, label: string): Promise<boolean> {
  try {
    const handle = await open(filename, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw new RuntimeError('PERSISTENCE_FAILURE', `Could not create ${label}`, { cause: error });
  }
  return true;
}

async function writePrivateFileAtomic(filename: string, content: string): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Private credential publication failed', { cause: error });
  }
}

export async function writePrivateJsonAtomic(filename: string, value: unknown): Promise<void> {
  await writePrivateFileAtomic(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function isTunnelServiceMetadata(value: unknown): value is TunnelServiceMetadata {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.principal === TUNNEL_SERVICE_PRINCIPAL
    && isPositiveSafeInteger(value.generation)
    && typeof value.createdAt === 'string'
    && (value.rotatedAt === null || typeof value.rotatedAt === 'string');
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPrivateSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,128}$/.test(value);
}

function isCredentialValue(value: string): boolean {
  return value.length >= 20 && value.length <= 4_096 && !/[\0\r\n]/.test(value);
}

function legacyScalar(content: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))\\s*$`, 'm').exec(content);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
