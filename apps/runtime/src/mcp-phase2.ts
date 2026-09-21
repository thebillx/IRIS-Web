import type { ArtifactRetentionPolicy, ArtifactSensitivity, CapabilityEffect } from '@iris/domain';
import { RuntimeError } from '@iris/domain';
import type { CapabilityOutcome, CapabilityService } from './capability-service.js';
import { resolveDirectSessionIdentity, type DirectSessionIdentity } from './mcp-direct-context.js';
import type { McpPrincipal } from './mcp.js';
import type { RuntimeState } from './state.js';

const EFFECTS = ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const satisfies readonly CapabilityEffect[];

export const PHASE2_GROUPED_TOOL_NAMES = ['workspace', 'fs', 'artifact'] as const;
export type Phase2GroupedToolName = (typeof PHASE2_GROUPED_TOOL_NAMES)[number];

export function isPhase2GroupedTool(name: string): name is Phase2GroupedToolName {
  return PHASE2_GROUPED_TOOL_NAMES.some((candidate) => candidate === name);
}

export function phase2GroupedToolDefinitions(): readonly Record<string, unknown>[] {
  const sessionId = { sessionId: { type: 'string', description: 'Optional explicit IRIS runtime session UUID. Authenticated tunnel connectors may omit it and use project-bound direct context.' } };
  const projectId = { projectId: { type: 'string', description: 'Registered project UUID; direct context is isolated to this project.' } };
  const workspaceId = { workspaceId: { type: 'string', description: 'Opaque IRIS workspace UUID, never a raw path.' } };
  const expectedEffects = {
    expectedEffects: {
      type: 'array',
      maxItems: 5,
      uniqueItems: true,
      items: { enum: EFFECTS },
      description: 'Optional surprise-prevention assertion. It never grants permission or changes server-derived effects.',
    },
  };
  return [
    {
      name: 'workspace',
      description: 'IRIS vNext Phase 2 workspace identity operations. PRIMARY is derived from project registration; SCRATCH is governed and exact-root scoped.',
      inputSchema: {
        type: 'object',
        required: ['operation', 'projectId'],
        properties: { ...sessionId, ...projectId, ...workspaceId, operation: { enum: ['list', 'get', 'create_scratch', 'revoke_scratch'] }, ...expectedEffects },
        additionalProperties: false,
      },
    },
    {
      name: 'fs',
      description: 'Governed vNext Phase 2 workspace filesystem operations. Paths are workspace-relative; absolute paths do not confer authority.',
      inputSchema: {
        type: 'object',
        required: ['operation', 'projectId', 'workspaceId'],
        properties: {
          ...sessionId,
          ...projectId,
          ...workspaceId,
          operation: { enum: ['list', 'stat', 'read', 'write', 'edit', 'mkdir', 'delete', 'hash', 'find'] },
          path: { type: 'string', description: 'Canonical workspace-relative target path.' },
          root: { type: 'string', description: 'Canonical workspace-relative inventory/search root; use . for workspace root.' },
          recursive: { type: 'boolean' },
          maxDepth: { type: 'integer', minimum: 1, maximum: 20 },
          maxEntries: { type: 'integer', minimum: 1, maximum: 2000 },
          maxResults: { type: 'integer', minimum: 1, maximum: 1000 },
          cursor: { type: 'string', maxLength: 2048 },
          ignoreMode: { enum: ['NONE', 'PROJECT'] },
          includeHidden: { type: 'boolean' },
          readMode: { enum: ['TEXT', 'BYTE_RANGE'] },
          encoding: { enum: ['utf-8'] },
          maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
          offset: { type: 'integer', minimum: 0 },
          length: { type: 'integer', minimum: 1, maximum: 1048576 },
          writeMode: { enum: ['CREATE', 'REPLACE', 'APPEND'] },
          content: { type: 'string' },
          expectedSize: { type: 'integer', minimum: 0 },
          expectedSha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
          find: { type: 'string', minLength: 1 },
          replace: { type: 'string' },
          dryRun: { type: 'boolean' },
          query: { type: 'string', minLength: 1, maxLength: 500 },
          findMode: { enum: ['NAME', 'TEXT'] },
          ...expectedEffects,
        },
        additionalProperties: false,
      },
    },
    {
      name: 'artifact',
      description: 'Governed vNext Phase 2 artifact identity/reference operations. Artifact IDs are application identities and raw paths never authorize access.',
      inputSchema: {
        type: 'object',
        required: ['operation', 'projectId'],
        properties: {
          ...sessionId,
          ...projectId,
          ...workspaceId,
          operation: { enum: ['stat', 'open_ref', 'register_existing', 'release'] },
          artifactId: { type: 'string', description: 'Opaque IRIS artifact UUID.' },
          path: { type: 'string', description: 'Canonical workspace-relative file path, required only for register_existing.' },
          mime: { type: 'string', minLength: 1, maxLength: 200 },
          artifactType: { type: 'string', minLength: 1, maxLength: 120 },
          sensitivity: { enum: ['PUBLIC', 'INTERNAL', 'SENSITIVE', 'RESTRICTED'] },
          retentionPolicy: { enum: ['EPHEMERAL', 'SESSION', 'MISSION', 'PROJECT', 'MANUAL'] },
          ...expectedEffects,
        },
        additionalProperties: false,
      },
    },
  ];
}

