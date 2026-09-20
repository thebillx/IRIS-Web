import { describe, expect, it } from 'vitest';
import { buildCrossProjectKnowledgeGraph } from './cross-project-graph.js';
import type { CrossSourceLink, CrossSourceNode } from './revision-correlation.js';

const grant = {
  grantId: 'cross-project-read-1', allowedProjectIds: ['project-a','project-b'],
  allowedRelations: ['SUPPORTS','VERIFIES'] as const, expiresAt: '2030-01-01T00:00:00.000Z', maxNodes: 10, maxLinks: 10,
};
const nodes: CrossSourceNode[] = [
  { nodeId:'a-req',projectId:'project-a',kind:'ADO_WORK_ITEM',sourceIdentity:'workitem:1',version:'1' },
  { nodeId:'b-test',projectId:'project-b',kind:'TEST_CASE',sourceIdentity:'testcase:2',version:'3' },
];
const links: CrossSourceLink[] = [
  { linkId:'cross-1',fromNodeId:'b-test',toNodeId:'a-req',relation:'VERIFIES',authority:'SUPPORTING_EVIDENCE' },
];

describe('M9 cross-project knowledge graph', () => {
  it('permits only explicitly granted project identities and evidence relations', () => {
    const graph = buildCrossProjectKnowledgeGraph(grant, nodes, links, Date.parse('2026-09-20T00:00:00.000Z'));
    expect(graph.projectIds).toEqual(['project-a','project-b']);
    expect(graph.links[0]?.authority).toBe('SUPPORTING_EVIDENCE');
  });
  it('rejects a project outside the grant', () => {
    expect(() => buildCrossProjectKnowledgeGraph(grant, [...nodes,{...nodes[0]!,nodeId:'c',projectId:'project-c'}], links, Date.now()))
      .toThrow('CROSS_PROJECT_AUTHORITY_DENIED');
  });
  it('rejects relation widening and expired grants', () => {
    expect(() => buildCrossProjectKnowledgeGraph(grant, nodes, [{...links[0]!,relation:'IMPLEMENTS'}], Date.now()))
      .toThrow('CROSS_PROJECT_RELATION_DENIED');
    expect(() => buildCrossProjectKnowledgeGraph({...grant,expiresAt:'2020-01-01T00:00:00.000Z'}, nodes, links, Date.now()))
      .toThrow('INVALID_CROSS_PROJECT_GRANT');
  });
});
