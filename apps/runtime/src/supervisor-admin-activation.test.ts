import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeError } from '@iris/domain';
import { loadOrCreateTunnelServiceSecret } from './credentials.js';
import { catalogToolNames } from './mcp-catalog.js';
import {
  ActivationController,
  type ActivationCandidateInspector,
  type ActivationCandidateSnapshot,
  type ActivationPrepareInput,
  type ActivationRuntimeAdapter,
  type ActivationRuntimeSnapshot,
} from './activation-controller.js';
import { callSupervisorAdminTool, startSupervisorAdminServer } from './supervisor-admin.js';

const roots: string[] = [];
const HEAD = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);
const CATALOG_A = `sha256:${'1'.repeat(64)}`;
const CATALOG_B = `sha256:${'2'.repeat(64)}`;
const SOURCE_A = '/synthetic/admin-activation/a';
const SOURCE_B = '/synthetic/admin-activation/b';
const ACTIVATION_TOOLS = [
  'activation_status',
  'activation_prepare',
  'activation_apply',
  'activation_confirm',
  'activation_rollback',
] as const;

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('persistent supervisor-admin activation MCP', () => {
  it('exposes activation lifecycle only on admin and not in workload FULL or PRO catalogs', async () => {
    const harness = await startHarness();
    try {
      const listed = await rpc(harness, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      const tools = resultTools(listed);
      const names = tools.map((tool) => String(tool.name));
      expect(names).toEqual(expect.arrayContaining([...ACTIVATION_TOOLS]));
      expect(names).toEqual(expect.arrayContaining(['admin_status', 'admin_identity']));
      for (const name of ACTIVATION_TOOLS) {
        expect(catalogToolNames('FULL')).not.toContain(name);
        expect(catalogToolNames('PRO')).not.toContain(name);
      }
      const prepare = tools.find((tool) => tool.name === 'activation_prepare');
      expect(prepare?.inputSchema).toMatchObject({ additionalProperties: false });
      const properties = isRecord(prepare?.inputSchema) && isRecord(prepare.inputSchema.properties)
        ? Object.keys(prepare.inputSchema.properties)
        : [];
      expect(properties).toEqual([
        'projectId', 'workspaceId', 'repositoryId', 'expectedHead', 'expectedCandidateFingerprint',
        'expectedCurrentDeploymentEpoch', 'expectedRuntimeId', 'expectedCatalogId',
      ]);
      for (const forbidden of ['sourceRoot', 'path', 'command', 'shell', 'argv', 'pid', 'process', 'service', 'executable']) {
        expect(properties).not.toContain(forbidden);
      }
    } finally {
      await harness.server.close();
    }
  });

  it('rejects arbitrary path, shell, argv, process, service, and executable authority fields', async () => {
    const harness = await startHarness();
    try {
      for (const [key, value] of Object.entries({
        sourceRoot: '/tmp/escape',
        path: '/tmp/escape',
        command: 'rm -rf /',
        shell: '/bin/sh',
        argv: ['anything'],
        pid: 1234,
        process: 'launchd',
        service: 'arbitrary-service',
        executable: '/bin/kill',
      })) {
        const response = await rpcTool(harness, 'activation_prepare', { ...harness.input(), [key]: value });
        expect(toolError(response)).toMatchObject({ code: 'INVALID_REQUEST' });
      }
      expect(harness.runtime.appliedRoots).toEqual([]);
    } finally {
      await harness.server.close();
    }
  });

  it('proves A -> B -> rollback A while the same persistent admin endpoint remains reachable', async () => {
    const harness = await startHarness();
    try {
      const prepare = await rpcTool(harness, 'activation_prepare', harness.input());
      const prepared = structured(prepare);
      expect(prepared.state).toBe('PREPARED');
      const transactionId = String(prepared.transactionId);

      const applied = structured(await rpcTool(harness, 'activation_apply', { transactionId }));
      expect(applied.state).toBe('APPLIED');
      expect(harness.runtime.current.workloadSourceRoot).toBe(SOURCE_B);

      const afterApply = structured(await rpcTool(harness, 'activation_status', {}));
      expect(isRecord(afterApply.runtime) ? afterApply.runtime.workloadSourceRoot : null).toBe(SOURCE_B);
      expect(await adminHealth(harness)).toBe(true);

      const rolled = structured(await rpcTool(harness, 'activation_rollback', { transactionId }));
      expect(rolled.state).toBe('ROLLED_BACK');
      expect(harness.runtime.current.workloadSourceRoot).toBe(SOURCE_A);

      const afterRollback = structured(await rpcTool(harness, 'activation_status', {}));
      expect(isRecord(afterRollback.runtime) ? afterRollback.runtime.workloadSourceRoot : null).toBe(SOURCE_A);
      expect(await adminHealth(harness)).toBe(true);
      expect(harness.runtime.appliedRoots).toEqual([SOURCE_B, SOURCE_A]);
    } finally {
      await harness.server.close();
    }
  });

  it('proves A -> B -> CONFIRMED and rejects rollback after confirmation', async () => {
    const harness = await startHarness();
    try {
      const prepared = structured(await rpcTool(harness, 'activation_prepare', harness.input()));
      const transactionId = String(prepared.transactionId);
      expect(structured(await rpcTool(harness, 'activation_apply', { transactionId })).state).toBe('APPLIED');
      expect(await adminHealth(harness)).toBe(true);
      const confirmed = structured(await rpcTool(harness, 'activation_confirm', { transactionId }));
      expect(confirmed.state).toBe('CONFIRMED');
      expect(harness.runtime.current.workloadSourceRoot).toBe(SOURCE_B);
      expect(await adminHealth(harness)).toBe(true);
      expect(toolError(await rpcTool(harness, 'activation_rollback', { transactionId }))).toMatchObject({ code: 'PRECONDITION_FAILED' });
    } finally {
      await harness.server.close();
    }
  });

  it('allows activation apply and rollback to exceed the two-second probe budget', async () => {
    const harness = await startHarness({ applyDelayMs: 2_100 });
    try {
      const prepared = structured(await rpcTool(harness, 'activation_prepare', harness.input()));
      const transactionId = String(prepared.transactionId);
      const applied = await callSupervisorAdminTool(harness.dataRoot, harness.port, 'activation_apply', { transactionId });
      expect(applied.isError).toBe(false);
      expect(isRecord(applied.structuredContent) ? applied.structuredContent.state : null).toBe('APPLIED');
      expect(harness.runtime.appliedRoots).toEqual([SOURCE_B]);

      const rolled = await callSupervisorAdminTool(harness.dataRoot, harness.port, 'activation_rollback', { transactionId });
      expect(rolled.isError).toBe(false);
      expect(isRecord(rolled.structuredContent) ? rolled.structuredContent.state : null).toBe('ROLLED_BACK');
      expect(harness.runtime.appliedRoots).toEqual([SOURCE_B, SOURCE_A]);
    } finally {
      await harness.server.close();
    }
  }, 10_000);

  it('reconciles durable terminal state after a mutation transport timeout without overlapping mutations', async () => {
    const harness = await startHarness({ applyDelayMs: 120 });
    const policy = {
      shortTimeoutMs: 250,
      mutationTimeoutMs: 25,
      reconciliationTimeoutMs: 2_000,
      reconciliationPollMs: 10,
    };
    try {
      const prepared = structured(await rpcTool(harness, 'activation_prepare', harness.input()));
      const transactionId = String(prepared.transactionId);
      const applied = await callSupervisorAdminTool(harness.dataRoot, harness.port, 'activation_apply', { transactionId }, policy);
      expect(applied.isError).toBe(false);
      expect(isRecord(applied.structuredContent) ? applied.structuredContent.state : null).toBe('APPLIED');
      expect(harness.runtime.appliedRoots).toEqual([SOURCE_B]);

      const rolled = await callSupervisorAdminTool(harness.dataRoot, harness.port, 'activation_rollback', { transactionId }, policy);
      expect(rolled.isError).toBe(false);
      expect(isRecord(rolled.structuredContent) ? rolled.structuredContent.state : null).toBe('ROLLED_BACK');
      expect(harness.runtime.appliedRoots).toEqual([SOURCE_B, SOURCE_A]);
    } finally {
      await harness.server.close();
    }
  });

  it('retains a short timeout for read-only admin proxy calls', async () => {
    const harness = await startHarness({ snapshotDelayMs: 100 });
    try {
      await expect(callSupervisorAdminTool(
        harness.dataRoot,
        harness.port,
        'activation_status',
        {},
        { shortTimeoutMs: 20, mutationTimeoutMs: 1_000, reconciliationTimeoutMs: 500, reconciliationPollMs: 10 },
      )).rejects.toMatchObject({ code: 'CONTROL_PLANE_UNREACHABLE' });
    } finally {
      await harness.server.close();
    }
  });
});

class FakeInspector implements ActivationCandidateInspector {
  public constructor(
    private readonly candidate: ActivationCandidateSnapshot,
    private readonly projectId: string,
    private readonly workspaceId: string,
    private readonly repositoryId: string,
  ) {}

  public async inspect(projectId: string, workspaceId: string, repositoryId: string): Promise<ActivationCandidateSnapshot> {
    if (projectId !== this.projectId) throw new RuntimeError('PROJECT_NOT_FOUND', 'synthetic project mismatch');
    if (workspaceId !== this.workspaceId) throw new RuntimeError('CAPABILITY_DENIED', 'synthetic workspace mismatch');
    if (repositoryId !== this.repositoryId) throw new RuntimeError('CAPABILITY_DENIED', 'synthetic repository mismatch');
    return { ...this.candidate };
  }
}

class FakeRuntime implements ActivationRuntimeAdapter {
  public readonly appliedRoots: string[] = [];

  public constructor(
    public current: ActivationRuntimeSnapshot,
    private readonly applyDelayMs = 0,
    private readonly snapshotDelayMs = 0,
  ) {}

  public async snapshot(): Promise<ActivationRuntimeSnapshot> {
    if (this.snapshotDelayMs > 0) await delay(this.snapshotDelayMs);
    return { ...this.current };
  }

  public async applySourceRoot(sourceRoot: string): Promise<ActivationRuntimeSnapshot> {
    if (this.applyDelayMs > 0) await delay(this.applyDelayMs);
    this.appliedRoots.push(sourceRoot);
    const epoch = (this.current.deploymentEpoch ?? 0) + 1;
    const target = sourceRoot === SOURCE_B;
    this.current = {
      ...this.current,
      readiness: 'READY',
      workloadSourceRoot: sourceRoot,
      runtimeId: 'runtime-synthetic',
      instanceId: target ? `instance-b-${epoch}` : `instance-a-${epoch}`,
      catalogId: target ? CATALOG_B : CATALOG_A,
      deploymentEpoch: epoch,
      fullToolCount: target ? 50 : 48,
      proToolCount: 5,
    };
    return { ...this.current };
  }
}

async function startHarness(options: { readonly applyDelayMs?: number; readonly snapshotDelayMs?: number } = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-supervisor-admin-activation-'));
  roots.push(dataRoot);
  await mkdir(path.join(dataRoot, 'supervisor'), { recursive: true, mode: 0o700 });
  const secret = await loadOrCreateTunnelServiceSecret(dataRoot);
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const repositoryId = randomUUID();
  const inspector = new FakeInspector({
    projectId,
    workspaceId,
    repositoryId,
    sourceRoot: SOURCE_B,
    head: HEAD,
    candidateFingerprint: FINGERPRINT,
    trackedModifiedCount: 2,
    fingerprintAlgorithm: 'sha256:sorted-tracked-path-content-v1',
  }, projectId, workspaceId, repositoryId);
  const runtime = new FakeRuntime({
    readiness: 'READY',
    runtimeId: 'runtime-synthetic',
    instanceId: 'instance-a',
    catalogId: CATALOG_A,
    deploymentEpoch: 10,
    fullToolCount: 48,
    proToolCount: 5,
    workloadSourceRoot: SOURCE_A,
  }, options.applyDelayMs ?? 0, options.snapshotDelayMs ?? 0);
  const controller = new ActivationController(dataRoot, inspector, runtime);
  const port = await freePort();
  const server = await startSupervisorAdminServer(dataRoot, port, controller);
  const input = (): ActivationPrepareInput => ({
    projectId,
    workspaceId,
    repositoryId,
    expectedHead: HEAD,
    expectedCandidateFingerprint: FINGERPRINT,
    expectedCurrentDeploymentEpoch: runtime.current.deploymentEpoch!,
    expectedRuntimeId: runtime.current.runtimeId!,
    expectedCatalogId: runtime.current.catalogId!,
  });
  return { dataRoot, secret, projectId, workspaceId, repositoryId, runtime, controller, port, server, input };
}

async function rpcTool(harness: Awaited<ReturnType<typeof startHarness>>, name: string, args: object) {
  return rpc(harness, {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

async function rpc(harness: Awaited<ReturnType<typeof startHarness>>, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${harness.secret}`,
      'content-type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

async function adminHealth(harness: Awaited<ReturnType<typeof startHarness>>): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${harness.port}/healthz`, {
    headers: { authorization: `Bearer ${harness.secret}` },
  });
  if (!response.ok) return false;
  const value = await response.json() as unknown;
  return isRecord(value) && value.ok === true && value.owner === 'PERSISTENT_SUPERVISOR_OR_CONTROL_PLANE';
}

function resultTools(value: Record<string, unknown>): Record<string, unknown>[] {
  if (!isRecord(value.result) || !Array.isArray(value.result.tools)) return [];
  return value.result.tools.filter(isRecord);
}

function structured(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.result) || !isRecord(value.result.structuredContent)) throw new Error('missing structuredContent');
  return value.result.structuredContent;
}

function toolError(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.result) || value.result.isError !== true || !isRecord(value.result.structuredContent)
    || !isRecord(value.result.structuredContent.error)) throw new Error('missing tool error');
  return value.result.structuredContent.error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Could not reserve synthetic admin port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
