import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeError } from '@iris/domain';
import {
  AGENT_EXECUTOR_ENV,
  LocalDevelopmentAgentExecutor,
  OPENAI_API_KEY_ENV,
  OPENAI_MODEL_ENV,
  OpenAIProductionAgentExecutor,
  createAgentExecutorFromEnvironment,
  type AgentExecutionRequest,
} from './agent-executor.js';
import { FoundationStateStore } from './persistence.js';
import { RuntimeState } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function request(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    executionId: 'execution-a',
    submissionId: 'submission-a',
    sessionId: 'session-a',
    clientId: 'client-a',
    agentId: 'agent-a',
    agentRole: 'owner',
    project: { id: 'project-a', name: 'Private Project Label', rootPath: '/Users/bill/iris' },
    instruction: 'Reply with a bounded answer',
    ...overrides,
  };
}

function providerResponse(text: string): Response {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('OpenAI production agent executor', () => {
  it('builds one bounded Responses API request with the configured model and maps output text', async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const secret = 'openai-test-secret';
    const executor = new OpenAIProductionAgentExecutor({
      apiKey: secret,
      model: 'gpt-5.6-terra',
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return providerResponse('IRIS production result');
      },
    });

    expect(executor.descriptor).toEqual({ type: 'production-provider-executor', productionModelConnected: false });
    const result = await executor.execute(request());

    expect(result).toEqual({ text: 'IRIS production result' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${secret}`);
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.body).toMatchObject({
      model: 'gpt-5.6-terra',
      input: 'Reply with a bounded answer',
      max_output_tokens: 2048,
      store: false,
    });
    expect(String(calls[0]?.body.instructions)).toContain('Agent role: owner');
    expect(String(calls[0]?.body.instructions)).toContain('Active project selected: yes');
    expect(String(calls[0]?.body.instructions)).not.toContain('Private Project Label');
    expect(String(calls[0]?.body.instructions)).not.toContain('/Users/bill/iris');
    expect(String(calls[0]?.body.instructions)).not.toContain('session-a');
    expect(String(calls[0]?.body.instructions)).not.toContain('client-a');
    expect(JSON.stringify(executor.descriptor)).not.toContain(secret);
    expect(executor.descriptor).toEqual({ type: 'production-provider-executor', productionModelConnected: true });
  });

  it.each([
    ['runtime error', new RuntimeError('AGENT_EXECUTION_FAILED', 'authentication failed token=SUPER_SECRET provider_request_id=internal-123 /private/path/config')],
    ['plain error', new Error('authentication failed token=SUPER_SECRET provider_request_id=internal-123 /private/path/config')],
    ['arbitrary value', { token: 'SUPER_SECRET', provider_request_id: 'internal-123', path: '/private/path/config' }],
  ])('sanitizes %s thrown by the provider transport', async (_label, thrownValue) => {
    const executor = new OpenAIProductionAgentExecutor({
      apiKey: 'openai-test-secret',
      model: 'gpt-test-model',
      fetchImpl: async () => { throw thrownValue; },
    });

    const execution = executor.execute(request());
    await expect(execution).rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED', message: 'Production model request failed' });
    await execution.catch((error: unknown) => {
      const visible = error instanceof Error ? error.message : String(error);
      expect(visible).not.toContain('SUPER_SECRET');
      expect(visible).not.toContain('internal-123');
      expect(visible).not.toContain('/private/path/config');
    });
    expect(executor.descriptor.productionModelConnected).toBe(false);
  });

  it('ignores raw provider error bodies and fails with a product-safe message', async () => {
    const sensitiveDiagnostic = 'authentication failed token=SUPER_SECRET provider_request_id=internal-123 /private/path/config';
    const executor = new OpenAIProductionAgentExecutor({
      apiKey: 'openai-test-secret',
      model: 'gpt-test-model',
      fetchImpl: async () => new Response(sensitiveDiagnostic, { status: 401 }),
    });

    await expect(executor.execute(request())).rejects.toMatchObject({
      code: 'AGENT_EXECUTION_FAILED',
      message: 'Production model request failed',
    });
  });

  it('fails safely for malformed or oversized provider results', async () => {
    const malformed = new OpenAIProductionAgentExecutor({
      apiKey: 'openai-test-secret', model: 'gpt-test-model',
      fetchImpl: async () => new Response(JSON.stringify({ status: 'completed', provider_secret: 'SUPER_SECRET' }), { status: 200 }),
    });
    await expect(malformed.execute(request())).rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED' });

    const oversized = new OpenAIProductionAgentExecutor({
      apiKey: 'openai-test-secret', model: 'gpt-test-model',
      fetchImpl: async () => providerResponse('x'.repeat(12_001)),
    });
    await expect(oversized.execute(request())).rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED' });
  });

  it('requires an explicit completed status before accepting provider output', async () => {
    const executor = new OpenAIProductionAgentExecutor({
      apiKey: 'openai-test-secret',
      model: 'gpt-test-model',
      fetchImpl: async () => new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'must not be accepted' }] }],
      }), { status: 200 }),
    });

    await expect(executor.execute(request())).rejects.toMatchObject({
      code: 'AGENT_EXECUTION_FAILED',
      message: 'Production model did not complete the response',
    });
    expect(executor.descriptor.productionModelConnected).toBe(false);
  });

  it('keeps connectivity false when a later overlapping request ends in an HTTP or schema failure', async () => {
    for (const failingResponse of [
      () => new Response('', { status: 401 }),
      () => new Response(JSON.stringify({ status: 'failed' }), { status: 200 }),
    ]) {
      const pending: Array<(response: Response) => void> = [];
      const executor = new OpenAIProductionAgentExecutor({
        apiKey: 'openai-test-secret',
        model: 'gpt-test-model',
        fetchImpl: async () => await new Promise<Response>((resolve) => { pending.push(resolve); }),
      });

      const first = executor.execute(request({ sessionId: 'session-a' }));
      const second = executor.execute(request({ sessionId: 'session-b', submissionId: 'submission-b' }));
      pending[0]?.(providerResponse('first succeeded'));
      await expect(first).resolves.toEqual({ text: 'first succeeded' });
      expect(executor.descriptor.productionModelConnected).toBe(true);

      pending[1]?.(failingResponse());
      await expect(second).rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED' });
      expect(executor.descriptor.productionModelConnected).toBe(false);
    }
  });

  it('times out without exposing transport diagnostics', async () => {
    const executor = new OpenAIProductionAgentExecutor({
      apiKey: 'openai-test-secret',
      model: 'gpt-test-model',
      timeoutMs: 5,
      fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error('missing timeout signal'));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });

    await expect(executor.execute(request())).rejects.toMatchObject({
      code: 'AGENT_EXECUTION_FAILED',
      message: 'Production model request failed',
    });
  });

  it('selects development or OpenAI deterministically and never silently falls back', async () => {
    const development = createAgentExecutorFromEnvironment({});
    expect(development).toBeInstanceOf(LocalDevelopmentAgentExecutor);
    expect(development.descriptor).toEqual({ type: 'local-development-executor', productionModelConnected: false });

    const production = createAgentExecutorFromEnvironment({
      [AGENT_EXECUTOR_ENV]: 'openai',
      [OPENAI_API_KEY_ENV]: 'openai-test-secret',
      [OPENAI_MODEL_ENV]: 'gpt-test-model',
    }, async () => providerResponse('production'));
    expect(production).toBeInstanceOf(OpenAIProductionAgentExecutor);
    expect(production.descriptor.type).toBe('production-provider-executor');

    const missing = createAgentExecutorFromEnvironment({ [AGENT_EXECUTOR_ENV]: 'openai' });
    expect(missing.descriptor).toEqual({ type: 'production-provider-executor', productionModelConnected: false });
    await expect(missing.execute(request())).rejects.toMatchObject({
      code: 'AGENT_EXECUTION_FAILED',
      message: 'Production model configuration is incomplete',
    });

    expect(() => createAgentExecutorFromEnvironment({ [AGENT_EXECUTOR_ENV]: 'unknown-provider' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });

  it('keeps provider execution session-bound and preserves replay/conflict protection', async () => {
    let providerCalls = 0;
    const executor = new OpenAIProductionAgentExecutor({
      apiKey: 'openai-test-secret',
      model: 'gpt-test-model',
      fetchImpl: async (_input, init) => {
        providerCalls += 1;
        const body = JSON.parse(String(init?.body)) as { input: string };
        return providerResponse(`provider:${body.input}`);
      },
    });
    const state = new RuntimeState(new FoundationStateStore(await temp('iris-openai-state-')), executor);
    const sessionA = state.createSession('client-a', 'agent-a', 'owner');
    const sessionB = state.createSession('client-b', 'agent-b', 'planner');

    const completedA = await state.submitInstruction(sessionA.id, sessionA.clientId, 'shared-id', 'Instruction A');
    const replayA = await state.submitInstruction(sessionA.id, sessionA.clientId, 'shared-id', 'Instruction A');
    await expect(state.submitInstruction(sessionA.id, sessionA.clientId, 'shared-id', 'Conflicting A')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const completedB = await state.submitInstruction(sessionB.id, sessionB.clientId, 'shared-id', 'Instruction B');

    expect(providerCalls).toBe(2);
    expect(state.executorDescriptor()).toEqual({ type: 'production-provider-executor', productionModelConnected: true });
    expect(replayA.interactions).toEqual(completedA.interactions);
    expect(completedA.interactions.at(-1)?.text).toBe('provider:Instruction A');
    expect(completedB.interactions.at(-1)?.text).toBe('provider:Instruction B');
    expect(completedA.interactions.some((event) => event.text === 'provider:Instruction B')).toBe(false);
    expect(completedB.interactions.some((event) => event.text === 'provider:Instruction A')).toBe(false);
  });
});
