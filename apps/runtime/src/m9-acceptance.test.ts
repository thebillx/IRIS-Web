import { describe, expect, it } from 'vitest';
import type { ArtifactReference, WorkspaceId } from '@iris/domain';
import { createExternalDocumentReference } from './external-documents/contract.js';
import { projectExternalDocumentReferencesForWiki } from './external-documents/reference-index.js';
import { compareExternalRevisions } from './external-documents/revision-correlation.js';
import { assessExternalKnowledgeFreshness } from './external-documents/freshness.js';
import { buildCrossProjectKnowledgeGraph } from './external-documents/cross-project-graph.js';
import { planDueScheduledSyncs } from './ado/m9-scheduler.js';
import { bindAdoWikiWriteBack } from './ado/wiki-writeback.js';

const workspaceId='11111111-1111-4111-8111-111111111111' as WorkspaceId;

describe('IRIS M9 acceptance',()=>{
  it('keeps supporting-document references useful before any connector exists',()=>{
    const ref=createExternalDocumentReference({
      referenceId:'doc-1',projectId:'bbl-wiki',sourceWorkItemId:'94747',sourceLinkIdentity:'ado-link:94747:figma',
      provider:'figma',sourceId:'AllowedFile',title:'Payment design',authority:'REFERENCE_ONLY',
    });
    expect(projectExternalDocumentReferencesForWiki([ref])).toEqual([{
      referenceId:'doc-1',sourceWorkItemId:'94747',sourceLinkIdentity:'ado-link:94747:figma',provider:'figma',
      sourceId:'AllowedFile',title:'Payment design',authority:'SUPPORTING_EVIDENCE',acquisition:'NOT_REQUESTED',searchable:false,
    }]);
  });

  it('propagates external source drift into stale Wiki topics without changing authority',()=>{
    const previous={projectId:'bbl-wiki',provider:'figma' as const,sourceId:'AllowedFile',sourceLinkIdentity:'ado-link:94747:figma',version:'v1',acquiredAt:'2026-09-20T00:00:00.000Z',contentSha256:'a'.repeat(64),artifactIds:[]};
    const current={...previous,version:'v2',acquiredAt:'2026-09-20T01:00:00.000Z',contentSha256:'b'.repeat(64)};
    expect(compareExternalRevisions(previous,current).state).toBe('CONTENT_CHANGED');
    expect(assessExternalKnowledgeFreshness({
      projectId:'bbl-wiki',sourceId:'AllowedFile',sourceLinkIdentity:'ado-link:94747:figma',sourceVersion:'v1',
      contentSha256:'a'.repeat(64),builtAt:'2026-09-20T00:30:00.000Z',topicIds:['topic-payments'],
    },current,'2026-09-20T01:00:00.000Z',3600000)).toEqual({state:'STALE_SOURCE',affectedTopicIds:['topic-payments'],reason:'SOURCE_CHANGED'});
  });

  it('uses the existing scheduled sync contract and explicit cross-project graph grant',()=>{
    const scope={organizationId:'org',projectId:'project-a',teamId:'team',boardId:'board'};
    const planned=planDueScheduledSyncs([{scheduleId:'daily',scope,mode:'INCREMENTAL',nextDueAt:'2026-09-20T00:00:00.000Z',enabled:true}],
      {daily:{snapshotId:'snap',complete:true,items:[{itemId:1,parentId:null,backlogIds:['Stories']}]}},
      {daily:{gateVersion:'m5-v1',minimumPromoted:0,allowRejections:true}},'2026-09-20T01:00:00.000Z');
    expect(planned[0]?.start.trigger).toEqual({kind:'SCHEDULE',scheduleId:'daily'});
    const graph=buildCrossProjectKnowledgeGraph({grantId:'g1',allowedProjectIds:['project-a','project-b'],allowedRelations:['VERIFIES'],expiresAt:'2030-01-01T00:00:00.000Z',maxNodes:10,maxLinks:10},[
      {nodeId:'req',projectId:'project-a',kind:'ADO_WORK_ITEM',sourceIdentity:'workitem:1',version:'1'},
      {nodeId:'test',projectId:'project-b',kind:'TEST_CASE',sourceIdentity:'testcase:2',version:'2'},
    ],[{linkId:'x',fromNodeId:'test',toNodeId:'req',relation:'VERIFIES',authority:'SUPPORTING_EVIDENCE'}],Date.parse('2026-09-20T00:00:00.000Z'));
    expect(graph.links[0]?.authority).toBe('SUPPORTING_EVIDENCE');
  });

  it('prepares optional ADO Wiki write-back as owner-gated transport-disabled intent only',()=>{
    const artifact={artifactId:'22222222-2222-4222-8222-222222222222',projectId:'bbl-wiki',workspaceId,mime:'text/markdown',artifactType:'WIKI_RENDER',size:10,sha256:'c'.repeat(64),sensitivity:'INTERNAL',retentionPolicy:'MISSION'} as ArtifactReference;
    const intent=bindAdoWikiWriteBack({projectId:'bbl-wiki',connectorBindingId:'wiki-binding',wikiId:'knowledge',outputWorkspaceId:workspaceId,allowedPathPrefixes:['/Knowledge'],operations:['UPDATE'],expiresAt:'2030-01-01T00:00:00.000Z',enabled:true,maxArtifactBytes:1024},{requestId:'w1',projectId:'bbl-wiki',connectorBindingId:'wiki-binding',wikiId:'knowledge',operation:'UPDATE',targetPath:'/Knowledge/Payments',expectedRemoteVersion:'v7',artifact},Date.parse('2026-09-20T00:00:00.000Z'));
    expect(intent).toMatchObject({requiresOwnerApproval:true,transportEnabled:false});
  });
});
