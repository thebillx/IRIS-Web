import { describe, expect, it } from 'vitest';
import { catalogIdentity, catalogIdentityAtVersion, catalogToolNames, MCP_CATALOG_VERSION, orderToolDefinitions } from './mcp-catalog.js';
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

  it('derives a version-bound PRO identity without changing the five-tool schema surface', () => {
    const definitions = proMcpToolDefinitions();
    const v23 = catalogIdentityAtVersion('PRO', definitions, '2.3.0');
    const v24 = catalogIdentityAtVersion('PRO', definitions, '2.4.0');
    const v25 = catalogIdentityAtVersion('PRO', definitions, '2.5.0');
    const v26 = catalogIdentityAtVersion('PRO', definitions, '2.6.0');

    expect(v23).toMatchObject({ profile: 'PRO', catalogVersion: '2.3.0', toolCount: 5 });
    expect(v24).toMatchObject({ profile: 'PRO', catalogVersion: '2.4.0', toolCount: 5 });
    expect(v25).toMatchObject({ profile: 'PRO', catalogVersion: '2.5.0', toolCount: 5 });
    expect(v26).toMatchObject({ profile: 'PRO', catalogVersion: '2.6.0', toolCount: 5 });
    expect(v23.catalogHash).toBe('sha256:8952f22b28a5fc43b99a215455a024a7d422acb8d0da7d5d4f4b037e73e9f363');
    expect(v24.catalogHash).toBe('sha256:93f69d86d1b010b7ad7756c186d93dd4edf59cdb17cbc93fd308c72c2f303e09');
    expect(v23.catalogHash).not.toBe(v24.catalogHash);
    expect(v24.catalogHash).not.toBe(v25.catalogHash);
    expect(v25.catalogHash).not.toBe(v26.catalogHash);
    expect(MCP_CATALOG_VERSION).toBe('2.6.0');
    expect(catalogIdentity('PRO', definitions)).toEqual(v26);
  });

  it('keeps the exact read-only PRO allowlist separate from governed FULL tools', () => {
    expect(proMcpToolDefinitions().map((definition) => definition.name)).toEqual([
      'list_projects', 'project_info', 'git_status', 'file_read', 'search',
    ]);
    expect(catalogToolNames('PRO')).not.toContain('project_validation_run');
    expect(catalogToolNames('PRO')).not.toContain('git_local');
    expect(catalogToolNames('PRO')).not.toContain('remote_publish');
    expect(catalogToolNames('PRO')).not.toContain('mission_rebind');
    for (const name of ['ado_discovery','ado_workitem_read','ado_hierarchy_read','ado_context_search']) {
      expect(catalogToolNames('FULL')).toContain(name);
      expect(catalogToolNames('PRO')).not.toContain(name);
    }
  });

  it('orders the live definitions by the canonical catalog rather than handler declaration order', () => {
    const definitions = fullMcpToolDefinitionsV21().toReversed();
    expect(orderToolDefinitions('FULL', definitions).map((definition) => definition.name)).toEqual(catalogToolNames('FULL'));
    expect(orderToolDefinitions('FULL', [...definitions, { name: 'unregistered_tool' }]).map((definition) => definition.name)).toEqual(catalogToolNames('FULL'));
  });
});
