import type { CapabilityDefinition, CapabilityId } from '@iris/domain';

const DEFINITIONS: readonly CapabilityDefinition[] = [
  { id: 'runtime.status', title: 'Read runtime status', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: false, implemented: true },
  { id: 'project.list', title: 'List registered projects', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: false, implemented: true },
  { id: 'project.git_status', title: 'Read project Git status', riskClass: 'LOW', requiredScope: 'PROJECT', mutation: false, implemented: true },
  { id: 'mission.list', title: 'List mission execution records', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: false, implemented: true },
  { id: 'mission.get', title: 'Read mission execution record', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: false, implemented: true },
  { id: 'mission.create', title: 'Register mission identity', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: true, implemented: true },
  { id: 'mission.state.set', title: 'Record mission state', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: true, implemented: true },
  { id: 'mission.task.create', title: 'Register mission task', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: true, implemented: true },
  { id: 'mission.task.state.set', title: 'Record mission task state', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: true, implemented: true },
  { id: 'mission.action.prepare', title: 'Prepare governed mission action', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: true, implemented: true },
  { id: 'mission.supervisor_gate.set', title: 'Record supervisor gate state', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: true, implemented: true },
  { id: 'session.create', title: 'Create local session', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: true, implemented: true },
  { id: 'session.delete', title: 'Delete owned local session', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: true, implemented: true },
  { id: 'session.current_project.set', title: 'Set session current project', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: true, implemented: true },
  { id: 'session.instruction.submit', title: 'Submit session instruction', riskClass: 'LOW', requiredScope: 'MACHINE', mutation: true, implemented: true },
  { id: 'project.register', title: 'Register project root', riskClass: 'MODERATE', requiredScope: 'PROJECT', mutation: true, implemented: true },
  { id: 'project.default.set', title: 'Set machine default project', riskClass: 'MODERATE', requiredScope: 'MACHINE', mutation: true, implemented: true },
  { id: 'file.read', title: 'Read project file', riskClass: 'LOW', requiredScope: 'PROJECT', mutation: false, implemented: true },
  { id: 'file.write', title: 'Create or edit project file', riskClass: 'MODERATE', requiredScope: 'PROJECT', mutation: true, implemented: true },
  { id: 'file.delete', title: 'Delete project file', riskClass: 'MODERATE', requiredScope: 'PROJECT', mutation: true, implemented: true },
  { id: 'directory.create', title: 'Create project directory', riskClass: 'MODERATE', requiredScope: 'PROJECT', mutation: true, implemented: true },
  { id: 'directory.delete', title: 'Remove empty project directory', riskClass: 'MODERATE', requiredScope: 'PROJECT', mutation: true, implemented: true },
  { id: 'project.command.run', title: 'Run approved project command', riskClass: 'MODERATE', requiredScope: 'PROJECT', mutation: true, implemented: false },
  { id: 'git.local', title: 'Local project Git operation', riskClass: 'MODERATE', requiredScope: 'PROJECT', mutation: true, implemented: false },
  { id: 'runtime.lifecycle', title: 'Local runtime lifecycle', riskClass: 'MODERATE', requiredScope: 'RUNTIME_DATA', mutation: true, implemented: true },
  { id: 'web.lifecycle', title: 'Local Web development lifecycle', riskClass: 'MODERATE', requiredScope: 'PROJECT', mutation: true, implemented: false },
  { id: 'package.project', title: 'Project package-manager operation', riskClass: 'MODERATE', requiredScope: 'PROJECT', mutation: true, implemented: false },
  { id: 'policy.mode.set', title: 'Change machine permission mode', riskClass: 'HIGH', requiredScope: 'OWNER', mutation: true, implemented: true },
  { id: 'credential.mutate', title: 'Create or change credentials', riskClass: 'HIGH', requiredScope: 'OWNER', mutation: true, implemented: false },
  { id: 'remote.publish', title: 'Publish or mutate a remote repository/account', riskClass: 'HIGH', requiredScope: 'OWNER', mutation: true, implemented: false },
  { id: 'system.sudo', title: 'System privilege escalation', riskClass: 'SYSTEM', requiredScope: 'OWNER', mutation: true, implemented: false },
] as const;

const BY_ID = new Map<CapabilityId, CapabilityDefinition>(DEFINITIONS.map((definition) => [definition.id, definition]));

export function listCapabilities(): readonly CapabilityDefinition[] {
  return DEFINITIONS;
}

export function capabilityDefinition(id: string): CapabilityDefinition | null {
  return BY_ID.get(id as CapabilityId) ?? null;
}
