import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  RuntimeError,
  type CapabilityDefinition,
  type CapabilityId,
  type Worker,
  type WorkerAssignment,
  type WorkerRuntimeFence,
  type WorkerTask,
  type WorkerTaskAuthorityMetadata,
} from '@iris/domain';
import { capabilityDefinition } from '../capability-registry.js';
import type { MultiWorkerDocument } from './model.js';
import { validateMultiWorkerDocument } from './validation.js';

export interface WorkerAuthorityClaims {
  readonly missionId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly assignmentId: string;
  readonly authorityDigest: string;
}

export interface WorkerAuthorityServerContext {
  readonly sessionId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly parentOrchestratorId: string;
  readonly runtimeFence: WorkerRuntimeFence;
  readonly now: string;
}

export interface WorkerExecutionEnvelope extends WorkerTaskAuthorityMetadata {
  readonly orchestrationRunId: string;
  readonly assignmentId: string;
  readonly workerId: string;
  readonly authorityDigest: string;
  readonly runtimeFence: WorkerRuntimeFence;
}

export interface WorkerResourceUsage {
  readonly elapsedMs: number;
  readonly jobs: number;
  readonly artifacts: number;
  readonly outputBytes: number;
}

export interface WorkerCapabilityRequest {
  readonly paths?: readonly string[];
  readonly processProfile?: string | null;
  readonly usage?: WorkerResourceUsage;
}

