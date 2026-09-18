import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GovernedMobileAdapter } from './governed.ts';
import { mobileArtifactIntent, planRobotJob } from './integration.ts';

const emulator = {
  serial: 'emulator-5554', state: 'device', transport: 'emulator', model: 'synthetic',
  manufacturer: 'fake', androidVersion: '14', apiLevel: 34, kind: 'emulator', connectionId: 'epoch-1',
};
const phone = { ...emulator, serial: 'phone-1', transport: 'usb', kind: 'physical' };

class Authority {
  bindings = new Map([['bbl-device', { serial: emulator.serial, connectionId: emulator.connectionId }]]);
  async binding(id) { return this.bindings.get(id) ?? null; }
  async authorize() { return { allowed: true, redactionValues: ['CID-001'] }; }
}

class Adb {
  inventory = [emulator];
  calls = [];
  async devices() { return this.inventory.map(device => ({ ...device })); }
  async packageInfo() {}
  async activity() {}
  async install() {}
  async screenshot(serial) { this.calls.push(['screenshot', serial]); return new Uint8Array([137, 80, 78, 71, 1]); }
  async logcat() { return 'CID=CID-001'; }
  async androidVersion() { return '14'; }
}

class Appium {
  endpoint = 'http://127.0.0.1:4723';
  calls = [];
  async status() { return { ready: true }; }
  async createSession({ udid }) { this.calls.push(['create', udid]); return { sessionId: 'actual-bbl-session' }; }
  async deleteSession(id) { this.calls.push(['delete', id]); }
  async source(id) {
    this.calls.push(['source', id]);
    return '<hierarchy><node text="Account summary"/></hierarchy>';
  }
  async screenshot(id) { this.calls.push(['screenshot', id]); return new Uint8Array([1, 2, 3]); }
  async contexts(id) { this.calls.push(['contexts', id]); return ['NATIVE_APP']; }
}

class Sink {
  commits = [];
  async commit(input) {
    this.commits.push({ ...input, bytes: Uint8Array.from(input.bytes), evidence: { ...input.evidence } });
    return {
      sensitivity: input.sensitivity,
      retention: input.retention,
      redaction: input.redaction,
      evidence: { ...input.evidence },
    };
  }
}

function ctx(operationId, jobId) {
  return {
    operationId,
    ...(jobId ? { jobId } : {}),
    timeoutMs: 500,
    signal: new globalThis.AbortController().signal,
  };
}

function fixture() {
  const adb = new Adb();
  const appium = new Appium();
  const authority = new Authority();
  const sink = new Sink();
  const adapter = new GovernedMobileAdapter(adb, appium, authority, sink);
  return { adb, appium, authority, sink, adapter };
}

test('e2e 01: bound device -> Appium source -> restricted artifact intent -> Robot plan preserves one identity chain', async () => {
  const f = fixture();
  assert.equal((await f.adapter.status()).ready, true);
  const inventory = await f.adapter.devices();
  assert.equal(inventory[0].serial, emulator.serial);

  await f.adapter.execute(
    { deviceBindingId: 'bbl-device' },
    { adapter: 'appium', operation: { kind: 'session', action: 'create' } },
    ctx('logical-session'),
  );
  const result = await f.adapter.execute(
    { deviceBindingId: 'bbl-device' },
    { adapter: 'appium', operation: { kind: 'source', sessionId: 'logical-session' } },
    ctx('source-op', 'robot-job-1'),
  );
  assert.equal(result.artifact.sensitivity, 'restricted');
  assert.deepEqual(f.appium.calls, [
    ['create', emulator.serial],
    ['source', 'actual-bbl-session'],
  ]);

  const committed = f.sink.commits[0];
  const intent = mobileArtifactIntent({
    kind: 'source',
    bytes: committed.bytes,
    projectId: 'BBL',
    workspaceId: 'bbl-workspace',
    producerJobId: result.evidence.jobId,
    operationId: result.evidence.operationId,
    serial: result.evidence.serial,
    connectionId: result.evidence.connectionId,
  });
  const robot = planRobotJob({
    suitePath: 'tests/mobile/ntb.robot',
    appiumEndpoint: f.appium.endpoint,
    device: { serial: result.evidence.serial, connectionId: result.evidence.connectionId, kind: result.evidence.kind },
    jobId: 'robot-job-1',
    operationId: 'robot-op-1',
  });

  const receipt = {
    serial: result.evidence.serial,
    connectionId: result.evidence.connectionId,
    sourceOperationId: result.evidence.operationId,
    artifactSha256: intent.sha256,
    artifactSensitivity: intent.sensitivity,
    artifactExportState: intent.exportState,
    robotJobId: robot.jobId,
    robotOperationId: robot.operationId,
    suite: robot.argv.at(-1),
  };
  assert.deepEqual(receipt, {
    serial: 'emulator-5554',
    connectionId: 'epoch-1',
    sourceOperationId: 'source-op',
    artifactSha256: intent.sha256,
    artifactSensitivity: 'RESTRICTED',
    artifactExportState: 'REVIEW_REQUIRED',
    robotJobId: 'robot-job-1',
    robotOperationId: 'robot-op-1',
    suite: 'tests/mobile/ntb.robot',
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes('<hierarchy>'), false);
  assert.equal(serialized.includes('CID-001'), false);
});

test('e2e 02: reconnect invalidates bound device and existing Appium session before evidence publication', async () => {
  const f = fixture();
  await f.adapter.execute(
    { deviceBindingId: 'bbl-device' },
    { adapter: 'appium', operation: { kind: 'session', action: 'create' } },
    ctx('logical-session'),
  );
  f.adb.inventory = [{ ...emulator, connectionId: 'epoch-2' }];
  await assert.rejects(
    f.adapter.execute(
      { deviceBindingId: 'bbl-device' },
      { adapter: 'appium', operation: { kind: 'source', sessionId: 'logical-session' } },
      ctx('source-after-reconnect', 'robot-job-1'),
    ),
    /STALE_BINDING/,
  );
  assert.equal(f.sink.commits.length, 0);
});

test('e2e 03: disappearance never falls back from emulator to a physical device', async () => {
  const f = fixture();
  f.adb.inventory = [phone];
  await assert.rejects(
    f.adapter.execute(
      { deviceBindingId: 'bbl-device' },
      { adapter: 'adb', operation: { kind: 'screenshot' } },
      ctx('shot-op'),
    ),
    /DEVICE_MISSING_OR_AMBIGUOUS/,
  );
  assert.deepEqual(f.adb.calls, []);
  assert.equal(f.sink.commits.length, 0);
});

test('e2e 04: cancelled mobile evidence request produces no artifact intent input', async () => {
  const f = fixture();
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(
    f.adapter.execute(
      { deviceBindingId: 'bbl-device' },
      { adapter: 'adb', operation: { kind: 'screenshot' } },
      { operationId: 'cancelled-shot', timeoutMs: 500, signal: controller.signal },
    ),
    /CANCELLED/,
  );
  assert.equal(f.sink.commits.length, 0);
});
