import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeText, stageRawSource } from '@iris/ado';
import { writePrivateJsonAtomic } from '../credentials.js';
import { privateDirectoryProblem } from '../private-fs.js';

export interface AdoLiveAcceptanceTarget {
  readonly organization: string;
  readonly project: string;
  readonly teamName: string;
  readonly level1WorkItemId: number;
  readonly storyWorkItemId: number;
}

export interface AdoLiveAcceptanceOptions {
  readonly maxItems: number;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
}

export interface AdoLiveLedgerEntry {
  readonly operation: string;
  readonly method: 'GET';
  readonly status: number;
  readonly objectCount: number;
}

export interface AdoLiveSanitizedItem {
  readonly id: number;
  readonly revision: number;
  readonly type: string | null;
  readonly title: string | null;
  readonly state: string | null;
  readonly description: string | null;
  readonly acceptanceCriteria: string | null;
  readonly areaPath: string | null;
  readonly iterationPath: string | null;
  readonly parent: number | null;
  readonly changedDate: string;
  readonly backlogIds: readonly string[];
  readonly comments: readonly { readonly id: string; readonly text: string }[];
  readonly relations: readonly { readonly relation: string; readonly targetWorkItemId: number }[];
}

export interface AdoLiveAcceptanceSnapshot {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly targetDigest: string;
  readonly organization: string;
  readonly project: { readonly id: string; readonly name: string };
  readonly team: { readonly id: string; readonly name: string };
  readonly board: { readonly id: string; readonly name: string };
  readonly scope: {
    readonly field: string;
    readonly defaultValue: string;
    readonly values: readonly { readonly value: string; readonly includeChildren: boolean }[];
  };
  readonly backlogLevels: readonly {
    readonly id: string;
    readonly name: string;
    readonly rank: number;
    readonly type: 'portfolio' | 'requirement' | 'task';
    readonly workItemTypes: readonly string[];
    readonly hidden: boolean;
  }[];
  readonly levels: {
    readonly level1: { readonly itemId: number; readonly revision: number; readonly commentCount: number };
    readonly level2: { readonly featureRootId: number; readonly itemCount: number };
    readonly level3: { readonly backlogId: string; readonly backlogName: string; readonly itemCount: number };
    readonly level4: { readonly uniqueItemCount: number; readonly commentCount: number; readonly relationCount: number };
  };
  readonly items: readonly AdoLiveSanitizedItem[];
  readonly revisionStable: boolean;
  readonly zeroMutation: boolean;
  readonly ledger: readonly AdoLiveLedgerEntry[];
}

export interface AdoLiveAcceptanceReceipt {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly targetDigest: string;
  readonly projectDigest: string;
  readonly teamDigest: string;
  readonly boardDigest: string;
  readonly level1: { readonly itemCount: 1; readonly commentCount: number; readonly revisionStable: boolean };
  readonly level2: { readonly itemCount: number };
  readonly level3: { readonly itemCount: number };
  readonly level4: { readonly itemCount: number; readonly commentCount: number; readonly relationCount: number };
  readonly requestCount: number;
  readonly areaPathMismatchCount: number;
  readonly zeroMutation: true;
  readonly revisionStable: boolean;
}

export class AdoLiveAcceptanceError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'AUTH_FAILED' | 'NOT_FOUND' | 'AMBIGUOUS_TARGET'
    | 'SCOPE_MISMATCH' | 'LIMIT_EXCEEDED' | 'UPSTREAM_FAILURE' | 'REVISION_CHANGED') {
    super(code);
  }
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly continuation: string | null;
}

interface RawWorkItem {
  readonly id: number;
  readonly rev: number;
  readonly fields: Record<string, unknown>;
  readonly relations: readonly { readonly rel?: unknown; readonly url?: unknown }[];
}

interface TeamRef { readonly id: string; readonly name: string }
interface BoardRef { readonly id: string; readonly name: string }

const defaultOptions: AdoLiveAcceptanceOptions = {
  maxItems: 5000,
  maxResponseBytes: 16 * 1024 * 1024,
  timeoutMs: 15000,
};

