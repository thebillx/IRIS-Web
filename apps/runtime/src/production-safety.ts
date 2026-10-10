import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type RuntimeIdentity } from '@iris/domain';
import { inspectPrivateRegularFile, privateDirectoryProblem } from './private-fs.js';
import { observeProcessStart } from './macos-safety.js';

const SAFETY_FILE = 'production-safety.json';
const SAFETY_LOCK = 'production-safety.lock';
const MANIFEST_FILE = 'manifest.json';
const CHECKPOINT_FILE = 'checkpoint.json';
let processStartMarker: string | undefined;
const REQUIRED_WRITERS = [
  'runtime-state', 'mission-state', 'mission-broker', 'durable-jobs',
  'mission-lifecycle', 'multi-worker', 'security-audit', 'resource-registry',
  'permission-store', 'permission-audit', 'activation', 'supervisor', 'external-runners',
] as const;
const INSTRUMENTED_WRITERS = ['runtime-state', 'mission-state', 'mission-broker', 'durable-jobs'] as const;
const WRITER_STATES = ['IDLE', 'ACTIVE', 'UNKNOWN'] as const;
const FENCE_STATES = ['ACTIVE', 'QUIESCING', 'QUIESCED', 'BLOCKED', 'RECOVERY_REQUIRED'] as const;

export type SafetyWriterName = typeof REQUIRED_WRITERS[number];
export type SafetyWriterState = typeof WRITER_STATES[number];
export type ProductionFenceState = typeof FENCE_STATES[number];

export interface SafetyIdentity {
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly dataRoot: string;
}

interface WriterRecord {
  readonly state: SafetyWriterState;
  readonly inFlight: number;
  readonly observedState: SafetyWriterState;
  readonly observedInFlight: number;
  readonly ownerInstanceId: string | null;
  readonly leaseIds: readonly string[];
}

interface BackupEvidence {
  readonly backupId: string;
  readonly destination: string;
  readonly manifestDigest: string;
  readonly sourceIdentity: SafetyIdentity;
  readonly fenceEpoch: number;
  readonly checkpointDigest: string | null;
  readonly verifiedAt: string;
}

interface RestoreEvidence {
  readonly backupId: string;
  readonly destination: string;
  readonly checkpointTarget: string | null;
  readonly manifestDigest: string;
  readonly sourceIdentity: SafetyIdentity;
  readonly fenceEpoch: number;
  readonly checkpointDigest: string | null;
  readonly verifiedAt: string;
}

interface SafetyReservation {
  readonly id: string;
  readonly operation: 'BACKUP' | 'RESTORE';
  readonly ownerInstanceId: string;
  readonly fenceEpoch: number;
  readonly destination: string;
  readonly checkpointTarget: string | null;
  readonly startedAt: string;
  readonly status: 'ACTIVE' | 'FAILED';
}

interface SafetyDocument {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly state: ProductionFenceState;
  readonly identity: SafetyIdentity;
  readonly writers: Readonly<Record<string, WriterRecord>>;
  readonly blockedReason: string | null;
  readonly fenceEpoch: number;
  readonly backup: BackupEvidence | null;
  readonly restore: RestoreEvidence | null;
  readonly reservation: SafetyReservation | null;
  readonly updatedAt: string;
}

export type SafetySnapshot = SafetyDocument;

export interface WriterObservation {
  readonly state: SafetyWriterState;
  readonly inFlight?: number;
}

export interface TrustedWriterVerificationContext {
  readonly fenceEpoch: number;
  readonly generation: number;
}

export interface TrustedWriterVerification {
  readonly state: Exclude<SafetyWriterState, 'UNKNOWN'>;
  readonly inFlight: number;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly dataRoot: string;
  readonly fenceEpoch: number;
  readonly generation: number;
}

export interface TrustedWriterVerifier {
  verify(writer: SafetyWriterName, identity: SafetyIdentity, context: TrustedWriterVerificationContext): Promise<TrustedWriterVerification | null>;
}

export interface ProductionSafetyOpenOptions {
  readonly dataRoot: string;
  readonly identity: SafetyIdentity | RuntimeIdentity;
  readonly ownerAccessSecret: string;
  readonly writerVerifier?: TrustedWriterVerifier;
}

export interface MutationLease {
  readonly writer: string;
  readonly release: () => Promise<void>;
}

export interface ReadinessReport {
  readonly status: 'READY_FOR_OWNER_WINDOW' | 'BLOCKED';
  readonly reasons: readonly string[];
  readonly fence: SafetySnapshot;
}

export interface ReadOnlySafetyControllerOptions {
  readonly dataRoot: string;
}

export interface BackupManifest {
  readonly schemaVersion: 1;
  readonly backupId: string;
  readonly createdAt: string;
  readonly sourceIdentity: SafetyIdentity;
  readonly fenceGeneration: number;
  readonly files: readonly { path: string; size: number; sha256: string; mode: number }[];
  readonly checkpoint: { size: number; sha256: string; mode: number } | null;
}

export interface CreateBackupInput {
  readonly controller: ProductionSafetyController;
  readonly ownerAccessToken: string;
  readonly destination: string;
  readonly checkpointFile?: string;
}

export interface RestoreBackupInput {
  readonly controller: ProductionSafetyController;
  readonly ownerAccessToken: string;
  readonly backupRoot: string;
  readonly destination: string;
  readonly disposable: true;
  readonly checkpointFile?: string;
}

