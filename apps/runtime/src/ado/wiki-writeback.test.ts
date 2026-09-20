import { describe, expect, it } from 'vitest';
import type { ArtifactReference, WorkspaceId } from '@iris/domain';
import { bindAdoWikiWriteBack, type AdoWikiWriteGrant, type AdoWikiWriteRequest } from './wiki-writeback.js';

const workspaceId = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
const artifact: ArtifactReference = {
  artifactId: '22222222-2222-4222-8222-222222222222', projectId: 'bbl-wiki', workspaceId,
  mime: 'text/markdown', artifactType: 'WIKI_RENDER', size: 120, sha256: 'a'.repeat(64),
  sensitivity: 'INTERNAL', retentionPolicy: 'MISSION',
} as ArtifactReference;
const grant: AdoWikiWriteGrant = {
  projectId: 'bbl-wiki', connectorBindingId: 'ado-wiki-binding', wikiId: 'knowledge-wiki', outputWorkspaceId: workspaceId,
  allowedPathPrefixes: ['/Knowledge'], operations: ['CREATE','UPDATE'], expiresAt: '2030-01-01T00:00:00.000Z',
  enabled: true, maxArtifactBytes: 1024 * 1024,
};
const request: AdoWikiWriteRequest = {
  requestId: 'write-1', projectId: 'bbl-wiki', connectorBindingId: 'ado-wiki-binding', wikiId: 'knowledge-wiki',
  operation: 'UPDATE', targetPath: '/Knowledge/Payments', expectedRemoteVersion: 'etag-v7', artifact,
};

describe('M9 optional controlled ADO Wiki write-back boundary', () => {
  it('binds an exact immutable intent and leaves transport disabled pending owner approval', () => {
    const bound = bindAdoWikiWriteBack(grant, request, Date.parse('2026-09-20T00:00:00.000Z'));
    expect(bound).toMatchObject({
      projectId:'bbl-wiki',wikiId:'knowledge-wiki',operation:'UPDATE',targetPath:'/Knowledge/Payments',
      expectedRemoteVersion:'etag-v7',requiresOwnerApproval:true,transportEnabled:false,
    });
    expect(bound.intentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(bound.artifactSha256).toBe(artifact.sha256);
  });

  it('is disabled by default unless a trusted grant explicitly enables write-back', () => {
    expect(() => bindAdoWikiWriteBack({ ...grant, enabled:false }, request, Date.now())).toThrow('ADO_WIKI_WRITE_DISABLED');
  });

  it('requires exact path authority and rejects traversal or sibling substitution', () => {
    expect(() => bindAdoWikiWriteBack(grant,{...request,targetPath:'/Other/Payments'},Date.now())).toThrow('ADO_WIKI_PATH_DENIED');
    expect(() => bindAdoWikiWriteBack(grant,{...request,targetPath:'/Knowledge/../Admin'},Date.now())).toThrow('INVALID_ADO_WIKI_PATH');
  });

  it('requires update version fencing and clean create semantics', () => {
    expect(() => bindAdoWikiWriteBack(grant,{...request,expectedRemoteVersion:null},Date.now())).toThrow('ADO_WIKI_VERSION_REQUIRED');
    expect(() => bindAdoWikiWriteBack(grant,{...request,operation:'CREATE',expectedRemoteVersion:'etag'},Date.now())).toThrow('ADO_WIKI_VERSION_CONFLICT');
    expect(bindAdoWikiWriteBack(grant,{...request,operation:'CREATE',expectedRemoteVersion:null,targetPath:'/Knowledge/New'},Date.now()).operation).toBe('CREATE');
  });

  it('rejects foreign/oversized/non-text governed artifacts', () => {
    expect(() => bindAdoWikiWriteBack(grant,{...request,artifact:{...artifact,projectId:'foreign'}},Date.now())).toThrow('ADO_WIKI_ARTIFACT_DENIED');
    expect(() => bindAdoWikiWriteBack(grant,{...request,artifact:{...artifact,size:grant.maxArtifactBytes+1}},Date.now())).toThrow('ADO_WIKI_ARTIFACT_DENIED');
    expect(() => bindAdoWikiWriteBack(grant,{...request,artifact:{...artifact,mime:'application/pdf'}},Date.now())).toThrow('ADO_WIKI_ARTIFACT_DENIED');
  });

  it('changes intent identity whenever target/version/artifact changes', () => {
    const a=bindAdoWikiWriteBack(grant,request,Date.now());
    const b=bindAdoWikiWriteBack(grant,{...request,targetPath:'/Knowledge/Cards'},Date.now());
    const c=bindAdoWikiWriteBack(grant,{...request,artifact:{...artifact,sha256:'b'.repeat(64)}},Date.now());
    expect(new Set([a.intentDigest,b.intentDigest,c.intentDigest]).size).toBe(3);
  });
});
