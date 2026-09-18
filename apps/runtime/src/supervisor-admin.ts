import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';
import { readConnectorRegistry, type ConnectorBinding } from './connector-registry.js';
import { readTunnelServiceSecret } from './credentials.js';
import { runtimeStatus } from './lifecycle.js';
import { MCP_PROTOCOL_VERSION } from './mcp.js';
import type { ActivationController } from './activation-controller.js';

const MAX_REQUEST_BYTES = 64 * 1024;
const ADMIN_SERVER_NAME = 'IRIS Supervisor Admin';
const ADMIN_OWNER = 'PERSISTENT_SUPERVISOR_OR_CONTROL_PLANE' as const;

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface SupervisorAdminServerHandle {
  readonly port: number;
  readonly mcpUrl: string;
  readonly healthUrl: string;
  close(): Promise<void>;
}

export interface SupervisorAdminSnapshot {
  readonly supervisorId: string | null;
  readonly adminProcessId: number;
  readonly adminEndpointOwner: typeof ADMIN_OWNER;
  readonly readiness: 'READY' | 'DEGRADED';
  readonly workloadState: 'running' | 'stopped' | 'stale' | 'indeterminate';
  readonly runtimeId: string | null;
  readonly instanceId: string | null;
  readonly fullCatalogId: string | null;
  readonly fullToolCount: number | null;
  readonly proToolCount: number | null;
  readonly deploymentEpoch: number | null;
  readonly activeBindingIdentity: {
    readonly machineId: string | null;
    readonly runtimeId: string | null;
  } | null;
}

export async function startSupervisorAdminServer(
  dataRoot: string,
  port: number,
  activationController?: ActivationController,
): Promise<SupervisorAdminServerHandle> {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new RuntimeError('INVALID_REQUEST', 'Supervisor admin port must be a valid TCP port');
  }
  const secret = await readTunnelServiceSecret(dataRoot);
  if (secret === null) throw new RuntimeError('CREDENTIAL_MISSING', 'Supervisor admin transport requires the persistent tunnel service credential');
  let controller = activationController;
  if (controller === undefined) {
    const { createProductionActivationController } = await import('./activation-controller.js');
    controller = await createProductionActivationController(dataRoot);
  }
  const server = createServer((request, response) => {
    void handleAdminRequest(request, response, dataRoot, secret, controller).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: 'internal_error' });
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    port,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    healthUrl: `http://127.0.0.1:${port}/healthz`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export async function readSupervisorAdminSnapshot(dataRoot: string): Promise<SupervisorAdminSnapshot> {
  const [observed, registry, supervisorId] = await Promise.all([
    runtimeStatus(dataRoot),
    readConnectorRegistry(dataRoot),
    readSupervisorId(dataRoot),
  ]);
  const serviceSecret = await readTunnelServiceSecret(dataRoot);
  const endpoint = observed.endpoint;
  let fullCatalogId: string | null = null;
  let fullToolCount: number | null = null;
  let proToolCount: number | null = null;
  if (endpoint !== null && registry !== null && serviceSecret !== null && observed.state === 'running') {
    const full = registry.connectors.find((candidate) => candidate.mode === 'FULL');
    const pro = registry.connectors.find((candidate) => candidate.mode === 'PRO');
    if (full !== undefined) {
      const identity = await readLiveFullCatalogIdentity(endpoint.apiUrl, endpoint.runtimeId, registry.deploymentEpoch, full, serviceSecret);
      fullCatalogId = identity?.catalogHash ?? null;
      fullToolCount = identity?.toolCount ?? null;
    }
    if (pro !== undefined) {
      proToolCount = await readLiveToolCount(endpoint.apiUrl, endpoint.runtimeId, registry.deploymentEpoch, pro, serviceSecret);
    }
  }
  const fullBinding = registry?.connectors.find((candidate) => candidate.mode === 'FULL') ?? null;
  const readiness = observed.state === 'running' && fullCatalogId !== null && fullToolCount !== null && proToolCount !== null ? 'READY' : 'DEGRADED';
  return {
    supervisorId,
    adminProcessId: process.pid,
    adminEndpointOwner: ADMIN_OWNER,
    readiness,
    workloadState: observed.state,
    runtimeId: endpoint?.runtimeId ?? null,
    instanceId: endpoint?.instanceId ?? null,
    fullCatalogId,
    fullToolCount,
    proToolCount,
    deploymentEpoch: registry?.deploymentEpoch ?? null,
    activeBindingIdentity: fullBinding === null ? null : { machineId: fullBinding.machineId, runtimeId: fullBinding.runtimeId },
  };
}

