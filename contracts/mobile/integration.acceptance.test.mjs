import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mobileArtifactIntent, planRobotJob } from './integration.ts';

const device = { serial: 'emulator-5554', connectionId: 'epoch-1', kind: 'emulator' };

test('integration 01: Robot plan uses server-owned robot profile with explicit loopback Appium and UDID', () => {
  const plan = planRobotJob({
    suitePath: 'tests/mobile/smoke.robot',
    appiumEndpoint: 'http://127.0.0.1:4723/',
    device,
    jobId: 'job-1',
    operationId: 'mobile-op-1',
  });
  assert.equal(plan.executable, 'robot');
  assert.equal(plan.executionProfile, 'robot');
  assert.deepEqual(plan.argv, [
    '--variable', 'APPIUM_URL:http://127.0.0.1:4723',
    '--variable', 'UDID:emulator-5554',
    '--variable', 'IRIS_OPERATION_ID:mobile-op-1',
    'tests/mobile/smoke.robot',
  ]);
  assert.deepEqual(plan.expectedEffects, ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE']);
  assert.deepEqual(plan.device, device);
  assert.equal(plan.jobId, 'job-1');
  assert.equal(plan.operationId, 'mobile-op-1');
});

test('integration 02: Robot plan rejects non-loopback endpoint and path traversal', () => {
  assert.throws(() => planRobotJob({
    suitePath: 'tests/mobile/smoke.robot',
    appiumEndpoint: 'https://example.com:4723',
    device,
    jobId: 'job-1',
    operationId: 'mobile-op-1',
  }), /APPIUM_ENDPOINT_DENIED/);
  for (const suitePath of ['../secret.robot', 'tests/../secret.robot', '/tmp/secret.robot', 'tests/file.txt']) {
    assert.throws(() => planRobotJob({
      suitePath,
      appiumEndpoint: 'http://127.0.0.1:4723',
      device,
      jobId: 'job-1',
      operationId: 'mobile-op-1',
    }), /INVALID_ROBOT_SUITE/);
  }
});

test('integration 03: Robot argv is argument-array only and contains no shell interpolation channel', () => {
  const plan = planRobotJob({
    suitePath: 'tests/mobile/smoke.robot',
    appiumEndpoint: 'http://localhost:4723',
    device,
    jobId: 'job-2',
    operationId: 'op-2',
  });
  const joined = plan.argv.join(' ');
  for (const token of ['&&', ';', '$(', '| sh', '/bin/sh']) assert.equal(joined.includes(token), false);
  assert.equal(plan.argv.at(-1), 'tests/mobile/smoke.robot');
});

test('integration 04: mobile artifact intent computes digest and requires restricted ephemeral review', () => {
  const bytes = new globalThis.TextEncoder().encode('mobile screenshot bytes');
  const intent = mobileArtifactIntent({
    kind: 'screenshot',
    bytes,
    projectId: 'project-A',
    workspaceId: 'workspace-A',
    producerJobId: 'job-42',
    operationId: 'op-42',
    serial: 'emulator-5554',
    connectionId: 'epoch-1',
  });
  assert.equal(intent.artifactType, 'mobile.screenshot');
  assert.equal(intent.mime, 'image/png');
  assert.equal(intent.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(intent.sensitivity, 'RESTRICTED');
  assert.equal(intent.retentionPolicy, 'EPHEMERAL');
  assert.equal(intent.exportState, 'REVIEW_REQUIRED');
  const serialized = JSON.stringify(intent);
  for (const forbidden of ['physicalPath', 'destinationPath', 'file://']) assert.equal(serialized.includes(forbidden), false);
});

test('integration 05: source/logcat artifact mappings preserve correlation without widening authority', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const source = mobileArtifactIntent({
    kind: 'source', bytes, projectId: 'project-A', workspaceId: 'workspace-A',
    producerJobId: 'job-1', operationId: 'op-source', serial: 'emulator-5554', connectionId: 'epoch-1',
  });
  const log = mobileArtifactIntent({
    kind: 'logcat', bytes, projectId: 'project-A', workspaceId: 'workspace-A',
    producerJobId: 'job-1', operationId: 'op-log', serial: 'emulator-5554', connectionId: 'epoch-1',
  });
  assert.equal(source.artifactType, 'mobile.page-source');
  assert.equal(source.mime, 'application/xml; charset=utf-8');
  assert.equal(log.artifactType, 'mobile.logcat');
  assert.equal(log.mime, 'text/plain; charset=utf-8');
  assert.equal(source.producerJobId, 'job-1');
  assert.equal(source.serial, 'emulator-5554');
  assert.equal(source.connectionId, 'epoch-1');
});

test('integration 06: invalid identity or oversized mobile artifact is rejected before registration intent', () => {
  assert.throws(() => mobileArtifactIntent({
    kind: 'screenshot', bytes: new Uint8Array(),
    projectId: '../project', workspaceId: 'workspace-A', producerJobId: 'job-1',
    operationId: 'op-1', serial: 'emulator-5554', connectionId: 'epoch-1',
  }), /INVALID_ARTIFACT_IDENTITY/);
  assert.throws(() => mobileArtifactIntent({
    kind: 'screenshot', bytes: new Uint8Array(16 * 1024 * 1024 + 1),
    projectId: 'project-A', workspaceId: 'workspace-A', producerJobId: 'job-1',
    operationId: 'op-1', serial: 'emulator-5554', connectionId: 'epoch-1',
  }), /INVALID_ARTIFACT_SIZE/);
});
