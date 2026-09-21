import { describe, expect, it } from 'vitest';
import type { AdoRuntimeBindingProvider, ResolvedAdoRuntimeBinding } from './runtime-binding.js';
import { AdoRequirementContextService } from './runtime-context.js';

const identity = {
  organization: { id: 'org-id', name: 'org' },
  project: { id: 'project-id', name: 'Project' },
  team: { id: 'team-id', name: 'Team' },
  board: { id: 'board-id', name: 'Stories' },
} as const;

const resolved: ResolvedAdoRuntimeBinding = {
  identity,
  organizationName: 'org',
  projectName: 'Project',
  auth: { kind: 'PAT', secret: 'abcdefghijklmnopqrstuvwxyz1234567890' },
  grant: {
    projectId: 'iris-project',
    connectorBindingId: 'ado-binding',
    credentialRef: 'ado-credential',
    sessionRef: 'ado-session',
    network: 'allowed',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revoked: false,
    tokenScopes: ['vso.work'],
    policy: {
      mode: 'READ_ONLY',
      allowlist: [{
        organization: 'org-id',
        project: 'project-id',
        team: 'team-id',
        board: 'board-id',
        resources: ['board', 'scope', 'backlogs', 'query', 'workItems', 'comments', 'links'],
      }],
      timeoutMs: 5000,
      maxResponseBytes: 1024 * 1024,
      maxPageItems: 100,
      maxPages: 4,
      maxBatchItems: 100,
      rateLimit: { requests: 100, windowMs: 60_000, maxRetryAfterMs: 10_000 },
    },
  },
};

const provider: AdoRuntimeBindingProvider = {
  resolve: async (projectId) => {
    if (projectId !== 'iris-project') throw new Error('wrong project');
    return resolved;
  },
};