export class ProductionSafetyController {
  private operationTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly dataRoot: string,
    private readonly identity: SafetyIdentity,
    private readonly ownerAccessSecret: string,
    private readonly writerVerifier: TrustedWriterVerifier | undefined,
    private document: SafetyDocument,
  ) {}

  public static async open(options: ProductionSafetyOpenOptions): Promise<ProductionSafetyController> {
    const dataRoot = path.resolve(options.dataRoot);
    const problem = await privateDirectoryProblem(dataRoot, 'Runtime data root');
    if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
    if (options.ownerAccessSecret.length < 1) throw new RuntimeError('CONTROL_DENIED', 'Owner access token is unavailable');
    const identity: SafetyIdentity = {
      runtimeId: options.identity.runtimeId,
      instanceId: options.identity.instanceId,
      dataRoot,
    };
    const document = await withLock(dataRoot, async () => {
      const filename = path.join(dataRoot, SAFETY_FILE);
      const inspected = await inspectPrivateRegularFile(filename, 'Production safety state');
      if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
      if (inspected.state === 'missing') {
        const initial = emptyDocument(identity);
        await writeDocument(filename, initial);
        return initial;
      }
      const current = parseDocument(inspected.content);
      if (current.identity.runtimeId !== identity.runtimeId || current.identity.instanceId === identity.instanceId) return current;
      const unresolvedWriter = Object.values(current.writers).some((writer) => writer.state === 'ACTIVE' || writer.inFlight > 0 || writer.leaseIds.length > 0);
      const recoverable = current.state === 'ACTIVE' && current.reservation === null && !unresolvedWriter;
      const next = {
        ...current,
        state: recoverable ? 'ACTIVE' as const : 'RECOVERY_REQUIRED' as const,
        identity,
        blockedReason: recoverable ? null : 'Runtime instance changed; owner recovery is required',
        backup: null,
        restore: null,
        reservation: current.reservation === null ? null : { ...current.reservation, status: 'FAILED' as const },
      };
      const published = bump(next);
      await writeDocument(filename, published);
      return published;
    }, identity);
    return new ProductionSafetyController(dataRoot, identity, options.ownerAccessSecret, options.writerVerifier, document);
  }

  public static async openReadOnly(options: ReadOnlySafetyControllerOptions): Promise<ProductionSafetyController | null> {
    const dataRoot = path.resolve(options.dataRoot);
    const problem = await privateDirectoryProblem(dataRoot, 'Runtime data root');
    if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
    const inspected = await inspectPrivateRegularFile(path.join(dataRoot, SAFETY_FILE), 'Production safety state');
    if (inspected.state === 'missing') return null;
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    const document = parseDocument(inspected.content);
    return new ProductionSafetyController(dataRoot, document.identity, '', undefined, document);
  }

  public snapshot(): SafetySnapshot { return structuredClone(this.document); }

  public async inspect(): Promise<SafetySnapshot> {
    return parseDocument(await readPrivateFile(path.join(this.dataRoot, SAFETY_FILE), 'Production safety state'));
  }

  public registerWriter(name: string, state: SafetyWriterState = 'IDLE'): Promise<void> {
    if (!name || !WRITER_STATES.includes(state)) throw new RuntimeError('INVALID_REQUEST', 'Writer registration is invalid');
    if (!REQUIRED_WRITERS.includes(name as SafetyWriterName)) throw new RuntimeError('INVALID_REQUEST', `Writer ${name} is not supported`);
    return this.transaction(async (current) => {
      this.assertIdentity(current);
      if (current.reservation !== null) throw new RuntimeError('PRECONDITION_FAILED', 'Writer registration is blocked by an unresolved safety reservation');
      const existing = current.writers[name];
      if (existing === undefined) throw new RuntimeError('PERSISTENCE_FAILURE', `Writer ${name} is missing from the authoritative inventory`);
      const unchanged = existing.state === state
        && existing.ownerInstanceId === (state === 'UNKNOWN' ? null : this.identity.instanceId)
        && existing.leaseIds.length === existing.inFlight
        && existing.observedState === (INSTRUMENTED_WRITERS.includes(name as typeof INSTRUMENTED_WRITERS[number]) ? 'IDLE' : state)
        && existing.observedInFlight === 0
        && (state === 'UNKNOWN' ? existing.inFlight === 0 : true);
      if (unchanged) return { value: undefined, document: current };
      if (current.state !== 'ACTIVE') throw new RuntimeError('PRECONDITION_FAILED', `Writer registration cannot change a ${current.state} fence`);
      if (existing.inFlight > 0) throw new RuntimeError('PRECONDITION_FAILED', `Writer ${name} has active mutation leases`);
      if (state !== 'UNKNOWN' && !INSTRUMENTED_WRITERS.includes(name as typeof INSTRUMENTED_WRITERS[number])) {
        const verified = await verifyWriterEvidence(current, this.identity, this.writerVerifier, name as SafetyWriterName);
        if (verified === null || verified.state !== state || verified.inFlight !== existing.inFlight) throw new RuntimeError('PRECONDITION_FAILED', `Writer ${name} is not independently verified`);
      }
      if (state === 'UNKNOWN' && existing.state !== 'UNKNOWN') throw new RuntimeError('PRECONDITION_FAILED', `Writer ${name} cannot be weakened to UNKNOWN`);
      const writers = {
        ...current.writers,
        [name]: { state, inFlight: 0, observedState: state, observedInFlight: 0, ownerInstanceId: state === 'UNKNOWN' ? null : this.identity.instanceId, leaseIds: [] },
      };
      return { value: undefined, document: { ...current, writers } };
    });
  }

  public beginMutation(writer: string): Promise<MutationLease> {
    return this.transaction(async (current) => {
      this.assertIdentity(current);
      if (current.state !== 'ACTIVE') throw new RuntimeError('PRECONDITION_FAILED', `Production writer fence is ${current.state}`);
      const record = current.writers[writer];
      if (record === undefined || record.state === 'UNKNOWN') throw new RuntimeError('PRECONDITION_FAILED', `Writer ${writer} is not verified for mutation`);
      if (!INSTRUMENTED_WRITERS.includes(writer as typeof INSTRUMENTED_WRITERS[number])) {
        const verified = await verifyWriterEvidence(current, this.identity, this.writerVerifier, writer as SafetyWriterName);
        if (verified === null || verified.state !== record.observedState || verified.inFlight !== record.observedInFlight || verified.state !== 'IDLE' || verified.inFlight !== 0) throw new RuntimeError('PRECONDITION_FAILED', `Writer ${writer} is not independently verified for mutation`);
      }
      const leaseId = randomUUID();
      const writers = { ...current.writers, [writer]: { ...record, state: 'ACTIVE' as const, inFlight: record.inFlight + 1, ownerInstanceId: this.identity.instanceId, leaseIds: [...record.leaseIds, leaseId] } };
      let released = false;
      return {
        value: {
          writer,
          release: async () => {
          if (released) return;
            try {
              await this.transaction(async (latest) => {
                const active = latest.writers[writer];
                if (active === undefined || !active.leaseIds.includes(leaseId) || active.inFlight < 1) throw new RuntimeError('PERSISTENCE_FAILURE', `Writer ${writer} lease accounting is inconsistent`);
                const nextCount = active.inFlight - 1;
                const leaseIds = active.leaseIds.filter((id) => id !== leaseId);
                return { value: undefined, document: { ...latest, writers: { ...latest.writers, [writer]: { ...active, state: nextCount === 0 && active.observedState === 'IDLE' && active.observedInFlight === 0 ? 'IDLE' : 'ACTIVE', inFlight: nextCount, leaseIds } } } };
              });
              released = true;
            } catch (error) {
              const latest = await this.inspect().catch(() => null);
              if (latest !== null) {
                this.assertIdentity(latest);
                const active = latest.writers[writer];
                if (active !== undefined && !active.leaseIds.includes(leaseId)) {
                  released = true;
                  return;
                }
              }
              throw error;
            }
          },
        },
        document: { ...current, writers },
      };
    });
  }

  public async quiesce(ownerAccessToken: string, observations: Readonly<Record<string, WriterObservation>> = {}): Promise<SafetySnapshot> {
    return this.transaction(async (current) => {
      this.authorize(current, ownerAccessToken);
      if (current.state === 'QUIESCED') {
        const reasons = [...quiescenceReasons(current, {}), ...await freshQuiescenceReasons(current, this.writerVerifier)];
        if (reasons.length === 0) return { value: current, document: current };
        const next = { ...current, state: 'BLOCKED' as const, blockedReason: reasons.join('; ') };
        return { value: next, document: next };
      }
      if (current.state !== 'ACTIVE') throw new RuntimeError('PRECONDITION_FAILED', `Production safety state is ${current.state}`);
      const observed = await applyObservations(current, observations, this.identity, this.writerVerifier);
      const reasons = [...quiescenceReasons(observed, observations), ...await freshQuiescenceReasons(observed, this.writerVerifier)];
      const state: ProductionFenceState = reasons.length === 0 ? 'QUIESCED' : 'BLOCKED';
      const next = { ...observed, state, blockedReason: reasons.length === 0 ? null : reasons.join('; '), fenceEpoch: reasons.length === 0 ? observed.fenceEpoch + 1 : observed.fenceEpoch };
      return { value: next, document: next };
    });
  }

  public async recover(ownerAccessToken: string, observations: Readonly<Record<string, WriterObservation>>): Promise<SafetySnapshot> {
    return this.transaction(async (current) => {
      this.authorize(current, ownerAccessToken);
      if (!['BLOCKED', 'RECOVERY_REQUIRED'].includes(current.state)) throw new RuntimeError('PRECONDITION_FAILED', `Production safety state is ${current.state}`);
      if (current.reservation !== null) throw new RuntimeError('PRECONDITION_FAILED', 'Safety reservation outcome must be verified before recovery');
      const observed = await applyObservations(current, observations, this.identity, this.writerVerifier);
      const reasons = [...quiescenceReasons(observed, observations), ...await freshQuiescenceReasons(observed, this.writerVerifier)];
      if (reasons.length > 0) throw new RuntimeError('PRECONDITION_FAILED', `Recovery is not verified: ${reasons.join('; ')}`);
      const next = { ...observed, state: 'ACTIVE' as const, blockedReason: null, backup: null, restore: null, reservation: null };
      return { value: next, document: next };
    });
  }

  public async unfence(ownerAccessToken: string): Promise<SafetySnapshot> {
    return this.transaction(async (current) => {
      this.authorize(current, ownerAccessToken);
      if (current.state !== 'QUIESCED') throw new RuntimeError('PRECONDITION_FAILED', 'Only a verified QUIESCED fence can be released');
      if (current.reservation !== null) throw new RuntimeError('PRECONDITION_FAILED', 'A backup or restore reservation is active');
      const reasons = [...quiescenceReasons(current, {}), ...await freshQuiescenceReasons(current, this.writerVerifier)];
      if (reasons.length > 0) throw new RuntimeError('PRECONDITION_FAILED', `Cannot release fence: ${reasons.join('; ')}`);
      const next = { ...current, state: 'ACTIVE' as const, backup: null, restore: null };
      return { value: next, document: next };
    });
  }

  public async readiness(): Promise<ReadinessReport> {
    const fence = await this.inspect();
    const reasons: string[] = [];
    if (fence.state !== 'QUIESCED') reasons.push(`fence state is ${fence.state}`);
    if (fence.reservation !== null) reasons.push(`reservation ${fence.reservation.id} is ${fence.reservation.status.toLowerCase()}`);
    reasons.push(...quiescenceReasons(fence, {}), ...await freshQuiescenceReasons(fence, this.writerVerifier));
    if (fence.backup === null) reasons.push('a verified backup is not recorded');
    if (fence.restore === null) reasons.push('a disposable restore drill is not recorded');
    if (fence.backup !== null) {
      if (fence.backup.fenceEpoch !== fence.fenceEpoch) reasons.push('backup evidence is from an earlier fence epoch');
      if (!sameIdentity(fence.backup.sourceIdentity, fence.identity)) reasons.push('backup evidence belongs to another runtime identity');
      try {
        const manifest = await verifyRuntimeBackup(fence.backup.destination);
        if (manifestDigest(manifest) !== fence.backup.manifestDigest || manifest.backupId !== fence.backup.backupId || !sameIdentity(manifest.sourceIdentity, fence.backup.sourceIdentity)) reasons.push('backup evidence does not match its verified artifact');
        if (manifest.checkpoint === null || fence.backup.checkpointDigest !== manifest.checkpoint.sha256) reasons.push('backup does not include verified task checkpoint evidence');
      } catch { reasons.push('recorded backup is no longer verifiable'); }
    }
    if (fence.restore !== null) {
      if (fence.backup === null) reasons.push('restore evidence has no current backup');
      else if (!sameBackupEvidence(fence.backup, fence.restore)) reasons.push('restore evidence does not match the current verified backup');
      if (fence.restore.fenceEpoch !== fence.fenceEpoch) reasons.push('restore evidence is from an earlier fence epoch');
      if (!sameIdentity(fence.restore.sourceIdentity, fence.identity)) reasons.push('restore evidence belongs to another runtime identity');
      try {
        const manifest = await verifyRuntimeBackup(fence.restore.destination);
        if (manifestDigest(manifest) !== fence.restore.manifestDigest || manifest.backupId !== fence.restore.backupId || !sameIdentity(manifest.sourceIdentity, fence.restore.sourceIdentity)) reasons.push('restore evidence does not match its verified artifact');
        if (manifest.checkpoint === null || fence.restore.checkpointDigest !== manifest.checkpoint.sha256) reasons.push('restore drill does not include verified task checkpoint evidence');
        if (fence.restore.checkpointTarget === null || await hashFile(fence.restore.checkpointTarget) !== fence.restore.checkpointDigest) reasons.push('restored task checkpoint is unavailable or changed');
      } catch { reasons.push('restored runtime is no longer verifiable'); }
    }
    try {
      const latest = await withLock(this.dataRoot, () => readDocument(this.dataRoot), this.identity);
      if (latest.generation !== fence.generation) reasons.push('safety state changed during readiness evaluation');
      if (latest.state !== 'QUIESCED') reasons.push(`fence state changed to ${latest.state} during readiness evaluation`);
      if (latest.reservation !== null) reasons.push('a safety reservation became active during readiness evaluation');
      reasons.push(...quiescenceReasons(latest, {}), ...await freshQuiescenceReasons(latest, this.writerVerifier));
    } catch {
      reasons.push('safety state could not be rechecked after artifact verification');
    }
    return { status: reasons.length === 0 ? 'READY_FOR_OWNER_WINDOW' : 'BLOCKED', reasons, fence };
  }

  public async requireQuiesced(ownerAccessToken: string): Promise<SafetySnapshot> {
    return this.transaction(async (current) => {
      this.authorize(current, ownerAccessToken);
      if (current.state !== 'QUIESCED') throw new RuntimeError('PRECONDITION_FAILED', 'A verified QUIESCED fence is required');
      if (current.reservation !== null) throw new RuntimeError('PRECONDITION_FAILED', 'A safety reservation is already active');
      if ([...quiescenceReasons(current, {}), ...await freshQuiescenceReasons(current, this.writerVerifier)].length > 0) throw new RuntimeError('PRECONDITION_FAILED', 'Writer inventory is not idle and verified');
      return { value: current, document: current };
    });
  }

  public async reserveBackup(ownerAccessToken: string, destination: string): Promise<{ readonly id: string; readonly fence: SafetySnapshot }> {
    return this.transaction(async (current) => {
      this.authorize(current, ownerAccessToken);
      await this.assertQuiescedForReservation(current);
      const reservation: SafetyReservation = { id: randomUUID(), operation: 'BACKUP', ownerInstanceId: this.identity.instanceId, fenceEpoch: current.fenceEpoch, destination: path.resolve(destination), checkpointTarget: null, startedAt: new Date().toISOString(), status: 'ACTIVE' };
      const next = { ...current, reservation };
      return { value: { id: reservation.id, fence: next }, document: next };
    });
  }

  public async completeBackup(ownerAccessToken: string, reservationId: string, evidence: BackupEvidence): Promise<void> {
    await this.transaction(async (current) => {
      this.authorize(current, ownerAccessToken);
      const reservation = this.assertReservation(current, reservationId, 'BACKUP');
      if (current.state !== 'QUIESCED') throw new RuntimeError('PRECONDITION_FAILED', 'Backup completion requires a QUIESCED fence');
      if (!sameIdentity(evidence.sourceIdentity, current.identity) || evidence.fenceEpoch !== current.fenceEpoch || path.resolve(evidence.destination) !== reservation.destination) throw new RuntimeError('AUTHORITY_CHANGED', 'Backup evidence does not match the fenced reservation');
      const next = { ...current, backup: evidence, restore: null, reservation: null };
      return { value: undefined, document: next };
    });
  }

  public async reserveRestore(ownerAccessToken: string, destination: string, checkpointTarget: string | null): Promise<{ readonly id: string; readonly fence: SafetySnapshot }> {
    return this.transaction(async (current) => {
      this.authorize(current, ownerAccessToken);
      await this.assertQuiescedForReservation(current);
      if (current.backup === null) throw new RuntimeError('PRECONDITION_FAILED', 'Restore requires a current verified backup');
      const reservation: SafetyReservation = { id: randomUUID(), operation: 'RESTORE', ownerInstanceId: this.identity.instanceId, fenceEpoch: current.fenceEpoch, destination: path.resolve(destination), checkpointTarget: checkpointTarget === null ? null : path.resolve(checkpointTarget), startedAt: new Date().toISOString(), status: 'ACTIVE' };
      const next = { ...current, reservation };
      return { value: { id: reservation.id, fence: next }, document: next };
    });
  }

  public async completeRestore(ownerAccessToken: string, reservationId: string, evidence: RestoreEvidence): Promise<void> {
    await this.transaction(async (current) => {
      this.authorize(current, ownerAccessToken);
      const reservation = this.assertReservation(current, reservationId, 'RESTORE');
      if (current.state !== 'QUIESCED') throw new RuntimeError('PRECONDITION_FAILED', 'Restore completion requires a QUIESCED fence');
      if (current.backup === null || !sameBackupEvidence(current.backup, evidence) || !sameIdentity(evidence.sourceIdentity, current.identity) || evidence.fenceEpoch !== current.fenceEpoch || path.resolve(evidence.destination) !== reservation.destination || evidence.checkpointTarget !== reservation.checkpointTarget) throw new RuntimeError('PRECONDITION_FAILED', 'Restore evidence does not match the current verified backup or reservation');
      const next = { ...current, restore: evidence, reservation: null };
      return { value: undefined, document: next };
    });
  }

  public async failReservation(ownerAccessToken: string, reservationId: string, reason: string): Promise<void> {
    await this.transaction(async (current) => {
      this.authorize(current, ownerAccessToken);
      if (current.reservation?.id !== reservationId || current.reservation.ownerInstanceId !== this.identity.instanceId) return { value: undefined, document: current };
      const next = { ...current, state: 'BLOCKED' as const, blockedReason: `Safety reservation ${reservationId} failed: ${reason}`, reservation: { ...current.reservation, status: 'FAILED' as const } };
      return { value: undefined, document: next };
    });
  }

  private async assertQuiescedForReservation(current: SafetyDocument): Promise<void> {
    if (current.state !== 'QUIESCED') throw new RuntimeError('PRECONDITION_FAILED', 'A verified QUIESCED fence is required');
    if (current.reservation !== null) throw new RuntimeError('PRECONDITION_FAILED', 'A safety reservation is already active');
    if ([...quiescenceReasons(current, {}), ...await freshQuiescenceReasons(current, this.writerVerifier)].length > 0) throw new RuntimeError('PRECONDITION_FAILED', 'Writer inventory is not idle and verified');
    for (const writer of REQUIRED_WRITERS) {
      if (INSTRUMENTED_WRITERS.includes(writer as typeof INSTRUMENTED_WRITERS[number])) continue;
      const record = current.writers[writer];
      if (record === undefined || record.state === 'UNKNOWN') throw new RuntimeError('PRECONDITION_FAILED', `Writer ${writer} is not verified`);
      const verified = await verifyWriterEvidence(current, this.identity, this.writerVerifier, writer);
      if (verified.state !== record.observedState || verified.inFlight !== record.observedInFlight || verified.state !== 'IDLE' || verified.inFlight !== 0) throw new RuntimeError('PRECONDITION_FAILED', `Writer ${writer} verification does not match the fenced inventory`);
    }
  }

  private assertReservation(current: SafetyDocument, reservationId: string, operation: SafetyReservation['operation']): SafetyReservation {
    const reservation = current.reservation;
    if (reservation === null || reservation.id !== reservationId || reservation.operation !== operation || reservation.ownerInstanceId !== this.identity.instanceId || reservation.status !== 'ACTIVE') throw new RuntimeError('PRECONDITION_FAILED', 'Safety reservation is not owned by this runtime instance');
    return reservation;
  }

  private async transaction<T>(operation: (current: SafetyDocument) => Promise<{ readonly value: T; readonly document: SafetyDocument }> | { readonly value: T; readonly document: SafetyDocument }): Promise<T> {
    return this.enqueue(async () => withLock(this.dataRoot, async () => {
      const current = await readDocument(this.dataRoot);
      this.document = current;
      const result = await operation(current);
      const next = result.document === current ? current : bump(result.document);
      if (next !== current) await writeDocument(path.join(this.dataRoot, SAFETY_FILE), next);
      this.document = next;
      return result.value;
    }, this.identity));
  }

  private authorize(document: SafetyDocument, token: string): void {
    this.assertIdentity(document);
    if (this.ownerAccessSecret.length < 1) throw new RuntimeError('CONTROL_DENIED', 'Owner access token is unavailable');
    const expected = Buffer.from(this.ownerAccessSecret);
    const provided = Buffer.from(token);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new RuntimeError('CONTROL_DENIED', 'Owner authorization is invalid');
  }

  private assertIdentity(document: SafetyDocument): void {
    if (document.identity.runtimeId !== this.identity.runtimeId || document.identity.instanceId !== this.identity.instanceId || document.identity.dataRoot !== this.identity.dataRoot) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'Production safety identity changed');
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    const queued = this.operationTail.then(async () => { result = await operation(); }, async () => { result = await operation(); });
    this.operationTail = queued.then(() => undefined, () => undefined);
    await queued;
    return result;
  }
}
export async function createRuntimeBackup(input: CreateBackupInput): Promise<BackupManifest> {
  const destination = path.resolve(input.destination);
  const reservation = await input.controller.reserveBackup(input.ownerAccessToken, destination);
  const fence = reservation.fence;
  const source = fence.identity.dataRoot;
  const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.staging`);
  try {
    await assertDestinationAvailable([source], destination);
    await mkdir(staging, { mode: 0o700 });
    const files = await copyTree(source, staging);
    if (input.checkpointFile !== undefined && isWithin(source, path.resolve(input.checkpointFile))) throw new RuntimeError('PRECONDITION_FAILED', 'Checkpoint source must be outside the runtime data root');
    const checkpoint = input.checkpointFile === undefined ? null : await copyCheckpoint(input.checkpointFile, staging);
    const manifest: BackupManifest = { schemaVersion: 1, backupId: randomUUID(), createdAt: new Date().toISOString(), sourceIdentity: fence.identity, fenceGeneration: fence.generation, files: files.sort((a, b) => a.path.localeCompare(b.path)), checkpoint };
    await writePrivateJson(path.join(staging, MANIFEST_FILE), manifest);
    await chmod(staging, 0o700);
    await verifyRuntimeBackup(staging);
    await rename(staging, destination);
    await verifyRuntimeBackup(destination);
    await input.controller.completeBackup(input.ownerAccessToken, reservation.id, {
      backupId: manifest.backupId,
      destination,
      manifestDigest: manifestDigest(manifest),
      sourceIdentity: manifest.sourceIdentity,
      fenceEpoch: fence.fenceEpoch,
      checkpointDigest: manifest.checkpoint?.sha256 ?? null,
      verifiedAt: new Date().toISOString(),
    });
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await input.controller.failReservation(input.ownerAccessToken, reservation.id, error instanceof Error ? error.message : 'backup outcome is unknown').catch(() => undefined);
    throw error;
  }
}

export async function verifyRuntimeBackup(destinationInput: string): Promise<BackupManifest> {
  const destination = path.resolve(destinationInput);
  const problem = await privateDirectoryProblem(destination, 'Backup directory');
  if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
  const manifestPath = path.join(destination, MANIFEST_FILE);
  const manifest = parseManifest(await readPrivateFile(manifestPath, 'Backup manifest'));
  const actual = (await listFiles(destination)).filter((file) => file !== MANIFEST_FILE && file !== SAFETY_LOCK);
  const expected = new Set(manifest.files.map((file) => file.path));
  if (manifest.checkpoint !== null) expected.add(CHECKPOINT_FILE);
  const actualSet = new Set(actual);
  if (actualSet.size !== expected.size || actual.some((file) => !expected.has(file))) throw new RuntimeError('PERSISTENCE_FAILURE', 'Backup contains missing or unexpected files');
  for (const file of manifest.files) {
    const filename = safeJoin(destination, file.path);
    const metadata = await safeFileMetadata(filename, 'Backup file');
    if (metadata.size !== file.size || metadata.mode !== file.mode || await hashFile(filename) !== file.sha256) throw new RuntimeError('PERSISTENCE_FAILURE', `Backup integrity check failed for ${file.path}`);
  }
  if (manifest.checkpoint !== null) {
    const checkpoint = await safeFileMetadata(safeJoin(destination, CHECKPOINT_FILE), 'Backup checkpoint');
    if (checkpoint.size !== manifest.checkpoint.size || checkpoint.mode !== manifest.checkpoint.mode || await hashFile(safeJoin(destination, CHECKPOINT_FILE)) !== manifest.checkpoint.sha256) throw new RuntimeError('PERSISTENCE_FAILURE', 'Backup checkpoint integrity check failed');
  }
  return manifest;
}

export async function restoreRuntimeBackup(input: RestoreBackupInput): Promise<BackupManifest> {
  if (input.disposable !== true) throw new RuntimeError('PRECONDITION_FAILED', 'Restore requires disposable: true');
  const backupRoot = path.resolve(input.backupRoot);
  const destination = path.resolve(input.destination);
  const checkpointTarget = input.checkpointFile === undefined ? null : path.resolve(input.checkpointFile);
  const reservation = await input.controller.reserveRestore(input.ownerAccessToken, destination, checkpointTarget);
  const fence = reservation.fence;
  const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.staging`);
  let checkpointStaging: string | undefined;
  try {
    const manifest = await verifyRuntimeBackup(backupRoot);
    if (manifest.sourceIdentity.dataRoot !== fence.identity.dataRoot || manifest.sourceIdentity.runtimeId !== fence.identity.runtimeId || manifest.sourceIdentity.instanceId !== fence.identity.instanceId) throw new RuntimeError('AUTHORITY_CHANGED', 'Backup identity does not match the fenced runtime instance');
    await assertDestinationAvailable([fence.identity.dataRoot, backupRoot], destination);
    if (checkpointTarget !== null) await assertCheckpointTargetAvailable(checkpointTarget, [fence.identity.dataRoot, backupRoot, destination]);
    await mkdir(staging, { mode: 0o700 });
    for (const file of manifest.files) {
      const source = safeJoin(backupRoot, file.path);
      const target = safeJoin(staging, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      await chmod(target, file.mode);
    }
    if (manifest.checkpoint !== null) {
      if (input.checkpointFile === undefined) throw new RuntimeError('PRECONDITION_FAILED', 'Restore requires a disposable checkpoint target');
      await assertNewPrivateFile(input.checkpointFile);
      const checkpointTarget = path.resolve(input.checkpointFile);
      checkpointStaging = `${checkpointTarget}.${process.pid}.${randomUUID()}.staging`;
      await copyFile(safeJoin(backupRoot, CHECKPOINT_FILE), checkpointStaging);
      await chmod(checkpointStaging, manifest.checkpoint.mode);
      await copyFile(safeJoin(backupRoot, CHECKPOINT_FILE), path.join(staging, CHECKPOINT_FILE));
      await chmod(path.join(staging, CHECKPOINT_FILE), manifest.checkpoint.mode);
      await writePrivateJson(path.join(staging, MANIFEST_FILE), manifest);
      await verifyRuntimeBackup(staging);
      await rename(staging, destination);
      await rename(checkpointStaging, checkpointTarget);
      await verifyRuntimeBackup(destination);
      await verifyCheckpointTarget(checkpointTarget!, manifest.checkpoint.sha256);
      await input.controller.completeRestore(input.ownerAccessToken, reservation.id, {
        backupId: manifest.backupId,
        destination,
        checkpointTarget,
        manifestDigest: manifestDigest(manifest),
        sourceIdentity: manifest.sourceIdentity,
        fenceEpoch: fence.fenceEpoch,
        checkpointDigest: manifest.checkpoint.sha256,
        verifiedAt: new Date().toISOString(),
      });
      return manifest;
    }
    await writePrivateJson(path.join(staging, MANIFEST_FILE), manifest);
    await verifyRuntimeBackup(staging);
    await rename(staging, destination);
    await verifyRuntimeBackup(destination);
    await input.controller.completeRestore(input.ownerAccessToken, reservation.id, {
      backupId: manifest.backupId,
      destination,
      checkpointTarget: null,
      manifestDigest: manifestDigest(manifest),
      sourceIdentity: manifest.sourceIdentity,
      fenceEpoch: fence.fenceEpoch,
      checkpointDigest: null,
      verifiedAt: new Date().toISOString(),
    });
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (checkpointStaging !== undefined) await rm(checkpointStaging, { force: true }).catch(() => undefined);
    await input.controller.failReservation(input.ownerAccessToken, reservation.id, error instanceof Error ? error.message : 'restore outcome is unknown').catch(() => undefined);
    throw error;
  }
}

