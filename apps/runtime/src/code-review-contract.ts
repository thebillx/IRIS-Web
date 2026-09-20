import { RuntimeError } from '@iris/domain';

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUIRED';
export type ReviewFindingSeverity = 'BLOCKING' | 'NON_BLOCKING';

export interface ReviewFinding {
  readonly severity: ReviewFindingSeverity;
  readonly rootCause: string;
  readonly evidence: string;
  readonly minimalRequiredChange: string;
}

export interface ReviewReport {
  readonly task: string;
  readonly scopeReviewed: string;
  readonly filesInspected: readonly string[];
  readonly validationReviewed: readonly string[];
  readonly findings: readonly ReviewFinding[];
  readonly regressionRisks: readonly string[];
  readonly decision: ReviewDecision;
  readonly recommendedLifecycleAction: string;
}

export interface NativeCodeReviewOutput {
  readonly schemaVersion: 1;
  readonly reviewDecision: ReviewDecision;
  readonly terminalReceipt: 'REVIEW_DECISION: APPROVED' | 'REVIEW_DECISION: CHANGES_REQUIRED';
  readonly reviewReport: ReviewReport;
  readonly workspaceSha256: string;
  readonly contextSha256: string;
  readonly reviewerProfileSha256: string;
  readonly repositoryIdentitySha256: string;
  readonly stderrObserved: boolean;
}

const REPORT_KEYS = [
  'decision','filesInspected','findings','recommendedLifecycleAction','regressionRisks',
  'scopeReviewed','task','validationReviewed',
] as const;
const FINDING_KEYS = ['evidence','minimalRequiredChange','rootCause','severity'] as const;
const OUTPUT_KEYS = [
  'contextSha256','repositoryIdentitySha256','reviewDecision','reviewReport','reviewerProfileSha256',
  'schemaVersion','stderrObserved','terminalReceipt','workspaceSha256',
] as const;

export function validateReviewReport(value: unknown): ReviewReport {
  if (!isRecord(value) || !hasExactKeys(value, REPORT_KEYS)) fail('Reviewer report shape is invalid');
  const decision = reviewDecision(value.decision);
  const task = boundedString(value.task, 'task', 240);
  const scopeReviewed = boundedString(value.scopeReviewed, 'scopeReviewed', 2_000);
  const filesInspected = boundedStringArray(value.filesInspected, 'filesInspected', 64, 1_000);
  const validationReviewed = boundedStringArray(value.validationReviewed, 'validationReviewed', 64, 1_000);
  const regressionRisks = boundedStringArray(value.regressionRisks, 'regressionRisks', 32, 1_000);
  const recommendedLifecycleAction = boundedString(value.recommendedLifecycleAction, 'recommendedLifecycleAction', 1_000);
  if (!Array.isArray(value.findings) || value.findings.length > 32) fail('Reviewer findings are invalid');
  const findings = value.findings.map((item, index) => validateFinding(item, index));
  const blocking = findings.filter((item) => item.severity === 'BLOCKING');
  if (decision === 'APPROVED' && blocking.length !== 0) fail('APPROVED review contains a blocking finding');
  if (decision === 'CHANGES_REQUIRED' && blocking.length === 0) fail('CHANGES_REQUIRED review has no blocking finding');
  return {
    task, scopeReviewed, filesInspected, validationReviewed, findings,
    regressionRisks, decision, recommendedLifecycleAction,
  };
}

export function parseNativeCodeReviewOutput(stdout: string): NativeCodeReviewOutput {
  const normalized = stdout.trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > 64 * 1024 || normalized.includes('\0')) {
    fail('Native code review returned an invalid bounded result');
  }
  let value: unknown;
  try { value = parseJsonRejectDuplicateKeys(normalized); }
  catch (error) { throw new RuntimeError('AGENT_EXECUTION_FAILED', 'Native code review did not return one unambiguous JSON result', { cause: error }); }
  if (!isRecord(value) || value.schemaVersion !== 1 || !hasExactKeys(value, OUTPUT_KEYS)) fail('Native code review result schema is invalid');
  const reviewDecisionValue = reviewDecision(value.reviewDecision);
  const terminalReceipt = `REVIEW_DECISION: ${reviewDecisionValue}` as NativeCodeReviewOutput['terminalReceipt'];
  if (value.terminalReceipt !== terminalReceipt) fail('Native code review terminal receipt does not match its decision');
  const reviewReport = validateReviewReport(value.reviewReport);
  if (reviewReport.decision !== reviewDecisionValue) fail('Native code review report does not match its terminal decision');
  const workspaceSha256 = sha256(value.workspaceSha256, 'workspaceSha256');
  const contextSha256 = sha256(value.contextSha256, 'contextSha256');
  const reviewerProfileSha256 = sha256(value.reviewerProfileSha256, 'reviewerProfileSha256');
  const repositoryIdentitySha256 = sha256(value.repositoryIdentitySha256, 'repositoryIdentitySha256');
  if (typeof value.stderrObserved !== 'boolean') fail('Native code review stderr marker is invalid');
  return {
    schemaVersion: 1,
    reviewDecision: reviewDecisionValue,
    terminalReceipt,
    reviewReport,
    workspaceSha256,
    contextSha256,
    reviewerProfileSha256,
    repositoryIdentitySha256,
    stderrObserved: value.stderrObserved,
  };
}

