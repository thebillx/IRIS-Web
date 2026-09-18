import { describe, expect, it } from 'vitest';
import { fakeAcquire, fixtureGrant } from './figma-read/fixtures.js';
import { ContractError } from './figma-read/contract.js';
import {
  ArtifactTransferBridge,
  FakeArtifactAuthority,
  artifactDigest,
  type TransferIdentity,
  type TransferRecord,
} from './phase55-artifact-bridge.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type CompletedArtifact = Readonly<{ record: TransferRecord; bytes: Uint8Array }>;

function provenance(requestId: string, version: string) {
  return {
    source: [
      `connector:${fixtureGrant.connectorId}`,
      'provider:figma',
      'file:AllowedFile',
      'node:1:2',
    ],
    acquisition: [`request:${requestId}`, `version:${version}`],
  };
}

function identity(
  transferId: string,
  sourceArtifactId: string,
  destinationArtifactId: string,
  bytes: Uint8Array,
  sourceProvenance: ReturnType<typeof provenance>,
): TransferIdentity {
  return {
    transferId,
    sourceArtifactId,
    sourceRuntimeId: 'figma-connector-plane',
    destinationRuntimeId: 'iris-local',
    destinationProjectId: 'bbl-wiki',
    destinationWorkspaceId: 'wiki-workspace',
    destinationArtifactId,
    size: bytes.length,
    sha256: artifactDigest(bytes),
    sensitivity: 'SENSITIVE',
    provenance: sourceProvenance,
    expiresAt: 1_000,
  };
}

function transferCompleted(
  bridge: ArtifactTransferBridge,
  authority: FakeArtifactAuthority,
  transferIdentity: TransferIdentity,
  bytes: Uint8Array,
): CompletedArtifact {
  const source = authority.ownSource(
    transferIdentity.sourceRuntimeId,
    transferIdentity.sourceArtifactId,
    bytes,
    'SENSITIVE',
    transferIdentity.provenance,
  );
  const destination = authority.allowDestination(transferIdentity);
  bridge.transfer(transferIdentity, source, destination);
  if (bytes.length > 0) bridge.push(transferIdentity.transferId, 0, bytes, source, destination);
  bridge.verify(transferIdentity.transferId, source, destination);
  return bridge.readCompleted(transferIdentity.transferId, source, destination);
}

function publishSyntheticWiki(metadataArtifact: CompletedArtifact, screenshotArtifact: CompletedArtifact) {
  for (const artifact of [metadataArtifact, screenshotArtifact]) {
    if (artifact.record.transferState !== 'COMPLETED') throw new Error('EVIDENCE_NOT_COMPLETE');
    if (artifact.record.destinationProjectId !== 'bbl-wiki') throw new Error('WIKI_DESTINATION_MISMATCH');
  }
  if (JSON.stringify(metadataArtifact.record.provenance) !== JSON.stringify(screenshotArtifact.record.provenance)) {
    throw new Error('WIKI_PROVENANCE_MISMATCH');
  }
  const parsed = JSON.parse(decoder.decode(metadataArtifact.bytes)) as {
    provider: string;
    fileKey: string;
    nodeIds: string[];
    version: string;
    observed: { title: string; cta: string; validation: string; error: string };
  };
  if (parsed.provider !== 'figma' || parsed.fileKey !== 'AllowedFile' || parsed.nodeIds.length === 0) {
    throw new Error('WIKI_SOURCE_INVALID');
  }
  return Object.freeze({
    topicId: `figma:${parsed.fileKey}:${parsed.nodeIds[0]}`,
    title: parsed.observed.title,
    sections: Object.freeze([
      Object.freeze({ id: 'ux', text: `CTA: ${parsed.observed.cta}` }),
      Object.freeze({ id: 'validation', text: parsed.observed.validation }),
      Object.freeze({ id: 'error-handling', text: parsed.observed.error }),
    ]),
    sourceVersion: parsed.version,
    evidenceArtifactIds: Object.freeze([
      metadataArtifact.record.destinationArtifactId,
      screenshotArtifact.record.destinationArtifactId,
    ]),
    provenance: structuredClone(metadataArtifact.record.provenance),
  });
}