function emptyDocument(identity: SafetyIdentity): SafetyDocument {
  const writers: Record<string, WriterRecord> = {};
  for (const writer of REQUIRED_WRITERS) writers[writer] = { state: 'UNKNOWN', inFlight: 0, observedState: 'UNKNOWN', observedInFlight: 0, ownerInstanceId: null, leaseIds: [] };
  return { schemaVersion: 1, generation: 0, state: 'ACTIVE', identity, writers, blockedReason: null, fenceEpoch: 0, backup: null, restore: null, reservation: null, updatedAt: new Date().toISOString() };
}

async function applyObservations(document: SafetyDocument, observations: Readonly<Record<string, WriterObservation>>, identity: SafetyIdentity, verifier: TrustedWriterVerifier | undefined): Promise<SafetyDocument> {
  const writers = { ...document.writers };
  for (const [name, observation] of Object.entries(observations)) {
    if (!REQUIRED_WRITERS.includes(name as SafetyWriterName)) throw new RuntimeError('INVALID_REQUEST', `Writer observation for ${name} is not supported`);
    if (!WRITER_STATES.includes(observation.state) || !Number.isSafeInteger(observation.inFlight ?? 0) || (observation.inFlight ?? 0) < 0) throw new RuntimeError('INVALID_REQUEST', `Writer observation for ${name} is invalid`);
    const candidate = observation as WriterObservation & Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(candidate, 'verified') || Object.prototype.hasOwnProperty.call(candidate, 'runtimeId') || Object.prototype.hasOwnProperty.call(candidate, 'instanceId') || Object.prototype.hasOwnProperty.call(candidate, 'dataRoot') || Object.prototype.hasOwnProperty.call(candidate, 'fenceEpoch') || Object.prototype.hasOwnProperty.call(candidate, 'generation')) throw new RuntimeError('PRECONDITION_FAILED', `Writer observation for ${name} contains caller-supplied proof`);
    const current = writers[name];
    if (current !== undefined && (current.inFlight > 0 || current.leaseIds.length > 0)) throw new RuntimeError('PRECONDITION_FAILED', `Writer ${name} has an active mutation lease that observations cannot reconcile`);
    const verified = await verifyWriterEvidence(document, identity, verifier, name as SafetyWriterName);
    if (verified === null || verified.state !== observation.state || verified.inFlight !== (observation.inFlight ?? 0)) throw new RuntimeError('PRECONDITION_FAILED', `Writer observation for ${name} is not independently verified`);
    if (current !== undefined) writers[name] = { ...current, state: verified.state, inFlight: 0, observedState: verified.state, observedInFlight: verified.inFlight, ownerInstanceId: identity.instanceId, leaseIds: [] };
  }
  return { ...document, writers };
}

