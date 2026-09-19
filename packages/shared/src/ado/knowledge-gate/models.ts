export const primaryStatuses = ['PROMOTED', 'CONTEXT_ONLY', 'SUPPORTING_EVIDENCE', 'REJECTED'] as const;
export type PrimaryStatus = typeof primaryStatuses[number];

export const knowledgeCategories = [
  'BUSINESS_RULE', 'FUNCTIONAL_BEHAVIOR', 'UX_BEHAVIOR', 'USER_FLOW', 'VALIDATION',
  'ERROR_HANDLING', 'INTEGRATION', 'KNOWN_LIMITATION', 'PRODUCT_CONFIGURATION', 'RELEASE_CHANGE',
] as const;
export type KnowledgeCategory = typeof knowledgeCategories[number];
export const nonKnowledgeCategories = [
  'PROJECT_ADMIN', 'QA_EXECUTION', 'TEST_DATA', 'AUTOMATION_ONLY', 'DEPLOYMENT',
  'HOUSEKEEPING', 'PLACEHOLDER', 'SUPPORT_ONLY',
] as const;
export type NonKnowledgeCategory = typeof nonKnowledgeCategories[number];
export type SourceReference = Readonly<{ source: string; id: string; revision: string }>;
export type RecordKind = 'WORK_ITEM' | 'TEST_RESULT' | 'CLARIFICATION' | 'LINK' | 'IMPLEMENTATION_NOTE';
export type SourceRecord = Readonly<{
  reference: SourceReference;
  workItemType: string;
  kind: RecordKind;
  title: string;
  description: string;
  acceptanceCriteria: string;
  children: readonly Readonly<{ reference: SourceReference; substantive: boolean }>[];
}>;
export type SemanticEvidence = Readonly<{
  verdict: 'VALIDATED' | 'NOT_KNOWLEDGE' | 'AMBIGUOUS';
  reusable: boolean;
  category: KnowledgeCategory | NonKnowledgeCategory;
  quotes: readonly Readonly<{ field: 'title' | 'description' | 'acceptanceCriteria'; text: string }>[];
}>;
export interface SemanticClassifier {
  classify(record: SourceRecord): SemanticEvidence;
}
export type TypeRule = Readonly<{
  defaultStatus: 'REJECTED' | 'CONTEXT_ONLY' | 'SUPPORTING_EVIDENCE';
  allowSemanticPromotion: boolean;
  container: boolean;
}>;
export type GatePolicy = Readonly<{ version: string; types: Readonly<Record<string, TypeRule>> }>;
export type Signal = Readonly<{ code: string; weight: number; evidence: string }>;
export type Classification = Readonly<{
  status: PrimaryStatus;
  reasonCodes: readonly string[];
  signals: readonly Signal[];
  score: number;
  policyVersion: string;
  category: KnowledgeCategory | NonKnowledgeCategory | null;
  semanticEvidence: SemanticEvidence | null;
  sourceReferences: readonly SourceReference[];
}>;
