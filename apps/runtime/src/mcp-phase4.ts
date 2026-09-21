import type { CapabilityEffect, MissionExecutionAssociation } from '@iris/domain';
import { RuntimeError } from '@iris/domain';
import type { CapabilityOutcome, CapabilityService } from './capability-service.js';
import { resolveDirectSessionIdentity, type DirectSessionIdentity } from './mcp-direct-context.js';
import type { McpPrincipal } from './mcp.js';
import type { RuntimeState } from './state.js';

const EFFECTS = ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const satisfies readonly CapabilityEffect[];
const OPERATIONS = [
  'status','head','diff','log','show','cat_file','merge_base','ancestry','refs','branch_list','worktree_list',
  'branch_create','worktree_add','worktree_remove','add','commit','fetch','push',
] as const;

export const PHASE4_GROUPED_TOOL_NAMES = ['git'] as const;
export type Phase4GroupedToolName = (typeof PHASE4_GROUPED_TOOL_NAMES)[number];

const GIT_KEYS = new Set([
  'operation','sessionId','projectId','workspaceId','repositoryId','expectedEffects','missionId','taskId','actionId',
  'paths','ref','object','left','right','ancestor','descendant','maxCount','maxEntries',
  'branchName','baseRef','destinationPath','message','remote','branch',
]);

export function isPhase4GroupedTool(name: string): name is Phase4GroupedToolName {
  return name === 'git';
}

export function phase4GroupedToolDefinitions(): readonly Record<string, unknown>[] {
  return [{
    name: 'git',
    description: 'Governed typed Git operations with verified repository/workspace identity, server-built argv, bounded output, isolated worktree authorization, configured-remote fetch, and safe feature-branch push. No raw git argv, shell command, force push, delete push, or arbitrary remote URL is accepted.',
    inputSchema: {
      type: 'object',
      required: ['operation','projectId','workspaceId'],
      properties: {
        sessionId: { type: 'string', description: 'Optional explicit IRIS runtime session UUID. Authenticated tunnel connectors may omit it and use project-bound direct context.' },
        projectId: { type: 'string', description: 'Registered project UUID; direct context is isolated to this project.' },
        workspaceId: { type: 'string', description: 'Opaque ACTIVE IRIS PRIMARY or WORKTREE workspace UUID.' },
        missionId: { type: 'string', description: 'Optional prepared CHATGPT mission identity; missionId/taskId/actionId must be supplied together.' },
        taskId: { type: 'string', description: 'Optional prepared CHATGPT task identity; missionId/taskId/actionId must be supplied together.' },
        actionId: { type: 'string', description: 'Optional prepared CHATGPT action identity; missionId/taskId/actionId must be supplied together.' },
        repositoryId: { type: 'string', description: 'Opaque verified repository UUID. Required for mutation/network operations; optional assertion for reads.' },
        operation: { enum: OPERATIONS },
        paths: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'string', minLength: 1, maxLength: 1000 }, description: 'Explicit workspace-relative physical regular-file paths only.' },
        ref: { type: 'string', minLength: 1, maxLength: 200 },
        object: { type: 'string', minLength: 1, maxLength: 200 },
        left: { type: 'string', minLength: 1, maxLength: 200 },
        right: { type: 'string', minLength: 1, maxLength: 200 },
        ancestor: { type: 'string', minLength: 1, maxLength: 200 },
        descendant: { type: 'string', minLength: 1, maxLength: 200 },
        maxCount: { type: 'integer', minimum: 1, maximum: 100 },
        maxEntries: { type: 'integer', minimum: 1, maximum: 200 },
        branchName: { type: 'string', minLength: 1, maxLength: 200 },
        baseRef: { type: 'string', minLength: 1, maxLength: 200 },
        destinationPath: { type: 'string', minLength: 1, maxLength: 4000, description: 'Absolute destination constrained by the project-specific approved sibling-worktree policy.' },
        message: { type: 'string', minLength: 1, maxLength: 200 },
        remote: { type: 'string', minLength: 1, maxLength: 100, description: 'Configured remote name only, never a URL.' },
        branch: { type: 'string', minLength: 1, maxLength: 200 },
        expectedEffects: {
          type: 'array', maxItems: 5, uniqueItems: true, items: { enum: EFFECTS },
          description: 'Optional surprise-prevention assertion only. Server-derived effects remain authoritative.',
        },
      },
      additionalProperties: false,
    },
  }];
}

