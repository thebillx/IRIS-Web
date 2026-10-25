import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeError, type RiskClass } from '@iris/domain';
import { capabilityDefinition } from './capability-registry.js';
import { inspectPrivateRegularFile, privateDirectoryProblem } from './private-fs.js';
import { readOwnerAccessSecret } from './persistence.js';

const FILE = 'mission-delegations.json';
const SCHEMA_VERSION = 1 as const;
const MAX_DELEGATIONS = 128;
const MAX_ARCHIVED_DELEGATIONS = 128;
const UUID_PATTERN = /^[0-9a-f-]{36}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const execFileAsync = promisify(execFile);

export interface MissionDelegationSpec {
  readonly requestId: string;
  readonly missionId: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly trustedAgentIds: readonly string[];
  readonly allowedCapabilities: readonly string[];
  readonly projectIds: readonly string[];
  readonly workspaceIds?: readonly string[] | undefined;
  readonly sourceSha?: string | null;
  readonly sourceTree?: string | null;
  readonly expiresAt: string;
  readonly maxExecutions: number;
}

export interface MissionDelegationRecord extends MissionDelegationSpec {
  readonly delegationId: string;
  readonly issuedAt: string;
  readonly consumedOperationIds: readonly string[];
  readonly revokedAt: string | null;
  readonly digest: string;
}

export interface VerifiedSourceIdentity {
  readonly sha: string;
  readonly tree: string;
}

interface DelegationDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly delegations: readonly MissionDelegationRecord[];
  readonly archivedDelegations?: readonly DelegationArchiveRecord[] | undefined;
  readonly mac: string;
}

interface DelegationArchiveRecord {
  readonly requestId: string;
  readonly specificationDigest: string;
  readonly terminalDigest: string;
}

export type DelegationDecision =
  | { readonly status: 'none' }
  | { readonly status: 'allowed'; readonly record: MissionDelegationRecord; readonly reason: string }
  | { readonly status: 'blocked'; readonly reason: string };