async function verifyWriterEvidence(document: SafetyDocument, identity: SafetyIdentity, verifier: TrustedWriterVerifier | undefined, writer: SafetyWriterName): Promise<TrustedWriterVerification> {
  if (verifier === undefined) throw new RuntimeError('PRECONDITION_FAILED', `Writer ${writer} has no trusted verifier`);
  let verified: TrustedWriterVerification | null;
  try {
    verified = await verifier.verify(writer, identity, { fenceEpoch: document.fenceEpoch, generation: document.generation });
  } catch {
    throw new RuntimeError('PRECONDITION_FAILED', `Writer ${writer} verification failed`);
  }
  if (verified === null
    || typeof verified !== 'object'
    || !['IDLE', 'ACTIVE'].includes(verified.state)
    || !Number.isSafeInteger(verified.inFlight)
    || verified.inFlight < 0
    || typeof verified.runtimeId !== 'string'
    || typeof verified.instanceId !== 'string'
    || typeof verified.dataRoot !== 'string'
    || verified.runtimeId !== identity.runtimeId
    || verified.instanceId !== identity.instanceId
    || path.resolve(verified.dataRoot) !== path.resolve(identity.dataRoot)
    || verified.fenceEpoch !== document.fenceEpoch
    || verified.generation !== document.generation) {
    throw new RuntimeError('PRECONDITION_FAILED', `Writer ${writer} verification is stale, conflicting, or unbound`);
  }
  return verified;
}