async function handleAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dataRoot: string,
  secret: string,
  activation: ActivationController,
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${secret}`) {
    writeJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method === 'GET' && request.url === '/healthz') {
    writeJson(response, 200, { ok: true, owner: ADMIN_OWNER, pid: process.pid });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/mcp') {
    writeJson(response, 404, { error: 'not_found' });
    return;
  }
  const rpc = await readJsonRpc(request);
  if (rpc === null) {
    writeJsonRpcError(response, null, -32700, 'Parse error', 400);
    return;
  }
  if (rpc.method === 'server/discover') {
    writeJsonRpcResult(response, rpc.id ?? null, {
      resultType: 'complete',
      supportedVersions: [MCP_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: ADMIN_SERVER_NAME, version: '0.0.0' } },
    });
    return;
  }
  if (request.headers['mcp-protocol-version'] !== MCP_PROTOCOL_VERSION) {
    writeJsonRpcError(response, rpc.id ?? null, -32600, `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}`, 400);
    return;
  }
  if (rpc.method === 'ping') {
    writeJsonRpcResult(response, rpc.id ?? null, {});
    return;
  }
  if (rpc.method === 'tools/list') {
    writeJsonRpcResult(response, rpc.id ?? null, { tools: adminToolDefinitions() });
    return;
  }
  if (rpc.method === 'tools/call') {
    const params = isRecord(rpc.params) ? rpc.params : null;
    const name = params !== null && typeof params.name === 'string' ? params.name : null;
    const args = params !== null && (params.arguments === undefined || isRecord(params.arguments)) ? (params.arguments ?? {}) : null;
    if (name === null || args === null) {
      writeJsonRpcError(response, rpc.id ?? null, -32602, 'Admin tool arguments must be an object', 400);
      return;
    }
    const toolHeader = request.headers['mcp-name'];
    if (typeof toolHeader === 'string' && toolHeader !== name) {
      writeJsonRpcError(response, rpc.id ?? null, -32600, 'Mcp-Name does not match tool name', 400);
      return;
    }
    try {
      if (name === 'admin_status') {
        requireNoArguments(args);
        writeJsonRpcResult(response, rpc.id ?? null, toolResult(await readSupervisorAdminSnapshot(dataRoot)));
        return;
      }
      if (name === 'admin_identity') {
        requireNoArguments(args);
        const snapshot = await readSupervisorAdminSnapshot(dataRoot);
        writeJsonRpcResult(response, rpc.id ?? null, toolResult({
          supervisorId: snapshot.supervisorId,
          adminProcessId: snapshot.adminProcessId,
          adminEndpointOwner: snapshot.adminEndpointOwner,
          runtimeId: snapshot.runtimeId,
          instanceId: snapshot.instanceId,
          fullCatalogId: snapshot.fullCatalogId,
          deploymentEpoch: snapshot.deploymentEpoch,
          readiness: snapshot.readiness,
        }));
        return;
      }
      if (name === 'activation_status') {
        writeJsonRpcResult(response, rpc.id ?? null, toolResult(await activation.status(activationStatusTransactionId(args))));
        return;
      }
      if (name === 'activation_prepare') {
        writeJsonRpcResult(response, rpc.id ?? null, toolResult(await activation.prepare(activationPrepareArguments(args))));
        return;
      }
      if (name === 'activation_apply') {
        writeJsonRpcResult(response, rpc.id ?? null, toolResult(await activation.apply(requireTransactionId(args))));
        return;
      }
      if (name === 'activation_confirm') {
        writeJsonRpcResult(response, rpc.id ?? null, toolResult(await activation.confirm(requireTransactionId(args))));
        return;
      }
      if (name === 'activation_rollback') {
        writeJsonRpcResult(response, rpc.id ?? null, toolResult(await activation.rollback(requireTransactionId(args))));
        return;
      }
    } catch (error) {
      writeJsonRpcResult(response, rpc.id ?? null, toolErrorResult(error));
      return;
    }
    writeJsonRpcError(response, rpc.id ?? null, -32601, 'Unknown admin tool', 404);
    return;
  }
  writeJsonRpcError(response, rpc.id ?? null, -32601, 'Method not found', 404);
}

export function adminToolDefinitions(): readonly Record<string, unknown>[] {
  const noArgs = { type: 'object', properties: {}, additionalProperties: false };
  const transactionId = {
    type: 'object',
    properties: { transactionId: { type: 'string', format: 'uuid' } },
    required: ['transactionId'],
    additionalProperties: false,
  };
  return [
    {
      name: 'admin_status',
      description: 'Read persistent supervisor/admin readiness and current workload runtime/catalog identity. This tool is outside the workload FULL/PRO catalogs.',
      inputSchema: noArgs,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'admin_identity',
      description: 'Read the persistent supervisor/admin identity and current workload binding identity without mutation authority.',
      inputSchema: noArgs,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'activation_status',
      description: 'Read the persistent activation transaction and current workload binding/runtime identity without mutation.',
      inputSchema: {
        type: 'object',
        properties: { transactionId: { type: 'string', format: 'uuid' } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'activation_prepare',
      description: 'Prepare one identity-bound durable activation transaction without replacing the workload runtime.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', format: 'uuid' },
          workspaceId: { type: 'string', format: 'uuid' },
          repositoryId: { type: 'string', format: 'uuid' },
          expectedHead: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
          expectedCandidateFingerprint: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
          expectedCurrentDeploymentEpoch: { type: 'integer', minimum: 1 },
          expectedRuntimeId: { type: 'string', minLength: 1, maxLength: 200 },
          expectedCatalogId: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
        },
        required: ['projectId', 'workspaceId', 'repositoryId', 'expectedHead', 'expectedCandidateFingerprint', 'expectedCurrentDeploymentEpoch'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: 'activation_apply',
      description: 'Apply only a previously prepared activation transaction through the bounded workload replacement path.',
      inputSchema: transactionId,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'activation_confirm',
      description: 'Confirm only an applied activation whose observed live binding still matches its prepared target.',
      inputSchema: transactionId,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: 'activation_rollback',
      description: 'Rollback a prepared or applied transaction using only the prior binding captured durably during prepare.',
      inputSchema: transactionId,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  ];
}

function requireNoArguments(args: Record<string, unknown>): void {
  assertAllowedKeys(args, [], []);
}

function activationStatusTransactionId(args: Record<string, unknown>): string | undefined {
  assertAllowedKeys(args, ['transactionId'], []);
  return optionalStringArgument(args, 'transactionId');
}

function activationPrepareArguments(args: Record<string, unknown>): Parameters<ActivationController['prepare']>[0] {
  const required = [
    'projectId',
    'workspaceId',
    'repositoryId',
    'expectedHead',
    'expectedCandidateFingerprint',
    'expectedCurrentDeploymentEpoch',
  ] as const;
  const allowed = [...required, 'expectedRuntimeId', 'expectedCatalogId'] as const;
  assertAllowedKeys(args, allowed, required);
  const expectedRuntimeId = optionalStringArgument(args, 'expectedRuntimeId');
  const expectedCatalogId = optionalStringArgument(args, 'expectedCatalogId');
  return {
    projectId: requireStringArgument(args, 'projectId'),
    workspaceId: requireStringArgument(args, 'workspaceId'),
    repositoryId: requireStringArgument(args, 'repositoryId'),
    expectedHead: requireStringArgument(args, 'expectedHead'),
    expectedCandidateFingerprint: requireStringArgument(args, 'expectedCandidateFingerprint'),
    expectedCurrentDeploymentEpoch: requirePositiveIntegerArgument(args, 'expectedCurrentDeploymentEpoch'),
    ...(expectedRuntimeId === undefined ? {} : { expectedRuntimeId }),
    ...(expectedCatalogId === undefined ? {} : { expectedCatalogId }),
  };
}

function requireTransactionId(args: Record<string, unknown>): string {
  assertAllowedKeys(args, ['transactionId'], ['transactionId']);
  return requireStringArgument(args, 'transactionId');
}

function assertAllowedKeys(
  args: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(args).find((key) => !allowedSet.has(key));
  if (unexpected !== undefined) {
    throw new RuntimeError('INVALID_REQUEST', `Unexpected activation argument: ${unexpected}`);
  }
  const missing = required.find((key) => !(key in args));
  if (missing !== undefined) {
    throw new RuntimeError('INVALID_REQUEST', `Missing activation argument: ${missing}`);
  }
}

function requireStringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeError('INVALID_REQUEST', `${key} must be a non-empty string`);
  }
  return value;
}

function optionalStringArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeError('INVALID_REQUEST', `${key} must be a non-empty string when provided`);
  }
  return value;
}

function requirePositiveIntegerArgument(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError('INVALID_REQUEST', `${key} must be a positive integer`);
  }
  return value;
}

function toolErrorResult(error: unknown) {
  const code = error instanceof RuntimeError ? error.code : 'PERSISTENCE_FAILURE';
  const message = error instanceof RuntimeError ? error.message : 'Admin activation operation failed';
  const structuredContent = { error: { code, message } };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true as const,
  };
}

async function readSupervisorId(dataRoot: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dataRoot, 'supervisor', 'state.json'), 'utf8')) as unknown;
    return isRecord(parsed) && typeof parsed.supervisorId === 'string' ? parsed.supervisorId : null;
  } catch {
    return null;
  }
}

async function readLiveFullCatalogIdentity(
  apiUrl: string,
  runtimeId: string,
  deploymentEpoch: number,
  binding: ConnectorBinding,
  secret: string,
): Promise<{ readonly catalogHash: string; readonly toolCount: number } | null> {
  const value = await postWorkloadMcp(apiUrl, runtimeId, deploymentEpoch, binding, secret, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'catalog_identity', arguments: {} },
  }, { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'catalog_identity' });
  if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.result.structuredContent)) return null;
  const identity = value.result.structuredContent;
  return typeof identity.catalogHash === 'string' && Number.isSafeInteger(identity.toolCount)
    ? { catalogHash: identity.catalogHash, toolCount: Number(identity.toolCount) }
    : null;
}

async function readLiveToolCount(
  apiUrl: string,
  runtimeId: string,
  deploymentEpoch: number,
  binding: ConnectorBinding,
  secret: string,
): Promise<number | null> {
  const value = await postWorkloadMcp(apiUrl, runtimeId, deploymentEpoch, binding, secret,
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, 'Mcp-Method': 'tools/list' });
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.tools)) return null;
  return value.result.tools.filter((tool) => isRecord(tool) && typeof tool.name === 'string').length;
}

async function postWorkloadMcp(
  apiUrl: string,
  runtimeId: string,
  deploymentEpoch: number,
  binding: ConnectorBinding,
  secret: string,
  body: unknown,
  extraHeaders: Record<string, string>,
): Promise<unknown | null> {
  try {
    const response = await fetch(`${apiUrl}${binding.mcpPath}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        'x-iris-client-id': 'iris-supervisor-admin',
        'x-iris-connector-profile': binding.mode,
        'x-iris-deployment-epoch': String(deploymentEpoch),
        'x-iris-runtime-id': runtimeId,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 1024 * 1024) return null;
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

