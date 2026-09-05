import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RuntimeError, type MissionBrokerSnapshot, type SupervisorDirective } from '@iris/domain';

const execFileAsync = promisify(execFile);
const DEFAULT_HERMES_BIN = '/Users/bill/.local/bin/hermes';
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface HermesCheckpointReceipt {
  readonly currentPhase: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly blockers: readonly string[];
  readonly hermesAssessment: string;
  readonly proposedNextAction: string;
  readonly decisionRequired: boolean;
  readonly missionComplete: boolean;
}

export interface HermesCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HermesCommandRunner {
  run(args: readonly string[], cwd: string): Promise<HermesCommandResult>;
}

export class HermesCliRunner implements HermesCommandRunner {
  public constructor(private readonly binary = process.env.IRIS_HERMES_BIN?.trim() || DEFAULT_HERMES_BIN) {}

  public async run(args: readonly string[], cwd: string): Promise<HermesCommandResult> {
    try {
      const result = await execFileAsync(this.binary, [...args], {
        cwd,
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: process.env,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const candidate = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
      return {
        exitCode: typeof candidate.code === 'number' ? candidate.code : 1,
        stdout: typeof candidate.stdout === 'string' ? candidate.stdout : '',
        stderr: typeof candidate.stderr === 'string' ? candidate.stderr : '',
      };
    }
  }
}

export class HermesSessionResumeAdapter {
  public constructor(
    private readonly runner: HermesCommandRunner = new HermesCliRunner(),
    private readonly toolsetSelector = 'iris_v2_bridge_proof',
  ) {}

  public async resumeExact(mapping: MissionBrokerSnapshot, directive: SupervisorDirective): Promise<HermesCheckpointReceipt> {
    if (mapping.state === 'COMPLETED') throw new RuntimeError('INVALID_REQUEST', 'Completed mission cannot be resumed');
    if (directive.missionId !== mapping.missionId || directive.directiveId !== mapping.lastDirectiveId) {
      throw new RuntimeError('INVALID_REQUEST', 'Hermes resume requires the latest accepted directive for this mission');
    }
    return this.runExact(mapping, resumePrompt(mapping, directive), 8);
  }

  public async repairCheckpointReceipt(mapping: MissionBrokerSnapshot, evidenceSummary: string): Promise<HermesCheckpointReceipt> {
    if (mapping.state === 'COMPLETED') throw new RuntimeError('INVALID_REQUEST', 'Completed mission cannot be resumed');
    const evidence = boundedString(evidenceSummary, 'repairEvidence', 2000);
    return this.runExact(mapping, repairPrompt(mapping, evidence), 2);
  }

  private async runExact(mapping: MissionBrokerSnapshot, prompt: string, maxTurns: number): Promise<HermesCheckpointReceipt> {
    const args = [
      'chat', '-Q', '--resume', mapping.hermesSessionId, '--in', mapping.worktreePath,
      '--source', 'tool', '--max-turns', String(maxTurns), '--pass-session-id', '-t', this.toolsetSelector, '-q', prompt,
    ] as const;
    if (args.includes('latest')) throw new RuntimeError('INVALID_REQUEST', 'Global latest Hermes resume is forbidden for mission-bound execution');
    const result = await this.runner.run(args, mapping.worktreePath);
    if (result.exitCode !== 0) {
      if (result.stderr.includes(`Session not found: ${mapping.hermesSessionId}`)) {
        throw new RuntimeError('MISSION_NOT_FOUND', 'Bound Hermes session does not exist');
      }
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Hermes exact-session resume failed');
    }
    if (!result.stderr.includes(`Resumed session ${mapping.hermesSessionId}`)
      || !result.stderr.includes(`session_id: ${mapping.hermesSessionId}`)) {
      throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Hermes did not confirm the exact bound session identity');
    }
    return parseCheckpointReceipt(result.stdout);
  }
}

function resumePrompt(mapping: MissionBrokerSnapshot, directive: SupervisorDirective): string {
  const directivePayload = {
    missionId: mapping.missionId,
    missionVersion: mapping.missionVersion,
    directiveId: directive.directiveId,
    directiveSequence: directive.directiveSequence,
    decision: directive.decision,
    instruction: directive.instruction,
    authorizedScope: directive.authorizedScope,
    doNot: directive.doNot,
    successCriteria: directive.successCriteria,
  };
  return [
    'You are resuming the exact Hermes Loop Engineer session bound to one IRIS mission.',
    'IRIS remains execution authority. The supervisor directive is orchestration input only and grants no local permission.',
    `Directive JSON: ${JSON.stringify(directivePayload)}`,
    'For this proof, use the configured read-only MCP tool project_git_status when the directive asks for project Git status.',
    'Do not run git or shell directly. Do not mutate files. Do not create a new session.',
    'Return ONLY one JSON object with keys currentPhase, summary, evidenceRefs, blockers, hermesAssessment, proposedNextAction, decisionRequired, missionComplete.',
    'The receipt MUST match this JSON shape exactly: {"currentPhase":"...","summary":"...","evidenceRefs":[],"blockers":[],"hermesAssessment":"...","proposedNextAction":"...","decisionRequired":true,"missionComplete":false}.',
    'decisionRequired and missionComplete MUST be JSON booleans true or false, never strings or descriptive text.',
    'evidenceRefs must be short references, not raw logs. missionComplete must be true only when the accepted directive decision is COMPLETE and the mission is finished.',
  ].join('\n');
}

function repairPrompt(mapping: MissionBrokerSnapshot, evidenceSummary: string): string {
  return [
    'You are repairing only the structured supervisor checkpoint receipt for the exact already-bound IRIS mission.',
    `Mission ID: ${mapping.missionId}`,
    `Mission version: ${mapping.missionVersion}`,
    `Preserved bounded evidence: ${evidenceSummary}`,
    'Do NOT call tools. Do NOT delegate. Do NOT repeat any project work. Use only the prior session context plus the preserved evidence above.',
    'Return ONLY one JSON object with keys currentPhase, summary, evidenceRefs, blockers, hermesAssessment, proposedNextAction, decisionRequired, missionComplete.',
    'The receipt MUST match this JSON shape exactly: {"currentPhase":"...","summary":"...","evidenceRefs":[],"blockers":[],"hermesAssessment":"...","proposedNextAction":"...","decisionRequired":true,"missionComplete":false}.',
    'decisionRequired and missionComplete MUST be JSON booleans true or false, never strings or descriptive text.',
    'This is a checkpoint repair turn, so missionComplete must remain false unless a COMPLETE supervisor directive was already accepted.',
  ].join('\n');
}

function parseCheckpointReceipt(stdout: string): HermesCheckpointReceipt {
  if (stdout.length > MAX_OUTPUT_BYTES) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Hermes completion output exceeded the proof bound');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(stdout)?.[1];
  const candidate = fenced ?? stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1);
  if (candidate.length === 0) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Hermes did not return a structured checkpoint receipt');
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); } catch (error) {
    throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Hermes checkpoint receipt was not valid JSON', { cause: error });
  }
  if (!isRecord(parsed)) throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Hermes checkpoint receipt must be an object');
  return {
    currentPhase: boundedString(parsed.currentPhase, 'currentPhase', 240),
    summary: boundedString(parsed.summary, 'summary', 2000),
    evidenceRefs: boundedStringList(parsed.evidenceRefs, 'evidenceRefs'),
    blockers: boundedStringList(parsed.blockers, 'blockers'),
    hermesAssessment: boundedString(parsed.hermesAssessment, 'hermesAssessment', 2000),
    proposedNextAction: boundedString(parsed.proposedNextAction, 'proposedNextAction', 1000),
    decisionRequired: booleanValue(parsed.decisionRequired, 'decisionRequired'),
    missionComplete: booleanValue(parsed.missionComplete, 'missionComplete'),
  };
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) {
    throw new RuntimeError('AGENT_EXECUTION_FAILED', `Hermes checkpoint ${name} is invalid`);
  }
  return value.trim();
}

function boundedStringList(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 24) throw new RuntimeError('AGENT_EXECUTION_FAILED', `Hermes checkpoint ${name} is invalid`);
  return value.map((item, index) => boundedString(item, `${name}[${index}]`, 1000));
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new RuntimeError('AGENT_EXECUTION_FAILED', `Hermes checkpoint ${name} must be boolean`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