export async function runAdoLiveReadAcceptance(
  target: AdoLiveAcceptanceTarget,
  pat: string,
  options: Partial<AdoLiveAcceptanceOptions> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly snapshot: AdoLiveAcceptanceSnapshot; readonly receipt: AdoLiveAcceptanceReceipt }> {
  validateTarget(target);
  validatePat(pat);
  const limits = { ...defaultOptions, ...options };
  validateOptions(limits);

  const ledger: AdoLiveLedgerEntry[] = [];
  const authorization = 'Basic ' + Buffer.from(':' + pat, 'utf8').toString('base64');
  const org = encodeURIComponent(target.organization);

  const request = async (
    operation: string,
    pathname: string,
    query: Readonly<Record<string, string>>,
  ): Promise<HttpResult> => {
    const url = new URL('https://dev.azure.com/' + org + pathname);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    if (url.protocol !== 'https:' || url.hostname !== 'dev.azure.com' || !url.pathname.startsWith('/' + org + '/')) {
      throw new AdoLiveAcceptanceError('INVALID_INPUT');
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization },
        redirect: 'error',
        signal: AbortSignal.timeout(limits.timeoutMs),
      });
    } catch {
      throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
    }
    if (response.status === 401 || response.status === 403) throw new AdoLiveAcceptanceError('AUTH_FAILED');
    if (response.status === 404) throw new AdoLiveAcceptanceError('NOT_FOUND');
    if (!response.ok) throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');

    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > limits.maxResponseBytes) throw new AdoLiveAcceptanceError('LIMIT_EXCEEDED');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limits.maxResponseBytes) throw new AdoLiveAcceptanceError('LIMIT_EXCEEDED');

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
    }
    ledger.push({ operation, method: 'GET', status: response.status, objectCount: inferObjectCount(body) });

    const continuation = response.headers.get('x-ms-continuationtoken')
      ?? (isRecord(body) && typeof body.continuationToken === 'string' ? body.continuationToken : null);
    return { status: response.status, body, continuation };
  };

  const projectResponse = await request(
    'project.get',
    '/_apis/projects/' + encodeURIComponent(target.project),
    { 'api-version': '7.1' },
  );
  const project = parseIdentity(projectResponse.body);

  const teams = await listTeams(request, project.id);
  const teamMatches = teams.filter(team => team.name === target.teamName);
  if (teamMatches.length === 0) throw new AdoLiveAcceptanceError('NOT_FOUND');
  if (teamMatches.length !== 1) throw new AdoLiveAcceptanceError('AMBIGUOUS_TARGET');
  const team = teamMatches[0]!;
  const boards = await listBoards(request, project.id, team.id);
  if (boards.length === 0) throw new AdoLiveAcceptanceError('NOT_FOUND');

  const teamField = parseTeamField((await request(
    'scope.team_field_values',
    '/' + encodeURIComponent(project.id) + '/' + encodeURIComponent(team.id) + '/_apis/work/teamsettings/teamfieldvalues',
    { 'api-version': '7.1' },
  )).body);
  if (teamField.field.referenceName !== 'System.AreaPath') throw new AdoLiveAcceptanceError('SCOPE_MISMATCH');

  const backlogLevels = parseBacklogs((await request(
    'backlogs.list',
    '/' + encodeURIComponent(project.id) + '/' + encodeURIComponent(team.id) + '/_apis/work/backlogs',
    { 'api-version': '7.1' },
  )).body);
  if (backlogLevels.length === 0 || backlogLevels.length > 100) throw new AdoLiveAcceptanceError('LIMIT_EXCEEDED');

  const fullIds = new Set<number>();
  const membership = new Map<number, Set<string>>();
  for (const backlog of backlogLevels.filter(level => !level.hidden)) {
    const ids = await readBacklogIds(request, project.id, team.id, backlog.id, limits.maxItems);
    for (const id of ids) {
      fullIds.add(id);
      const memberships = membership.get(id) ?? new Set<string>();
      memberships.add(backlog.id);
      membership.set(id, memberships);
    }
    if (fullIds.size > limits.maxItems) throw new AdoLiveAcceptanceError('LIMIT_EXCEEDED');
  }

  if (!fullIds.has(target.level1WorkItemId) || !fullIds.has(target.storyWorkItemId)) {
    throw new AdoLiveAcceptanceError('SCOPE_MISMATCH');
  }

  const level1Before = parseWorkItem((await request(
    'level1.work_item',
    '/' + encodeURIComponent(project.id) + '/_apis/wit/workitems/' + target.level1WorkItemId,
    { '$expand': 'all', 'api-version': '7.1' },
  )).body);
  const level1Comments = await readAllComments(request, project.id, target.level1WorkItemId, limits.maxItems);

  const story = parseWorkItem((await request(
    'level2.story_anchor',
    '/' + encodeURIComponent(project.id) + '/_apis/wit/workitems/' + target.storyWorkItemId,
    { '$expand': 'all', 'api-version': '7.1' },
  )).body);

  const featureRoot = await findFeatureAncestor(request, project.id, story, limits.maxItems, fullIds);
  const subtreeIds = await collectSubtree(request, project.id, featureRoot, limits.maxItems, fullIds);

  const storyType = textField(story.fields['System.WorkItemType']);
  const matchingRequirement = backlogLevels.filter(level =>
    level.type === 'requirement' && level.workItemTypes.includes(storyType));
  if (matchingRequirement.length !== 1) throw new AdoLiveAcceptanceError('AMBIGUOUS_TARGET');
  const requirementBacklog = matchingRequirement[0]!;
  const requirementBoards = boards.filter(board => board.name === requirementBacklog.name);
  if (requirementBoards.length !== 1) throw new AdoLiveAcceptanceError('AMBIGUOUS_TARGET');
  const canonicalBoard = requirementBoards[0]!;
  const level3Ids = await readBacklogIds(request, project.id, team.id, requirementBacklog.id, limits.maxItems);

  const firstPass = await readWorkItems(request, project.id, [...fullIds], limits.maxItems);
  const areaPathMismatchCount = firstPass.filter(workItem => !isInConfiguredArea(workItem, teamField)).length;

  const comments = new Map<number, readonly { readonly id: string; readonly text: string }[]>();
  for (const workItem of firstPass) {
    comments.set(workItem.id, await readAllComments(request, project.id, workItem.id, limits.maxItems));
  }

  const secondPass = await readWorkItems(request, project.id, [...fullIds], limits.maxItems);
  const revisions = new Map(firstPass.map(workItem => [workItem.id, workItem.rev]));
  const fullStable = secondPass.length === firstPass.length
    && secondPass.every(workItem => revisions.get(workItem.id) === workItem.rev);

  const level1After = parseWorkItem((await request(
    'level1.revision_recheck',
    '/' + encodeURIComponent(project.id) + '/_apis/wit/workitems/' + target.level1WorkItemId,
    { 'api-version': '7.1' },
  )).body);
  const level1Stable = level1After.rev === level1Before.rev;
  if (!fullStable || !level1Stable) throw new AdoLiveAcceptanceError('REVISION_CHANGED');

  const sanitizedItems = firstPass.map(workItem =>
    sanitizeLiveItem(workItem, [...(membership.get(workItem.id) ?? new Set<string>())], comments.get(workItem.id) ?? []));
  const relationCount = sanitizedItems.reduce((sum, workItem) => sum + workItem.relations.length, 0);
  const commentCount = sanitizedItems.reduce((sum, workItem) => sum + workItem.comments.length, 0);
  const observedAt = new Date().toISOString();
  const targetDigest = digest([
    target.organization,
    project.id,
    team.id,
    canonicalBoard.id,
    boards.map(board => [board.id, board.name]).sort(),
  ]);

  const snapshot: AdoLiveAcceptanceSnapshot = {
    schemaVersion: 1,
    observedAt,
    targetDigest,
    organization: target.organization,
    project,
    team,
    board: canonicalBoard,
    scope: {
      field: teamField.field.referenceName,
      defaultValue: teamField.defaultValue,
      values: teamField.values,
    },
    backlogLevels,
    levels: {
      level1: { itemId: level1Before.id, revision: level1Before.rev, commentCount: level1Comments.length },
      level2: { featureRootId: featureRoot.id, itemCount: subtreeIds.size },
      level3: { backlogId: requirementBacklog.id, backlogName: requirementBacklog.name, itemCount: level3Ids.size },
      level4: { uniqueItemCount: fullIds.size, commentCount, relationCount },
    },
    items: sanitizedItems,
    revisionStable: true,
    zeroMutation: true,
    ledger,
  };

  const receipt: AdoLiveAcceptanceReceipt = {
    schemaVersion: 1,
    observedAt,
    targetDigest,
    projectDigest: digest([project.id, project.name]),
    teamDigest: digest([team.id, team.name]),
    boardDigest: digest([canonicalBoard.id, canonicalBoard.name]),
    level1: { itemCount: 1, commentCount: level1Comments.length, revisionStable: true },
    level2: { itemCount: subtreeIds.size },
    level3: { itemCount: level3Ids.size },
    level4: { itemCount: fullIds.size, commentCount, relationCount },
    requestCount: ledger.length,
    areaPathMismatchCount,
    zeroMutation: true,
    revisionStable: true,
  };
  return { snapshot, receipt };
}

