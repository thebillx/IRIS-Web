import { RuntimeError, type SecurityFindingSeverity, type SecurityVerificationDecision } from '@iris/domain';
import { resolveDirectSessionIdentity } from './mcp-direct-context.js';
import type { McpPrincipal } from './mcp.js';
import type { RuntimeState } from './state.js';
import type { SecurityAuditService, SecurityCoverageTargetInput, SecurityFindingCandidateInput } from './security-audit/service.js';

const OPERATIONS = ['list_runs','get_run','create_run','hunter_report','verifier_report','proof_gate','finalize','compare_runs','cancel_run'] as const;
export function isSecurityAuditTool(name: string): boolean { return name === 'security_audit'; }

export function securityAuditToolDefinitions(): readonly Record<string, unknown>[] {
  return [{
    name: 'security_audit',
    description: 'Run the governed on-demand Security Audit Engine: coverage planning, read-only Hunter reports, independent Verifier reports, Proof Gate, decision packages, rerun comparison, and cancellation. Proof Gate verifies evidence; it is not a permission approval.',
    inputSchema: {
      type: 'object',
      required: ['operation','projectId'],
      properties: {
        operation: { enum: OPERATIONS },
        sessionId: { type: 'string', description: 'Optional explicit IRIS session. Authenticated tunnel connectors may omit it and use project-bound direct context.' },
        projectId: { type: 'string' },
        workspaceId: { type: 'string' },
        missionId: { type: 'string' },
        auditRunId: { type: 'string' },
        baselineRunId: { type: 'string' },
        coverageTargets: {
          type: 'array', minItems: 1, maxItems: 64,
          items: {
            type: 'object', required: ['key','title','scope'], additionalProperties: false,
            properties: {
              key: { type: 'string', minLength: 1, maxLength: 160 },
              title: { type: 'string', minLength: 1, maxLength: 500 },
              scope: { type: 'string', minLength: 1, maxLength: 2000 },
            },
          },
        },
        coverageTargetId: { type: 'string' },
        coverageStatus: { enum: ['COVERED','GAP'] },
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        evidenceRefs: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 2000 } },
        filesRead: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 2000 } },
        findings: {
          type: 'array', maxItems: 64,
          items: {
            type: 'object', required: ['title','category','severity','location','summary','evidenceRefs'], additionalProperties: false,
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 500 },
              category: { type: 'string', minLength: 1, maxLength: 200 },
              severity: { enum: ['LOW','MEDIUM','HIGH','CRITICAL'] },
              location: { type: 'string', minLength: 1, maxLength: 1000 },
              summary: { type: 'string', minLength: 1, maxLength: 4000 },
              evidenceRefs: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 2000 } },
            },
          },
        },
        findingId: { type: 'string' },
        decision: { enum: ['VERIFIED','REJECTED','NEEDS_MORE_EVIDENCE'] },
        rationale: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      additionalProperties: false,
    },
  }];
}

export async function executeSecurityAuditTool(
  args: Record<string, unknown>,
  request: Request,
  state: RuntimeState,
  service: SecurityAuditService,
  principal: McpPrincipal = 'owner',
): Promise<unknown> {
  assertOnlyKeys(args);
  const projectId = requiredString(args, 'projectId', 200);
  const identity = await resolveDirectSessionIdentity(args, request, state, projectId, principal);
  const operation = requiredEnum(args, 'operation', OPERATIONS);
  const common = { clientId: identity.clientId, sessionId: identity.sessionId, projectId };

  if (operation === 'list_runs') return { runs: await service.listRuns(projectId) };
  if (operation === 'get_run') {
    const view = await service.getRun(requiredString(args, 'auditRunId', 200));
    await assertReadableRun(state, identity.clientId, identity.sessionId, projectId, view.run.missionId, view.run.projectId);
    return view;
  }
  if (operation === 'create_run') {
    return service.createRun({
      ...common,
      workspaceId: requiredString(args, 'workspaceId', 200),
      missionId: requiredString(args, 'missionId', 200),
      ...(optionalString(args, 'baselineRunId', 200) === undefined ? {} : { baselineRunId: optionalString(args, 'baselineRunId', 200)! }),
      coverageTargets: coverageTargets(args.coverageTargets),
    });
  }
  const auditRunId = requiredString(args, 'auditRunId', 200);
  if (operation === 'hunter_report') {
    return service.recordHunterReport({
      ...common,
      auditRunId,
      coverageTargetId: requiredString(args, 'coverageTargetId', 200),
      coverageStatus: requiredEnum(args, 'coverageStatus', ['COVERED','GAP'] as const),
      summary: requiredString(args, 'summary', 4000),
      evidenceRefs: stringArray(args.evidenceRefs, 'evidenceRefs', 128, 2000),
      filesRead: stringArray(args.filesRead, 'filesRead', 128, 2000),
      findings: findingCandidates(args.findings),
    });
  }
  if (operation === 'verifier_report') {
    return service.recordVerifierReport({
      ...common,
      auditRunId,
      findingId: requiredString(args, 'findingId', 200),
      decision: requiredEnum(args, 'decision', ['VERIFIED','REJECTED','NEEDS_MORE_EVIDENCE'] as const) as SecurityVerificationDecision,
      rationale: requiredString(args, 'rationale', 4000),
      evidenceRefs: stringArray(args.evidenceRefs, 'evidenceRefs', 128, 2000),
      filesRead: stringArray(args.filesRead, 'filesRead', 128, 2000),
    });
  }
  if (operation === 'proof_gate') return service.evaluateProofGate({ ...common, auditRunId, findingId: requiredString(args, 'findingId', 200) });
  if (operation === 'finalize') return service.finalizeRun({ ...common, auditRunId });
  if (operation === 'compare_runs') return service.compareRun({ ...common, auditRunId, baselineRunId: requiredString(args, 'baselineRunId', 200) });
  return service.cancelRun({ ...common, auditRunId });
}

