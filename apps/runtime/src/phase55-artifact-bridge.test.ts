import { describe, expect, it } from 'vitest';
import { ArtifactTransferBridge, FakeArtifactAuthority, artifactDigest, type TransferIdentity } from './phase55-artifact-bridge.js';

function fixture(bytes = new TextEncoder().encode('acquisition evidence')) {
  let now = 100;
  const authority = new FakeArtifactAuthority();
  const bridge = new ArtifactTransferBridge(authority, 64, () => now);
  const identity: TransferIdentity = {
    transferId: 'transfer-1', sourceArtifactId: 'source-1', sourceRuntimeId: 'connector-plane',
    destinationRuntimeId: 'iris-local', destinationProjectId: 'project-A', destinationWorkspaceId: 'workspace-A',
    destinationArtifactId: 'artifact-new', size: bytes.length, sha256: artifactDigest(bytes), sensitivity: 'SENSITIVE',
    provenance: { source: ['connector:figma', 'file:synthetic'], acquisition: ['acquisition:original'] }, expiresAt: 200,
  };
  const source = authority.ownSource(identity.sourceRuntimeId, identity.sourceArtifactId, bytes, 'SENSITIVE', identity.provenance);
  const destination = authority.allowDestination(identity);
  const start = () => bridge.transfer(identity, source, destination);
  return { bytes, authority, bridge, identity, source, destination, start, expire: () => { now = 200; } };
}

