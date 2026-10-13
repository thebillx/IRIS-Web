import assert from 'node:assert/strict';
import test from 'node:test';
import { redactOutput, StreamingRedactor } from './job-runner-redaction.mjs';

test('job runner redacts nested arrays and objects', () => {
  const output = redactOutput('{"secret":["alpha","beta"],"safe":"visible"}\n{"secret":{"a":"alpha","b":"beta"}}');
  assert.doesNotMatch(output, /alpha|beta/);
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /"safe":"visible"/);
});

test('job runner streaming redaction does not leak split structured values', () => {
  const redactor = new StreamingRedactor();
  const output = [
    redactor.push(`${'x'.repeat(4_200)}{"secret":["alpha",`),
    redactor.push('"beta"],"safe":"visible"}'),
    redactor.finish(),
  ].join('');
  assert.doesNotMatch(output, /alpha|beta/);
  assert.match(output, /"safe":"visible"/);
});
