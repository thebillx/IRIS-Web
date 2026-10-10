import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError, type RuntimeIdentity } from '@iris/domain';
import { inspectPrivateRegularFile, privateDirectoryProblem } from './private-fs.js';

const SAFETY_FILE = 'production-safety.json';
const SAFETY_LOCK = 'production-safety.lock';
const MANIFEST_FILE = 'manifest.json';
const CHECKPOINT_FILE = 'checkpoint.json';
const REQUIRED_WRITERS = ['runtime-state', 'mission-state', 'mission-broker', 'durable-jobs', 'supervisor', 'external-runners'] as const;
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
  readonly ownerInstanceId: string | null;
}

interface EvidenceRecord {
  readonly id: string;
  readonly at: string;
  readonly detail: string;
}

interface SafetyDocument {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly state: ProductionFenceState;
  readonly identity: SafetyIdentity;
  readonly writers: Readonly<Record<string, WriterRecord>>;
  readonly blockedReason: string | null;
  readonly backup: EvidenceRecord | null;
  readonly restore: EvidenceRecord | null;
  readonly updatedAt: string;
}

export type SafetySnapshot = SafetyDocument;

export interface WriterObservation {
  readonly state: SafetyWriterState;
  readonly inFlight?: number;
}

export interface ProductionSafetyOpenOptions {
  readonly dataRoot: string;
  readonly identity: SafetyIdentity | RuntimeIdentity;
  readonly ownerAccessSecret: string;
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
    const filename = path.join(dataRoot, SAFETY_FILE);
    let document: SafetyDocument | null = null;
    const inspected = await inspectPrivateRegularFile(filename, 'Production safety state');
    if (inspected.state === 'invalid') throw new RuntimeError('PERSISTENCE_FAILURE', inspected.reason);
    if (inspected.state === 'ok') document = parseDocument(inspected.content);
    if (document === null) {
      document = emptyDocument(identity);
      await writeDocument(filename, document);
    } else if (document.identity.runtimeId === identity.runtimeId && document.identity.instanceId !== identity.instanceId) {
      const nextState: ProductionFenceState = document.state === 'ACTIVE' ? 'ACTIVE' : 'RECOVERY_REQUIRED';
      document = { ...document, state: nextState, identity, blockedReason: nextState === 'ACTIVE' ? null : 'Runtime instance changed; owner recovery is required', generation: document.generation + 1, updatedAt: new Date().toISOString() };
      await writeDocument(filename, document);
    }
    return new ProductionSafetyController(dataRoot, identity, options.ownerAccessSecret, document);
  }

  public snapshot(): SafetySnapshot { return structuredClone(this.document); }

  public async inspect(): Promise<SafetySnapshot> {
    await this.refresh();
    return this.snapshot();
  }

  public registerWriter(name: string, state: SafetyWriterState = 'IDLE'): Promise<void> {
    if (!name || !WRITER_STATES.includes(state)) throw new RuntimeError('INVALID_REQUEST', 'Writer registration is invalid');
    return this.enqueue(async () => {
      const current = await this.refresh();
      if (current.writers[name] !== undefined && current.writers[name]!.inFlight > 0) return;
      const writers = { ...current.writers, [name]: { state, inFlight: 0, ownerInstanceId: this.identity.instanceId } };
      await this.persist({ ...current, writers });
    });
  }

  public beginMutation(writer: string): Promise<MutationLease> {
    return this.enqueue(async () => {
      const current = await this.refresh();
      this.assertIdentity(current);
      if (current.state !== 'ACTIVE') throw new RuntimeError('PRECONDITION_FAILED', `Production writer fence is ${current.state}`);
      const record = current.writers[writer];
      if (record === undefined || record.state === 'UNKNOWN') throw new RuntimeError('PRECONDITION_FAILED', `Writer ${writer} is not verified for mutation`);
      const writers = { ...current.writers, [writer]: { ...record, state: 'ACTIVE' as const, inFlight: record.inFlight + 1, ownerInstanceId: this.identity.instanceId } };
      await this.persist({ ...current, writers });
      let released = false;
      return {
        writer,
        release: async () => {
          if (released) return;
          released = true;
          await this.enqueue(async () => {
            const latest = await this.refresh();
            const active = latest.writers[writer];
            if (active === undefined || active.inFlight < 1) throw new RuntimeError('PERSISTENCE_FAILURE', `Writer ${writer} lease accounting is inconsistent`);
            const nextCount = active.inFlight - 1;
            await this.persist({ ...latest, writers: { ...latest.writers, [writer]: { ...active, state: nextCount === 0 ? 'IDLE' : 'ACTIVE', inFlight: nextCount } } });
          });
        },
      };
    });
  }

  public async quiesce(ownerAccessToken: string, observations: Readonly<Record<string, WriterObservation>> = {}): Promise<SafetySnapshot> {
    return this.enqueue(async () => {
      let current = await this.refresh();
      this.authorize(current, ownerAccessToken);
      if (current.state === 'QUIESCED') return current;
      if (current.state !== 'ACTIVE') throw new RuntimeError('PRECONDITION_FAILED', `Production safety state is ${current.state}`);
      current = applyObservations(current, observations);
      await this.persist({ ...current, state: 'QUIESCING', blockedReason: null });
      const reasons = quiescenceReasons(current, observations);
      const state: ProductionFenceState = reasons.length === 0 ? 'QUIESCED' : 'BLOCKED';
      const next = { ...current, state, blockedReason: reasons.length === 0 ? null : reasons.join('; ') };
      await this.persist(next);
      return next;
    });
  }

  public async recover(ownerAccessToken: string, observations: Readonly<Record<string, WriterObservation>>): Promise<SafetySnapshot> {
    return this.enqueue(async () => {
      let current = await this.refresh();
      this.authorize(current, ownerAccessToken);
      if (!['BLOCKED', 'RECOVERY_REQUIRED'].includes(current.state)) throw new RuntimeError('PRECONDITION_FAILED', `Production safety state is ${current.state}`);
      current = applyObservations(current, observations);
      const reasons = quiescenceReasons(current, observations);
      if (reasons.length > 0) throw new RuntimeError('PRECONDITION_FAILED', `Recovery is not verified: ${reasons.join('; ')}`);
      const next = { ...current, state: 'ACTIVE' as const, blockedReason: null };
      await this.persist(next);
      return next;
    });
  }

  public async unfence(ownerAccessToken: string): Promise<SafetySnapshot> {
    return this.enqueue(async () => {
      const current = await this.refresh();
      this.authorize(current, ownerAccessToken);
      if (current.state !== 'QUIESCED') throw new RuntimeError('PRECONDITION_FAILED', 'Only a verified QUIESCED fence can be released');
      const reasons = quiescenceReasons(current, {});
      if (reasons.length > 0) throw new RuntimeError('PRECONDITION_FAILED', `Cannot release fence: ${reasons.join('; ')}`);
      const next = { ...current, state: 'ACTIVE' as const };
      await this.persist(next);
      return next;
    });
  }

  public async readiness(): Promise<ReadinessReport> {
    const fence = await this.inspect();
    const reasons: string[] = [];
    if (fence.state !== 'QUIESCED') reasons.push(`fence state is ${fence.state}`);
    if (fence.backup === null) reasons.push('a verified backup is not recorded');
    if (fence.restore === null) reasons.push('a disposable restore drill is not recorded');
    if (fence.backup !== null && !fence.backup.detail.includes('checkpoint=VERIFIED')) reasons.push('backup does not include verified task checkpoint evidence');
    if (fence.restore !== null && !fence.restore.detail.includes('checkpoint=VERIFIED')) reasons.push('restore drill does not include verified task checkpoint evidence');
    return { status: reasons.length === 0 ? 'READY_FOR_OWNER_WINDOW' : 'BLOCKED', reasons, fence };
  }

  public async requireQuiesced(ownerAccessToken: string): Promise<SafetySnapshot> {
    return this.enqueue(async () => {
      const current = await this.refresh();
      this.authorize(current, ownerAccessToken);
      if (current.state !== 'QUIESCED') throw new RuntimeError('PRECONDITION_FAILED', 'A verified QUIESCED fence is required');
      if (quiescenceReasons(current, {}).length > 0) throw new RuntimeError('PRECONDITION_FAILED', 'Writer inventory is not idle and verified');
      return current;
    });
  }

  public async recordBackupEvidence(ownerAccessToken: string, detail: string): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.refresh();
      this.authorize(current, ownerAccessToken);
      if (current.state !== 'QUIESCED' || quiescenceReasons(current, {}).length > 0) throw new RuntimeError('PRECONDITION_FAILED', 'A verified QUIESCED fence is required');
      await this.persist({ ...current, backup: { id: randomUUID(), at: new Date().toISOString(), detail } });
    });
  }

  public async recordRestoreEvidence(ownerAccessToken: string, detail: string): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.refresh();
      this.authorize(current, ownerAccessToken);
      if (current.state !== 'QUIESCED' || quiescenceReasons(current, {}).length > 0) throw new RuntimeError('PRECONDITION_FAILED', 'A verified QUIESCED fence is required');
      await this.persist({ ...current, restore: { id: randomUUID(), at: new Date().toISOString(), detail } });
    });
  }

  private async refresh(): Promise<SafetyDocument> {
    try { this.document = parseDocument(await readFile(path.join(this.dataRoot, SAFETY_FILE), 'utf8')); }
    catch (error: unknown) { throw error instanceof RuntimeError ? error : new RuntimeError('PERSISTENCE_FAILURE', 'Production safety state is unreadable', { cause: error }); }
    return this.document;
  }

  private authorize(document: SafetyDocument, token: string): void {
    this.assertIdentity(document);
    const expected = Buffer.from(this.ownerAccessSecret);
    const provided = Buffer.from(token);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new RuntimeError('CONTROL_DENIED', 'Owner authorization is invalid');
  }

  private assertIdentity(document: SafetyDocument): void {
    if (document.identity.runtimeId !== this.identity.runtimeId || document.identity.instanceId !== this.identity.instanceId || document.identity.dataRoot !== this.identity.dataRoot) {
      throw new RuntimeError('AUTHORITY_CHANGED', 'Production safety identity changed');
    }
  }

  private async persist(document: SafetyDocument): Promise<void> {
    this.document = { ...document, generation: document.generation + 1, updatedAt: new Date().toISOString() };
    await withLock(this.dataRoot, async () => writeDocument(path.join(this.dataRoot, SAFETY_FILE), this.document));
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
  const fence = await input.controller.requireQuiesced(input.ownerAccessToken);
  const source = fence.identity.dataRoot;
  const destination = path.resolve(input.destination);
  await assertDestinationAvailable(source, destination);
  const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.staging`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const files = await copyTree(source, staging);
    if (input.checkpointFile !== undefined && isWithin(source, path.resolve(input.checkpointFile))) throw new RuntimeError('PRECONDITION_FAILED', 'Checkpoint source must be outside the runtime data root');
    const checkpoint = input.checkpointFile === undefined ? null : await copyCheckpoint(input.checkpointFile, staging);
    const manifest: BackupManifest = { schemaVersion: 1, backupId: randomUUID(), createdAt: new Date().toISOString(), sourceIdentity: fence.identity, fenceGeneration: fence.generation, files: files.sort((a, b) => a.path.localeCompare(b.path)), checkpoint };
    await writePrivateJson(path.join(staging, MANIFEST_FILE), manifest);
    await chmod(staging, 0o700);
    await rename(staging, destination);
    await verifyRuntimeBackup(destination);
    await input.controller.recordBackupEvidence(input.ownerAccessToken, `${manifest.backupId}:${manifest.files.length} files;checkpoint=${manifest.checkpoint === null ? 'UNVERIFIED' : 'VERIFIED'}`);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function verifyRuntimeBackup(destinationInput: string): Promise<BackupManifest> {
  const destination = path.resolve(destinationInput);
  const problem = await privateDirectoryProblem(destination, 'Backup directory');
  if (problem !== null) throw new RuntimeError('PERSISTENCE_FAILURE', problem);
  const manifestPath = path.join(destination, MANIFEST_FILE);
  const manifest = parseManifest(await readPrivateFile(manifestPath, 'Backup manifest'));
  const actual = (await listFiles(destination)).filter((file) => file !== MANIFEST_FILE);
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
  const fence = await input.controller.requireQuiesced(input.ownerAccessToken);
  const backupRoot = path.resolve(input.backupRoot);
  const destination = path.resolve(input.destination);
  const manifest = await verifyRuntimeBackup(backupRoot);
  if (manifest.sourceIdentity.dataRoot !== fence.identity.dataRoot || manifest.sourceIdentity.runtimeId !== fence.identity.runtimeId) throw new RuntimeError('AUTHORITY_CHANGED', 'Backup identity does not match the fenced runtime');
  await assertDestinationAvailable(backupRoot, destination);
  const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.staging`);
  await mkdir(staging, { mode: 0o700 });
  let checkpointStaging: string | undefined;
  try {
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
      await rename(staging, destination);
      await rename(checkpointStaging, checkpointTarget);
      await verifyRuntimeBackup(destination);
      await input.controller.recordRestoreEvidence(input.ownerAccessToken, `${manifest.backupId}:${destination};checkpoint=VERIFIED`);
      return manifest;
    }
    await writePrivateJson(path.join(staging, MANIFEST_FILE), manifest);
    await rename(staging, destination);
    await verifyRuntimeBackup(destination);
    await input.controller.recordRestoreEvidence(input.ownerAccessToken, `${manifest.backupId}:${destination};checkpoint=UNVERIFIED`);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (checkpointStaging !== undefined) await rm(checkpointStaging, { force: true }).catch(() => undefined);
    throw error;
  }
}

