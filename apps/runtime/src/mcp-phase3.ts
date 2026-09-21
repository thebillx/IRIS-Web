import type { CapabilityEffect } from '@iris/domain';
import { RuntimeError } from '@iris/domain';
import type { CapabilityOutcome, CapabilityService } from './capability-service.js';
import { resolveDirectSessionIdentity, type DirectSessionIdentity } from './mcp-direct-context.js';
import type { McpPrincipal } from './mcp.js';
import type { RuntimeState } from './state.js';

const EFFECTS = ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const satisfies readonly CapabilityEffect[];

export const PHASE3_GROUPED_TOOL_NAMES = ['shell', 'job'] as const;
export type Phase3GroupedToolName = (typeof PHASE3_GROUPED_TOOL_NAMES)[number];

export function isPhase3GroupedTool(name: string): name is Phase3GroupedToolName {
  return PHASE3_GROUPED_TOOL_NAMES.some((candidate) => candidate === name);
}

export function phase3GroupedToolDefinitions(): readonly Record<string, unknown>[] {
  const sessionId = { sessionId: { type: 'string', description: 'Optional explicit IRIS runtime session UUID. Authenticated tunnel connectors may omit it and use project-bound direct context.' } };
  const projectId = { projectId: { type: 'string', description: 'Registered project UUID; direct context is isolated to this project.' } };
  const workspaceId = { workspaceId: { type: 'string', description: 'Opaque ACTIVE IRIS workspace UUID.' } };
  const expectedEffects = {
    expectedEffects: {
      type: 'array', maxItems: 5, uniqueItems: true, items: { enum: EFFECTS },
      description: 'Surprise-prevention assertion only. Server-derived effects remain authoritative.',
    },
  };
  return [
    {
      name: 'shell',
      description: 'Governed vNext local process execution using server-owned execution profiles, explicit executable+argv, ACTIVE workspace cwd, bounded/redacted output, and no implicit shell string.',
      inputSchema: {
        type: 'object',
        required: ['operation','projectId','workspaceId','executable','argv','cwd','executionProfile','envOverrides','timeoutMs'],
        properties: {
          ...sessionId, ...projectId, ...workspaceId,
          operation: { enum: ['run','start'] },
          executable: { type: 'string', minLength: 1, maxLength: 120 },
          argv: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 4096 } },
          cwd: { type: 'string', minLength: 1, maxLength: 4000, description: 'Workspace-relative cwd only.' },
          executionProfile: { type: 'string', minLength: 1, maxLength: 120 },
          envOverrides: { type: 'object', maxProperties: 32, additionalProperties: { type: 'string', maxLength: 8192 } },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 3600000 },
          requestId: { type: 'string', minLength: 1, maxLength: 200, description: 'Required for shell.start idempotency.' },
          stdinArtifactId: { type: 'string', minLength: 1, maxLength: 200 },
          ...expectedEffects,
        },
        additionalProperties: false,
      },
    },
    {
      name: 'job',
      description: 'Read/cancel governed durable Phase 3 jobs. Logs are cursor/window based and process cancellation fails closed on ambiguous ownership.',
      inputSchema: {
        type: 'object',
        required: ['operation','projectId','jobId'],
        properties: {
          ...sessionId, ...projectId,
          operation: { enum: ['status','logs','result','cancel'] },
          jobId: { type: 'string', minLength: 1, maxLength: 200 },
          stream: { enum: ['stdout','stderr'] },
          cursor: { type: 'string', maxLength: 2048 },
          maxBytes: { type: 'integer', minimum: 1, maximum: 65536 },
          ...expectedEffects,
        },
        additionalProperties: false,
      },
    },
  ];
}

export async function executePhase3GroupedTool(
  name: Phase3GroupedToolName,
  args: Record<string, unknown>,
  request: Request,
  capabilities: CapabilityService,
  state: RuntimeState | undefined,
  principal: McpPrincipal = 'owner',
): Promise<CapabilityOutcome> {
  assertOnlyPhase3Keys(name, args);
  const projectId = requiredBoundedString(args, 'projectId', 200);
  const identity = await resolveDirectSessionIdentity(args, request, state, projectId, principal);
  const expectedEffects = optionalExpectedEffects(args);
  if (name === 'shell') return executeShell(args, identity, projectId, expectedEffects, capabilities);
  return executeJob(args, identity, projectId, expectedEffects, capabilities);
}