export async function persistAdoLiveAcceptance(
  dataRoot: string,
  result: { readonly snapshot: AdoLiveAcceptanceSnapshot; readonly receipt: AdoLiveAcceptanceReceipt },
): Promise<{ readonly snapshotPath: string; readonly receiptPath: string }> {
  if (!path.isAbsolute(dataRoot) || path.resolve(dataRoot) !== dataRoot) throw new AdoLiveAcceptanceError('INVALID_INPUT');
  const directory = path.join(dataRoot, 'ado-acceptance');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const problem = await privateDirectoryProblem(directory, 'ADO acceptance directory');
  if (problem !== null) throw new AdoLiveAcceptanceError('INVALID_INPUT');

  const stamp = result.receipt.observedAt.replace(/[:.]/g, '-');
  const snapshotPath = path.join(directory, 'live-' + stamp + '.snapshot.json');
  const receiptPath = path.join(directory, 'live-' + stamp + '.receipt.json');
  await writePrivateJsonAtomic(snapshotPath, result.snapshot);
  await writePrivateJsonAtomic(receiptPath, result.receipt);
  return { snapshotPath, receiptPath };
}

export async function readPatFromStdin(): Promise<string> {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 4096) throw new AdoLiveAcceptanceError('INVALID_INPUT');
  }
  return value.trim();
}

