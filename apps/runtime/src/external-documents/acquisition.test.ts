import { describe, expect, it } from 'vitest';
import type { ArtifactReference, WorkspaceId } from '@iris/domain';
import { acquireExternalDocument } from './acquisition.js';
import type {
  ExternalDocumentAdapter, ExternalDocumentGrant, ExternalDocumentReference, ExternalDocumentRequest,
} from './contract.js';

const workspaceId = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
const reference: ExternalDocumentReference = {
  referenceId: 'sp-link-1', projectId: 'bbl-wiki', sourceWorkItemId: '94747',
  sourceLinkIdentity: 'ado-link:94747:sharepoint', provider: 'sharepoint', sourceId: 'doc-123',
  title: 'Product specification', authority: 'REFERENCE_ONLY',
};
const grant: ExternalDocumentGrant = {
  projectId: 'bbl-wiki', connectorId: 'sharepoint-read', connectorBindingId: 'sp-binding-1',
  provider: 'sharepoint', credentialRef: 'opaque-secret-ref', sessionRef: 'opaque-session-ref',
  sourceMode: 'REMOTE', allowedSourceIds: ['doc-123'], allowedOperations: ['content'],
  network: 'allowed', expiresAt: '2030-01-01T00:00:00.000Z', revoked: false, outputWorkspaceId: workspaceId,
  limits: { maxContentBytes: 32, maxArtifacts: 2, timeoutMs: 100 },
};
const request: ExternalDocumentRequest = {
  requestId: 'request-1', projectId: 'bbl-wiki', connectorBindingId: 'sp-binding-1',
  provider: 'sharepoint', operation: 'content', sourceId: 'doc-123', expectedVersion: 'v7',
};

const artifact = (projectId = 'bbl-wiki', targetWorkspace = workspaceId): ArtifactReference => ({
  artifactId: '22222222-2222-4222-8222-222222222222',
  projectId, workspaceId: targetWorkspace, mime: 'text/plain', artifactType: 'EXTERNAL_DOCUMENT_TEXT',
  size: 4, sha256: 'a'.repeat(64), sensitivity: 'SENSITIVE', retentionPolicy: 'MISSION',
} as ArtifactReference);

class FakeAdapter implements ExternalDocumentAdapter<{ readonly token: string }> {
  readonly connectorId = 'sharepoint-read';
  readonly provider = 'sharepoint' as const;
  constructor(private readonly options: {
    status?: 'available' | 'unavailable'; version?: string; sourceId?: string;
    chunks?: readonly Uint8Array[]; artifacts?: readonly ArtifactReference[]; hangStatus?: boolean;
  } = {}) {}
  async status(): Promise<'available' | 'unavailable'> {
    if (this.options.hangStatus) return await new Promise(() => undefined);
    return this.options.status ?? 'available';
  }
  async acquire() {
    const chunks = this.options.chunks ?? [new TextEncoder().encode('hello')];
    return {
      sourceId: this.options.sourceId ?? 'doc-123',
      version: this.options.version ?? 'v7',
      content: (async function* () { for (const chunk of chunks) yield chunk; })(),
      artifacts: this.options.artifacts ?? [artifact()],
    };
  }
}

describe('M9 governed external document acquisition', () => {
  it('ingests bounded SharePoint content and returns supporting evidence with a digest', async () => {
    let clock = Date.parse('2026-09-20T00:00:00.000Z');
    const result = await acquireExternalDocument({
      reference, grant, request, adapter: new FakeAdapter(), auth: { token: 'SECRET-MATERIAL' },
      now: () => clock++,
    });
    expect(new TextDecoder().decode(result.content)).toBe('hello');
    expect(result.evidence).toMatchObject({
      authority: 'SUPPORTING_EVIDENCE', status: 'complete',
      provenance: { provider: 'sharepoint', sourceId: 'doc-123', version: 'v7', sourceLinkIdentity: 'ado-link:94747:sharepoint' },
    });
    expect(result.evidence.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(result.evidence);
    expect(serialized).not.toContain('SECRET-MATERIAL');
    expect(serialized).not.toContain(grant.credentialRef);
    expect(serialized).not.toContain(grant.sessionRef);
  });

  it('supports local PDF/Excel extraction authority with networking disabled', async () => {
    const localReference: ExternalDocumentReference = { ...reference, referenceId: 'pdf-link-1', provider: 'pdf', sourceId: 'artifact-123' };
    const localGrant: ExternalDocumentGrant = {
      ...grant, connectorId: 'local-doc-extractor', connectorBindingId: 'local-binding', provider: 'pdf',
      sourceMode: 'LOCAL_ARTIFACT', allowedSourceIds: ['artifact-123'], network: 'disabled',
    };
    const localRequest: ExternalDocumentRequest = {
      ...request, connectorBindingId: 'local-binding', provider: 'pdf', sourceId: 'artifact-123', expectedVersion: null,
    };
    const adapter: ExternalDocumentAdapter<null> = {
      connectorId: 'local-doc-extractor', provider: 'pdf', async status() { return 'available'; },
      async acquire() {
        return { sourceId: 'artifact-123', version: 'sha256-v1', content: (async function* () { yield new TextEncoder().encode('pdf text'); })(), artifacts: [] };
      },
    };
    const result = await acquireExternalDocument({ reference: localReference, grant: localGrant, request: localRequest, adapter, auth: null });
    expect(new TextDecoder().decode(result.content)).toBe('pdf text');
    expect(result.evidence.provenance.provider).toBe('pdf');
  });

  it('rejects content that exceeds the grant byte budget while streaming', async () => {
    await expect(acquireExternalDocument({
      reference, grant: { ...grant, limits: { ...grant.limits, maxContentBytes: 4 } }, request,
      adapter: new FakeAdapter({ chunks: [new TextEncoder().encode('123'), new TextEncoder().encode('45')] }),
      auth: { token: 'secret' },
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('rejects source-version drift and source-id substitution', async () => {
    await expect(acquireExternalDocument({ reference, grant, request, adapter: new FakeAdapter({ version: 'v8' }), auth: { token: 'x' } }))
      .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await expect(acquireExternalDocument({ reference, grant, request, adapter: new FakeAdapter({ sourceId: 'doc-999' }), auth: { token: 'x' } }))
      .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('rejects foreign artifact ownership before evidence publication', async () => {
    await expect(acquireExternalDocument({
      reference, grant, request, adapter: new FakeAdapter({ artifacts: [artifact('foreign-project')] }), auth: { token: 'x' },
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('fails closed when the connector is unavailable or exceeds its timeout', async () => {
    await expect(acquireExternalDocument({ reference, grant, request, adapter: new FakeAdapter({ status: 'unavailable' }), auth: { token: 'x' } }))
      .rejects.toMatchObject({ code: 'ACQUISITION_FAILED' });
    await expect(acquireExternalDocument({
      reference, grant: { ...grant, limits: { ...grant.limits, timeoutMs: 5 } }, request,
      adapter: new FakeAdapter({ hangStatus: true }), auth: { token: 'x' },
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
