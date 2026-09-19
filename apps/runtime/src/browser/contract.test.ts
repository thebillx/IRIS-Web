import { describe, expect, it } from 'vitest';
import {
  BrowserContractError,
  BrowserResponseBudget,
  assertConnectedAddress,
  assertResponsePolicy,
  assertSignalActive,
  bindBrowserRequest,
  bindRedirect,
  bindResolution,
  revalidateResolution,
  type BrowserGrant,
} from './contract.js';

const grant: BrowserGrant = {
  projectId: 'project-p7',
  browserBindingId: 'browser-binding-1',
  sessionRef: 'session-ref-1',
  network: 'allowed',
  allowedOrigins: ['https://example.com', 'https://cdn.example.com', 'http://localhost:43110'],
  allowLocalhostHttp: true,
  outputWorkspaceId: 'workspace-p7' as BrowserGrant['outputWorkspaceId'],
  expiresAt: '2026-10-01T00:00:00.000Z',
  revoked: false,
  limits: {
    maxRedirects: 3,
    maxResponseBytes: 1024,
    maxDecompressionRatio: 10,
    timeoutMs: 5000,
    allowedContentTypes: ['text/html', 'application/json', 'application/octet-stream'],
  },
};

const request = {
  requestId: 'browser-request-1',
  projectId: grant.projectId,
  browserBindingId: grant.browserBindingId,
  method: 'GET' as const,
  mode: 'navigate' as const,
  url: 'https://example.com/path?q=1#fragment',
};

const now = Date.parse('2026-09-19T00:00:00.000Z');

function code(fn: () => unknown): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof BrowserContractError ? error.code : String(error);
  }
}