export class MissionDelegationStore {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly dataRoot: string, private readonly sourceRoot?: string, private readonly startupSource?: VerifiedSourceIdentity, private readonly sourceVerificationFailed = false) {}

  public async issue(spec: MissionDelegationSpec): Promise<MissionDelegationRecord> {
    const boundSpec = await this.bindCurrentSource(spec);
    validateSpec(boundSpec);
    const secret = await this.requireSecret();
    let issued!: MissionDelegationRecord;
    await this.mutate(async (document) => {
      const existing = document.delegations.find((entry) => entry.requestId === boundSpec.requestId);
      if (existing !== undefined) {
        if (!sameSpec(existing, boundSpec)) throw new RuntimeError('AUTHORITY_CHANGED', 'Delegation requestId was already used for a different scope');
        issued = existing;
        return document;
      }
      if (document.archivedDelegations?.some((entry) => entry.requestId === boundSpec.requestId)) {
        throw new RuntimeError('AUTHORITY_CHANGED', 'Delegation requestId was already retired; issue a new requestId');
      }
      const terminal = document.delegations.filter((entry) => entry.revokedAt !== null || entry.consumedOperationIds.length >= entry.maxExecutions || Date.parse(entry.expiresAt) <= Date.now());
      const retained = document.delegations.filter((entry) => !terminal.includes(entry));
      if (retained.length >= MAX_DELEGATIONS) throw new RuntimeError('PERSISTENCE_FAILURE', 'Mission delegation capacity is exhausted by active records');
      if ((document.archivedDelegations?.length ?? 0) + terminal.length > MAX_ARCHIVED_DELEGATIONS) throw new RuntimeError('PERSISTENCE_FAILURE', 'Mission delegation replay history is at capacity; archive compaction requires explicit migration');
      const delegationId = randomUUID();
      const issuedAt = new Date().toISOString();
      const base = {
        ...boundSpec,
        sourceSha: boundSpec.sourceSha ?? null,
        sourceTree: boundSpec.sourceTree ?? null,
        delegationId,
        issuedAt,
        consumedOperationIds: [],
        revokedAt: null,
      } satisfies Omit<MissionDelegationRecord, 'digest'>;
      issued = { ...base, digest: digest(base) };
      const archived = [...(document.archivedDelegations ?? []), ...terminal.map((entry) => ({ requestId: entry.requestId, specificationDigest: specificationDigest(entry), terminalDigest: entry.digest }))];
      return { ...document, delegations: [...retained, issued], ...(archived.length === 0 ? {} : { archivedDelegations: archived }) };
    }, secret);
    return issued;
  }

  public async revoke(delegationId: string, ownerClientId: string, ownerSessionId: string): Promise<void> {
    const secret = await this.requireSecret();
    await this.mutate(async (document) => {
      const index = document.delegations.findIndex((entry) => entry.delegationId === delegationId);
      if (index < 0) throw new RuntimeError('INVALID_REQUEST', 'Mission delegation was not found');
      const current = document.delegations[index]!;
      if (current.ownerClientId !== ownerClientId || current.ownerSessionId !== ownerSessionId) throw new RuntimeError('CONTROL_DENIED', 'Delegation belongs to a different owner session');
      if (current.revokedAt !== null) return document;
      const next = { ...current, revokedAt: new Date().toISOString() };
      const delegations = [...document.delegations];
      delegations[index] = { ...next, digest: digest(next) };
      return { ...document, delegations };
    }, secret);
  }

  public async authorize(input: {
    readonly missionId?: string | null | undefined;
    readonly clientId?: string | null | undefined;
    readonly sessionId?: string | null | undefined;
    readonly agentId?: string | null | undefined;
    readonly capabilityId: string;
    readonly projectId?: string | null | undefined;
    readonly workspaceId?: string | null | undefined;
    readonly sourceSha?: string | null | undefined;
    readonly sourceTree?: string | null | undefined;
    readonly operationId?: string | null | undefined;
    readonly riskClass: RiskClass;
  }): Promise<DelegationDecision> {
    if (input.missionId === undefined || input.missionId === null) return { status: 'none' };
    const secret = await this.requireSecret();
    const document = await this.read(secret);
    const source = await this.currentSourceIdentity();
    const effectiveInput = source === null ? input : { ...input, sourceSha: source.sha, sourceTree: source.tree };
    const candidates = document.delegations.filter((entry) => entry.missionId === effectiveInput.missionId);
    if (candidates.length === 0) return { status: 'none' };
    if (effectiveInput.operationId === undefined || effectiveInput.operationId === null || !OPERATION_ID_PATTERN.test(effectiveInput.operationId)) return { status: 'blocked', reason: 'Delegated mission operation requires a valid action identity' };
    const active = candidates.filter((candidate) => candidate.revokedAt === null && Date.parse(candidate.expiresAt) > Date.now());
    if (active.length > 1) return { status: 'blocked', reason: 'Multiple active delegations for one mission are ambiguous' };
    if (active[0] === undefined) return { status: 'blocked', reason: 'Mission delegation is expired or revoked' };
    let allowed!: MissionDelegationRecord;
    try {
      await this.mutate(async (current) => {
        const active = current.delegations.filter((candidate) => candidate.missionId === effectiveInput.missionId && candidate.revokedAt === null && Date.parse(candidate.expiresAt) > Date.now());
        if (active.length !== 1) throw new RuntimeError('AUTHORITY_CHANGED', active.length > 1 ? 'Multiple active delegations for one mission are ambiguous' : 'Mission delegation is no longer active');
        const index = current.delegations.findIndex((candidate) => candidate.delegationId === active[0]!.delegationId);
        const latest = current.delegations[index]!;
        const mismatch = delegationMismatch(latest, effectiveInput);
        if (mismatch !== null) throw new RuntimeError('AUTHORITY_CHANGED', mismatch);
        if (input.riskClass === 'HIGH' || input.riskClass === 'SYSTEM') throw new RuntimeError('AUTHORITY_CHANGED', 'Delegation cannot bypass high-risk or system authority');
        if (latest.consumedOperationIds.includes(effectiveInput.operationId!)) throw new RuntimeError('AUTHORITY_CHANGED', 'Delegated operation replay was rejected');
        if (latest.consumedOperationIds.length >= latest.maxExecutions) throw new RuntimeError('AUTHORITY_CHANGED', 'Mission delegation execution limit was reached');
        const consumedOperationIds = [...latest.consumedOperationIds, effectiveInput.operationId!];
        allowed = { ...latest, consumedOperationIds, digest: digest({ ...latest, consumedOperationIds }) };
        const delegations = [...current.delegations];
        delegations[index] = allowed;
        return { ...current, delegations };
      }, secret);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'AUTHORITY_CHANGED') return { status: 'blocked', reason: error.message };
      throw error;
    }
    return { status: 'allowed', record: allowed, reason: `Mission-scoped owner delegation ${allowed.delegationId} authorized this operation` };
  }

  /** Inspect authority for a consumed action receipt without consuming, renewing, or rewriting the grant. */
  public async inspectReceipt(input: Parameters<MissionDelegationStore['authorize']>[0]): Promise<DelegationDecision> {
    if (input.missionId === undefined || input.missionId === null) return { status: 'none' };
    const document = await this.read(await this.requireSecret());
    const source = await this.currentSourceIdentity();
    const effective = source === null ? input : { ...input, sourceSha: source.sha, sourceTree: source.tree };
    const candidates = document.delegations.filter((entry) => entry.missionId === effective.missionId);
    if (candidates.length === 0) return (document.archivedDelegations?.length ?? 0) === 0
      ? { status: 'none' } : { status: 'blocked', reason: 'Retired delegation history cannot prove receipt authority' };
    if (effective.operationId === undefined || effective.operationId === null || !OPERATION_ID_PATTERN.test(effective.operationId)) return { status: 'blocked', reason: 'Delegation receipt requires an exact action identity' };
    const active = candidates.filter((entry) => entry.revokedAt === null && Date.parse(entry.expiresAt) > Date.now());
    if (active.length !== 1) return { status: 'blocked', reason: active.length === 0 ? 'Mission delegation is expired or revoked' : 'Multiple active delegations for one mission are ambiguous' };
    const grant = active[0]!;
    const mismatch = delegationMismatch(grant, effective);
    if (mismatch !== null) return { status: 'blocked', reason: mismatch };
    if (input.riskClass === 'HIGH' || input.riskClass === 'SYSTEM') return { status: 'blocked', reason: 'Delegation cannot bypass high-risk or system authority' };
    if (!grant.consumedOperationIds.includes(effective.operationId)) return { status: 'blocked', reason: 'Action was not consumed by this delegation' };
    return { status: 'allowed', record: grant, reason: `Existing action receipt is covered by active mission delegation ${grant.delegationId}` };
  }

  private async bindCurrentSource(spec: MissionDelegationSpec): Promise<MissionDelegationSpec> {
    const source = await this.currentSourceIdentity();
    if (source === null) return spec;
    if ((spec.sourceSha !== undefined && spec.sourceSha !== null && spec.sourceSha !== source.sha)
      || (spec.sourceTree !== undefined && spec.sourceTree !== null && spec.sourceTree !== source.tree)) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'Delegation source identity does not match the current source');
    }
    return { ...spec, sourceSha: source.sha, sourceTree: source.tree };
  }

  private async currentSourceIdentity(): Promise<VerifiedSourceIdentity | null> {
    if (this.sourceRoot === undefined) return null;
    if (this.sourceVerificationFailed) throw new RuntimeError('PERSISTENCE_FAILURE', 'Delegation source identity was unavailable at daemon startup');
    try {
      const current = await readVerifiedSourceIdentity(this.sourceRoot);
      if (this.startupSource !== undefined && (current.sha !== this.startupSource.sha || current.tree !== this.startupSource.tree)) throw new RuntimeError('AUTHORITY_CHANGED', 'Running source checkout changed after daemon startup');
      return current;
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'AUTHORITY_CHANGED') throw error;
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Current source identity could not be verified', { cause: error });
    }
  }

  private async requireSecret(): Promise<string> {
    const directoryProblem = await privateDirectoryProblem(this.dataRoot, 'IRIS runtime data root');
    if (directoryProblem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', directoryProblem);
    const secret = await readOwnerAccessSecret(this.dataRoot);
    if (secret === null) throw new RuntimeError('PERSISTENCE_FAILURE', 'Owner access credential is unavailable');
    return secret;
  }

  private async read(secret: string): Promise<DelegationDocument> {
    const inspected = await inspectPrivateRegularFile(path.join(this.dataRoot, FILE), 'Mission delegation document');
    if (inspected.state === 'missing') return { schemaVersion: SCHEMA_VERSION, delegations: [], mac: mac(secret, { schemaVersion: SCHEMA_VERSION, delegations: [] }) };
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    let parsed: unknown;
    try { parsed = JSON.parse(inspected.content); } catch { throw new RuntimeError('PERSISTENCE_FAILURE', 'Mission delegation document is invalid JSON'); }
    if (!isDocument(parsed) || !safeEqual(parsed.mac, mac(secret, documentPayload(parsed)))) {
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Mission delegation document authentication failed');
    }
    return parsed;
  }

  private async mutate(transform: (document: DelegationDocument) => Promise<DelegationDocument>, secret: string): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      const current = await this.read(secret);
      const next = await transform(current);
      await writeAtomic(path.join(this.dataRoot, FILE), { ...next, mac: mac(secret, documentPayload(next)) });
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    await operation;
  }
}

