import {
  knowledgeCategories, nonKnowledgeCategories,
  type Classification, type GatePolicy, type NonKnowledgeCategory, type PrimaryStatus,
  type SemanticClassifier, type SemanticEvidence, type Signal, type SourceRecord, type TypeRule,
} from './models.js';

const requirement: TypeRule = Object.freeze({ defaultStatus: 'REJECTED', allowSemanticPromotion: true, container: false });
const container: TypeRule = Object.freeze({ defaultStatus: 'CONTEXT_ONLY', allowSemanticPromotion: true, container: true });
const supporting: TypeRule = Object.freeze({ defaultStatus: 'SUPPORTING_EVIDENCE', allowSemanticPromotion: false, container: false });
export const defaultPolicy: GatePolicy = Object.freeze({
  version: 'ado-knowledge-gate/v1',
  types: Object.freeze({ task: requirement, 'user story': requirement, feature: container, epic: container,
    initiative: container, bug: supporting, 'test case': supporting }),
});

const noiseRules: readonly Readonly<{ code: string; category: NonKnowledgeCategory; pattern: RegExp }>[] = [
  { code: 'ADMIN_ONLY', category: 'PROJECT_ADMIN', pattern: /^(?:update (?:the )?(?:timesheet|sprint board)|schedule (?:a )?meeting|assign (?:the )?tickets?)[.!\s]*$/i },
  { code: 'EXECUTION_ONLY', category: 'QA_EXECUTION', pattern: /^(?:execute|run) (?:the )?(?:manual )?tests?(?: suite)?[.!\s]*$/i },
  { code: 'RETEST_ONLY', category: 'QA_EXECUTION', pattern: /^(?:retest|re-test)(?: (?:the )?(?:fix|build|release|ticket))?[.!\s]*$/i },
  { code: 'TEST_DATA_ONLY', category: 'TEST_DATA', pattern: /^(?:prepare|seed|create|refresh) (?:the )?(?:test|qa) data[.!\s]*$/i },
  { code: 'DEPLOYMENT_ONLY', category: 'DEPLOYMENT', pattern: /^(?:deploy|rebuild|build) (?:the )?(?:application|build|release)(?: to (?:staging|production))?[.!\s]*$/i },
  { code: 'AUTOMATION_ONLY', category: 'AUTOMATION_ONLY', pattern: /^(?:maintain|repair|update) (?:the )?(?:test automation|automation scripts?|ci pipeline)[.!\s]*$/i },
  { code: 'HOUSEKEEPING_ONLY', category: 'HOUSEKEEPING', pattern: /^(?:clean|remove|archive) (?:the )?(?:old )?(?:build artifacts|logs|temporary files)[.!\s]*$/i },
  { code: 'COORDINATION_ONLY', category: 'PROJECT_ADMIN', pattern: /^(?:coordinate|arrange) (?:the )?(?:handoff|meeting|team sync)[.!\s]*$/i },
  { code: 'SUPPORT_ONLY', category: 'SUPPORT_ONLY', pattern: /^(?:support|assist) (?:the )?(?:qa|testing|test execution)(?: team)?[.!\s]*$/i },
];