export async function executePhase4GroupedTool(
  _name: Phase4GroupedToolName,
  args: Record<string, unknown>,
  request: Request,
  capabilities: CapabilityService,
  state: RuntimeState | undefined,
  principal: McpPrincipal = 'owner',
): Promise<CapabilityOutcome> {
  assertOnlyGitKeys(args);
  const projectId = requiredBoundedString(args, 'projectId', 200);
  const identity = await resolveDirectSessionIdentity(args, request, state, projectId, principal);
  const workspaceId = requiredBoundedString(args, 'workspaceId', 200);
  const operation = requiredEnum(args, 'operation', OPERATIONS);
  const repositoryId = optionalBoundedString(args, 'repositoryId', 200);
  const expectedEffects = optionalExpectedEffects(args);
  const mission = await optionalMissionAssociation(args, state, identity);
  const common = { ...identity, projectId, workspaceId, ...(repositoryId === undefined ? {} : { repositoryId }), ...(expectedEffects === undefined ? {} : { expectedEffects }), ...(mission === undefined ? {} : { mission }) };

  if (operation === 'status') return capabilities.execute({ capabilityId: 'git.status', operation, ...common });
  if (operation === 'head') return capabilities.execute({ capabilityId: 'git.head', operation, ...common });
  if (operation === 'diff') {
    const paths = optionalStringArray(args, 'paths', 24, 1000);
    return capabilities.execute({ capabilityId: 'git.diff', operation, ...common, ...(paths === undefined ? {} : { paths }) });
  }
  if (operation === 'log') {
    const ref = optionalBoundedString(args, 'ref', 200);
    const maxCount = optionalInteger(args, 'maxCount', 1, 100);
    return capabilities.execute({ capabilityId: 'git.log', operation, ...common, ...(ref === undefined ? {} : { ref }), ...(maxCount === undefined ? {} : { maxCount }) });
  }
  if (operation === 'show') return capabilities.execute({ capabilityId: 'git.show', operation, ...common, ref: requiredBoundedString(args, 'ref', 200) });
  if (operation === 'cat_file') return capabilities.execute({ capabilityId: 'git.cat_file', operation, ...common, object: requiredBoundedString(args, 'object', 200) });
  if (operation === 'merge_base') return capabilities.execute({ capabilityId: 'git.merge_base', operation, ...common, left: requiredBoundedString(args, 'left', 200), right: requiredBoundedString(args, 'right', 200) });
  if (operation === 'ancestry') return capabilities.execute({ capabilityId: 'git.ancestry', operation, ...common, ancestor: requiredBoundedString(args, 'ancestor', 200), descendant: requiredBoundedString(args, 'descendant', 200) });
  if (operation === 'refs' || operation === 'branch_list') {
    const maxEntries = optionalInteger(args, 'maxEntries', 1, 200);
    const capabilityId = operation === 'refs' ? 'git.refs' : 'git.branch_list';
    return capabilities.execute({ capabilityId, operation, ...common, ...(maxEntries === undefined ? {} : { maxEntries }) });
  }
  if (operation === 'worktree_list') return capabilities.execute({ capabilityId: 'git.worktree_list', operation, ...common });

  const requiredRepositoryId = requireMutationRepositoryId(repositoryId);
  if (operation === 'branch_create') return capabilities.execute({ capabilityId: 'git.branch_create', operation, ...common, repositoryId: requiredRepositoryId, branchName: requiredBoundedString(args, 'branchName', 200), baseRef: requiredBoundedString(args, 'baseRef', 200) });
  if (operation === 'worktree_add') return capabilities.execute({ capabilityId: 'git.worktree_add', operation, ...common, repositoryId: requiredRepositoryId, branchName: requiredBoundedString(args, 'branchName', 200), baseRef: requiredBoundedString(args, 'baseRef', 200), destinationPath: requiredBoundedString(args, 'destinationPath', 4000) });
  if (operation === 'worktree_remove') return capabilities.execute({ capabilityId: 'git.worktree_remove', operation, ...common, repositoryId: requiredRepositoryId });
  if (operation === 'add') return capabilities.execute({ capabilityId: 'git.add', operation, ...common, repositoryId: requiredRepositoryId, paths: requiredStringArray(args, 'paths', 24, 1000) });
  if (operation === 'commit') return capabilities.execute({ capabilityId: 'git.commit', operation, ...common, repositoryId: requiredRepositoryId, paths: requiredStringArray(args, 'paths', 24, 1000), message: requiredBoundedString(args, 'message', 200) });
  if (operation === 'fetch') return capabilities.execute({ capabilityId: 'git.fetch', operation, ...common, repositoryId: requiredRepositoryId, remote: requiredBoundedString(args, 'remote', 100) });
  return capabilities.execute({ capabilityId: 'git.push', operation, ...common, repositoryId: requiredRepositoryId, remote: requiredBoundedString(args, 'remote', 100), branch: requiredBoundedString(args, 'branch', 200) });
}