function quiescenceReasons(document: SafetyDocument, observations: Readonly<Record<string, WriterObservation>>): string[] {
  const reasons: string[] = [];
  for (const writer of REQUIRED_WRITERS) {
    const record = document.writers[writer];
    if (record === undefined || record.state === 'UNKNOWN') reasons.push(`writer ${writer} is unknown`);
    else if (record.inFlight > 0 || record.state === 'ACTIVE') reasons.push(`writer ${writer} is active`);
    else if (record.observedInFlight > 0 || record.observedState === 'ACTIVE') reasons.push(`writer ${writer} has active external work`);
    if (record !== undefined && record.state !== 'UNKNOWN' && record.ownerInstanceId !== document.identity.instanceId) reasons.push(`writer ${writer} belongs to another runtime instance`);
    if (record !== undefined && record.leaseIds.length !== record.inFlight) reasons.push(`writer ${writer} lease accounting is inconsistent`);
    const observed = observations[writer];
    if (observed?.state === 'ACTIVE' || (observed?.inFlight ?? 0) > 0) reasons.push(`observation reports ${writer} active`);
  }
  return [...new Set(reasons)];
}

async function freshQuiescenceReasons(document: SafetyDocument, verifier: TrustedWriterVerifier | undefined): Promise<string[]> {
  const reasons: string[] = [];
  for (const writer of REQUIRED_WRITERS) {
    if (INSTRUMENTED_WRITERS.includes(writer as typeof INSTRUMENTED_WRITERS[number])) continue;
    if (verifier === undefined) {
      reasons.push(`writer ${writer} has no trusted verifier`);
      continue;
    }
    try {
      const verified = await verifyWriterEvidence(document, document.identity, verifier, writer);
      if (verified.state !== 'IDLE' || verified.inFlight !== 0) reasons.push(`writer ${writer} is active from fresh verification`);
      const record = document.writers[writer];
      if (record === undefined || record.observedState !== verified.state || record.observedInFlight !== verified.inFlight) reasons.push(`writer ${writer} observation is stale`);
    } catch {
      reasons.push(`writer ${writer} fresh verification is unavailable`);
    }
  }
  return [...new Set(reasons)];
}

