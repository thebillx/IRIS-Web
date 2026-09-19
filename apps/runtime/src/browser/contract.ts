import { BlockList, isIP } from 'node:net';
import type { ArtifactReference, WorkspaceId } from '@iris/domain';

export const browserMethods = ['GET', 'HEAD'] as const;
export const browserModes = ['navigate', 'download'] as const;
export type BrowserMethod = typeof browserMethods[number];
export type BrowserMode = typeof browserModes[number];

export type BrowserFailureCode =
  | 'INVALID_REQUEST'
  | 'POLICY_INVALID'
  | 'UNAUTHORIZED'
  | 'EXPIRED_AUTH'
  | 'REVOKED_AUTH'
  | 'NETWORK_DISABLED'
  | 'URL_NOT_ALLOWED'
  | 'SSRF_DENIED'
  | 'REDIRECT_LIMIT'
  | 'DNS_CHANGED'
  | 'CONTENT_TYPE_DENIED'
  | 'RESPONSE_LIMIT'
  | 'DECOMPRESSION_LIMIT'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'ADAPTER_TRANSITION_DENIED'
  | 'SCOPE_WIDENING';

export interface BrowserGrant {
  readonly projectId: string;
  readonly browserBindingId: string;
  readonly sessionRef: string;
  readonly network: 'allowed' | 'disabled';
  readonly allowedOrigins: readonly string[];
  readonly allowLocalhostHttp: boolean;
  readonly outputWorkspaceId: WorkspaceId;
  readonly expiresAt: string;
  readonly revoked: boolean;
  readonly limits: {
    readonly maxRedirects: number;
    readonly maxResponseBytes: number;
    readonly maxDecompressionRatio: number;
    readonly timeoutMs: number;
    readonly allowedContentTypes: readonly string[];
  };
}

export interface BrowserRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly browserBindingId: string;
  readonly method: BrowserMethod;
  readonly mode: BrowserMode;
  readonly url: string;
}

export interface BoundBrowserRequest extends BrowserRequest {
  readonly url: string;
  readonly origin: string;
  readonly hostname: string;
  readonly resolutionPolicy: 'PUBLIC_ONLY' | 'LOOPBACK_ONLY';
  readonly redirectMode: 'manual';
  readonly outputWorkspaceId: WorkspaceId;
  readonly limits: BrowserGrant['limits'];
}

export interface ResolutionBinding {
  readonly hostname: string;
  readonly addresses: readonly string[];
  readonly policy: 'PUBLIC_ONLY' | 'LOOPBACK_ONLY';
}

export interface BrowserDownloadResult {
  readonly sourceOrigin: string;
  readonly sourceRequestSha256: string;
  readonly contentType: string;
  readonly artifact: ArtifactReference;
}

export type BrowserAdapterKind = 'dom' | 'native';

export interface BrowserSessionScope {
  readonly sessionId: string;
  readonly projectId: string;
  readonly browserBindingId: string;
  readonly adapter: BrowserAdapterKind;
  readonly uploadArtifactIds: readonly string[];
}

export interface BrowserAdapterTransitionRecord {
  readonly transitionId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly browserBindingId: string;
  readonly from: BrowserAdapterKind;
  readonly to: BrowserAdapterKind;
  readonly reason: string;
  readonly uploadArtifactIds: readonly string[];
}