function validateTarget(target: AdoLiveAcceptanceTarget): void {
  for (const value of [target.organization, target.project, target.teamName]) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200 || /[\0\r\n]/.test(value)) {
      throw new AdoLiveAcceptanceError('INVALID_INPUT');
    }
  }
  for (const id of [target.level1WorkItemId, target.storyWorkItemId]) {
    if (!Number.isSafeInteger(id) || id < 1) throw new AdoLiveAcceptanceError('INVALID_INPUT');
  }
}

function validatePat(pat: string): void {
  if (typeof pat !== 'string' || pat.length < 20 || pat.length > 1024 || /[\0\r\n\s]/.test(pat)) {
    throw new AdoLiveAcceptanceError('INVALID_INPUT');
  }
}

function validateOptions(options: AdoLiveAcceptanceOptions): void {
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1 || options.maxItems > 20000
    || !Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1024
    || options.maxResponseBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 120000) {
    throw new AdoLiveAcceptanceError('INVALID_INPUT');
  }
}

async function listTeams(
  request: (operation: string, pathname: string, query: Readonly<Record<string, string>>) => Promise<HttpResult>,
  projectId: string,
): Promise<TeamRef[]> {
  const teams: TeamRef[] = [];
  for (let skip = 0; skip < 10000; skip += 100) {
    const result = await request(
      'teams.list',
      '/_apis/projects/' + encodeURIComponent(projectId) + '/teams',
      { '$top': '100', '$skip': String(skip), 'api-version': '7.1' },
    );
    const values = parseArrayResponse(result.body).map(parseIdentity);
    teams.push(...values);
    if (values.length < 100) break;
  }
  if (teams.length === 0 || teams.length > 10000) throw new AdoLiveAcceptanceError('LIMIT_EXCEEDED');
  return uniqueIdentity(teams);
}

