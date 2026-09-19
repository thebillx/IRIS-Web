import { createHash } from 'node:crypto';
import {
  classifyKnowledge,
  gatePolicyFromBacklogs,
  type Classification,
  type SemanticClassifier,
  type SourceRecord,
} from '@iris/shared/ado/knowledge-gate';
import type { Backlog } from './ado/discovery.js';
import type { CanonicalKnowledgeCandidate } from './ado-knowledge-bridge.js';
import { knowledgeAssert } from './ado-knowledge-provenance.js';

export interface GateChildCandidate {
  readonly candidate: CanonicalKnowledgeCandidate;
  readonly substantive: boolean;
}

export function policyVersionForBacklogs(backlogs: readonly Backlog[]): string {
  knowledgeAssert(Array.isArray(backlogs) && backlogs.length > 0, 'Backlog policy requires discovered levels');
  const digest = createHash('sha256').update(JSON.stringify(
    [...backlogs]
      .map(backlog => ({
        id: backlog.id,
        rank: backlog.rank,
        type: backlog.type,
        workItemTypes: [...backlog.workItemTypes],
      }))
      .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id)),
  )).digest('hex');
  return `ado-discovered-backlogs/v1:${digest}`;
}

export function toGateSourceRecord(
  candidate: CanonicalKnowledgeCandidate,
  children: readonly GateChildCandidate[] = [],
): SourceRecord {
  assertCandidate(candidate);
  const facts = new Map(candidate.facts.map(entry => [entry.field, entry.fact.body] as const));
  const workItemType = facts.get('type') ?? '';
  const normalizedChildren = children.map(entry => {
    assertCandidate(entry.candidate);
    knowledgeAssert(entry.candidate.item.scopeId === candidate.item.scopeId, 'Gate child crosses authorized ADO scope');
    knowledgeAssert(typeof entry.substantive === 'boolean', 'Gate child substantive flag must be explicit');
    return {
      reference: {
        source: candidate.item.scopeId,
        id: entry.candidate.item.workItemId,
        revision: String(entry.candidate.node.provenance.revision),
      },
      substantive: entry.substantive,
    };
  });
  return Object.freeze({
    reference: {
      source: candidate.item.scopeId,
      id: candidate.item.workItemId,
      revision: String(candidate.node.provenance.revision),
    },
    workItemType,
    kind: 'WORK_ITEM',
    title: facts.get('title') ?? '',
    description: facts.get('description') ?? '',
    acceptanceCriteria: facts.get('acceptanceCriteria') ?? '',
    children: Object.freeze(normalizedChildren),
  });
}

export function classifyCanonicalKnowledge(
  candidate: CanonicalKnowledgeCandidate,
  backlogs: readonly Backlog[],
  semantic?: SemanticClassifier,
  children: readonly GateChildCandidate[] = [],
): Classification {
  const policy = gatePolicyFromBacklogs(backlogs, policyVersionForBacklogs(backlogs));
  return classifyKnowledge(toGateSourceRecord(candidate, children), policy, semantic);
}

function assertCandidate(candidate: CanonicalKnowledgeCandidate): void {
  knowledgeAssert(candidate !== null && typeof candidate === 'object'
    && candidate.status === 'CANDIDATE'
    && candidate.validation === 'UNVALIDATED_SOURCE'
    && candidate.searchable === false, 'Expected unvalidated canonical knowledge candidate');
}