async function executeShell(
  args: Record<string, unknown>, identity: DirectSessionIdentity, projectId: string,
  expectedEffects: readonly CapabilityEffect[] | undefined, capabilities: CapabilityService,
): Promise<CapabilityOutcome> {
  const operation = requiredEnum(args, 'operation', ['run','start'] as const);
  const workspaceId = requiredBoundedString(args, 'workspaceId', 200);
  const executable = requiredBoundedString(args, 'executable', 120);
  const argv = requiredStringArray(args, 'argv', 128, 4096);
  const cwd = requiredBoundedString(args, 'cwd', 4000);
  const executionProfile = requiredBoundedString(args, 'executionProfile', 120);
  const envOverrides = requiredStringMap(args, 'envOverrides', 32, 8192);
  const timeoutMs = requiredInteger(args, 'timeoutMs', 100, 3_600_000);
  const stdinArtifactId = optionalBoundedString(args, 'stdinArtifactId', 200);
  const common = {
    ...identity, projectId, workspaceId, executable, argv, cwd, executionProfile, envOverrides, timeoutMs, expectedEffects,
    ...(stdinArtifactId === undefined ? {} : { stdinArtifactId }),
  };
  if (operation === 'run') return capabilities.execute({ capabilityId: 'shell.run', ...common });
  return capabilities.execute({ capabilityId: 'shell.start', ...common, requestId: requiredBoundedString(args, 'requestId', 200) });
}

async function executeJob(
  args: Record<string, unknown>, identity: DirectSessionIdentity, projectId: string,
  expectedEffects: readonly CapabilityEffect[] | undefined, capabilities: CapabilityService,
): Promise<CapabilityOutcome> {
  const operation = requiredEnum(args, 'operation', ['status','logs','result','cancel'] as const);
  const jobId = requiredBoundedString(args, 'jobId', 200);
  const effects = expectedEffects === undefined ? {} : { expectedEffects };
  if (operation === 'status') return capabilities.execute({ capabilityId: 'job.status', ...identity, projectId, jobId, ...effects });
  if (operation === 'result') return capabilities.execute({ capabilityId: 'job.result', ...identity, projectId, jobId, ...effects });
  if (operation === 'cancel') return capabilities.execute({ capabilityId: 'job.cancel', ...identity, projectId, jobId, ...effects });
  const cursor = optionalBoundedString(args, 'cursor', 2048);
  const maxBytes = optionalInteger(args, 'maxBytes', 1, 65536);
  return capabilities.execute({
    capabilityId: 'job.logs', ...identity, projectId, jobId, stream: requiredEnum(args, 'stream', ['stdout','stderr'] as const),
    ...(cursor === undefined ? {} : { cursor }), ...(maxBytes === undefined ? {} : { maxBytes }), ...effects,
  });
}

const SHELL_KEYS = new Set(['operation','sessionId','projectId','workspaceId','executable','argv','cwd','executionProfile','envOverrides','timeoutMs','requestId','stdinArtifactId','expectedEffects']);
const JOB_KEYS = new Set(['operation','sessionId','projectId','jobId','stream','cursor','maxBytes','expectedEffects']);

function assertOnlyPhase3Keys(name: Phase3GroupedToolName, args: Record<string, unknown>): void {
  const allowed = name === 'shell' ? SHELL_KEYS : JOB_KEYS;
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new RuntimeError('INVALID_REQUEST', `Unsupported ${name} field: ${key}`);
  }
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
  if (record[name] === undefined) return undefined; return requiredBoundedString(record, name, maxLength);
}
function requiredInteger(record: Record<string, unknown>, name: string, min: number, max: number): number {
  const value = record[name]; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new RuntimeError('INVALID_REQUEST', `${name} must be an integer from ${min} through ${max}`); return value;
}
function optionalInteger(record: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  if (record[name] === undefined) return undefined; return requiredInteger(record, name, min, max);
}
function requiredEnum<const T extends readonly string[]>(record: Record<string, unknown>, name: string, allowed: T): T[number] {
  const value = record[name]; if (typeof value === 'string' && allowed.some((candidate) => candidate === value)) return value as T[number]; throw new RuntimeError('INVALID_REQUEST', `${name} is not a supported value`);
}
function requiredStringArray(record: Record<string, unknown>, name: string, maxItems: number, maxItemLength: number): readonly string[] {
  const value = record[name];
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === 'string' && item.length <= maxItemLength && !item.includes('\0'))) throw new RuntimeError('INVALID_REQUEST', `${name} must be a bounded string array`);
  return value as string[];
}
function requiredStringMap(record: Record<string, unknown>, name: string, maxItems: number, maxValueLength: number): Readonly<Record<string, string>> {
  const value = record[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RuntimeError('INVALID_REQUEST', `${name} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > maxItems || entries.some(([key, item]) => key.length === 0 || key.length > 120 || key.includes('\0') || typeof item !== 'string' || item.length > maxValueLength || item.includes('\0'))) throw new RuntimeError('INVALID_REQUEST', `${name} contains an invalid environment override`);
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}