function emptyDocument(identity: SafetyIdentity): SafetyDocument {
  const writers: Record<string, WriterRecord> = {};
  for (const writer of REQUIRED_WRITERS) writers[writer] = { state: 'UNKNOWN', inFlight: 0, ownerInstanceId: null };
  return { schemaVersion: 1, generation: 0, state: 'ACTIVE', identity, writers, blockedReason: null, backup: null, restore: null, updatedAt: new Date().toISOString() };
}

function applyObservations(document: SafetyDocument, observations: Readonly<Record<string, WriterObservation>>): SafetyDocument {
  const writers = { ...document.writers };
  for (const [name, observation] of Object.entries(observations)) {
    if (!WRITER_STATES.includes(observation.state) || !Number.isSafeInteger(observation.inFlight ?? 0) || (observation.inFlight ?? 0) < 0) throw new RuntimeError('INVALID_REQUEST', `Writer observation for ${name} is invalid`);
    if (writers[name] !== undefined) writers[name] = { ...writers[name], state: observation.state, inFlight: observation.inFlight ?? writers[name]!.inFlight };
  }
  return { ...document, writers };
}

function quiescenceReasons(document: SafetyDocument, observations: Readonly<Record<string, WriterObservation>>): string[] {
  const reasons: string[] = [];
  for (const writer of REQUIRED_WRITERS) {
    const record = document.writers[writer];
    if (record === undefined || record.state === 'UNKNOWN') reasons.push(`writer ${writer} is unknown`);
    else if (record.inFlight > 0 || record.state === 'ACTIVE') reasons.push(`writer ${writer} is active`);
    const observed = observations[writer];
    if (observed?.state === 'ACTIVE' || (observed?.inFlight ?? 0) > 0) reasons.push(`observation reports ${writer} active`);
  }
  return [...new Set(reasons)];
}

