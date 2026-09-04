export interface RuntimeIdentity {
  readonly instanceId: string;
  readonly processId: number;
  readonly startedAt: string;
}

export type RuntimeStatus = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface RuntimeHealth {
  readonly status: RuntimeStatus;
  readonly version: string;
  readonly platform: 'darwin';
}

export interface ProjectReference {
  readonly id: string;
  readonly rootPath: string;
}

export interface ActiveProject {
  readonly project: ProjectReference;
  readonly activatedAt: string;
}

export type AuthorityState =
  | { readonly kind: 'unowned' }
  | { readonly kind: 'owned'; readonly owner: RuntimeIdentity }
  | { readonly kind: 'indeterminate'; readonly reason: string };
