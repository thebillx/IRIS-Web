import { describe, expect, it } from 'vitest';
import { bindRead, readOperations } from './figma-read/contract.js';
import { fixtureGrant, fixtureRequest } from './figma-read/fixtures.js';
import {
  ArtifactTransferBridge,
  FakeArtifactAuthority,
  artifactDigest,
  type TransferIdentity,
} from './phase55-artifact-bridge.js';

function bridgeFixture() {
  const bytes = new TextEncoder().encode('figma acquisition evidence');
  const authority = new FakeArtifactAuthority();
  const bridge = new ArtifactTransferBridge(authority, 1024, () => 100);
  const provenance = {
    source: ['connector:figma', 'file:AllowedFile', 'node:1:2'],
    acquisition: ['acquisition:request-test'],
  } as const;
  const identity: TransferIdentity = {
    transferId: 'phase55-security-transfer',
    sourceArtifactId: 'figma-acquisition-artifact',
    sourceRuntimeId: 'figma-connector-plane',
    destinationRuntimeId: 'iris-local',
    destinationProjectId: 'bbl-wiki',
    destinationWorkspaceId: 'workspace-test',
    destinationArtifactId: 'wiki-evidence-artifact',
    size: bytes.length,
    sha256: artifactDigest(bytes),
    sensitivity: 'SENSITIVE',
    provenance,
    expiresAt: 200,
  };
  const source = authority.ownSource(
    identity.sourceRuntimeId,
    identity.sourceArtifactId,
    bytes,
    'SENSITIVE',
    identity.provenance,
  );
  const destination = authority.allowDestination(identity);
  return { bytes, authority, bridge, identity, source, destination };
}

describe('Phase 5.5 contract security acceptance', () => {
  it('keeps the Figma connector surface strictly read-only', () => {
    expect(readOperations).toEqual([
      'connector.status',
      'connector.capabilities',
      'figma.get_file_metadata',
      'figma.get_page_or_node',
      'figma.get_design_context',
      'figma.get_screenshot',
    ]);
    for (const operation of readOperations) {
      expect(operation).not.toMatch(/(?:create|write|edit|update|delete|comment|publish|move|rename)/i);
    }
  });

  it('binds an immutable Figma request without materialized auth references', () => {
    const bound = bindRead(fixtureGrant, fixtureRequest, Date.parse('2026-09-15'));
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.nodeIds)).toBe(true);
    const serialized = JSON.stringify(bound);
    expect(serialized).not.toContain(fixtureGrant.credentialRef);
    expect(serialized).not.toContain(fixtureGrant.sessionRef);
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer');
  });

  it('retains Figma source/acquisition provenance across artifact transfer without secret refs', () => {
    const f = bridgeFixture();
    f.bridge.transfer(f.identity, f.source, f.destination);
    f.bridge.push(f.identity.transferId, 0, f.bytes, f.source, f.destination);
    f.bridge.verify(f.identity.transferId, f.source, f.destination);
    const completed = f.bridge.readCompleted(f.identity.transferId, f.source, f.destination);
    expect(completed.record.provenance).toEqual(f.identity.provenance);
    const serialized = JSON.stringify(completed.record);
    expect(serialized).not.toContain(fixtureGrant.credentialRef);
    expect(serialized).not.toContain(fixtureGrant.sessionRef);
  });

  it('rejects caller path metadata and sensitivity downgrade at the bridge boundary', () => {
    const pathFixture = bridgeFixture();
    expect(() => pathFixture.bridge.transfer(
      { ...pathFixture.identity, path: '/tmp/forbidden' } as TransferIdentity,
      pathFixture.source,
      pathFixture.destination,
    )).toThrow('INVALID_METADATA');

    const downgradeFixture = bridgeFixture();
    expect(() => downgradeFixture.bridge.transfer(
      { ...downgradeFixture.identity, sensitivity: 'PUBLIC' },
      downgradeFixture.source,
      downgradeFixture.destination,
    )).toThrow('SENSITIVITY_DOWNGRADE');
  });

  it('rejects destination project substitution even when all source bytes and hashes match', () => {
    const f = bridgeFixture();
    expect(() => f.bridge.transfer(
      { ...f.identity, destinationProjectId: 'foreign-project' },
      f.source,
      f.destination,
    )).toThrow('DESTINATION_AUTHORITY_DENIED');
  });
});
