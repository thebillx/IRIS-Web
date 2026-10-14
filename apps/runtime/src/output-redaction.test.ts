import { describe, expect, it } from 'vitest';
import { REDACTION_MARKER, StreamingRedactor, redactOutput, redactStructuredValue, safeErrorMessage, safePublicError, safeSerialize } from './output-redaction.js';

describe('typed safe output contract', () => {
  it('redacts sensitive fields before serialization while preserving safe fields', () => {
    const value = redactStructuredValue({ secret: ['alpha', 'beta'], safe: 'visible', nested: { apiKey: 'gamma' } });
    expect(value).toEqual({ safe: 'visible', nested: {} });
    expect(safeSerialize(value)).toContain('visible');
    expect(safeSerialize(value)).not.toMatch(/alpha|beta|gamma/);
  });

  it('redacts compound secret keys and secret-bearing string values', () => {
    const value = safeSerialize({ client_secret: 'alpha', private_key: 'beta', session_token: 'gamma', dbPassword: 'delta', oauthCredential: 'zeta', message: 'PASSWORD=epsilon', header: 'Authorization: Bearer theta' });
    expect(value).not.toMatch(/alpha|beta|gamma|delta|epsilon|zeta|theta/);
    expect(redactOutput('client_secret=synthetic-leak')).not.toContain('synthetic-leak');
  });

  it('fails closed for explicit keys, escaped keys and serialized wrappers', () => {
    const valid = JSON.stringify(JSON.stringify({ secret: ['alpha"]leak', 'beta'], safe: 'visible' }));
    for (const input of [
      '{"secret":["alpha","beta"],"safe":"visible"}',
      '{"\\u0073ecret":["alpha","beta"]}',
      valid.slice(0, -1),
      `x${valid}`,
      '{"payload":"{\\"secret\\":[\\"alpha\\"]}"',
    ]) {
      const output = redactOutput(input);
      expect(output).toBe(REDACTION_MARKER);
      expect(output).not.toMatch(/alpha|leak|beta/);
    }
  });

  it('fails closed for separator-obfuscated structured keys and nested serialized values', () => {
    for (const input of ['{"se\\u200bcret":"alpha"}', '{"se\\u2060cret":"alpha"}', '{"se\\u00adcret":"alpha"}', '{"sｅcret":"alpha"}', '{"api key":"alpha"}', 'API Key: alpha', 'Private Key: alpha']) {
      expect(redactOutput(input)).not.toContain('alpha');
      expect(safeSerialize({ message: input })).not.toContain('alpha');
    }
  });

  it('redacts bare private-key blocks at every output boundary', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nsynthetic-private-material\n-----END PRIVATE KEY-----\n';
    expect(redactOutput(pem)).not.toContain('synthetic-private-material');
    expect(safeErrorMessage(new Error(pem))).not.toContain('synthetic-private-material');
    expect(safePublicError('INVALID_REQUEST', pem).message).not.toContain('synthetic-private-material');
    expect(safeSerialize({ message: pem })).not.toContain('synthetic-private-material');
    const stream = new StreamingRedactor();
    const output = stream.push(pem) + stream.finish();
    expect(output).not.toContain('synthetic-private-material');
  });

  it('does not leak explicit values across stream chunks or newlines', () => {
    const redactor = new StreamingRedactor(['synthetic-stream-secret']);
    const output = [
      redactor.push(`prefix\nsynthetic-stream-`),
      redactor.push('secret\n'),
      redactor.push('{"secret":["alpha",\n"beta"]}\n'),
      redactor.finish(),
    ].join('');
    expect(output).not.toMatch(/synthetic-stream-secret|alpha|beta/);
    expect(output).toContain(REDACTION_MARKER);
    expect(output).toContain('prefix\n');
  });

  it('quarantines a structured prefix before a later chunk reveals sensitive fields', () => {
    const redactor = new StreamingRedactor();
    const output = redactor.push('{"safe":\n') + redactor.push('"visible","secret":"alpha"}\n') + redactor.finish();
    expect(output).not.toContain('alpha');
    expect(output).toContain(REDACTION_MARKER);
  });

  it('fails closed when a sensitive key is split across chunks', () => {
    const redactor = new StreamingRedactor();
    const output = redactor.push('{"se\n') + redactor.push('cret":"alpha"}\n') + redactor.finish();
    expect(output).not.toContain('alpha');
    expect(output).toContain(REDACTION_MARKER);
  });

  it('quarantines multiline sensitive records and private-key blocks', () => {
    const redactor = new StreamingRedactor();
    const output = redactor.push('private_key: -----BEGIN PRIVATE KEY-----\n')
      + redactor.push('synthetic-private-body\n-----END PRIVATE KEY-----\nordinary-safe-log\n')
      + redactor.finish();
    expect(output).not.toMatch(/synthetic-private-body|PRIVATE KEY/);
    expect(output).toContain('ordinary-safe-log');
    const generic = new StreamingRedactor();
    const genericOutput = generic.push('secret: alpha\n') + generic.push('continuation-secret\n\nordinary\n') + generic.finish();
    expect(genericOutput).not.toMatch(/alpha|continuation-secret|ordinary/);
  });

  it('quarantines malformed and prefixed structured payloads but preserves ordinary logs', () => {
    const valid = JSON.stringify(JSON.stringify({ secret: ['alpha"]leak', 'beta'], safe: 'visible' }));
    expect(redactOutput(valid.slice(0, -1))).toBe(REDACTION_MARKER);
    expect(redactOutput(`x${valid}`)).toBe(REDACTION_MARKER);
    expect(redactOutput('ordinary safe log')).toBe('ordinary safe log');
  });

  it('bounds input and streaming memory', () => {
    expect(redactOutput(`{"payload":"${'x'.repeat(300_000)}"}`)).toBe(REDACTION_MARKER);
    const redactor = new StreamingRedactor();
    expect(redactor.push('{' + 'x'.repeat(300_000))).toBe(REDACTION_MARKER);
    expect(redactor.finish()).toBe('');
  });

  it('keeps a quarantined stream closed after a resource limit', () => {
    const redactor = new StreamingRedactor();
    expect(redactor.push('{"secret":"alpha"' + 'x'.repeat(300_000))).toBe(REDACTION_MARKER);
    expect(redactor.push('\nSAFE_AFTER_QUARANTINE')).toBe('');
    expect(redactor.finish()).toBe('');
  });

  it('redacts header and assignment forms', () => {
    expect(redactOutput('Authorization: Bearer synthetic-bearer')).not.toContain('synthetic-bearer');
    expect(redactOutput('PASSWORD=synthetic-password')).toContain('[REDACTED]');
    for (const input of ['secret: alpha', 'password: beta', 'api_key: gamma', 'client_secret: delta', 'token: epsilon', 'credential: zeta', 'authorization=eta', 'Authorization: Basic theta', 'secret: alpha beta gamma', 'PASSWORD=one two three']) {
      expect(redactOutput(input)).not.toMatch(/alpha|beta|gamma|delta|epsilon|zeta|eta|theta|one|two|three/);
    }
    expect(safePublicError('INVALID_REQUEST', 'Authorization: Bearer synthetic-bearer').message).not.toContain('synthetic-bearer');
    expect(safePublicError('INVALID_REQUEST', 'PASSWORD=synthetic-password').message).not.toContain('synthetic-password');
  });
});
