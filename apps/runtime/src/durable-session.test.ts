import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadOrCreateMachineId } from './machine-identity.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('ensures two durable conversations, survives replacement, and never infers the latest session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-durable-session-')); roots.push(root);
  await loadOrCreateMachineId(root);
  const state = new RuntimeState(new FoundationStateStore(root));
  const input = { clientId: 'chatgpt', conversationId: randomUUID(), requestId: randomUUID() };
  const a = await state.ensureSession(input);
  const b = await state.ensureSession({ ...input, conversationId: randomUUID(), requestId: randomUUID() });
  expect(b.id).not.toBe(a.id);
  expect((await state.ensureSession(input)).id).toBe(a.id);
  const replacement = new RuntimeState(new FoundationStateStore(root));
  await replacement.initializeSessions();
  expect(replacement.getSessionForClient(a.id, input.clientId).id).toBe(a.id);
  expect(replacement.getSessionForClient(b.id, input.clientId).id).toBe(b.id);
  expect(() => replacement.getSessionForClient(a.id, 'another-client')).toThrow();
  await expect(replacement.ensureSession({ ...input, conversationId: randomUUID() })).rejects.toThrow();
});

it('persists detach/resume receipts without changing project registrations or replaying transitions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-durable-session-')); roots.push(root);
  await loadOrCreateMachineId(root);
  const state = new RuntimeState(new FoundationStateStore(root));
  const project = await state.registerProject('fixture', root);
  const session = await state.ensureSession({ clientId: 'owner', conversationId: randomUUID(), requestId: randomUUID() });
  const detach = { operation: 'detach' as const, clientId: 'owner', sessionId: session.id, requestId: randomUUID() };
  const detached = await state.mutateSession(detach);
  expect(detached.attachmentState).toBe('DETACHED');
  expect(await state.mutateSession(detach)).toEqual(detached);
  const resume = { ...detach, operation: 'resume' as const, requestId: randomUUID() };
  expect((await state.mutateSession(resume)).attachmentState).toBe('ATTACHED');
  const document = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
  expect(document.projects[0].id).toBe(project.id);
  expect(document.schemaVersion).toBe(2);
  const closed = await state.mutateSession({ ...detach, operation: 'close', requestId: randomUUID() });
  expect(closed.attachmentState).toBe('CLOSED');
  await expect(state.mutateSession({ ...resume, requestId: randomUUID() })).rejects.toThrow();
});

it('retains completed instruction identity and refuses interrupted instruction replay after replacement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-durable-session-')); roots.push(root);
  await loadOrCreateMachineId(root);
  let executions = 0;
  const executor = { descriptor: { type: 'local-development-executor' as const, productionModelConnected: false }, execute: async () => { executions += 1; return { text: 'complete' }; } };
  const state = new RuntimeState(new FoundationStateStore(root), executor);
  const session = await state.ensureSession({ clientId: 'owner', conversationId: randomUUID(), requestId: randomUUID() });
  const submissionId = randomUUID();
  await state.submitInstruction(session.id, 'owner', submissionId, 'fixture instruction');
  const replacement = new RuntimeState(new FoundationStateStore(root), executor);
  await replacement.initializeSessions();
  await replacement.submitInstruction(session.id, 'owner', submissionId, 'fixture instruction');
  expect(executions).toBe(1);
  await expect(replacement.submitInstruction(session.id, 'owner', submissionId, 'changed instruction')).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  const filename = path.join(root, 'state.json');
  const document = JSON.parse(await readFile(filename, 'utf8'));
  document.sessions[0].snapshot.executionState = 'WORKING';
  document.sessions[0].submissions[0].state = 'RUNNING';
  await writeFile(filename, JSON.stringify(document), { mode: 0o600 });
  const before = await readFile(filename, 'utf8');
  const interrupted = new RuntimeState(new FoundationStateStore(root), executor);
  await interrupted.initializeSessions();
  await expect(interrupted.submitInstruction(session.id, 'owner', submissionId, 'fixture instruction')).rejects.toMatchObject({ code: 'AUTHORITY_INDETERMINATE' });
  expect(await readFile(filename, 'utf8')).toBe(before);
  expect(executions).toBe(1);
});
