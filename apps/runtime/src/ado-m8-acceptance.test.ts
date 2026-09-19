import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stageRawSource, type RawSourceStage } from '@iris/ado';
import {
  resolveConcept,
  type Claim,
  type Classification,
  type SemanticClassifier,
  type SourceRecord,
} from '@iris/shared/ado/knowledge-gate';
import { queryKnowledge, type TopicDefinition } from '@iris/shared/ado/wiki';
import { readSemantics, type ReadPolicy } from './ado/adapter.js';
import { FakeAzureDevOpsAdapter, type FakeResponses } from './ado/fake-adapter.js';
import {
  planEnumeration,
  type Backlog,
  type BoardIdentity,
  type ScopeResponse,
} from './ado/discovery.js';
import { bridgeCanonicalStageToKnowledge } from './ado-knowledge-bridge.js';
import { classifyCanonicalKnowledge, truthStatusForClaim } from './ado-knowledge-gate-bridge.js';
import {
  gateDecisionFromClassification,
  toSyncMembership,
  toSyncObservation,
} from './ado-knowledge-sync-bridge.js';
import { buildWikiFromPublishedCorpus } from './ado-wiki-bridge.js';
import { createKnowledgeFact, type KnowledgeWorkItem } from './ado-knowledge-provenance.js';
import { buildKnowledgeGraph, createKnowledgeEdge } from './ado-knowledge-graph.js';
import { assembleKnowledgeComments, createKnowledgeComment } from './ado-knowledge-comments.js';
import { SqliteSyncStore } from './ado/m6/sqlite-store.js';
import { MemorySyncStore } from './ado/m6/store.js';
import { SyncCoordinator } from './ado/m6/sync.js';

type CatalogItem = {
  key: string;
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations: Array<{ rel: string; url: string; attributes?: Record<string, unknown> }>;
  comments?: {
    totalCount: number;
    pages: Array<{
      count: number;
      continuationToken?: string;
      comments: Array<{ id: number; text: string; createdDate: string }>;
    }>;
  };
  expectedStatus: Classification['status'];
  expectedTruthStatus: 'DUPLICATE' | 'SUPERSEDED' | 'CURRENT' | 'CONFLICTING' | 'AMBIGUOUS' | 'NEEDS_REVIEW';
  expectedAdmission: 'PRIMARY' | 'CONTEXT' | 'EVIDENCE' | 'REJECTED' | 'HISTORY' | 'REVIEW';
};

type Scenario = Record<string, unknown> & { key: string; kind: string };
type ErrorScenario = Scenario & {
  status: number;
  expectedCode: string;
  headers?: Record<string, string>;
};
type PaginationScenario = Scenario & {
  pages: Array<{ count: number; value: number[]; continuationToken?: string }>;
  expectedUniqueIds: number[];
};
type GraphScenario = Scenario & { edges: [number, number][] };
type Catalog = {
  version: number;
  origin: string;
  logicalSource: { organization: string; project: string; team: string; board: string };
  items: CatalogItem[];
  scenarios: Scenario[];
};

const catalog = JSON.parse(readFileSync(
  new URL('../../../tests/ado-acceptance/fixtures/catalog.json', import.meta.url),
  'utf8',
)) as Catalog;

const identity: BoardIdentity = {
  organization: { id: 'sample-org', name: 'sample-org' },
  project: { id: 'sample-project', name: 'sample-project' },
  team: { id: 'sample-team', name: 'sample-team' },
  board: { id: 'sample-board', name: 'sample-board' },
};

const backlogScenario = scenario('backlog-discovery') as Scenario & {
  levels: Array<{ name: string; type: Backlog['type']; workItemTypes: string[] }>;
};
const backlogs: readonly Backlog[] = backlogScenario.levels.map((level, index) => ({
  id: level.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name: level.name,
  rank: index,
  type: level.type,
  workItemTypes: level.workItemTypes,
}));

