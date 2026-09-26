import { randomUUID } from 'node:crypto';
import { RuntimeError } from '@iris/domain';
import { normalizeHtml, sanitizeText, stageRawSource, type CanonicalWorkItem } from '@iris/ado';
import { bindAdoRead, type AdoReadRequest } from './governance.js';
import { discoverBacklogs, type Backlog, type BoardIdentity } from './discovery.js';
import {
  FileAdoRuntimeBindingProvider,
  type AdoRuntimeBindingProvider,
  type ResolvedAdoRuntimeBinding,
} from './runtime-binding.js';

export interface AdoContextProvenance {
  readonly acquisitionId: string;
  readonly requestId: string;
  readonly provider: 'azure-devops';
  readonly operation: 'discovery' | 'workitem.read' | 'hierarchy.read' | 'context.search' | 'backlog.list';
  readonly organizationId: string;
  readonly projectId: string;
  readonly teamId: string;
  readonly boardId: string;
  readonly acquiredAt: string;
}

export interface AdoScopeSnapshot {
  readonly field: 'System.AreaPath';
  readonly defaultValue: string;
  readonly values: readonly { readonly value: string; readonly includeChildren: boolean }[];
}

export interface AdoWorkItemSnapshot {
  readonly item: CanonicalWorkItem;
  readonly relations: readonly { readonly relation: string; readonly targetWorkItemId: number }[];
  readonly comments: readonly { readonly id: string; readonly text: string }[];
}

export interface AdoDiscoveryResult {
  readonly identity: BoardIdentity;
  readonly scope: AdoScopeSnapshot;
  readonly backlogs: readonly Backlog[];
  readonly provenance: AdoContextProvenance;
}

export interface AdoWorkItemResult extends AdoWorkItemSnapshot {
  readonly provenance: AdoContextProvenance & {
    readonly revision: number;
    readonly changedDate: string;
  };
}

export interface AdoHierarchyResult {
  readonly rootWorkItemId: number;
  readonly nodes: readonly {
    readonly depth: number;
    readonly item: CanonicalWorkItem;
    readonly childIds: readonly number[];
  }[];
  readonly provenance: AdoContextProvenance;
}

export interface AdoSearchResult {
  readonly query: string;
  readonly items: readonly CanonicalWorkItem[];
  readonly provenance: AdoContextProvenance;
}

export interface AdoBacklogListResult {
  readonly backlog: { readonly id: string; readonly name: string; readonly type: string; readonly workItemTypes: readonly string[] };
  readonly scope: AdoScopeSnapshot;
  readonly items: readonly CanonicalWorkItem[];
  readonly page: { readonly offset: number; readonly limit: number; readonly nextCursor: string | null; readonly complete: boolean };
  readonly provenance: AdoContextProvenance;
}

interface HttpResult {
  readonly body: unknown;
  readonly continuation: string | null;
}

interface RuntimeScope {
  readonly snapshot: AdoScopeSnapshot;
}

interface RawWorkItem {
  readonly id: number;
  readonly rev: number;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly relations: readonly { readonly rel?: unknown; readonly url?: unknown }[];
}

type DistributiveOmit<T, Keys extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, Keys>> : never;
type AdoBoundInput = DistributiveOmit<AdoReadRequest, 'projectId' | 'connectorBindingId'>;

const SAFE_FIELDS = [
  'System.WorkItemType',
  'System.Title',
  'System.State',
  'System.Description',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
  'System.AreaPath',
  'System.IterationPath',
  'System.Parent',
  'System.Tags',
  'System.BoardColumn',
  'System.CreatedDate',
  'System.ChangedDate',
] as const;

export class AdoRequirementContextService {
  private readonly bindings: AdoRuntimeBindingProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly requestWindows = new Map<string, number[]>();

  public constructor(
    dataRootOrBindings: string | AdoRuntimeBindingProvider,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.bindings = typeof dataRootOrBindings === 'string'
      ? new FileAdoRuntimeBindingProvider(dataRootOrBindings)
      : dataRootOrBindings;
    this.fetchImpl = fetchImpl;
  }

