import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { ensureCredentialDirectory, writePrivateJsonAtomic } from '../credentials.js';
import { inspectPrivateRegularFile, privateDirectoryProblem } from '../private-fs.js';
import type { AdoReadGrant } from './governance.js';
import type { BoardIdentity } from './discovery.js';
import type { Resource } from './adapter.js';

export interface AdoRuntimeBinding {
  readonly schemaVersion: 1;
  readonly irisProjectId: string;
  readonly connectorBindingId: string;
  readonly credentialRef: string;
  readonly sessionRef: string;
  readonly organization: { readonly id: string; readonly name: string };
  readonly project: { readonly id: string; readonly name: string };
  readonly team: { readonly id: string; readonly name: string };
  readonly board: { readonly id: string; readonly name: string };
  readonly network: 'allowed' | 'disabled';
  readonly expiresAt: string;
  readonly revoked: boolean;
  readonly tokenScopes: readonly ['vso.work'];
  readonly resources: readonly Resource[];
  readonly limits: {
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
    readonly maxPageItems: number;
    readonly maxPages: number;
    readonly maxBatchItems: number;
    readonly rateLimitRequests: number;
    readonly rateLimitWindowMs: number;
    readonly maxRetryAfterMs: number;
  };
}

interface AdoCredentialRecord {
  readonly schemaVersion: 1;
  readonly credentialRef: string;
  readonly kind: 'PAT' | 'BEARER';
  readonly secret: string;
}

export interface ResolvedAdoRuntimeBinding {
  readonly identity: BoardIdentity;
  readonly grant: AdoReadGrant;
  readonly organizationName: string;
  readonly projectName: string;
  readonly auth: { readonly kind: 'PAT' | 'BEARER'; readonly secret: string };
}

export interface AdoRuntimeBindingProvider {
  resolve(projectId: string): Promise<ResolvedAdoRuntimeBinding>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ALLOWED_RESOURCES = new Set<Resource>(['board', 'scope', 'backlogs', 'query', 'workItems', 'comments', 'links']);
const BINDING_KEYS = new Set([
  'schemaVersion','irisProjectId','connectorBindingId','credentialRef','sessionRef',
  'organization','project','team','board','network','expiresAt','revoked',
  'tokenScopes','resources','limits',
]);
const LIMIT_KEYS = new Set([
  'timeoutMs','maxResponseBytes','maxPageItems','maxPages','maxBatchItems',
  'rateLimitRequests','rateLimitWindowMs','maxRetryAfterMs',
]);
const CREDENTIAL_KEYS = new Set(['schemaVersion','credentialRef','kind','secret']);
const IDENTITY_KEYS = new Set(['id','name']);

export class FileAdoRuntimeBindingProvider implements AdoRuntimeBindingProvider {
  public constructor(private readonly dataRoot: string) {}

