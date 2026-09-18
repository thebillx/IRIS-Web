import { bindRead, ContractError } from './contract.js';
import type { ReadGrant, ReadRequest, FailureCode } from './contract.js';

export const fixtureGrant: ReadGrant = {
  projectId: 'bbl-wiki', connectorId: 'figma-test', connectorBindingId: 'binding-test',
  credentialRef: 'credential-test', sessionRef: 'session-test', organizationId: 'bbl',
  fileKeys: ['AllowedFile'], nodeIds: ['1:2'], network: 'allowed',
  expiresAt: '2030-01-01T00:00:00Z', revoked: false,
  outputWorkspaceId: 'workspace-test' as ReadGrant['outputWorkspaceId'],
  limits: { metadataBytes: 100, screenshotBytes: 100, maxNodes: 2, maxDepth: 2, timeoutMs: 100 },
};
export const fixtureRequest: ReadRequest = {
  requestId: 'request-test', projectId: 'bbl-wiki', connectorBindingId: 'binding-test',
  operation: 'figma.get_design_context', fileKey: 'AllowedFile', nodeIds: ['1:2'], depth: 1,
};
/** Synthetic future integration oracle; does not implement a real adapter or persistence. */
export function fakeAcquire(options: {
  grant?: ReadGrant; request?: ReadRequest; organization?: string; artifactProject?: string;
  metadataBytes?: number; screenshotBytes?: number; elapsedMs?: number;
  providerError?: string; partial?: boolean; priorVersion?: string;
} = {}) {
  const grant = options.grant ?? fixtureGrant;
  const request = bindRead(grant, options.request ?? fixtureRequest, Date.parse('2026-09-15'));
  const deny = (code: FailureCode): never => { throw new ContractError(code); };
  if (options.providerError) deny('ACQUISITION_FAILED');
  if ((options.organization ?? 'bbl') !== grant.organizationId) deny('UNAUTHORIZED');
  if ((options.artifactProject ?? 'bbl-wiki') !== grant.projectId) deny('UNAUTHORIZED');
  if ((options.metadataBytes ?? 10) > grant.limits.metadataBytes
    || (options.screenshotBytes ?? 10) > grant.limits.screenshotBytes) deny('LIMIT_EXCEEDED');
  if ((options.elapsedMs ?? 1) >= grant.limits.timeoutMs) deny('TIMEOUT');
  if (options.priorVersion && options.priorVersion !== 'v1') deny('SOURCE_CHANGED');
  return { request, version: 'v1', resumedFrom: options.priorVersion ? 'prior-acquisition' : null,
    status: options.partial ? 'partial' : 'complete',
    evidence: { text: 'acquired', annotations: 'unsupported', screenshots: options.partial ? 'failed' : 'acquired' },
    artifactIds: options.partial ? ['metadata-artifact'] : ['metadata-artifact', 'screenshot-artifact'] };
}