  public async discovery(projectId: string, requestId: string): Promise<AdoDiscoveryResult> {
    const binding = await this.bindings.resolve(projectId);
    const rid = validRequestId(requestId);
    await this.verifyBoard(binding, childRequestId(rid, 'board'));
    const [scope, backlogs] = await Promise.all([
      this.readScope(binding, childRequestId(rid, 'scope')),
      this.readBacklogs(binding, childRequestId(rid, 'backlogs')),
    ]);
    return {
      identity: cloneIdentity(binding.identity),
      scope: scope.snapshot,
      backlogs,
      provenance: provenance(binding.identity, rid, 'discovery'),
    };
  }

  public async workItemRead(input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly workItemId: number;
    readonly includeComments: boolean;
    readonly includeLinks: boolean;
  }): Promise<AdoWorkItemResult> {
    const binding = await this.bindings.resolve(input.projectId);
    const rid = validRequestId(input.requestId);
    const scope = await this.readScope(binding, childRequestId(rid, 'scope'));
    const snapshot = await this.readWorkItem(binding, scope, input.workItemId, rid, input.includeComments, input.includeLinks);
    return {
      ...snapshot,
      provenance: {
        ...provenance(binding.identity, rid, 'workitem.read'),
        revision: snapshot.item.revision,
        changedDate: snapshot.item.changedDate,
      },
    };
  }

  public async hierarchyRead(input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly rootWorkItemId: number;
    readonly maxDepth: number;
    readonly maxItems: number;
  }): Promise<AdoHierarchyResult> {
    const binding = await this.bindings.resolve(input.projectId);
    const rid = validRequestId(input.requestId);
    const rootId = positiveId(input.rootWorkItemId);
    if (!Number.isSafeInteger(input.maxDepth) || input.maxDepth < 0 || input.maxDepth > 12) {
      throw new RuntimeError('INVALID_REQUEST', 'ADO hierarchy maxDepth must be from 0 through 12');
    }
    if (!Number.isSafeInteger(input.maxItems) || input.maxItems < 1 || input.maxItems > 200) {
      throw new RuntimeError('INVALID_REQUEST', 'ADO hierarchy maxItems must be from 1 through 200');
    }
    const scope = await this.readScope(binding, childRequestId(rid, 'scope'));
    const pending: Array<{ id: number; depth: number }> = [{ id: rootId, depth: 0 }];
    const seen = new Set<number>();
    const nodes: AdoHierarchyResult['nodes'][number][] = [];
    while (pending.length > 0) {
      const current = pending.shift()!;
      if (seen.has(current.id)) continue;
      if (seen.size >= input.maxItems) throw new RuntimeError('CAPABILITY_DENIED', 'ADO hierarchy exceeds the bounded item limit');
      seen.add(current.id);
      const snapshot = await this.readWorkItem(
        binding,
        scope,
        current.id,
        childRequestId(rid, `item-${current.id}`),
        false,
        true,
      );
      const childIds = snapshot.relations
        .filter((relation) => relation.relation === 'System.LinkTypes.Hierarchy-Forward')
        .map((relation) => relation.targetWorkItemId);
      nodes.push({ depth: current.depth, item: snapshot.item, childIds });
      if (current.depth < input.maxDepth) {
        for (const childId of childIds) if (!seen.has(childId)) pending.push({ id: childId, depth: current.depth + 1 });
      }
    }
    return {
      rootWorkItemId: rootId,
      nodes,
      provenance: provenance(binding.identity, rid, 'hierarchy.read'),
    };
  }

  public async contextSearch(input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<AdoSearchResult> {
    const binding = await this.bindings.resolve(input.projectId);
    const rid = validRequestId(input.requestId);
    const query = boundedQuery(input.query);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new RuntimeError('INVALID_REQUEST', 'ADO context search limit must be from 1 through 50');
    }
    const scope = await this.readScope(binding, childRequestId(rid, 'scope'));
    const wiql = buildScopedWiql(binding.projectName, scope.snapshot, query);
    this.bind(binding, {
      operation: 'ado.work_items.query',
      requestId: childRequestId(rid, 'query'),
      identity: binding.identity,
      wiql,
      page: { index: 0, continuation: null, limit: input.limit },
    });
    const result = await this.requestJson(
      binding,
      'POST',
      `/${encodeURIComponent(binding.identity.project.id)}/_apis/wit/wiql`,
      { 'api-version': '7.1', '$top': String(input.limit) },
      { query: wiql },
    );
    const ids = parseWiqlIds(result.body).slice(0, input.limit);
    if (ids.length === 0) {
      return { query, items: [], provenance: provenance(binding.identity, rid, 'context.search') };
    }
    this.bind(binding, {
      operation: 'ado.work_items.batch',
      requestId: childRequestId(rid, 'batch'),
      identity: binding.identity,
      ids,
    });
    const batch = await this.requestJson(
      binding,
      'POST',
      `/${encodeURIComponent(binding.identity.project.id)}/_apis/wit/workitemsbatch`,
      { 'api-version': '7.1' },
      { ids, fields: [...SAFE_FIELDS], errorPolicy: 'Omit' },
    );
    const items = parseArrayResponse(batch.body).map(parseWorkItem).map((raw) => canonicalize(raw));
    if (items.length !== ids.length) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO batch response did not preserve the bounded requested work-item set');
    for (const item of items) assertAreaInScope(item, scope.snapshot);
    return {
      query,
      items,
      provenance: provenance(binding.identity, rid, 'context.search'),
    };
  }

  public async backlogList(input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly backlog: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<AdoBacklogListResult> {
    const binding = await this.bindings.resolve(input.projectId);
    const rid = validRequestId(input.requestId);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new RuntimeError('INVALID_REQUEST', 'ADO backlog list limit must be from 1 through 200');
    }
    const scope = await this.readScope(binding, childRequestId(rid, 'scope'));
    const backlogs = await this.readBacklogs(binding, childRequestId(rid, 'backlogs'));
    const selector = input.backlog.trim();
    if (selector.length === 0 || selector.length > 100 || /[\0\r\n]/.test(selector)) {
      throw new RuntimeError('INVALID_REQUEST', 'ADO backlog selector is invalid');
    }
    const matches = backlogs.filter((entry) => entry.id === selector || entry.name === selector);
    if (matches.length !== 1) throw new RuntimeError('CAPABILITY_DENIED', 'ADO backlog must resolve to exactly one provider-discovered backlog level');
    const backlog = matches[0]!;
    if (backlog.workItemTypes.length === 0) throw new RuntimeError('CAPABILITY_DENIED', 'ADO backlog has no provider-discovered work-item types');
    const afterId = parseBacklogCursor(input.cursor);
    const fetchLimit = input.limit + 1;
    const wiql = buildScopedBacklogWiql(binding.projectName, scope.snapshot, backlog.workItemTypes, afterId, fetchLimit);
    this.bind(binding, {
      operation: 'ado.work_items.query',
      requestId: childRequestId(rid, 'query'),
      identity: binding.identity,
      wiql,
      page: { index: 0, continuation: input.cursor ?? null, limit: fetchLimit },
    });
    const result = await this.requestJson(
      binding,
      'POST',
      `/${encodeURIComponent(binding.identity.project.id)}/_apis/wit/wiql`,
      { 'api-version': '7.1', '$top': String(fetchLimit) },
      { query: wiql },
    );
    const ids = parseWiqlIds(result.body);
    const hasMore = ids.length > input.limit;
    const pageIds = ids.slice(0, input.limit);
    let items: CanonicalWorkItem[] = [];
    if (pageIds.length > 0) {
      this.bind(binding, {
        operation: 'ado.work_items.batch',
        requestId: childRequestId(rid, 'batch'),
        identity: binding.identity,
        ids: pageIds,
      });
      const batch = await this.requestJson(
        binding,
        'POST',
        `/${encodeURIComponent(binding.identity.project.id)}/_apis/wit/workitemsbatch`,
        { 'api-version': '7.1' },
        { ids: pageIds, fields: [...SAFE_FIELDS], errorPolicy: 'Omit' },
      );
      items = parseArrayResponse(batch.body).map(parseWorkItem).map((raw) => canonicalize(raw));
      if (items.length !== pageIds.length) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO backlog batch response did not preserve the requested work-item set');
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.id !== pageIds[index]) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO backlog batch response changed deterministic Work Item order');
        assertAreaInScope(item, scope.snapshot);
        if (item.type === null || !backlog.workItemTypes.includes(item.type)) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO backlog item type changed outside provider-discovered backlog metadata');
      }
    }
    return {
      backlog: { id: backlog.id, name: backlog.name, type: backlog.type, workItemTypes: [...backlog.workItemTypes] },
      scope: scope.snapshot,
      items,
      page: {
        offset: afterId,
        limit: input.limit,
        nextCursor: hasMore ? backlogCursor(pageIds[pageIds.length - 1]!) : null,
        complete: !hasMore,
      },
      provenance: provenance(binding.identity, rid, 'backlog.list'),
    };
  }

  private async verifyBoard(binding: ResolvedAdoRuntimeBinding, requestId: string): Promise<void> {
    this.bind(binding, {
      operation: 'ado.board.read',
      requestId,
      identity: binding.identity,
    });
    const result = await this.requestJson(
      binding,
      'GET',
      `/${encodeURIComponent(binding.identity.project.id)}/${encodeURIComponent(binding.identity.team.id)}/_apis/work/boards/${encodeURIComponent(binding.identity.board.id)}`,
      { 'api-version': '7.1' },
    );
    const board = parseIdentity(result.body);
    if (board.id !== binding.identity.board.id) throw new RuntimeError('CAPABILITY_DENIED', 'ADO board response changed outside the exact configured binding');
  }

  private async readScope(binding: ResolvedAdoRuntimeBinding, requestId: string): Promise<RuntimeScope> {
    this.bind(binding, {
      operation: 'ado.scope.read',
      requestId,
      identity: binding.identity,
    });
    const result = await this.requestJson(
      binding,
      'GET',
      `/${encodeURIComponent(binding.identity.project.id)}/${encodeURIComponent(binding.identity.team.id)}/_apis/work/teamsettings/teamfieldvalues`,
      { 'api-version': '7.1' },
    );
    return { snapshot: parseScope(result.body, binding.projectName, binding.grant.policy.maxPageItems) };
  }

  private async readBacklogs(binding: ResolvedAdoRuntimeBinding, requestId: string): Promise<readonly Backlog[]> {
    this.bind(binding, {
      operation: 'ado.backlogs.list',
      requestId,
      identity: binding.identity,
      page: { index: 0, continuation: null, limit: binding.grant.policy.maxPageItems },
    });
    const result = await this.requestJson(
      binding,
      'GET',
      `/${encodeURIComponent(binding.identity.project.id)}/${encodeURIComponent(binding.identity.team.id)}/_apis/work/backlogs`,
      { 'api-version': '7.1' },
    );
    const backlogs = parseArrayResponse(result.body).map((entry) => parseBacklog(entry));
    return discoverBacklogs(backlogs, binding.grant.policy.maxPageItems);
  }

  private async readWorkItem(
    binding: ResolvedAdoRuntimeBinding,
    scope: RuntimeScope,
    workItemId: number,
    requestId: string,
    includeComments: boolean,
    includeLinks: boolean,
  ): Promise<AdoWorkItemSnapshot> {
    const id = positiveId(workItemId);
    const authorizedIds = await this.scopedWorkItemIds(
      binding,
      scope,
      [id],
      childRequestId(requestId, 'scope-membership'),
    );
    if (!authorizedIds.has(id)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'ADO work item is outside the exact configured team area-path scope');
    }
    this.bind(binding, {
      operation: 'ado.work_items.get',
      requestId: childRequestId(requestId, 'get'),
      identity: binding.identity,
      id,
    });
    if (includeLinks) {
      this.bind(binding, {
        operation: 'ado.links.list',
        requestId: childRequestId(requestId, 'links'),
        identity: binding.identity,
        id,
        page: { index: 0, continuation: null, limit: binding.grant.policy.maxPageItems },
      });
    }
    const result = await this.requestJson(
      binding,
      'GET',
      `/${encodeURIComponent(binding.identity.project.id)}/_apis/wit/workitems/${id}`,
      includeLinks
        ? {
            '$expand': 'Relations',
            'api-version': '7.1',
          }
        : {
            fields: SAFE_FIELDS.join(','),
            '$expand': 'None',
            'api-version': '7.1',
          },
    );
    const raw = parseWorkItem(result.body);
    if (raw.id !== id) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO returned a different work-item identity');
    const item = canonicalize(raw);
    assertAreaInScope(item, scope.snapshot);
    const rawRelations = includeLinks ? parseRelations(raw.relations) : [];
    const relations = rawRelations.length === 0
      ? []
      : await this.filterRelationTargetsInScope(
        binding,
        scope,
        rawRelations,
        childRequestId(requestId, 'relation-targets'),
      );
    const comments = includeComments ? await this.readComments(binding, id, childRequestId(requestId, 'comments')) : [];
    return { item, relations, comments };
  }

  private async filterRelationTargetsInScope(
    binding: ResolvedAdoRuntimeBinding,
    scope: RuntimeScope,
    relations: readonly { readonly relation: string; readonly targetWorkItemId: number }[],
    requestId: string,
  ): Promise<readonly { readonly relation: string; readonly targetWorkItemId: number }[]> {
    const ids = [...new Set(relations.map((relation) => relation.targetWorkItemId))];
    if (ids.length === 0) return [];
    const allowed = await this.scopedWorkItemIds(binding, scope, ids, requestId);
    return relations.filter((relation) => allowed.has(relation.targetWorkItemId));
  }

  private async scopedWorkItemIds(
    binding: ResolvedAdoRuntimeBinding,
    scope: RuntimeScope,
    ids: readonly number[],
    requestId: string,
  ): Promise<ReadonlySet<number>> {
    const uniqueIds = [...new Set(ids.map(positiveId))];
    if (uniqueIds.length === 0) return new Set<number>();
    const policy = binding.grant.policy;
    const maxTotal = policy.maxPageItems * policy.maxPages;
    if (!Number.isSafeInteger(maxTotal) || uniqueIds.length > maxTotal) {
      throw new RuntimeError('CAPABILITY_DENIED', 'ADO scoped membership proof exceeds the configured bounded result limit');
    }
    const chunkSize = Math.min(policy.maxPageItems, policy.maxBatchItems, 200);
    const allowed = new Set<number>();
    for (let offset = 0, chunkIndex = 0; offset < uniqueIds.length; offset += chunkSize, chunkIndex += 1) {
      const chunk = uniqueIds.slice(offset, offset + chunkSize);
      const wiql = buildScopedIdWiql(binding.projectName, scope.snapshot, chunk);
      this.bind(binding, {
        operation: 'ado.work_items.query',
        requestId: childRequestId(requestId, `chunk-${chunkIndex}`),
        identity: binding.identity,
        wiql,
        page: { index: 0, continuation: null, limit: chunk.length },
      });
      const result = await this.requestJson(
        binding,
        'POST',
        `/${encodeURIComponent(binding.identity.project.id)}/_apis/wit/wiql`,
        { 'api-version': '7.1', '$top': String(chunk.length) },
        { query: wiql },
      );
      for (const id of parseWiqlIds(result.body)) {
        if (chunk.includes(id)) allowed.add(id);
      }
    }
    return allowed;
  }

  private async readComments(
    binding: ResolvedAdoRuntimeBinding,
    workItemId: number,
    requestId: string,
  ): Promise<readonly { readonly id: string; readonly text: string }[]> {
    const comments: { id: string; text: string }[] = [];
    let continuation: string | null = null;
    for (let index = 0; index < binding.grant.policy.maxPages; index += 1) {
      const page = {
        index,
        continuation,
        limit: Math.min(200, binding.grant.policy.maxPageItems),
      };
      this.bind(binding, {
        operation: 'ado.comments.list',
        requestId: childRequestId(requestId, `page-${index}`),
        identity: binding.identity,
        id: workItemId,
        page,
      });
      const query: Record<string, string> = {
        '$top': String(page.limit),
        'api-version': '7.1-preview.4',
      };
      if (continuation !== null) query.continuationToken = continuation;
      const result = await this.requestJson(
        binding,
        'GET',
        `/${encodeURIComponent(binding.identity.project.id)}/_apis/wit/workItems/${workItemId}/comments`,
        query,
      );
      for (const raw of parseCommentResponse(result.body)) {
        if (!isRecord(raw) || typeof raw.text !== 'string') throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO comment response is invalid');
        const commentId = raw.id ?? raw.commentId;
        if (!Number.isSafeInteger(commentId) && typeof commentId !== 'string') throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO comment identity is invalid');
        comments.push({ id: String(commentId), text: sanitizeText(normalizeHtml(raw.text).text) });
        if (comments.length > binding.grant.policy.maxPageItems * binding.grant.policy.maxPages) {
          throw new RuntimeError('CAPABILITY_DENIED', 'ADO comments exceed the configured bounded result limit');
        }
      }
      continuation = result.continuation;
      if (continuation === null) return comments;
    }
    throw new RuntimeError('CAPABILITY_DENIED', 'ADO comments exceeded the configured page bound');
  }

  private bind(
    binding: ResolvedAdoRuntimeBinding,
    input: AdoBoundInput,
  ): void {
    bindAdoRead(binding.grant, {
      ...input,
      projectId: binding.grant.projectId,
      connectorBindingId: binding.grant.connectorBindingId,
    } as AdoReadRequest, Date.now());
  }

  private consumeRateLimit(binding: ResolvedAdoRuntimeBinding): void {
    const key = [
      binding.grant.projectId,
      binding.grant.connectorBindingId,
      binding.grant.credentialRef,
    ].join('\0');
    const now = Date.now();
    const { requests, windowMs } = binding.grant.policy.rateLimit;
    const floor = now - windowMs;
    const active = (this.requestWindows.get(key) ?? []).filter((timestamp) => timestamp > floor);
    if (active.length >= requests) {
      const retryAfterMs = Math.max(1, active[0]! + windowMs - now);
      this.requestWindows.set(key, active);
      throw new RuntimeError(
        'LOCAL_RATE_LIMITED',
        'ADO local read rate limit exceeded; no automatic retry was performed',
        {
          publicDetails: {
            retryAfterMs,
            limit: requests,
            remaining: 0,
            windowMs,
          },
        },
      );
    }
    active.push(now);
    this.requestWindows.set(key, active);
  }

  private async requestJson(
    binding: ResolvedAdoRuntimeBinding,
    method: 'GET' | 'POST',
    pathname: string,
    query: Readonly<Record<string, string>>,
    body?: unknown,
  ): Promise<HttpResult> {
    const org = encodeURIComponent(binding.organizationName);
    const url = new URL(`https://dev.azure.com/${org}${pathname}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    if (url.protocol !== 'https:' || url.hostname !== 'dev.azure.com' || !url.pathname.startsWith(`/${org}/`)) {
      throw new RuntimeError('CAPABILITY_DENIED', 'ADO request escaped the exact configured organization host boundary');
    }
    this.consumeRateLimit(binding);
    const authorization = binding.auth.kind === 'PAT'
      ? 'Basic ' + Buffer.from(':' + binding.auth.secret, 'utf8').toString('base64')
      : 'Bearer ' + binding.auth.secret;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(binding.grant.policy.timeoutMs),
      });
    } catch {
      throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO read transport failed without exposing upstream credential or transport detail');
    }
    if (response.status === 401 || response.status === 403) {
      throw new RuntimeError('CREDENTIAL_INVALID', 'ADO rejected the protected read credential');
    }
    if (response.status === 404) throw new RuntimeError('PRECONDITION_FAILED', 'ADO resource was not found within the configured binding');
    if (response.status === 429) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO rate limited the bounded read request');
    if (!response.ok) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO returned a non-success response to the bounded read request');
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > binding.grant.policy.maxResponseBytes) {
      throw new RuntimeError('CAPABILITY_DENIED', 'ADO response exceeds the configured byte bound');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > binding.grant.policy.maxResponseBytes) {
      throw new RuntimeError('CAPABILITY_DENIED', 'ADO response exceeds the configured byte bound');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch {
      throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO response was not valid bounded JSON');
    }
    const continuation = response.headers.get('x-ms-continuationtoken')
      ?? (isRecord(parsed) && typeof parsed.continuationToken === 'string' ? parsed.continuationToken : null);
    return { body: parsed, continuation };
  }
}

function provenance(
  identity: BoardIdentity,
  requestId: string,
  operation: AdoContextProvenance['operation'],
): AdoContextProvenance {
  return {
    acquisitionId: randomUUID(),
    requestId,
    provider: 'azure-devops',
    operation,
    organizationId: identity.organization.id,
    projectId: identity.project.id,
    teamId: identity.team.id,
    boardId: identity.board.id,
    acquiredAt: new Date().toISOString(),
  };
}

function canonicalize(raw: RawWorkItem): CanonicalWorkItem {
  const fields: Record<string, string | number | boolean | null> = {};
  for (const name of SAFE_FIELDS) {
    const value = raw.fields[name];
    if (value === undefined || value === null) fields[name] = null;
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') fields[name] = value;
    else fields[name] = null;
  }
  return stageRawSource(JSON.stringify({ id: raw.id, rev: raw.rev, fields })).canonical;
}

function parseWorkItem(value: unknown): RawWorkItem {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.id) || Number(value.id) < 1
    || !Number.isSafeInteger(value.rev) || Number(value.rev) < 1
    || !isRecord(value.fields)
    || (value.relations !== undefined && !Array.isArray(value.relations))) {
    throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO work-item response is invalid');
  }
  return {
    id: Number(value.id),
    rev: Number(value.rev),
    fields: value.fields,
    relations: (value.relations ?? []) as RawWorkItem['relations'],
  };
}

function parseScope(value: unknown, projectName: string, maxEntries: number): AdoScopeSnapshot {
  if (!isRecord(value)
    || !isRecord(value.field)
    || value.field.referenceName !== 'System.AreaPath'
    || typeof value.defaultValue !== 'string'
    || !Array.isArray(value.values)
    || value.values.length === 0
    || value.values.length > maxEntries) {
    throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO team scope response is invalid');
  }
  const seen = new Set<string>();
  const values = value.values.map((entry) => {
    if (!isRecord(entry) || typeof entry.value !== 'string' || typeof entry.includeChildren !== 'boolean') {
      throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO team scope entry is invalid');
    }
    if (entry.value !== projectName && !entry.value.startsWith(projectName + '\\')) {
      throw new RuntimeError('CAPABILITY_DENIED', 'ADO team scope escaped the configured project area-path root');
    }
    if (seen.has(entry.value)) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO team scope contains duplicate area paths');
    seen.add(entry.value);
    return { value: entry.value, includeChildren: entry.includeChildren };
  });
  if (!seen.has(value.defaultValue)) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO default area path is outside the configured team scope');
  return { field: 'System.AreaPath', defaultValue: value.defaultValue, values };
}

function parseBacklog(value: unknown): Backlog {
  if (!isRecord(value)
    || typeof value.id !== 'string' || value.id.length === 0
    || typeof value.name !== 'string' || value.name.length === 0
    || !Number.isSafeInteger(value.rank) || Number(value.rank) < 0
    || !['portfolio', 'requirement', 'task'].includes(String(value.type))
    || !Array.isArray(value.workItemTypes)) {
    throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO backlog response is invalid');
  }
  const workItemTypes = value.workItemTypes.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO backlog work-item type is invalid');
    }
    return entry.name;
  });
  return {
    id: value.id,
    name: value.name,
    rank: Number(value.rank),
    type: value.type as Backlog['type'],
    workItemTypes,
  };
}

function parseRelations(relations: RawWorkItem['relations']): readonly { readonly relation: string; readonly targetWorkItemId: number }[] {
  const result: { relation: string; targetWorkItemId: number }[] = [];
  const seen = new Set<string>();
  for (const relation of relations) {
    if (typeof relation.rel !== 'string' || typeof relation.url !== 'string') continue;
    const id = relationTargetId(relation.url);
    if (id === null) continue;
    const key = `${relation.rel}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ relation: relation.rel, targetWorkItemId: id });
  }
  return result;
}