function assertOnlyGitKeys(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (!GIT_KEYS.has(key)) throw new RuntimeError('INVALID_REQUEST', `Unsupported git field: ${key}`);
  }
}

async function optionalMissionAssociation(
  args: Record<string, unknown>,
  state: RuntimeState | undefined,
  identity: DirectSessionIdentity,
): Promise<MissionExecutionAssociation | undefined> {
  const missionId = optionalBoundedString(args, 'missionId', 200);
  const taskId = optionalBoundedString(args, 'taskId', 200);
  const actionId = optionalBoundedString(args, 'actionId', 200);
  if (missionId === undefined && taskId === undefined && actionId === undefined) return undefined;
  if (missionId === undefined || taskId === undefined || actionId === undefined) {
    throw new RuntimeError('INVALID_REQUEST', 'missionId, taskId, and actionId must be supplied together');
  }
  if (state === undefined) throw new RuntimeError('INVALID_REQUEST', 'IRIS mission validation is unavailable');
  const mission = await state.assertMissionOrchestrator(missionId, 'CHATGPT');
  if (mission.clientId !== identity.clientId || mission.sessionId !== identity.sessionId) {
    throw new RuntimeError('MISSION_SESSION_STALE', 'Mission session binding is stale for grouped Git execution');
  }
  return { missionId, taskId, actionId, orchestratorMode: 'CHATGPT' };
}

function requireMutationRepositoryId(value: string | undefined): string {
  if (value === undefined) throw new RuntimeError('INVALID_REQUEST', 'repositoryId is required for Git mutation/network operations');
  return value;
}

function optionalExpectedEffects(args: Record<string, unknown>): readonly CapabilityEffect[] | undefined {
  const value = args.expectedEffects;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > EFFECTS.length) throw new RuntimeError('INVALID_REQUEST', 'expectedEffects must be a bounded effect array');
  const effects: CapabilityEffect[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !EFFECTS.some((effect) => effect === item)) throw new RuntimeError('INVALID_REQUEST', 'expectedEffects contains an unsupported effect');
    const effect = item as CapabilityEffect;
    if (!effects.includes(effect)) effects.push(effect);
  }
  return effects;
}

function requiredBoundedString(record: Record<string, unknown>, name: string, maxLength: number): string {
  const value = record[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) throw new RuntimeError('INVALID_REQUEST', `${name} must be a bounded non-empty string`);
  return value;
}
function optionalBoundedString(record: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  if (record[name] === undefined) return undefined;
  return requiredBoundedString(record, name, maxLength);
}
function requiredInteger(record: Record<string, unknown>, name: string, min: number, max: number): number {
  const value = record[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new RuntimeError('INVALID_REQUEST', `${name} must be an integer from ${min} through ${max}`);
  return value;
}
function optionalInteger(record: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  if (record[name] === undefined) return undefined;
  return requiredInteger(record, name, min, max);
}
function requiredEnum<const T extends readonly string[]>(record: Record<string, unknown>, name: string, allowed: T): T[number] {
  const value = record[name];
  if (typeof value === 'string' && allowed.some((candidate) => candidate === value)) return value as T[number];
  throw new RuntimeError('INVALID_REQUEST', `${name} is not a supported value`);
}
function requiredStringArray(record: Record<string, unknown>, name: string, maxItems: number, maxItemLength: number): readonly string[] {
  const value = record[name];
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems || !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= maxItemLength && !item.includes('\0'))) throw new RuntimeError('INVALID_REQUEST', `${name} must be a bounded non-empty string array`);
  return value as string[];
}
function optionalStringArray(record: Record<string, unknown>, name: string, maxItems: number, maxItemLength: number): readonly string[] | undefined {
  if (record[name] === undefined) return undefined;
  return requiredStringArray(record, name, maxItems, maxItemLength);
}