function plain(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function placeholder(text: string): boolean {
  return /^(?:tbd|todo|placeholder|n\/a|to be (?:defined|determined)|[-.\s]*)$/i.test(plain(text));
}

function meaningful(text: string): boolean {
  return !placeholder(text) && plain(text).split(/\s+/).length >= 6;
}

function validRecord(record: SourceRecord): boolean {
  return !!record && !!record.reference && [record.reference.source, record.reference.id, record.reference.revision,
    record.workItemType].every(value => typeof value === 'string' && value.trim().length > 0)
    && ['WORK_ITEM', 'TEST_RESULT', 'CLARIFICATION', 'LINK', 'IMPLEMENTATION_NOTE'].includes(record.kind)
    && [record.title, record.description, record.acceptanceCriteria].every(value => typeof value === 'string')
    && Array.isArray(record.children) && record.children.every(child => child && typeof child.substantive === 'boolean'
      && child.reference && [child.reference.source, child.reference.id, child.reference.revision]
        .every(value => typeof value === 'string' && value.trim().length > 0));
}

function validPolicy(policy: GatePolicy): boolean {
  return !!policy && typeof policy.version === 'string' && !!policy.version.trim() && !!policy.types
    && Object.entries(policy.types).every(([key, rule]) => key === key.trim().toLowerCase() && !!key && !!rule
      && ['REJECTED', 'CONTEXT_ONLY', 'SUPPORTING_EVIDENCE'].includes(rule.defaultStatus)
      && typeof rule.allowSemanticPromotion === 'boolean' && typeof rule.container === 'boolean');
}

function validSemantic(evidence: SemanticEvidence, record: SourceRecord): boolean {
  return !!evidence && ['VALIDATED', 'NOT_KNOWLEDGE', 'AMBIGUOUS'].includes(evidence.verdict)
    && typeof evidence.reusable === 'boolean'
    && [...knowledgeCategories, ...nonKnowledgeCategories].some(category => category === evidence.category)
    && Array.isArray(evidence.quotes) && evidence.quotes.length > 0
    && evidence.quotes.every((quote: SemanticEvidence['quotes'][number]) => quote && ['title', 'description', 'acceptanceCriteria'].includes(quote.field)
      && typeof quote.text === 'string' && meaningful(quote.text) && record[quote.field].includes(quote.text));
}

export function classifyKnowledge(record: SourceRecord, policy: GatePolicy = defaultPolicy,
  semantic?: SemanticClassifier): Classification {
  const signals: Signal[] = [];
  const finish = (status: PrimaryStatus, reason: string, category: Classification['category'] = null,
    semanticEvidence: SemanticEvidence | null = null): Classification => ({
    status, reasonCodes: [reason], signals: [...signals, { code: reason, weight: 0, evidence: status }],
    score: Math.max(0, Math.min(100, signals.reduce((sum, signal) => sum + signal.weight, 0))),
    policyVersion: typeof policy?.version === 'string' && policy.version.trim() ? policy.version : 'INVALID_POLICY',
    category, semanticEvidence, sourceReferences: validRecord(record) ? [{ ...record.reference }] : [],
  });
  if (!validRecord(record)) return finish('REJECTED', 'INVALID_RECORD');
  if (!validPolicy(policy)) return finish('REJECTED', 'INVALID_POLICY');
  const signal = (code: string, weight: number, evidence: string) => signals.push({ code, weight, evidence });
  if (meaningful(record.description)) signal('MEANINGFUL_DESCRIPTION', 25, record.description);
  if (meaningful(record.acceptanceCriteria)) signal('ACCEPTANCE_CRITERIA', 25, record.acceptanceCriteria);
  const hasChildren = record.children.some(child => child.substantive);
  if (hasChildren) signal('HIERARCHY_CONTEXT', 10, 'Substantive child references supplied by caller');
  const typeKey = record.workItemType.trim().toLowerCase();
  const rule = Object.prototype.hasOwnProperty.call(policy.types, typeKey) ? policy.types[typeKey] : undefined;
  const thin = !meaningful(record.description) && !meaningful(record.acceptanceCriteria);
  const fields = [record.title, record.description, record.acceptanceCriteria].map(plain).filter(text => !placeholder(text));
  if (rule?.container && thin && hasChildren) return finish('CONTEXT_ONLY', 'CONTAINER_WITH_SUBSTANTIVE_CHILDREN');
  if (!fields.length) {
    signal('PLACEHOLDER', -50, 'No substantive fields');
    return finish('REJECTED', 'PLACEHOLDER', 'PLACEHOLDER');
  }
  const noise = fields.map(text => noiseRules.find(candidate => candidate.pattern.test(text)));
  if (noise.every(Boolean)) {
    const matched = noise[0]!;
    signal('EXECUTION_ONLY', -40, fields.join(' | '));
    return finish('REJECTED', matched.code, matched.category);
  }
  if (record.kind !== 'WORK_ITEM') {
    signal(record.kind === 'CLARIFICATION' ? 'MEANINGFUL_CLARIFICATION' : 'SUPPORTING_EVIDENCE', 15, record.kind);
    return finish('SUPPORTING_EVIDENCE', 'EVIDENCE_NOT_REQUIREMENT');
  }
  if (!rule) return finish('REJECTED', 'UNKNOWN_WORK_ITEM_TYPE');
  if (!rule.allowSemanticPromotion) return finish(rule.defaultStatus, 'TYPE_POLICY');
  if (!semantic) {
    signal('UNVALIDATED', -15, 'No semantic validation supplied');
    return finish(rule.defaultStatus, 'SEMANTIC_VALIDATION_REQUIRED');
  }
  let evidence: SemanticEvidence;
  try {
    evidence = semantic.classify(record);
    if (!validSemantic(evidence, record)) return finish('REJECTED', 'INVALID_SEMANTIC_EVIDENCE');
  } catch {
    return finish('REJECTED', 'SEMANTIC_CLASSIFIER_FAILED');
  }
  if (evidence.verdict !== 'VALIDATED' || !evidence.reusable
    || !knowledgeCategories.some(category => category === evidence.category)) {
    signal('AMBIGUOUS_OR_NON_KNOWLEDGE', -25, evidence.verdict);
    return finish('REJECTED', 'SEMANTIC_NOT_VALIDATED', evidence.category, evidence);
  }
  signal('EXPLICIT_PRODUCT_BEHAVIOR', 35, evidence.quotes.map(quote => quote.text).join(' | '));
  return finish('PROMOTED', 'REUSABLE_KNOWLEDGE_VALIDATED', evidence.category, evidence);
}
