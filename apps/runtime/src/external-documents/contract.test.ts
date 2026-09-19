import { describe, expect, it } from 'vitest';
import {
  bindExternalDocumentAcquisition,
  createExternalDocumentReference,
  ExternalDocumentContractError,
  type ExternalDocumentGrant,
  type ExternalDocumentRequest,
} from './contract.js';

const grant: ExternalDocumentGrant = {
  projectId: 'bbl-wiki',
  connectorId: 'figma-read',
  connectorBindingId: 'binding-1',
  provider: 'figma',
  credentialRef: 'credential-ref',
  sessionRef: 'session-ref',
  sourceMode: 'REMOTE',
  allowedSourceIds: ['AllowedFile'],
  allowedOperations: ['metadata', 'content', 'structure', 'preview'],
  network: 'allowed',
  expiresAt: '2030-01-01T00:00:00.000Z',
  revoked: false,
  outputWorkspaceId: 'workspace-1' as ExternalDocumentGrant['outputWorkspaceId'],
  limits: { maxContentBytes: 1_048_576, maxArtifacts: 16, timeoutMs: 30_000 },
};

const request: ExternalDocumentRequest = {
  requestId: 'request-1',
  projectId: 'bbl-wiki',
  connectorBindingId: 'binding-1',
  provider: 'figma',
  operation: 'content',
  sourceId: 'AllowedFile',
  expectedVersion: 'v1',
};

function code(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalDocumentContractError);
    return (error as ExternalDocumentContractError).code;
  }
  throw new Error('expected contract failure');
}

describe('M9 external document connector boundary', () => {
  it('keeps an ADO supporting-document reference inert without requiring a connector', () => {
    expect(createExternalDocumentReference({
      referenceId: 'link-1',
      projectId: 'bbl-wiki',
      sourceWorkItemId: '94747',
      sourceLinkIdentity: 'ado-link:94747:design',
      provider: 'figma',
      sourceId: 'AllowedFile',
      title: 'Authoritative design',
      authority: 'REFERENCE_ONLY',
    })).toEqual({
      referenceId: 'link-1',
      projectId: 'bbl-wiki',
      sourceWorkItemId: '94747',
      sourceLinkIdentity: 'ado-link:94747:design',
      provider: 'figma',
      sourceId: 'AllowedFile',
      title: 'Authoritative design',
      authority: 'REFERENCE_ONLY',
    });
  });

  it('binds only the named project, connector binding, provider, source and operation', () => {
    expect(bindExternalDocumentAcquisition(grant, request, Date.parse('2026-09-20T00:00:00.000Z'))).toEqual(request);
    expect(code(() => bindExternalDocumentAcquisition(grant, { ...request, projectId: 'other' }, Date.now()))).toBe('UNAUTHORIZED');
    expect(code(() => bindExternalDocumentAcquisition(grant, { ...request, connectorBindingId: 'binding-2' }, Date.now()))).toBe('UNAUTHORIZED');
    expect(code(() => bindExternalDocumentAcquisition(grant, { ...request, provider: 'sharepoint' }, Date.now()))).toBe('UNAUTHORIZED');
    expect(code(() => bindExternalDocumentAcquisition(grant, { ...request, sourceId: 'OtherFile' }, Date.now()))).toBe('UNAUTHORIZED');
  });

  it('fails closed for revoked, expired and network-disabled remote authority', () => {
    const now = Date.parse('2026-09-20T00:00:00.000Z');
    expect(code(() => bindExternalDocumentAcquisition({ ...grant, revoked: true }, request, now))).toBe('REVOKED_AUTH');
    expect(code(() => bindExternalDocumentAcquisition({ ...grant, expiresAt: '2026-09-19T00:00:00.000Z' }, request, now))).toBe('EXPIRED_AUTH');
    expect(code(() => bindExternalDocumentAcquisition({ ...grant, network: 'disabled' }, request, now))).toBe('NETWORK_DISABLED');
  });

  it('allows local PDF/Excel-style artifact acquisition without network authority', () => {
    const localGrant: ExternalDocumentGrant = {
      ...grant,
      provider: 'pdf',
      connectorId: 'artifact-doc',
      connectorBindingId: 'binding-local',
      sourceMode: 'LOCAL_ARTIFACT',
      allowedSourceIds: ['artifact-123'],
      allowedOperations: ['metadata', 'content', 'structure'],
      network: 'disabled',
    };
    const localRequest: ExternalDocumentRequest = {
      ...request,
      connectorBindingId: 'binding-local',
      provider: 'pdf',
      sourceId: 'artifact-123',
      operation: 'structure',
      expectedVersion: null,
    };
    expect(bindExternalDocumentAcquisition(localGrant, localRequest, Date.parse('2026-09-20T00:00:00.000Z'))).toEqual(localRequest);
  });

  it('does not accept URLs, headers, paths or arbitrary operations in the acquisition request surface', () => {
    expect(code(() => bindExternalDocumentAcquisition(grant, {
      ...request,
      sourceId: 'https://figma.example/file/AllowedFile',
    }, Date.now()))).toBe('INVALID_REQUEST');
    expect(code(() => bindExternalDocumentAcquisition(grant, {
      ...request,
      operation: 'write' as ExternalDocumentRequest['operation'],
    }, Date.now()))).toBe('INVALID_REQUEST');
  });
});
