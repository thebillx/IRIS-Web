import { describe, expect, it } from 'vitest';
import { classifyKnowledge, defaultPolicy } from './gate.js';
import { includedInDefaultRetrieval, projectionFor, resolveConcept, type Claim } from './concepts.js';
import { knowledgeCategories, nonKnowledgeCategories, primaryStatuses, type GatePolicy,
  type SemanticClassifier, type SemanticEvidence, type SourceRecord } from './models.js';

function record(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return { reference: { source: 'synthetic', id: 'item-1', revision: '1' }, workItemType: 'User Story', kind: 'WORK_ITEM',
    title: 'Download behavior', description: 'The system must support exporting filtered results as a file.',
    acceptanceCriteria: 'Only the selected records appear in the exported file.', children: [], ...overrides };
}

class FakeSemanticClassifier implements SemanticClassifier {
  calls = 0;
  constructor(private readonly output?: SemanticEvidence) {}
  classify(source: SourceRecord): SemanticEvidence {
    this.calls += 1;
    return this.output ?? { verdict: 'VALIDATED', reusable: true, category: 'FUNCTIONAL_BEHAVIOR',
      quotes: [{ field: 'description', text: source.description }] };
  }
}

function claim(id: string, overrides: Partial<Claim> = {}): Claim {
  return { id, text: 'Exports contain only selected records.', category: 'FUNCTIONAL_BEHAVIOR',
    references: [{ source: 'synthetic', id, revision: '1' }], supersedes: [], ambiguous: false, ...overrides };
}

describe('deterministic relevance gate', () => {
  it('defines exactly four exhaustive primary classifications', () => {
    expect(primaryStatuses).toEqual(['PROMOTED', 'CONTEXT_ONLY', 'SUPPORTING_EVIDENCE', 'REJECTED']);
    expect(knowledgeCategories).toHaveLength(10);
    expect(nonKnowledgeCategories).toHaveLength(8);
  });

  it.each([
    ['Support QA', 'SUPPORT_ONLY'], ['Retest the fix', 'RETEST_ONLY'], ['Prepare test data', 'TEST_DATA_ONLY'],
    ['TBD', 'PLACEHOLDER'], ['', 'PLACEHOLDER'], ['<p>&nbsp;</p>', 'PLACEHOLDER'],
    ['Execute manual tests', 'EXECUTION_ONLY'], ['Deploy the release to staging', 'DEPLOYMENT_ONLY'],
    ['Update automation scripts', 'AUTOMATION_ONLY'], ['Coordinate the handoff', 'COORDINATION_ONLY'],
    ['Update the timesheet', 'ADMIN_ONLY'], ['Remove old build artifacts', 'HOUSEKEEPING_ONLY'],
  ])('rejects %s before semantic execution', (title, reason) => {
    const fake = new FakeSemanticClassifier();
    const result = classifyKnowledge(record({ title, description: '', acceptanceCriteria: '' }), defaultPolicy, fake);
    expect(result.status).toBe('REJECTED');
    expect(result.reasonCodes).toContain(reason);
    expect(result.policyVersion).toBe(defaultPolicy.version);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(fake.calls).toBe(0);
  });

  it('rejects ordinary Tasks and never promotes a Story on type or score alone', () => {
    expect(classifyKnowledge(record({ workItemType: 'Task' })).status).toBe('REJECTED');
    expect(classifyKnowledge(record()).status).toBe('REJECTED');
    expect(classifyKnowledge(record()).score).toBeGreaterThan(0);
  });

  it.each(['Task', 'User Story', 'Feature', 'Epic', 'Initiative'])('requires reusable evidence for %s promotion', workItemType => {
    const result = classifyKnowledge(record({ workItemType }), defaultPolicy, new FakeSemanticClassifier());
    expect(result.status).toBe('PROMOTED');
    expect(result.signals.map(signal => signal.code)).toContain('EXPLICIT_PRODUCT_BEHAVIOR');
    expect(result.semanticEvidence?.quotes[0]?.text).toContain('support');
  });

  it('does not let an execution title suppress substantive product behavior', () => {
    expect(classifyKnowledge(record({ title: 'Support QA' }), defaultPolicy, new FakeSemanticClassifier()).status).toBe('PROMOTED');
  });

  it.each(['Epic', 'Feature', 'Initiative'])('keeps thin %s with children as context', workItemType => {
    const fake = new FakeSemanticClassifier();
    const result = classifyKnowledge(record({ workItemType, title: 'TBD', description: '', acceptanceCriteria: '',
      children: [{ reference: { source: 'synthetic', id: 'child-1', revision: '1' }, substantive: true }] }), defaultPolicy, fake);
    expect(result.status).toBe('CONTEXT_ONLY');
    expect(projectionFor(result)).toBe('GRAPH_CONTEXT');
    expect(fake.calls).toBe(0);
  });

  it.each(['Bug', 'Test Case'])('keeps %s out of primary v1 knowledge', workItemType => {
    const fake = new FakeSemanticClassifier();
    const result = classifyKnowledge(record({ workItemType }), defaultPolicy, fake);
    expect(result.status).toBe('SUPPORTING_EVIDENCE');
    expect(fake.calls).toBe(0);
  });

  it.each(['TEST_RESULT', 'CLARIFICATION', 'LINK', 'IMPLEMENTATION_NOTE'] as const)('cannot promote %s automatically', kind => {
    const fake = new FakeSemanticClassifier();
    const result = classifyKnowledge(record({ kind }), defaultPolicy, fake);
    expect(result.status).toBe('SUPPORTING_EVIDENCE');
    expect(projectionFor(result)).toBe('EVIDENCE_INDEX');
    expect(includedInDefaultRetrieval(result)).toBe(false);
    expect(fake.calls).toBe(0);
  });

  it('supports versioned type configuration without bypassing validation', () => {
    const policy: GatePolicy = { version: 'synthetic/v2', types: { task: {
      defaultStatus: 'REJECTED', allowSemanticPromotion: false, container: false } } };
    const result = classifyKnowledge(record({ workItemType: 'Task' }), policy, new FakeSemanticClassifier());
    expect(result.status).toBe('REJECTED');
    expect(result.policyVersion).toBe('synthetic/v2');
    expect(classifyKnowledge(record({ workItemType: 'unknown' })).reasonCodes).toContain('UNKNOWN_WORK_ITEM_TYPE');
    expect(classifyKnowledge(record({ workItemType: 'constructor' })).status).toBe('REJECTED');
  });

  it.each([
    { verdict: 'AMBIGUOUS' }, { verdict: 'NOT_KNOWLEDGE' }, { reusable: false }, { category: 'SUPPORT_ONLY' },
    { quotes: [] }, { quotes: [{ field: 'description', text: 'An invented claim not present in source.' }] },
  ])('fails closed on inadequate semantic evidence %j', overrides => {
    const evidence = { ...new FakeSemanticClassifier().classify(record()), ...overrides } as SemanticEvidence;
    expect(classifyKnowledge(record(), defaultPolicy, new FakeSemanticClassifier(evidence)).status).toBe('REJECTED');
  });

  it('contains classifier errors and invalid boundary inputs', () => {
    expect(classifyKnowledge(record(), defaultPolicy, { classify() { throw new Error('failure'); } }).reasonCodes)
      .toContain('SEMANTIC_CLASSIFIER_FAILED');
    expect(classifyKnowledge(null as unknown as SourceRecord).reasonCodes).toContain('INVALID_RECORD');
    expect(classifyKnowledge(record(), { version: '', types: {} }).reasonCodes).toContain('INVALID_POLICY');
  });

  it('routes rejected content only to audit, never default retrieval', () => {
    const rejected = classifyKnowledge(record({ workItemType: 'Task' }));
    expect(projectionFor(rejected)).toBe('AUDIT_QUARANTINE');
    expect(includedInDefaultRetrieval(rejected)).toBe(false);
    const promoted = classifyKnowledge(record(), defaultPolicy, new FakeSemanticClassifier());
    expect(includedInDefaultRetrieval(promoted)).toBe(true);
    for (const truth of ['SUPERSEDED', 'CONFLICTING', 'AMBIGUOUS', 'NEEDS_REVIEW'] as const) {
      expect(includedInDefaultRetrieval(promoted, truth)).toBe(false);
    }
  });
});

