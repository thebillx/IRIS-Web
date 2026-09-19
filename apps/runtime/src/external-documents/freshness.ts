import type { ExternalRevisionSnapshot } from './revision-correlation.js';

export type ExternalKnowledgeFreshness = 'CURRENT' | 'STALE_SOURCE' | 'STALE_AGE';

export interface ExternalKnowledgeProjection {
  readonly projectId: string;
  readonly sourceId: string;
  readonly sourceLinkIdentity: string;
  readonly sourceVersion: string;
  readonly contentSha256: string | null;
  readonly builtAt: string;
  readonly topicIds: readonly string[];
}

export interface ExternalFreshnessAssessment {
  readonly state: ExternalKnowledgeFreshness;
  readonly affectedTopicIds: readonly string[];
  readonly reason: 'SOURCE_CHANGED' | 'AGE_LIMIT' | 'NONE';
}

export function assessExternalKnowledgeFreshness(
  projection: ExternalKnowledgeProjection,
  current: ExternalRevisionSnapshot,
  now: string,
  maxAgeMs: number,
): ExternalFreshnessAssessment {
  validateProjection(projection);
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error('INVALID_FRESHNESS_POLICY');
  if (projection.projectId !== current.projectId
    || projection.sourceId !== current.sourceId
    || projection.sourceLinkIdentity !== current.sourceLinkIdentity) throw new Error('FRESHNESS_IDENTITY_MISMATCH');
  const sourceChanged = projection.sourceVersion !== current.version || projection.contentSha256 !== current.contentSha256;
  if (sourceChanged) return Object.freeze({ state: 'STALE_SOURCE', affectedTopicIds: Object.freeze([...projection.topicIds]), reason: 'SOURCE_CHANGED' });
  if (Date.parse(now) - Date.parse(projection.builtAt) > maxAgeMs) {
    return Object.freeze({ state: 'STALE_AGE', affectedTopicIds: Object.freeze([...projection.topicIds]), reason: 'AGE_LIMIT' });
  }
  return Object.freeze({ state: 'CURRENT', affectedTopicIds: Object.freeze([]), reason: 'NONE' });
}

function validateProjection(value: ExternalKnowledgeProjection): void {
  if (!bounded(value.projectId) || !bounded(value.sourceId) || !opaque(value.sourceLinkIdentity)
    || !opaque(value.sourceVersion) || !timestamp(value.builtAt)
    || (value.contentSha256 !== null && !/^[a-f0-9]{64}$/.test(value.contentSha256))
    || !Array.isArray(value.topicIds) || value.topicIds.length === 0 || value.topicIds.length > 10_000
    || value.topicIds.some(item => !bounded(item)) || new Set(value.topicIds).size !== value.topicIds.length) {
    throw new Error('INVALID_FRESHNESS_PROJECTION');
  }
}
const bounded = (value: string) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const opaque = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\r\n\0]/.test(value);
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
