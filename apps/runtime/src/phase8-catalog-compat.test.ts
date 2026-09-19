import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { capabilityDefinition } from './capability-registry.js';
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

const ADDITIVE_TOOLS = ['owner_approval_resolve', 'workspace', 'fs', 'artifact', 'shell', 'job', 'git'] as const;

describe('Phase 8 two-version catalog compatibility', () => {
  it('AC-IRIS-005 + AC-COMPAT-004 preserves the exact 42-tool 2.3.0 legacy schemas in the 2.4.0 catalog', () => {
    expect(PHASE8_V230_CATALOG_FIXTURE.catalogVersion).toBe('2.3.0');
    expect(MCP_CATALOG_VERSION).toBe('2.4.0');
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
    expect(digest(payload)).toBe(PHASE8_V230_CATALOG_FIXTURE.legacyCompatibilityHash);

    const fullNames = catalogToolNames('FULL');
    expect(fullNames).toHaveLength(49);
    expect(fullNames.filter((name) => additive.has(name))).toEqual(ADDITIVE_TOOLS);
    expect(legacyEntries.every((entry) => entry.availability === 'ACTIVE')).toBe(true);
    expect(legacyEntries.every((entry) => !('deprecationVersion' in entry) && !('removalVersion' in entry))).toBe(true);
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
