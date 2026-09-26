import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { RuntimeError } from '@iris/domain';
import { readTunnelServiceSecret } from './credentials.js';
import { LEGACY_MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION, TUNNEL_CLIENT_MCP_PROTOCOL_VERSION } from './mcp.js';
import { adminToolDefinitions, type SupervisorAdminToolCallResult } from './supervisor-admin.js';

const MAX_REQUEST_BYTES = 64 * 1024;
const SERVER_NAME = 'IRIS Native Supervisor Control';
const OWNER = 'OUTER_SUPERVISOR_DAEMON' as const;
const ACTIVATION_NAMES = new Set([
  'activation_status',
  'activation_prepare',
  'activation_apply',
  'activation_confirm',
  'activation_rollback',
]);
const INITIALIZE_PROTOCOL_VERSIONS = new Set<string>([LEGACY_MCP_PROTOCOL_VERSION, TUNNEL_CLIENT_MCP_PROTOCOL_VERSION]);

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface AdminRecycleInput {
  readonly expectedAdminIdentity?: string;
  readonly expectedAdminProfileDigest?: string;
}

export interface AdminTunnelRecycleInput {
  readonly expectedAdminTunnelId: string;
  readonly expectedAdminTunnelIdentity: string;
  readonly expectedAdminProfileDigest: string;
}

export interface SupervisorNativeOperations {
  supervisorStatus(): Promise<unknown>;
  adminStatus(): Promise<unknown>;
  runtimeReconcile(): Promise<unknown>;
  adminRecycle(input: AdminRecycleInput): Promise<unknown>;
  adminTunnelRecycle(input: AdminTunnelRecycleInput): Promise<unknown>;
  adminToolCall(name: string, args: Record<string, unknown>): Promise<SupervisorAdminToolCallResult>;
}

export interface SupervisorNativeControlHandle {
  readonly port: number;
  readonly mcpUrl: string;
  readonly healthUrl: string;
  close(): Promise<void>;
}