function relationTargetId(value: string): number | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'dev.azure.com') return null;
    const match = /\/workItems\/(\d+)$/i.exec(url.pathname);
    if (match === null) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function assertAreaInScope(item: CanonicalWorkItem, scope: AdoScopeSnapshot): void {
  const areaPath = item.areaPath;
  if (areaPath === null || !scope.values.some((entry) =>
    areaPath === entry.value || (entry.includeChildren && areaPath.startsWith(entry.value + '\\')))) {
    throw new RuntimeError('CAPABILITY_DENIED', 'ADO work item is outside the exact configured team area-path scope');
  }
}

function buildScopedWiql(projectName: string, scope: AdoScopeSnapshot, query: string): string {
  const project = wiqlLiteral(projectName);
  const term = wiqlLiteral(query);
  const areas = scopedAreaClauses(scope);
  return [
    'SELECT [System.Id] FROM WorkItems',
    `WHERE [System.TeamProject] = '${project}'`,
    `AND (${areas.join(' OR ')})`,
    `AND ([System.Title] CONTAINS '${term}' OR [System.Description] CONTAINS '${term}' OR [Microsoft.VSTS.Common.AcceptanceCriteria] CONTAINS '${term}')`,
    'ORDER BY [System.ChangedDate] DESC',
  ].join(' ');
}

