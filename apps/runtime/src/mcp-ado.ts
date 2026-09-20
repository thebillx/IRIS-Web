import type { CapabilityEffect } from '@iris/domain';
import { RuntimeError } from '@iris/domain';
import type { CapabilityOutcome, CapabilityService } from './capability-service.js';
import type { RuntimeState } from './state.js';

const CLIENT_ID_HEADER = 'x-iris-client-id';
const SESSION_ID_HEADER = 'x-iris-session-id';
const EFFECTS = ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const satisfies readonly CapabilityEffect[];

export const ADO_TOOL_NAMES = [
  'ado_discovery',
  'ado_workitem_read',
  'ado_hierarchy_read',
  'ado_context_search',
] as const;

export type AdoToolName = (typeof ADO_TOOL_NAMES)[number];

export function isAdoTool(name: string): name is AdoToolName {
  return ADO_TOOL_NAMES.some((candidate) => candidate === name);
}

export function adoToolDefinitions(): readonly Record<string, unknown>[] {
  const sessionId = { sessionId: { type: 'string', description: 'IRIS runtime session UUID returned by session_open. May be omitted when x-iris-session-id is supplied.' } };
  const projectId = { projectId: { type: 'string', description: 'Registered IRIS project UUID; must equal the live session project and have one protected ADO binding.' } };
  const requestId = { requestId: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' } };
  const expectedEffects = {
    expectedEffects: {
      type: 'array',
      minItems: 2,
      maxItems: 5,
      uniqueItems: true,
      items: { enum: EFFECTS },
      description: 'Surprise-prevention assertion. ADO V1 derives READ + NETWORK and never WRITE/DESTRUCTIVE.',
    },
  };
  const common = { ...sessionId, ...projectId, ...requestId, ...expectedEffects };
  const annotations = { readOnlyHint: true, destructiveHint: false };
  return [
    {
      name: 'ado_discovery',
      description: 'Read the exact protected Azure DevOps Board binding, team Area Path scope and provider-defined backlog levels. FULL only; no write-back.',
      inputSchema: {
        type: 'object',
        required: ['projectId','requestId','expectedEffects'],
        properties: common,
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'ado_workitem_read',
      description: 'Read one scoped Azure DevOps Work Item with canonical fields, revision/changed time, optional comments and relation links, with IRIS provenance.',
      inputSchema: {
        type: 'object',
        required: ['projectId','requestId','workItemId','expectedEffects'],
        properties: {
          ...common,
          workItemId: { type: 'integer', minimum: 1 },
          includeComments: { type: 'boolean', default: false },
          includeLinks: { type: 'boolean', default: true },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'ado_hierarchy_read',
      description: 'Read a bounded hierarchy-forward subtree from one scoped Azure DevOps Work Item. Every returned node is rechecked against the bound Team Area Path.',
      inputSchema: {
        type: 'object',
        required: ['projectId','requestId','rootWorkItemId','maxDepth','maxItems','expectedEffects'],
        properties: {
          ...common,
          rootWorkItemId: { type: 'integer', minimum: 1 },
          maxDepth: { type: 'integer', minimum: 0, maximum: 12 },
          maxItems: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'ado_context_search',
      description: 'Search requirement context using server-built scoped WIQL. Caller text is a bounded search term only; raw WIQL/URL/method/header input is never accepted.',
      inputSchema: {
        type: 'object',
        required: ['projectId','requestId','query','limit','expectedEffects'],
        properties: {
          ...common,
          query: { type: 'string', minLength: 1, maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      annotations,
    },
  ];
}

export async function executeAdoTool(
  name: AdoToolName,
  args: Record<string, unknown>,
  request: Request,
  capabilities: CapabilityService,
  state: RuntimeState | undefined,
): Promise<CapabilityOutcome> {
  assertOnlyKnownKeys(name, args);
  const identity = resolveSessionIdentity(args, request, state);
  const projectId = requiredBoundedString(args, 'projectId', 200);
  if (identity.session.currentProjectId !== projectId) {
    throw new RuntimeError('CAPABILITY_DENIED', 'ADO projectId must match the live session project');
  }
  const requestId = requiredBoundedString(args, 'requestId', 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(requestId)) throw new RuntimeError('INVALID_REQUEST', 'ADO requestId is invalid');
  const expectedEffects = requiredExpectedEffects(args);

  if (name === 'ado_discovery') {
    return capabilities.execute({
      capabilityId: 'ado.discovery',
      clientId: identity.clientId,
      sessionId: identity.sessionId,
      projectId,
      requestId,
      expectedEffects,
    });
  }
  if (name === 'ado_workitem_read') {
    return capabilities.execute({
      capabilityId: 'ado.workitem.read',
      clientId: identity.clientId,
      sessionId: identity.sessionId,
      projectId,
      requestId,
      workItemId: requiredPositiveInteger(args, 'workItemId'),
      includeComments: optionalBoolean(args, 'includeComments') ?? false,
      includeLinks: optionalBoolean(args, 'includeLinks') ?? true,
      expectedEffects,
    });
  }
  if (name === 'ado_hierarchy_read') {
    return capabilities.execute({
      capabilityId: 'ado.hierarchy.read',
      clientId: identity.clientId,
      sessionId: identity.sessionId,
      projectId,
      requestId,
      rootWorkItemId: requiredPositiveInteger(args, 'rootWorkItemId'),
      maxDepth: requiredIntegerInRange(args, 'maxDepth', 0, 12),
      maxItems: requiredIntegerInRange(args, 'maxItems', 1, 200),
      expectedEffects,
    });
  }
  return capabilities.execute({
    capabilityId: 'ado.context.search',
    clientId: identity.clientId,
    sessionId: identity.sessionId,
    projectId,
    requestId,
    query: requiredBoundedString(args, 'query', 200),
    limit: requiredIntegerInRange(args, 'limit', 1, 50),
    expectedEffects,
  });
}

const COMMON_KEYS = ['sessionId','projectId','requestId','expectedEffects'] as const;

function assertOnlyKnownKeys(name: AdoToolName, args: Record<string, unknown>): void {
  const extra = name === 'ado_workitem_read'
    ? ['workItemId','includeComments','includeLinks']
    : name === 'ado_hierarchy_read'
      ? ['rootWorkItemId','maxDepth','maxItems']
      : name === 'ado_context_search'
        ? ['query','limit']
        : [];
  const allowed = new Set<string>([...COMMON_KEYS, ...extra]);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new RuntimeError('INVALID_REQUEST', `Unsupported ${name} field: ${key}`);
}

function resolveSessionIdentity(
  args: Record<string, unknown>,
  request: Request,
  state: RuntimeState | undefined,
): { readonly clientId: string; readonly sessionId: string; readonly session: ReturnType<RuntimeState['getSessionForClient']> } {
  const clientId = requiredHeader(request, CLIENT_ID_HEADER);
  const argumentSessionId = optionalBoundedString(args, 'sessionId', 200);
  const headerSessionId = optionalHeader(request, SESSION_ID_HEADER);
  if (argumentSessionId !== undefined && headerSessionId !== undefined && argumentSessionId !== headerSessionId) {
    throw new RuntimeError('CONTROL_DENIED', 'sessionId argument does not match x-iris-session-id');
  }
  const sessionId = argumentSessionId ?? headerSessionId;
  if (sessionId === undefined) throw new RuntimeError('INVALID_REQUEST', 'IRIS session is required; call session_open first.');
  if (state === undefined) throw new RuntimeError('INVALID_REQUEST', 'IRIS session validation is unavailable');
  return { clientId, sessionId, session: state.getSessionForClient(sessionId, clientId) };
}

function requiredExpectedEffects(record: Record<string, unknown>): readonly CapabilityEffect[] {
  const value = record.expectedEffects;
  if (!Array.isArray(value) || value.length < 2 || value.length > EFFECTS.length) {
    throw new RuntimeError('INVALID_REQUEST', 'expectedEffects must be a bounded effect array containing READ and NETWORK');
  }
  const result: CapabilityEffect[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !EFFECTS.some((effect) => effect === item)) {
      throw new RuntimeError('INVALID_REQUEST', 'expectedEffects contains an unsupported effect');
    }
    const effect = item as CapabilityEffect;
    if (!result.includes(effect)) result.push(effect);
  }
  if (!result.includes('READ') || !result.includes('NETWORK')) {
    throw new RuntimeError('INVALID_REQUEST', 'ADO expectedEffects must include READ and NETWORK');
  }
  return result;
}

function requiredHeader(request: Request, name: string): string {
  const value = optionalHeader(request, name);
  if (value === undefined) throw new RuntimeError('INVALID_REQUEST', `${name} is required`);
  return value;
}

function optionalHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 200 || value.includes('\0')) throw new RuntimeError('INVALID_REQUEST', `${name} is invalid`);
  return value;
}

function requiredBoundedString(record: Record<string, unknown>, name: string, maxLength: number): string {
  const value = record[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', `${name} must be a bounded non-empty string`);
  }
  return value;
}

function optionalBoundedString(record: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  if (record[name] === undefined) return undefined;
  return requiredBoundedString(record, name, maxLength);
}

function requiredPositiveInteger(record: Record<string, unknown>, name: string): number {
  const value = record[name];
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new RuntimeError('INVALID_REQUEST', `${name} must be a positive safe integer`);
  return Number(value);
}

function requiredIntegerInRange(record: Record<string, unknown>, name: string, min: number, max: number): number {
  const value = record[name];
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new RuntimeError('INVALID_REQUEST', `${name} must be an integer from ${min} through ${max}`);
  }
  return Number(value);
}

function optionalBoolean(record: Record<string, unknown>, name: string): boolean | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new RuntimeError('INVALID_REQUEST', `${name} must be boolean when provided`);
  return value;
}
