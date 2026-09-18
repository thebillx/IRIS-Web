import { createHash } from 'node:crypto';

export const MCP_CATALOG_VERSION = '2.3.0' as const;
export const MCP_SCHEMA_VERSION = '2026-07-28' as const;

export type McpCatalogProfile = 'FULL' | 'PRO';
export type McpMutationClass = 'READ_ONLY' | 'ORCHESTRATION' | 'PROJECT_MUTATION' | 'OWNER_MUTATION';
export type McpToolAvailability = 'ACTIVE' | 'READ_ONLY';

export interface McpCatalogEntry {
  readonly toolName: string;
  readonly profile: McpCatalogProfile;
  readonly schemaVersion: typeof MCP_SCHEMA_VERSION;
  readonly mutationClass: McpMutationClass;
  readonly capabilityId: string | null;
  readonly availability: McpToolAvailability;
  readonly introducedVersion: string;
}

export interface McpCatalogIdentity {
  readonly profile: McpCatalogProfile;
  readonly catalogVersion: typeof MCP_CATALOG_VERSION;
  readonly catalogHash: string;
  readonly toolCount: number;
}

export interface McpCatalogRuntimeContext {
  readonly runtimeId?: string | null;
  readonly instanceId?: string | null;
  readonly runtimeVersion?: string | null;
  readonly deploymentEpoch?: number | null;
}

const FULL_CATALOG = [
  entry('runtime_status', 'READ_ONLY', 'runtime.status', '2.0.0'),
  entry('list_projects', 'READ_ONLY', 'project.list', '2.0.0'),
  entry('project_info', 'READ_ONLY', 'project.info', '2.0.0'),
  entry('git_status', 'READ_ONLY', 'project.git_status', '2.0.0'),
  entry('search', 'READ_ONLY', 'project.search', '2.0.0'),
  entry('mission_list', 'READ_ONLY', 'mission.list', '2.0.0'),
  entry('session_open', 'READ_ONLY', 'session.create', '2.0.0'),
  entry('session_get', 'READ_ONLY', null, '2.0.0'),
  entry('session_close', 'ORCHESTRATION', 'session.delete', '2.0.0'),
  entry('workspace_select', 'ORCHESTRATION', 'session.current_project.set', '2.0.0'),
  entry('mission_list_waiting_supervisor', 'READ_ONLY', null, '2.1.0'),
  entry('mission_get', 'READ_ONLY', 'mission.get', '2.0.0'),
  entry('mission_events', 'READ_ONLY', null, '2.1.0'),
  entry('mission_directive', 'ORCHESTRATION', null, '2.0.0'),
  entry('mission_orchestrator_handoff', 'ORCHESTRATION', null, '2.0.0'),
  entry('mission_create', 'ORCHESTRATION', 'mission.create', '2.0.0'),
  entry('mission_state_set', 'ORCHESTRATION', 'mission.state.set', '2.0.0'),
  entry('mission_task_create', 'ORCHESTRATION', 'mission.task.create', '2.0.0'),
  entry('mission_task_state_set', 'ORCHESTRATION', 'mission.task.state.set', '2.0.0'),
  entry('mission_action_prepare', 'ORCHESTRATION', 'mission.action.prepare', '2.0.0'),
  entry('mission_supervisor_gate_set', 'ORCHESTRATION', 'mission.supervisor_gate.set', '2.1.0'),
  entry('project_test_run', 'PROJECT_MUTATION', 'project.test.run', '2.0.0'),
  entry('project_validation_run', 'PROJECT_MUTATION', 'project.command.run', '2.2.0'),
  entry('project_validation_discover', 'READ_ONLY', 'project.validation.discover', '2.3.0'),
  entry('project_validation_start', 'PROJECT_MUTATION', 'project.validation.start', '2.3.0'),
  entry('project_validation_job', 'READ_ONLY', 'project.validation.job.read', '2.3.0'),
  entry('git_local', 'PROJECT_MUTATION', 'git.local', '2.2.0'),
  entry('remote_publish', 'OWNER_MUTATION', 'remote.publish', '2.2.0'),
  entry('file_read', 'READ_ONLY', 'file.read', '2.0.0'),
  entry('file_write', 'PROJECT_MUTATION', 'file.write', '2.0.0'),
  entry('file_edit', 'PROJECT_MUTATION', 'file.edit', '2.3.0'),
  entry('file_delete', 'PROJECT_MUTATION', 'file.delete', '2.0.0'),
  entry('directory_create', 'PROJECT_MUTATION', 'directory.create', '2.0.0'),
  entry('directory_delete', 'PROJECT_MUTATION', 'directory.delete', '2.0.0'),
  entry('mission_start', 'ORCHESTRATION', 'mission.start', '2.1.0'),
  entry('mission_checkpoint', 'ORCHESTRATION', 'mission.checkpoint', '2.1.0'),
  entry('mission_resume', 'ORCHESTRATION', 'mission.resume', '2.1.0'),
  entry('mission_rebind', 'ORCHESTRATION', 'mission.session.rebind', '2.3.0'),
  entry('mission_cancel', 'ORCHESTRATION', 'mission.cancel', '2.1.0'),
  entry('mission_complete', 'ORCHESTRATION', 'mission.complete', '2.1.0'),
  entry('mission_evidence', 'ORCHESTRATION', 'mission.evidence', '2.1.0'),
  entry('catalog_identity', 'READ_ONLY', null, '2.3.0'),
] as const satisfies readonly McpCatalogEntry[];