function buildScopedBacklogWiql(
  projectName: string,
  scope: AdoScopeSnapshot,
  workItemTypes: readonly string[],
  afterId: number,
  fetchLimit: number,
): string {
  if (workItemTypes.length === 0 || workItemTypes.length > 50) throw new RuntimeError('CAPABILITY_DENIED', 'ADO backlog work-item type set is invalid');
  if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(fetchLimit) || fetchLimit < 1 || fetchLimit > 201) {
    throw new RuntimeError('INVALID_REQUEST', 'ADO backlog pagination is invalid');
  }
  const project = wiqlLiteral(projectName);
  const areas = scopedAreaClauses(scope);
  const types = workItemTypes.map((value) => `'${wiqlLiteral(value)}'`).join(',');
  return [
    'SELECT [System.Id] FROM WorkItems',
    `WHERE [System.TeamProject] = '${project}'`,
    `AND (${areas.join(' OR ')})`,
    `AND [System.WorkItemType] IN (${types})`,
    ...(afterId === 0 ? [] : [`AND [System.Id] > ${afterId}`]),
    'ORDER BY [System.Id] ASC',
  ].join(' ');
}

function parseBacklogCursor(value: string | null): number {
  if (value === null) return 0;
  const match = /^offset:(0|[1-9]\d*)$/.exec(value);
  if (match === null) throw new RuntimeError('INVALID_REQUEST', 'ADO backlog cursor is invalid');
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RuntimeError('INVALID_REQUEST', 'ADO backlog cursor is invalid');
  return offset;
}

