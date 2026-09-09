import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { node24Environment, node24TsxArgs, resolveCanonicalNode } from './node24.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const artifactRoot = path.join(repoRoot, '.local-artifacts');
await mkdir(artifactRoot, { recursive: true });
const projectRoot = await mkdtemp(path.join(artifactRoot, 'permission-smoke-project-'));
const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-permission-smoke-data-'));
const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-permission-smoke-outside-'));
const node = resolveCanonicalNode();
const environment = node24Environment(process.env, { IRIS_RUNTIME_DATA_ROOT: dataRoot });
let dev;
let ownerAccessToken = '';

try {
  const endpoints = endpointPromise();
  dev = spawn(node.path, [path.join(repoRoot, 'scripts', 'dev.mjs')], {
    cwd: repoRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  dev.stderr.setEncoding('utf8');
  dev.stderr.on('data', (chunk) => { stderr.push(chunk); process.stderr.write(chunk); });
  pipeAndDiscover(dev.stdout, endpoints.observe);
  dev.once('exit', (code) => endpoints.exit(code, stderr.join('')));

  const { runtimeUrl, webUrl, ownerToken } = await endpoints.ready;
  ownerAccessToken = ownerToken;
  const health = await requestJson(`${webUrl}health`);
  if (health.apiUrl !== runtimeUrl) throw new Error('Web proxy did not attach to the discovered runtime');

  const permissions = await requestJson(`${webUrl}permissions`);
  if (permissions.mode !== 'FULL_LOCAL_OWNER') throw new Error(`Unexpected permission mode: ${permissions.mode}`);

  const session = await requestJson(`${webUrl}sessions`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ clientId: 'real-web-smoke', agentId: 'agent-owner-web-smoke', agentRole: 'owner' }),
  });
  const project = await requestJson(`${webUrl}projects`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'Real Web Smoke', rootPath: projectRoot }),
  });
  await requestJson(`${webUrl}sessions/${session.id}/current-project`, {
    method: 'PUT', headers: jsonHeaders({ 'x-iris-client-id': session.clientId }), body: JSON.stringify({ projectId: project.id }),
  });

  const target = path.join(projectRoot, 'owner-mode.txt');
  await fileCapability(webUrl, session, project.id, 'write', { targetPath: target, content: 'created' });
  if (await readFile(target, 'utf8') !== 'created') throw new Error('Project-scoped create did not execute');
  await fileCapability(webUrl, session, project.id, 'write', { targetPath: target, content: 'edited' });
  if (await readFile(target, 'utf8') !== 'edited') throw new Error('Project-scoped edit did not execute');
  await fileCapability(webUrl, session, project.id, 'delete', { targetPath: target });
  if (await exists(target)) throw new Error('Project-scoped delete did not execute');

  const mcpTarget = path.join(projectRoot, 'mcp-owner-mode.txt');
  await mcpTool(runtimeUrl, session, 'file_write', { projectId: project.id, targetPath: mcpTarget, content: 'mcp-created' });
  const mcpRead = await mcpTool(runtimeUrl, session, 'file_read', { projectId: project.id, targetPath: mcpTarget });
  if (mcpRead?.content !== 'mcp-created') throw new Error('Local MCP read did not return the project file content');
  await mcpTool(runtimeUrl, session, 'file_delete', { projectId: project.id, targetPath: mcpTarget });
  if (await exists(mcpTarget)) throw new Error('Local MCP delete did not execute');

  const audit = await requestJson(`${webUrl}permissions/audit?limit=50`);
  if (!audit.events.some((event) => event.capabilityId === 'file.write' && event.agentId === 'agent-owner-web-smoke' && event.decision === 'ALLOW_AUTO' && event.result === 'SUCCESS')) {
    throw new Error('ALLOW_AUTO audit evidence is missing');
  }
  const auditText = JSON.stringify(audit);
  if (auditText.includes('created') || auditText.includes('edited')) throw new Error('File contents leaked into audit metadata');

  const outsideTarget = path.join(outsideRoot, 'must-not-exist.txt');
  const outside = await globalThis.fetch(`${webUrl}capabilities/file/write`, {
    method: 'POST',
    headers: jsonHeaders({ 'x-iris-client-id': session.clientId, 'x-iris-session-id': session.id }),
    body: JSON.stringify({ projectId: project.id, targetPath: outsideTarget, content: 'blocked' }),
  });
  if (outside.status !== 403 || await exists(outsideTarget)) throw new Error('Outside-root mutation did not fail closed');

  const legacy = await globalThis.fetch(`${webUrl}projects`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'Legacy Reference', rootPath: '/Users/bill/iris-native-runtime' }),
  });
  if (legacy.status !== 403) throw new Error(`Legacy reference mutation was not denied: HTTP ${legacy.status}`);

  dev.kill('SIGTERM');
  await waitForExit(dev, 15_000);
  dev = undefined;

  const stopped = await runtimeControl('status', environment);
  if (stopped.state !== 'stopped') throw new Error(`Runtime remained active after pnpm dev shutdown: ${stopped.state}`);
  const restarted = await runtimeControl('start', environment);
  if (restarted.state !== 'running') throw new Error(`Immediate runtime restart failed: ${restarted.state}`);
  const stoppedAgain = await runtimeControl('stop', environment);
  if (stoppedAgain.state !== 'stopped') throw new Error(`Restarted runtime did not stop cleanly: ${stoppedAgain.state}`);

  process.stdout.write('LOCAL_PERMISSION_SMOKE=PASS\n');
} finally {
  if (dev !== undefined && dev.exitCode === null) {
    dev.kill('SIGTERM');
    await waitForExit(dev, 5_000).catch(() => undefined);
  }
  await runtimeControl('stop', environment).catch(() => undefined);
  await Promise.all([
    rm(projectRoot, { recursive: true, force: true }),
    rm(dataRoot, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true }),
  ]);
}

