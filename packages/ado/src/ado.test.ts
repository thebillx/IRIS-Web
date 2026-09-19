import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { classifyBatchFailure, normalizeHtml, planCollection, recordBatchResult, restoreCollectionPlan, resumableBatches, sanitizeValue, stageRawSource, type NormalizationPolicy } from './index.js';

const timestamp = '2026-01-02T03:04:05.123Z';
function raw(fields: Record<string, unknown> = {}) {
  return JSON.stringify({ id: 101, rev: 7, fields: { 'System.ChangedDate': timestamp, ...fields }, _links: { avatar: 'https://example.test/avatar' } });
}
function stage(fields: Record<string, unknown> = {}, policy: NormalizationPolicy = {}) {
  return stageRawSource(raw(fields), policy);
}
function version(id: number) {
  return { id, revision: 7, changedDate: timestamp, rawHash: 'a'.repeat(64) };
}

describe('batch collection contracts', () => {
  it('bounds, deduplicates and deterministically plans chunks', () => {
    const plan = planCollection([105, 101, 103, 101, 102, 104], 2);
    expect(plan.batches.map(batch => batch.ids)).toEqual([[101, 102], [103, 104], [105]]);
    expect(plan).toEqual(planCollection([101, 102, 103, 104, 105], 2));
    expect(planCollection([]).batches).toEqual([]);
  });
  it.each([0, 201, 1.5, NaN])('rejects unsafe chunk size %s', size => {
    expect(() => planCollection([101], size)).toThrow();
  });
  it('validates IDs, planning budget and attempts', () => {
    expect(() => planCollection([-1])).toThrow();
    expect(() => planCollection([Number.MAX_SAFE_INTEGER + 1])).toThrow();
    expect(() => planCollection([101], 2, 0)).toThrow();
    expect(() => planCollection(Array.from({ length: 100_001 }, () => 101))).toThrow();
  });
  it.each([408, 429, 500, 503, null])('classifies transient failure %s', status => {
    expect(classifyBatchFailure(status).classification).toBe('retryable');
  });
  it.each([400, 401, 403, 404, 422])('does not retry rejection %s', status => {
    expect(classifyBatchFailure(status).classification).toBe('permanent');
  });
  it('resumes failed batches without restarting completed ones', () => {
    let plan = planCollection([101, 102], 1);
    const [first, second] = plan.batches;
    plan = recordBatchResult(plan, first!.key, 0, { items: [version(101)] });
    plan = recordBatchResult(plan, second!.key, 0, { failureStatus: 429 });
    expect(resumableBatches(plan).map(batch => batch.ids)).toEqual([[102]]);
    const persisted = restoreCollectionPlan(JSON.stringify(plan));
    plan = recordBatchResult(persisted, second!.key, 1, { items: [version(102)] });
    expect(resumableBatches(plan)).toEqual([]);
    expect(plan.batches[0]!.outcome).toEqual({ status: 'succeeded', items: [version(101)] });
  });
  it('rejects stale responses and bounds retries', () => {
    let plan = planCollection([101], 1, 2);
    const key = plan.batches[0]!.key;
    plan = recordBatchResult(plan, key, 0, { failureStatus: null });
    expect(() => recordBatchResult(plan, key, 0, { items: [version(101)] })).toThrow();
    plan = recordBatchResult(plan, key, 1, { failureStatus: 503 });
    expect(resumableBatches(plan)).toEqual([]);
    expect(() => recordBatchResult(plan, key, 2, { items: [version(101)] })).toThrow();
  });
  it('does not accept incomplete, duplicate, wrong or unversioned responses', () => {
    const plan = planCollection([101, 102]);
    for (const items of [[version(101)], [version(101), version(101)], [version(101), version(103)], [version(101), { ...version(102), revision: 0 }], [version(101), { ...version(102), rawHash: 'invalid' }]]) {
      expect(() => recordBatchResult(plan, plan.batches[0]!.key, 0, { items })).toThrow();
    }
    expect(plan.batches[0]!.attempts).toBe(0);
  });
  it('validates checkpoint data before resuming', () => {
    const plan = planCollection([101]);
    expect(restoreCollectionPlan(JSON.stringify(plan))).toEqual(plan);
    for (const invalid of [null, { ...plan, version: 'unknown' }, { ...plan, maxAttempts: 99 }, { ...plan, batches: [plan.batches[0], plan.batches[0]] }, { ...plan, batches: [{ ...plan.batches[0], key: 'forged' }] }, { ...plan, batches: [{ ...plan.batches[0], attempts: -1 }] }, { ...plan, batches: [{ ...plan.batches[0], attempts: 1, outcome: { status: 'failed', failure: { classification: 'retryable', reason: 'rejected' } } }] }]) expect(() => restoreCollectionPlan(JSON.stringify(invalid))).toThrow();
  });
});