function backlogCursor(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 1) throw new RuntimeError('INVALID_REQUEST', 'ADO backlog cursor offset is invalid');
  return `offset:${offset}`;
}

function buildScopedIdWiql(projectName: string, scope: AdoScopeSnapshot, ids: readonly number[]): string {
  if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new RuntimeError('INVALID_REQUEST', 'ADO scoped membership proof requires positive Work Item IDs');
  }
  const project = wiqlLiteral(projectName);
  const areas = scopedAreaClauses(scope);
  return [
    'SELECT [System.Id] FROM WorkItems',
    `WHERE [System.TeamProject] = '${project}'`,
    `AND (${areas.join(' OR ')})`,
    `AND [System.Id] IN (${ids.join(',')})`,
  ].join(' ');
}

function scopedAreaClauses(scope: AdoScopeSnapshot): readonly string[] {
  const areas = scope.values.map((entry) =>
    `[System.AreaPath] ${entry.includeChildren ? 'UNDER' : '='} '${wiqlLiteral(entry.value)}'`);
  if (areas.length === 0) throw new RuntimeError('CAPABILITY_DENIED', 'ADO context access requires a non-empty configured team scope');
  return areas;
}

function wiqlLiteral(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\0\r\n]/.test(value)) {
    throw new RuntimeError('INVALID_REQUEST', 'ADO query contains invalid text');
  }
  return value.replaceAll("'", "''");
}