const policy: ReadPolicy = {
  mode: 'READ_ONLY',
  allowlist: [{
    organization: identity.organization.id,
    project: identity.project.id,
    team: identity.team.id,
    board: identity.board.id,
    resources: ['board', 'scope', 'backlogs', 'query', 'workItems', 'comments', 'links'],
  }],
  timeoutMs: 5_000,
  maxResponseBytes: 2_000_000,
  maxPageItems: 100,
  maxPages: 20,
  maxBatchItems: 200,
  rateLimit: { requests: 500, windowMs: 60_000, maxRetryAfterMs: 60_000 },
};

const scopeResponse: ScopeResponse = {
  teamId: identity.team.id,
  field: {
    referenceName: 'System.AreaPath',
    defaultValue: 'sample-project\\Delivery',
    values: [{ value: 'sample-project\\Delivery', includeChildren: true }],
  },
  iterations: [{ id: 'iteration-1', name: 'Sprint', path: 'sample-project\\Sprint' }],
  backlogIteration: { id: 'iteration-root', name: 'All', path: 'sample-project' },
};

function item(key: string): CatalogItem {
  const found = catalog.items.find(entry => entry.key === key);
  if (!found) throw new Error('missing fixture ' + key);
  return found;
}

function scenario(key: string): Scenario {
  const found = catalog.scenarios.find(entry => entry.key === key);
  if (!found) throw new Error('missing scenario ' + key);
  return found;
}

function stage(key: string, extraFields: Record<string, unknown> = {}): RawSourceStage {
  const source = item(key);
  return stageRawSource(JSON.stringify({
    id: source.id,
    rev: source.rev,
    fields: { ...source.fields, ...extraFields },
    relations: source.relations,
  }), key === 'story-custom-fields' ? {
    customFields: {
      retentionDays: 'Custom.RetentionDays',
      enabled: 'Custom.Enabled',
      note: 'Custom.Note',
      policy: 'Custom.Policy',
    },
  } : {});
}

function sourceKind(key: string) {
  return key === 'supporting-evidence' ? 'IMPLEMENTATION_NOTE' as const : 'WORK_ITEM' as const;
}

function semanticQuote(record: SourceRecord): { field: 'title' | 'description' | 'acceptanceCriteria'; text: string } | null {
  for (const field of ['acceptanceCriteria', 'description', 'title'] as const) {
    const value = record[field].trim();
    if (value.split(/\s+/).filter(Boolean).length >= 6) return { field, text: value };
  }
  return null;
}

const semantic: SemanticClassifier = {
  classify(record) {
    const combined = [record.title, record.description, record.acceptanceCriteria].join(' ').toLowerCase();
    const quote = semanticQuote(record);
    if (/either retain or clear|decision is still needed/.test(combined)) {
      return {
        verdict: 'AMBIGUOUS',
        reusable: false,
        category: 'FUNCTIONAL_BEHAVIOR',
        quotes: quote ? [quote] : [],
      };
    }
    if (/manual checks|qa checks|test records|book a room|invite reviewers/.test(combined)) {
      return {
        verdict: 'NOT_KNOWLEDGE',
        reusable: false,
        category: 'QA_EXECUTION',
        quotes: quote ? [quote] : [],
      };
    }
    if (!quote) {
      return {
        verdict: 'AMBIGUOUS',
        reusable: false,
        category: 'PLACEHOLDER',
        quotes: [],
      };
    }
    return {
      verdict: 'VALIDATED',
      reusable: true,
      category: 'FUNCTIONAL_BEHAVIOR',
      quotes: [quote],
    };
  },
};

function classifyFixture(key: string) {
  const source = stage(key);
  const candidate = bridgeCanonicalStageToKnowledge(source, identity);
  const type = candidate.facts.find(entry => entry.field === 'type')?.fact.body ?? '';
  const classifier = type === 'Epic' || type === 'Feature' ? undefined : semantic;
  return {
    source,
    candidate,
    classification: classifyCanonicalKnowledge(candidate, backlogs, classifier, [], sourceKind(key)),
  };
}