async function copyTree(source: string, destination: string): Promise<BackupManifest['files'][number][]> {
  const files: BackupManifest['files'][number][] = [];
  for (const relative of await listFiles(source)) {
    if (relative === CHECKPOINT_FILE) throw new RuntimeError('PERSISTENCE_FAILURE', `${CHECKPOINT_FILE} is reserved for checkpoint evidence`);
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

async function assertDestinationAvailable(source: string, destination: string): Promise<void> {
  if (destination === source || isWithin(source, destination) || isWithin(destination, source)) throw new RuntimeError('PRECONDITION_FAILED', 'Backup or restore destination overlaps the runtime data root');
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
async function withLock<T>(dataRoot: string, operation: () => Promise<T>): Promise<T> {
  const filename = path.join(dataRoot, SAFETY_LOCK);
  let handle;
  try { handle = await open(filename, 'wx', 0o600); return await operation(); }
  catch (error) { throw error instanceof RuntimeError ? error : new RuntimeError('SUPERVISOR_BUSY', 'Production safety state is busy', { cause: error }); }
  finally { await handle?.close().catch(() => undefined); await rm(filename, { force: true }).catch(() => undefined); }
}
function parseDocument(content: string): SafetyDocument {
  try {
    const value = JSON.parse(content) as SafetyDocument;
    if (value.schemaVersion !== 1 || !FENCE_STATES.includes(value.state) || !value.identity || typeof value.identity.runtimeId !== 'string' || typeof value.identity.instanceId !== 'string' || !path.isAbsolute(value.identity.dataRoot) || !Number.isSafeInteger(value.generation) || typeof value.writers !== 'object') throw new Error('schema');
    return value;
  } catch (error) { throw new RuntimeError('PERSISTENCE_FAILURE', 'Production safety state is invalid', { cause: error }); }
}
function parseManifest(content: string): BackupManifest {
  try {
    const value = JSON.parse(content) as BackupManifest;
    if (value.schemaVersion !== 1 || typeof value.backupId !== 'string' || !Array.isArray(value.files) || (value.checkpoint !== null && (value.checkpoint === undefined || !Number.isSafeInteger(value.checkpoint.size) || typeof value.checkpoint.sha256 !== 'string' || !Number.isSafeInteger(value.checkpoint.mode))) || value.files.some((file) => typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || typeof file.sha256 !== 'string' || !Number.isSafeInteger(file.mode))) throw new Error('schema');
    return value;
  } catch (error) { throw new RuntimeError('PERSISTENCE_FAILURE', 'Backup manifest is invalid', { cause: error }); }
}
function isWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); }
function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'; }
async function hashFile(filename: string): Promise<string> { return createHash('sha256').update(await readFile(filename)).digest('hex'); }
