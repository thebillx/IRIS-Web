import { describe, expect, it } from 'vitest';
import { LocalArtifactDocumentAdapter, SharePointExternalDocumentAdapter } from './provider-adapters.js';
import type { ExternalDocumentRequest } from './contract.js';

const request = (provider: 'sharepoint' | 'pdf' | 'excel'): ExternalDocumentRequest => ({
  requestId: 'request-1', projectId: 'bbl-wiki', connectorBindingId: 'binding-1', provider,
  operation: 'content', sourceId: provider === 'sharepoint' ? 'doc-1' : 'artifact-1', expectedVersion: null,
});
const context = { auth: { secret: 'opaque' }, signal: new AbortController().signal, expectedVersion: null,
  limits: { maxContentBytes: 1024, maxArtifacts: 4, timeoutMs: 1000 } };

describe('M9 provider adapters', () => {
  it('keeps SharePoint URL construction behind a typed source-id port', async () => {
    let received: unknown;
    const adapter = new SharePointExternalDocumentAdapter('sharepoint-read', {
      async status() { return 'available'; },
      async read(input) {
        received = input;
        return { sourceId: input.sourceId, version: 'v1', content: (async function* () { yield new TextEncoder().encode('text'); })(), artifacts: [] };
      },
    });
    const result = await adapter.acquire(request('sharepoint'), context);
    expect(result.sourceId).toBe('doc-1');
    expect(received).toMatchObject({ sourceId: 'doc-1', operation: 'content' });
    expect(JSON.stringify(received)).not.toContain('http');
  });

  it('binds local PDF/Excel extraction to artifact identity rather than a raw path', async () => {
    const seen: unknown[] = [];
    const port = {
      async status() { return 'available' as const; },
      async extract(input: unknown) {
        seen.push(input);
        const typed = input as { artifactId: string };
        return { sourceId: typed.artifactId, version: 'digest-v1', content: (async function* () { yield new Uint8Array(); })(), artifacts: [] };
      },
    };
    const pdf = new LocalArtifactDocumentAdapter('local-doc', 'pdf', port);
    const excel = new LocalArtifactDocumentAdapter('local-doc', 'excel', port);
    await pdf.acquire(request('pdf'), context);
    await excel.acquire(request('excel'), context);
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen)).not.toContain('/Users/');
    expect(JSON.stringify(seen)).toContain('artifact-1');
  });

  it('rejects provider substitution at the adapter boundary', async () => {
    const adapter = new SharePointExternalDocumentAdapter('sharepoint-read', {
      async status() { return 'available'; },
      async read() { throw new Error('should not run'); },
    });
    await expect(adapter.acquire(request('pdf'), context)).rejects.toThrow('PROVIDER_MISMATCH');
  });
});