export interface SupervisorAdminToolCallResult {
  readonly structuredContent: unknown;
  readonly isError: boolean;
}

export interface SupervisorAdminCallPolicy {
  readonly shortTimeoutMs?: number;
  readonly mutationTimeoutMs?: number;
  readonly reconciliationTimeoutMs?: number;
  readonly reconciliationPollMs?: number;
}

const ADMIN_SHORT_TIMEOUT_MS = 2_000;
const ADMIN_MUTATION_TIMEOUT_MS = 120_000;
const ADMIN_RECONCILIATION_TIMEOUT_MS = 30_000;
const ADMIN_RECONCILIATION_POLL_MS = 100;
const LONG_RUNNING_ACTIVATION_MUTATIONS = new Set(['activation_apply', 'activation_rollback']);

export async function callSupervisorAdminTool(
  dataRoot: string,
  port: number,
  name: string,
  args: Record<string, unknown>,
  policy: SupervisorAdminCallPolicy = {},
): Promise<SupervisorAdminToolCallResult> {
  const secret = await readTunnelServiceSecret(dataRoot);
  if (secret === null) throw new RuntimeError('CREDENTIAL_MISSING', 'Supervisor admin transport requires the persistent tunnel service credential');
  const shortTimeoutMs = adminCallTimeout(policy.shortTimeoutMs, ADMIN_SHORT_TIMEOUT_MS, 'shortTimeoutMs');
  const mutationTimeoutMs = adminCallTimeout(policy.mutationTimeoutMs, ADMIN_MUTATION_TIMEOUT_MS, 'mutationTimeoutMs');
  const reconciliationTimeoutMs = adminCallTimeout(policy.reconciliationTimeoutMs, ADMIN_RECONCILIATION_TIMEOUT_MS, 'reconciliationTimeoutMs');
  const reconciliationPollMs = adminCallTimeout(policy.reconciliationPollMs, ADMIN_RECONCILIATION_POLL_MS, 'reconciliationPollMs');
  const longRunningMutation = LONG_RUNNING_ACTIVATION_MUTATIONS.has(name);
  try {
    return await callSupervisorAdminToolOnce(secret, port, name, args, longRunningMutation ? mutationTimeoutMs : shortTimeoutMs);
  } catch (error) {
    if (longRunningMutation && isTransportTimeout(error)) {
      const transactionId = args.transactionId;
      if (typeof transactionId !== 'string' || transactionId.length === 0) {
        throw new RuntimeError('INVALID_REQUEST', `${name} requires transactionId before timeout reconciliation`);
      }
      return reconcileTimedOutActivationMutation(
        secret,
        port,
        name,
        transactionId,
        shortTimeoutMs,
        reconciliationTimeoutMs,
        reconciliationPollMs,
      );
    }
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', `Supervisor admin tool ${name} transport failed`, { cause: error });
  }
}