function sameIdentity(left: SafetyIdentity, right: SafetyIdentity): boolean {
  return left.runtimeId === right.runtimeId && left.instanceId === right.instanceId && path.resolve(left.dataRoot) === path.resolve(right.dataRoot);
}

function sameBackupEvidence(backup: BackupEvidence, restore: RestoreEvidence): boolean {
  return backup.backupId === restore.backupId
    && backup.manifestDigest === restore.manifestDigest
    && backup.fenceEpoch === restore.fenceEpoch
    && backup.checkpointDigest === restore.checkpointDigest
    && sameIdentity(backup.sourceIdentity, restore.sourceIdentity);
}

async function copyTree(source: string, destination: string): Promise<BackupManifest['files'][number][]> {
  const files: BackupManifest['files'][number][] = [];
  for (const relative of await listFiles(source)) {
    if (relative === CHECKPOINT_FILE) throw new RuntimeError('PERSISTENCE_FAILURE', `${CHECKPOINT_FILE} is reserved for checkpoint evidence`);
    if (relative === SAFETY_LOCK) continue;
    const from = safeJoin(source, relative);
    const to = safeJoin(destination, relative);
    const before = await safeFileMetadata(from, 'Runtime data file');
    const content = await readFile(from);
    const after = await safeFileMetadata(from, 'Runtime data file');
    if (before.size !== after.size || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs) throw new RuntimeError('PERSISTENCE_FAILURE', `Runtime data changed while backing up ${relative}`);
    await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
    await writeFile(to, content, { mode: before.mode, flag: 'wx' });
    await chmod(to, before.mode);
    files.push({ path: relative, size: content.length, sha256: createHash('sha256').update(content).digest('hex'), mode: before.mode });
  }
  return files;
}

async function copyCheckpoint(sourceInput: string, destination: string): Promise<NonNullable<BackupManifest['checkpoint']>> {
  const source = path.resolve(sourceInput);
  const metadata = await safeFileMetadata(source, 'Checkpoint file');
  if (isWithin(path.resolve(destination), source)) throw new RuntimeError('PRECONDITION_FAILED', 'Checkpoint source overlaps backup staging');
  const content = await readFile(source);
  const after = await safeFileMetadata(source, 'Checkpoint file');
  if (metadata.size !== after.size || metadata.mode !== after.mode || metadata.mtimeMs !== after.mtimeMs) throw new RuntimeError('PERSISTENCE_FAILURE', 'Checkpoint changed while backing up');
  const target = path.join(destination, CHECKPOINT_FILE);
  await writeFile(target, content, { mode: metadata.mode, flag: 'wx' });
  await chmod(target, metadata.mode);
  return { size: content.length, sha256: createHash('sha256').update(content).digest('hex'), mode: metadata.mode };
}

