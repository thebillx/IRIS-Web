import type { JsonValue } from './sanitize.js';

export interface CanonicalWorkItem {
  readonly id: number;
  readonly revision: number;
  readonly type: string | null;
  readonly title: string | null;
  readonly state: string | null;
  readonly description: string | null;
  readonly acceptanceCriteria: { readonly text: string | null; readonly source: 'standard' | 'description' | 'custom' | 'missing'; readonly sourceKey: string | null };
  readonly areaPath: string | null;
  readonly iterationPath: string | null;
  readonly parent: number | null;
  readonly tags: readonly string[];
  readonly boardColumn: string | null;
  readonly createdDate: string | null;
  readonly changedDate: string;
  readonly customFields: Readonly<Record<string, JsonValue>>;
  readonly provenance: { readonly source: 'ado'; readonly rawHash: string; readonly normalizerVersion: 'm3-v1' };
}

export interface RawSourceStage {
  readonly kind: 'raw-source-stage';
  readonly validation: 'unvalidated';
  readonly searchable: false;
  readonly revision: number;
  readonly changedDate: string;
  readonly rawHash: string;
  readonly rawAudit: { readonly access: 'quarantine-only'; readonly json: string; readonly bytes: number };
  readonly canonical: CanonicalWorkItem;
  readonly fieldSources: Readonly<Record<string, string>>;
}