export async function readVerifiedSourceIdentity(sourceRoot: string): Promise<VerifiedSourceIdentity> {
  const result = await execFileAsync('/usr/bin/git', ['-C', sourceRoot, 'rev-parse', 'HEAD', 'HEAD^{tree}'], { encoding: 'utf8', timeout: 5000 });
  const [sha, tree] = result.stdout.trim().split(/\s+/);
  if (sha === undefined || tree === undefined || !SHA_PATTERN.test(sha) || !SHA_PATTERN.test(tree)) throw new Error('invalid Git identity');
  return { sha, tree };
}

function delegationMismatch(entry: MissionDelegationRecord, input: Parameters<MissionDelegationStore['authorize']>[0]): string | null {
  if (entry.ownerClientId !== input.clientId || entry.ownerSessionId !== input.sessionId) return 'Mission delegation owner session does not match';
  if (!entry.trustedAgentIds.includes(input.agentId ?? '')) return 'Agent identity is outside the delegated scope';
  if (!entry.allowedCapabilities.includes(input.capabilityId)) return 'Capability is outside the delegated scope';
  if (!entry.projectIds.includes(input.projectId ?? '')) return 'Project is outside the delegated scope';
  if (requiresWorkspaceScope(entry.allowedCapabilities) && (entry.workspaceIds === undefined || !entry.workspaceIds.includes(input.workspaceId ?? ''))) return 'Workspace is outside the delegated scope';
  if ((entry.sourceSha ?? null) !== (input.sourceSha ?? null) || (entry.sourceTree ?? null) !== (input.sourceTree ?? null)) return 'Source identity is outside the delegated scope';
  return null;
}

