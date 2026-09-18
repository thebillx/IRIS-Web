import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GovernedMobileAdapter } from './governed.ts';

const emulator = {
  serial: 'emulator-5554',
  state: 'device',
  transport: 'emulator',
  model: 'synthetic',
  manufacturer: 'fake',
  androidVersion: '14',
  apiLevel: 34,
  kind: 'emulator',
  connectionId: 'epoch-1',
};
const phone = { ...emulator, serial: 'phone-1', kind: 'physical', transport: 'usb' };

class Authority {
  bindings = new Map();
  allowed = true;
  redactionValues = ['CID-1234'];
  async binding(id) { return this.bindings.get(id) ?? null; }
  async authorize() {
    if (!this.allowed) throw new Error('AUTHORIZATION_REQUIRED');
    return { allowed: true, redactionValues: [...this.redactionValues] };
  }
}

class Adb {
  inventory = [emulator];
  calls = [];
  duringActivity = () => {};
  async devices() { return this.inventory.map(device => ({ ...device })); }
  async packageInfo(serial, packageName) { this.calls.push(['packageInfo', serial, packageName]); }
  async activity(serial, action, component) {
    this.calls.push(['activity', serial, action, component]);
    this.duringActivity();
  }
  async install(serial, apk) { this.calls.push(['install', serial, apk.length]); }
  async screenshot(serial) { this.calls.push(['screenshot', serial]); return new Uint8Array([1, 2, 3]); }
  async logcat(serial, maxBytes) {
    this.calls.push(['logcat', serial, maxBytes]);
    return 'Authorization: Bearer abc-secret\nCID=CID-1234';
  }
  async androidVersion(serial) { this.calls.push(['androidVersion', serial]); return '14'; }
}

class Appium {
  endpoint = 'http://127.0.0.1:4723';
  calls = [];
  nextSessionId = 'actual-session-1';
  async status() { this.calls.push(['status']); return { ready: true }; }
  async createSession(input) { this.calls.push(['createSession', input.udid]); return { sessionId: this.nextSessionId }; }
  async deleteSession(sessionId) { this.calls.push(['deleteSession', sessionId]); }
  async source(sessionId) { this.calls.push(['source', sessionId]); return '<hierarchy password="secret"/>'; }
  async screenshot(sessionId) { this.calls.push(['screenshot', sessionId]); return new Uint8Array([9, 8, 7]); }
  async contexts(sessionId) { this.calls.push(['contexts', sessionId]); return ['NATIVE_APP']; }
}

class Sink {
  commits = [];
  async commit(input) {
    this.commits.push({
      ...input,
      bytes: Uint8Array.from(input.bytes),
      evidence: { ...input.evidence },
    });
    return {
      sensitivity: input.sensitivity,
      retention: input.retention,
      redaction: input.redaction,
      evidence: { ...input.evidence },
    };
  }
}

