import { createHash } from 'node:crypto';
import type { RawSourceStage } from '@iris/ado';
import type { BoardIdentity } from './ado/discovery.js';
import {
  createKnowledgeFact,
  knowledgeAssert,
  knowledgeId,
  type KnowledgeFact,
  type KnowledgeWorkItem,
} from './ado-knowledge-provenance.js';
import type { KnowledgeGraphNode } from './ado-knowledge-graph.js';

export interface CanonicalKnowledgeFieldCandidate {
  readonly field: 'type' | 'title' | 'state' | 'description' | 'acceptanceCriteria' | 'areaPath' | 'iterationPath' | 'boardColumn' | 'tags';
  readonly status: 'CANDIDATE';
  readonly searchable: false;
  readonly fact: KnowledgeFact;
}

export interface CanonicalKnowledgeCandidate {
  readonly status: 'CANDIDATE';
  readonly validation: 'UNVALIDATED_SOURCE';
  readonly searchable: false;
  readonly sourceRawHash: string;
  readonly sourceNormalizerVersion: 'm3-v1';
  readonly item: KnowledgeWorkItem;
  readonly node: KnowledgeGraphNode;
  readonly facts: readonly CanonicalKnowledgeFieldCandidate[];
}

export function adoKnowledgeScopeId(identity: BoardIdentity): string {
  const ids = [identity.organization.id, identity.project.id, identity.team.id, identity.board.id];
  for (const id of ids) knowledgeId(id);
  return `ado-board:${createHash('sha256').update(JSON.stringify(ids)).digest('hex')}`;
}

export function bridgeCanonicalStageToKnowledge(
  stage: RawSourceStage,
  identity: BoardIdentity,
): CanonicalKnowledgeCandidate {
  validateStage(stage);
  const item: KnowledgeWorkItem = {
    scopeId: adoKnowledgeScopeId(identity),
    workItemId: String(stage.canonical.id),
  };
  const source = {
    sourceWorkItem: item,
    revision: stage.canonical.revision,
    changedDate: stage.canonical.changedDate,
  } as const;

  const nodeFact = createKnowledgeFact({ ...source, source: { kind: 'FIELD', name: 'id' } }, item.workItemId);
  const fields: Array<readonly [CanonicalKnowledgeFieldCandidate['field'], string | null]> = [
    ['type', stage.canonical.type],
    ['title', stage.canonical.title],
    ['state', stage.canonical.state],
    ['description', stage.canonical.description],
    ['acceptanceCriteria', stage.canonical.acceptanceCriteria.text],
    ['areaPath', stage.canonical.areaPath],
    ['iterationPath', stage.canonical.iterationPath],
    ['boardColumn', stage.canonical.boardColumn],
    ['tags', stage.canonical.tags.length === 0 ? null : stage.canonical.tags.join('\n')],
  ];
  const facts = fields.flatMap(([field, body]) => body === null || body.length === 0 ? [] : [{
    field,
    status: 'CANDIDATE' as const,
    searchable: false as const,
    fact: createKnowledgeFact({ ...source, source: { kind: 'FIELD' as const, name: field } }, body),
  }]);

  return Object.freeze({
    status: 'CANDIDATE',
    validation: 'UNVALIDATED_SOURCE',
    searchable: false,
    sourceRawHash: stage.rawHash,
    sourceNormalizerVersion: stage.canonical.provenance.normalizerVersion,
    item: Object.freeze({ ...item }),
    node: Object.freeze({
      item: Object.freeze({ ...item }),
      provenance: nodeFact.provenance,
    }),
    facts: Object.freeze(facts),
  });
}

function validateStage(stage: RawSourceStage): void {
  knowledgeAssert(stage !== null && typeof stage === 'object'
    && stage.kind === 'raw-source-stage'
    && stage.validation === 'unvalidated'
    && stage.searchable === false, 'Expected unvalidated M3 raw source stage');
  knowledgeAssert(/^[a-f0-9]{64}$/.test(stage.rawHash)
    && stage.rawHash === stage.canonical.provenance.rawHash, 'M3 raw source hash mismatch');
  knowledgeAssert(stage.revision === stage.canonical.revision
    && stage.changedDate === stage.canonical.changedDate, 'M3 stage version identity mismatch');
  knowledgeAssert(stage.canonical.provenance.normalizerVersion === 'm3-v1', 'Unsupported M3 normalizer version');
}