export async function startSupervisorNativeControlServer(
  dataRoot: string,
  port: number,
  operations: SupervisorNativeOperations,
): Promise<SupervisorNativeControlHandle> {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new RuntimeError('INVALID_REQUEST', 'Supervisor native control port must be a valid TCP port');
  }
  const secret = await readTunnelServiceSecret(dataRoot);
  if (secret === null) throw new RuntimeError('CREDENTIAL_MISSING', 'Supervisor native control requires the persistent tunnel service credential');
  const server = createServer((request, response) => {
    void handleRequest(request, response, secret, operations).catch(() => {
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

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  secret: string,
  operations: SupervisorNativeOperations,
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${secret}`) {
    writeJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method === 'GET' && request.url === '/healthz') {
    writeJson(response, 200, { ok: true, owner: OWNER, pid: process.pid });
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
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: '0.0.0' } },
    });
    return;
  }
  const methodHeader = request.headers['mcp-method'];
  if (methodHeader !== undefined && methodHeader !== rpc.method) {
    writeJsonRpcError(response, rpc.id ?? null, -32600, 'Mcp-Method does not match JSON-RPC method', 400);
    return;
  }
  if (rpc.method === 'initialize') {
    const params = isRecord(rpc.params) ? rpc.params : null;
    const clientInfo = params !== null && isRecord(params.clientInfo) ? params.clientInfo : null;
    if (typeof params?.protocolVersion !== 'string'
      || !INITIALIZE_PROTOCOL_VERSIONS.has(params.protocolVersion)
      || !isRecord(params.capabilities)
      || typeof clientInfo?.name !== 'string'
      || typeof clientInfo.version !== 'string') {
      writeJsonRpcError(response, rpc.id ?? null, -32602, 'Invalid initialize parameters', 400);
      return;
    }
    writeJsonRpcResult(response, rpc.id ?? null, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: '0.0.0' },
    });
    return;
  }
  const protocolVersion = request.headers['mcp-protocol-version'];
  if (typeof protocolVersion !== 'string'
    || (protocolVersion !== MCP_PROTOCOL_VERSION && !INITIALIZE_PROTOCOL_VERSIONS.has(protocolVersion))) {
    writeJsonRpcError(response, rpc.id ?? null, -32600, 'Unsupported MCP-Protocol-Version', 400);
    return;
  }
  if (rpc.method === 'notifications/initialized' && rpc.id === undefined) {
    response.writeHead(202);
    response.end();
    return;
  }
  if (rpc.method === 'ping') {
    writeJsonRpcResult(response, rpc.id ?? null, {});
    return;
  }
  if (rpc.method === 'tools/list') {
    writeJsonRpcResult(response, rpc.id ?? null, { tools: nativeToolDefinitions() });
    return;
  }
  if (rpc.method !== 'tools/call') {
    writeJsonRpcError(response, rpc.id ?? null, -32601, 'Method not found');
    return;
  }
  const params = isRecord(rpc.params) ? rpc.params : null;
  const name = params !== null && typeof params.name === 'string' ? params.name : null;
  const args = params !== null && (params.arguments === undefined || isRecord(params.arguments)) ? (params.arguments ?? {}) : null;
  if (name === null || args === null) {
    writeJsonRpcError(response, rpc.id ?? null, -32602, 'Supervisor tool arguments must be an object', 400);
    return;
  }
  const toolHeader = request.headers['mcp-name'];
  if (typeof toolHeader === 'string' && toolHeader !== name) {
    writeJsonRpcError(response, rpc.id ?? null, -32600, 'Mcp-Name does not match tool name', 400);
    return;
  }
  try {
    if (name === 'supervisor_status') {
      requireNoArguments(args);
      writeJsonRpcResult(response, rpc.id ?? null, toolResult(await operations.supervisorStatus()));
      return;
    }
    if (name === 'admin_status') {
      requireNoArguments(args);
      writeJsonRpcResult(response, rpc.id ?? null, toolResult(await operations.adminStatus()));
      return;
    }
    if (name === 'runtime_reconcile') {
      requireNoArguments(args);
      writeJsonRpcResult(response, rpc.id ?? null, toolResult(await operations.runtimeReconcile()));
      return;
    }
    if (name === 'admin_recycle') {
      writeJsonRpcResult(response, rpc.id ?? null, toolResult(await operations.adminRecycle(adminRecycleArguments(args))));
      return;
    }
    if (name === 'admin_tunnel_recycle') {
      writeJsonRpcResult(response, rpc.id ?? null, toolResult(await operations.adminTunnelRecycle(adminTunnelRecycleArguments(args))));
      return;
    }
    if (ACTIVATION_NAMES.has(name)) {
      const result = await operations.adminToolCall(name, args);
      writeJsonRpcResult(response, rpc.id ?? null, {
        content: [{ type: 'text', text: JSON.stringify(result.structuredContent) }],
        structuredContent: result.structuredContent,
        isError: result.isError,
      });
      return;
    }
  } catch (error) {
    writeJsonRpcResult(response, rpc.id ?? null, toolErrorResult(error));
    return;
  }
  writeJsonRpcError(response, rpc.id ?? null, -32601, 'Unknown supervisor tool');
}

export function nativeToolDefinitions(): readonly Record<string, unknown>[] {
  const noArgs = { type: 'object', properties: {}, additionalProperties: false };
  const activation = adminToolDefinitions().filter((tool) => typeof tool.name === 'string' && ACTIVATION_NAMES.has(tool.name));
  return [
    {
      name: 'supervisor_status',
      description: 'Read bounded identity, readiness, tunnel identity, and profile digest state owned by the outer supervisor daemon.',
      inputSchema: noArgs,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'admin_status',
      description: 'Read the supervisor-owned admin child identity and bounded activation capability visibility without mutation.',
      inputSchema: noArgs,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'runtime_reconcile',
      description: 'Adopt only a verified running workload runtime and reconcile only already-proven healthy FULL/PRO supervisor ownership metadata without restarting any process.',
      inputSchema: noArgs,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'admin_recycle',
      description: 'Recycle only the supervisor-owned admin child using supervisor-governed identity and optional fail-closed identity/digest preconditions.',
      inputSchema: {
        type: 'object',
        properties: {
          expectedAdminIdentity: { type: 'string', minLength: 1, maxLength: 300 },
          expectedAdminProfileDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'admin_tunnel_recycle',
      description: 'Recycle only the supervisor-owned ADMIN tunnel after fail-closed identity and corrected-profile checks.',
      inputSchema: {
        type: 'object',
        properties: {
          expectedAdminTunnelId: { type: 'string', minLength: 1, maxLength: 300 },
          expectedAdminTunnelIdentity: { type: 'string', minLength: 1, maxLength: 300 },
          expectedAdminProfileDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
        required: ['expectedAdminTunnelId', 'expectedAdminTunnelIdentity', 'expectedAdminProfileDigest'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ...activation,
  ];
}

function adminRecycleArguments(args: Record<string, unknown>): AdminRecycleInput {
  assertAllowedKeys(args, ['expectedAdminIdentity', 'expectedAdminProfileDigest']);
  const expectedAdminIdentity = optionalBoundedString(args, 'expectedAdminIdentity', 300);
  const expectedAdminProfileDigest = optionalBoundedString(args, 'expectedAdminProfileDigest', 64);
  if (expectedAdminProfileDigest !== undefined && !/^[0-9a-f]{64}$/.test(expectedAdminProfileDigest)) {
    throw new RuntimeError('INVALID_REQUEST', 'expectedAdminProfileDigest must be a lowercase SHA-256 digest');
  }
  return {
    ...(expectedAdminIdentity === undefined ? {} : { expectedAdminIdentity }),
    ...(expectedAdminProfileDigest === undefined ? {} : { expectedAdminProfileDigest }),
  };
}

function adminTunnelRecycleArguments(args: Record<string, unknown>): AdminTunnelRecycleInput {
  assertAllowedKeys(args, ['expectedAdminTunnelId', 'expectedAdminTunnelIdentity', 'expectedAdminProfileDigest']);
  const expectedAdminTunnelId = requiredBoundedString(args, 'expectedAdminTunnelId', 300);
  const expectedAdminTunnelIdentity = requiredBoundedString(args, 'expectedAdminTunnelIdentity', 300);
  const expectedAdminProfileDigest = requiredBoundedString(args, 'expectedAdminProfileDigest', 64);
  if (!/^[0-9a-f]{64}$/.test(expectedAdminProfileDigest)) {
    throw new RuntimeError('INVALID_REQUEST', 'expectedAdminProfileDigest must be a lowercase SHA-256 digest');
  }
  return { expectedAdminTunnelId, expectedAdminTunnelIdentity, expectedAdminProfileDigest };
}

function requireNoArguments(args: Record<string, unknown>): void {
  assertAllowedKeys(args, []);
}

function assertAllowedKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(args).find((key) => !allowedSet.has(key));
  if (unexpected !== undefined) throw new RuntimeError('INVALID_REQUEST', `Unexpected supervisor control argument: ${unexpected}`);
}

function optionalBoundedString(args: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new RuntimeError('INVALID_REQUEST', `${key} must be a bounded non-empty string when provided`);
  }
  return value;
}

function requiredBoundedString(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = optionalBoundedString(args, key, maxLength);
  if (value === undefined) throw new RuntimeError('INVALID_REQUEST', `${key} is required`);
  return value;
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value, isError: false as const };
}

function toolErrorResult(error: unknown) {
  const code = error instanceof RuntimeError ? error.code : 'PERSISTENCE_FAILURE';
  const message = error instanceof RuntimeError ? error.message : 'Supervisor native control operation failed';
  const structuredContent = { error: { code, message } };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true as const,
  };
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