describe('HTML normalizer', () => {
  it('preserves lists, rows, cells and safe link meaning', () => {
    const result = normalizeHtml('<div><ol><li>First</li><li>Second</li></ol><table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>B</td></tr></table><a href="https://example.test/docs">Read docs</a></div>');
    expect(result.text).toContain('1. First\n\n2. Second');
    expect(result.text).toContain('| Name | Value |');
    expect(result.text).toContain('| A | B |');
    expect(result.links).toEqual([{ label: 'Read docs', href: 'https://example.test/docs' }]);
  });
  it('removes styles and active content, decodes entities and separates adjacent text', () => {
    const result = normalizeHtml('<style>secret noise</style><script>evil()</script><p style="color:red">One</p><p>Two &amp; &#169; &nbsp; &eacute;</p><span>Three</span><span>Four</span><img src="secret-avatar"><!-- hidden -->');
    expect(result.text).toBe('One\n\nTwo & © é\nThree Four');
  });
  it('repairs malformed HTML and never preserves unsafe link targets', () => {
    const result = normalizeHtml('<p>Hello<div>World<a href="javascript:alert(1)">Unsafe</a><a href="mailto:user@example.test">Mail</a><a href="https://user:pass@example.test/">Login</a>');
    expect(result.text).toContain('Hello\n\nWorld');
    expect(result.links).toEqual([]);
    expect(result.text).not.toMatch(/javascript|mailto|user:pass/);
  });
  it('bounds HTML size and nesting', () => {
    expect(() => normalizeHtml('x'.repeat(262_145))).toThrow();
    expect(() => normalizeHtml('<div>'.repeat(102))).toThrow();
  });
});