async function listBoards(
  request: (operation: string, pathname: string, query: Readonly<Record<string, string>>) => Promise<HttpResult>,
  projectId: string,
  teamId: string,
): Promise<BoardRef[]> {
  const result = await request(
    'boards.list',
    '/' + encodeURIComponent(projectId) + '/' + encodeURIComponent(teamId) + '/_apis/work/boards',
    { 'api-version': '7.1' },
  );
  return uniqueIdentity(parseArrayResponse(result.body).map(parseIdentity));
}

async function readAllComments(
  request: (operation: string, pathname: string, query: Readonly<Record<string, string>>) => Promise<HttpResult>,
  projectId: string,
  workItemId: number,
  maxItems: number,
): Promise<readonly { readonly id: string; readonly text: string }[]> {
  const comments: { id: string; text: string }[] = [];
  let continuation: string | null = null;
  const used = new Set<string>();
  do {
    const query: Record<string, string> = { '$top': '200', 'api-version': '7.1-preview.4' };
    if (continuation !== null) query.continuationToken = continuation;
    const result = await request(
      'comments.list',
      '/' + encodeURIComponent(projectId) + '/_apis/wit/workItems/' + workItemId + '/comments',
      query,
    );
    for (const raw of parseCommentResponse(result.body)) {
      if (!isRecord(raw) || typeof raw.text !== 'string') {
        throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
      }
      const commentId = raw.id ?? raw.commentId;
      if (!Number.isSafeInteger(commentId) && typeof commentId !== 'string') {
        throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
      }
      comments.push({ id: String(commentId), text: sanitizeText(raw.text) });
      if (comments.length > maxItems) throw new AdoLiveAcceptanceError('LIMIT_EXCEEDED');
    }
    continuation = result.continuation;
    if (continuation !== null) {
      if (used.has(continuation) || continuation.length > 2048) throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
      used.add(continuation);
    }
  } while (continuation !== null);
  return comments;
}

async function findFeatureAncestor(
  request: (operation: string, pathname: string, query: Readonly<Record<string, string>>) => Promise<HttpResult>,
  projectId: string,
  start: RawWorkItem,
  maxItems: number,
  authorizedIds: ReadonlySet<number>,
): Promise<RawWorkItem> {
  let current = start;
  const seen = new Set<number>();
  for (let depth = 0; depth < Math.min(maxItems, 50); depth += 1) {
    if (textField(current.fields['System.WorkItemType']) === 'Feature') return current;
    if (seen.has(current.id)) throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
    seen.add(current.id);
    const parentIds = relationTargets(current, 'System.LinkTypes.Hierarchy-Reverse');
    if (parentIds.length !== 1) throw new AdoLiveAcceptanceError('NOT_FOUND');
    const parentId = parentIds[0]!;
    if (!authorizedIds.has(parentId)) throw new AdoLiveAcceptanceError('SCOPE_MISMATCH');
    current = parseWorkItem((await request(
      'level2.parent',
      '/' + encodeURIComponent(projectId) + '/_apis/wit/workitems/' + parentId,
      { '$expand': 'relations', 'api-version': '7.1' },
    )).body);
  }
  throw new AdoLiveAcceptanceError('LIMIT_EXCEEDED');
}

async function collectSubtree(
  request: (operation: string, pathname: string, query: Readonly<Record<string, string>>) => Promise<HttpResult>,
  projectId: string,
  root: RawWorkItem,
  maxItems: number,
  authorizedIds: ReadonlySet<number>,
): Promise<Set<number>> {
  const seen = new Set<number>();
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    if (seen.size > maxItems) throw new AdoLiveAcceptanceError('LIMIT_EXCEEDED');
    for (const childId of relationTargets(current, 'System.LinkTypes.Hierarchy-Forward')) {
      if (!authorizedIds.has(childId) || seen.has(childId)) continue;
      const child = parseWorkItem((await request(
        'level2.child',
        '/' + encodeURIComponent(projectId) + '/_apis/wit/workitems/' + childId,
        { '$expand': 'relations', 'api-version': '7.1' },
      )).body);
      queue.push(child);
    }
  }
  return seen;
}