export function transitionBrowserAdapter(
  current: BrowserSessionScope,
  input: Readonly<{
    transitionId: string;
    sessionId: string;
    projectId: string;
    browserBindingId: string;
    from: BrowserAdapterKind;
    to: BrowserAdapterKind;
    reason: string;
    uploadArtifactIds: readonly string[];
  }>,
): Readonly<{ session: BrowserSessionScope; audit: BrowserAdapterTransitionRecord }> {
  if (![current.sessionId, current.projectId, current.browserBindingId, input.transitionId, input.sessionId, input.projectId, input.browserBindingId]
    .every(boundedIdentity)) fail('INVALID_REQUEST');
  if (!['dom', 'native'].includes(current.adapter) || !['dom', 'native'].includes(input.from) || !['dom', 'native'].includes(input.to)
    || input.from !== current.adapter || input.to === input.from) fail('ADAPTER_TRANSITION_DENIED');
  if (input.sessionId !== current.sessionId || input.projectId !== current.projectId || input.browserBindingId !== current.browserBindingId) {
    fail('SCOPE_WIDENING');
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 500) fail('INVALID_REQUEST');
  if (!Array.isArray(current.uploadArtifactIds) || current.uploadArtifactIds.length > 64
    || !Array.isArray(input.uploadArtifactIds) || input.uploadArtifactIds.length > 64
    || current.uploadArtifactIds.some((artifactId) => !boundedIdentity(artifactId))
    || input.uploadArtifactIds.some((artifactId) => !boundedIdentity(artifactId))) fail('INVALID_REQUEST');
  const allowedUploads = new Set(current.uploadArtifactIds);
  if (input.uploadArtifactIds.some((artifactId) => !allowedUploads.has(artifactId))) fail('SCOPE_WIDENING');
  const uploadArtifactIds = Object.freeze([...new Set(input.uploadArtifactIds)]);
  const session = Object.freeze({
    sessionId: current.sessionId,
    projectId: current.projectId,
    browserBindingId: current.browserBindingId,
    adapter: input.to,
    uploadArtifactIds,
  });
  const audit = Object.freeze({
    transitionId: input.transitionId,
    sessionId: current.sessionId,
    projectId: current.projectId,
    browserBindingId: current.browserBindingId,
    from: input.from,
    to: input.to,
    reason: input.reason,
    uploadArtifactIds,
  });
  return Object.freeze({ session, audit });
}

export class BrowserContractError extends Error {
  readonly code: BrowserFailureCode;
  constructor(code: BrowserFailureCode) {
    super(code);
    this.code = code;
  }
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const internalSuffixes = ['.internal', '.local', '.lan', '.home', '.corp'];
const specialUseAddresses = createSpecialUseBlockLists();

function fail(code: BrowserFailureCode): never {
  throw new BrowserContractError(code);
}

export function bindBrowserRequest(grant: BrowserGrant, request: BrowserRequest, now: number): BoundBrowserRequest {
  if (typeof request !== 'object' || request === null || !Number.isFinite(now)
    || !boundedIdentity(request.requestId) || !boundedIdentity(request.projectId) || !boundedIdentity(request.browserBindingId)
    || !browserMethods.includes(request.method) || !browserModes.includes(request.mode)
    || typeof request.url !== 'string' || request.url.length === 0 || request.url.length > 4096 || request.url.includes('\0')) {
    fail('INVALID_REQUEST');
  }
  validateGrant(grant, now);
  if (request.projectId !== grant.projectId || request.browserBindingId !== grant.browserBindingId) fail('UNAUTHORIZED');

  const url = parseUrl(request.url);
  if (url.username !== '' || url.password !== '') fail('URL_NOT_ALLOWED');
  url.hash = '';

  const hostname = normalizeHostname(url.hostname);
  const localhost = isLocalhostName(hostname) || isLoopbackLiteral(hostname);
  if (localhost && !grant.allowLocalhostHttp) fail('SSRF_DENIED');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost && grant.allowLocalhostHttp)) {
    fail('URL_NOT_ALLOWED');
  }
  if (isObviousInternalName(hostname) && !localhost) fail('SSRF_DENIED');

  const allowedOrigins = normalizeAllowedOrigins(grant.allowedOrigins, grant.allowLocalhostHttp);
  if (!allowedOrigins.has(url.origin)) fail('URL_NOT_ALLOWED');

  const resolutionPolicy = localhost && grant.allowLocalhostHttp ? 'LOOPBACK_ONLY' : 'PUBLIC_ONLY';
  if (isIP(hostname) !== 0) assertAddressAllowed(hostname, resolutionPolicy);

  const limits = Object.freeze({
    maxRedirects: grant.limits.maxRedirects,
    maxResponseBytes: grant.limits.maxResponseBytes,
    maxDecompressionRatio: grant.limits.maxDecompressionRatio,
    timeoutMs: grant.limits.timeoutMs,
    allowedContentTypes: Object.freeze(grant.limits.allowedContentTypes.map(normalizeContentType)),
  });

  return Object.freeze({
    requestId: request.requestId,
    projectId: request.projectId,
    browserBindingId: request.browserBindingId,
    method: request.method,
    mode: request.mode,
    url: url.toString(),
    origin: url.origin,
    hostname,
    resolutionPolicy,
    redirectMode: 'manual',
    outputWorkspaceId: grant.outputWorkspaceId,
    limits,
  });
}