describe('Phase 5.5 synthetic Figma to Wiki E2E', () => {
  it('moves bounded Figma metadata and screenshot evidence into a provenance-retaining Wiki result', () => {
    const acquisition = fakeAcquire();
    expect(acquisition.status).toBe('complete');
    const sourceProvenance = provenance(acquisition.request.requestId, acquisition.version);
    const metadataBytes = encoder.encode(JSON.stringify({
      provider: 'figma',
      fileKey: acquisition.request.fileKey,
      nodeIds: acquisition.request.nodeIds,
      version: acquisition.version,
      observed: {
        title: 'Payment confirmation',
        cta: 'Confirm',
        validation: 'Amount is required before confirmation.',
        error: 'Card declined is shown as an inline error.',
      },
    }));
    const screenshotBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

    const authority = new FakeArtifactAuthority();
    const bridge = new ArtifactTransferBridge(authority, 8 * 1024, () => 100);
    const metadata = transferCompleted(
      bridge,
      authority,
      identity('figma-meta-transfer', 'metadata-artifact', 'wiki-figma-metadata', metadataBytes, sourceProvenance),
      metadataBytes,
    );
    const screenshot = transferCompleted(
      bridge,
      authority,
      identity('figma-shot-transfer', 'screenshot-artifact', 'wiki-figma-screenshot', screenshotBytes, sourceProvenance),
      screenshotBytes,
    );

    const wiki = publishSyntheticWiki(metadata, screenshot);
    expect(wiki).toMatchObject({
      topicId: 'figma:AllowedFile:1:2',
      title: 'Payment confirmation',
      sourceVersion: 'v1',
      evidenceArtifactIds: ['wiki-figma-metadata', 'wiki-figma-screenshot'],
      provenance: sourceProvenance,
    });
    expect(wiki.sections.map(section => section.id)).toEqual(['ux', 'validation', 'error-handling']);
    const serialized = JSON.stringify(wiki);
    expect(serialized).not.toContain(fixtureGrant.credentialRef);
    expect(serialized).not.toContain(fixtureGrant.sessionRef);
    expect(serialized).not.toContain('Bearer');
  });

  it('rejects a changed Figma source version before any transfer or Wiki publication', () => {
    expect(() => fakeAcquire({ priorVersion: 'v0' })).toThrowError(ContractError);
    expect(() => fakeAcquire({ priorVersion: 'v0' })).toThrow('SOURCE_CHANGED');
  });

  it('rejects foreign Wiki destination substitution even with valid source bytes and digest', () => {
    const acquisition = fakeAcquire();
    const bytes = encoder.encode('bounded metadata');
    const sourceProvenance = provenance(acquisition.request.requestId, acquisition.version);
    const original = identity('foreign-destination-transfer', 'metadata-artifact', 'wiki-artifact', bytes, sourceProvenance);
    const authority = new FakeArtifactAuthority();
    const bridge = new ArtifactTransferBridge(authority, 1024, () => 100);
    const source = authority.ownSource(original.sourceRuntimeId, original.sourceArtifactId, bytes, 'SENSITIVE', original.provenance);
    const destination = authority.allowDestination(original);

    expect(() => bridge.transfer(
      { ...original, destinationProjectId: 'foreign-wiki' },
      source,
      destination,
    )).toThrow('DESTINATION_AUTHORITY_DENIED');
  });

  it('rejects tampered screenshot bytes before they can become Wiki evidence', () => {
    const acquisition = fakeAcquire();
    const expected = new Uint8Array([1, 2, 3, 4]);
    const sourceProvenance = provenance(acquisition.request.requestId, acquisition.version);
    const transferIdentity = identity('tampered-shot-transfer', 'screenshot-artifact', 'wiki-shot', expected, sourceProvenance);
    const authority = new FakeArtifactAuthority();
    const bridge = new ArtifactTransferBridge(authority, 1024, () => 100);
    const source = authority.ownSource(
      transferIdentity.sourceRuntimeId,
      transferIdentity.sourceArtifactId,
      expected,
      'SENSITIVE',
      transferIdentity.provenance,
    );
    const destination = authority.allowDestination(transferIdentity);
    bridge.transfer(transferIdentity, source, destination);
    expect(() => bridge.push(
      transferIdentity.transferId,
      0,
      new Uint8Array([1, 2, 3, 9]),
      source,
      destination,
    )).toThrow('CHECKSUM_MISMATCH');
    expect(() => bridge.readCompleted(transferIdentity.transferId, source, destination)).toThrow('TRANSFER_TERMINAL');
  });
});
