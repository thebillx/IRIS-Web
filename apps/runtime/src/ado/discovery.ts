export interface Identity { readonly id: string; readonly name: string }
export interface ChildIdentity extends Identity { readonly parentId: string }
export interface BoardIdentity {
  readonly organization: Identity;
  readonly project: Identity;
  readonly team: Identity;
  readonly board: Identity;
}
export type Selector = { readonly id: string } | { readonly name: string };
export type Target = { readonly [Key in keyof BoardIdentity]: Selector };
export interface IdentityCatalog {
  readonly organizations: readonly Identity[];
  readonly projects: readonly ChildIdentity[];
  readonly teams: readonly ChildIdentity[];
  readonly boards: readonly ChildIdentity[];
}
export class DiscoveryError extends Error {
  constructor(readonly code: 'INVALID_RESPONSE' | 'MISSING_TARGET' | 'AMBIGUOUS_TARGET' | 'LIMIT_EXCEEDED' | 'INVALID_CONTINUATION') {
    super(code);
  }
}
export function text(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || [...value].some(character => character.charCodeAt(0) < 32)) throw new DiscoveryError('INVALID_RESPONSE');
}
export function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new DiscoveryError('INVALID_RESPONSE');
}
function select(selector: Selector, candidates: readonly Identity[]): Identity {
  const value = 'id' in selector ? selector.id : selector.name;
  text(value);
  for (const candidate of candidates) { text(candidate.id); text(candidate.name); }
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) throw new DiscoveryError('AMBIGUOUS_TARGET');
  const matches = candidates.filter(candidate => 'id' in selector ? candidate.id === value : candidate.name === value);
  if (!matches.length) throw new DiscoveryError('MISSING_TARGET');
  if (matches.length !== 1) throw new DiscoveryError('AMBIGUOUS_TARGET');
  return { id: matches[0]!.id, name: matches[0]!.name };
}
export function resolveBoardIdentity(target: Target, catalog: IdentityCatalog): BoardIdentity {
  const organization = select(target.organization, catalog.organizations);
  const project = select(target.project, catalog.projects.filter(item => item.parentId === organization.id));
  const team = select(target.team, catalog.teams.filter(item => item.parentId === project.id));
  const board = select(target.board, catalog.boards.filter(item => item.parentId === team.id));
  return { organization, project, team, board };
}
export interface ScopeResponse {
  readonly teamId: string;
  readonly field: { readonly referenceName: string; readonly defaultValue: string; readonly values: readonly { readonly value: string; readonly includeChildren: boolean }[] };
  readonly iterations: readonly (Identity & { readonly path: string })[];
  readonly backlogIteration: Identity & { readonly path: string };
}
export interface BoardScope {
  readonly identity: BoardIdentity;
  readonly areaPaths: readonly { readonly path: string; readonly includeChildren: boolean }[];
  readonly defaultAreaPath: string;
  readonly iterations: ScopeResponse['iterations'];
  readonly backlogIteration: ScopeResponse['backlogIteration'];
  readonly iterationFilter: 'ALL_CONFIGURED_AREAS';
}
function pathSegments(path: string): string[] {
  text(path);
  const segments = path.split('\\');
  if (segments.some(segment => !segment.trim() || segment === '.' || segment === '..')) throw new DiscoveryError('INVALID_RESPONSE');
  return segments;
}
export function resolveBoardScope(identity: BoardIdentity, response: ScopeResponse, maxEntries: number): BoardScope {
  positive(maxEntries);
  if (response.teamId !== identity.team.id || response.field.referenceName !== 'System.AreaPath' || !response.field.values.length) throw new DiscoveryError('INVALID_RESPONSE');
  if (response.field.values.length > maxEntries || response.iterations.length > maxEntries) throw new DiscoveryError('LIMIT_EXCEEDED');
  const seen = new Set<string>();
  const areaPaths = response.field.values.map(entry => {
    const segments = pathSegments(entry.value);
    if (segments[0] !== identity.project.name || typeof entry.includeChildren !== 'boolean' || seen.has(entry.value)) throw new DiscoveryError('INVALID_RESPONSE');
    seen.add(entry.value);
    return { path: entry.value, includeChildren: entry.includeChildren };
  });
  if (!seen.has(response.field.defaultValue)) throw new DiscoveryError('INVALID_RESPONSE');
  const iterationIds = new Set<string>();
  for (const iteration of [...response.iterations, response.backlogIteration]) {
    text(iteration.id); text(iteration.name);
    if (pathSegments(iteration.path)[0] !== identity.project.name) throw new DiscoveryError('INVALID_RESPONSE');
  }
  for (const iteration of response.iterations) {
    if (iterationIds.has(iteration.id)) throw new DiscoveryError('INVALID_RESPONSE');
    iterationIds.add(iteration.id);
  }
  return structuredClone({ identity, areaPaths, defaultAreaPath: response.field.defaultValue, iterations: response.iterations, backlogIteration: response.backlogIteration, iterationFilter: 'ALL_CONFIGURED_AREAS' });
}
export function isAreaInScope(scope: BoardScope, path: string): boolean {
  pathSegments(path);
  return scope.areaPaths.some(area => path === area.path || (area.includeChildren && path.startsWith(`${area.path}\\`)));
}
export type BacklogType = 'portfolio' | 'requirement' | 'task';
export interface Backlog extends Identity { readonly rank: number; readonly type: BacklogType; readonly workItemTypes: readonly string[] }
export function discoverBacklogs(backlogs: readonly Backlog[], maxEntries: number): readonly Backlog[] {
  positive(maxEntries);
  if (backlogs.length > maxEntries) throw new DiscoveryError('LIMIT_EXCEEDED');
  const seen = new Set<string>();
  for (const backlog of backlogs) {
    text(backlog.id); text(backlog.name);
    if (seen.has(backlog.id) || !Number.isSafeInteger(backlog.rank) || backlog.rank < 0
      || !['portfolio', 'requirement', 'task'].includes(backlog.type)
      || !backlog.workItemTypes.length || backlog.workItemTypes.length > maxEntries) throw new DiscoveryError('INVALID_RESPONSE');
    seen.add(backlog.id);
    backlog.workItemTypes.forEach(text);
    if (new Set(backlog.workItemTypes).size !== backlog.workItemTypes.length) throw new DiscoveryError('INVALID_RESPONSE');
  }
  return structuredClone([...backlogs].sort((left, right) => left.rank - right.rank));
}
export interface MembershipPage {
  readonly backlogId: string;
  readonly continuation: string | null;
  readonly nextContinuation: string | null;
  readonly ids: readonly number[];
}
export interface EnumerationLimits { readonly maxPages: number; readonly maxPageItems: number; readonly maxItems: number; readonly chunkSize: number }
export interface PlannedItem { readonly id: number; readonly memberships: readonly Backlog[] }
export interface EnumerationPlan {
  readonly chunkSize: number;
  readonly items: readonly PlannedItem[];
  readonly pending: readonly { readonly backlogId: string; readonly continuation: string | null }[];
  readonly complete: boolean;
}
export function planEnumeration(catalog: readonly Backlog[], pages: readonly MembershipPage[], limits: EnumerationLimits): EnumerationPlan {
  [limits.maxPages, limits.maxPageItems, limits.maxItems, limits.chunkSize].forEach(positive);
  const backlogs = discoverBacklogs(catalog, limits.maxItems);
  if (pages.length > limits.maxPages) throw new DiscoveryError('LIMIT_EXCEEDED');
  const cursors = new Map(backlogs.map(backlog => [backlog.id, null as string | null]));
  const completed = new Set<string>();
  const used = new Map(backlogs.map(backlog => [backlog.id, new Set<string>()]));
  const items = new Map<number, { id: number; memberships: Backlog[] }>();
  for (const page of pages) {
    const backlog = backlogs.find(candidate => candidate.id === page.backlogId);
    if (!backlog || completed.has(page.backlogId) || cursors.get(page.backlogId) !== page.continuation) throw new DiscoveryError('INVALID_CONTINUATION');
    if (page.ids.length > limits.maxPageItems) throw new DiscoveryError('LIMIT_EXCEEDED');
    if (page.nextContinuation !== null) {
      text(page.nextContinuation);
      if (used.get(page.backlogId)!.has(page.nextContinuation)) throw new DiscoveryError('INVALID_CONTINUATION');
      used.get(page.backlogId)!.add(page.nextContinuation);
    } else completed.add(page.backlogId);
    cursors.set(page.backlogId, page.nextContinuation);
    for (const id of page.ids) {
      positive(id);
      const item = items.get(id) ?? { id, memberships: [] };
      if (!item.memberships.some(member => member.id === backlog.id)) item.memberships.push(backlog);
      items.set(id, item);
      if (items.size > limits.maxItems) throw new DiscoveryError('LIMIT_EXCEEDED');
    }
  }
  const pending = backlogs.filter(backlog => !completed.has(backlog.id)).map(backlog => ({ backlogId: backlog.id, continuation: cursors.get(backlog.id)! }));
  if (pending.length && pages.length === limits.maxPages) throw new DiscoveryError('LIMIT_EXCEEDED');
  return { chunkSize: limits.chunkSize, items: [...items.values()], pending, complete: !pending.length };
}
export function enumerationChunk(plan: EnumerationPlan, offset: number): { items: readonly PlannedItem[]; nextOffset: number | null } {
  const chunkSize = plan.chunkSize;
  positive(chunkSize);
  if (!plan.complete || !Number.isSafeInteger(offset) || offset < 0 || offset > plan.items.length) throw new DiscoveryError('INVALID_CONTINUATION');
  const nextOffset = Math.min(offset + chunkSize, plan.items.length);
  return { items: structuredClone(plan.items.slice(offset, nextOffset)), nextOffset: nextOffset < plan.items.length ? nextOffset : null };
}