async function readBacklogIds(
  request: (operation: string, pathname: string, query: Readonly<Record<string, string>>) => Promise<HttpResult>,
  projectId: string,
  teamId: string,
  backlogId: string,
  maxItems: number,
): Promise<Set<number>> {
  const result = await request(
    'backlog.work_items',
    '/' + encodeURIComponent(projectId) + '/' + encodeURIComponent(teamId)
      + '/_apis/work/backlogs/' + encodeURIComponent(backlogId) + '/workItems',
    { 'api-version': '7.1' },
  );
  if (!isRecord(result.body) || !Array.isArray(result.body.workItems)) throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
  const ids = new Set<number>();
  for (const link of result.body.workItems) {
    if (!isRecord(link) || !isRecord(link.target) || !Number.isSafeInteger(link.target.id) || Number(link.target.id) < 1) {
      throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
    }
    ids.add(Number(link.target.id));
    if (ids.size > maxItems) throw new AdoLiveAcceptanceError('LIMIT_EXCEEDED');
  }
  return ids;
}

async function readWorkItems(
  request: (operation: string, pathname: string, query: Readonly<Record<string, string>>) => Promise<HttpResult>,
  projectId: string,
  ids: readonly number[],
  maxItems: number,
): Promise<RawWorkItem[]> {
  if (ids.length > maxItems) throw new AdoLiveAcceptanceError('LIMIT_EXCEEDED');
  const values: RawWorkItem[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200);
    if (chunk.length === 0) continue;
    const result = await request(
      'work_items.list',
      '/' + encodeURIComponent(projectId) + '/_apis/wit/workitems',
      { ids: chunk.join(','), '$expand': 'all', 'api-version': '7.1' },
    );
    values.push(...parseArrayResponse(result.body).map(parseWorkItem));
  }
  if (new Set(values.map(workItem => workItem.id)).size !== ids.length) throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
  return values;
}

function sanitizeLiveItem(
  workItem: RawWorkItem,
  backlogIds: readonly string[],
  comments: readonly { readonly id: string; readonly text: string }[],
): AdoLiveSanitizedItem {
  const safeFields = {
    'System.WorkItemType': scalarField(workItem.fields['System.WorkItemType']),
    'System.Title': scalarField(workItem.fields['System.Title']),
    'System.State': scalarField(workItem.fields['System.State']),
    'System.Description': scalarField(workItem.fields['System.Description']),
    'Microsoft.VSTS.Common.AcceptanceCriteria': scalarField(workItem.fields['Microsoft.VSTS.Common.AcceptanceCriteria']),
    'System.AreaPath': scalarField(workItem.fields['System.AreaPath']),
    'System.IterationPath': scalarField(workItem.fields['System.IterationPath']),
    'System.Parent': workItem.fields['System.Parent'] ?? null,
    'System.Tags': scalarField(workItem.fields['System.Tags']),
    'System.BoardColumn': scalarField(workItem.fields['System.BoardColumn']),
    'System.ChangedDate': scalarField(workItem.fields['System.ChangedDate']),
  };
  const stage = stageRawSource(JSON.stringify({ id: workItem.id, rev: workItem.rev, fields: safeFields }));
  return {
    id: stage.canonical.id,
    revision: stage.canonical.revision,
    type: stage.canonical.type,
    title: stage.canonical.title,
    state: stage.canonical.state,
    description: stage.canonical.description,
    acceptanceCriteria: stage.canonical.acceptanceCriteria.text,
    areaPath: stage.canonical.areaPath,
    iterationPath: stage.canonical.iterationPath,
    parent: stage.canonical.parent,
    changedDate: stage.canonical.changedDate,
    backlogIds: [...new Set(backlogIds)].sort(),
    comments: comments.map(comment => ({ id: comment.id, text: sanitizeText(comment.text) })),
    relations: workItem.relations.flatMap(relation => {
      if (typeof relation.rel !== 'string' || typeof relation.url !== 'string') return [];
      const target = parseTargetId(relation.url);
      return target === null ? [] : [{ relation: relation.rel, targetWorkItemId: target }];
    }),
  };
}

