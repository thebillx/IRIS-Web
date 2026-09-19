import { createHash } from 'node:crypto';
import type {
  ArtifactId,
  ArtifactRecord,
  ArtifactReference,
  ArtifactRetentionPolicy,
  ArtifactSensitivity,
  JobId,
  WorkspaceId,
} from '@iris/domain';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const fail = (code: string): never => { throw new Error(code); };
const validId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);

export const mediaCompositionPrimitives = [
  'artifact.open_ref',
  'shell.run',
  'shell.start',
  'job.status',
  'job.logs',
  'job.result',
  'artifact.register_existing',
] as const;

export type MediaCompositionStep =
  | Readonly<{ primitive: 'artifact.open_ref'; artifactId: ArtifactId }>
  | Readonly<{
    primitive: 'shell.run';
    executable: 'ffprobe';
    executionProfile: 'ffprobe';
    expectedEffects: readonly ['READ', 'EXECUTE'];
    input: 'AUTHORIZED_ARTIFACT_REF';
  }>
  | Readonly<{
    primitive: 'shell.start';
    executable: 'ffmpeg';
    executionProfile: 'ffmpeg';
    inputArtifactIds: readonly ArtifactId[];
  }>
  | Readonly<{ primitive: 'job.status' | 'job.logs' | 'job.result' }>
  | Readonly<{ primitive: 'artifact.register_existing' }>;

export interface MediaProbePlan {
  readonly projectId: string;
  readonly workspaceId: WorkspaceId;
  readonly operationId: string;
  readonly sourceArtifactId: ArtifactId;
  readonly steps: readonly MediaCompositionStep[];
}

export function planMediaProbe(input: Readonly<{
  projectId: string;
  workspaceId: WorkspaceId;
  operationId: string;
  sourceArtifactId: ArtifactId;
}>): MediaProbePlan {
  if (![input.projectId, input.workspaceId, input.operationId, input.sourceArtifactId].every(validId)) fail('INVALID_MEDIA_IDENTITY');
  return Object.freeze({
    ...input,
    steps: Object.freeze([
      Object.freeze({ primitive: 'artifact.open_ref' as const, artifactId: input.sourceArtifactId }),
      Object.freeze({
        primitive: 'shell.run' as const,
        executable: 'ffprobe' as const,
        executionProfile: 'ffprobe' as const,
        expectedEffects: Object.freeze(['READ', 'EXECUTE'] as const),
        input: 'AUTHORIZED_ARTIFACT_REF' as const,
      }),
    ]),
  });
}

export interface MediaRenderPlan {
  readonly projectId: string;
  readonly workspaceId: WorkspaceId;
  readonly operationId: string;
  readonly producerJobId: JobId;
  readonly producerActionId: string;
  readonly sourceArtifactIds: readonly ArtifactId[];
  readonly steps: readonly MediaCompositionStep[];
}

export function planMediaRender(input: Readonly<{
  projectId: string;
  workspaceId: WorkspaceId;
  operationId: string;
  producerJobId: JobId;
  producerActionId: string;
  sourceArtifactIds: readonly ArtifactId[];
}>): MediaRenderPlan {
  if (![input.projectId, input.workspaceId, input.operationId, input.producerJobId, input.producerActionId].every(validId)
    || !Array.isArray(input.sourceArtifactIds) || input.sourceArtifactIds.length === 0 || input.sourceArtifactIds.length > 32
    || input.sourceArtifactIds.some((artifactId) => !validId(artifactId))
    || new Set(input.sourceArtifactIds).size !== input.sourceArtifactIds.length) fail('INVALID_MEDIA_IDENTITY');
  const sourceArtifactIds = Object.freeze([...input.sourceArtifactIds]);
  const openSteps = sourceArtifactIds.map((artifactId) =>
    Object.freeze({ primitive: 'artifact.open_ref' as const, artifactId }));
  return Object.freeze({
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    producerJobId: input.producerJobId,
    producerActionId: input.producerActionId,
    sourceArtifactIds,
    steps: Object.freeze([
      ...openSteps,
      Object.freeze({
        primitive: 'shell.start' as const,
        executable: 'ffmpeg' as const,
        executionProfile: 'ffmpeg' as const,
        inputArtifactIds: sourceArtifactIds,
      }),
      Object.freeze({ primitive: 'job.status' as const }),
      Object.freeze({ primitive: 'job.logs' as const }),
      Object.freeze({ primitive: 'job.result' as const }),
      Object.freeze({ primitive: 'artifact.register_existing' as const }),
    ]),
  });
}

export interface MediaArtifactRegistrationIntent {
  readonly projectId: string;
  readonly workspaceId: WorkspaceId;
  readonly producerJobId: JobId;
  readonly producerActionId: string;
  readonly artifactType: 'media.frame' | 'media.audio' | 'media.video' | 'media.probe';
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly sensitivity: ArtifactSensitivity;
  readonly retentionPolicy: ArtifactRetentionPolicy;
  readonly exportState: 'REVIEW_REQUIRED';
}

export function mediaArtifactIntent(input: Readonly<{
  projectId: string;
  workspaceId: WorkspaceId;
  producerJobId: JobId;
  producerActionId: string;
  artifactType: MediaArtifactRegistrationIntent['artifactType'];
  mime: string;
  bytes: Uint8Array;
}>): MediaArtifactRegistrationIntent {
  if (![input.projectId, input.workspaceId, input.producerJobId, input.producerActionId].every(validId)) fail('INVALID_MEDIA_IDENTITY');
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0 || input.bytes.length > 64 * 1024 * 1024) fail('INVALID_MEDIA_SIZE');
  if (typeof input.mime !== 'string' || input.mime.length === 0 || input.mime.length > 200
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.mime)) fail('INVALID_MEDIA_MIME');
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  if (!shaPattern.test(sha256)) fail('INVALID_MEDIA_HASH');
  return Object.freeze({
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    producerJobId: input.producerJobId,
    producerActionId: input.producerActionId,
    artifactType: input.artifactType,
    mime: input.mime.toLowerCase(),
    size: input.bytes.length,
    sha256,
    sensitivity: 'RESTRICTED',
    retentionPolicy: 'EPHEMERAL',
    exportState: 'REVIEW_REQUIRED',
  });
}

export function bindMediaArtifactReference(
  intent: MediaArtifactRegistrationIntent,
  record: ArtifactRecord,
): ArtifactReference {
  if (record.projectId !== intent.projectId
    || record.workspaceId !== intent.workspaceId
    || record.producerJobId !== intent.producerJobId
    || record.producerActionId !== intent.producerActionId
    || record.artifactType !== intent.artifactType
    || record.mime.toLowerCase() !== intent.mime
    || record.size !== intent.size
    || record.sha256 !== intent.sha256
    || record.sensitivity !== intent.sensitivity
    || record.retentionPolicy !== intent.retentionPolicy) {
    fail('ARTIFACT_REGISTRATION_MISMATCH');
  }
  return Object.freeze({
    artifactId: record.artifactId,
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    mime: record.mime,
    artifactType: record.artifactType,
    size: record.size,
    sha256: record.sha256,
    sensitivity: record.sensitivity,
    retentionPolicy: record.retentionPolicy,
  });
}