function boundedQuery(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200 || /[\0\r\n]/.test(normalized)) {
    throw new RuntimeError('INVALID_REQUEST', 'ADO context query must be from 1 through 200 characters');
  }
  return normalized;
}

function validRequestId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value)) throw new RuntimeError('INVALID_REQUEST', 'ADO requestId is invalid');
  return value;
}

function childRequestId(parent: string, suffix: string): string {
  const normalized = `${parent}:${suffix}`;
  if (normalized.length <= 200) return normalized;
  return parent.slice(0, Math.max(1, 199 - suffix.length)) + ':' + suffix;
}

function positiveId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RuntimeError('INVALID_REQUEST', 'ADO work-item ID must be a positive safe integer');
  return value;
}

function parseIdentity(value: unknown): { readonly id: string; readonly name: string } {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || typeof value.name !== 'string' || value.name.length === 0) {
    throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO identity response is invalid');
  }
  return { id: value.id, name: value.name };
}

function parseArrayResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.value)) return value.value;
  throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO collection response is invalid');
}

function parseCommentResponse(value: unknown): unknown[] {
  if (isRecord(value) && Array.isArray(value.comments)) return value.comments;
  return parseArrayResponse(value);
}

function parseWiqlIds(value: unknown): number[] {
  if (!isRecord(value) || !Array.isArray(value.workItems)) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO WIQL response is invalid');
  const ids = value.workItems.map((item) => {
    if (!isRecord(item) || !Number.isSafeInteger(item.id) || Number(item.id) < 1) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'ADO WIQL result identity is invalid');
    return Number(item.id);
  });
  return [...new Set(ids)];
}

function cloneIdentity(identity: BoardIdentity): BoardIdentity {
  return {
    organization: { ...identity.organization },
    project: { ...identity.project },
    team: { ...identity.team },
    board: { ...identity.board },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
