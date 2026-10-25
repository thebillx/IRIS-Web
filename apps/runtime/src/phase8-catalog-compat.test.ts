import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { capabilityDefinition } from './capability-registry.js';
import { workloadMutationContract } from './durable-mutation-journal.js';
import {
  catalogEntries,
  catalogToolNames,
  MCP_CATALOG_VERSION,
  MCP_SCHEMA_VERSION,
} from './mcp-catalog.js';
import { fullMcpToolDefinitionsV21 } from './mcp-v21.js';
import { proMcpToolDefinitions } from './mcp.js';
import {
  PHASE8_COMPATIBILITY_WRAPPERS,
  PHASE8_V230_CATALOG_FIXTURE,
} from './phase8-catalog-v230-fixture.js';

const ADDITIVE_TOOLS = ['ado_discovery', 'ado_workitem_read', 'ado_hierarchy_read', 'ado_context_search', 'ado_backlog_list', 'session_resume', 'session_detach', 'mission_delegation_issue', 'mission_delegation_revoke', 'owner_approval_resolve', 'workspace', 'fs', 'artifact', 'shell', 'job', 'git', 'code_review', 'security_audit'] as const;

describe('Phase 8 two-version catalog compatibility', () => {
  it('AC-IRIS-005 + AC-COMPAT-004 preserves the 42 legacy contracts except the explicitly approved durable-session and mission additions', () => {
    expect(PHASE8_V230_CATALOG_FIXTURE.catalogVersion).toBe('2.3.0');
    expect(MCP_CATALOG_VERSION).toBe('2.8.0');
    expect(MCP_SCHEMA_VERSION).toBe(PHASE8_V230_CATALOG_FIXTURE.schemaVersion);

    const fullDefinitions = fullMcpToolDefinitionsV21();
    const fullByName = new Map(fullDefinitions.map((definition) => [definition.name, definition]));
    const additive = new Set<string>(ADDITIVE_TOOLS);
    const legacyEntries = catalogEntries('FULL').filter((entry) => !additive.has(entry.toolName));

    expect(legacyEntries.map((entry) => entry.toolName)).toEqual(PHASE8_V230_CATALOG_FIXTURE.legacyToolNames);
    expect(legacyEntries).toHaveLength(42);

    const payload = legacyEntries.map((entry) => ({
      toolName: entry.toolName,
      capabilityId: entry.capabilityId,
      mutationClass: entry.mutationClass,
      availability: entry.availability,
      inputSchema: fullByName.get(entry.toolName)?.inputSchema ?? null,
    }));
    // Keep the historical hash: only the separately asserted durable-contract changes are projected out.
    expect(digest(payload.map(projectApprovedChangesToLegacy))).toBe(PHASE8_V230_CATALOG_FIXTURE.legacyCompatibilityHash);

    const fullNames = catalogToolNames('FULL');
    expect(fullNames).toHaveLength(60);
    expect(fullNames.filter((name) => additive.has(name))).toEqual(ADDITIVE_TOOLS);
    expect(legacyEntries.every((entry) => entry.availability === 'ACTIVE')).toBe(true);
    expect(legacyEntries.every((entry) => !('deprecationVersion' in entry) && !('removalVersion' in entry))).toBe(true);
  });

  it('publishes explicit conversation correlation and revision-bound session transitions', () => {
    const byName = new Map(fullMcpToolDefinitionsV21().map((definition) => [definition.name, definition]));
    const sessionId = { type: 'string', description: 'IRIS runtime session UUID returned by session_open. May be omitted only by compatible clients that send x-iris-session-id.' };
    const requestId = { type: 'string', minLength: 1, maxLength: 200 };
    const expectedRevision = { type: 'integer', minimum: 1 };
    expect(byName.get('session_open')?.inputSchema).toEqual({
      type: 'object', required: ['conversationId', 'requestId'],
      properties: { conversationId: requestId, requestId }, additionalProperties: false,
    });
    for (const toolName of ['session_close', 'session_resume', 'session_detach']) {
      expect(byName.get(toolName)?.inputSchema, toolName).toEqual({
        type: 'object', required: ['sessionId', 'requestId', 'expectedRevision'],
        properties: { sessionId, requestId, expectedRevision }, additionalProperties: false,
      });
    }
    expect(byName.get('workspace_select')?.inputSchema).toEqual({
      type: 'object', required: ['projectId', 'requestId', 'expectedRevision'],
      properties: { sessionId, requestId, expectedRevision, workspaceId: { type: 'string' }, projectId: { type: 'string', description: 'Registered project ID returned by list_projects.' } },
      additionalProperties: false,
    });
    const entries = new Map(catalogEntries('FULL').map((entry) => [entry.toolName, entry]));
    for (const [name, operation] of Object.entries({ session_open: 'ensure', session_close: 'close', session_resume: 'resume', session_detach: 'detach', workspace_select: 'select' })) {
      expect(entries.get(name)?.mutationClass, name).toBe('ORCHESTRATION');
      const args = name === 'session_open'
        ? { conversationId: 'conversation-1', requestId: 'request-1' }
        : { sessionId: 'session-1', requestId: 'request-1', expectedRevision: 1 };
      expect(workloadMutationContract(name, args)).toEqual({ contractId: `session.${operation}.v1`, requestId: 'request-1', requiresSession: name !== 'session_open' });
      expect(() => workloadMutationContract(name, { ...args, requestId: undefined })).toThrow();
      if (name !== 'session_open') expect(() => workloadMutationContract(name, { ...args, expectedRevision: 0 })).toThrow();
    }
    expect(() => workloadMutationContract('session_open', { requestId: 'request-1' })).toThrow();
  });

  it('adds bounded mission request identities while retaining the legacy rebind schema requirements', () => {
    const byName = new Map(fullMcpToolDefinitionsV21().map((definition) => [definition.name, definition]));
    for (const name of ['mission_create', 'mission_rebind']) {
      const schema = byName.get(name)!.inputSchema as ObjectSchema;
      expect(schema.properties.requestId, name).toEqual({ type: 'string', minLength: 1, maxLength: 200 });
      expect(schema.required, name).toEqual(name === 'mission_create' ? ['title', 'requestId'] : ['missionId', 'projectId', 'expectedBindingRevision']);
      expect(workloadMutationContract(name, { requestId: 'request-1' })).toEqual({ contractId: name === 'mission_create' ? 'mission.create.v1' : 'mission.rebind.v1', requestId: 'request-1', requiresSession: true });
      expect(() => workloadMutationContract(name, {})).toThrow();
      expect(() => workloadMutationContract(name, { requestId: 'x'.repeat(201) })).toThrow();
    }
  });

  it('keeps all 15 wrapper capability IDs registered while the grouped tools remain additive', () => {
    const byName = new Map(catalogEntries('FULL').map((entry) => [entry.toolName, entry]));
    for (const toolName of PHASE8_COMPATIBILITY_WRAPPERS) {
      const entry = byName.get(toolName);
      expect(entry, toolName).toBeDefined();
      expect(entry?.capabilityId, toolName).not.toBeNull();
      expect(capabilityDefinition(String(entry?.capabilityId)), toolName).not.toBeNull();
    }
    for (const name of ADDITIVE_TOOLS) {
      expect(byName.get(name)?.availability, name).toBe('ACTIVE');
    }
  });

  it('keeps PRO exactly five read-only tools with unchanged 2.3.0 schemas', () => {
    const definitions = proMcpToolDefinitions();
    const byName = new Map(definitions.map((definition) => [definition.name, definition]));
    const entries = catalogEntries('PRO');

    expect(catalogToolNames('PRO')).toEqual(PHASE8_V230_CATALOG_FIXTURE.proToolNames);
    expect(entries).toHaveLength(5);
    expect(entries.every((entry) => entry.availability === 'READ_ONLY' && entry.mutationClass === 'READ_ONLY')).toBe(true);

    const payload = entries.map((entry) => ({
      toolName: entry.toolName,
      capabilityId: entry.capabilityId,
      mutationClass: entry.mutationClass,
      availability: entry.availability,
      inputSchema: byName.get(entry.toolName)?.inputSchema ?? null,
    }));
    expect(digest(payload)).toBe(PHASE8_V230_CATALOG_FIXTURE.proCompatibilityHash);
  });
});

interface ObjectSchema {
  type: string;
  required?: string[];
  properties: Record<string, unknown>;
  additionalProperties: boolean;
}

function projectApprovedChangesToLegacy<T extends { toolName: string; mutationClass: string; inputSchema: unknown }>(entry: T): T {
  const projected = structuredClone(entry);
  const schema = projected.inputSchema as ObjectSchema;
  if (entry.toolName === 'session_open') {
    projected.mutationClass = 'READ_ONLY';
    delete schema.required;
    delete schema.properties.conversationId;
    delete schema.properties.requestId;
  } else if (entry.toolName === 'session_close') {
    delete schema.required;
    delete schema.properties.requestId;
    delete schema.properties.expectedRevision;
  } else if (entry.toolName === 'workspace_select') {
    schema.required = schema.required!.filter((field) => !['requestId', 'expectedRevision'].includes(field));
    delete schema.properties.requestId;
    delete schema.properties.expectedRevision;
    delete schema.properties.workspaceId;
  } else if (entry.toolName === 'mission_create') {
    schema.required = schema.required!.filter((field) => field !== 'requestId');
    delete schema.properties.requestId;
  } else if (entry.toolName === 'mission_rebind') {
    delete schema.properties.requestId;
  }
  return projected;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}
