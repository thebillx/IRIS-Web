import { describe, expect, it } from 'vitest';
import type { ArtifactReference, WorkspaceId } from '@iris/domain';
import { bindExternalDocumentAcquisition, type ExternalDocumentGrant } from './external-documents/contract.js';
import { routeAdoAttachment } from './external-documents/attachment-routing.js';
import { buildCrossProjectKnowledgeGraph } from './external-documents/cross-project-graph.js';
import { bindAdoWikiWriteBack } from './ado/wiki-writeback.js';

const workspaceId='11111111-1111-4111-8111-111111111111' as WorkspaceId;
const grant:ExternalDocumentGrant={projectId:'bbl-wiki',connectorId:'sp',connectorBindingId:'b1',provider:'sharepoint',credentialRef:'cred-ref',sessionRef:'session-ref',sourceMode:'REMOTE',allowedSourceIds:['doc-1'],allowedOperations:['content'],network:'allowed',expiresAt:'2030-01-01T00:00:00.000Z',revoked:false,outputWorkspaceId:workspaceId,limits:{maxContentBytes:1024,maxArtifacts:2,timeoutMs:1000}};

describe('IRIS M9 security acceptance',()=>{
  it('does not accept caller URLs as external source authority',()=>{
    expect(()=>bindExternalDocumentAcquisition(grant,{requestId:'r1',projectId:'bbl-wiki',connectorBindingId:'b1',provider:'sharepoint',operation:'content',sourceId:'https://evil.example/doc',expectedVersion:null},Date.now())).toThrow('INVALID_REQUEST');
  });
  it('rejects cross-project attachment artifact substitution',()=>{
    const artifact={artifactId:'22222222-2222-4222-8222-222222222222',projectId:'foreign',workspaceId,mime:'application/pdf',artifactType:'ADO_ATTACHMENT',size:1,sha256:'a'.repeat(64),sensitivity:'SENSITIVE',retentionPolicy:'MISSION'} as ArtifactReference;
    expect(()=>routeAdoAttachment({projectId:'bbl-wiki',workspaceId,sourceWorkItemId:'1',sourceLinkIdentity:'ado-attachment:1:1',title:'x',artifact})).toThrow('ATTACHMENT_ARTIFACT_AUTHORITY_MISMATCH');
  });
  it('rejects cross-project graph nodes outside the explicit allowlist',()=>{
    expect(()=>buildCrossProjectKnowledgeGraph({grantId:'g1',allowedProjectIds:['a','b'],allowedRelations:['SUPPORTS'],expiresAt:'2030-01-01T00:00:00.000Z',maxNodes:4,maxLinks:1},[
      {nodeId:'n1',projectId:'a',kind:'ADO_WORK_ITEM',sourceIdentity:'w:1',version:null},
      {nodeId:'n2',projectId:'c',kind:'BUG',sourceIdentity:'b:2',version:null},
    ],[],Date.now())).toThrow('CROSS_PROJECT_AUTHORITY_DENIED');
  });
  it('rejects ADO Wiki traversal and leaves transport unavailable even for valid intents',()=>{
    const artifact={artifactId:'33333333-3333-4333-8333-333333333333',projectId:'bbl-wiki',workspaceId,mime:'text/markdown',artifactType:'WIKI_RENDER',size:10,sha256:'b'.repeat(64),sensitivity:'INTERNAL',retentionPolicy:'MISSION'} as ArtifactReference;
    const writeGrant={projectId:'bbl-wiki',connectorBindingId:'wiki-binding',wikiId:'knowledge',outputWorkspaceId:workspaceId,allowedPathPrefixes:['/Knowledge'],operations:['UPDATE'] as const,expiresAt:'2030-01-01T00:00:00.000Z',enabled:true,maxArtifactBytes:1024};
    expect(()=>bindAdoWikiWriteBack(writeGrant,{requestId:'w1',projectId:'bbl-wiki',connectorBindingId:'wiki-binding',wikiId:'knowledge',operation:'UPDATE',targetPath:'/Knowledge/../Admin',expectedRemoteVersion:'v1',artifact},Date.now())).toThrow('INVALID_ADO_WIKI_PATH');
    expect(bindAdoWikiWriteBack(writeGrant,{requestId:'w2',projectId:'bbl-wiki',connectorBindingId:'wiki-binding',wikiId:'knowledge',operation:'UPDATE',targetPath:'/Knowledge/Good',expectedRemoteVersion:'v1',artifact},Date.now()).transportEnabled).toBe(false);
  });
});
