import { RuntimeError, type AgentExecutorType, type AgentRole, type ProjectReference } from '@iris/domain';

export const AGENT_EXECUTOR_ENV = 'IRIS_AGENT_EXECUTOR' as const;
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY' as const;
export const OPENAI_MODEL_ENV = 'IRIS_OPENAI_MODEL' as const;
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses' as const;

const MAX_PROVIDER_INSTRUCTION_CHARS = 8_000;
const MAX_PROVIDER_OUTPUT_CHARS = 12_000;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_PROVIDER_OUTPUT_TOKENS = 2_048;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_TIMEOUT_MS = 120_000;

export interface AgentExecutionRequest {
  readonly executionId: string;
  readonly submissionId: string;
  readonly sessionId: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly agentRole: AgentRole;
  readonly project: ProjectReference | null;
  readonly instruction: string;
}

export interface AgentExecutionResult {
  readonly text: string;
}

export interface AgentExecutorDescriptor {
  readonly type: AgentExecutorType;
  readonly productionModelConnected: boolean;
}

export interface AgentExecutor {
  readonly descriptor: AgentExecutorDescriptor;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
}

export class LocalDevelopmentAgentExecutor implements AgentExecutor {
  public readonly descriptor = {
    type: 'local-development-executor',
    productionModelConnected: false,
  } as const;

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    await Promise.resolve();
    return {
      text: `Development executor received the instruction for ${request.project?.name ?? 'the current local session'}: ${request.instruction}`,
    };
  }
}

export interface OpenAIProductionExecutorConfig {
  readonly apiKey: string | undefined;
  readonly model: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

export class OpenAIProductionAgentExecutor implements AgentExecutor {
  private readonly apiKey: string | null;
  private readonly model: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private connected = false;

  public constructor(config: OpenAIProductionExecutorConfig) {
    this.apiKey = normalizeCredential(config.apiKey);
    this.model = normalizeModel(config.model);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.endpoint = config.endpoint ?? OPENAI_RESPONSES_URL;
    this.timeoutMs = normalizeTimeout(config.timeoutMs);
  }

  public get descriptor(): AgentExecutorDescriptor {
    return {
      type: 'production-provider-executor',
      productionModelConnected: this.connected,
    };
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.connected = false;
    validateExecutionRequest(request);
    if (this.apiKey === null || this.model === null) {
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Production model configuration is incomplete');
    }

    const body = JSON.stringify({
      model: this.model,
      instructions: providerInstructions(request),
      input: request.instruction,
      max_output_tokens: MAX_PROVIDER_OUTPUT_TOKENS,
      store: false,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.connected = false;
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Production model request failed', { cause: error });
    }

    if (!response.ok) {
      this.connected = false;
      await response.body?.cancel().catch(() => undefined);
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Production model request failed');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBoundedResponseText(response, MAX_PROVIDER_RESPONSE_BYTES)) as unknown;
    } catch (error) {
      this.connected = false;
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Production model returned an invalid response', { cause: error });
    }

    let text: string;
    try {
      text = extractOpenAIOutputText(parsed);
    } catch (error) {
      this.connected = false;
      throw error;
    }
    this.connected = true;
    return { text };
  }
}

export function createAgentExecutorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): AgentExecutor {
  const selection = environment[AGENT_EXECUTOR_ENV]?.trim() ?? '';
  if (selection === '' || selection === 'development') return new LocalDevelopmentAgentExecutor();
  if (selection === 'openai') {
    return new OpenAIProductionAgentExecutor({
      apiKey: environment[OPENAI_API_KEY_ENV],
      model: environment[OPENAI_MODEL_ENV],
      fetchImpl,
    });
  }
  throw new RuntimeError('INVALID_REQUEST', `${AGENT_EXECUTOR_ENV} must be development or openai`);
}

function validateExecutionRequest(request: AgentExecutionRequest): void {
  for (const [label, value] of [
    ['executionId', request.executionId],
    ['submissionId', request.submissionId],
    ['sessionId', request.sessionId],
    ['clientId', request.clientId],
    ['agentId', request.agentId],
  ] as const) {
    if (value.length === 0 || value.length > 200 || value.includes('\0')) {
      throw new RuntimeError('AGENT_EXECUTION_FAILED', `Production executor received invalid ${label}`);
    }
  }
  if (request.instruction.length === 0
    || request.instruction.length > MAX_PROVIDER_INSTRUCTION_CHARS
    || request.instruction !== request.instruction.trim()
    || request.instruction.includes('\0')) {
    throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Production executor received an invalid bounded instruction');
  }
}

function providerInstructions(request: AgentExecutionRequest): string {
  return `You are IRIS, a local user-directed agent. Agent role: ${request.agentRole}. Active project selected: ${request.project === null ? 'no' : 'yes'}. Respond only to the current user instruction. Do not assume access to local files, tools, secrets, other sessions, or repository contents.`;
}

function normalizeCredential(value: string | undefined): string | null {
  if (value === undefined || value.length === 0 || value !== value.trim() || value.length > 4_096 || value.includes('\0')) return null;
  return value;
}

function normalizeModel(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200 || normalized.includes('\0') || /\s/.test(normalized)) return null;
  return normalized;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PROVIDER_TIMEOUT_MS) {
    throw new RuntimeError('INVALID_REQUEST', 'Production provider timeout is invalid');
  }
  return value;
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) throw new Error('Provider response body is missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error('Provider response exceeded the bounded response size');
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function extractOpenAIOutputText(value: unknown): string {
  if (!isRecord(value)) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Production model returned an invalid response');
  if (value.status !== 'completed') {
    throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Production model did not complete the response');
  }
  if (!Array.isArray(value.output)) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Production model returned an invalid response');

  const chunks: string[] = [];
  for (const item of value.output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  const text = chunks.join('\n').trim();
  if (text.length === 0 || text.length > MAX_PROVIDER_OUTPUT_CHARS || text.includes('\0')) {
    throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Production model returned an invalid bounded result');
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