async function assertReadableRun(
  state: RuntimeState,
  clientId: string,
  sessionId: string,
  projectId: string,
  missionId: string,
  runProjectId: string,
): Promise<void> {
  if (runProjectId !== projectId) throw new RuntimeError('CAPABILITY_DENIED', 'Security audit run does not belong to the selected project');
  const mission = await state.getMission(missionId);
  if (mission.clientId !== clientId || mission.sessionId !== sessionId || mission.projectId !== projectId) {
    throw new RuntimeError('CONTROL_DENIED', 'Security audit run is not bound to the calling mission session');
  }
}

function coverageTargets(value: unknown): SecurityCoverageTargetInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new RuntimeError('INVALID_REQUEST', 'coverageTargets is invalid');
  return value.map((item, index) => {
    if (!isRecord(item) || !exactKeys(item, ['key','title','scope'])) throw new RuntimeError('INVALID_REQUEST', `coverageTargets[${index}] is invalid`);
    return {
      key: requiredString(item, 'key', 160),
      title: requiredString(item, 'title', 500),
      scope: requiredString(item, 'scope', 2000),
    };
  });
}

function findingCandidates(value: unknown): SecurityFindingCandidateInput[] {
  if (!Array.isArray(value) || value.length > 64) throw new RuntimeError('INVALID_REQUEST', 'findings is invalid');
  return value.map((item, index) => {
    if (!isRecord(item) || !exactKeys(item, ['title','category','severity','location','summary','evidenceRefs'])) throw new RuntimeError('INVALID_REQUEST', `findings[${index}] is invalid`);
    return {
      title: requiredString(item, 'title', 500),
      category: requiredString(item, 'category', 200),
      severity: requiredEnum(item, 'severity', ['LOW','MEDIUM','HIGH','CRITICAL'] as const) as SecurityFindingSeverity,
      location: requiredString(item, 'location', 1000),
      summary: requiredString(item, 'summary', 4000),
      evidenceRefs: stringArray(item.evidenceRefs, 'evidenceRefs', 128, 2000),
    };
  });
}

function assertOnlyKeys(args: Record<string, unknown>): void {
  const allowed = new Set(['operation','sessionId','projectId','workspaceId','missionId','auditRunId','baselineRunId','coverageTargets','coverageTargetId','coverageStatus','summary','evidenceRefs','filesRead','findings','findingId','decision','rationale']);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new RuntimeError('INVALID_REQUEST', `Unsupported security_audit field: ${key}`);
}
function requiredString(record: Record<string, unknown>, name: string, maxLength: number): string {
  const value = record[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) throw new RuntimeError('INVALID_REQUEST', `${name} must be a bounded non-empty string`);
  return value;
}
function optionalString(record: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  if (record[name] === undefined) return undefined;
  return requiredString(record, name, maxLength);
}
function requiredEnum<const T extends readonly string[]>(record: Record<string, unknown>, name: string, allowed: T): T[number] {
  const value = record[name];
  if (typeof value === 'string' && allowed.some((candidate) => candidate === value)) return value as T[number];
  throw new RuntimeError('INVALID_REQUEST', `${name} is not supported`);
}
function stringArray(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= maxLength && !item.includes('\0'))) {
    throw new RuntimeError('INVALID_REQUEST', `${name} must be a bounded string array`);
  }
  if (new Set(value).size !== value.length) throw new RuntimeError('INVALID_REQUEST', `${name} must not contain duplicates`);
  return value as string[];
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((entry, index) => entry === wanted[index]);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