function fakeResponses(): FakeResponses {
  const storyComments = item('story-comments').comments;
  return {
    identity,
    scope: scopeResponse,
    backlogs,
    workItems: catalog.items.map(entry => ({
      id: entry.id,
      areaPath: 'sample-project\\Delivery',
      fields: Object.fromEntries(Object.entries(entry.fields).filter(([, value]) =>
        value === null || ['string', 'number', 'boolean'].includes(typeof value))) as Record<string, string | number | boolean | null>,
    })),
    queryIds: catalog.items.map(entry => entry.id),
    comments: storyComments ? {
      [item('story-comments').id]: storyComments.pages.flatMap(page => page.comments.map(comment => ({
        id: String(comment.id),
        text: comment.text,
      }))),
    } : {},
    links: {
      [item('normal-story').id]: [{ relation: 'parent', targetWorkItemId: item('epic-container').id }],
    },
  };
}

function claimFrom(key: string, overrides: Partial<Claim> = {}): Claim {
  const fixture = item(key);
  const canonical = stage(key).canonical;
  const text = canonical.description ?? canonical.acceptanceCriteria.text ?? canonical.title ?? '';
  return {
    id: key,
    text,
    category: 'FUNCTIONAL_BEHAVIOR',
    references: [{ source: 'synthetic', id: String(fixture.id), revision: String(fixture.rev) }],
    supersedes: [],
    ambiguous: false,
    ...overrides,
  };
}

