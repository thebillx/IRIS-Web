import path from 'node:path';
import type {
  CapabilityDefinition,
  CapabilityId,
  PermissionDecisionRecord,
  PermissionMode,
  ProjectReference,
} from '@iris/domain';
import { capabilityDefinition, listCapabilities } from './capability-registry.js';
import { PermissionSettingsStore } from './permission-store.js';
import { inspectProjectTarget, inspectRegistrationRoot, pathIsWithin, type ProjectTargetKind } from './project-path.js';
import type { RuntimeState } from './state.js';

export const LEGACY_REFERENCE_ROOT = '/Users/bill/iris-native-runtime' as const;

export interface PolicyRequest {
  readonly capabilityId: string;
  readonly clientId?: string | null | undefined;
  readonly sessionId?: string | null | undefined;
  readonly agentId?: string | null | undefined;
  readonly projectId?: string | null | undefined;
  readonly targetPath?: string | null | undefined;
}

export interface PermissionSnapshot {
  readonly mode: PermissionMode;
  readonly approvedRoots: readonly string[];
  readonly autoApprovedCategories: readonly string[];
  readonly ownerRequiredCategories: readonly string[];
  readonly capabilities: readonly CapabilityDefinition[];
}

interface ScopeResult {
  readonly valid: boolean;
  readonly reason: string;
  readonly projectId: string | null;
  readonly target: string | null;
}

export class PermissionPolicyEngine {
  public constructor(
    private readonly state: RuntimeState,
    private readonly settings: PermissionSettingsStore,
    private readonly sourceRoot: string,
    private readonly dataRoot: string,
    private readonly legacyReferenceRoot: string = LEGACY_REFERENCE_ROOT,
  ) {}

  public async snapshot(): Promise<PermissionSnapshot> {
    const [settings, projects] = await Promise.all([this.settings.read(), this.state.listProjects()]);
    return {
      mode: settings.mode,
      approvedRoots: unique([this.sourceRoot, this.dataRoot, ...projects.map((project) => project.rootPath)]),
      autoApprovedCategories: autoCategories(settings.mode),
      ownerRequiredCategories: [
        'sudo/root/system security changes',
        'external project-root expansion',
        'credentials and secret mutation',
        'remote publication/account mutation',
        'paid/proprietary or license-sensitive dependency adoption',
        'unknown or unimplemented capabilities',
      ],
      capabilities: listCapabilities(),
    };
  }

  public async evaluate(input: PolicyRequest): Promise<PermissionDecisionRecord> {
    input = { ...input, agentId: this.effectiveAgentId(input) };
    const definition = capabilityDefinition(input.capabilityId);
    if (definition === null) return record(input, 'HIGH', 'DENY', 'Unknown capability fails closed', null, null);

    if (definition.riskClass === 'SYSTEM') {
      return record(input, definition.riskClass, 'OWNER_REQUIRED', 'System privilege or trust escalation always requires the owner', input.projectId ?? null, normalizedDisplayTarget(input.targetPath));
    }
    if (definition.riskClass === 'HIGH' || definition.requiredScope === 'OWNER') {
      return record(input, definition.riskClass, 'OWNER_REQUIRED', 'High-risk trust expansion requires the owner', input.projectId ?? null, normalizedDisplayTarget(input.targetPath));
    }

    const requestedTarget = normalizedDisplayTarget(input.targetPath);
    if (definition.mutation && requestedTarget !== null && pathIsWithin(this.legacyReferenceRoot, requestedTarget)) {
      return record(input, definition.riskClass, 'DENY', 'Legacy reference root is permanently read-only', input.projectId ?? null, requestedTarget);
    }

    const scope = await this.resolveScope(definition, input);
    if (!scope.valid) return record(input, definition.riskClass, 'DENY', scope.reason, scope.projectId, scope.target);
    if (scope.target !== null && definition.mutation && pathIsWithin(this.legacyReferenceRoot, scope.target)) {
      return record(input, definition.riskClass, 'DENY', 'Legacy reference root is permanently read-only', scope.projectId, scope.target);
    }
    if (!definition.implemented) {
      return record(input, definition.riskClass, 'DENY', 'Capability is not implemented in the local registry', scope.projectId, scope.target);
    }

    if (definition.id === 'project.register' && scope.target !== null && !pathIsWithin(this.sourceRoot, scope.target)) {
      const existing = (await this.state.listProjects()).find((project) => project.rootPath === scope.target);
      if (existing === undefined) {
        return record(input, definition.riskClass, 'OWNER_REQUIRED', 'Registering an external project expands writable authority', null, scope.target);
      }
    }

    const settings = await this.settings.read();
    const override = scope.projectId !== null
      && settings.projectOverrides.some((entry) => entry.projectId === scope.projectId && entry.capabilityId === definition.id);
    if (override) {
      return record(input, definition.riskClass, 'ALLOW_AUTO', 'Owner-approved project policy override matches this capability', scope.projectId, scope.target);
    }

    const decision = decideMode(settings.mode, definition);
    return record(input, definition.riskClass, decision, decisionReason(settings.mode, definition, decision), scope.projectId, scope.target);
  }

