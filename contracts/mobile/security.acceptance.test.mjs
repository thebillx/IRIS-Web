import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeMobileAdapter, effects, redactLog } from './fake.ts';

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
const phone = { ...emulator, serial: 'fake-phone', kind: 'physical', transport: 'usb' };
const target = { deviceSerial: emulator.serial };
const ctx = () => ({ operationId: 'sec-op-1', timeoutMs: 100, signal: new globalThis.AbortController().signal });

function fixture(devices = [emulator]) {
  const adapter = new FakeMobileAdapter(devices);
  adapter.granted = true;
  return adapter;
}

test('security 01: only the fixed bounded mobile operation surface is accepted', () => {
  assert.deepEqual(effects({ adapter: 'adb', operation: { kind: 'shell', profile: 'android-properties-v1', command: 'get_android_version' } }), ['READ', 'EXECUTE']);
  for (const command of ['su', 'root', 'rm -rf /', 'settings put secure']) {
    assert.throws(() => effects({ adapter: 'adb', operation: { kind: 'shell', profile: 'android-properties-v1', command } }), /SHELL_POLICY_DENIED/);
  }
  assert.throws(() => effects({ adapter: 'unknown', operation: { kind: 'screenshot' } }), /ADAPTER_DENIED/);
});

test('security 02: discovery never creates authority and execution still requires authorization', async () => {
  const adapter = new FakeMobileAdapter([emulator, phone]);
  const devices = await adapter.devices();
  assert.equal(devices.length, 2);
  assert.equal(adapter.bindingCount, 0);
  await assert.rejects(adapter.execute(target, { adapter: 'adb', operation: { kind: 'screenshot' } }, ctx()), /AUTHORIZATION_REQUIRED/);
  assert.equal(adapter.calls.length, 0);
});

test('security 03: binding and Appium session identity fail closed across reconnect or cross-device use', async () => {
  const adapter = fixture([emulator, phone]);
  adapter.bind('binding-sec', emulator.serial);
  await adapter.execute({ deviceBindingId: 'binding-sec' }, { adapter: 'appium', operation: { kind: 'session', action: 'create' } }, ctx());
  await assert.rejects(
    adapter.execute({ deviceSerial: phone.serial }, { adapter: 'appium', operation: { kind: 'source', sessionId: 'sec-op-1' } }, ctx()),
    /STALE_SESSION/,
  );
  adapter.inventory = [{ ...emulator, connectionId: 'epoch-2' }, phone];
  await assert.rejects(
    adapter.execute({ deviceBindingId: 'binding-sec' }, { adapter: 'adb', operation: { kind: 'screenshot' } }, ctx()),
    /STALE_BINDING/,
  );
});

test('security 04: screenshot/source/logcat evidence is restricted and has no caller path/export channel', async () => {
  const adapter = fixture();
  const screenshot = await adapter.execute(target, { adapter: 'adb', operation: { kind: 'screenshot' } }, ctx());
  assert.deepEqual(
    { sensitivity: screenshot.artifact.sensitivity, retention: screenshot.artifact.retention, redaction: screenshot.artifact.redaction },
    { sensitivity: 'restricted', retention: 'memory-only', redaction: 'required-before-export' },
  );
  const serialized = JSON.stringify(screenshot.artifact);
  for (const forbidden of ['physicalPath', 'outputPath', 'destinationPath', 'file://']) assert.equal(serialized.includes(forbidden), false);
});

test('security 05: text redaction removes bearer/password material and explicit sensitive values', () => {
  const output = redactLog(
    'Authorization: Bearer token-123\nPASSWORD=secret-pass\nCID=1234567890123',
    ['1234567890123'],
  );
  for (const value of ['token-123', 'secret-pass', '1234567890123']) assert.equal(output.includes(value), false);
});

test('security 06: hash mismatch and pre-cancellation cause zero device dispatch', async () => {
  const mismatch = fixture();
  await assert.rejects(
    mismatch.execute(target, { adapter: 'adb', operation: { kind: 'install', apk: new Uint8Array([1, 2]), expectedSha256: 'bad' } }, ctx()),
    /APK_HASH_MISMATCH/,
  );
  assert.equal(mismatch.calls.length, 0);

  const cancelled = fixture();
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(
    cancelled.execute(target, { adapter: 'adb', operation: { kind: 'screenshot' } }, { ...ctx(), signal: controller.signal }),
    /CANCELLED/,
  );
  assert.equal(cancelled.calls.length, 0);
});