async function verifyCheckpointTarget(filename: string, expectedDigest: string): Promise<void> {
  await safeFileMetadata(filename, 'Restored checkpoint');
  if (await hashFile(filename) !== expectedDigest) throw new RuntimeError('PERSISTENCE_FAILURE', 'Restored checkpoint integrity check failed');
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(safeJoin(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filename = safeJoin(root, relative);
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink()) throw new RuntimeError('PERSISTENCE_FAILURE', `Symlink is not allowed in safety data: ${relative}`);
    if (metadata.isDirectory()) output.push(...await listFiles(root, relative));
    else if (metadata.isFile()) {
      if (metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw new RuntimeError('PERSISTENCE_FAILURE', `Unsafe runtime data file: ${relative}`);
      output.push(relative);
    } else throw new RuntimeError('PERSISTENCE_FAILURE', `Unsupported runtime data entry: ${relative}`);
  }
  return output;
}

async function assertDestinationAvailable(protectedRoots: readonly string[], destination: string): Promise<void> {
  const canonicalDestination = await canonicalNewPath(destination, 'Backup destination parent');
  const canonicalRoots = await Promise.all(protectedRoots.map(async (root) => realpath(root).catch(() => path.resolve(root))));
  if (canonicalRoots.some((root) => canonicalDestination === root || isWithin(root, canonicalDestination) || isWithin(canonicalDestination, root))) throw new RuntimeError('PRECONDITION_FAILED', 'Backup or restore destination overlaps protected safety data');
  try { await lstat(destination); throw new RuntimeError('PRECONDITION_FAILED', 'Backup or restore destination already exists'); }
  catch (error: unknown) { if (!isNotFound(error)) throw error; }
  const parent = path.dirname(destination);
  const problem = await privateDirectoryProblem(parent, 'Backup destination parent');
  if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
}

async function assertNewPrivateFile(filenameInput: string): Promise<void> {
  const filename = path.resolve(filenameInput);
  try { await lstat(filename); throw new RuntimeError('PRECONDITION_FAILED', 'Checkpoint restore target already exists'); }
  catch (error: unknown) { if (!isNotFound(error)) throw error; }
  const problem = await privateDirectoryProblem(path.dirname(filename), 'Checkpoint restore parent');
  if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
  await canonicalNewPath(filename, 'Checkpoint restore parent');
}

async function assertCheckpointTargetAvailable(filenameInput: string, protectedRoots: readonly string[]): Promise<void> {
  const filename = path.resolve(filenameInput);
  const canonicalFilename = await canonicalNewPath(filename, 'Checkpoint restore parent');
  const canonicalRoots = await Promise.all(protectedRoots.map(async (root) => realpath(root).catch(() => path.resolve(root))));
  if (canonicalRoots.some((root) => canonicalFilename === root || isWithin(root, canonicalFilename) || isWithin(canonicalFilename, root))) throw new RuntimeError('PRECONDITION_FAILED', 'Checkpoint restore target overlaps protected safety data');
  await assertNewPrivateFile(filename);
}

async function canonicalNewPath(filename: string, label: string): Promise<string> {
  const parent = path.dirname(path.resolve(filename));
  const parts = parent.split(path.sep).filter(Boolean);
  let current = path.parse(parent).root;
  for (const part of parts) {
    current = path.join(current, part);
    const metadata = await lstat(current).catch(() => null);
    if (metadata?.isSymbolicLink() && current !== '/var' && current !== '/tmp') throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is not a canonical physical path`);
  }
  const canonical = await realpath(parent).catch(() => null);
  if (canonical === null) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is not an existing physical path`);
  return path.join(canonical, path.basename(filename));
}

async function safeFileMetadata(filename: string, label: string): Promise<{ size: number; mode: number; mtimeMs: number }> {
  const metadata = await lstat(filename).catch((error) => { throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is unavailable`, { cause: error }); });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is not a private physical file`);
  return { size: metadata.size, mode: metadata.mode & 0o777, mtimeMs: metadata.mtimeMs };
}

function safeJoin(root: string, relative: string): string {
  if (relative === '') return path.resolve(root);
  if (path.isAbsolute(relative) || relative.includes('\0') || relative.split('/').some((part) => part === '..' || part === '')) throw new RuntimeError('PERSISTENCE_FAILURE', 'Safety path is invalid');
  const candidate = path.resolve(root, ...relative.split('/'));
  if (!isWithin(path.resolve(root), candidate)) throw new RuntimeError('PERSISTENCE_FAILURE', 'Safety path escaped its root');
  return candidate;
}

async function writeDocument(filename: string, document: SafetyDocument): Promise<void> { await writePrivateJson(filename, document); }
async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temporary, filename); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw new RuntimeError('PERSISTENCE_FAILURE', 'Safety state publication failed', { cause: error }); }
}
async function readPrivateFile(filename: string, label: string): Promise<string> {
  const metadata = await lstat(filename).catch((error) => { throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is unavailable`, { cause: error }); });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw new RuntimeError('PERSISTENCE_FAILURE', `${label} is not private`);
  return readFile(filename, 'utf8');
}

async function readDocument(dataRoot: string): Promise<SafetyDocument> {
  try { return parseDocument(await readPrivateFile(path.join(dataRoot, SAFETY_FILE), 'Production safety state')); }
  catch (error: unknown) { throw error instanceof RuntimeError ? error : new RuntimeError('PERSISTENCE_FAILURE', 'Production safety state is unreadable', { cause: error }); }
}

function bump(document: SafetyDocument): SafetyDocument {
  return { ...document, generation: document.generation + 1, updatedAt: new Date().toISOString() };
}

interface OwnedLock {
  readonly filename: string;
  readonly handle: FileHandle;
  readonly device: number;
  readonly inode: number;
}

async function withLock<T>(dataRoot: string, operation: () => Promise<T>, identity?: SafetyIdentity): Promise<T> {
  const filename = path.join(dataRoot, SAFETY_LOCK);
  let lock: OwnedLock | undefined;
  let handle: FileHandle | undefined;
  try {
    handle = await open(filename, 'wx', 0o600);
    const marker = verifiedProcessStartMarker();
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, processStartMarker: marker, lockId: randomUUID(), runtimeId: identity?.runtimeId ?? null, instanceId: identity?.instanceId ?? null, dataRoot: identity?.dataRoot ?? null, createdAt: new Date().toISOString() })}\n`, 'utf8');
    await handle.sync();
    const file = await handle.stat();
    const visible = await lstat(filename);
    if (file.dev !== visible.dev || file.ino !== visible.ino || visible.nlink !== 1 || (visible.mode & 0o077) !== 0) {
      await handle.close().catch(() => undefined);
      throw new RuntimeError('PERSISTENCE_FAILURE', 'Production safety lock identity changed during acquisition');
    }
    lock = { filename, handle, device: Number(file.dev), inode: Number(file.ino) };
    return await operation();
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new RuntimeError('SUPERVISOR_BUSY', 'Production safety state is busy');
    if (handle !== undefined) {
      const owned = await handle.stat().then(async (file) => {
        const visible = await lstat(filename).catch(() => null);
        return visible !== null && file.dev === visible.dev && file.ino === visible.ino;
      }).catch(() => false);
      await handle.close().catch(() => undefined);
      if (owned) await rm(filename, { force: true }).catch(() => undefined);
    }
    throw error instanceof RuntimeError ? error : new RuntimeError('PERSISTENCE_FAILURE', 'Production safety lock could not be acquired', { cause: error });
  }
  finally {
    if (lock !== undefined) await releaseLock(lock);
  }
}

function verifiedProcessStartMarker(): string {
  if (processStartMarker !== undefined) return processStartMarker;
  const observed = observeProcessStart(process.pid);
  if (observed.state !== 'live') throw new RuntimeError('SUPERVISOR_BUSY', 'Production safety process identity is indeterminate');
  processStartMarker = observed.marker;
  return processStartMarker;
}

