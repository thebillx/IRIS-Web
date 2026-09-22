import { RuntimeError, type SecurityAuditComparison, type SecurityAuditRun, type SecurityCoverageTarget, type SecurityDecisionPackage, type SecurityFinding, type SecurityProofGateResult, type SecurityVerificationResult } from '@iris/domain';
import type { SecurityAuditDocument } from './model.js';

const MAX_RUNS = 256;
const MAX_TARGETS = 4096;
const MAX_FINDINGS = 8192;
const MAX_VERIFICATIONS = 8192;
const MAX_GATES = 8192;
const MAX_PACKAGES = 512;
const MAX_COMPARISONS = 512;
const MAX_LIST = 256;

export function validateSecurityAuditDocument(value: unknown): SecurityAuditDocument {
  if (!isRecord(value)
    || !exactKeys(value, ['schemaVersion','generation','runs','coverageTargets','findings','verifications','proofGateResults','decisionPackages','comparisons'])
    || value.schemaVersion !== 1
    || !nonNegativeInteger(value.generation)
    || !boundedArray(value.runs, MAX_RUNS)
    || !boundedArray(value.coverageTargets, MAX_TARGETS)
    || !boundedArray(value.findings, MAX_FINDINGS)
    || !boundedArray(value.verifications, MAX_VERIFICATIONS)
    || !boundedArray(value.proofGateResults, MAX_GATES)
    || !boundedArray(value.decisionPackages, MAX_PACKAGES)
    || !boundedArray(value.comparisons, MAX_COMPARISONS)) {
    fail('Security audit state is invalid');
  }

  const runs = value.runs as SecurityAuditRun[];
  const coverageTargets = value.coverageTargets as SecurityCoverageTarget[];
  const findings = value.findings as SecurityFinding[];
  const verifications = value.verifications as SecurityVerificationResult[];
  const proofGateResults = value.proofGateResults as SecurityProofGateResult[];
  const decisionPackages = value.decisionPackages as SecurityDecisionPackage[];
  const comparisons = value.comparisons as SecurityAuditComparison[];

  if (!runs.every(isRun)
    || !coverageTargets.every(isCoverageTarget)
    || !findings.every(isFinding)
    || !verifications.every(isVerification)
    || !proofGateResults.every(isProofGateResult)
    || !decisionPackages.every(isDecisionPackage)
    || !comparisons.every(isComparison)) {
    fail('Security audit record is invalid');
  }

  ensureUnique(runs.map((entry) => entry.id), 'run');
  ensureUnique(coverageTargets.map((entry) => entry.id), 'coverage target');
  ensureUnique(findings.map((entry) => entry.id), 'finding');
  ensureUnique(verifications.map((entry) => entry.id), 'verification');
  ensureUnique(proofGateResults.map((entry) => entry.id), 'proof gate result');
  ensureUnique(decisionPackages.map((entry) => entry.id), 'decision package');
  ensureUnique(comparisons.map((entry) => entry.id), 'comparison');

  const runById = new Map(runs.map((entry) => [entry.id, entry]));
  const targetById = new Map(coverageTargets.map((entry) => [entry.id, entry]));
  const findingById = new Map(findings.map((entry) => [entry.id, entry]));
  const verificationById = new Map(verifications.map((entry) => [entry.id, entry]));
  const gateById = new Map(proofGateResults.map((entry) => [entry.id, entry]));
  const packageById = new Map(decisionPackages.map((entry) => [entry.id, entry]));
  const comparisonById = new Map(comparisons.map((entry) => [entry.id, entry]));

  for (const run of runs) {
    assertExactMembership(run.coverageTargetIds, coverageTargets.filter((entry) => entry.auditRunId === run.id).map((entry) => entry.id), 'run coverage target');
    assertExactMembership(run.findingIds, findings.filter((entry) => entry.auditRunId === run.id).map((entry) => entry.id), 'run finding');
    assertExactMembership(run.verificationIds, verifications.filter((entry) => entry.auditRunId === run.id).map((entry) => entry.id), 'run verification');
    assertExactMembership(run.proofGateResultIds, proofGateResults.filter((entry) => entry.auditRunId === run.id).map((entry) => entry.id), 'run proof gate result');
    if (run.baselineRunId !== null && (run.baselineRunId === run.id || !runById.has(run.baselineRunId))) fail('Security audit baseline run reference is invalid');
    if (run.decisionPackageId !== null) {
      const pkg = packageById.get(run.decisionPackageId);
      if (pkg === undefined || pkg.auditRunId !== run.id) fail('Security audit decision package reference is invalid');
    }
    if (run.comparisonId !== null) {
      const comparison = comparisonById.get(run.comparisonId);
      if (comparison === undefined || comparison.auditRunId !== run.id) fail('Security audit comparison reference is invalid');
    }
  }

  for (const target of coverageTargets) {
    if (!runById.has(target.auditRunId)) fail('Security coverage target is not bound to a run');
  }
  for (const finding of findings) {
    const target = targetById.get(finding.coverageTargetId);
    if (!runById.has(finding.auditRunId) || target === undefined || target.auditRunId !== finding.auditRunId) fail('Security finding binding is invalid');
    for (const verificationId of finding.verificationIds) {
      const verification = verificationById.get(verificationId);
      if (verification === undefined || verification.findingId !== finding.id || verification.auditRunId !== finding.auditRunId) fail('Security finding verification index is invalid');
    }
    if (finding.proofGateResultId !== null) {
      const gate = gateById.get(finding.proofGateResultId);
      if (gate === undefined || gate.findingId !== finding.id || gate.auditRunId !== finding.auditRunId) fail('Security finding proof gate reference is invalid');
    }
  }
  for (const verification of verifications) {
    const finding = findingById.get(verification.findingId);
    if (finding === undefined || finding.auditRunId !== verification.auditRunId || verification.verifierWorkerId === finding.hunterWorkerId) fail('Security verification independence is invalid');
  }
  for (const gate of proofGateResults) {
    const finding = findingById.get(gate.findingId);
    if (finding === undefined || finding.auditRunId !== gate.auditRunId) fail('Security proof gate binding is invalid');
    if (gate.verificationId !== null) {
      const verification = verificationById.get(gate.verificationId);
      if (verification === undefined || verification.findingId !== finding.id) fail('Security proof gate verification reference is invalid');
    }
  }
  for (const pkg of decisionPackages) {
    const run = runById.get(pkg.auditRunId);
    if (run === undefined) fail('Security decision package run is missing');
    const all = [...pkg.verifiedFindingIds, ...pkg.rejectedFindingIds, ...pkg.needsMoreEvidenceFindingIds];
    if (!all.every((id) => findingById.get(id)?.auditRunId === run.id)) fail('Security decision package finding reference is invalid');
    if (!pkg.coverageGapTargetIds.every((id) => targetById.get(id)?.auditRunId === run.id)) fail('Security decision package coverage reference is invalid');
  }
  for (const comparison of comparisons) {
    const run = runById.get(comparison.auditRunId);
    const baseline = runById.get(comparison.baselineRunId);
    if (run === undefined || baseline === undefined || run.projectId !== baseline.projectId || run.id === baseline.id) fail('Security audit comparison binding is invalid');
  }

  return value as unknown as SecurityAuditDocument;
}

