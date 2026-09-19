import type { ArtifactReference } from '@iris/domain';
import type {
  ExternalDocumentAdapter, ExternalDocumentGrant, ExternalDocumentOperation,
  ExternalDocumentProvider, ExternalDocumentRequest,
} from './contract.js';

export interface ExternalReadReceipt {
  readonly sourceId: string;
  readonly version: string;
  readonly content: AsyncIterable<Uint8Array>;
  readonly artifacts: readonly ArtifactReference[];
}

/** Trusted SharePoint transport. It accepts source identity only; URL/header construction is connector-owned. */
export interface SharePointReadPort<Auth> {
  status(signal: AbortSignal): Promise<'available' | 'unavailable'>;
  read(input: {
    readonly sourceId: string;
    readonly operation: ExternalDocumentOperation;
    readonly auth: Auth;
    readonly signal: AbortSignal;
    readonly limits: ExternalDocumentGrant['limits'];
  }): Promise<ExternalReadReceipt>;
}

export class SharePointExternalDocumentAdapter<Auth> implements ExternalDocumentAdapter<Auth> {
  readonly provider = 'sharepoint' as const;
  constructor(readonly connectorId: string, private readonly port: SharePointReadPort<Auth>) {}
  status(signal: AbortSignal) { return this.port.status(signal); }
  async acquire(request: ExternalDocumentRequest, context: {
    readonly auth: Auth; readonly signal: AbortSignal; readonly expectedVersion: string | null;
    readonly limits: ExternalDocumentGrant['limits'];
  }) {
    if (request.provider !== 'sharepoint') throw new Error('PROVIDER_MISMATCH');
    return await this.port.read({ sourceId: request.sourceId, operation: request.operation, auth: context.auth, signal: context.signal, limits: context.limits });
  }
}

export interface LocalDocumentExtractionPort<Auth> {
  status(signal: AbortSignal): Promise<'available' | 'unavailable'>;
  extract(input: {
    readonly provider: 'pdf' | 'excel';
    readonly artifactId: string;
    readonly operation: ExternalDocumentOperation;
    readonly auth: Auth;
    readonly signal: AbortSignal;
    readonly limits: ExternalDocumentGrant['limits'];
  }): Promise<ExternalReadReceipt>;
}

export class LocalArtifactDocumentAdapter<Auth> implements ExternalDocumentAdapter<Auth> {
  constructor(
    readonly connectorId: string,
    readonly provider: 'pdf' | 'excel',
    private readonly port: LocalDocumentExtractionPort<Auth>,
  ) {}
  status(signal: AbortSignal) { return this.port.status(signal); }
  async acquire(request: ExternalDocumentRequest, context: {
    readonly auth: Auth; readonly signal: AbortSignal; readonly expectedVersion: string | null;
    readonly limits: ExternalDocumentGrant['limits'];
  }) {
    if (request.provider !== this.provider) throw new Error('PROVIDER_MISMATCH');
    return await this.port.extract({ provider: this.provider, artifactId: request.sourceId, operation: request.operation, auth: context.auth, signal: context.signal, limits: context.limits });
  }
}

export function isLocalDocumentProvider(provider: ExternalDocumentProvider): provider is 'pdf' | 'excel' {
  return provider === 'pdf' || provider === 'excel';
}
