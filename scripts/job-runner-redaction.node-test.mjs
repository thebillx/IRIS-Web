import assert from 'node:assert/strict';
import test from 'node:test';
import { REDACTION_MARKER, StreamingRedactor, redactOutput, redactStructuredValue, safeSerialize } from './job-runner-redaction.mjs';

test('job runner uses the canonical typed redaction contract', () => {
  const safe = redactStructuredValue({ secret: ['alpha', 'beta'], safe: 'visible' });
  assert.deepEqual(safe, { safe: 'visible' });
  assert.match(safeSerialize(safe), /visible/);
  assert.doesNotMatch(safeSerialize(safe), /alpha|beta/);
});

test('job runner redacts compound keys and secret-bearing strings', () => {
  const output = safeSerialize({ client_secret: 'alpha', private_key: 'beta', session_token: 'gamma', dbPassword: 'delta', oauthCredential: 'zeta', message: 'PASSWORD=epsilon', header: 'Authorization: Bearer theta' });
  assert.doesNotMatch(output, /alpha|beta|gamma|delta|epsilon|zeta|theta/);
  assert.doesNotMatch(redactOutput('client_secret=synthetic-leak'), /synthetic-leak/);
  for (const input of ['secret: alpha', 'password: beta', 'api_key: gamma', 'client_secret: delta', 'token: epsilon', 'credential: zeta', 'authorization=eta', 'Authorization: Basic theta', 'secret: alpha beta gamma', 'PASSWORD=one two three']) {
    assert.doesNotMatch(redactOutput(input), /alpha|beta|gamma|delta|epsilon|zeta|eta|theta|one|two|three/);
  }
});

test('job runner fails closed for malformed, prefixed and escaped wrappers', () => {
  const valid = JSON.stringify(JSON.stringify({ secret: ['alpha"]leak', 'beta'], safe: 'visible' }));
  for (const input of [valid.slice(0, -1), `x${valid}`, '{"payload":"{\\"secret\\":[\\"alpha\\"]}"']) {
    const output = redactOutput(input);
    assert.equal(output, REDACTION_MARKER);
    assert.doesNotMatch(output, /alpha|leak|beta/);
  }
});

test('job runner fails closed for separator-obfuscated structured keys and nested serialized values', () => {
  for (const input of ['{"se\\u200bcret":"alpha"}', '{"se\\u2060cret":"alpha"}', '{"se\\u00adcret":"alpha"}', '{"sｅcret":"alpha"}', '{"api key":"alpha"}', 'API Key: alpha', 'Private Key: alpha']) {
    assert.doesNotMatch(redactOutput(input), /alpha/);
    assert.doesNotMatch(safeSerialize({ message: input }), /alpha/);
  }
});

test('job runner redacts bare private-key blocks at every output boundary', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nsynthetic-private-material\n-----END PRIVATE KEY-----\n';
  assert.doesNotMatch(redactOutput(pem), /synthetic-private-material/);
  const stream = new StreamingRedactor();
  assert.doesNotMatch(stream.push(pem) + stream.finish(), /synthetic-private-material/);
});

test('job runner streaming quarantine survives chunk and newline boundaries', () => {
  const redactor = new StreamingRedactor();
  const output = redactor.push('{"secret":["alpha",\n') + redactor.push('"beta"]}\n') + redactor.finish();
  assert.doesNotMatch(output, /alpha|beta/);
  assert.match(output, /REDACTED/);
});

test('job runner quarantines structured prefixes before sensitive fields arrive', () => {
  const redactor = new StreamingRedactor();
  const output = redactor.push('{"safe":\n') + redactor.push('"visible","secret":"alpha"}\n') + redactor.finish();
  assert.doesNotMatch(output, /alpha/);
  assert.match(output, /REDACTED/);
});

test('job runner fails closed when sensitive keys split across chunks', () => {
  const redactor = new StreamingRedactor();
  const output = redactor.push('{"se\n') + redactor.push('cret":"alpha"}\n') + redactor.finish();
  assert.doesNotMatch(output, /alpha/);
  assert.match(output, /REDACTED/);
});

test('job runner quarantines multiline sensitive records and private-key blocks', () => {
  const redactor = new StreamingRedactor();
  const output = redactor.push('private_key: -----BEGIN PRIVATE KEY-----\n')
    + redactor.push('synthetic-private-body\n-----END PRIVATE KEY-----\nordinary-safe-log\n')
    + redactor.finish();
  assert.doesNotMatch(output, /synthetic-private-body|PRIVATE KEY/);
  assert.match(output, /ordinary-safe-log/);
  const generic = new StreamingRedactor();
  const genericOutput = generic.push('secret: alpha\n') + generic.push('continuation-secret\n\nordinary\n') + generic.finish();
  assert.doesNotMatch(genericOutput, /alpha|continuation-secret|ordinary/);
});

test('job runner preserves ordinary safe logs and bounds oversized input', () => {
  assert.equal(redactOutput('ordinary safe log'), 'ordinary safe log');
  assert.equal(redactOutput(`{"payload":"${'x'.repeat(300_000)}"}`), REDACTION_MARKER);
});

test('job runner keeps a quarantined stream closed after a resource limit', () => {
  const redactor = new StreamingRedactor();
  assert.equal(redactor.push('{"secret":"alpha"' + 'x'.repeat(300_000)), REDACTION_MARKER);
  assert.equal(redactor.push('\nSAFE_AFTER_QUARANTINE'), '');
  assert.equal(redactor.finish(), '');
});

test('job runner ignores malformed bytes after quarantine without throwing', () => {
  const redactor = new StreamingRedactor();
  assert.equal(redactor.push('{"secret":"alpha"' + 'x'.repeat(300_000)), REDACTION_MARKER);
  assert.equal(redactor.push(new Uint8Array([0xc3, 0x28])), '');
  assert.equal(redactor.finish(), '');
});