function isRun(value: unknown): value is SecurityAuditRun {
  return isRecord(value)
    && exactKeys(value, ['id','missionId','orchestrationRunId','projectId','sessionId','workspaceId','baselineRunId','state','coverageTargetIds','findingIds','verificationIds','proofGateResultIds','decisionPackageId','comparisonId','failureReason','createdAt','updatedAt','completedAt'])
    && uuid(value.id) && uuid(value.missionId) && uuid(value.orchestrationRunId) && uuid(value.projectId) && uuid(value.sessionId) && uuid(value.workspaceId)
    && (value.baselineRunId === null || uuid(value.baselineRunId))
    && ['HUNTING','VERIFYING','PROOFING','COMPLETED','FAILED','CANCELLED'].includes(String(value.state))
    && idList(value.coverageTargetIds) && idList(value.findingIds) && idList(value.verificationIds) && idList(value.proofGateResultIds)
    && (value.decisionPackageId === null || uuid(value.decisionPackageId))
    && (value.comparisonId === null || uuid(value.comparisonId))
    && (value.failureReason === null || bounded(value.failureReason, 2_000))
    && timestamp(value.createdAt) && timestamp(value.updatedAt)
    && (value.completedAt === null || timestamp(value.completedAt));
}

function isCoverageTarget(value: unknown): value is SecurityCoverageTarget {
  return isRecord(value)
    && exactKeys(value, ['id','auditRunId','key','title','scope','status','hunterWorkerId','hunterTaskId','hunterResultId','evidenceRefs','createdAt','updatedAt'])
    && uuid(value.id) && uuid(value.auditRunId)
    && bounded(value.key, 160) && bounded(value.title, 500) && bounded(value.scope, 2_000)
    && ['IN_PROGRESS','COVERED','GAP'].includes(String(value.status))
    && uuid(value.hunterWorkerId) && uuid(value.hunterTaskId)
    && (value.hunterResultId === null || uuid(value.hunterResultId))
    && evidenceList(value.evidenceRefs)
    && timestamp(value.createdAt) && timestamp(value.updatedAt);
}

function isFinding(value: unknown): value is SecurityFinding {
  return isRecord(value)
    && exactKeys(value, ['id','auditRunId','coverageTargetId','fingerprint','title','category','severity','location','summary','state','hunterWorkerId','hunterTaskId','hunterResultId','evidenceRefs','verificationIds','proofGateResultId','occurrences','firstSeenAt','lastSeenAt'])
    && uuid(value.id) && uuid(value.auditRunId) && uuid(value.coverageTargetId)
    && typeof value.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(value.fingerprint)
    && bounded(value.title, 500) && bounded(value.category, 200) && ['LOW','MEDIUM','HIGH','CRITICAL'].includes(String(value.severity))
    && bounded(value.location, 1_000) && bounded(value.summary, 4_000)
    && ['CANDIDATE','VERIFYING','VERIFIED','REJECTED','NEEDS_MORE_EVIDENCE'].includes(String(value.state))
    && uuid(value.hunterWorkerId) && uuid(value.hunterTaskId) && uuid(value.hunterResultId)
    && evidenceList(value.evidenceRefs) && idList(value.verificationIds)
    && (value.proofGateResultId === null || uuid(value.proofGateResultId))
    && positiveInteger(value.occurrences) && timestamp(value.firstSeenAt) && timestamp(value.lastSeenAt);
}