describe('canonical normalization and staging', () => {
  it('maps the canonical model without raw field names or technical noise', () => {
    const result = stage({
      'System.WorkItemType': 'Story', 'System.Title': '<b>Synthetic story</b>', 'System.State': 'Active',
      'System.Description': '<p>Useful description</p>', 'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>Observable result</li></ul>',
      'System.AreaPath': 'Demo\\Area', 'System.IterationPath': 'Demo\\Sprint', 'System.Parent': 100,
      'System.Tags': 'one; two', 'System.BoardColumn': 'Doing', 'System.CreatedDate': timestamp,
      'System.Watermark': 456, 'System.AuthorizedDate': timestamp, 'Custom.Unknown': 'not projected',
    });
    expect(result.canonical).toMatchObject({ id: 101, revision: 7, type: 'Story', title: 'Synthetic story', state: 'Active', description: 'Useful description', acceptanceCriteria: { text: '- Observable result', source: 'standard', sourceKey: 'acceptanceCriteria' }, areaPath: 'Demo\\Area', iterationPath: 'Demo\\Sprint', parent: 100, tags: ['one', 'two'], boardColumn: 'Doing', createdDate: timestamp, changedDate: timestamp, customFields: {} });
    expect(JSON.stringify(result.canonical)).not.toMatch(/System\.|Microsoft\.|Custom\.|Watermark|AuthorizedDate|_links/);
  });
  it('treats missing or blank AC as normal and never invents criteria', () => {
    expect(stage({ 'System.Description': 'Not automatically AC' }).canonical.acceptanceCriteria).toEqual({ text: null, source: 'missing', sourceKey: null });
    expect(stage({ 'Microsoft.VSTS.Common.AcceptanceCriteria': '<div>&nbsp;</div>' }).canonical.acceptanceCriteria.source).toBe('missing');
  });
  it('records exact custom fallback source separately and honors configured order', () => {
    const result = stage({ 'Custom.ExitRules': '<p>Exact source</p>', 'System.Description': 'Description fallback' }, { customFields: { exitRules: 'Custom.ExitRules' }, acceptanceFallbacks: [{ customKey: 'exitRules' }, 'description'] });
    expect(result.canonical.acceptanceCriteria).toEqual({ text: 'Exact source', source: 'custom', sourceKey: 'customFields.exitRules' });
    expect(result.fieldSources['customFields.exitRules']).toBe('Custom.ExitRules');
    expect(stage({ 'System.Description': 'Literal fallback' }, { acceptanceFallbacks: ['description'] }).canonical.acceptanceCriteria.source).toBe('description');
    expect(() => stage({}, { acceptanceFallbacks: [{ customKey: 'notProjected' }] })).toThrow();
  });
  it('gives standard AC precedence over fallback', () => {
    expect(stage({ 'Microsoft.VSTS.Common.AcceptanceCriteria': 'Standard', 'System.Description': 'Other' }, { acceptanceFallbacks: ['description'] }).canonical.acceptanceCriteria.text).toBe('Standard');
  });
  it('retains extensible structured custom values only through safe aliases', () => {
    expect(stage({ 'Custom.Spec': { score: 5, enabled: true, options: ['A', 'B'], empty: null }, 'Custom.Unknown': 'raw only' }, { customFields: { spec: 'Custom.Spec' } }).canonical.customFields).toEqual({ spec: { score: 5, enabled: true, options: ['A', 'B'], empty: null } });
    for (const customFields of [{ spec: 'System.AssignedTo' }, { personId: 'Custom.Spec' }, { spec: 'Custom.AuthToken' }, { 'Custom.Spec': 'Custom.Spec' }]) expect(() => stage({}, { customFields })).toThrow();
  });
  it('sanitizes all projected text and nested values before returning canonical data', () => {
    const sensitive = 'person@example.test 11111111-2222-3333-4444-555555555555 aad.SYNTHETIC descriptor=opaque PersonId=123 Bearer synthetic-token avatar=https://example.test/image';
    const result = stage({ 'System.Title': sensitive, 'System.Description': `<p>${sensitive}</p>`, 'Microsoft.VSTS.Common.AcceptanceCriteria': sensitive, 'System.Tags': sensitive, 'System.AreaPath': sensitive, 'System.IterationPath': sensitive, 'System.State': sensitive, 'System.WorkItemType': sensitive, 'System.BoardColumn': sensitive, 'System.AssignedTo': { displayName: 'Synthetic', uniqueName: 'person@example.test' }, 'Custom.Spec': { text: sensitive, authMetadata: { token: 'sensitive' }, _links: { self: 'noise' }, owner: { descriptor: 'opaque', displayName: 'Synthetic' } } }, { customFields: { spec: 'Custom.Spec' } });
    const canonical = JSON.stringify(result.canonical);
    expect(canonical).not.toMatch(/person@example|11111111|aad\.SYNTHETIC|opaque|PersonId=123|synthetic-token|authMetadata|_links|displayName/);
    expect(result.rawAudit.json).toContain('person@example.test');
    expect(result.rawAudit.access).toBe('quarantine-only');
  });
  it('decodes obfuscated HTML identities before sanitizing and strips URL auth data', () => {
    const text = stage({ 'System.Description': 'person&#64;example.test <a href="https://example.test/docs?token=private#auth">Guide</a> https://example.test/avatar/person' }).canonical.description;
    expect(text).not.toMatch(/person@example|private|avatar\/person/);
    expect(text).toContain('https://example.test/docs');
  });
  it('redacts quoted and spaced metadata in free text', () => {
    const result = stage({ 'System.Description': '{"PersonId":123456,"descriptor":"opaque-private","accessToken":"private-token"} PersonId 654321' });
    expect(result.canonical.description).not.toMatch(/123456|654321|opaque-private|private-token/);
    expect(() => stage({}, { customFields: { owner: 'Custom.Person.Id' } })).toThrow();
  });
  it('keeps raw audit bytes and hash separate from unvalidated canonical staging', () => {
    const source = raw({ 'System.Description': '<p style="color:red">Original</p>' });
    const result = stageRawSource(source);
    expect(result).toMatchObject({ kind: 'raw-source-stage', validation: 'unvalidated', searchable: false, revision: 7, changedDate: timestamp });
    expect(result.rawAudit).toEqual({ access: 'quarantine-only', json: source, bytes: Buffer.byteLength(source) });
    expect(result.rawHash).toBe(createHash('sha256').update(source).digest('hex'));
    expect(result.canonical.provenance.rawHash).toBe(result.rawHash);
    expect(stageRawSource(source.replace('Original', 'Revised')).rawHash).not.toBe(result.rawHash);
  });
  it('rejects invalid source envelopes, versions and dates', () => {
    for (const source of ['null', '[]', '{}', '{', JSON.stringify({ id: 101, rev: 0, fields: {} }), raw({ 'System.ChangedDate': '2026-02-30T00:00:00Z' }), raw({ 'System.ChangedDate': 'invalid' }), raw({ 'System.Parent': '../escape' }), raw({ 'System.Title': {} })]) expect(() => stageRawSource(source)).toThrow();
    expect(() => stageRawSource(' '.repeat(1_048_577))).toThrow();
  });
  it('rejects excessive structured nesting and handles prototype keys without pollution', () => {
    let value: unknown = 'leaf';
    for (let depth = 0; depth < 34; depth++) value = { nested: value };
    expect(() => stage({ 'Custom.Spec': value }, { customFields: { spec: 'Custom.Spec' } })).toThrow();
    expect(sanitizeValue(JSON.parse('{"__proto__":{"safe":true},"email":"person@example.test"}'))).not.toHaveProperty('email');
    expect(Object.prototype).not.toHaveProperty('safe');
  });
});
