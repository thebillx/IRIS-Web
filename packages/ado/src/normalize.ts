import { createHash } from 'node:crypto';
import { normalizeHtml } from './html.js';
import { safeCustomKey, sanitizeText, sanitizeValue, type JsonValue } from './sanitize.js';
import type { CanonicalWorkItem, RawSourceStage } from './model.js';

export interface NormalizationPolicy {
  readonly customFields?: Readonly<Record<string, string>>;
  readonly acceptanceFallbacks?: readonly ('description' | { readonly customKey: string })[];
}

const fieldNames = {
  type: 'System.WorkItemType', title: 'System.Title', state: 'System.State', description: 'System.Description',
  areaPath: 'System.AreaPath', iterationPath: 'System.IterationPath', boardColumn: 'System.BoardColumn',
  createdDate: 'System.CreatedDate', changedDate: 'System.ChangedDate', parent: 'System.Parent',
  tags: 'System.Tags', acceptanceCriteria: 'Microsoft.VSTS.Common.AcceptanceCriteria',
} as const;

export function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Expected positive safe integer');
  return value;
}

export function changedDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Expected UTC source date');
  const date = new Date(value);
  if (date.toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error('Invalid calendar date');
  return value;
}

export function stageRawSource(rawJson: string, policy: NormalizationPolicy = {}): RawSourceStage {
  const bytes = Buffer.byteLength(rawJson, 'utf8');
  if (bytes > 1_048_576) throw new Error('Raw snapshot exceeds staging limit');
  const raw: unknown = JSON.parse(rawJson);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected work item object');
  const envelope = raw as Record<string, unknown>;
  const id = positiveInteger(envelope.id);
  const revision = positiveInteger(envelope.rev);
  if (!envelope.fields || typeof envelope.fields !== 'object' || Array.isArray(envelope.fields)) throw new Error('Expected fields object');
  const fields = envelope.fields as Record<string, JsonValue>;
  const sourceDate = changedDate(fields[fieldNames.changedDate]);
  const rawHash = createHash('sha256').update(rawJson).digest('hex');
  const fieldSources: Record<string, string> = { ...fieldNames };
  function clean(field: string): string | null {
    const value = fields[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new Error('Expected textual source field');
    return sanitizeText(normalizeHtml(value).text) || null;
  }
  const customFields: Record<string, JsonValue> = {};
  for (const [key, source] of Object.entries(policy.customFields ?? {})) {
    if (!safeCustomKey(key) || !/^Custom\.[A-Za-z0-9_.]{1,128}$/.test(source) || /email|identity|guid|descriptor|avatar|personid|auth|token|secret|password/i.test(source.replace(/[^a-z0-9]/gi, ''))) throw new Error('Unsafe custom projection');
    fieldSources[`customFields.${key}`] = source;
    if (Object.hasOwn(fields, source)) customFields[key] = sanitizeValue(fields[source]!);
  }
  let acceptanceCriteria: CanonicalWorkItem['acceptanceCriteria'] = { text: clean(fieldNames.acceptanceCriteria), source: 'standard', sourceKey: 'acceptanceCriteria' };
  if (!acceptanceCriteria.text) {
    acceptanceCriteria = { text: null, source: 'missing', sourceKey: null };
    for (const fallback of policy.acceptanceFallbacks ?? []) {
      const key = fallback === 'description' ? 'description' : `customFields.${fallback.customKey}`;
      const source = fieldSources[key];
      if (!source) throw new Error('AC fallback must reference a projected custom field');
      const text = clean(source);
      if (text) {
        acceptanceCriteria = { text, source: fallback === 'description' ? 'description' : 'custom', sourceKey: key };
        break;
      }
    }
  }
  const canonical: CanonicalWorkItem = {
    id, revision, type: clean(fieldNames.type), title: clean(fieldNames.title), state: clean(fieldNames.state),
    description: clean(fieldNames.description), acceptanceCriteria,
    areaPath: clean(fieldNames.areaPath), iterationPath: clean(fieldNames.iterationPath),
    parent: fields[fieldNames.parent] == null ? null : positiveInteger(fields[fieldNames.parent]),
    tags: (clean(fieldNames.tags) ?? '').split(';').map(tag => tag.trim()).filter(Boolean),
    boardColumn: clean(fieldNames.boardColumn),
    createdDate: fields[fieldNames.createdDate] == null ? null : changedDate(fields[fieldNames.createdDate]),
    changedDate: sourceDate, customFields, provenance: { source: 'ado', rawHash, normalizerVersion: 'm3-v1' },
  };
  return {
    kind: 'raw-source-stage', validation: 'unvalidated', searchable: false, revision, changedDate: sourceDate, rawHash,
    rawAudit: { access: 'quarantine-only', json: rawJson, bytes }, canonical, fieldSources,
  };
}