function validateSpec(spec: MissionDelegationSpec): void {
  if (!UUID_PATTERN.test(spec.requestId) || !UUID_PATTERN.test(spec.missionId) || spec.ownerClientId.trim().length === 0 || spec.ownerClientId.length > 200 || !UUID_PATTERN.test(spec.ownerSessionId)) throw new RuntimeError('INVALID_REQUEST', 'Delegation identities are invalid');
  if (spec.trustedAgentIds.length === 0 || spec.trustedAgentIds.length > 16 || spec.allowedCapabilities.length === 0 || spec.allowedCapabilities.length > 32 || spec.projectIds.length === 0 || spec.projectIds.length > 32 || (spec.workspaceIds !== undefined && spec.workspaceIds.length > 64) || spec.maxExecutions < 1 || spec.maxExecutions > 1000) throw new RuntimeError('INVALID_REQUEST', 'Delegation scope or execution limit is invalid');
  if (spec.trustedAgentIds.some((value) => value.trim().length === 0 || value.length > 200)
    || spec.projectIds.some((value) => value.trim().length === 0 || value.length > 200)
    || spec.workspaceIds?.some((value) => value.trim().length === 0 || value.length > 200)
    || spec.allowedCapabilities.some((value) => capabilityDefinition(value) === null)) throw new RuntimeError('INVALID_REQUEST', 'Delegation contains an unknown or invalid scope entry');
  if (requiresWorkspaceScope(spec.allowedCapabilities) && (spec.workspaceIds === undefined || spec.workspaceIds.length === 0)) throw new RuntimeError('INVALID_REQUEST', 'Workspace-scoped capabilities require explicit workspaceIds');
  if ((spec.sourceSha === undefined) !== (spec.sourceTree === undefined)
    || (spec.sourceSha === null) !== (spec.sourceTree === null)) throw new RuntimeError('INVALID_REQUEST', 'Source SHA and tree must be supplied together');
  if (!Number.isFinite(Date.parse(spec.expiresAt)) || Date.parse(spec.expiresAt) <= Date.now()) throw new RuntimeError('INVALID_REQUEST', 'Delegation expiry must be in the future');
  if ((spec.sourceSha !== undefined && spec.sourceSha !== null && !SHA_PATTERN.test(spec.sourceSha)) || (spec.sourceTree !== undefined && spec.sourceTree !== null && !SHA_PATTERN.test(spec.sourceTree))) throw new RuntimeError('INVALID_REQUEST', 'Source identities must be lowercase Git object identifiers');
}