async function releaseLock(lock: OwnedLock): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  try {
    const visible = await lstat(lock.filename);
    if (Number(visible.dev) !== lock.device || Number(visible.ino) !== lock.inode || visible.nlink !== 1) throw new RuntimeError('PERSISTENCE_FAILURE', 'Production safety lock ownership changed before release');
    await rm(lock.filename);
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PERSISTENCE_FAILURE', 'Production safety lock could not be released', { cause: error });
  }
}
function parseDocument(content: string): SafetyDocument {
  try {
    const value = JSON.parse(content) as Partial<SafetyDocument> & { writers?: Record<string, Partial<WriterRecord>> };
    if (value.schemaVersion !== 1 || !FENCE_STATES.includes(value.state as ProductionFenceState) || !Number.isSafeInteger(value.generation) || !value.writers || typeof value.writers !== 'object') throw new Error('schema');
    const generation = value.generation as number;
    const identity = parseIdentityValue(value.identity);
    const fenceEpoch = Number.isSafeInteger(value.fenceEpoch) && (value.fenceEpoch as number) >= 0 ? value.fenceEpoch as number : 0;
    const writers: Record<string, WriterRecord> = {};
    for (const [name, record] of Object.entries(value.writers)) {
      if (!REQUIRED_WRITERS.includes(name as SafetyWriterName)) throw new Error('writer name');
      if (!record || !WRITER_STATES.includes(record.state as SafetyWriterState) || !Number.isSafeInteger(record.inFlight) || record.inFlight < 0) throw new Error('writer schema');
      const leaseIds = record.leaseIds ?? [];
      const observedState = record.observedState ?? record.state;
      const observedInFlight = record.observedInFlight ?? 0;
      if (!Array.isArray(leaseIds) || leaseIds.some((id) => typeof id !== 'string') || leaseIds.length !== record.inFlight || !WRITER_STATES.includes(observedState as SafetyWriterState) || !Number.isSafeInteger(observedInFlight) || observedInFlight < 0) throw new Error('lease schema');
      writers[name] = { state: record.state as SafetyWriterState, inFlight: record.inFlight, observedState: observedState as SafetyWriterState, observedInFlight, ownerInstanceId: typeof record.ownerInstanceId === 'string' ? record.ownerInstanceId : null, leaseIds };
    }
    return {
      schemaVersion: 1,
      generation,
      state: value.state as ProductionFenceState,
      identity,
      writers,
      blockedReason: typeof value.blockedReason === 'string' ? value.blockedReason : null,
      fenceEpoch,
      backup: value.backup === null || value.backup === undefined ? null : parseBackupEvidence(value.backup),
      restore: value.restore === null || value.restore === undefined ? null : parseRestoreEvidence(value.restore),
      reservation: value.reservation === null || value.reservation === undefined ? null : parseReservation(value.reservation),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
    };
  } catch (error) { throw new RuntimeError('PERSISTENCE_FAILURE', 'Production safety state is invalid', { cause: error }); }
}

function parseIdentityValue(value: unknown): SafetyIdentity {
  if (!isRecord(value) || typeof value.runtimeId !== 'string' || typeof value.instanceId !== 'string' || typeof value.dataRoot !== 'string' || !path.isAbsolute(value.dataRoot)) throw new Error('identity schema');
  return { runtimeId: value.runtimeId, instanceId: value.instanceId, dataRoot: value.dataRoot };
}

function parseBackupEvidence(value: unknown): BackupEvidence {
  if (!isRecord(value) || typeof value.backupId !== 'string' || typeof value.destination !== 'string' || !path.isAbsolute(value.destination) || typeof value.manifestDigest !== 'string' || !Number.isSafeInteger(value.fenceEpoch) || (value.fenceEpoch as number) < 0 || (value.checkpointDigest !== null && typeof value.checkpointDigest !== 'string') || typeof value.verifiedAt !== 'string') throw new Error('backup evidence schema');
  return { backupId: value.backupId, destination: value.destination, manifestDigest: value.manifestDigest, sourceIdentity: parseIdentityValue(value.sourceIdentity), fenceEpoch: value.fenceEpoch as number, checkpointDigest: value.checkpointDigest as string | null, verifiedAt: value.verifiedAt };
}

function parseRestoreEvidence(value: unknown): RestoreEvidence {
  if (!isRecord(value) || typeof value.backupId !== 'string' || typeof value.destination !== 'string' || !path.isAbsolute(value.destination) || (value.checkpointTarget !== null && (typeof value.checkpointTarget !== 'string' || !path.isAbsolute(value.checkpointTarget))) || typeof value.manifestDigest !== 'string' || !Number.isSafeInteger(value.fenceEpoch) || (value.fenceEpoch as number) < 0 || (value.checkpointDigest !== null && typeof value.checkpointDigest !== 'string') || typeof value.verifiedAt !== 'string') throw new Error('restore evidence schema');
  return { backupId: value.backupId, destination: value.destination, checkpointTarget: value.checkpointTarget as string | null, manifestDigest: value.manifestDigest, sourceIdentity: parseIdentityValue(value.sourceIdentity), fenceEpoch: value.fenceEpoch as number, checkpointDigest: value.checkpointDigest as string | null, verifiedAt: value.verifiedAt };
}

function parseReservation(value: unknown): SafetyReservation {
  if (!isRecord(value) || typeof value.id !== 'string' || (value.operation !== 'BACKUP' && value.operation !== 'RESTORE') || typeof value.ownerInstanceId !== 'string' || !Number.isSafeInteger(value.fenceEpoch) || (value.fenceEpoch as number) < 0 || typeof value.destination !== 'string' || !path.isAbsolute(value.destination) || (value.checkpointTarget !== null && (typeof value.checkpointTarget !== 'string' || !path.isAbsolute(value.checkpointTarget))) || typeof value.startedAt !== 'string' || (value.status !== 'ACTIVE' && value.status !== 'FAILED')) throw new Error('reservation schema');
  return { id: value.id, operation: value.operation, ownerInstanceId: value.ownerInstanceId, fenceEpoch: value.fenceEpoch as number, destination: value.destination, checkpointTarget: value.checkpointTarget as string | null, startedAt: value.startedAt, status: value.status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseManifest(content: string): BackupManifest {
  try {
    const value = JSON.parse(content) as Partial<BackupManifest>;
    if (value.schemaVersion !== 1 || typeof value.backupId !== 'string' || typeof value.createdAt !== 'string' || !Number.isSafeInteger(value.fenceGeneration) || !Array.isArray(value.files) || (value.checkpoint !== null && (value.checkpoint === undefined || !Number.isSafeInteger(value.checkpoint.size) || typeof value.checkpoint.sha256 !== 'string' || !Number.isSafeInteger(value.checkpoint.mode))) || value.files.some((file) => !file || typeof file.path !== 'string' || file.path === SAFETY_LOCK || path.isAbsolute(file.path) || file.path.split('/').some((part: string) => part === '' || part === '..') || !Number.isSafeInteger(file.size) || typeof file.sha256 !== 'string' || !Number.isSafeInteger(file.mode))) throw new Error('schema');
    return { ...value, sourceIdentity: parseIdentityValue(value.sourceIdentity), files: value.files, checkpoint: value.checkpoint ?? null } as BackupManifest;
  } catch (error) { throw new RuntimeError('PERSISTENCE_FAILURE', 'Backup manifest is invalid', { cause: error }); }
}
function isWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); }
function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'; }
async function hashFile(filename: string): Promise<string> { return createHash('sha256').update(await readFile(filename)).digest('hex'); }
function manifestDigest(manifest: BackupManifest): string { return createHash('sha256').update(JSON.stringify(manifest)).digest('hex'); }