async function callSupervisorAdminToolOnce(
  secret: string,
  port: number,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<SupervisorAdminToolCallResult> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      'Mcp-Name': name,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', `Supervisor admin tool ${name} returned HTTP ${response.status}`);
  const value = await response.json() as unknown;
  if (!isRecord(value) || !isRecord(value.result) || !('structuredContent' in value.result) || typeof value.result.isError !== 'boolean') {
    throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', `Supervisor admin tool ${name} returned an invalid MCP result`);
  }
  return { structuredContent: value.result.structuredContent, isError: value.result.isError };
}

async function reconcileTimedOutActivationMutation(
  secret: string,
  port: number,
  name: string,
  transactionId: string,
  statusTimeoutMs: number,
  reconciliationTimeoutMs: number,
  reconciliationPollMs: number,
): Promise<SupervisorAdminToolCallResult> {
  const deadline = Date.now() + reconciliationTimeoutMs;
  let lastState = 'UNKNOWN';
  do {
    try {
      const statusResult = await callSupervisorAdminToolOnce(
        secret,
        port,
        'activation_status',
        { transactionId },
        statusTimeoutMs,
      );
      if (statusResult.isError) return statusResult;
      const status = isRecord(statusResult.structuredContent) ? statusResult.structuredContent : null;
      const transaction = status !== null && isRecord(status.transaction) ? status.transaction : null;
      const observedTransactionId = transaction !== null && typeof transaction.transactionId === 'string' ? transaction.transactionId : null;
      if (transaction !== null && observedTransactionId === transactionId && typeof transaction.state === 'string') {
        lastState = transaction.state;
        if (name === 'activation_apply') {
          if (transaction.state === 'APPLIED' || transaction.state === 'CONFIRMED') {
            return { structuredContent: transaction, isError: false };
          }
          if (transaction.state === 'APPLY_FAILED') {
            return reconciledActivationError(transaction, 'Activation apply failed after transport timeout');
          }
          if (transaction.state === 'ROLLED_BACK') {
            return activationErrorResult('AUTHORITY_CHANGED', 'Activation transaction was rolled back while apply timeout reconciliation was in progress');
          }
        } else if (name === 'activation_rollback') {
          if (transaction.state === 'ROLLED_BACK') {
            return { structuredContent: transaction, isError: false };
          }
          if (transaction.state === 'APPLY_FAILED') {
            return reconciledActivationError(transaction, 'Activation rollback failed after transport timeout');
          }
          if (transaction.state === 'CONFIRMED') {
            return activationErrorResult('PRECONDITION_FAILED', 'Activation transaction was confirmed while rollback timeout reconciliation was in progress');
          }
        }
      }
    } catch (error) {
      if (!(isTransportTimeout(error) || error instanceof RuntimeError && error.code === 'CONTROL_PLANE_UNREACHABLE')) throw error;
    }
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, reconciliationPollMs));
  } while (Date.now() < deadline);
  throw new RuntimeError(
    'SUPERVISOR_BUSY',
    `${name} transport timed out and activation transaction ${transactionId} remained ${lastState}; do not issue another activation mutation until activation_status is reconciled`,
  );
}