const PRO_CATALOG = [
  entry('list_projects', 'READ_ONLY', 'project.list', '2.0.0', 'PRO'),
  entry('project_info', 'READ_ONLY', 'project.info', '2.0.0', 'PRO'),
  entry('git_status', 'READ_ONLY', 'project.git_status', '2.0.0', 'PRO'),
  entry('file_read', 'READ_ONLY', 'file.read', '2.0.0', 'PRO'),
  entry('search', 'READ_ONLY', 'project.search', '2.0.0', 'PRO'),
] as const satisfies readonly McpCatalogEntry[];

export function catalogEntries(profile: McpCatalogProfile): readonly McpCatalogEntry[] {
  return profile === 'FULL' ? FULL_CATALOG : PRO_CATALOG;
}

export function catalogToolNames(profile: McpCatalogProfile): readonly string[] {
  return catalogEntries(profile).map((entry) => entry.toolName);
}

export function orderToolDefinitions(profile: McpCatalogProfile, definitions: readonly unknown[]): readonly Record<string, unknown>[] {
  const byName = new Map<string, Record<string, unknown>>();
  const allowedNames = new Set(catalogToolNames(profile));
  for (const definition of definitions) {
    if (isRecord(definition) && typeof definition.name === 'string' && allowedNames.has(definition.name)) byName.set(definition.name, definition);
  }
  const ordered: Record<string, unknown>[] = [];
  for (const name of catalogToolNames(profile)) {
    const definition = byName.get(name);
    if (definition !== undefined) ordered.push(definition);
  }
  return ordered;
}

export function catalogIdentity(profile: McpCatalogProfile, definitions: readonly unknown[]): McpCatalogIdentity {
  const entries = definitions.map((definition) => {
    const name = isRecord(definition) && typeof definition.name === 'string' ? definition.name : 'invalid';
    const canonical = catalogEntries(profile).find((entry) => entry.toolName === name);
    return {
      ...(canonical ?? {
        toolName: name,
        profile,
        schemaVersion: MCP_SCHEMA_VERSION,
        mutationClass: 'READ_ONLY' as const,
        capabilityId: null,
        availability: 'ACTIVE' as const,
        introducedVersion: 'unknown',
      }),
      inputSchema: isRecord(definition) ? canonicalJson(definition.inputSchema ?? null) : null,
    };
  });
  const catalogHash = `sha256:${createHash('sha256').update(stableJson({ catalogVersion: MCP_CATALOG_VERSION, profile, entries })).digest('hex')}`;
  return { profile, catalogVersion: MCP_CATALOG_VERSION, catalogHash, toolCount: entries.length };
}

export function catalogIdentityPayload(
  profile: McpCatalogProfile,
  definitions: readonly unknown[],
  runtime: McpCatalogRuntimeContext = {},
): Record<string, unknown> {
  return {
    ...catalogIdentity(profile, definitions),
    runtimeId: runtime.runtimeId ?? null,
    instanceId: runtime.instanceId ?? null,
    runtimeVersion: runtime.runtimeVersion ?? null,
    deploymentEpoch: runtime.deploymentEpoch ?? null,
    connectorProfile: profile,
  };
}

function entry(
  toolName: string,
  mutationClass: McpMutationClass,
  capabilityId: string | null,
  introducedVersion: string,
  profile: McpCatalogProfile = 'FULL',
): McpCatalogEntry {
  return {
    toolName,
    profile,
    schemaVersion: MCP_SCHEMA_VERSION,
    mutationClass,
    capabilityId,
    availability: profile === 'PRO' ? 'READ_ONLY' : 'ACTIVE',
    introducedVersion,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
