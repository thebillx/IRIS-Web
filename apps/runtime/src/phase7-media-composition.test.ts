import { describe, expect, it } from 'vitest';
import type { ArtifactId, ArtifactRecord, JobId, WorkspaceId } from '@iris/domain';
import {
  bindMediaArtifactReference,
  mediaArtifactIntent,
  mediaCompositionPrimitives,
  planMediaProbe,
  planMediaRender,
} from './phase7-media-composition.js';

const workspaceId = 'workspace-p7' as WorkspaceId;
const producerJobId = 'media-job-1' as JobId;
const producerActionId = 'media-action-1';
const sourceVideoId = 'source-video-1' as ArtifactId;
const sourceAudioId = 'source-audio-1' as ArtifactId;

describe('Phase 7 media composition acceptance', () => {
  it('AC-MEDIA-001 composes media only from existing artifact/shell/job primitives', () => {
    const probe = planMediaProbe({
      projectId: 'project-p7',
      workspaceId,
      operationId: 'media-probe-1',
      sourceArtifactId: sourceVideoId,
    });
    expect(probe.steps.map((step) => step.primitive)).toEqual(['artifact.open_ref', 'shell.run']);
    expect(probe.steps[1]).toMatchObject({
      executable: 'ffprobe',
      executionProfile: 'ffprobe',
      expectedEffects: ['READ', 'EXECUTE'],
    });

    const render = planMediaRender({
      projectId: 'project-p7',
      workspaceId,
      operationId: 'media-render-1',
      producerJobId,
      producerActionId,
      sourceArtifactIds: [sourceVideoId, sourceAudioId],
    });
    expect(render.steps.every((step) => mediaCompositionPrimitives.includes(step.primitive))).toBe(true);
    expect(render.steps.some((step) => step.primitive === 'shell.start'
      && step.executionProfile === 'ffmpeg')).toBe(true);
    expect(render.steps.map((step) => step.primitive)).not.toContain('media.execute');
    expect(render.producerJobId).toBe(producerJobId);
    expect(render.producerActionId).toBe(producerActionId);
  });

  it('AC-NINJA-007 binds generated frame/audio/video registrations to distinct safe artifact refs', () => {
    const common = {
      projectId: 'project-p7',
      workspaceId,
      producerJobId,
      producerActionId,
    };
    const intents = [
      mediaArtifactIntent({
        ...common,
        artifactType: 'media.frame',
        mime: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
      }),
      mediaArtifactIntent({
        ...common,
        artifactType: 'media.audio',
        mime: 'audio/wav',
        bytes: new Uint8Array([4, 5, 6]),
      }),
      mediaArtifactIntent({
        ...common,
        artifactType: 'media.video',
        mime: 'video/mp4',
        bytes: new Uint8Array([7, 8, 9]),
      }),
    ] as const;

    const artifactIds = ['artifact-frame-1', 'artifact-audio-1', 'artifact-video-1'] as const;
    const records: ArtifactRecord[] = intents.map((intent, index) => ({
      artifactId: artifactIds[index] as ArtifactId,
      physicalPath: `/private/runtime/media-output-${index}`,
      projectId: intent.projectId,
      workspaceId: intent.workspaceId,
      producerJobId: intent.producerJobId,
      producerActionId: intent.producerActionId,
      mime: intent.mime,
      artifactType: intent.artifactType,
      size: intent.size,
      sha256: intent.sha256,
      sensitivity: intent.sensitivity,
      createdAt: '2026-09-19T00:00:00.000Z',
      retentionPolicy: intent.retentionPolicy,
    }));

    const refs = intents.map((intent, index) => bindMediaArtifactReference(intent, records[index]!));
    expect(new Set(refs.map((ref) => ref.artifactId)).size).toBe(3);
    expect(new Set(refs.map((ref) => ref.sha256)).size).toBe(3);

    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index]!;
      const intent = intents[index]!;
      expect(ref).toMatchObject({
        artifactId: artifactIds[index],
        projectId: intent.projectId,
        workspaceId: intent.workspaceId,
        mime: intent.mime,
        artifactType: intent.artifactType,
        size: intent.size,
        sha256: intent.sha256,
      });
      expect(ref).not.toHaveProperty('physicalPath');
      expect(ref).not.toHaveProperty('producerJobId');
      expect(ref).not.toHaveProperty('producerActionId');
      expect(ref).not.toHaveProperty('bytes');
      expect(ref).not.toHaveProperty('content');
    }

    expect(JSON.stringify(refs)).not.toContain('/private/runtime/');
  });

  it('rejects registry records whose producer or byte identity differs from the registration intent', () => {
    const intent = mediaArtifactIntent({
      projectId: 'project-p7',
      workspaceId,
      producerJobId,
      producerActionId,
      artifactType: 'media.video',
      mime: 'video/mp4',
      bytes: new Uint8Array([1, 2, 3]),
    });
    const record: ArtifactRecord = {
      artifactId: 'artifact-video-mismatch' as ArtifactId,
      physicalPath: '/private/runtime/video',
      projectId: intent.projectId,
      workspaceId: intent.workspaceId,
      producerJobId: intent.producerJobId,
      producerActionId: 'other-action',
      mime: intent.mime,
      artifactType: intent.artifactType,
      size: intent.size,
      sha256: intent.sha256,
      sensitivity: intent.sensitivity,
      createdAt: '2026-09-19T00:00:00.000Z',
      retentionPolicy: intent.retentionPolicy,
    };
    expect(() => bindMediaArtifactReference(intent, record)).toThrow('ARTIFACT_REGISTRATION_MISMATCH');
    expect(() => bindMediaArtifactReference(intent, { ...record, producerActionId, sha256: 'f'.repeat(64) }))
      .toThrow('ARTIFACT_REGISTRATION_MISMATCH');
  });

  it('rejects zero-byte media outputs instead of producing a false-success artifact receipt', () => {
    expect(() => mediaArtifactIntent({
      projectId: 'project-p7',
      workspaceId,
      producerJobId: 'media-job-empty' as JobId,
      producerActionId: 'media-action-empty',
      artifactType: 'media.video',
      mime: 'video/mp4',
      bytes: new Uint8Array(),
    })).toThrow('INVALID_MEDIA_SIZE');
  });

  it('rejects raw/unknown media authority by construction', () => {
    expect(mediaCompositionPrimitives).toEqual([
      'artifact.open_ref',
      'shell.run',
      'shell.start',
      'job.status',
      'job.logs',
      'job.result',
      'artifact.register_existing',
    ]);
    expect(mediaCompositionPrimitives.join(' ')).not.toMatch(/media\.execute|shell-string|raw-http/i);
  });
});