function endpointPromise() {
  let runtimeUrl;
  let webUrl;
  let ownerToken;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timeout = globalThis.setTimeout(() => rejectReady(new Error('Timed out waiting for runtime/Web owner endpoints')), 20_000);
  const check = () => {
    if (runtimeUrl !== undefined && webUrl !== undefined && ownerToken !== undefined) {
      globalThis.clearTimeout(timeout);
      resolveReady({ runtimeUrl, webUrl, ownerToken });
    }
  };
  return {
    ready,
    observe(line) {
      const runtimeMatch = /^IRIS_RUNTIME_URL=(http:\/\/127\.0\.0\.1:\d+)$/.exec(line.trim());
      if (runtimeMatch) runtimeUrl = `${runtimeMatch[1]}`;
      const ownerMatch = /^IRIS_OWNER_URL=(http:\/\/127\.0\.0\.1:\d+\/)#owner=([A-Za-z0-9_-]{40,128})$/.exec(line.trim());
      if (ownerMatch) {
        webUrl = ownerMatch[1];
        ownerToken = ownerMatch[2];
      }
      check();
    },
    exit(code, stderr) {
      if (runtimeUrl === undefined || webUrl === undefined || ownerToken === undefined) {
        globalThis.clearTimeout(timeout);
        rejectReady(new Error(`pnpm dev exited before readiness (${code ?? 'signal'}): ${stderr}`));
      }
    },
  };
}

function pipeAndDiscover(stream, observe) {
  stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) observe(line);
  });
}

async function mcpTool(runtimeUrl, session, name, args) {
  const response = await globalThis.fetch(`${runtimeUrl}/mcp`, {
    method: 'POST',
    headers: {
      ...jsonHeaders(),
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
      'x-iris-client-id': session.clientId,
      'x-iris-session-id': session.id,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (body?.result?.isError === true) throw new Error(`MCP tool ${name} failed: ${JSON.stringify(body.result.structuredContent)}`);
  return body?.result?.structuredContent;
}

async function fileCapability(webUrl, session, projectId, operation, body) {
  return requestJson(`${webUrl}capabilities/file/${operation}`, {
    method: 'POST',
    headers: jsonHeaders({ 'x-iris-client-id': session.clientId, 'x-iris-session-id': session.id }),
    body: JSON.stringify({ projectId, ...body }),
  });
}

async function requestJson(url, init = {}) {
  const headers = new globalThis.Headers(init.headers);
  if (ownerAccessToken.length > 0) headers.set('authorization', `Bearer ${ownerAccessToken}`);
  const response = await globalThis.fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${await response.text()}`);
  return response.json();
}

function jsonHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    ...(ownerAccessToken.length === 0 ? {} : { authorization: `Bearer ${ownerAccessToken}` }),
    ...extra,
  };
}

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => reject(new Error('Process did not exit before deadline')), timeoutMs);
    child.once('exit', () => { globalThis.clearTimeout(timeout); resolve(); });
  });
}

async function runtimeControl(command, env) {
  const child = spawn(node.path, node24TsxArgs(path.join(repoRoot, 'apps', 'runtime', 'src', 'control.ts'), [command]), { cwd: path.join(repoRoot, 'apps', 'runtime'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitForExit(child, 20_000);
  if (child.exitCode !== 0) throw new Error(`runtime ${command} failed: ${stderr}`);
  return JSON.parse(stdout);
}
