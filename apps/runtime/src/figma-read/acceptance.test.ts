import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bindRead, ContractError } from './contract.js';
import type { ReadRequest } from './contract.js';
import { fakeAcquire, fixtureGrant as grant, fixtureRequest as request } from './fixtures.js';

const rejects = (run: () => unknown, code: string) => assert.throws(run,
  error => error instanceof ContractError && error.code === code && error.message === code);
test('allowed fileKey', () => assert.equal(fakeAcquire().request.fileKey, 'AllowedFile'));
test('forbidden fileKey', () => rejects(() => fakeAcquire({ request: { ...request, fileKey: 'Forbidden' } }), 'UNAUTHORIZED'));
test('fileKey substitution after authorization cannot alter bound request', () => {
  const mutable = { ...request, nodeIds: ['1:2'] };
  const bound = bindRead(grant, mutable, Date.parse('2026-09-15'));
  mutable.fileKey = 'Forbidden'; mutable.nodeIds[0] = '9:9';
  assert.equal(bound.fileKey, 'AllowedFile'); assert.deepEqual(bound.nodeIds, ['1:2']);
  assert.throws(() => { (bound as { fileKey: string }).fileKey = 'Forbidden'; }, TypeError);
});
test('expired auth', () => rejects(() => fakeAcquire({ grant: { ...grant, expiresAt: '2020-01-01' } }), 'EXPIRED_AUTH'));
test('revoked auth', () => rejects(() => fakeAcquire({ grant: { ...grant, revoked: true } }), 'REVOKED_AUTH'));
test('wrong organization', () => rejects(() => fakeAcquire({ organization: 'foreign' }), 'UNAUTHORIZED'));
test('oversized metadata', () => rejects(() => fakeAcquire({ metadataBytes: 101 }), 'LIMIT_EXCEEDED'));
test('oversized screenshot', () => rejects(() => fakeAcquire({ screenshotBytes: 101 }), 'LIMIT_EXCEEDED'));
test('cross-project artifact ownership', () => rejects(() => fakeAcquire({ artifactProject: 'foreign' }), 'UNAUTHORIZED'));
test('secret redaction: provider errors never escape', () => {
  rejects(() => fakeAcquire({ providerError: 'Authorization: Bearer SECRET' }), 'ACQUISITION_FAILED');
  assert.equal(JSON.stringify(fakeAcquire()).includes('credential-test'), false);
});
test('network disabled policy', () => rejects(() => fakeAcquire({ grant: { ...grant, network: 'disabled' } }), 'NETWORK_DISABLED'));
test('connector timeout', () => rejects(() => fakeAcquire({ elapsedMs: 100 }), 'TIMEOUT'));
test('partial acquisition retains only successful artifacts', () => {
  const result = fakeAcquire({ partial: true });
  assert.equal(result.status, 'partial'); assert.deepEqual(result.artifactIds, ['metadata-artifact']);
  assert.equal(result.evidence.screenshots, 'failed');
});
test('resumed acquisition preserves source and parent provenance', () => {
  const initial = fakeAcquire(); const resumed = fakeAcquire({ priorVersion: initial.version });
  assert.deepEqual(resumed.request, initial.request); assert.equal(resumed.version, initial.version);
  assert.equal(resumed.resumedFrom, 'prior-acquisition');
});
test('resumed source version mismatch', () => rejects(() => fakeAcquire({ priorVersion: 'v0' }), 'SOURCE_CHANGED'));
test('write operation excluded', () => rejects(() => fakeAcquire({ request: { ...request, operation: 'figma.edit' as ReadRequest['operation'] } }), 'INVALID_REQUEST'));
test('forbidden node', () => rejects(() => fakeAcquire({ request: { ...request, nodeIds: ['9:9'] } }), 'UNAUTHORIZED'));
test('bounded depth', () => rejects(() => fakeAcquire({ request: { ...request, depth: 3 } }), 'LIMIT_EXCEEDED'));
test('capability-dependent evidence explicit', () => assert.equal(fakeAcquire().evidence.annotations, 'unsupported'));