function reconciledActivationError(transaction: Record<string, unknown>, message: string): SupervisorAdminToolCallResult {
  const code = typeof transaction.lastFailureCode === 'string' && transaction.lastFailureCode.length > 0
    ? transaction.lastFailureCode
    : 'PERSISTENCE_FAILURE';
  return activationErrorResult(code, message);
}

function activationErrorResult(code: string, message: string): SupervisorAdminToolCallResult {
  return { structuredContent: { error: { code, message } }, isError: true };
}

function adminCallTimeout(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RuntimeError('INVALID_REQUEST', `${label} must be a positive integer`);
  return value;
}

function isTransportTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

export async function listSupervisorAdminToolNames(dataRoot: string, port: number): Promise<readonly string[]> {
  const secret = await readTunnelServiceSecret(dataRoot);
  if (secret === null) throw new RuntimeError('CREDENTIAL_MISSING', 'Supervisor admin transport requires the persistent tunnel service credential');
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', `Supervisor admin tool discovery returned HTTP ${response.status}`);
  const value = await response.json() as unknown;
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.tools)) {
    throw new RuntimeError('CONTROL_PLANE_UNREACHABLE', 'Supervisor admin tool discovery returned an invalid MCP result');
  }
  return value.result.tools.flatMap((tool) => isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : []);
}

async function readJsonRpc(request: IncomingMessage): Promise<JsonRpcRequest | null> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) return null;
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return isRecord(value) && value.jsonrpc === '2.0' && typeof value.method === 'string' ? value as unknown as JsonRpcRequest : null;
  } catch {
    return null;
  }
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value, isError: false as const };
}

function writeJsonRpcResult(response: ServerResponse, id: string | number | null, result: unknown): void {
  writeJson(response, 200, { jsonrpc: '2.0', id, result });
}

function writeJsonRpcError(response: ServerResponse, id: string | number | null, code: number, message: string, status = 200): void {
  writeJson(response, status, { jsonrpc: '2.0', id, error: { code, message } });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