export function bindRedirect(
  grant: BrowserGrant,
  current: BoundBrowserRequest,
  location: string,
  redirectCount: number,
  now: number,
): BoundBrowserRequest {
  if (!Number.isSafeInteger(redirectCount) || redirectCount < 0 || typeof location !== 'string' || location.length === 0) {
    fail('INVALID_REQUEST');
  }
  if (redirectCount + 1 > current.limits.maxRedirects) fail('REDIRECT_LIMIT');
  let next: URL;
  try {
    next = new URL(location, current.url);
  } catch {
    fail('URL_NOT_ALLOWED');
  }
  return bindBrowserRequest(grant, {
    requestId: current.requestId,
    projectId: current.projectId,
    browserBindingId: current.browserBindingId,
    method: current.method,
    mode: current.mode,
    url: next.toString(),
  }, now);
}

export function bindResolution(request: BoundBrowserRequest, addresses: readonly string[]): ResolutionBinding {
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 16) fail('SSRF_DENIED');
  const normalized = [...new Set(addresses.map(normalizeAddress))].sort();
  for (const address of normalized) assertAddressAllowed(address, request.resolutionPolicy);
  return Object.freeze({
    hostname: request.hostname,
    addresses: Object.freeze(normalized),
    policy: request.resolutionPolicy,
  });
}

export function revalidateResolution(binding: ResolutionBinding, addresses: readonly string[]): ResolutionBinding {
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 16) fail('DNS_CHANGED');
  const normalized = [...new Set(addresses.map(normalizeAddress))].sort();
  for (const address of normalized) assertAddressAllowed(address, binding.policy);
  if (normalized.length !== binding.addresses.length
    || normalized.some((address, index) => address !== binding.addresses[index])) {
    fail('DNS_CHANGED');
  }
  return binding;
}

export function assertConnectedAddress(binding: ResolutionBinding, address: string): string {
  const normalized = normalizeAddress(address);
  assertAddressAllowed(normalized, binding.policy);
  if (!binding.addresses.includes(normalized)) fail('DNS_CHANGED');
  return normalized;
}

export interface BrowserResponseBudgetSnapshot {
  readonly contentType: string;
  readonly transportBytes: number;
  readonly decodedBytes: number;
  readonly maxResponseBytes: number;
  readonly maxDecompressionRatio: number;
}

export class BrowserResponseBudget {
  readonly #request: BoundBrowserRequest;
  readonly #contentType: string;
  #transportBytes = 0;
  #decodedBytes = 0;

