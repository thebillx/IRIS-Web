import type {
  SecurityAuditComparison,
  SecurityAuditRun,
  SecurityCoverageTarget,
  SecurityDecisionPackage,
  SecurityFinding,
  SecurityProofGateResult,
  SecurityVerificationResult,
} from '@iris/domain';

export interface SecurityAuditDocument {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly runs: readonly SecurityAuditRun[];
  readonly coverageTargets: readonly SecurityCoverageTarget[];
  readonly findings: readonly SecurityFinding[];
  readonly verifications: readonly SecurityVerificationResult[];
  readonly proofGateResults: readonly SecurityProofGateResult[];
  readonly decisionPackages: readonly SecurityDecisionPackage[];
  readonly comparisons: readonly SecurityAuditComparison[];
}

export function emptySecurityAuditDocument(): SecurityAuditDocument {
  return {
    schemaVersion: 1,
    generation: 0,
    runs: [],
    coverageTargets: [],
    findings: [],
    verifications: [],
    proofGateResults: [],
    decisionPackages: [],
    comparisons: [],
  };
}