describe('Phase 7 browser contract', () => {
  it('binds only the typed GET/HEAD surface and strips fragments', () => {
    const bound = bindBrowserRequest(grant, request, now);
    expect(bound.url).toBe('https://example.com/path?q=1');
    expect(bound.origin).toBe('https://example.com');
    expect(bound.redirectMode).toBe('manual');
    expect(bound.outputWorkspaceId).toBe(grant.outputWorkspaceId);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.limits.allowedContentTypes)).toBe(true);
    expect(JSON.stringify(bound)).not.toContain(grant.sessionRef);
    expect(bound).not.toHaveProperty('headers');
    expect(bound).not.toHaveProperty('script');
    expect(bound).not.toHaveProperty('outputPath');
  });

  it('rejects arbitrary origin, credentials, non-HTTPS public targets and internal hostnames', () => {
    expect(code(() => bindBrowserRequest(grant, { ...request, url: 'https://evil.example/' }, now))).toBe('URL_NOT_ALLOWED');
    expect(code(() => bindBrowserRequest(grant, { ...request, url: 'https://user:pass@example.com/' }, now))).toBe('URL_NOT_ALLOWED');
    expect(code(() => bindBrowserRequest({ ...grant, allowedOrigins: ['http://example.com'] }, { ...request, url: 'http://example.com/' }, now))).toBe('POLICY_INVALID');
    expect(code(() => bindBrowserRequest({ ...grant, allowedOrigins: ['https://service.internal'] }, { ...request, url: 'https://service.internal/' }, now))).toBe('POLICY_INVALID');
  });

  it('permits HTTP loopback only through the explicit localhost grant', () => {
    const local = bindBrowserRequest(grant, { ...request, url: 'http://localhost:43110/health' }, now);
    expect(local.resolutionPolicy).toBe('LOOPBACK_ONLY');
    expect(bindResolution(local, ['127.0.0.1']).addresses).toEqual(['127.0.0.1']);
    expect(code(() => bindBrowserRequest({ ...grant, allowLocalhostHttp: false }, { ...request, url: 'http://localhost:43110/health' }, now))).toBe('POLICY_INVALID');

    const subdomainGrant = { ...grant, allowedOrigins: [...grant.allowedOrigins, 'http://worker.localhost:43110'] };
    const subdomain = bindBrowserRequest(subdomainGrant, { ...request, url: 'http://worker.localhost:43110/health' }, now);
    expect(subdomain.resolutionPolicy).toBe('LOOPBACK_ONLY');
    expect(code(() => bindResolution(subdomain, ['93.184.216.34']))).toBe('SSRF_DENIED');
  });

  it('denies private, link-local, metadata and IPv6 local resolution for public targets', () => {
    const bound = bindBrowserRequest(grant, request, now);
    for (const address of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '127.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', 'fd00::1', 'fe80::1', 'fec0::1', '2001:db8::1', '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe']) {
      expect(code(() => bindResolution(bound, [address]))).toBe('SSRF_DENIED');
    }
    expect(bindResolution(bound, ['93.184.216.34']).addresses).toEqual(['93.184.216.34']);
    expect(bindResolution(bound, ['2606:4700:4700::1111']).addresses).toEqual(['2606:4700:4700::1111']);
  });

  it('denies alternate numeric IPv4 URL forms after URL canonicalization', () => {
    for (const rawHost of ['2130706433', '0x7f000001', '127.1']) {
      const url = new URL(`https://${rawHost}/`);
      const numericGrant = {
        ...grant,
        allowLocalhostHttp: false,
        allowedOrigins: [url.origin],
      };
      expect(code(() => bindBrowserRequest(numericGrant, {
        ...request,
        url: url.toString(),
      }, now))).toBe('SSRF_DENIED');
    }
  });

  it('blocks the IPv4 special-use 192.0.0.0/24 space while preserving its globally reachable anycast exceptions', () => {
    const bound = bindBrowserRequest(grant, request, now);
    for (const address of ['192.0.0.0', '192.0.0.8', '192.0.0.11', '192.0.0.170', '192.0.0.171', '192.0.0.255']) {
      expect(code(() => bindResolution(bound, [address]))).toBe('SSRF_DENIED');
    }
    for (const address of ['192.0.0.9', '192.0.0.10']) {
      expect(bindResolution(bound, [address]).addresses).toEqual([address]);
    }
  });

  it('blocks IPv6 special/translation ranges without blanket-blocking globally reachable IETF exceptions', () => {
    const bound = bindBrowserRequest(grant, request, now);

    for (const address of [
      '::7f00:1',
      '::ffff:7f00:1',
      '64:ff9b::c0a8:101',
      '64:ff9b:1::1',
      '100::1',
      '100:0:0:1::1',
      '2001::1',
      '2001:2::1',
      '2001:10::1',
      '2001:db8::1',
      '2002:c0a8:101::1',
      '3fff::1',
      '5f00::1',
      'fc00::1',
      'fe80::1',
      'fec0::1',
      'ff02::1',
    ]) {
      expect(code(() => bindResolution(bound, [address]))).toBe('SSRF_DENIED');
    }

    for (const address of [
      '2001:1::1',
      '2001:1::2',
      '2001:3::1',
      '2001:4:112::1',
      '2001:20::1',
      '2001:30::1',
      '2620:4f:8000::1',
    ]) {
      expect(bindResolution(bound, [address]).addresses).toEqual([address]);
    }
  });

  it('fails closed when DNS answers change after the first safe binding', () => {
    const bound = bindBrowserRequest(grant, request, now);
    const resolution = bindResolution(bound, ['93.184.216.34']);
    expect(revalidateResolution(resolution, ['93.184.216.34'])).toBe(resolution);
    expect(code(() => revalidateResolution(resolution, ['93.184.216.35']))).toBe('DNS_CHANGED');
    expect(code(() => revalidateResolution(resolution, ['127.0.0.1']))).toBe('SSRF_DENIED');
  });

  it('pins the actual connected address to the validated DNS answer set', () => {
    const bound = bindBrowserRequest(grant, request, now);
    const resolution = bindResolution(bound, ['93.184.216.34']);
    expect(assertConnectedAddress(resolution, '93.184.216.34')).toBe('93.184.216.34');
    expect(code(() => assertConnectedAddress(resolution, '93.184.216.35'))).toBe('DNS_CHANGED');
    expect(code(() => assertConnectedAddress(resolution, '127.0.0.1'))).toBe('SSRF_DENIED');
  });

  it('enforces streaming response/decompression budgets before completion', () => {
    const bound = bindBrowserRequest(grant, request, now);
    const budget = new BrowserResponseBudget(bound, 'text/html; charset=utf-8');
    expect(budget.observeTransportBytes(100).transportBytes).toBe(100);
    expect(budget.observeDecodedBytes(500).decodedBytes).toBe(500);
    expect(() => budget.assertElapsed(1000)).not.toThrow();
    expect(code(() => budget.observeDecodedBytes(501))).toBe('DECOMPRESSION_LIMIT');

    const transport = new BrowserResponseBudget(bound, 'text/html');
    expect(code(() => transport.observeTransportBytes(1025))).toBe('RESPONSE_LIMIT');
  });

  it('revalidates every redirect target and enforces redirect count', () => {
    const bound = bindBrowserRequest(grant, request, now);
    const redirected = bindRedirect(grant, bound, 'https://cdn.example.com/file', 0, now);
    expect(redirected.origin).toBe('https://cdn.example.com');
    expect(code(() => bindRedirect(grant, bound, 'https://evil.example/', 0, now))).toBe('URL_NOT_ALLOWED');
    expect(code(() => bindRedirect(grant, bound, '/again', 3, now))).toBe('REDIRECT_LIMIT');
  });

  it('enforces content type, byte, decompression and timeout bounds', () => {
    const bound = bindBrowserRequest(grant, request, now);
    expect(() => assertResponsePolicy(bound, {
      contentType: 'text/html; charset=utf-8',
      compressedBytes: 100,
      decompressedBytes: 500,
      elapsedMs: 1000,
    })).not.toThrow();
    expect(code(() => assertResponsePolicy(bound, {
      contentType: 'image/svg+xml', compressedBytes: 100, decompressedBytes: 100, elapsedMs: 10,
    }))).toBe('CONTENT_TYPE_DENIED');
    expect(code(() => assertResponsePolicy(bound, {
      contentType: 'text/html', compressedBytes: 100, decompressedBytes: 1025, elapsedMs: 10,
    }))).toBe('RESPONSE_LIMIT');
    expect(code(() => assertResponsePolicy(bound, {
      contentType: 'text/html', compressedBytes: 10, decompressedBytes: 101, elapsedMs: 10,
    }))).toBe('DECOMPRESSION_LIMIT');
    expect(code(() => assertResponsePolicy(bound, {
      contentType: 'text/html', compressedBytes: 100, decompressedBytes: 100, elapsedMs: 5001,
    }))).toBe('TIMEOUT');
  });

  it('exposes cancellation as a fail-closed contract signal', () => {
    const controller = new AbortController();
    expect(() => assertSignalActive(controller.signal)).not.toThrow();
    controller.abort();
    expect(code(() => assertSignalActive(controller.signal))).toBe('CANCELLED');
  });

  it('rejects malformed runtime identities and oversized opaque authority before semantic checks', () => {
    expect(code(() => bindBrowserRequest(grant, {
      ...request,
      requestId: undefined as never,
    }, now))).toBe('INVALID_REQUEST');
    expect(code(() => bindBrowserRequest({
      ...grant,
      projectId: undefined as never,
    }, request, now))).toBe('POLICY_INVALID');
    expect(code(() => bindBrowserRequest({
      ...grant,
      outputWorkspaceId: undefined as never,
    }, request, now))).toBe('POLICY_INVALID');
    expect(code(() => bindBrowserRequest({
      ...grant,
      sessionRef: 'x'.repeat(2049),
    }, request, now))).toBe('POLICY_INVALID');
  });

  it('rejects expired, revoked and network-disabled grants before navigation', () => {
    expect(code(() => bindBrowserRequest({ ...grant, expiresAt: '2026-09-01T00:00:00.000Z' }, request, now))).toBe('EXPIRED_AUTH');
    expect(code(() => bindBrowserRequest({ ...grant, revoked: true }, request, now))).toBe('REVOKED_AUTH');
    expect(code(() => bindBrowserRequest({ ...grant, network: 'disabled' }, request, now))).toBe('NETWORK_DISABLED');
  });
});
