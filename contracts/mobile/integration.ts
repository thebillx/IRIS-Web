import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ArtifactRetentionPolicy, ArtifactSensitivity } from '../../packages/domain/src/index.ts';
import type { Device } from './contract.ts';

const fail = (code: string): never => { throw new Error(code); };
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);

function loopbackUrl(value: string): string {
  const url = (() => {
    try { return new URL(value); } catch { return fail('APPIUM_ENDPOINT_DENIED'); }
  })();
  if (!['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password) fail('APPIUM_ENDPOINT_DENIED');
  return url.toString().replace(/\/$/, '');
}

function suitePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000
      || path.isAbsolute(value) || value.includes('\0') || !value.endsWith('.robot')) fail('INVALID_ROBOT_SUITE');
  const slash = value.replaceAll('\\', '/');
  if (slash.split('/').includes('..')) fail('INVALID_ROBOT_SUITE');
  const normalized = path.posix.normalize(slash);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) fail('INVALID_ROBOT_SUITE');
  return normalized;
}

export interface MobileRobotJobPlan {
  readonly executable: 'robot';
  readonly executionProfile: 'robot';
  readonly argv: readonly string[];
  readonly expectedEffects: readonly ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'];
  readonly jobId: string;
  readonly operationId: string;
  readonly device: Readonly<Pick<Device, 'serial' | 'connectionId' | 'kind'>>;
  readonly appiumEndpoint: string;
}

export function planRobotJob(input: Readonly<{
  suitePath: string;
  appiumEndpoint: string;
  device: Pick<Device, 'serial' | 'connectionId' | 'kind'>;
  jobId: string;
  operationId: string;
}>): MobileRobotJobPlan {
  if (!validId(input.jobId) || !validId(input.operationId)
      || !validId(input.device.serial) || !validId(input.device.connectionId)) fail('INVALID_ROBOT_IDENTITY');
  const endpoint = loopbackUrl(input.appiumEndpoint);
  const suite = suitePath(input.suitePath);
  return Object.freeze({
    executable: 'robot',
    executionProfile: 'robot',
    argv: Object.freeze([
      '--variable', `APPIUM_URL:${endpoint}`,
      '--variable', `UDID:${input.device.serial}`,
      '--variable', `IRIS_OPERATION_ID:${input.operationId}`,
      suite,
    ]),
    expectedEffects: Object.freeze(['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const),
    jobId: input.jobId,
    operationId: input.operationId,
    device: Object.freeze({ ...input.device }),
    appiumEndpoint: endpoint,
  });
}

export interface MobileArtifactRegistrationIntent {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly producerJobId: string;
  readonly operationId: string;
  readonly serial: string;
  readonly connectionId: string;
  readonly artifactType: 'mobile.screenshot' | 'mobile.page-source' | 'mobile.logcat';
  readonly mime: 'image/png' | 'application/xml; charset=utf-8' | 'text/plain; charset=utf-8';
  readonly size: number;
  readonly sha256: string;
  readonly sensitivity: ArtifactSensitivity;
  readonly retentionPolicy: ArtifactRetentionPolicy;
  readonly exportState: 'REVIEW_REQUIRED';
}

export function mobileArtifactIntent(input: Readonly<{
  kind: 'screenshot' | 'source' | 'logcat';
  bytes: Uint8Array;
  projectId: string;
  workspaceId: string;
  producerJobId: string;
  operationId: string;
  serial: string;
  connectionId: string;
}>): MobileArtifactRegistrationIntent {
  if (![input.projectId, input.workspaceId, input.producerJobId, input.operationId, input.serial, input.connectionId]
    .every(validId)) fail('INVALID_ARTIFACT_IDENTITY');
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length > 16 * 1024 * 1024) fail('INVALID_ARTIFACT_SIZE');
  const mapping = {
    screenshot: { artifactType: 'mobile.screenshot', mime: 'image/png' },
    source: { artifactType: 'mobile.page-source', mime: 'application/xml; charset=utf-8' },
    logcat: { artifactType: 'mobile.logcat', mime: 'text/plain; charset=utf-8' },
  } as const;
  const selected = mapping[input.kind];
  return Object.freeze({
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    producerJobId: input.producerJobId,
    operationId: input.operationId,
    serial: input.serial,
    connectionId: input.connectionId,
    artifactType: selected.artifactType,
    mime: selected.mime,
    size: input.bytes.length,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    sensitivity: 'RESTRICTED',
    retentionPolicy: 'EPHEMERAL',
    exportState: 'REVIEW_REQUIRED',
  });
}