  constructor(request: BoundBrowserRequest, contentType: string) {
    this.#request = request;
    this.#contentType = normalizeContentType(contentType);
    if (!request.limits.allowedContentTypes.includes(this.#contentType)) fail('CONTENT_TYPE_DENIED');
  }

  observeTransportBytes(bytes: number): BrowserResponseBudgetSnapshot {
    this.#transportBytes = boundedTotal(this.#transportBytes, bytes);
    if (this.#transportBytes > this.#request.limits.maxResponseBytes) fail('RESPONSE_LIMIT');
    this.assertRatio();
    return this.snapshot();
  }

  observeDecodedBytes(bytes: number): BrowserResponseBudgetSnapshot {
    this.#decodedBytes = boundedTotal(this.#decodedBytes, bytes);
    if (this.#decodedBytes > this.#request.limits.maxResponseBytes) fail('RESPONSE_LIMIT');
    this.assertRatio();
    return this.snapshot();
  }

  assertElapsed(elapsedMs: number): void {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) fail('INVALID_REQUEST');
    if (elapsedMs > this.#request.limits.timeoutMs) fail('TIMEOUT');
  }

  snapshot(): BrowserResponseBudgetSnapshot {
    return Object.freeze({
      contentType: this.#contentType,
      transportBytes: this.#transportBytes,
      decodedBytes: this.#decodedBytes,
      maxResponseBytes: this.#request.limits.maxResponseBytes,
      maxDecompressionRatio: this.#request.limits.maxDecompressionRatio,
    });
  }

  private assertRatio(): void {
    if (this.#decodedBytes === 0) return;
    if (this.#transportBytes === 0
      || this.#decodedBytes / this.#transportBytes > this.#request.limits.maxDecompressionRatio) {
      fail('DECOMPRESSION_LIMIT');
    }
  }
}

export function assertResponsePolicy(
  request: BoundBrowserRequest,
  response: {
    readonly contentType: string;
    readonly compressedBytes: number;
    readonly decompressedBytes: number;
    readonly elapsedMs: number;
  },
): void {
  const { compressedBytes, decompressedBytes, elapsedMs } = response;
  if (![compressedBytes, decompressedBytes, elapsedMs].every(Number.isSafeInteger)
    || compressedBytes < 0 || decompressedBytes < 0 || elapsedMs < 0) fail('INVALID_REQUEST');
  const budget = new BrowserResponseBudget(request, response.contentType);
  if (compressedBytes > 0) budget.observeTransportBytes(compressedBytes);
  if (decompressedBytes > 0) budget.observeDecodedBytes(decompressedBytes);
  budget.assertElapsed(elapsedMs);
}

export function assertSignalActive(signal: AbortSignal): void {
  if (signal.aborted) fail('CANCELLED');
}

function validateGrant(grant: BrowserGrant, now: number): void {
  if (typeof grant !== 'object' || grant === null
    || typeof grant.revoked !== 'boolean'
    || typeof grant.allowLocalhostHttp !== 'boolean'
    || typeof grant.expiresAt !== 'string'
    || !boundedIdentity(grant.projectId)
    || !boundedIdentity(grant.browserBindingId)
    || !boundedIdentity(grant.outputWorkspaceId)
    || !boundedOpaqueRef(grant.sessionRef)
    || typeof grant.limits !== 'object' || grant.limits === null) fail('POLICY_INVALID');
  if (grant.revoked) fail('REVOKED_AUTH');
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt)) fail('POLICY_INVALID');
  if (expiresAt <= now) fail('EXPIRED_AUTH');
  if (grant.network !== 'allowed') fail('NETWORK_DISABLED');
  if (!Array.isArray(grant.allowedOrigins) || grant.allowedOrigins.length === 0 || grant.allowedOrigins.length > 32
    || grant.allowedOrigins.some((origin) => typeof origin !== 'string' || origin.length === 0 || origin.length > 4096 || origin.includes('\0'))) {
    fail('POLICY_INVALID');
  }
  // Validate grant semantics before interpreting the request so a malformed
  // authority consistently fails as POLICY_INVALID rather than leaking into
  // request-specific URL/SSRF error precedence.
  normalizeAllowedOrigins(grant.allowedOrigins, grant.allowLocalhostHttp);
  const { maxRedirects, maxResponseBytes, maxDecompressionRatio, timeoutMs, allowedContentTypes } = grant.limits;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0
    || !Number.isSafeInteger(maxDecompressionRatio) || maxDecompressionRatio < 1 || maxDecompressionRatio > 1000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || !Array.isArray(allowedContentTypes) || allowedContentTypes.length === 0 || allowedContentTypes.length > 32) {
    fail('POLICY_INVALID');
  }
  for (const contentType of allowedContentTypes) normalizeContentType(contentType);
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && requestIdPattern.test(value);
}

function boundedOpaqueRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !value.includes('\0');
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    fail('URL_NOT_ALLOWED');
  }
}