export async function executePhase2GroupedTool(
  name: Phase2GroupedToolName,
  args: Record<string, unknown>,
  request: Request,
  capabilities: CapabilityService,
  state: RuntimeState | undefined,
  principal: McpPrincipal = 'owner',
): Promise<CapabilityOutcome> {
  const projectId = requiredBoundedString(args, 'projectId', 200);
  const identity = await resolveDirectSessionIdentity(args, request, state, projectId, principal);
  const expectedEffects = optionalExpectedEffects(args);
  if (name === 'workspace') return executeWorkspace(args, identity, projectId, expectedEffects, capabilities);
  if (name === 'fs') return executeFs(args, identity, projectId, expectedEffects, capabilities);
  return executeArtifact(args, identity, projectId, expectedEffects, capabilities);
}

async function executeWorkspace(
  args: Record<string, unknown>, identity: DirectSessionIdentity, projectId: string,
  expectedEffects: readonly CapabilityEffect[] | undefined, capabilities: CapabilityService,
): Promise<CapabilityOutcome> {
  const operation = requiredEnum(args, 'operation', ['list', 'get', 'create_scratch', 'revoke_scratch'] as const);
  const effects = expectedEffects === undefined ? {} : { expectedEffects };
  if (operation === 'list') return capabilities.execute({ capabilityId: 'workspace.list', ...identity, projectId, ...effects });
  if (operation === 'create_scratch') return capabilities.execute({ capabilityId: 'workspace.create_scratch', ...identity, projectId, ...effects });
  const workspaceId = requiredBoundedString(args, 'workspaceId', 200);
  if (operation === 'get') return capabilities.execute({ capabilityId: 'workspace.get', ...identity, projectId, workspaceId, ...effects });
  return capabilities.execute({ capabilityId: 'workspace.revoke_scratch', ...identity, projectId, workspaceId, ...effects });
}

