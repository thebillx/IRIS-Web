import { createHash } from 'node:crypto';
import type { ArtifactSensitivity } from '@iris/domain';

export type TransferState = 'PENDING' | 'TRANSFERRING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export interface TransferIdentity {
  transferId: string;
  sourceArtifactId: string;
  sourceRuntimeId: string;
  destinationRuntimeId: string;
  destinationProjectId: string;
  destinationWorkspaceId: string;
  destinationArtifactId: string;
  size: number;
  sha256: string;
  sensitivity: ArtifactSensitivity;
  provenance: { source: readonly string[]; acquisition?: readonly string[] };
  expiresAt: number;
}
export interface TransferRecord extends TransferIdentity {
  offset: number;
  prefixSha256: string;
  transferState: TransferState;
}
export const artifactDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const levels = ['PUBLIC', 'INTERNAL', 'SENSITIVE', 'RESTRICTED'];
const id = (value: string): boolean => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
function validProvenance(value: TransferIdentity['provenance']): boolean {
  const chain = (items: unknown): boolean => Array.isArray(items) && items.length <= 64 && items.every((item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 2048);
  return value !== null && typeof value === 'object' && Object.keys(value).every((key) => ['source', 'acquisition'].includes(key)) && chain(value.source) && (value.acquisition === undefined || chain(value.acquisition));
}
const destinationKey = (r: TransferIdentity): string => JSON.stringify([r.destinationRuntimeId, r.destinationProjectId, r.destinationWorkspaceId, r.destinationArtifactId]);
function demand(ok: boolean, code: string): asserts ok { if (!ok) throw new Error(code); }

/** Test-only trusted control plane. Tokens are object capabilities, never serialized credentials. */
export class FakeArtifactAuthority {
  private sources = new WeakMap<object, { runtimeId: string; artifactId: string; bytes: Uint8Array; sensitivity: ArtifactSensitivity; provenance: TransferIdentity['provenance'] }>();
  private destinations = new WeakMap<object, { key: string; transferId: string; expiresAt: number }>();

  ownSource(runtimeId: string, artifactId: string, bytes: Uint8Array, sensitivity: ArtifactSensitivity, provenance: TransferIdentity['provenance']): object {
    demand(id(runtimeId) && id(artifactId) && levels.includes(sensitivity) && validProvenance(provenance), 'INVALID_SOURCE');
    const token = Object.freeze({});
    this.sources.set(token, { runtimeId, artifactId, bytes: bytes.slice(), sensitivity, provenance: structuredClone(provenance) });
    return token;
  }
  allowDestination(identity: TransferIdentity): object {
    const token = Object.freeze({});
    this.destinations.set(token, { key: destinationKey(identity), transferId: identity.transferId, expiresAt: identity.expiresAt });
    return token;
  }
  revoke(token: object): void { this.sources.delete(token); this.destinations.delete(token); }
  mutateSource(token: object, bytes: Uint8Array): void {
    const source = this.sources.get(token);
    demand(source !== undefined, 'SOURCE_AUTHORITY_DENIED');
    source.bytes = bytes.slice();
  }
  prove(r: TransferIdentity, sourceToken: object, destinationToken: object, now: number): Uint8Array {
    const source = this.sources.get(sourceToken);
    const destination = this.destinations.get(destinationToken);
    demand(source !== undefined && source.runtimeId === r.sourceRuntimeId && source.artifactId === r.sourceArtifactId, 'SOURCE_AUTHORITY_DENIED');
    demand(destination !== undefined && destination.key === destinationKey(r) && destination.transferId === r.transferId, 'DESTINATION_AUTHORITY_DENIED');
    demand(now < r.expiresAt && now < destination.expiresAt, 'TRANSFER_EXPIRED');
    demand(levels.includes(r.sensitivity) && levels.indexOf(r.sensitivity) >= levels.indexOf(source.sensitivity), 'SENSITIVITY_DOWNGRADE');
    demand(JSON.stringify(source.provenance.source) === JSON.stringify(r.provenance.source) && JSON.stringify(source.provenance.acquisition) === JSON.stringify(r.provenance.acquisition), 'PROVENANCE_MISMATCH');
    demand(source.bytes.length === r.size && artifactDigest(source.bytes) === r.sha256, 'SOURCE_CHANGED');
    return source.bytes.slice();
  }
}

/** Isolated synchronous fake transport. No disk, network, registry, or MCP effects. */
export class ArtifactTransferBridge {
  private transfers = new Map<string, { record: TransferRecord; bytes: Uint8Array }>();
  private reservations = new Map<string, string>();
  private artifacts = new Map<string, { record: TransferRecord; bytes: Uint8Array }>();
  constructor(private authority: FakeArtifactAuthority, private maxSize = 16 * 1024 * 1024, private now: () => number = Date.now) {
    demand(Number.isSafeInteger(maxSize) && maxSize >= 0, 'INVALID_LIMIT');
  }
  transfer(identity: TransferIdentity, source: object, destination: object): TransferRecord {
    const r = structuredClone(identity);
    demand([r.transferId, r.sourceArtifactId, r.sourceRuntimeId, r.destinationRuntimeId, r.destinationProjectId, r.destinationWorkspaceId, r.destinationArtifactId].every(id), 'INVALID_IDENTITY');
    demand(validProvenance(r.provenance), 'INVALID_PROVENANCE');
    demand(Object.keys(r).length === 12 && Object.keys(r).every((key) => ['transferId', 'sourceArtifactId', 'sourceRuntimeId', 'destinationRuntimeId', 'destinationProjectId', 'destinationWorkspaceId', 'destinationArtifactId', 'size', 'sha256', 'sensitivity', 'provenance', 'expiresAt'].includes(key)), 'INVALID_METADATA');
    demand(Number.isSafeInteger(r.size) && r.size >= 0 && r.size <= this.maxSize, 'INVALID_SIZE');
    demand(/^[0-9a-f]{64}$/.test(r.sha256) && Number.isSafeInteger(r.expiresAt), 'INVALID_METADATA');
    this.authority.prove(r, source, destination, this.now());
    const previous = this.transfers.get(r.transferId);
    if (previous) {
      demand(Object.keys(r).every((key) => JSON.stringify(previous.record[key as keyof TransferIdentity]) === JSON.stringify(r[key as keyof TransferIdentity])), 'TRANSFER_ID_CONFLICT');
      return structuredClone(previous.record);
    }
    demand(!this.reservations.has(destinationKey(r)), 'DESTINATION_COLLISION');
    const record: TransferRecord = { ...r, offset: 0, prefixSha256: artifactDigest(new Uint8Array()), transferState: 'PENDING' };
    this.reservations.set(destinationKey(r), r.transferId);
    this.transfers.set(r.transferId, { record, bytes: new Uint8Array() });
    return structuredClone(record);
  }
  private active(transferId: string, source: object, destination: object) {
    const entry = this.transfers.get(transferId);
    demand(entry !== undefined, 'TRANSFER_NOT_FOUND');
    this.authority.prove(entry.record, source, destination, this.now());
    demand(!['FAILED', 'CANCELLED'].includes(entry.record.transferState), 'TRANSFER_TERMINAL');
    return entry;
  }
  resume(transferId: string, offset: number, prefixSha256: string, source: object, destination: object): TransferRecord {
    const entry = this.active(transferId, source, destination);
    demand(offset === entry.record.offset && prefixSha256 === entry.record.prefixSha256 && prefixSha256 === artifactDigest(entry.bytes), 'RESUME_MISMATCH');
    return structuredClone(entry.record);
  }
  push(transferId: string, offset: number, chunk: Uint8Array, source: object, destination: object): TransferRecord {
    const entry = this.active(transferId, source, destination);
    demand(Number.isSafeInteger(offset) && offset >= 0 && chunk.length > 0 && offset + chunk.length <= entry.record.size, 'INVALID_CHUNK');
    if (offset < entry.record.offset) {
      demand(offset + chunk.length <= entry.record.offset && artifactDigest(entry.bytes.slice(offset, offset + chunk.length)) === artifactDigest(chunk), 'DUPLICATE_CONFLICT');
      return structuredClone(entry.record);
    }
    demand(entry.record.transferState !== 'COMPLETED' && offset === entry.record.offset, 'OFFSET_MISMATCH');
    const expected = this.authority.prove(entry.record, source, destination, this.now()).slice(offset, offset + chunk.length);
    if (artifactDigest(expected) !== artifactDigest(chunk)) {
      entry.record.transferState = 'FAILED';
      throw new Error('CHECKSUM_MISMATCH');
    }
    const appended = new Uint8Array(entry.bytes.length + chunk.length);
    appended.set(entry.bytes);
    appended.set(chunk, entry.bytes.length);
    entry.bytes = appended;
    entry.record.offset = entry.bytes.length;
    entry.record.prefixSha256 = artifactDigest(entry.bytes);
    entry.record.transferState = 'TRANSFERRING';
    return structuredClone(entry.record);
  }
  pull(transferId: string, offset: number, length: number, source: object, destination: object): TransferRecord {
    const entry = this.active(transferId, source, destination);
    demand(Number.isSafeInteger(length) && length > 0 && Number.isSafeInteger(offset) && offset >= 0 && offset + length <= entry.record.size, 'INVALID_CHUNK');
    const bytes = this.authority.prove(entry.record, source, destination, this.now());
    return this.push(transferId, offset, bytes.slice(offset, offset + length), source, destination);
  }
  verify(transferId: string, source: object, destination: object): TransferRecord {
    const entry = this.active(transferId, source, destination);
    if (entry.record.transferState === 'COMPLETED') return structuredClone(entry.record);
    demand(entry.record.offset === entry.record.size, 'TRANSFER_INCOMPLETE');
    entry.record.transferState = 'VERIFYING';
    if (artifactDigest(entry.bytes) !== entry.record.sha256) {
      entry.record.transferState = 'FAILED';
      throw new Error('CHECKSUM_MISMATCH');
    }
    entry.record.transferState = 'COMPLETED';
    this.artifacts.set(destinationKey(entry.record), structuredClone(entry));
    return structuredClone(entry.record);
  }
  cancel(transferId: string, source: object, destination: object): void {
    const entry = this.active(transferId, source, destination);
    demand(entry.record.transferState !== 'COMPLETED', 'TRANSFER_TERMINAL');
    entry.bytes = new Uint8Array();
    entry.record.offset = 0;
    entry.record.prefixSha256 = artifactDigest(entry.bytes);
    entry.record.transferState = 'CANCELLED';
  }
  readCompleted(transferId: string, source: object, destination: object): { record: TransferRecord; bytes: Uint8Array } {
    const entry = this.active(transferId, source, destination);
    const artifact = this.artifacts.get(destinationKey(entry.record));
    demand(artifact !== undefined, 'PACKAGE_NOT_LOCALLY_AVAILABLE');
    return structuredClone(artifact);
  }
}