function isVerification(value: unknown): value is SecurityVerificationResult {
  return isRecord(value)
    && exactKeys(value, ['id','auditRunId','findingId','verifierWorkerId','verifierTaskId','verifierResultId','decision','rationale','evidenceRefs','createdAt'])
    && uuid(value.id) && uuid(value.auditRunId) && uuid(value.findingId) && uuid(value.verifierWorkerId) && uuid(value.verifierTaskId) && uuid(value.verifierResultId)
    && ['VERIFIED','REJECTED','NEEDS_MORE_EVIDENCE'].includes(String(value.decision))
    && bounded(value.rationale, 4_000) && evidenceList(value.evidenceRefs) && timestamp(value.createdAt);
}

function isProofGateResult(value: unknown): value is SecurityProofGateResult {
  return isRecord(value)
    && exactKeys(value, ['id','auditRunId','findingId','verificationId','decision','satisfiedRequirements','missingRequirements','evaluatedAt'])
    && uuid(value.id) && uuid(value.auditRunId) && uuid(value.findingId)
    && (value.verificationId === null || uuid(value.verificationId))
    && ['VERIFIED','REJECTED','NEEDS_MORE_EVIDENCE'].includes(String(value.decision))
    && stringList(value.satisfiedRequirements, 200) && stringList(value.missingRequirements, 200)
    && timestamp(value.evaluatedAt);
}

function isDecisionPackage(value: unknown): value is SecurityDecisionPackage {
  return isRecord(value)
    && exactKeys(value, ['id','auditRunId','verifiedFindingIds','rejectedFindingIds','needsMoreEvidenceFindingIds','coverageGapTargetIds','coverageTargetCount','findingCount','generatedAt'])
    && uuid(value.id) && uuid(value.auditRunId)
    && idList(value.verifiedFindingIds) && idList(value.rejectedFindingIds) && idList(value.needsMoreEvidenceFindingIds) && idList(value.coverageGapTargetIds)
    && nonNegativeInteger(value.coverageTargetCount) && nonNegativeInteger(value.findingCount) && timestamp(value.generatedAt);
}

function isComparison(value: unknown): value is SecurityAuditComparison {
  return isRecord(value)
    && exactKeys(value, ['id','auditRunId','baselineRunId','newVerifiedFingerprints','persistentVerifiedFingerprints','resolvedVerifiedFingerprints','generatedAt'])
    && uuid(value.id) && uuid(value.auditRunId) && uuid(value.baselineRunId)
    && fingerprintList(value.newVerifiedFingerprints) && fingerprintList(value.persistentVerifiedFingerprints) && fingerprintList(value.resolvedVerifiedFingerprints)
    && timestamp(value.generatedAt);
}

function evidenceList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_LIST && unique(value) && value.every(securityEvidenceRef);
}

function securityEvidenceRef(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_000 || value.includes('\0')) return false;
  const file = /^file:([^#]+)#L([1-9]\d*)-L([1-9]\d*)$/.exec(value);
  if (file !== null) {
    const candidate = file[1]!;
    const start = Number(file[2]);
    const end = Number(file[3]);
    const segments = candidate.split('/');
    return !candidate.startsWith('/') && !candidate.includes('\\')
      && !segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
      && Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start;
  }
  return /^artifact:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    || /^receipt:sha256:[0-9a-f]{64}$/.test(value);
}

function fingerprintList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_LIST && unique(value) && value.every((entry) => typeof entry === 'string' && /^[0-9a-f]{64}$/.test(entry));
}

function idList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_LIST && unique(value) && value.every(uuid);
}
function stringList(value: unknown, maxLength: number): boolean {
  return Array.isArray(value) && value.length <= MAX_LIST && unique(value) && value.every((entry) => bounded(entry, maxLength));
}
function boundedArray(value: unknown, max: number): value is unknown[] { return Array.isArray(value) && value.length <= max; }
function ensureUnique(values: readonly string[], label: string): void { if (!unique(values)) fail(`Duplicate security audit ${label} identity`); }
function assertExactMembership(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || [...actual].sort().join('\0') !== [...expected].sort().join('\0')) fail(`Security audit ${label} index is inconsistent`);
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((entry, index) => entry === wanted[index]);
}
function unique(values: readonly unknown[]): boolean { return new Set(values).size === values.length; }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function bounded(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !value.includes('\0'); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function fail(message: string): never { throw new RuntimeError('PERSISTENCE_FAILURE', message); }