async function executeFs(
  args: Record<string, unknown>, identity: DirectSessionIdentity, projectId: string,
  expectedEffects: readonly CapabilityEffect[] | undefined, capabilities: CapabilityService,
): Promise<CapabilityOutcome> {
  const operation = requiredEnum(args, 'operation', ['list', 'stat', 'read', 'write', 'edit', 'mkdir', 'delete', 'hash', 'find'] as const);
  const workspaceId = requiredBoundedString(args, 'workspaceId', 200);
  const effects = expectedEffects === undefined ? {} : { expectedEffects };
  if (operation === 'list') {
    const recursive = optionalBoolean(args, 'recursive');
    const maxDepth = optionalInteger(args, 'maxDepth', 1, 20);
    const maxEntries = optionalInteger(args, 'maxEntries', 1, 2000);
    const cursor = optionalBoundedString(args, 'cursor', 2048);
    const ignoreMode = optionalEnum(args, 'ignoreMode', ['NONE', 'PROJECT'] as const);
    const includeHidden = optionalBoolean(args, 'includeHidden');
    return capabilities.execute({
      capabilityId: 'fs.list', ...identity, projectId, workspaceId, path: optionalBoundedString(args, 'root', 4000) ?? '.',
      ...(recursive === undefined ? {} : { recursive }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(maxEntries === undefined ? {} : { maxEntries }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(ignoreMode === undefined ? {} : { ignoreMode }),
      ...(includeHidden === undefined ? {} : { includeHidden }),
      ...effects,
    });
  }
  if (operation === 'find') {
    const mode = optionalEnum(args, 'findMode', ['NAME', 'TEXT'] as const);
    const maxDepth = optionalInteger(args, 'maxDepth', 1, 20);
    const maxResults = optionalInteger(args, 'maxResults', 1, 1000);
    const cursor = optionalBoundedString(args, 'cursor', 2048);
    const ignoreMode = optionalEnum(args, 'ignoreMode', ['NONE', 'PROJECT'] as const);
    const includeHidden = optionalBoolean(args, 'includeHidden');
    return capabilities.execute({
      capabilityId: 'fs.find', ...identity, projectId, workspaceId, root: optionalBoundedString(args, 'root', 4000) ?? '.', query: requiredBoundedString(args, 'query', 500),
      ...(mode === undefined ? {} : { mode }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(maxResults === undefined ? {} : { maxResults }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(ignoreMode === undefined ? {} : { ignoreMode }),
      ...(includeHidden === undefined ? {} : { includeHidden }),
      ...effects,
    });
  }
  const target = requiredBoundedString(args, 'path', 4000);
  if (operation === 'stat') return capabilities.execute({ capabilityId: 'fs.stat', ...identity, projectId, workspaceId, path: target, ...effects });
  if (operation === 'hash') return capabilities.execute({ capabilityId: 'fs.hash', ...identity, projectId, workspaceId, path: target, ...effects });
  if (operation === 'mkdir') return capabilities.execute({ capabilityId: 'fs.mkdir', ...identity, projectId, workspaceId, path: target, ...effects });
  if (operation === 'delete') return capabilities.execute({ capabilityId: 'fs.delete', ...identity, projectId, workspaceId, path: target, ...effects });
  if (operation === 'read') {
    const mode = requiredEnum(args, 'readMode', ['TEXT', 'BYTE_RANGE'] as const);
    if (mode === 'TEXT') {
      const maxBytes = optionalInteger(args, 'maxBytes', 1, 1048576);
      const encoding = optionalEnum(args, 'encoding', ['utf-8'] as const);
      return capabilities.execute({
        capabilityId: 'fs.read', ...identity, projectId, workspaceId, path: target, mode,
        ...(maxBytes === undefined ? {} : { maxBytes }),
        ...(encoding === undefined ? {} : { encoding }),
        ...effects,
      });
    }
    return capabilities.execute({
      capabilityId: 'fs.read', ...identity, projectId, workspaceId, path: target, mode,
      offset: requiredInteger(args, 'offset', 0, Number.MAX_SAFE_INTEGER),
      length: requiredInteger(args, 'length', 1, 1048576),
      ...effects,
    });
  }
  if (operation === 'write') {
    const expectedSize = optionalInteger(args, 'expectedSize', 0, Number.MAX_SAFE_INTEGER);
    const expectedSha256 = optionalSha256(args, 'expectedSha256');
    return capabilities.execute({
      capabilityId: 'fs.write', ...identity, projectId, workspaceId, path: target,
      mode: requiredEnum(args, 'writeMode', ['CREATE', 'REPLACE', 'APPEND'] as const),
      content: requiredText(args, 'content'),
      ...(expectedSize === undefined ? {} : { expectedSize }),
      ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      ...effects,
    });
  }
  const dryRun = optionalBoolean(args, 'dryRun');
  return capabilities.execute({
    capabilityId: 'fs.edit', ...identity, projectId, workspaceId, path: target,
    find: requiredBoundedString(args, 'find', 1048576), replace: requiredText(args, 'replace'), expectedSha256: requiredSha256(args, 'expectedSha256'),
    ...(dryRun === undefined ? {} : { dryRun }),
    ...effects,
  });
}

async function executeArtifact(
  args: Record<string, unknown>, identity: DirectSessionIdentity, projectId: string,
  expectedEffects: readonly CapabilityEffect[] | undefined, capabilities: CapabilityService,
): Promise<CapabilityOutcome> {
  const operation = requiredEnum(args, 'operation', ['stat', 'open_ref', 'register_existing', 'release'] as const);
  const effects = expectedEffects === undefined ? {} : { expectedEffects };
  if (operation === 'register_existing') return capabilities.execute({
    capabilityId: 'artifact.register_existing', ...identity, projectId,
    workspaceId: requiredBoundedString(args, 'workspaceId', 200), path: requiredBoundedString(args, 'path', 4000),
    mime: requiredBoundedString(args, 'mime', 200), artifactType: requiredBoundedString(args, 'artifactType', 120),
    sensitivity: requiredEnum(args, 'sensitivity', ['PUBLIC', 'INTERNAL', 'SENSITIVE', 'RESTRICTED'] as const) satisfies ArtifactSensitivity,
    retentionPolicy: requiredEnum(args, 'retentionPolicy', ['EPHEMERAL', 'SESSION', 'MISSION', 'PROJECT', 'MANUAL'] as const) satisfies ArtifactRetentionPolicy,
    ...effects,
  });
  const artifactId = requiredBoundedString(args, 'artifactId', 200);
  if (operation === 'stat') return capabilities.execute({ capabilityId: 'artifact.stat', ...identity, projectId, artifactId, ...effects });
  if (operation === 'open_ref') return capabilities.execute({ capabilityId: 'artifact.open_ref', ...identity, projectId, artifactId, ...effects });
  return capabilities.execute({ capabilityId: 'artifact.release', ...identity, projectId, artifactId, ...effects });
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

function requiredText(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== 'string') throw new RuntimeError('INVALID_REQUEST', `${name} must be a string`);
  return value;
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
function optionalBoolean(record: Record<string, unknown>, name: string): boolean | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new RuntimeError('INVALID_REQUEST', `${name} must be boolean`);
  return value;
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
function requiredSha256(record: Record<string, unknown>, name: string): string {
  const value = requiredBoundedString(record, name, 64);
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new RuntimeError('INVALID_REQUEST', `${name} must be a SHA-256 hex digest`);
  return value;
}
function optionalSha256(record: Record<string, unknown>, name: string): string | undefined {
  if (record[name] === undefined) return undefined;
  return requiredSha256(record, name);
}
function requiredEnum<const T extends readonly string[]>(record: Record<string, unknown>, name: string, allowed: T): T[number] {
  const value = record[name];
  if (typeof value === 'string' && allowed.some((candidate) => candidate === value)) return value as T[number];
  throw new RuntimeError('INVALID_REQUEST', `${name} is not a supported value`);
}
function optionalEnum<const T extends readonly string[]>(record: Record<string, unknown>, name: string, allowed: T): T[number] | undefined {
  if (record[name] === undefined) return undefined;
  return requiredEnum(record, name, allowed);
}
