import { createHash } from 'node:crypto';
import type { ArtifactReference } from '@iris/domain';
import {
  bindExternalDocumentAcquisition,
  ExternalDocumentContractError,
  type ExternalDocumentAdapter,
  type ExternalDocumentEvidence,
  type ExternalDocumentGrant,
  type ExternalDocumentReference,
  type ExternalDocumentRequest,
} from './contract.js';

export interface ExternalDocumentAcquisitionResult {
  readonly reference: ExternalDocumentReference;
  readonly evidence: ExternalDocumentEvidence;
  readonly content: Uint8Array;
}

export interface AcquireExternalDocumentInput<Auth> {
  readonly reference: ExternalDocumentReference;
  readonly grant: ExternalDocumentGrant;
  readonly request: ExternalDocumentRequest;
  readonly adapter: ExternalDocumentAdapter<Auth>;
  readonly auth: Auth;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export async function acquireExternalDocument<Auth>(
  input: AcquireExternalDocumentInput<Auth>,
): Promise<ExternalDocumentAcquisitionResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const request = bindExternalDocumentAcquisition(input.grant, input.request, startedAt);
  assertReferenceBinding(input.reference, input.grant, request);
  if (input.adapter.connectorId !== input.grant.connectorId || input.adapter.provider !== input.grant.provider) {
    throw new ExternalDocumentContractError('UNAUTHORIZED');
  }

  const controller = new AbortController();
  const parentAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) parentAbort();
  else input.signal?.addEventListener('abort', parentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('TIMEOUT')), input.grant.limits.timeoutMs);

  try {
    const status = await withAbort(input.adapter.status(controller.signal), controller.signal);
    if (status !== 'available') throw new ExternalDocumentContractError('ACQUISITION_FAILED');

    const acquired = await withAbort(input.adapter.acquire(request, {
      auth: input.auth,
      signal: controller.signal,
      expectedVersion: request.expectedVersion,
      limits: input.grant.limits,
    }), controller.signal);

    if (acquired.sourceId !== request.sourceId
      || (request.expectedVersion !== null && acquired.version !== request.expectedVersion)) {
      throw new ExternalDocumentContractError('SOURCE_CHANGED');
    }
    if (typeof acquired.version !== 'string' || acquired.version.length === 0 || acquired.version.length > 2048) {
      throw new ExternalDocumentContractError('ACQUISITION_FAILED');
    }
    if (!Array.isArray(acquired.artifacts) || acquired.artifacts.length > input.grant.limits.maxArtifacts) {
      throw new ExternalDocumentContractError('LIMIT_EXCEEDED');
    }
    for (const artifact of acquired.artifacts) assertArtifactAuthority(artifact, input.grant);

    const chunks: Uint8Array[] = [];
    let size = 0;
    const digest = createHash('sha256');
    try {
      for await (const chunk of acquired.content) {
        if (controller.signal.aborted) throw timeoutOrCancellation(controller.signal);
        if (!(chunk instanceof Uint8Array)) throw new ExternalDocumentContractError('ACQUISITION_FAILED');
        size += chunk.byteLength;
        if (size > input.grant.limits.maxContentBytes) throw new ExternalDocumentContractError('LIMIT_EXCEEDED');
        const owned = chunk.slice();
        chunks.push(owned);
        digest.update(owned);
      }
    } catch (error) {
      if (controller.signal.aborted) throw timeoutOrCancellation(controller.signal);
      if (error instanceof ExternalDocumentContractError) throw error;
      throw new ExternalDocumentContractError('ACQUISITION_FAILED');
    }

    const content = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
    const acquiredAt = new Date(now()).toISOString();
    const acquisitionId = 'external-acq:' + createHash('sha256').update(JSON.stringify([
      request.requestId, input.grant.connectorId, input.grant.connectorBindingId, request.provider,
      request.sourceId, acquired.version, input.reference.sourceLinkIdentity, acquiredAt,
    ])).digest('hex').slice(0, 32);

    const evidence: ExternalDocumentEvidence = Object.freeze({
      authority: 'SUPPORTING_EVIDENCE',
      provenance: Object.freeze({
        acquisitionId,
        requestId: request.requestId,
        projectId: request.projectId,
        connectorId: input.grant.connectorId,
        connectorBindingId: input.grant.connectorBindingId,
        provider: request.provider,
        sourceId: request.sourceId,
        version: acquired.version,
        sourceLinkIdentity: input.reference.sourceLinkIdentity,
        acquiredAt,
      }),
      status: 'complete',
      artifacts: Object.freeze(acquired.artifacts.map(artifact => Object.freeze({ ...artifact }))),
      contentSha256: digest.digest('hex'),
      failures: Object.freeze([]),
    });
    return Object.freeze({ reference: Object.freeze({ ...input.reference }), evidence, content });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', parentAbort);
  }
}

function assertReferenceBinding(
  reference: ExternalDocumentReference,
  grant: ExternalDocumentGrant,
  request: ExternalDocumentRequest,
): void {
  if (reference.authority !== 'REFERENCE_ONLY'
    || reference.projectId !== grant.projectId
    || reference.projectId !== request.projectId
    || reference.provider !== grant.provider
    || reference.provider !== request.provider
    || reference.sourceId !== request.sourceId) {
    throw new ExternalDocumentContractError('UNAUTHORIZED');
  }
}

function assertArtifactAuthority(artifact: ArtifactReference, grant: ExternalDocumentGrant): void {
  if (artifact.projectId !== grant.projectId
    || artifact.workspaceId !== grant.outputWorkspaceId
    || !Number.isSafeInteger(artifact.size) || artifact.size < 0
    || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new ExternalDocumentContractError('UNAUTHORIZED');
  }
}

async function withAbort<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) throw timeoutOrCancellation(signal);
  return await new Promise<Value>((resolve, reject) => {
    const aborted = () => reject(timeoutOrCancellation(signal));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => {
        signal.removeEventListener('abort', aborted);
        if (signal.aborted) reject(timeoutOrCancellation(signal));
        else if (error instanceof ExternalDocumentContractError) reject(error);
        else reject(new ExternalDocumentContractError('ACQUISITION_FAILED'));
      },
    );
  });
}

function timeoutOrCancellation(signal: AbortSignal): ExternalDocumentContractError {
  return signal.reason instanceof Error && signal.reason.message === 'TIMEOUT'
    ? new ExternalDocumentContractError('TIMEOUT')
    : new ExternalDocumentContractError('ACQUISITION_FAILED');
}