describe('pure concept reconciliation', () => {
  it('collapses exact duplicates to one concept while preserving all provenance', () => {
    const result = resolveConcept('export-selection', [claim('first'), claim('second')]);
    expect(result.status).toBe('DUPLICATE');
    expect(result.currentClaim?.text).toBe(claim('first').text);
    expect(result.sourceReferences).toHaveLength(2);
    expect(result.currentReferences).toHaveLength(2);
    expect(resolveConcept('export-selection', [claim('second'), claim('first')])).toEqual(result);
  });

  it('retains superseded history without treating it as current truth', () => {
    const result = resolveConcept('export-selection', [claim('old'), claim('new', { text: 'Exports include selected visible records.', supersedes: ['old'] })]);
    expect(result.status).toBe('CURRENT');
    expect(result.currentClaim?.id).toBe('new');
    expect(result.sourceReferences).toHaveLength(2);
    expect(result.historicalReferences.map(reference => reference.id)).toEqual(['old']);
    expect(result.claimStates).toContainEqual({ id: 'old', status: 'SUPERSEDED' });
  });

  it('does not silently merge divergent claims', () => {
    const result = resolveConcept('export-selection', [claim('first'), claim('second', { text: 'Exports include all records.' })]);
    expect(result.status).toBe('CONFLICTING');
    expect(result.currentClaim).toBeNull();
    expect(result.sourceReferences).toHaveLength(2);
  });

  it('detects branched supersession conflicts', () => {
    expect(resolveConcept('export-selection', [claim('old'), claim('next', { supersedes: ['old'] }),
      claim('other', { text: 'Exports include all records.', supersedes: ['old'] })]).status).toBe('CONFLICTING');
  });

  it('marks ambiguity and invalid supersession graphs for review', () => {
    expect(resolveConcept('export-selection', [claim('first', { ambiguous: true })]).status).toBe('AMBIGUOUS');
    for (const claims of [[], [claim('first'), claim('first')], [claim('first', { supersedes: ['missing'] })],
      [claim('first', { supersedes: ['second'] }), claim('second', { supersedes: ['first'] })]]) {
      expect(resolveConcept('export-selection', claims).status).toBe('NEEDS_REVIEW');
    }
  });
});