describe('isolated cross-runtime artifact contract', () => {
  it('resumes a verified prefix after interruption, publishes only after verification, and retains provenance', () => {
    const f = fixture();
    expect(f.start().transferState).toBe('PENDING');
    expect(() => f.bridge.readCompleted(f.identity.transferId, f.source, f.destination)).toThrow('PACKAGE_NOT_LOCALLY_AVAILABLE');
    const partial = f.bridge.pull(f.identity.transferId, 0, 5, f.source, f.destination);
    expect(partial.offset).toBe(5);
    expect(f.bridge.resume(f.identity.transferId, 5, artifactDigest(f.bytes.slice(0, 5)), f.source, f.destination)).toEqual(partial);
    expect(() => f.bridge.verify(f.identity.transferId, f.source, f.destination)).toThrow('TRANSFER_INCOMPLETE');
    f.bridge.push(f.identity.transferId, 5, f.bytes.slice(5), f.source, f.destination);
    expect(f.bridge.verify(f.identity.transferId, f.source, f.destination).transferState).toBe('COMPLETED');
    const completed = f.bridge.readCompleted(f.identity.transferId, f.source, f.destination);
    expect(completed.bytes).toEqual(f.bytes);
    expect(completed.record).toMatchObject(f.identity);
    completed.bytes.fill(0);
    completed.record.provenance.source = [];
    expect(f.bridge.readCompleted(f.identity.transferId, f.source, f.destination).bytes).toEqual(f.bytes);
    expect(f.bridge.readCompleted(f.identity.transferId, f.source, f.destination).record.provenance).toEqual(f.identity.provenance);
  });
  it('makes transfer, chunk delivery and completion retries idempotent', () => {
    const f = fixture();
    expect(f.start()).toEqual(f.start());
    const sent = f.bridge.push(f.identity.transferId, 0, f.bytes, f.source, f.destination);
    expect(f.bridge.push(f.identity.transferId, 0, f.bytes, f.source, f.destination)).toEqual(sent);
    const done = f.bridge.verify(f.identity.transferId, f.source, f.destination);
    expect(f.bridge.verify(f.identity.transferId, f.source, f.destination)).toEqual(done);
    expect(f.bridge.push(f.identity.transferId, 0, f.bytes, f.source, f.destination)).toEqual(done);
    const reordered = Object.fromEntries(Object.entries(f.identity).reverse()) as unknown as TransferIdentity;
    expect(f.bridge.transfer(reordered, f.source, f.destination)).toEqual(done);
  });
  it.each(['sourceRuntimeId', 'sourceArtifactId', 'destinationRuntimeId', 'destinationProjectId', 'destinationWorkspaceId', 'destinationArtifactId', 'transferId'] as const)('denies grant reuse for another %s', (field) => {
    const f = fixture();
    expect(() => f.bridge.transfer({ ...f.identity, [field]: 'unrelated' }, f.source, f.destination)).toThrow('AUTHORITY_DENIED');
  });
  it('denies forged, raw-path and revoked authority', () => {
    const f = fixture();
    expect(() => f.bridge.transfer(f.identity, {}, f.destination)).toThrow('SOURCE_AUTHORITY_DENIED');
    expect(() => f.bridge.transfer(f.identity, f.source, { path: '/tmp' })).toThrow('DESTINATION_AUTHORITY_DENIED');
    f.start();
    f.authority.revoke(f.destination);
    expect(() => f.bridge.pull(f.identity.transferId, 0, 1, f.source, f.destination)).toThrow('DESTINATION_AUTHORITY_DENIED');
  });
  it('rejects destination collision and transfer identity reuse', () => {
    const f = fixture(); f.start();
    const other = { ...f.identity, transferId: 'transfer-2' };
    expect(() => f.bridge.transfer(other, f.source, f.authority.allowDestination(other))).toThrow('DESTINATION_COLLISION');
    const changed = { ...f.identity, destinationArtifactId: 'new-artifact' };
    expect(() => f.bridge.transfer(changed, f.source, f.authority.allowDestination(changed))).toThrow('TRANSFER_ID_CONFLICT');
  });
  it('rejects offset gaps, wrong resume prefixes and conflicting duplicates without appending', () => {
    const f = fixture(); f.start();
    expect(() => f.bridge.push(f.identity.transferId, 1, f.bytes.slice(0, 1), f.source, f.destination)).toThrow('OFFSET_MISMATCH');
    f.bridge.pull(f.identity.transferId, 0, 5, f.source, f.destination);
    expect(() => f.bridge.resume(f.identity.transferId, 4, artifactDigest(f.bytes.slice(0, 4)), f.source, f.destination)).toThrow('RESUME_MISMATCH');
    expect(() => f.bridge.resume(f.identity.transferId, 5, artifactDigest(f.bytes), f.source, f.destination)).toThrow('RESUME_MISMATCH');
    expect(() => f.bridge.push(f.identity.transferId, 0, new Uint8Array(5), f.source, f.destination)).toThrow('DUPLICATE_CONFLICT');
    expect(f.start().offset).toBe(5);
  });
  it('fails corrupt delivery and prevents publication or restart under the same identity', () => {
    const f = fixture(); f.start();
    expect(() => f.bridge.push(f.identity.transferId, 0, new Uint8Array(f.bytes.length), f.source, f.destination)).toThrow('CHECKSUM_MISMATCH');
    expect(f.start().transferState).toBe('FAILED');
    expect(() => f.bridge.verify(f.identity.transferId, f.source, f.destination)).toThrow('TRANSFER_TERMINAL');
  });
  it('detects same-size source mutation before resume or completion', () => {
    const f = fixture(); f.start();
    f.bridge.pull(f.identity.transferId, 0, f.bytes.length, f.source, f.destination);
    f.authority.mutateSource(f.source, new Uint8Array(f.bytes.length));
    expect(() => f.bridge.verify(f.identity.transferId, f.source, f.destination)).toThrow('SOURCE_CHANGED');
    expect(() => f.bridge.resume(f.identity.transferId, f.bytes.length, f.identity.sha256, f.source, f.destination)).toThrow('SOURCE_CHANGED');
  });
  it('denies downgrade and altered provenance, permits stricter sensitivity', () => {
    const f = fixture();
    expect(() => f.bridge.transfer({ ...f.identity, sensitivity: 'PUBLIC' }, f.source, f.destination)).toThrow('SENSITIVITY_DOWNGRADE');
    expect(() => f.bridge.transfer({ ...f.identity, provenance: { source: [] } }, f.source, f.destination)).toThrow('PROVENANCE_MISMATCH');
    expect(f.bridge.transfer({ ...f.identity, sensitivity: 'RESTRICTED' }, f.source, f.destination).sensitivity).toBe('RESTRICTED');
  });
  it('enforces size, digest, identity, expiry and cancellation boundaries', () => {
    const f = fixture();
    expect(() => f.bridge.transfer({ ...f.identity, size: 65 }, f.source, f.destination)).toThrow('INVALID_SIZE');
    expect(() => f.bridge.transfer({ ...f.identity, size: -1 }, f.source, f.destination)).toThrow('INVALID_SIZE');
    expect(() => f.bridge.transfer({ ...f.identity, sha256: 'bad' }, f.source, f.destination)).toThrow('INVALID_METADATA');
    expect(() => f.bridge.transfer({ ...f.identity, sha256: '0'.repeat(64) }, f.source, f.destination)).toThrow('SOURCE_CHANGED');
    expect(() => f.bridge.transfer({ ...f.identity, destinationArtifactId: '../sibling' }, f.source, f.destination)).toThrow('INVALID_IDENTITY');
    f.start(); f.bridge.cancel(f.identity.transferId, f.source, f.destination);
    expect(f.start().transferState).toBe('CANCELLED');
    expect(() => f.bridge.pull(f.identity.transferId, 0, 1, f.source, f.destination)).toThrow('TRANSFER_TERMINAL');
    const expired = fixture(); expired.start(); expired.expire();
    expect(() => expired.bridge.verify(expired.identity.transferId, expired.source, expired.destination)).toThrow('TRANSFER_EXPIRED');
  });
  it('rehashes staging before completion even after all chunks were accepted', () => {
    const f = fixture(); f.start();
    f.bridge.pull(f.identity.transferId, 0, f.bytes.length, f.source, f.destination);
    // Inject storage corruption at the fake storage boundary, bypassing transport.
    const storage = f.bridge as unknown as { transfers: Map<string, { bytes: Uint8Array }> };
    storage.transfers.get(f.identity.transferId)!.bytes.fill(0);
    expect(() => f.bridge.verify(f.identity.transferId, f.source, f.destination)).toThrow('CHECKSUM_MISMATCH');
    expect(f.start().transferState).toBe('FAILED');
    expect(() => f.bridge.readCompleted(f.identity.transferId, f.source, f.destination)).toThrow('TRANSFER_TERMINAL');
  });
  it('bounds provenance and rejects undeclared metadata', () => {
    const f = fixture();
    expect(() => f.bridge.transfer({ ...f.identity, provenance: { source: ['x'.repeat(2049)] } }, f.source, f.destination)).toThrow('INVALID_PROVENANCE');
    expect(() => f.bridge.transfer({ ...f.identity, path: '/tmp/file' } as TransferIdentity, f.source, f.destination)).toThrow('INVALID_METADATA');
  });
  it('verifies an empty artifact without accepting an empty delivery', () => {
    const f = fixture(new Uint8Array()); f.start();
    expect(() => f.bridge.push(f.identity.transferId, 0, f.bytes, f.source, f.destination)).toThrow('INVALID_CHUNK');
    expect(f.bridge.verify(f.identity.transferId, f.source, f.destination).transferState).toBe('COMPLETED');
  });
});
