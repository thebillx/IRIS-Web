import { RuntimeError, type IdentityCoherenceState, type TunnelBindingDiagnostic } from '@iris/domain';
import type { ConnectorBinding, ConnectorRegistryDocument } from './connector-registry.js';

export interface RuntimeIdentityContext {
  readonly machineId: string;
  readonly runtimeId: string;
  readonly instanceId: string;
}

export interface TunnelBindingClaim extends RuntimeIdentityContext {
  readonly tunnelId: string;
  readonly deploymentEpoch: number;
  readonly catalogHash: string;
  readonly connectorProfile: 'FULL' | 'PRO';
  readonly leaseGeneration: number;
}

export interface IdentityCoherenceAssessment {
  readonly state: IdentityCoherenceState;
  readonly code: 'COHERENT' | 'UNBOUND' | 'TUNNEL_OWNERSHIP_CONFLICT' | 'SPLIT_IDENTITY';
  readonly detail: string;
  readonly tunnelBindings: readonly TunnelBindingDiagnostic[];
}

export function assessConnectorRegistryIdentity(
  registry: ConnectorRegistryDocument | null,
  context: Pick<RuntimeIdentityContext, 'machineId' | 'runtimeId'>,
  staleConnectorIds: readonly string[] = [],
): IdentityCoherenceAssessment {
  if (registry === null) return { state: 'UNBOUND', code: 'UNBOUND', detail: 'No connector registry is configured', tunnelBindings: [] };
  const diagnostics = registry.connectors.map(bindingDiagnostic);
  if (registry.connectors.some((binding) => binding.machineId !== null && binding.machineId !== context.machineId)) {
    return { state: 'SPLIT', code: 'TUNNEL_OWNERSHIP_CONFLICT', detail: 'Connector tunnel ownership belongs to a different machine identity', tunnelBindings: diagnostics };
  }
  if (registry.connectors.some((binding) => binding.runtimeId !== null && binding.runtimeId !== context.runtimeId)) {
    return { state: 'SPLIT', code: 'SPLIT_IDENTITY', detail: 'Connector runtime identity does not match the local logical runtime', tunnelBindings: diagnostics };
  }
  if (staleConnectorIds.length > 0) {
    return { state: 'SPLIT', code: 'SPLIT_IDENTITY', detail: `Connector catalog/deployment metadata is stale for: ${staleConnectorIds.join(',')}`, tunnelBindings: diagnostics };
  }
  if (registry.connectors.some((binding) => binding.machineId === null || binding.runtimeId === null || binding.leaseGeneration <= 0)) {
    return { state: 'UNBOUND', code: 'UNBOUND', detail: 'Connector ownership has not been fully bound to this machine/runtime', tunnelBindings: diagnostics };
  }
  return { state: 'COHERENT', code: 'COHERENT', detail: 'Machine, runtime and connector ownership identities are coherent', tunnelBindings: diagnostics };
}

export function assertTunnelBindingClaim(binding: ConnectorBinding, claim: TunnelBindingClaim): void {
  if (binding.machineId === null || binding.runtimeId === null || binding.leaseGeneration <= 0) {
    throw new RuntimeError('SPLIT_IDENTITY', 'Tunnel binding is not fully owned by a machine/runtime identity');
  }
  if (claim.tunnelId !== binding.tunnelId || claim.machineId !== binding.machineId || claim.leaseGeneration !== binding.leaseGeneration) {
    throw new RuntimeError('TUNNEL_OWNERSHIP_CONFLICT', 'Tunnel ownership/fencing claim does not match the active binding generation');
  }
  const expectedProfile = binding.mode === 'FULL' ? 'FULL' : 'PRO';
  if (claim.runtimeId !== binding.runtimeId
    || claim.connectorProfile !== expectedProfile
    || claim.deploymentEpoch !== binding.deploymentEpoch
    || claim.catalogHash !== binding.catalogHash) {
    throw new RuntimeError('SPLIT_IDENTITY', 'Runtime, connector profile, deployment epoch or catalog identity is split');
  }
  if (claim.instanceId.trim().length === 0) throw new RuntimeError('SPLIT_IDENTITY', 'Tunnel claim is missing the current runtime instance identity');
}

export function bindingDiagnostic(binding: ConnectorBinding): TunnelBindingDiagnostic {
  return {
    connectorProfile: binding.mode === 'FULL' ? 'FULL' : 'PRO',
    tunnelId: binding.tunnelId,
    deploymentEpoch: binding.deploymentEpoch,
    catalogHash: binding.catalogHash,
    leaseGeneration: binding.leaseGeneration,
    machineId: binding.machineId,
    runtimeId: binding.runtimeId,
  };
}