function digest(value: unknown): string { return mac('delegation-digest', value); }
function specificationDigest(spec: MissionDelegationSpec | MissionDelegationRecord): string {
  return digest({ requestId: spec.requestId, missionId: spec.missionId, ownerClientId: spec.ownerClientId, ownerSessionId: spec.ownerSessionId, trustedAgentIds: spec.trustedAgentIds, allowedCapabilities: spec.allowedCapabilities, projectIds: spec.projectIds, workspaceIds: spec.workspaceIds ?? null, sourceSha: spec.sourceSha ?? null, sourceTree: spec.sourceTree ?? null, expiresAt: spec.expiresAt, maxExecutions: spec.maxExecutions });
}
function mac(secret: string, value: unknown): string { return createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex'); }
function documentPayload(document: DelegationDocument | { readonly schemaVersion: typeof SCHEMA_VERSION; readonly delegations: readonly MissionDelegationRecord[]; readonly archivedDelegations?: readonly DelegationArchiveRecord[] | undefined }): Record<string, unknown> {
  return document.archivedDelegations === undefined
    ? { schemaVersion: document.schemaVersion, delegations: document.delegations }
    : { schemaVersion: document.schemaVersion, delegations: document.delegations, archivedDelegations: document.archivedDelegations };
}
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

async function writeAtomic(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const parent = path.dirname(filename);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    const directory = await open(parent, fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Mission delegation publication failed', { cause: error });
  }
}

function isDocument(value: unknown): value is DelegationDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === SCHEMA_VERSION
    && typeof candidate.mac === 'string'
    && Array.isArray(candidate.delegations)
    && candidate.delegations.length <= MAX_DELEGATIONS
    && (candidate.archivedDelegations === undefined || (Array.isArray(candidate.archivedDelegations) && candidate.archivedDelegations.length <= MAX_ARCHIVED_DELEGATIONS && candidate.archivedDelegations.every(isDelegationArchiveRecord)))
    && candidate.delegations.every(isDelegationRecord);
}

function isDelegationArchiveRecord(value: unknown): value is DelegationArchiveRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.requestId === 'string' && UUID_PATTERN.test(candidate.requestId)
    && typeof candidate.specificationDigest === 'string' && /^[a-f0-9]{64}$/.test(candidate.specificationDigest)
    && typeof candidate.terminalDigest === 'string' && /^[a-f0-9]{64}$/.test(candidate.terminalDigest);
}

