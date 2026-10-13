import { describe, expect, it } from 'vitest';
import { redactOutput, StreamingRedactor } from './output-redaction.js';

describe('secret-safe output redaction', () => {
  it('redacts quoted JSON keys, escaped JSON values, and header forms', () => {
    const output = '{"secret":"synthetic-owner-secret","api_key":"synthetic-api-key","safe":"visible"} Authorization: Bearer synthetic-bearer';
    const escaped = '{"secret":"synthetic\\u002downer\\u002dsecret"}';
    const escapedEnvelope = '{"payload":"{\\"secret\\":\\"synthetic-escaped-secret\\"}"}';
    const redacted = redactOutput(`${output}\n${escaped}\n${escapedEnvelope}`);

    expect(redacted).not.toContain('synthetic-owner-secret');
    expect(redacted).not.toContain('synthetic-api-key');
    expect(redacted).not.toContain('synthetic-bearer');
    expect(redacted).not.toContain('synthetic-escaped-secret');
    expect(redactOutput('token=Bearer synthetic-token-secret')).toContain('token=Bearer [REDACTED]');
    expect(redacted).toContain('visible');
    expect(redacted).toContain('[REDACTED]');
  });

  it('does not leak an explicit value split across streamed chunks', () => {
    const secret = 'synthetic-stream-secret-0123456789';
    const redactor = new StreamingRedactor([secret]);
    const output = [
      redactor.push(`${'x'.repeat(4_200)}${secret.slice(0, 15)}`),
      redactor.push(`${secret.slice(15)}-tail`),
      redactor.finish(),
    ].join('');

    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
  });

  it('holds a long sensitive assignment until its line can be redacted as a unit', () => {
    const redactor = new StreamingRedactor();
    const secret = 'long-generic-secret-'.padEnd(6_000, 'x');
    const output = `${redactor.push(`prefix\nPASSWORD=${secret}`)}${redactor.finish()}`;
    expect(output).not.toContain(secret);
    expect(output).toContain('PASSWORD=[REDACTED]');
  });

  it('redacts complete nested arrays and objects without leaking sibling values', () => {
    const output = redactOutput('{"secret":["alpha","beta"],"safe":"visible"}\n{"secret":{"a":"alpha","b":"beta"},"safe":"visible"}');
    expect(output).not.toContain('alpha');
    expect(output).not.toContain('beta');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('"safe":"visible"');
  });

  it('holds a chunked structured value until the complete value can be redacted', () => {
    const redactor = new StreamingRedactor();
    const output = [
      redactor.push(`${'x'.repeat(4_200)}{"secret":["alpha",`),
      redactor.push('"beta"],"safe":"visible"}'),
      redactor.finish(),
    ].join('');
    expect(output).not.toContain('alpha');
    expect(output).not.toContain('beta');
    expect(output).toContain('"safe":"visible"');
  });
});
