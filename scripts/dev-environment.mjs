import { node24Environment } from './node24.mjs';
import process from 'node:process';

export function runtimeEnvironment(source = process.env) {
  const environment = node24Environment(source);
  delete environment.IRIS_OWNER_ACCESS_TOKEN;
  return environment;
}
