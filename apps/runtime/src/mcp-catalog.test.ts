import { describe, expect, it } from 'vitest';
import { catalogIdentity, catalogToolNames, orderToolDefinitions } from './mcp-catalog.js';
import { fullMcpToolDefinitionsV21 } from './mcp-v21.js';
import { proMcpToolDefinitions } from './mcp.js';

describe('canonical MCP catalog', () => {
  it('produces a deterministic identity and changes it for schema changes', () => {
    const definitions = fullMcpToolDefinitionsV21();
    const first = catalogIdentity('FULL', definitions);
    const second = catalogIdentity('FULL', definitions.map((definition) => ({ ...definition })));
    expect(first).toEqual(second);
    expect(first.toolCount).toBe(catalogToolNames('FULL').length);

    const changed = definitions.map((definition) => definition.name === 'git_local'
      ? { ...definition, inputSchema: { type: 'object', properties: { changed: { type: 'boolean' } } } }
      : definition);
    expect(catalogIdentity('FULL', changed).catalogHash).not.toBe(first.catalogHash);
  });

  it('keeps the exact read-only PRO allowlist separate from governed FULL tools', () => {
    expect(proMcpToolDefinitions().map((definition) => definition.name)).toEqual([
      'list_projects', 'project_info', 'git_status', 'file_read', 'search',
    ]);
    expect(catalogToolNames('PRO')).not.toContain('project_validation_run');
    expect(catalogToolNames('PRO')).not.toContain('git_local');
    expect(catalogToolNames('PRO')).not.toContain('remote_publish');
    expect(catalogToolNames('PRO')).not.toContain('mission_rebind');
  });

  it('orders the live definitions by the canonical catalog rather than handler declaration order', () => {
    const definitions = fullMcpToolDefinitionsV21().toReversed();
    expect(orderToolDefinitions('FULL', definitions).map((definition) => definition.name)).toEqual(catalogToolNames('FULL'));
    expect(orderToolDefinitions('FULL', [...definitions, { name: 'unregistered_tool' }]).map((definition) => definition.name)).toEqual(catalogToolNames('FULL'));
  });
});