  public setMode(mode: PermissionMode): Promise<unknown> {
    return this.settings.setMode(mode);
  }

  public addProjectOverride(projectId: string, capabilityId: CapabilityId): Promise<unknown> {
    return this.settings.addProjectOverride(projectId, capabilityId);
  }

  private effectiveAgentId(input: PolicyRequest): string | null {
    const sessionId = input.sessionId?.trim() ?? '';
    const clientId = input.clientId?.trim() ?? '';
    if (sessionId.length > 0 && clientId.length > 0) {
      try {
        return this.state.getSessionForClient(sessionId, clientId).agentId;
      } catch {
        return null;
      }
    }
    return input.agentId?.trim() || null;
  }

  private async resolveScope(definition: CapabilityDefinition, input: PolicyRequest): Promise<ScopeResult> {
    if (definition.id === 'project.register') {
      const registration = await inspectRegistrationRoot(normalizedDisplayTarget(input.targetPath));
      return {
        valid: registration.valid,
        reason: registration.reason,
        projectId: registration.valid ? (await this.state.listProjects()).find((project) => project.rootPath === registration.target)?.id ?? null : null,
        target: registration.target,
      };
    }

    if (definition.id === 'session.current_project.set') return this.validateSessionProjectSelection(input);
    if (definition.id === 'session.instruction.submit') return this.validateOwnedSession(input);
    if (definition.id === 'project.default.set') return this.validateDefaultProject(input);

    if (definition.requiredScope === 'MACHINE') {
      return { valid: true, reason: 'Machine-local capability scope is valid', projectId: input.projectId ?? null, target: normalizedDisplayTarget(input.targetPath) };
    }
    if (definition.requiredScope === 'RUNTIME_DATA') {
      const target = normalizedDisplayTarget(input.targetPath) ?? this.dataRoot;
      const valid = pathIsWithin(this.dataRoot, target);
      return { valid, reason: valid ? 'IRIS runtime-data scope is valid' : 'Target escapes the IRIS runtime-data root', projectId: null, target };
    }
    if (definition.requiredScope !== 'PROJECT') {
      return { valid: false, reason: 'Capability scope is not eligible for automatic execution', projectId: input.projectId ?? null, target: normalizedDisplayTarget(input.targetPath) };
    }

    const sessionId = input.sessionId?.trim() ?? '';
    const clientId = input.clientId?.trim() ?? '';
    if (sessionId.length === 0 || clientId.length === 0) {
      return { valid: false, reason: 'Project capability requires live client and session identity', projectId: null, target: normalizedDisplayTarget(input.targetPath) };
    }
    let session;
    try {
      session = this.state.getSessionForClient(sessionId, clientId);
    } catch {
      return { valid: false, reason: 'Client/session identity does not own the requested session', projectId: null, target: normalizedDisplayTarget(input.targetPath) };
    }
    if (session.currentProjectId === null) {
      return { valid: false, reason: 'Session has no current project', projectId: null, target: normalizedDisplayTarget(input.targetPath) };
    }
    if (input.projectId !== undefined && input.projectId !== null && input.projectId !== session.currentProjectId) {
      return { valid: false, reason: 'Requested project does not match the live session project', projectId: session.currentProjectId, target: normalizedDisplayTarget(input.targetPath) };
    }
    const project = await projectById(this.state, session.currentProjectId);
    if (project === null) return { valid: false, reason: 'Session current project is not registered', projectId: session.currentProjectId, target: normalizedDisplayTarget(input.targetPath) };

    const targetKind = projectTargetKind(definition.id);
    if (targetKind === null) {
      const target = normalizedDisplayTarget(input.targetPath) ?? project.rootPath;
      const valid = target === project.rootPath || pathIsWithin(project.rootPath, target);
      return { valid, reason: valid ? 'Live session project scope is valid' : 'Target escapes the live session project root', projectId: project.id, target };
    }
    const inspected = await inspectProjectTarget(project.rootPath, normalizedDisplayTarget(input.targetPath), targetKind);
    return { valid: inspected.valid, reason: inspected.reason, projectId: project.id, target: inspected.target };
  }

  private validateOwnedSession(input: PolicyRequest): ScopeResult {
    const sessionId = input.sessionId?.trim() ?? '';
    const clientId = input.clientId?.trim() ?? '';
    if (sessionId.length === 0 || clientId.length === 0) {
      return { valid: false, reason: 'Session instruction requires client and session identity', projectId: null, target: null };
    }
    try {
      this.state.getSessionForClient(sessionId, clientId);
      return { valid: true, reason: 'Client owns the requested session', projectId: null, target: null };
    } catch {
      return { valid: false, reason: 'Client/session identity does not own the requested session', projectId: null, target: null };
    }
  }

