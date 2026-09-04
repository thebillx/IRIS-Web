export const IRIS_VERSION = '0.0.0' as const;
export const IRIS_PLATFORM = 'darwin' as const;

export interface RuntimeIdentity {
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly platform: typeof IRIS_PLATFORM;
  readonly version: typeof IRIS_VERSION;
}

export type RuntimeStatus = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface ProjectReference {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
}

export interface RuntimeSession {
  readonly id: string;
  readonly clientId: string;
  readonly createdAt: string;
  readonly currentProjectId: string | null;
}

export interface RuntimeClientState {
  readonly clientId: string;
  readonly connected: boolean;
  readonly lastSeenAt: string;
}

export interface RuntimeHealth {
  readonly status: RuntimeStatus;
  readonly version: typeof IRIS_VERSION;
  readonly platform: typeof IRIS_PLATFORM;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly uptimeMs: number;
  readonly authority: 'owned';
  readonly connectedClients: number;
  readonly connectedSessions: number;
  readonly apiUrl: string;
  readonly mcpUrl: string;
}

export interface DoctorCheck {
  readonly code: string;
  readonly status: 'pass' | 'fail';
  readonly message: string;
}

export interface DoctorReport {
  readonly status: 'pass' | 'fail';
  readonly checks: readonly DoctorCheck[];
}

export type RuntimeFailureCode =
  | 'AUTHORITY_HELD'
  | 'AUTHORITY_INDETERMINATE'
  | 'AUTHORITY_CHANGED'
  | 'CONTROL_DENIED'
  | 'STALE_AUTHORITY'
  | 'PORT_UNAVAILABLE'
  | 'INVALID_PROJECT_PATH'
  | 'PROJECT_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'RUNTIME_NOT_RUNNING'
  | 'RUNTIME_SHUTTING_DOWN'
  | 'PERSISTENCE_FAILURE'
  | 'INVALID_REQUEST';

export class RuntimeError extends Error {
  public constructor(
    public readonly code: RuntimeFailureCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = 'RuntimeError';
    if (options?.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, configurable: true });
    }
  }
}
