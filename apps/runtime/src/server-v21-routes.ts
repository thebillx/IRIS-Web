import { RuntimeError, type MissionEvidence } from '@iris/domain';
import type { IncomingMessage } from 'node:http';
import type { DurableMissionLifecycleService } from './durable-mission-service.js';

export interface V21OwnerRouteResult {
  readonly status: number;
  readonly value: unknown;
}

type ReadJsonBody = (request: IncomingMessage, allowEmpty?: boolean) => Promise<Record<string, unknown> | null>;

export async function handleV21OwnerRoute(
  request: IncomingMessage,
  url: URL,
  lifecycle: DurableMissionLifecycleService,
  readJsonBody: ReadJsonBody,
): Promise<V21OwnerRouteResult | null> {
  const match = /^\/missions\/([^/]+)\/lifecycle(?:\/([^/]+))?$/.exec(url.pathname);
  if (match === null) return null;
  const missionId = decodeURIComponent(match[1]!);
  const action = match[2] ?? null;

  if (request.method === 'GET' && action === null) return ok(await lifecycle.get(missionId));
  if (request.method !== 'POST' || action === null) return null;
  const body = await readJsonBody(request);

  if (action === 'start') return ok(await lifecycle.start({
    missionId,
    expectedRevision: positiveInteger(body, 'expectedRevision'),
    requestId: stringField(body, 'requestId', 200),
    workerType: stringField(body, 'workerType', 200),
  }));
  if (action === 'checkpoint') return ok(await lifecycle.checkpoint({
    missionId,
    expectedRevision: positiveInteger(body, 'expectedRevision'),
    checkpointId: stringField(body, 'checkpointId', 200),
    summary: stringField(body, 'summary', 2_000),
    evidenceRefs: stringArrayField(body, 'evidenceRefs'),
  }));
  if (action === 'directive') return ok(await lifecycle.acceptDirective({
    missionId,
    basedOnRevision: positiveInteger(body, 'basedOnRevision'),
    directiveId: stringField(body, 'directiveId', 200),
    directive: stringField(body, 'directive', 4_000),
  }));
  if (action === 'resume') return ok(await lifecycle.resume({
    missionId,
    expectedRevision: positiveInteger(body, 'expectedRevision'),
    requestId: stringField(body, 'requestId', 200),
  }));
  if (action === 'cancel') return ok(await lifecycle.cancel({
    missionId,
    expectedRevision: positiveInteger(body, 'expectedRevision'),
    requestId: stringField(body, 'requestId', 200),
  }));
  if (action === 'complete') return ok(await lifecycle.complete({
    missionId,
    expectedRevision: positiveInteger(body, 'expectedRevision'),
    requestId: stringField(body, 'requestId', 200),
  }));
  if (action === 'evidence') return ok(await lifecycle.appendEvidence({
    missionId,
    expectedRevision: positiveInteger(body, 'expectedRevision'),
    evidence: evidenceField(body, 'evidence'),
  }));
  return null;
}

function ok(value: unknown): V21OwnerRouteResult { return { status: 200, value }; }

function evidenceField(body: Record<string, unknown> | null, name: string): MissionEvidence {
  const value = body?.[name];
  if (!isRecord(value)) throw new RuntimeError('INVALID_REQUEST', `${name} must be an evidence object`);
  const kind = value.kind;
  if (kind !== 'CAPABILITY_RESULT' && kind !== 'AUDIT' && kind !== 'ARTIFACT' && kind !== 'OBSERVATION') {
    throw new RuntimeError('INVALID_REQUEST', `${name}.kind is invalid`);
  }
  if (value.reference !== null && typeof value.reference !== 'string') {
    throw new RuntimeError('INVALID_REQUEST', `${name}.reference must be a string or null`);
  }
  if (!isScalarRecord(value.data)) throw new RuntimeError('INVALID_REQUEST', `${name}.data must contain bounded scalar values`);
  return {
    id: stringField(value, 'id', 200),
    kind,
    label: stringField(value, 'label', 120),
    summary: stringField(value, 'summary', 500),
    reference: value.reference,
    data: value.data,
  };
}

function positiveInteger(body: Record<string, unknown> | null, name: string): number {
  const value = body?.[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RuntimeError('INVALID_REQUEST', `${name} must be a positive integer`);
  }
  return value;
}

function stringField(body: Record<string, unknown> | null, name: string, max: number): string {
  const value = body?.[name];
  if (typeof value !== 'string') throw new RuntimeError('INVALID_REQUEST', `${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max || normalized.includes('\0')) {
    throw new RuntimeError('INVALID_REQUEST', `${name} is invalid`);
  }
  return normalized;
}

function stringArrayField(body: Record<string, unknown> | null, name: string): readonly string[] {
  const value = body?.[name];
  if (!Array.isArray(value) || value.length > 24) throw new RuntimeError('INVALID_REQUEST', `${name} must be a bounded string array`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > 1_000 || item.includes('\0')) {
      throw new RuntimeError('INVALID_REQUEST', `${name}[${index}] must be a bounded string`);
    }
    return item.trim();
  });
}

function isScalarRecord(value: unknown): value is Readonly<Record<string, string | number | boolean | null>> {
  return isRecord(value) && Object.keys(value).length <= 24 && Object.entries(value).every(([key, item]) => key.length > 0 && key.length <= 120
    && (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
      || (typeof item === 'string' && item.length <= 2_048 && !item.includes('\0'))));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