  public async resolve(projectId: string): Promise<ResolvedAdoRuntimeBinding> {
    if (!ID.test(projectId)) throw new RuntimeError('INVALID_REQUEST', 'ADO binding requires a valid registered IRIS project identity');
    const binding = await readBinding(this.dataRoot, projectId);
    const credential = await readCredential(this.dataRoot, binding.credentialRef);
    if (credential.credentialRef !== binding.credentialRef) {
      throw new RuntimeError('CREDENTIAL_INVALID', 'ADO credential identity does not match the configured binding');
    }
    const identity: BoardIdentity = {
      organization: { ...binding.organization },
      project: { ...binding.project },
      team: { ...binding.team },
      board: { ...binding.board },
    };
    const grant: AdoReadGrant = {
      projectId: binding.irisProjectId,
      connectorBindingId: binding.connectorBindingId,
      credentialRef: binding.credentialRef,
      sessionRef: binding.sessionRef,
      network: binding.network,
      expiresAt: binding.expiresAt,
      revoked: binding.revoked,
      tokenScopes: [...binding.tokenScopes],
      policy: {
        mode: 'READ_ONLY',
        allowlist: [{
          organization: identity.organization.id,
          project: identity.project.id,
          team: identity.team.id,
          board: identity.board.id,
          resources: [...binding.resources],
        }],
        timeoutMs: binding.limits.timeoutMs,
        maxResponseBytes: binding.limits.maxResponseBytes,
        maxPageItems: binding.limits.maxPageItems,
        maxPages: binding.limits.maxPages,
        maxBatchItems: binding.limits.maxBatchItems,
        rateLimit: {
          requests: binding.limits.rateLimitRequests,
          windowMs: binding.limits.rateLimitWindowMs,
          maxRetryAfterMs: binding.limits.maxRetryAfterMs,
        },
      },
    };
    return {
      identity,
      grant,
      organizationName: binding.organization.name,
      projectName: binding.project.name,
      auth: { kind: credential.kind, secret: credential.secret },
    };
  }
}

export function adoBindingPath(dataRoot: string, projectId: string): string {
  if (!ID.test(projectId)) throw new RuntimeError('INVALID_REQUEST', 'ADO binding project identity is invalid');
  return path.join(dataRoot, 'integrations', 'ado', 'bindings', `${projectId}.json`);
}

export function adoCredentialPath(dataRoot: string, credentialRef: string): string {
  if (!REF.test(credentialRef)) throw new RuntimeError('CREDENTIAL_INVALID', 'ADO credential reference is invalid');
  return path.join(dataRoot, 'credentials', 'ado', `${credentialRef}.json`);
}

export interface AdoBindingStatus {
  readonly configured: boolean;
  readonly irisProjectId: string;
  readonly connectorBindingId: string | null;
  readonly credentialRef: string | null;
  readonly credentialPresent: boolean;
  readonly credentialKind: 'PAT' | 'BEARER' | null;
  readonly organization: AdoRuntimeBinding['organization'] | null;
  readonly project: AdoRuntimeBinding['project'] | null;
  readonly team: AdoRuntimeBinding['team'] | null;
  readonly board: AdoRuntimeBinding['board'] | null;
  readonly expiresAt: string | null;
  readonly revoked: boolean | null;
  readonly resources: readonly Resource[];
}

export async function persistAdoCredential(
  dataRoot: string,
  input: { readonly credentialRef: string; readonly kind: 'PAT' | 'BEARER'; readonly secret: string },
): Promise<void> {
  const credential: AdoCredentialRecord = { schemaVersion: 1, ...input };
  if (!isCredential(credential)) throw new RuntimeError('CREDENTIAL_INVALID', 'ADO credential input is invalid');
  await ensureAdoCredentialDirectory(dataRoot);
  await writePrivateJsonAtomic(adoCredentialPath(dataRoot, credential.credentialRef), credential);
}

export async function persistAdoRuntimeBinding(dataRoot: string, binding: AdoRuntimeBinding): Promise<void> {
  if (!isBinding(binding)) throw new RuntimeError('INVALID_REQUEST', 'ADO runtime binding input is invalid');
  await ensureAdoBindingDirectory(dataRoot);
  await writePrivateJsonAtomic(adoBindingPath(dataRoot, binding.irisProjectId), binding);
}

export async function readAdoBindingStatus(dataRoot: string, irisProjectId: string): Promise<AdoBindingStatus> {
  if (!ID.test(irisProjectId)) throw new RuntimeError('INVALID_REQUEST', 'ADO binding project identity is invalid');
  const inspected = await inspectPrivateRegularFile(adoBindingPath(dataRoot, irisProjectId), 'ADO project binding');
  if (inspected.state === 'missing') {
    return {
      configured: false,
      irisProjectId,
      connectorBindingId: null,
      credentialRef: null,
      credentialPresent: false,
      credentialKind: null,
      organization: null,
      project: null,
      team: null,
      board: null,
      expiresAt: null,
      revoked: null,
      resources: [],
    };
  }
  if (inspected.state === 'invalid') throw new RuntimeError('CREDENTIAL_INVALID', inspected.reason);
  const binding = await readBinding(dataRoot, irisProjectId);
  const credentialInspection = await inspectPrivateRegularFile(
    adoCredentialPath(dataRoot, binding.credentialRef),
    'ADO credential',
  );
  let credentialPresent = false;
  let credentialKind: 'PAT' | 'BEARER' | null = null;
  if (credentialInspection.state === 'invalid') throw new RuntimeError('CREDENTIAL_INVALID', credentialInspection.reason);
  if (credentialInspection.state === 'ok') {
    let value: unknown;
    try { value = JSON.parse(credentialInspection.content); } catch {
      throw new RuntimeError('CREDENTIAL_INVALID', 'ADO credential record is invalid JSON');
    }
    if (!isCredential(value) || value.credentialRef !== binding.credentialRef) {
      throw new RuntimeError('CREDENTIAL_INVALID', 'ADO credential record is invalid');
    }
    credentialPresent = true;
    credentialKind = value.kind;
  }
  return {
    configured: true,
    irisProjectId,
    connectorBindingId: binding.connectorBindingId,
    credentialRef: binding.credentialRef,
    credentialPresent,
    credentialKind,
    organization: { ...binding.organization },
    project: { ...binding.project },
    team: { ...binding.team },
    board: { ...binding.board },
    expiresAt: binding.expiresAt,
    revoked: binding.revoked,
    resources: [...binding.resources],
  };
}

async function ensureAdoBindingDirectory(dataRoot: string): Promise<void> {
  const directories = [
    path.join(dataRoot, 'integrations'),
    path.join(dataRoot, 'integrations', 'ado'),
    path.join(dataRoot, 'integrations', 'ado', 'bindings'),
  ];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const problem = await privateDirectoryProblem(directory, 'ADO binding directory');
    if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
  }
}