function parseWorkItem(value: unknown): RawWorkItem {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || Number(value.id) < 1
    || !Number.isSafeInteger(value.rev) || Number(value.rev) < 1
    || !isRecord(value.fields) || (value.relations !== undefined && !Array.isArray(value.relations))) {
    throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
  }
  return {
    id: Number(value.id),
    rev: Number(value.rev),
    fields: value.fields,
    relations: (value.relations ?? []) as RawWorkItem['relations'],
  };
}

function relationTargets(workItem: RawWorkItem, relation: string): number[] {
  const ids = workItem.relations.flatMap(entry => {
    if (entry.rel !== relation || typeof entry.url !== 'string') return [];
    const id = parseTargetId(entry.url);
    return id === null ? [] : [id];
  });
  return [...new Set(ids)];
}

function parseTargetId(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('dev.azure.com')) return null;
    const match = /\/workItems\/(\d+)$/i.exec(parsed.pathname);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function parseTeamField(value: unknown): {
  field: { referenceName: string };
  defaultValue: string;
  values: { value: string; includeChildren: boolean }[];
} {
  if (!isRecord(value) || !isRecord(value.field) || typeof value.field.referenceName !== 'string'
    || typeof value.defaultValue !== 'string' || !Array.isArray(value.values)) throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
  const values = value.values.map(entry => {
    if (!isRecord(entry) || typeof entry.value !== 'string' || typeof entry.includeChildren !== 'boolean') {
      throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
    }
    return { value: entry.value, includeChildren: entry.includeChildren };
  });
  if (values.length === 0 || !values.some(entry => entry.value === value.defaultValue)) throw new AdoLiveAcceptanceError('SCOPE_MISMATCH');
  return { field: { referenceName: value.field.referenceName }, defaultValue: value.defaultValue, values };
}

function parseBacklogs(value: unknown): {
  id: string; name: string; rank: number; type: 'portfolio' | 'requirement' | 'task'; workItemTypes: string[]; hidden: boolean;
}[] {
  return parseArrayResponse(value).map(entry => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string'
      || !Number.isSafeInteger(entry.rank) || !['portfolio', 'requirement', 'task'].includes(String(entry.type))
      || !Array.isArray(entry.workItemTypes)) throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
    const workItemTypes = entry.workItemTypes.map(type => {
      if (!isRecord(type) || typeof type.name !== 'string') throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
      return type.name;
    });
    return {
      id: entry.id,
      name: entry.name,
      rank: Number(entry.rank),
      type: entry.type as 'portfolio' | 'requirement' | 'task',
      workItemTypes,
      hidden: entry.isHidden === true,
    };
  });
}

function parseIdentity(value: unknown): { id: string; name: string } {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string'
    || value.id.length === 0 || value.name.length === 0) throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
  return { id: value.id, name: value.name };
}

function uniqueIdentity<T extends { id: string; name: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value.id)) throw new AdoLiveAcceptanceError('AMBIGUOUS_TARGET');
    seen.add(value.id);
    result.push(value);
  }
  return result;
}

function parseArrayResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.value)) return value.value;
  throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
}

function parseCommentResponse(value: unknown): unknown[] {
  if (isRecord(value) && Array.isArray(value.comments)) return value.comments;
  return parseArrayResponse(value);
}

function inferObjectCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) {
    if (typeof value.count === 'number' && Number.isSafeInteger(value.count) && value.count >= 0) return value.count;
    if (Array.isArray(value.value)) return value.value.length;
    if (Array.isArray(value.workItems)) return value.workItems.length;
  }
  return 1;
}

function isInConfiguredArea(workItem: RawWorkItem, scope: ReturnType<typeof parseTeamField>): boolean {
  const area = textField(workItem.fields['System.AreaPath']);
  return scope.values.some(candidate =>
    area === candidate.value || (candidate.includeChildren && area.startsWith(candidate.value + '\\')));
}

function textField(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4096) {
    throw new AdoLiveAcceptanceError('UPSTREAM_FAILURE');
  }
  return value;
}

function scalarField(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