function context(operationId = 'op-1', timeoutMs = 100) {
  return {
    operationId,
    timeoutMs,
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

test('governed 01: explicit serial + authority dispatches typed ADB screenshot and restricted artifact only', async () => {
  const f = fixture();
  const result = await f.adapter.execute(
    { deviceSerial: emulator.serial },
    { adapter: 'adb', operation: { kind: 'screenshot' } },
    context(),
  );
  assert.deepEqual(f.adb.calls, [['screenshot', emulator.serial]]);
  assert.equal(result.evidence.serial, emulator.serial);
  assert.equal(result.artifact.sensitivity, 'restricted');
  assert.equal(f.sink.commits[0].mime, 'image/png');
  assert.equal(Object.hasOwn(f.sink.commits[0], 'path'), false);
});

test('governed 02: authority denial occurs before any ADB/Appium dispatch', async () => {
  const f = fixture();
  f.authority.allowed = false;
  await assert.rejects(
    f.adapter.execute(
      { deviceSerial: emulator.serial },
      { adapter: 'adb', operation: { kind: 'screenshot' } },
      context(),
    ),
    /AUTHORIZATION_REQUIRED/,
  );
  assert.deepEqual(f.adb.calls, []);
  assert.deepEqual(f.appium.calls, []);
});

test('governed 03: APK SHA-256 mismatch is rejected before install dispatch', async () => {
  const f = fixture();
  await assert.rejects(
    f.adapter.execute(
      { deviceSerial: emulator.serial },
      { adapter: 'adb', operation: { kind: 'install', apk: new Uint8Array([1, 2]), expectedSha256: '0'.repeat(64) } },
      context(),
    ),
    /APK_HASH_MISMATCH/,
  );
  assert.deepEqual(f.adb.calls, []);
  const apk = new Uint8Array([1, 2]);
  const hash = createHash('sha256').update(apk).digest('hex');
  await f.adapter.execute(
    { deviceSerial: emulator.serial },
    { adapter: 'adb', operation: { kind: 'install', apk, expectedSha256: hash } },
    context('op-install'),
  );
  assert.deepEqual(f.adb.calls, [['install', emulator.serial, 2]]);
});

test('governed 04: Appium endpoint is loopback-only', () => {
  const f = fixture();
  f.appium.endpoint = 'https://example.com:4723';
  assert.throws(() => new GovernedMobileAdapter(f.adb, f.appium, f.authority, f.sink), /APPIUM_ENDPOINT_DENIED/);
});

test('governed 05: logical Appium session maps to actual session and remains device pinned', async () => {
  const f = fixture();
  f.adb.inventory = [emulator, phone];
  await f.adapter.execute(
    { deviceSerial: emulator.serial },
    { adapter: 'appium', operation: { kind: 'session', action: 'create' } },
    context('logical-session'),
  );
  await f.adapter.execute(
    { deviceSerial: emulator.serial },
    { adapter: 'appium', operation: { kind: 'source', sessionId: 'logical-session' } },
    context('source-op'),
  );
  assert.deepEqual(f.appium.calls.slice(0, 2), [
    ['createSession', emulator.serial],
    ['source', 'actual-session-1'],
  ]);
  await assert.rejects(
    f.adapter.execute(
      { deviceSerial: phone.serial },
      { adapter: 'appium', operation: { kind: 'contexts', sessionId: 'logical-session' } },
      context('ctx-op'),
    ),
    /STALE_SESSION/,
  );
});

test('governed 06: binding connection generation is immutable and reconnect fails before dispatch', async () => {
  const f = fixture();
  f.authority.bindings.set('bind-1', { serial: emulator.serial, connectionId: emulator.connectionId });
  await f.adapter.execute(
    { deviceBindingId: 'bind-1' },
    { adapter: 'adb', operation: { kind: 'screenshot' } },
    context(),
  );
  f.adb.calls.length = 0;
  f.adb.inventory = [{ ...emulator, connectionId: 'epoch-2' }];
  await assert.rejects(
    f.adapter.execute(
      { deviceBindingId: 'bind-1' },
      { adapter: 'adb', operation: { kind: 'screenshot' } },
      context('op-2'),
    ),
    /STALE_BINDING/,
  );
  assert.deepEqual(f.adb.calls, []);
});

test('governed 07: logcat is redacted before restricted artifact commit', async () => {
  const f = fixture();
  await f.adapter.execute(
    { deviceSerial: emulator.serial },
    { adapter: 'adb', operation: { kind: 'logcat', maxBytes: 1024 } },
    context(),
  );
  const text = new globalThis.TextDecoder().decode(f.sink.commits[0].bytes);
  assert.equal(text.includes('abc-secret'), false);
  assert.equal(text.includes('CID-1234'), false);
});

test('governed 08: device replacement after mutation reports failure and never retries another device', async () => {
  const f = fixture();
  f.adb.inventory = [emulator, phone];
  f.adb.duringActivity = () => { f.adb.inventory = [{ ...emulator, connectionId: 'epoch-2' }, phone]; };
  await assert.rejects(
    f.adapter.execute(
      { deviceSerial: emulator.serial },
      { adapter: 'adb', operation: { kind: 'activity', action: 'start', component: 'com.example/.MainActivity' } },
      context(),
    ),
    /DEVICE_REPLACED/,
  );
  assert.deepEqual(f.adb.calls, [['activity', emulator.serial, 'start', 'com.example/.MainActivity']]);
});

test('governed 09: timeout aborts transport and cannot produce a successful artifact', async () => {
  const f = fixture();
  f.adb.screenshot = async (_serial, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('transport-aborted')), { once: true });
  });
  await assert.rejects(
    f.adapter.execute(
      { deviceSerial: emulator.serial },
      { adapter: 'adb', operation: { kind: 'screenshot' } },
      context('timeout-op', 5),
    ),
    /TIMEOUT/,
  );
  assert.equal(f.sink.commits.length, 0);
});

test('governed 10: pre-cancelled operation never dispatches', async () => {
  const f = fixture();
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(
    f.adapter.execute(
      { deviceSerial: emulator.serial },
      { adapter: 'adb', operation: { kind: 'screenshot' } },
      { operationId: 'cancelled-op', timeoutMs: 100, signal: controller.signal },
    ),
    /CANCELLED/,
  );
  assert.deepEqual(f.adb.calls, []);
});