  private async validateSessionProjectSelection(input: PolicyRequest): Promise<ScopeResult> {
    const sessionId = input.sessionId?.trim() ?? '';
    const clientId = input.clientId?.trim() ?? '';
    if (sessionId.length === 0 || clientId.length === 0) {
      return { valid: false, reason: 'Session project selection requires client and session identity', projectId: null, target: null };
    }
    try {
      this.state.getSessionForClient(sessionId, clientId);
    } catch {
      return { valid: false, reason: 'Client/session identity does not own the requested session', projectId: null, target: null };
    }
    const projectId = input.projectId ?? null;
    if (projectId === null) return { valid: true, reason: 'Clearing current project is session-scoped', projectId: null, target: null };
    const project = await projectById(this.state, projectId);
    return project === null
      ? { valid: false, reason: 'Requested current project is not registered', projectId, target: null }
      : { valid: true, reason: 'Requested current project is registered', projectId, target: project.rootPath };
  }

  private async validateDefaultProject(input: PolicyRequest): Promise<ScopeResult> {
    const projectId = input.projectId ?? null;
    if (projectId === null) return { valid: true, reason: 'Clearing machine default project is valid', projectId: null, target: null };
    const project = await projectById(this.state, projectId);
    return project === null
      ? { valid: false, reason: 'Requested default project is not registered', projectId, target: null }
      : { valid: true, reason: 'Requested default project is registered', projectId, target: project.rootPath };
  }
}

function projectTargetKind(capabilityId: CapabilityId): Exclude<ProjectTargetKind, 'project-root'> | null {
  if (capabilityId === 'file.read') return 'file-read';
  if (capabilityId === 'file.write') return 'file-write';
  if (capabilityId === 'file.delete') return 'file-delete';
  if (capabilityId === 'directory.create') return 'directory-create';
  if (capabilityId === 'directory.delete') return 'directory-delete';
  return null;
}

function decideMode(mode: PermissionMode, definition: CapabilityDefinition): PermissionDecisionRecord['decision'] {
  if (!definition.mutation && definition.riskClass === 'LOW') return 'ALLOW_AUTO';
  if (mode === 'ASK_EVERY_TIME') return 'OWNER_REQUIRED';
  if (mode === 'AUTO_APPROVE_LOW_RISK') return definition.riskClass === 'LOW' ? 'ALLOW_AUTO' : 'OWNER_REQUIRED';
  if (mode === 'AUTO_APPROVE_PROJECT_SCOPED') {
    return definition.riskClass === 'LOW' || (definition.riskClass === 'MODERATE' && definition.requiredScope === 'PROJECT')
      ? 'ALLOW_AUTO'
      : 'OWNER_REQUIRED';
  }
  return definition.riskClass === 'LOW' || definition.riskClass === 'MODERATE' ? 'ALLOW_AUTO' : 'OWNER_REQUIRED';
}

function decisionReason(mode: PermissionMode, definition: CapabilityDefinition, decision: PermissionDecisionRecord['decision']): string {
  if (decision === 'ALLOW_AUTO') return `${mode} auto-approves ${definition.riskClass} ${definition.requiredScope.toLowerCase()} capability`;
  return `${mode} requires owner approval for ${definition.riskClass} ${definition.requiredScope.toLowerCase()} capability`;
}

async function projectById(state: RuntimeState, projectId: string): Promise<ProjectReference | null> {
  return (await state.listProjects()).find((project) => project.id === projectId) ?? null;
}

function record(
  input: PolicyRequest,
  riskClass: PermissionDecisionRecord['riskClass'],
  decision: PermissionDecisionRecord['decision'],
  reason: string,
  projectId: string | null,
  target: string | null,
): PermissionDecisionRecord {
  return {
    timestamp: new Date().toISOString(),
    clientId: input.clientId?.trim() || null,
    sessionId: input.sessionId?.trim() || null,
    agentId: input.agentId?.trim() || null,
    capabilityId: input.capabilityId,
    riskClass,
    projectId,
    target,
    decision,
    reason,
  };
}

function normalizedDisplayTarget(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim().length === 0 || value.includes('\0')) return null;
  return path.resolve(value);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function autoCategories(mode: PermissionMode): readonly string[] {
  if (mode === 'ASK_EVERY_TIME') return ['safe read/status inspection'];
  if (mode === 'AUTO_APPROVE_LOW_RISK') return ['LOW risk local capabilities'];
  if (mode === 'AUTO_APPROVE_PROJECT_SCOPED') return ['LOW risk local capabilities', 'MODERATE registered-project capabilities'];
  return [
    'LOW risk implemented local capabilities',
    'MODERATE registered-project file and directory capabilities',
    'session and current-project mutations',
    'project registration inside the canonical owner source root',
  ];
}