describe('ADO runtime requirement context', () => {
  it('discovers exact bound board/scope/backlogs with provenance and no credential output', async () => {
    const calls: RequestRecord[] = [];
    const service = new AdoRequirementContextService(provider, fakeFetch(calls));

    const result = await service.discovery('iris-project', 'req-discovery');

    expect(result.identity).toEqual(identity);
    expect(result.scope.values).toEqual([{ value: 'Project\\Team', includeChildren: true }]);
    expect(result.backlogs.map((entry) => [entry.name, entry.type])).toEqual([
      ['Features', 'portfolio'],
      ['Stories', 'requirement'],
    ]);
    expect(result.provenance.provider).toBe('azure-devops');
    expect(JSON.stringify(result)).not.toContain(resolved.auth.secret);
    expect(calls.every((call) => call.authorization.startsWith('Basic '))).toBe(true);
    expect(calls.every((call) => call.url.hostname === 'dev.azure.com')).toBe(true);
  });

  it('returns sanitized canonical work item, comments, links, revision and changed time', async () => {
    const calls: RequestRecord[] = [];
    const service = new AdoRequirementContextService(provider, fakeFetch(calls));

    const result = await service.workItemRead({
      projectId: 'iris-project',
      requestId: 'req-item',
      workItemId: 101,
      includeComments: true,
      includeLinks: true,
    });

    expect(result.item.id).toBe(101);
    expect(result.item.revision).toBe(7);
    expect(result.item.title).toBe('Story 101');
    expect(result.item.description).toBe('Hello world');
    expect(result.item.acceptanceCriteria.text).toContain('Given');
    expect(result.relations).toEqual([{ relation: 'System.LinkTypes.Hierarchy-Forward', targetWorkItemId: 102 }]);
    expect(result.comments).toEqual([{ id: '1', text: 'Reviewed comment' }]);
    expect(result.provenance.revision).toBe(7);
    expect(result.provenance.changedDate).toBe('2026-09-20T12:00:00Z');
    const workItemCall = calls.find((call) => call.url.pathname.endsWith('/_apis/wit/workitems/101'));
    expect(workItemCall?.url.searchParams.get('$expand')).toBe('Relations');
    expect(workItemCall?.url.searchParams.has('fields')).toBe(false);
    expect(JSON.stringify(result.item)).not.toContain('must-not-project');
  });

  it('walks only hierarchy-forward links and keeps every node inside team Area Path scope', async () => {
    const service = new AdoRequirementContextService(provider, fakeFetch([]));

    const result = await service.hierarchyRead({
      projectId: 'iris-project',
      requestId: 'req-tree',
      rootWorkItemId: 101,
      maxDepth: 2,
      maxItems: 10,
    });

    expect(result.nodes.map((node) => [node.item.id, node.depth])).toEqual([[101, 0], [102, 1]]);
    expect(result.nodes[0]!.childIds).toEqual([102]);
    expect(result.nodes[1]!.childIds).toEqual([]);
  });

  it('builds scoped WIQL internally, escapes caller text, then returns normalized bounded results', async () => {
    const calls: RequestRecord[] = [];
    const service = new AdoRequirementContextService(provider, fakeFetch(calls));

    const result = await service.contextSearch({
      projectId: 'iris-project',
      requestId: 'req-search',
      query: "O'Reilly",
      limit: 10,
    });

    expect(result.items.map((item) => item.id)).toEqual([101, 102]);
    const wiqlCall = calls.find((call) => call.url.pathname.endsWith('/_apis/wit/wiql'));
    expect(wiqlCall?.method).toBe('POST');
    expect(wiqlCall?.body).toContain("O''Reilly");
    expect(wiqlCall?.body).toContain("[System.AreaPath] UNDER 'Project\\\\Team'");
    expect(wiqlCall?.body).not.toContain(resolved.auth.secret);
  });

  it('fails closed before fetching Work Item content when the requested ID is outside the bound team Area Path', async () => {
    const calls: RequestRecord[] = [];
    const service = new AdoRequirementContextService(provider, fakeFetch(calls, true));

    await expect(service.workItemRead({
      projectId: 'iris-project',
      requestId: 'req-outside',
      workItemId: 101,
      includeComments: false,
      includeLinks: false,
    })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
    expect(calls.some((call) => call.url.pathname.endsWith('/_apis/wit/wiql'))).toBe(true);
    expect(calls.some((call) => call.url.pathname.endsWith('/_apis/wit/workitems/101'))).toBe(false);
  });

  it('filters relation targets outside the bound Team scope without fetching their Work Item content', async () => {
    const calls: RequestRecord[] = [];
    const service = new AdoRequirementContextService(provider, fakeFetch(calls, false, true));

    const result = await service.workItemRead({
      projectId: 'iris-project',
      requestId: 'req-link-outside',
      workItemId: 101,
      includeComments: false,
      includeLinks: true,
    });
    expect(result.relations).toEqual([]);
    expect(calls.some((call) => call.url.pathname.endsWith('/_apis/wit/workitemsbatch'))).toBe(false);
    expect(calls.some((call) => call.url.pathname.endsWith('/_apis/wit/workitems/102'))).toBe(false);
  });

  it('enforces the configured local request window before an extra network request is dispatched', async () => {
    const calls: RequestRecord[] = [];
    const limited: ResolvedAdoRuntimeBinding = {
      ...resolved,
      grant: {
        ...resolved.grant,
        policy: {
          ...resolved.grant.policy,
          rateLimit: { requests: 1, windowMs: 60_000, maxRetryAfterMs: 10_000 },
        },
      },
    };
    const limitedProvider: AdoRuntimeBindingProvider = {
      resolve: async () => limited,
    };
    const service = new AdoRequirementContextService(limitedProvider, fakeFetch(calls));

    await expect(service.discovery('iris-project', 'req-rate-limit'))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    expect(calls).toHaveLength(1);
  });
});

interface RequestRecord {
  readonly url: URL;
  readonly method: string;
  readonly authorization: string;
  readonly body: string;
}

function fakeFetch(calls: RequestRecord[], outsideScope = false, outsideRelationTarget = false): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, authorization: headers.get('authorization') ?? '', body });

    if (url.pathname.endsWith('/_apis/work/boards/board-id')) return json({ id: 'board-id', name: 'Stories' });
    if (url.pathname.endsWith('/_apis/work/teamsettings/teamfieldvalues')) return json({
      field: { referenceName: 'System.AreaPath' },
      defaultValue: 'Project\\Team',
      values: [{ value: 'Project\\Team', includeChildren: true }],
    });
    if (url.pathname.endsWith('/_apis/work/backlogs')) return json({ value: [
      { id: 'feature', name: 'Features', rank: 1, type: 'portfolio', workItemTypes: [{ name: 'Feature' }] },
      { id: 'story', name: 'Stories', rank: 2, type: 'requirement', workItemTypes: [{ name: 'User Story' }] },
    ] });
    if (url.pathname.endsWith('/_apis/wit/wiql')) {
      const parsed = JSON.parse(body) as { query?: unknown };
      const query = typeof parsed.query === 'string' ? parsed.query : '';
      const membership = /\[System\.Id\] IN \(([^)]+)\)/.exec(query);
      if (membership !== null) {
        const ids = membership[1]!.split(',').map((value) => Number(value.trim()));
        const workItems = ids
          .filter((id) => !(id === 101 && outsideScope) && !(id === 102 && outsideRelationTarget))
          .map((id) => ({ id }));
        return json({ workItems });
      }
      return json({ workItems: [{ id: 101 }, { id: 102 }] });
    }
    if (url.pathname.endsWith('/_apis/wit/workitemsbatch')) {
      const parsed = JSON.parse(body) as { ids?: unknown };
      if (!Array.isArray(parsed.ids) || !parsed.ids.every((id) => Number.isSafeInteger(id))) throw new Error('invalid fake batch body');
      return json({ value: parsed.ids.map((id) => {
        const numericId = Number(id);
        const areaPath = numericId === 101 && outsideScope
          ? 'Project\\Other'
          : numericId === 102 && outsideRelationTarget
            ? 'Project\\Other'
            : 'Project\\Team\\ETB';
        return rawWorkItem(numericId, areaPath, numericId === 101);
      }) });
    }
    if (url.pathname.endsWith('/workItems/101/comments')) {
      return json({ comments: [{ id: 1, text: '<b>Reviewed</b> comment' }] });
    }
    if (url.pathname.endsWith('/workitems/101')) return json(rawWorkItem(101, outsideScope ? 'Project\\Other' : 'Project\\Team\\ETB', true));
    if (url.pathname.endsWith('/workitems/102')) return json(rawWorkItem(102, 'Project\\Team\\ETB', false));
    throw new Error('unexpected fake ADO route: ' + url.pathname);
  }) as typeof fetch;
}

function rawWorkItem(id: number, areaPath: string, child: boolean) {
  return {
    id,
    rev: id === 101 ? 7 : 3,
    fields: {
      'System.WorkItemType': id === 101 ? 'User Story' : 'Task',
      'System.Title': id === 101 ? 'Story 101' : 'Task 102',
      'System.State': 'Active',
      'System.Description': '<p>Hello <b>world</b></p>',
      'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>Given safe context</p>',
      'System.AreaPath': areaPath,
      'System.IterationPath': 'Project\\Sprint 1',
      'System.Parent': id === 102 ? 101 : null,
      'System.Tags': 'etb;automation',
      'System.BoardColumn': 'Doing',
      'System.CreatedDate': '2026-09-01T10:00:00Z',
      'System.ChangedDate': id === 101 ? '2026-09-20T12:00:00Z' : '2026-09-20T12:30:00Z',
      'Custom.PrivateField': 'must-not-project',
    },
    relations: child ? [{
      rel: 'System.LinkTypes.Hierarchy-Forward',
      url: 'https://dev.azure.com/org/project-id/_apis/wit/workItems/102',
    }] : [],
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