export function deriveWorkerAuthorityDigest(
  task: WorkerTask,
  worker: Worker,
  assignment: WorkerAssignment,
): string {
  const authority = task.authority;
  const payload = {
    schemaVersion: 1,
    orchestrationRunId: task.orchestrationRunId,
    assignmentId: assignment.id,
    workerId: worker.id,
    workerPrincipalId: worker.principalId,
    task: {
      id: task.id,
      missionId: task.missionId,
      missionTaskId: task.missionTaskId,
    },
    authority: {
      ...authority,
      allowedCapabilities: [...authority.allowedCapabilities].sort(),
      allowedPaths: [...authority.allowedPaths].sort(),
      readOnlyPaths: [...authority.readOnlyPaths].sort(),
      mutablePaths: [...authority.mutablePaths].sort(),
      allowedProcesses: [...authority.allowedProcesses].sort(),
    },
    runtimeFence: assignment.runtimeFence,
    assignedAt: assignment.assignedAt,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Resolve worker authority from durable server-owned state.
 *
 * Worker claims contain identifiers plus the previously issued digest only. Capability/path/process
 * grants are never accepted from the worker and are copied exclusively from the durable task.
 */
export function resolveWorkerExecutionEnvelope(
  documentInput: MultiWorkerDocument,
  claims: WorkerAuthorityClaims,
  server: WorkerAuthorityServerContext,
): WorkerExecutionEnvelope {
  const document = validateMultiWorkerDocument(documentInput);
  const assignment = document.assignments.find((entry) => entry.id === claims.assignmentId);
  const task = document.tasks.find((entry) => entry.id === claims.taskId);
  const worker = document.workers.find((entry) => entry.id === claims.workerId);
  if (assignment === undefined || task === undefined || worker === undefined) deny('Worker authority identity was not found');

  const run = document.runs.find((entry) => entry.id === task.orchestrationRunId);
  if (run === undefined) deny('Worker orchestration run was not found');

  if (claims.missionId !== task.missionId
    || assignment.taskId !== task.id
    || assignment.workerId !== worker.id
    || assignment.orchestrationRunId !== run.id
    || worker.orchestrationRunId !== run.id
    || task.orchestrationRunId !== run.id
    || assignment.releasedAt !== null
    || run.state !== 'RUNNING'
    || !['ASSIGNED', 'RUNNING'].includes(task.state)
    || !['ASSIGNED', 'RUNNING'].includes(worker.state)) {
    deny('Worker authority assignment is not active');
  }

  if (task.authority.principalId !== worker.principalId
    || task.authority.missionId !== claims.missionId
    || task.authority.sessionId !== server.sessionId
    || task.authority.projectId !== server.projectId
    || task.authority.workspaceId !== server.workspaceId
    || task.authority.parentOrchestratorId !== server.parentOrchestratorId
    || run.sessionId !== server.sessionId
    || run.projectId !== server.projectId
    || run.parentOrchestratorId !== server.parentOrchestratorId) {
    deny('Worker authority scope does not match the authoritative execution context');
  }

  if (!sameFence(assignment.runtimeFence, server.runtimeFence)) {
    deny('Worker authority runtime/tunnel identity fence is stale');
  }

  const expectedDigest = deriveWorkerAuthorityDigest(task, worker, assignment);
  if (assignment.authorityDigest !== expectedDigest
    || claims.authorityDigest !== expectedDigest
    || !/^[a-f0-9]{64}$/.test(claims.authorityDigest)) {
    deny('Worker authority digest does not match immutable assignment state');
  }

  const now = Date.parse(server.now);
  const createdAt = Date.parse(task.authority.createdAt);
  const expiresAt = Date.parse(task.authority.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
    || now < createdAt || now >= expiresAt) {
    deny('Worker authority is not active at the current time');
  }

  return Object.freeze({
    ...task.authority,
    allowedCapabilities: Object.freeze([...task.authority.allowedCapabilities]),
    allowedPaths: Object.freeze([...task.authority.allowedPaths]),
    readOnlyPaths: Object.freeze([...task.authority.readOnlyPaths]),
    mutablePaths: Object.freeze([...task.authority.mutablePaths]),
    allowedProcesses: Object.freeze([...task.authority.allowedProcesses]),
    resourceBudget: Object.freeze({ ...task.authority.resourceBudget }),
    concurrencyPolicy: Object.freeze({ ...task.authority.concurrencyPolicy }),
    orchestrationRunId: run.id,
    assignmentId: assignment.id,
    workerId: worker.id,
    authorityDigest: expectedDigest,
    runtimeFence: Object.freeze({ ...assignment.runtimeFence }),
  });
}

export function authorizeWorkerCapability(
  envelope: WorkerExecutionEnvelope,
  capabilityId: string,
  request: WorkerCapabilityRequest = {},
): CapabilityDefinition {
  const definition = capabilityDefinition(capabilityId);
  if (definition === null || !envelope.allowedCapabilities.includes(capabilityId as CapabilityId)) {
    deny('Worker attempted a capability outside its authority envelope');
  }

  assertBudget(envelope, request.usage);

  const paths = request.paths ?? [];
  for (const candidate of paths) {
    const normalized = normalizeRelativeTarget(candidate);
    const grants = definition.mutation ? envelope.mutablePaths : envelope.allowedPaths;
    if (definition.mutation && envelope.concurrencyPolicy.mutablePathOwnership === 'READ_ONLY') {
      deny('Worker task is read-only and cannot mutate paths');
    }
    if (!grants.some((grant) => pathMatches(grant, normalized))) {
      deny('Worker attempted a path outside its authority envelope');
    }
  }

  if (capabilityId === 'shell.run' || capabilityId === 'shell.start' || request.processProfile !== undefined) {
    const processProfile = request.processProfile;
    if (typeof processProfile !== 'string' || !envelope.allowedProcesses.includes(processProfile)) {
      deny('Worker attempted a process outside its authority envelope');
    }
  }

  return definition;
}

export function assertWorkerResourceBudget(
  envelope: WorkerExecutionEnvelope,
  usage: WorkerResourceUsage,
): void {
  assertBudget(envelope, usage);
}

function assertBudget(envelope: WorkerExecutionEnvelope, usage: WorkerResourceUsage | undefined): void {
  if (usage === undefined) return;
  if (![usage.elapsedMs, usage.jobs, usage.artifacts, usage.outputBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    deny('Worker resource usage is invalid');
  }
  const budget = envelope.resourceBudget;
  if (usage.elapsedMs > budget.maxRuntimeMs
    || usage.jobs > budget.maxJobs
    || usage.artifacts > budget.maxArtifacts
    || usage.outputBytes > budget.maxOutputBytes) {
    deny('Worker resource budget was exceeded');
  }
}

export function workerPathAllowed(grants: readonly string[], targetInput: string): boolean {
  const target = normalizeRelativeTarget(targetInput);
  return grants.some((grant) => pathMatches(grant, target));
}

function pathMatches(grantInput: string, target: string): boolean {
  const grant = normalizeGrant(grantInput);
  if (grant === '**') return true;
  if (grant.endsWith('/**')) {
    const base = grant.slice(0, -3);
    return target === base || target.startsWith(`${base}/`);
  }
  return target === grant;
}

function normalizeGrant(value: string): string {
  if (value === '**') return value;
  if (value.endsWith('/**')) return `${normalizeRelativeTarget(value.slice(0, -3))}/**`;
  if (value.includes('*')) deny('Worker authority contains an unsupported path pattern');
  return normalizeRelativeTarget(value);
}

function normalizeRelativeTarget(value: string): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 2_000
    || value !== value.trim()
    || value.includes('\\')
    || value.includes('\0')
    || value.startsWith('/')) {
    deny('Worker path authority target is invalid');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.' && value !== '.') {
    deny('Worker path authority target escapes its workspace-relative scope');
  }
  return normalized;
}

function sameFence(left: WorkerRuntimeFence, right: WorkerRuntimeFence): boolean {
  return left.machineId === right.machineId
    && left.runtimeId === right.runtimeId
    && left.instanceId === right.instanceId
    && left.deploymentEpoch === right.deploymentEpoch
    && left.connectorProfile === right.connectorProfile
    && left.catalogHash === right.catalogHash;
}

function deny(message: string): never {
  throw new RuntimeError('CAPABILITY_DENIED', message);
}
