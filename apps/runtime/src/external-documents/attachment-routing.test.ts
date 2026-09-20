import { describe, expect, it } from 'vitest';
import type { ArtifactReference, WorkspaceId } from '@iris/domain';
import { routeAdoAttachment } from './attachment-routing.js';

const workspaceId = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
function artifact(mime: string, projectId = 'bbl-wiki', targetWorkspace = workspaceId): ArtifactReference {
  return {
    artifactId: '33333333-3333-4333-8333-333333333333', projectId, workspaceId: targetWorkspace,
    mime, artifactType: 'ADO_ATTACHMENT', size: 100, sha256: 'b'.repeat(64),
    sensitivity: 'SENSITIVE', retentionPolicy: 'MISSION',
  } as ArtifactReference;
}
const base = {
  projectId: 'bbl-wiki', workspaceId, sourceWorkItemId: '94747',
  sourceLinkIdentity: 'ado-attachment:94747:1', title: 'Requirement attachment',
};

describe('M9 ADO attachment routing', () => {
  it('routes PDF and Excel artifacts without exposing a filesystem path', () => {
    const pdf = routeAdoAttachment({ ...base, artifact: artifact('application/pdf') });
    expect(pdf).toMatchObject({ supported: true, provider: 'pdf', reference: { authority: 'REFERENCE_ONLY', sourceWorkItemId: '94747' } });
    const xlsx = routeAdoAttachment({ ...base, sourceLinkIdentity: 'ado-attachment:94747:2', artifact: artifact('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') });
    expect(xlsx).toMatchObject({ supported: true, provider: 'excel' });
    expect(JSON.stringify([pdf, xlsx])).not.toContain('/Users/');
  });

  it('keeps unsupported attachment content reference-only and does not invent an extractor', () => {
    expect(routeAdoAttachment({ ...base, artifact: artifact('application/zip') })).toEqual({
      supported: false, reason: 'UNSUPPORTED_MIME', sourceLinkIdentity: 'ado-attachment:94747:1', mime: 'application/zip',
    });
  });

  it('rejects cross-project and cross-workspace artifact substitution', () => {
    expect(() => routeAdoAttachment({ ...base, artifact: artifact('application/pdf', 'foreign') }))
      .toThrow('ATTACHMENT_ARTIFACT_AUTHORITY_MISMATCH');
    expect(() => routeAdoAttachment({ ...base, artifact: artifact('application/pdf', 'bbl-wiki', '44444444-4444-4444-8444-444444444444' as WorkspaceId) }))
      .toThrow('ATTACHMENT_ARTIFACT_AUTHORITY_MISMATCH');
  });

  it('derives a stable reference identity from the governed attachment identity and digest', () => {
    const first = routeAdoAttachment({ ...base, artifact: artifact('application/pdf') });
    const second = routeAdoAttachment({ ...base, artifact: artifact('application/pdf') });
    expect(first).toEqual(second);
    if (first.supported) expect(first.reference.referenceId).toMatch(/^attachment:[a-f0-9]{32}$/);
  });
});
