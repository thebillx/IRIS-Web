import type { AgentExecutorType, AgentRole, ProjectReference } from '@iris/domain';

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
