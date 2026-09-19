import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';

const catalog = JSON.parse(readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8'));
const statuses = ['PROMOTED', 'CONTEXT_ONLY', 'SUPPORTING_EVIDENCE', 'REJECTED'];
const truthStatuses = ['CURRENT', 'DUPLICATE', 'SUPERSEDED', 'CONFLICTING', 'AMBIGUOUS', 'NEEDS_REVIEW'];
const admissions = ['PRIMARY', 'CONTEXT', 'EVIDENCE', 'REJECTED', 'HISTORY', 'REVIEW'];
const requiredItems = ['epic-container', 'normal-story', 'story-no-description', 'story-acceptance-criteria', 'story-comments', 'story-custom-fields', 'support-only-story', 'execution-only-task', 'placeholder', 'context-only-epic', 'supporting-evidence', 'duplicate-story', 'superseded-story', 'conflicting-story', 'ambiguous-story', 'orphan-relation', 'valid-support-requirement', 'retest', 'prepare-data', 'feature-subtree'];
const requiredScenarios = ['pagination', 'upstream-401', 'upstream-403', 'upstream-429', 'upstream-5xx', 'malformed-item', 'bounded-description', 'unsafe-links', 'pii-redaction', 'pagination-cycle', 'backlog-discovery', 'graph-cycle', 'classifier-invalid', 'admin-only-story'];

function validateCatalog(candidate) {
  assert.equal(candidate.version, 1);
  assert.equal(candidate.origin, 'SYNTHETIC');
  assert.deepEqual(candidate.logicalSource, { organization: 'sample-org', project: 'sample-project', team: 'sample-team', board: 'sample-board' });
  assert.deepEqual(candidate.items.map((item) => item.key), requiredItems);
  assert.deepEqual(candidate.scenarios.map((scenario) => scenario.key), requiredScenarios);
  const ids = candidate.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of candidate.items) {
    assert(Number.isSafeInteger(item.id) && item.id >= 1001 && item.id <= 1020);
    assert(Number.isSafeInteger(item.rev) && item.rev > 0);
    assert.equal(typeof item.fields, 'object');
    assert(!Array.isArray(item.fields));
    assert.equal(typeof item.fields['System.Title'], 'string');
    assert(['Epic', 'Feature', 'User Story', 'Task'].includes(item.fields['System.WorkItemType']));
    assert(statuses.includes(item.expectedStatus));
    assert(truthStatuses.includes(item.expectedTruthStatus));
    assert(admissions.includes(item.expectedAdmission));
    assert.match(item.fields['System.ChangedDate'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(item.reason, /^[A-Z_]+$/);
    assert(Array.isArray(item.relations));
    for (const relation of item.relations) {
      assert.match(relation.rel, /^System\.LinkTypes\.(Hierarchy-(Reverse|Forward)|Duplicate-Forward|Related)$/);
      assert.match(relation.url, /^https:\/\/ado\.example\.invalid\/sample-org\/sample-project\/_apis\/wit\/workItems\/\d{4}$/);
      const target = Number(relation.url.split('/').at(-1));
      assert(ids.includes(target) || (item.key === 'orphan-relation' && target === 1999));
    }
  }
  const serialized = JSON.stringify(candidate);
  assert(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(serialized));
  assert(!/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i.test(serialized));
  assert(!/"(?:authorization|password|accessToken|refreshToken|pat|credentials|cookie)"\s*:/i.test(serialized));
  for (const url of serialized.matchAll(/https?:\/\/([^/"\s]+)/g)) assert(url[1].endsWith('.example.invalid'));
}

test('catalog schema, required coverage, generic source and relation integrity', () => validateCatalog(catalog));

test('schema rejects corrupt identifiers, status, relation and credential fields', () => {
  for (const corrupt of [
    (copy) => { copy.items[0].id = copy.items[1].id; },
    (copy) => { copy.items[0].expectedStatus = 'APPROVED'; },
    (copy) => { copy.items[1].relations[0].url = 'https://outside.invalid/item/1001'; },
    (copy) => { copy.items[0].fields.authorization = 'synthetic-forbidden-value'; },
    (copy) => { copy.scenarios.pop(); },
  ]) {
    const copy = JSON.parse(JSON.stringify(catalog));
    corrupt(copy);
    assert.throws(() => validateCatalog(copy));
  }
});

test('pagination fixture declares unique coverage and comment completeness', () => {
  const pagination = catalog.scenarios.find((scenario) => scenario.key === 'pagination');
  assert.deepEqual([...new Set(pagination.pages.flatMap((page) => page.value))], pagination.expectedUniqueIds);
  for (const page of pagination.pages) assert.equal(page.count, page.value.length);
  const comments = catalog.items.find((item) => item.key === 'story-comments').comments;
  assert.equal(comments.totalCount, comments.pages.reduce((count, page) => count + page.count, 0));
  for (const page of comments.pages) assert.equal(page.count, page.comments.length);
});

test('upstream fixtures declare fail-closed categories and bounded retry input', () => {
  const errors = catalog.scenarios.filter((scenario) => scenario.kind === 'error');
  assert.deepEqual(errors.map((scenario) => scenario.status), [401, 403, 429, 503]);
  assert.deepEqual(errors.map((scenario) => scenario.expectedCode), ['UNAUTHENTICATED', 'UNAUTHORIZED', 'RATE_LIMITED', 'UPSTREAM_FAILURE']);
  assert.deepEqual(errors.map((scenario) => scenario.retryable), [false, false, true, true]);
  assert.equal(errors[2].headers['retry-after'], '2');
});

test('noise and knowledge status oracles are explicit, not production execution', () => {
  const expected = { 'execution-only-task': 'REJECTED', 'support-only-story': 'REJECTED', retest: 'REJECTED', 'prepare-data': 'REJECTED', placeholder: 'REJECTED', 'valid-support-requirement': 'PROMOTED', 'normal-story': 'PROMOTED', 'epic-container': 'CONTEXT_ONLY', 'supporting-evidence': 'SUPPORTING_EVIDENCE', 'ambiguous-story': 'REJECTED', 'conflicting-story': 'PROMOTED' };
  for (const [key, status] of Object.entries(expected)) assert.equal(catalog.items.find((item) => item.key === key).expectedStatus, status);
  assert.deepEqual([...new Set(catalog.items.map((item) => item.expectedStatus))].sort(), [...statuses].sort());
  assert.equal(catalog.items.find((item) => item.key === 'duplicate-story').expectedTruthStatus, 'DUPLICATE');
  assert.equal(catalog.items.find((item) => item.key === 'superseded-story').expectedTruthStatus, 'SUPERSEDED');
  assert.equal(catalog.items.find((item) => item.key === 'conflicting-story').expectedTruthStatus, 'CONFLICTING');
  assert.equal(catalog.items.find((item) => item.key === 'ambiguous-story').expectedTruthStatus, 'AMBIGUOUS');
  assert.equal(catalog.items.find((item) => item.key === 'orphan-relation').expectedAdmission, 'REVIEW');
});

test('malformed and generated bounded fixtures retain intended edge cases', () => {
  const malformed = catalog.scenarios.find((scenario) => scenario.key === 'malformed-item');
  assert.equal(typeof malformed.input.id, 'string');
  assert(Array.isArray(malformed.input.fields));
  const bounded = catalog.scenarios.find((scenario) => scenario.key === 'bounded-description');
  assert.deepEqual(bounded.lengths, [bounded.limit - 1, bounded.limit, bounded.limit + 1]);
  for (const length of bounded.lengths) assert.equal(bounded.unit.repeat(length).length, length);
  const custom = catalog.items.find((item) => item.key === 'story-custom-fields').fields;
  assert.equal(custom['Custom.Enabled'], false);
  assert.equal(custom['Custom.Note'], null);
  assert.equal(custom['Custom.RetentionDays'], 30);
});