function normalizeAllowedOrigins(origins: readonly string[], allowLocalhostHttp: boolean): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const origin of origins) {
    const url = parseUrl(origin);
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') fail('POLICY_INVALID');
    const hostname = normalizeHostname(url.hostname);
    const localhost = isLocalhostName(hostname) || isLoopbackLiteral(hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost && allowLocalhostHttp)) fail('POLICY_INVALID');
    if (isObviousInternalName(hostname) && !localhost) fail('POLICY_INVALID');
    normalized.add(url.origin);
  }
  return normalized;
}

function normalizeContentType(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) fail('INVALID_REQUEST');
  const mediaType = value.split(';', 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) fail('INVALID_REQUEST');
  return mediaType;
}

function boundedTotal(current: number, increment: number): number {
  if (!Number.isSafeInteger(increment) || increment < 0) fail('INVALID_REQUEST');
  const next = current + increment;
  if (!Number.isSafeInteger(next)) fail('RESPONSE_LIMIT');
  return next;
}

function normalizeHostname(value: string): string {
  const hostname = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return hostname.toLowerCase().replace(/\.$/, '');
}

function normalizeAddress(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) fail('SSRF_DENIED');
  const address = normalizeHostname(value.trim());
  if (isIP(address) === 0) fail('SSRF_DENIED');
  return address;
}

function isLocalhostName(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

function isObviousInternalName(hostname: string): boolean {
  return internalSuffixes.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));
}

function isLoopbackLiteral(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith('127.');
  if (isIP(address) === 6) return address === '::1';
  return false;
}

function assertAddressAllowed(address: string, policy: 'PUBLIC_ONLY' | 'LOOPBACK_ONLY'): void {
  const version = isIP(address);
  if (version === 0) fail('SSRF_DENIED');
  if (policy === 'LOOPBACK_ONLY') {
    if (!isLoopbackLiteral(address)) fail('SSRF_DENIED');
    return;
  }
  const block = version === 4 ? specialUseAddresses.ipv4 : specialUseAddresses.ipv6;
  if (block.check(address, version === 4 ? 'ipv4' : 'ipv6')) fail('SSRF_DENIED');
}

function createSpecialUseBlockLists(): Readonly<{ ipv4: BlockList; ipv6: BlockList }> {
  const ipv4Block = new BlockList();
  const ipv6Block = new BlockList();
  const ipv4: ReadonlyArray<readonly [string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  const ipv6: ReadonlyArray<readonly [string, number]> = [
    // Deprecated IPv4-compatible IPv6 plus unspecified/loopback forms.
    ['::', 96],
    ['::ffff:0:0', 96],
    // Translation/transition ranges can encode or tunnel an IPv4 destination,
    // so they remain denied even when part of the range is globally reachable.
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['100:0:0:1::', 64],
    ['2001::', 32],
    ['2001:2::', 48],
    ['2001:10::', 28],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
    ['5f00::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    // Deprecated site-local addresses are not present in the current IANA
    // registry but are still inappropriate browser destinations.
    ['fec0::', 10],
    ['ff00::', 8],
  ];
  for (const [network, prefix] of ipv4) ipv4Block.addSubnet(network, prefix, 'ipv4');
  // 192.0.0.0/24 is special-use by default, but IANA assigns the globally
  // reachable PCP/TURN anycast exceptions at .9 and .10.
  ipv4Block.addRange('192.0.0.0', '192.0.0.8', 'ipv4');
  ipv4Block.addRange('192.0.0.11', '192.0.0.255', 'ipv4');
  for (const [network, prefix] of ipv6) ipv6Block.addSubnet(network, prefix, 'ipv6');
  return Object.freeze({ ipv4: ipv4Block, ipv6: ipv6Block });
}