export function parseJsonRejectDuplicateKeys(text: string): unknown {
  scanJsonForDuplicateKeys(text);
  return JSON.parse(text) as unknown;
}

function scanJsonForDuplicateKeys(text: string): void {
  let index = 0;
  const whitespace = (): void => { while (index < text.length && /\s/.test(text[index]!)) index += 1; };
  const parseStringToken = (): string => {
    const start = index;
    if (text[index] !== '"') throw new Error('Invalid JSON string');
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const ch = text[index]!;
      index += 1;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') return text.slice(start, index);
    }
    throw new Error('Unterminated JSON string');
  };
  const value = (): void => {
    whitespace();
    const ch = text[index];
    if (ch === '{') {
      index += 1; whitespace();
      const keys = new Set<string>();
      if (text[index] === '}') { index += 1; return; }
      while (index < text.length) {
        whitespace();
        const keyToken = parseStringToken();
        let key: string;
        try { key = JSON.parse(keyToken) as string; } catch { throw new Error('Invalid JSON object key'); }
        if (keys.has(key)) throw new Error(`Duplicate JSON object key: ${key}`);
        keys.add(key);
        whitespace();
        if (text[index] !== ':') throw new Error('Invalid JSON object separator');
        index += 1;
        value();
        whitespace();
        if (text[index] === '}') { index += 1; return; }
        if (text[index] !== ',') throw new Error('Invalid JSON object delimiter');
        index += 1;
      }
      throw new Error('Unterminated JSON object');
    }
    if (ch === '[') {
      index += 1; whitespace();
      if (text[index] === ']') { index += 1; return; }
      while (index < text.length) {
        value(); whitespace();
        if (text[index] === ']') { index += 1; return; }
        if (text[index] !== ',') throw new Error('Invalid JSON array delimiter');
        index += 1;
      }
      throw new Error('Unterminated JSON array');
    }
    if (ch === '"') { parseStringToken(); return; }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(index));
    if (match === null) throw new Error('Invalid JSON value');
    index += match[0].length;
  };
  value();
  whitespace();
  if (index !== text.length) throw new Error('Trailing JSON data');
}

function validateFinding(value: unknown, index: number): ReviewFinding {
  if (!isRecord(value) || !hasExactKeys(value, FINDING_KEYS)) fail(`Reviewer finding ${index} shape is invalid`);
  if (value.severity !== 'BLOCKING' && value.severity !== 'NON_BLOCKING') fail(`Reviewer finding ${index} severity is invalid`);
  return {
    severity: value.severity,
    rootCause: boundedString(value.rootCause, `findings[${index}].rootCause`, 500),
    evidence: boundedString(value.evidence, `findings[${index}].evidence`, 2_000),
    minimalRequiredChange: boundedString(value.minimalRequiredChange, `findings[${index}].minimalRequiredChange`, 1_000),
  };
}

function reviewDecision(value: unknown): ReviewDecision {
  if (value !== 'APPROVED' && value !== 'CHANGES_REQUIRED') fail('Reviewer decision is invalid');
  return value;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) fail(`${label} is invalid`);
  return value;
}

function boundedStringArray(value: unknown, label: string, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) fail(`${label} is invalid`);
  return value.map((item, index) => boundedString(item, `${label}[${index}]`, maxItemLength));
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(`Native code review ${label} is invalid`);
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function fail(message: string): never {
  throw new RuntimeError('AGENT_EXECUTION_FAILED', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