async function ensureAdoCredentialDirectory(dataRoot: string): Promise<void> {
  const credentials = await ensureCredentialDirectory(dataRoot);
  const directory = path.join(credentials.directory, 'ado');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const problem = await privateDirectoryProblem(directory, 'ADO credential directory');
  if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
}

async function readBinding(dataRoot: string, projectId: string): Promise<AdoRuntimeBinding> {
  const filename = adoBindingPath(dataRoot, projectId);
  const inspected = await inspectPrivateRegularFile(filename, 'ADO project binding');
  if (inspected.state === 'missing') throw new RuntimeError('CREDENTIAL_MISSING', 'ADO binding is not configured for the selected IRIS project');
  if (inspected.state === 'invalid') throw new RuntimeError('CREDENTIAL_INVALID', inspected.reason);
  const problem = await privateDirectoryProblem(path.dirname(filename), 'ADO binding directory');
  if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
  let value: unknown;
  try { value = JSON.parse(inspected.content); } catch {
    throw new RuntimeError('CREDENTIAL_INVALID', 'ADO project binding is invalid JSON');
  }
  if (!isBinding(value) || value.irisProjectId !== projectId) {
    throw new RuntimeError('CREDENTIAL_INVALID', 'ADO project binding is invalid or targets a different IRIS project');
  }
  return value;
}

async function readCredential(dataRoot: string, credentialRef: string): Promise<AdoCredentialRecord> {
  const filename = adoCredentialPath(dataRoot, credentialRef);
  const inspected = await inspectPrivateRegularFile(filename, 'ADO credential');
  if (inspected.state === 'missing') throw new RuntimeError('CREDENTIAL_MISSING', 'ADO credential is not configured');
  if (inspected.state === 'invalid') throw new RuntimeError('CREDENTIAL_INVALID', inspected.reason);
  const problem = await privateDirectoryProblem(path.dirname(filename), 'ADO credential directory');
  if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
  let value: unknown;
  try { value = JSON.parse(inspected.content); } catch {
    throw new RuntimeError('CREDENTIAL_INVALID', 'ADO credential record is invalid JSON');
  }
  if (!isCredential(value)) throw new RuntimeError('CREDENTIAL_INVALID', 'ADO credential record is invalid');
  return value;
}

function isBinding(value: unknown): value is AdoRuntimeBinding {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !BINDING_KEYS.has(key))
    || value.schemaVersion !== 1
    || !ID.test(stringValue(value.irisProjectId))
    || !ID.test(stringValue(value.connectorBindingId))
    || !REF.test(stringValue(value.credentialRef))
    || !REF.test(stringValue(value.sessionRef))
    || (value.network !== 'allowed' && value.network !== 'disabled')
    || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.expiresAt))
    || typeof value.revoked !== 'boolean'
    || !Array.isArray(value.tokenScopes)
    || value.tokenScopes.length !== 1
    || value.tokenScopes[0] !== 'vso.work'
    || !Array.isArray(value.resources)
    || value.resources.length === 0
    || !value.resources.every((resource) => typeof resource === 'string' && ALLOWED_RESOURCES.has(resource as Resource))
    || new Set(value.resources).size !== value.resources.length
    || !validIdentity(value.organization)
    || !validIdentity(value.project)
    || !validIdentity(value.team)
    || !validIdentity(value.board)
    || !isRecord(value.limits)
    || Object.keys(value.limits).some((key) => !LIMIT_KEYS.has(key))) return false;
  const limits = value.limits;
  return [
    limits.timeoutMs,
    limits.maxResponseBytes,
    limits.maxPageItems,
    limits.maxPages,
    limits.maxBatchItems,
    limits.rateLimitRequests,
    limits.rateLimitWindowMs,
    limits.maxRetryAfterMs,
  ].every((entry) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0)
    && Number(limits.timeoutMs) <= 120_000
    && Number(limits.maxResponseBytes) <= 64 * 1024 * 1024
    && Number(limits.maxPageItems) <= 2_000
    && Number(limits.maxPages) <= 100
    && Number(limits.maxBatchItems) <= 200;
}

function isCredential(value: unknown): value is AdoCredentialRecord {
  return isRecord(value)
    && Object.keys(value).every((key) => CREDENTIAL_KEYS.has(key))
    && value.schemaVersion === 1
    && REF.test(stringValue(value.credentialRef))
    && (value.kind === 'PAT' || value.kind === 'BEARER')
    && typeof value.secret === 'string'
    && value.secret.length >= 20
    && value.secret.length <= 4096
    && !/[\0\r\n]/.test(value.secret);
}

function validIdentity(value: unknown): value is { readonly id: string; readonly name: string } {
  return isRecord(value)
    && Object.keys(value).every((key) => IDENTITY_KEYS.has(key))
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 1024 && !/[\0\r\n]/.test(value.id)
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 1024 && !/[\0\r\n]/.test(value.name);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
