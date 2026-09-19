# ADO M5 convergence review

Date: 2026-09-19
Legacy source: `codex/ado-m5-knowledge-gate` / `bc34bb0c005529d890cac63be12be556a08a4260`

## Reused invariants

- Four explicit primary dispositions: PROMOTED, CONTEXT_ONLY, SUPPORTING_EVIDENCE, REJECTED.
- Promotion never happens from score/type alone.
- Semantic promotion requires a validated reusable knowledge category plus an exact substantive quote from canonical source fields.
- Rejected/context/evidence content is excluded from default retrieval.
- Conflicting, ambiguous, superseded and review-needed concept states are quarantined from default retrieval.
- Reconciliation keeps all source references and does not silently merge divergent claims.

## Convergence correction: source-defined work-item types

The legacy default policy contained standard English work-item type names. That is not sufficient for generic Azure DevOps organizations with custom processes.

Current convergence extends M1/M2 backlog discovery with the provider-defined backlog `type` field:

- `portfolio` -> container context by default, semantic promotion allowed
- `requirement` -> rejected by default, semantic promotion allowed
- `task` -> rejected by default, semantic promotion disabled

The actual work-item type names come only from each discovered backlog level's `workItemTypes`. No Epic/Feature/User Story/PBI/Task string is required by the integration policy. If a work-item type appears in more than one discovered backlog level, policy generation fails closed instead of guessing which authority wins.

This matches the Azure DevOps Work Backlogs 7.1 contract, which exposes both backlog `type` and project/process `workItemTypes`, including team-specific bug placement behavior.

## Candidate boundary

M3 -> M4 records remain CANDIDATE / UNVALIDATED_SOURCE / non-searchable.
The M5 bridge constructs the gate input only from canonical M4 facts and exact provenance. It does not read raw audit JSON, credentials, transport metadata or external documents.

A positive classification does not mutate the M4 candidate. Publication is still owned by M6 persistence/sync after a version-bound gate decision.

## External document boundary

Links, designs, test results and SharePoint/Figma references remain supporting metadata/evidence only in M1-M8. M5 cannot promote external document content because external document acquisition/authority is not part of the MVP. That remains M9/post-MVP.
