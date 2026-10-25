import { randomUUID } from 'node:crypto';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RuntimeError } from '@iris/domain';
import { DurableJobManager, inspectDurableRunnerEvidence } from './durable-job-manager.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';
import { VNextResourceRegistry } from './resource-registry.js';
import { loadOrCreateMachineId } from './machine-identity.js';
import type { SafetyWriterGate } from './production-safety.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('denied admission leaves no queued record, runtime directory or scratch workspace', async () => {
  const f = await fixture();
  const gate = { runMutation: async () => { throw new RuntimeError('CONTROL_DENIED', 'fenced'); } } as unknown as SafetyWriterGate;
  const jobs = new DurableJobManager(f.root, f.resources, gate);
  const prepared = await jobs.prepare(f.input);
  await expect(jobs.start(prepared, randomUUID(), ['READ', 'EXECUTE'])).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  for (const filename of ['vnext-jobs.json', 'vnext-job-runtime', 'vnext-resources.json']) await expect(access(path.join(f.root, filename))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await inspectDurableRunnerEvidence(f.root)).toEqual({ active: 0 });
});

it('holds admission from clean prelaunch through a verified runner and binds duplicate starts to the original owner', async () => {
  const f = await fixture();
  let admissions = 0;
  const gate = { runMutation: async <T>(component: string, operation: () => Promise<T>) => {
    if (component === 'external-runners') {
      admissions += 1;
      expect(await inspectDurableRunnerEvidence(f.root)).toEqual({ active: 0 });
      const result = await operation();
      expect(await inspectDurableRunnerEvidence(f.root)).toEqual({ active: 1 });
      return result;
    }
    return operation();
  } } as SafetyWriterGate;
  const jobs = new DurableJobManager(f.root, f.resources, gate);
  const authority = f.state.getDurableSessionAuthority(f.session.id, f.session.clientId)!;
  const prepared = await jobs.prepare({ ...f.input, authority });
  const requestId = randomUUID();
  const [a, b] = await Promise.all([jobs.start(prepared, requestId, ['READ', 'EXECUTE']), jobs.start(prepared, requestId, ['READ', 'EXECUTE'])]);
  expect(a.jobId).toBe(b.jobId);
  expect(admissions).toBe(1);
  const other = await f.state.ensureSession({ clientId: 'chatgpt', conversationId: randomUUID(), requestId: randomUUID() });
  await expect(jobs.status(f.project.id, String(a.jobId), f.state.getDurableSessionAuthority(other.id, 'chatgpt'))).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  await f.state.mutateSession({ operation: 'select', sessionId: f.session.id, clientId: 'chatgpt', projectId: null, requestId: randomUUID() });
  expect(await jobs.status(f.project.id, String(a.jobId), f.state.getDurableSessionAuthority(f.session.id, 'chatgpt'))).toMatchObject({ state: 'RUNNING' });
  // The fixture exits by itself; only fixture-owned resources are removed.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await jobs.status(f.project.id, String(a.jobId), f.state.getDurableSessionAuthority(f.session.id, 'chatgpt'))).state === 'RUNNING') await new Promise((resolve) => setTimeout(resolve, 40));
  expect(await jobs.result(f.project.id, String(a.jobId), f.state.getDurableSessionAuthority(f.session.id, 'chatgpt'))).toMatchObject({ state: 'SUCCEEDED' });
}, 15_000);

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-admission-data-'))); roots.push(root);
  const projectRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-admission-project-'))); roots.push(projectRoot);
  await loadOrCreateMachineId(root);
  await writeFile(path.join(projectRoot, 'fixture.mjs'), "setTimeout(() => console.log('done'), 4000);\n");
  const state = new RuntimeState(new FoundationStateStore(root));
  const project = await state.registerProject('fixture', projectRoot);
  const session = await state.ensureSession({ clientId: 'chatgpt', conversationId: randomUUID(), requestId: randomUUID() });
  const resources = new VNextResourceRegistry(state, root);
  const workspace = await resources.primaryWorkspace(project.id);
  return { root, state, project, session, resources, input: { projectId: project.id, workspaceId: workspace.workspaceId, executable: 'node', argv: ['fixture.mjs'], cwd: '.', executionProfile: 'node-script', envOverrides: {}, timeoutMs: 8000 } };
}