describe('ADO M8 executable acceptance on converged production modules', () => {
  it('C16/C17: keeps transport read-only, maps bounded failures, and completes deduplicated pagination', async () => {
    expect(Object.values(readSemantics).every(value => value === 'READ' || value === 'READ_QUERY')).toBe(true);

    const adapter = new FakeAzureDevOpsAdapter(policy, fakeResponses());
    const context = adapter.createContext();
    expect((await adapter.boardRead(context)).ok).toBe(true);
    const backlogPage = await adapter.backlogsList(context, { index: 0, continuation: null, limit: 10 });
    expect(backlogPage.ok && backlogPage.value.items).toHaveLength(4);
    const batch = await adapter.workItemBatch(context, [item('normal-story').id, item('story-acceptance-criteria').id]);
    expect(batch.ok && batch.value).toHaveLength(2);

    const failureMap = new Map<number, 'UNAUTHENTICATED' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'UPSTREAM_FAILURE'>([
      [401, 'UNAUTHENTICATED'],
      [403, 'UNAUTHORIZED'],
      [429, 'RATE_LIMITED'],
      [503, 'UPSTREAM_FAILURE'],
    ]);
    for (const rawError of catalog.scenarios.filter(entry => entry.kind === 'error')) {
      const error = rawError as ErrorScenario;
      const expected = failureMap.get(error.status);
      expect(error.expectedCode).toBe(expected);
      if (expected === undefined) throw new Error('missing failure mapping');
      const retryAfter = error.headers?.['retry-after'];
      const failed = new FakeAzureDevOpsAdapter(policy, fakeResponses(), {
        failure: expected,
        ...(error.status === 429 && retryAfter !== undefined ? { retryAfterMs: Number(retryAfter) * 1000 } : {}),
      });
      const result = await failed.workItemGet(failed.createContext(), item('normal-story').id);
      expect(result).toMatchObject({ ok: false, code: expected });
      if (!result.ok && error.status === 429) expect(result.retryAfterMs).toBeLessThanOrEqual(policy.rateLimit.maxRetryAfterMs);
    }

    const pagination = scenario('pagination') as PaginationScenario;
    const requirements = backlogs.find(level => level.type === 'requirement')!;
    const pages = pagination.pages.map((page, index) => ({
      backlogId: requirements.id,
      continuation: index === 0 ? null : pagination.pages[index - 1]!.continuationToken ?? null,
      nextContinuation: page.continuationToken ?? null,
      ids: page.value,
    }));
    const plan = planEnumeration([requirements], pages, {
      maxPages: 10, maxPageItems: 100, maxItems: 1000, chunkSize: 100,
    });
    expect(plan.complete).toBe(true);
    expect(plan.items.map(entry => entry.id)).toEqual(pagination.expectedUniqueIds);
  });

  it('C01-C08: normalizes/redacts source data, preserves approved custom fields, comments and graph incompleteness', () => {
    const pii = stageRawSource(JSON.stringify({
      id: 9001,
      rev: 1,
      fields: {
        'System.WorkItemType': 'User Story',
        'System.Title': 'Synthetic privacy check',
        'System.Description': 'Contact alice@example.invalid id 123e4567-e89b-12d3-a456-426614174000 Bearer secret-value',
        'System.ChangedDate': '2026-01-15T00:00:00.000Z',
        'Custom.Unapproved': 'Bearer hidden-secret',
      },
    }));
    expect(pii.rawAudit.json).toContain('alice@example.invalid');
    expect(pii.canonical.description).toContain('[redacted-email]');
    expect(pii.canonical.description).toContain('[redacted-identity]');
    expect(pii.canonical.description).toContain('[redacted-auth]');
    const piiCandidate = bridgeCanonicalStageToKnowledge(pii, identity);
    expect(JSON.stringify(piiCandidate)).not.toContain('alice@example.invalid');
    expect(JSON.stringify(piiCandidate)).not.toContain('secret-value');

    const custom = stage('story-custom-fields');
    expect(custom.canonical.customFields).toEqual({
      retentionDays: 30,
      enabled: false,
      note: null,
      policy: 'Expired drafts are excluded.',
    });
    expect(custom.canonical.customFields).not.toHaveProperty('Unapproved');

    const commentFixture = item('story-comments');
    const commentStage = stage('story-comments');
    const commentCandidate = bridgeCanonicalStageToKnowledge(commentStage, identity);
    const pages = commentFixture.comments!.pages.map((page, index) => ({
      sourceWorkItem: commentCandidate.item,
      revision: commentFixture.rev,
      cursor: index === 0 ? null : commentFixture.comments!.pages[index - 1]!.continuationToken ?? null,
      nextCursor: page.continuationToken ?? null,
      comments: page.comments.map(entry => createKnowledgeComment({
        sourceWorkItem: commentCandidate.item,
        revision: commentFixture.rev,
        changedDate: entry.createdDate,
        commentId: String(entry.id),
        version: 1,
        body: entry.text,
        identityId: 'synthetic-user@example.invalid',
      })),
    }));
    const assembled = assembleKnowledgeComments(pages);
    expect(assembled.complete).toBe(true);
    expect(assembled.comments).toHaveLength(commentFixture.comments!.totalCount);
    expect(JSON.stringify(assembled)).not.toContain('synthetic-user@example.invalid');

    const graphScenario = scenario('graph-cycle') as GraphScenario;
    const graphPairs = graphScenario.edges;
    const scopeId = commentCandidate.item.scopeId;
    const node = (id: number) => {
      const workItem: KnowledgeWorkItem = { scopeId, workItemId: String(id) };
      return {
        item: workItem,
        provenance: createKnowledgeFact({
          sourceWorkItem: workItem,
          revision: 1,
          source: { kind: 'FIELD' as const, name: 'title' },
          changedDate: '2026-01-15T00:00:00.000Z',
        }, '').provenance,
      };
    };
    const nodes = [...new Set(graphPairs.flat())].map(node);
    const edges = graphPairs.map(([source, target], index) =>
      createKnowledgeEdge({
        source: { scopeId, workItemId: String(source) },
        target: { scopeId, workItemId: String(target) },
        type: 'CHILD',
        provenance: {
          sourceWorkItem: { scopeId, workItemId: String(source) },
          revision: 1,
          source: { kind: 'RELATION', relationId: 'cycle-' + index },
          changedDate: '2026-01-15T00:00:00.000Z',
        },
      }));
    expect(buildKnowledgeGraph(nodes, edges).validHierarchy).toBe(false);
  });

  it('C09-C12: applies source-defined gate policy with resolved four-status algebra', () => {
    for (const fixture of catalog.items) {
      const result = classifyFixture(fixture.key).classification;
      expect(result.status, fixture.key).toBe(fixture.expectedStatus);
    }
    expect(classifyFixture('supporting-evidence').classification.status).toBe('SUPPORTING_EVIDENCE');
    expect(classifyFixture('valid-support-requirement').classification.status).toBe('PROMOTED');
    expect(classifyFixture('execution-only-task').classification.status).toBe('REJECTED');
  });

  it('C14/G09: keeps duplicate, superseded, conflicting and ambiguous truth orthogonal to relevance', () => {
    const duplicate = resolveConcept('preference-save', [claimFrom('normal-story'), claimFrom('duplicate-story')]);
    expect(duplicate.status).toBe('DUPLICATE');
    expect(truthStatusForClaim(duplicate, 'duplicate-story')).toBe('DUPLICATE');

    const superseded = resolveConcept('preference-history', [
      claimFrom('superseded-story'),
      claimFrom('normal-story', { supersedes: ['superseded-story'] }),
    ]);
    expect(truthStatusForClaim(superseded, 'superseded-story')).toBe('SUPERSEDED');
    expect(truthStatusForClaim(superseded, 'normal-story')).toBe('CURRENT');

    const conflicting = resolveConcept('preference-conflict', [
      claimFrom('normal-story'),
      claimFrom('conflicting-story'),
    ]);
    expect(conflicting.status).toBe('CONFLICTING');
    expect(truthStatusForClaim(conflicting, 'conflicting-story')).toBe('CONFLICTING');

    const ambiguous = resolveConcept('preference-ambiguity', [
      claimFrom('ambiguous-story', { ambiguous: true }),
    ]);
    expect(ambiguous.status).toBe('AMBIGUOUS');
  });

  it('C13/C15/G08: routes unresolved truth to review and only current promoted evidence into Wiki retrieval', () => {
    const normal = classifyFixture('normal-story');
    const conflict = classifyFixture('conflicting-story');
    const resolution = resolveConcept('preference-conflict', [
      claimFrom('normal-story'),
      claimFrom('conflicting-story'),
    ]);
    const store = new MemorySyncStore();
    const coordinator = new SyncCoordinator(store);
    const sources = [normal, conflict];
    coordinator.start({
      syncRunId: 'conflict-run',
      scope: { organizationId: 'sample-org', projectId: 'sample-project', teamId: 'sample-team', boardId: 'sample-board' },
      mode: 'FULL',
      trigger: { kind: 'MANUAL' },
      inventory: {
        snapshotId: 'conflict-inventory',
        complete: true,
        items: sources.map(entry => toSyncMembership(entry.source, ['requirements'])),
      },
      policy: { gateVersion: normal.classification.policyVersion, minimumPromoted: 2, allowRejections: true },
      at: '2026-01-15T00:00:00.000Z',
    });
    coordinator.checkpoint('conflict-run', 1, {
      batchId: 'conflict-batch',
      observations: sources.map(entry => toSyncObservation(entry.source, entry.candidate, {
        expectedCommentIds: [], commentsComplete: true, comments: [],
        relationsComplete: true, relations: [], linksComplete: true, links: [],
      })),
      failures: [],
    }, '2026-01-15T00:00:00.000Z');
    for (const entry of sources) {
      const sourceRow = store.read().sourceStaging.find(row => row.itemId === entry.source.canonical.id)!;
      coordinator.decide(
        'conflict-run',
        coordinator.inspect('conflict-run').run.version,
        gateDecisionFromClassification(
          entry.source.canonical.id,
          sourceRow.fingerprint,
          entry.classification,
          truthStatusForClaim(resolution, entry === normal ? 'normal-story' : 'conflicting-story'),
        ),
        '2026-01-15T00:00:00.000Z',
      );
    }
    expect(coordinator.finish('conflict-run', coordinator.inspect('conflict-run').run.version, '2026-01-15T00:00:00.000Z').published).toBe(true);
    const corpus = coordinator.published({
      organizationId: 'sample-org', projectId: 'sample-project', teamId: 'sample-team', boardId: 'sample-board',
    })!;
    expect(corpus.promoted.sources).toHaveLength(0);
    expect(corpus.review.sources.map(source => source.itemId).sort()).toEqual([
      item('normal-story').id, item('conflicting-story').id,
    ].sort());

    const current = classifyFixture('normal-story');
    const currentStore = new MemorySyncStore();
    const currentCoordinator = new SyncCoordinator(currentStore);
    currentCoordinator.start({
      syncRunId: 'current-run',
      scope: { organizationId: 'sample-org', projectId: 'sample-project', teamId: 'sample-team', boardId: 'sample-board' },
      mode: 'FULL', trigger: { kind: 'MANUAL' },
      inventory: { snapshotId: 'current-inventory', complete: true, items: [toSyncMembership(current.source, ['requirements'])] },
      policy: { gateVersion: current.classification.policyVersion, minimumPromoted: 1, allowRejections: true },
      at: '2026-01-15T00:00:00.000Z',
    });
    currentCoordinator.checkpoint('current-run', 1, {
      batchId: 'current-batch',
      observations: [toSyncObservation(current.source, current.candidate, {
        expectedCommentIds: [], commentsComplete: true, comments: [],
        relationsComplete: true, relations: [], linksComplete: true, links: [],
      })], failures: [],
    }, '2026-01-15T00:00:00.000Z');
    const currentSource = currentStore.read().sourceStaging[0]!;
    currentCoordinator.decide('current-run', 2,
      gateDecisionFromClassification(current.source.canonical.id, currentSource.fingerprint, current.classification, 'CURRENT'),
      '2026-01-15T00:00:00.000Z');
    currentCoordinator.finish('current-run', 3, '2026-01-15T00:00:00.000Z');
    const topic: TopicDefinition = {
      id: 'requirements',
      title: 'Requirements',
      hierarchyIds: [],
      groupingKeys: ['requirements'],
      conceptIds: [],
    };
    const wiki = buildWikiFromPublishedCorpus(currentCoordinator.published({
      organizationId: 'sample-org', projectId: 'sample-project', teamId: 'sample-team', boardId: 'sample-board',
    })!, { topics: [topic] });
    expect(wiki.ok).toBe(true);
    if (!wiki.ok) return;
    const response = queryKnowledge(wiki.value, { keyword: 'save a preference' });
    expect(response.status).toBe('ANSWERED');
    expect(response.claims.every(claim => claim.provenance[0]?.reference.classification?.truthStatus === 'CURRENT')).toBe(true);
  });

  it('M6 durability: reopens a private SQLite store without losing a running sync', () => {
    const dataRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iris-ado-m8-')));
    try {
      let store = new SqliteSyncStore(dataRoot);
      const coordinator = new SyncCoordinator(store);
      coordinator.start({
        syncRunId: 'durable-run',
        scope: { organizationId: 'sample-org', projectId: 'sample-project', teamId: 'sample-team', boardId: 'sample-board' },
        mode: 'FULL', trigger: { kind: 'MANUAL' },
        inventory: { snapshotId: 'durable-inventory', complete: true, items: [] },
        policy: { gateVersion: 'gate-v1', minimumPromoted: 0, allowRejections: true },
        at: '2026-01-15T00:00:00.000Z',
      });
      const generation = store.read().generation;
      store.close();
      store = new SqliteSyncStore(dataRoot);
      expect(store.read().generation).toBe(generation);
      expect(new SyncCoordinator(store).inspect('durable-run').run.status).toBe('RUNNING');
      store.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
