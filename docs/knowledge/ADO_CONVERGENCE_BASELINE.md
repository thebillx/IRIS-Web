# ADO Knowledge MVP convergence baseline

Date: 2026-09-19

## Canonical baseline

- Integration branch: `codex/ado-knowledge-mvp-convergence`
- Base: `origin/main`
- Base SHA: `718e4f6d372b38b7fb311c23ced88c016d89cce3`
- IRIS runtime/catalog baseline: 2.4.0
- The current main tree has no ADO knowledge implementation under `apps/runtime/src/ado` or `packages/shared/src/ado` before this convergence work.
- Do not use the divergent local `main` ref as an integration authority. The branch was created from fetched `origin/main`.

## Legacy worker inventory

All M1-M8 worker branches are isolated foundations from an older Phase 5 lineage. None of their heads is an ancestor of current `origin/main`. They are source material for reviewed convergence, not merge-ready branches.

| Milestone | Worker branch | Implementation commit | Scope |
| --- | --- | --- | --- |
| M1/M2 | `codex/ado-m1-m2-foundation` | `94f636e582d6298d8e478083c93cb56ab5e76657` | Read-only adapter contract, board identity/scope discovery, backlog enumeration planner, fake adapter |
| M3 | `codex/ado-m3-collection` | `502108bed17880b83c77dcf31bad20a5c3698ad6` | Collection, sanitization and normalization package |
| M4 | `codex/ado-m4-graph-provenance` | `c392f585ba15c9472b6787970656cb21ccf07023` | Graph, comments and provenance |
| M5 | `codex/ado-m5-knowledge-gate` | `bc34bb0c005529d890cac63be12be556a08a4260` | Relevance and quality gate |
| M6 | `codex/ado-m6-sync` | `3d5739849d3cbeeedd40deeadc60e4a52ae155ae` | Persistence and sync foundation |
| M7 | `codex/ado-m7-wiki` | `088e43fff180e85b8d1879671015fe057cc21157` | Wiki projection, retrieval and incremental projection |
| M8 | `codex/ado-m8-acceptance` | `f16814650bd5588e073596cef56597280b49bffe` | Generic acceptance fixtures/contracts |

## M1/M2 convergence decision

The M1/M2 foundation is being ported first because its design remains compatible with the current IRIS governance direction:

- exactly named read operations; no generic HTTP escape hatch
- opaque auth/session references rather than agent-visible credentials
- exact organization/project/team/board ID tuple allowlists
- explicit resource allowlists and bounded rate/timeout/page/batch limits
- fail-closed discovery for missing/ambiguous target identities
- parent-bound identity resolution
- explicit Area Path scope with separator-safe descendant matching
- source-defined backlog hierarchy rather than hardcoded Epic/Feature/PBI labels
- deterministic continuation and membership provenance planning
- no production network authority introduced by the isolated foundation

The port is intentionally still a foundation. Production transport must be wired through current IRIS capability/effect authority and current credential ownership before any live ADO call.

## Official Azure DevOps API research used during convergence

Verified against current Microsoft Learn Azure DevOps REST documentation:

- Work Item Tracking REST API remains documented at API version 7.1.
- WIQL query execution is a POST operation but semantically read-only for this integration; authorization should still derive READ + NETWORK effects rather than granting generic write authority.
- Work Items Batch accepts at most 200 work item IDs per request. The production adapter must enforce a server-side batch ceiling at or below this limit.
- Single work-item reads support `$expand`, including relations, which can support bounded relation capture without creating write authority.
- Work-item comments are separately pageable; comment pagination must not be conflated with work-item enumeration cursors.
- Work-item revisions are separately paged and should be treated as their own provenance stream if M4/M6 use historical revision evidence.
- The documented read scope for work-item tracking is `vso.work`; MVP should remain read-only unless a later milestone has an explicit write requirement.

## Integration sequence

1. Converge and validate M1/M2 on current main.
2. Converge M3 normalization against the accepted M1/M2 contracts.
3. Converge M4 provenance/graph against normalized records.
4. Converge M5 quality gates before persistence-derived wiki publication.
5. Converge M6 full + incremental sync with restart-safe/idempotent receipts.
6. Converge M7 wiki projection/retrieval.
7. Converge M8 acceptance and live ADO validation.
8. Only then prepare protected-main handoff.

## Non-goals for the MVP convergence

- no Figma/external-document authority in M1-M8
- no generic browser/HTTP bypass for Azure DevOps
- no ADO mutation/write operations unless separately approved and specified
- no secret values in agent-visible logs, artifacts, diagnostics or persisted knowledge
- no direct use of old worker worktrees as runtime sources
