import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeEnvironment } from './dev-environment.mjs';

test('runtime child environment excludes the raw owner token', () => {
  const source = { PATH: '/synthetic', IRIS_OWNER_ACCESS_TOKEN: 'synthetic-owner-token', IRIS_RUNTIME_PORT: '46710' };
  const environment = runtimeEnvironment(source);
  assert.equal(environment.IRIS_OWNER_ACCESS_TOKEN, undefined);
  assert.equal(environment.IRIS_RUNTIME_PORT, '46710');
  assert.equal(source.IRIS_OWNER_ACCESS_TOKEN, 'synthetic-owner-token');
});
