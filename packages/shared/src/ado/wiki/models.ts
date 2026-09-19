export const categories = [
  'FEATURE_OVERVIEW', 'BUSINESS_RULE', 'FUNCTIONAL_BEHAVIOR', 'UX_BEHAVIOR', 'USER_FLOW',
  'VALIDATION', 'ERROR_HANDLING', 'DEPENDENCIES', 'INTEGRATION', 'KNOWN_LIMITATION',
  'PRODUCT_CONFIGURATION', 'RELEASE_INFORMATION', 'RELEASE_CHANGE', 'QA_REFERENCE',
] as const;
export type Category = typeof categories[number];
export type KnowledgeStatus = 'PROMOTED' | 'CONTEXT_ONLY' | 'SUPPORTING_EVIDENCE' | 'REJECTED';
export type Authority = 'VALIDATED_KNOWLEDGE' | 'SUPPORTING_EVIDENCE';
export type SourceIdentity = Readonly<{ workItemId: string; sourceLinkIdentity: string }>;
export type SourceReference = SourceIdentity & Readonly<{
  revision: string;
  changedDate: string;
  location: Readonly<{ kind: 'FIELD' | 'COMMENT'; name: string }>;
  classification?: Readonly<{ gateVersion: string; digest: string }>;
}>;
export type SourceFragment = Readonly<{ reference: SourceReference; text: string; status: KnowledgeStatus }>;
export type Provenance = Readonly<{ reference: SourceReference; status: 'PROMOTED' | 'SUPPORTING_EVIDENCE' }>;
export type Candidate = Readonly<{
  conceptId: string;
  title: string;
  text: string;
  category: Category;
  references: readonly SourceReference[];
  hierarchyIds: readonly string[];
  groupingKeys: readonly string[];
  iterations: readonly string[];
  releases: readonly string[];
}>;
export type HierarchyNode = Readonly<{
  id: string;
  title: string;
  parentIds: readonly string[];
  references: readonly SourceReference[];
}>;
export type TopicDefinition = Readonly<{
  id: string;
  title: string;
  hierarchyIds: readonly string[];
  groupingKeys: readonly string[];
  conceptIds: readonly string[];
}>;
export type SectionDefinition = Readonly<{ id: string; title: string; categories: readonly Category[] }>;
export type SectionPolicy = Readonly<{ version: string; sections: readonly SectionDefinition[] }>;
export type BuildInput = Readonly<{
  sources: readonly SourceFragment[];
  candidates: readonly Candidate[];
  hierarchy: readonly HierarchyNode[];
  topics: readonly TopicDefinition[];
  sectionPolicy?: SectionPolicy;
}>;
export type KnowledgeConcept = Readonly<{
  id: string;
  aliasIds: readonly string[];
  titles: readonly string[];
  text: string;
  category: Category;
  authority: Authority;
  provenance: readonly Provenance[];
  hierarchyIds: readonly string[];
  hierarchyTitles: readonly string[];
  groupingKeys: readonly string[];
  iterations: readonly string[];
  releases: readonly string[];
  topicId: string;
}>;
export type WikiSection = Readonly<{
  id: string;
  title: string;
  conceptIds: readonly string[];
  sources: readonly Provenance[];
}>;
export type CuratedBlock = Readonly<{ id: string; text: string }>;
export type WikiTopic = Readonly<{
  id: string;
  title: string;
  sections: readonly WikiSection[];
  curatedAnnotations: readonly CuratedBlock[];
  curationNeedsReview: boolean;
}>;
export type DependencyGraph = Readonly<{
  sourceConcepts: readonly Readonly<{ sourceKey: string; conceptId: string }>[];
  sourceTopics: readonly Readonly<{ sourceKey: string; topicId: string }>[];
  conceptTopics: readonly Readonly<{ conceptId: string; topicId: string }>[];
}>;
export type BuildState = Readonly<{
  policyVersion: string;
  concepts: readonly KnowledgeConcept[];
  topics: readonly WikiTopic[];
  graph: DependencyGraph;
  sourceFingerprints: Readonly<Record<string, string>>;
  topicFingerprints: Readonly<Record<string, string>>;
}>;
export type Issue = Readonly<{ code: string; identity: string }>;
export type Result<Value> = Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; issues: readonly Issue[] }>;
export interface SourceRevalidator {
  revalidate(identity: SourceIdentity, fragments: readonly SourceFragment[]): Result<readonly SourceFragment[]>;
}
export type CurationPolicy = 'PRESERVE_WITH_REVIEW' | 'BLOCK_REBUILD';
export type IncrementalResult = Readonly<{
  state: BuildState;
  revalidatedSourceKeys: readonly string[];
  affectedConceptIds: readonly string[];
  rebuiltTopicIds: readonly string[];
  removedTopicIds: readonly string[];
}>;