function isDelegationRecord(value: unknown): value is MissionDelegationRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const strings = (entry: unknown, max: number): entry is string => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= max;
  const ids = (entry: unknown): entry is string => typeof entry === 'string' && UUID_PATTERN.test(entry);
  const operationIds = (entry: unknown): entry is string => typeof entry === 'string' && OPERATION_ID_PATTERN.test(entry);
  const boundedArray = (entry: unknown, max: number, predicate: (value: unknown) => boolean): entry is readonly unknown[] => Array.isArray(entry) && entry.length <= max && entry.every(predicate);
  const sourcePair = (candidate.sourceSha === null && candidate.sourceTree === null)
    || (typeof candidate.sourceSha === 'string' && typeof candidate.sourceTree === 'string' && SHA_PATTERN.test(candidate.sourceSha) && SHA_PATTERN.test(candidate.sourceTree));
  return ids(candidate.delegationId)
    && ids(candidate.requestId)
    && ids(candidate.missionId)
    && strings(candidate.ownerClientId, 200)
    && ids(candidate.ownerSessionId)
    && boundedArray(candidate.trustedAgentIds, 16, (entry) => strings(entry, 200))
    && boundedArray(candidate.allowedCapabilities, 32, (entry) => strings(entry, 100) && capabilityDefinition(entry) !== null)
    && boundedArray(candidate.projectIds, 32, (entry) => strings(entry, 200))
    && (candidate.projectIds as readonly unknown[]).length > 0
    && (candidate.workspaceIds === undefined || boundedArray(candidate.workspaceIds, 64, (entry) => strings(entry, 200)))
    && sourcePair
    && typeof candidate.expiresAt === 'string'
    && Number.isFinite(Date.parse(candidate.expiresAt))
    && Number.isSafeInteger(candidate.maxExecutions) && (candidate.maxExecutions as number) >= 1 && (candidate.maxExecutions as number) <= 1000
    && boundedArray(candidate.consumedOperationIds, 1000, (entry) => operationIds(entry))
    && (candidate.revokedAt === null || (typeof candidate.revokedAt === 'string' && Number.isFinite(Date.parse(candidate.revokedAt))))
    && typeof candidate.issuedAt === 'string' && Number.isFinite(Date.parse(candidate.issuedAt))
    && typeof candidate.digest === 'string' && /^[a-f0-9]{64}$/.test(candidate.digest)
    && (!requiresWorkspaceScope(candidate.allowedCapabilities as readonly string[]) || (Array.isArray(candidate.workspaceIds) && candidate.workspaceIds.length > 0));
}

function sameSpec(record: MissionDelegationRecord, spec: MissionDelegationSpec): boolean {
  return record.missionId === spec.missionId
    && record.ownerClientId === spec.ownerClientId
    && record.ownerSessionId === spec.ownerSessionId
    && JSON.stringify(record.trustedAgentIds) === JSON.stringify(spec.trustedAgentIds)
    && JSON.stringify(record.allowedCapabilities) === JSON.stringify(spec.allowedCapabilities)
    && JSON.stringify(record.projectIds) === JSON.stringify(spec.projectIds)
    && JSON.stringify(record.workspaceIds ?? undefined) === JSON.stringify(spec.workspaceIds ?? undefined)
    && (record.sourceSha ?? null) === (spec.sourceSha ?? null)
    && (record.sourceTree ?? null) === (spec.sourceTree ?? null)
    && record.expiresAt === spec.expiresAt
    && record.maxExecutions === spec.maxExecutions;
}

function requiresWorkspaceScope(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) => capability === 'workspace.get' || capability === 'workspace.revoke_scratch'
    || capability === 'fs.list' || capability === 'fs.stat' || capability === 'fs.read' || capability === 'fs.write' || capability === 'fs.edit' || capability === 'fs.mkdir' || capability === 'fs.delete' || capability === 'fs.hash' || capability === 'fs.find'
    || capability === 'artifact.register_existing' || capability === 'shell.run' || capability === 'shell.start' || capability === 'code_review.start'
    || capability === 'git.status' || capability === 'git.head' || capability === 'git.diff' || capability === 'git.log' || capability === 'git.show' || capability === 'git.cat_file' || capability === 'git.merge_base' || capability === 'git.ancestry' || capability === 'git.refs' || capability === 'git.branch_list' || capability === 'git.worktree_list' || capability === 'git.branch_create' || capability === 'git.worktree_add' || capability === 'git.worktree_remove' || capability === 'git.add' || capability === 'git.commit' || capability === 'git.fetch' || capability === 'git.push');
}
