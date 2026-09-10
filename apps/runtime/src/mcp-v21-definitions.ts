import { orderToolDefinitions } from './mcp-catalog.js';

export const V21_LIFECYCLE_TOOL_NAMES = new Set([
  'mission_start',
  'mission_checkpoint',
  'mission_resume',
  'mission_rebind',
  'mission_cancel',
  'mission_evidence',
  'mission_complete',
]);

export function augmentV21ToolDefinitions(tools: readonly unknown[]): readonly unknown[] {
  const augmented = tools.map(augmentExistingDefinition);
  for (const definition of lifecycleToolDefinitions()) {
    if (!augmented.some((candidate) => isRecord(candidate) && candidate.name === definition.name)) augmented.push(definition);
  }
  return orderToolDefinitions('FULL', augmented);
}

function augmentExistingDefinition(candidate: unknown): unknown {
  if (!isRecord(candidate) || typeof candidate.name !== 'string') return candidate;
  if (candidate.name === 'mission_create' && isRecord(candidate.inputSchema)) {
    const properties = isRecord(candidate.inputSchema.properties) ? candidate.inputSchema.properties : {};
    return {
      ...candidate,
      description: 'Create one durable project-bound mission. V2.1 persists lifecycle identity immediately; goal is optional and orchestrator compatibility is preserved.',
      inputSchema: {
        ...candidate.inputSchema,
        properties: { ...properties, goal: { type: 'string', minLength: 1, maxLength: 4000 } },
      },
    };
  }
  if (candidate.name === 'mission_directive' && isRecord(candidate.inputSchema)) {
    return {
      ...candidate,
      description: 'Submit either the legacy V2.0 supervisor directive or a V2.1 revision-bound lifecycle directive. Neither form grants local execution permission.',
      inputSchema: { oneOf: [candidate.inputSchema, lifecycleDirectiveSchema()] },
    };
  }
  return candidate;
}

function lifecycleToolDefinitions(): Record<string, unknown>[] {
  const sessionId = { sessionId: { type: 'string', description: 'IRIS runtime session UUID returned by session_open.' } };
  const mission = { ...sessionId, missionId: { type: 'string', description: 'Stable durable mission UUID.' } };
  const revision = { expectedRevision: { type: 'integer', minimum: 1 } };
  const request = { requestId: { type: 'string', description: 'Unique idempotency UUID for this worker operation.' } };
  const annotations = { readOnlyHint: false, destructiveHint: false };
  return [
    {
      name: 'mission_start',
      description: 'Start a V2.1 durable mission through a registered WorkerAdapter after IRIS persists operation intent.',
      inputSchema: { type: 'object', required: ['missionId','expectedRevision','requestId','workerType'], properties: { ...mission, ...revision, ...request, workerType: { type: 'string', maxLength: 200 } }, additionalProperties: false },
      annotations,
    },
    {
      name: 'mission_checkpoint',
      description: 'Persist a durable worker checkpoint before returning success and enter WAITING_FOR_SUPERVISOR.',
      inputSchema: { type: 'object', required: ['missionId','expectedRevision','checkpointId','summary','evidenceRefs'], properties: { ...mission, ...revision, checkpointId: { type: 'string' }, summary: { type: 'string', maxLength: 2000 }, evidenceRefs: { type: 'array', items: { type: 'string' }, maxItems: 24 } }, additionalProperties: false },
      annotations,
    },
    {
      name: 'mission_resume',
      description: 'Resume the same mission from its latest durable checkpoint and accepted directive without replaying duplicate requestId calls.',
      inputSchema: { type: 'object', required: ['missionId','expectedRevision','requestId'], properties: { ...mission, ...revision, ...request }, additionalProperties: false },
      annotations,
    },
    {
      name: 'mission_rebind',
      description: 'Rebind a durable mission to this newly authenticated owner session using a compare-and-swap binding revision. The mission and project identity remain unchanged.',
      inputSchema: {
        type: 'object', required: ['missionId', 'projectId', 'expectedBindingRevision'],
        properties: {
          ...sessionId,
          missionId: { type: 'string', description: 'Stable durable mission UUID.' },
          projectId: { type: 'string', description: 'Must equal the mission’s already-bound registered project UUID.' },
          expectedBindingRevision: { type: 'integer', minimum: 1 },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'mission_cancel',
      description: 'Cancel a V2.1 mission through its bound worker adapter without widening IRIS capability authority.',
      inputSchema: { type: 'object', required: ['missionId','expectedRevision','requestId'], properties: { ...mission, ...revision, ...request }, additionalProperties: false },
      annotations,
    },
    {
      name: 'mission_complete',
      description: 'Record terminal V2.1 mission completion with revision and idempotency checks.',
      inputSchema: { type: 'object', required: ['missionId','expectedRevision','requestId'], properties: { ...mission, ...revision, ...request }, additionalProperties: false },
      annotations,
    },
    {
      name: 'mission_evidence',
      description: 'Append bounded durable evidence. Evidence is observational and never authorizes execution.',
      inputSchema: {
        type: 'object', required: ['missionId','expectedRevision','evidence'], additionalProperties: false,
        properties: {
          ...mission, ...revision,
          evidence: {
            type: 'object', required: ['id','kind','label','summary','reference','data'], additionalProperties: false,
            properties: {
              id: { type: 'string' }, kind: { enum: ['CAPABILITY_RESULT','AUDIT','ARTIFACT','OBSERVATION'] },
              label: { type: 'string', maxLength: 120 }, summary: { type: 'string', maxLength: 500 },
              reference: { type: ['string','null'], maxLength: 2048 }, data: { type: 'object' },
            },
          },
        },
      },
      annotations,
    },
  ];
}

function lifecycleDirectiveSchema(): Record<string, unknown> {
  return {
    type: 'object', required: ['missionId','basedOnRevision','directiveId','directive'], additionalProperties: false,
    properties: {
      sessionId: { type: 'string' }, missionId: { type: 'string' }, basedOnRevision: { type: 'integer', minimum: 1 },
      directiveId: { type: 'string' }, directive: { type: 'string', minLength: 1, maxLength: 4000 },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
