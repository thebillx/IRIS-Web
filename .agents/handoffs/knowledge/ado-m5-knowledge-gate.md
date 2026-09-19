# ADO M5 Knowledge Relevance / Quality Gate

Mission: `IRIS_VNEXT_ADO_D_M5_KNOWLEDGE_GATE`
Worker: `WORKER_ADO_D`
Date: 2026-09-15

## Verified starting point

- Worktree: `/Users/bill/iris-wt-ado-m5-knowledge-gate`
- Branch: `codex/ado-m5-knowledge-gate`
- Clean initial Git status; exact HEAD/base: `5f6b35e034d7a8d8143c0a7558b507316daa3c32`.
- Read root `AGENTS.md`. No nested instructions apply to these new paths.
- No separate ADO Knowledge/Wiki M5 requirements document was found in this worktree or the primary checkout's docs/handoffs. The supplied mission is the requirements baseline.
- No legacy repository material was consulted or reused.

## Deliverables and invariant ownership

Direct-import modules under `packages/shared/src/ado/knowledge-gate/`:

- `models.ts`: four primary statuses, ten knowledge/eight non-knowledge categories, normalized source records, versioned type policy, semantic classifier contract, audit signals and provenance.
- `gate.ts`: pure synchronous deterministic filtering followed by optional semantic validation. No classifier means no promotion. Every exit supplies a status, reason, signals, score, policy version and source references when valid.
- `concepts.ts`: exact-claim reconciliation within one caller-selected concept, supersession graph validation, conflict/ambiguity handling, and explicit projection/default retrieval helpers.
- `gate.test.ts`: deterministic fake semantic classifier and 43 synthetic regressions.

No imports from live ADO, storage, daemon or capability services; no I/O, persistence, external LLM, network, new dependency or shared index export. Existing package scripts discover the new tests and typecheck the modules without configuration changes.

## Evaluation order

1. Validate normalized record and versioned policy; invalid input is rejected.
2. Gather explainable description, acceptance-criteria and hierarchy signals.
3. Thin container with substantively meaningful child metadata becomes context only.
4. Reject empty placeholders and recognized execution/admin/data/deployment/automation/housekeeping/coordination/support-only phrases before semantic invocation.
5. Typed test results, clarifications, links and implementation notes go only to evidence.
6. Apply type policy. Tasks and Stories default rejected; containers default context; Bugs and Test Cases default evidence with semantic promotion disabled in v1. Unknown types reject.
7. Promotion requires a successful semantic verdict, reusable knowledge category and substantive exact source quotations. Missing, invalid, failed, ambiguous and non-knowledge evidence cannot promote.

Noise matching is deliberately anchored to entire substantive fields, not substring keywords. A requirement saying the product must “support” something is not rejected by that word. A noise-like title with substantive product behavior elsewhere is left for semantic evaluation rather than discarded. These rules are conservative English phrase rules, not an exhaustive natural-language noise detector. The score is an audit/ranking aid, never an authorization threshold.

## Reconciliation and projection

The integrator selects a concept identity and provides normalized claims and explicit supersession edges. This worker does not infer fuzzy semantic identity or chronology from IDs/timestamps. Equality is category plus case-sensitive text with whitespace normalized. Multiple equal current claims yield one concept resolution with all current and historical source references preserved. Different current claims yield `CONFLICTING`, no selected current claim, and no automatic merge. Ambiguous current claims yield `AMBIGUOUS`. Missing targets, duplicate claim IDs, empty claims and supersession cycles yield `NEEDS_REVIEW`. Superseded claims are individually labeled `SUPERSEDED` and retained in historical provenance; only terminal current claims compete as current truth. Duplicate/superseded/conflicting audit signals are separate from the primary relevance score.

Projection mapping:

| Classification | Destination |
| --- | --- |
| PROMOTED | Primary Knowledge Store |
| CONTEXT_ONLY | Graph/context only |
| SUPPORTING_EVIDENCE | Evidence index only |
| REJECTED | Audit/quarantine only |

Non-current truth states override this mapping to quarantine. Default semantic retrieval includes only promoted current/duplicate knowledge, never rejected, context-only or evidence-only records. The integration must reconcile candidates before calling projection helpers, pass the actual resolved truth status (the helpers' default is `CURRENT` for standalone decisions), and persist the resolution's complete provenance rather than only its representative `currentClaim`. Source records remain in the collector/audit layer; this module does not write or enforce a database boundary itself.

## Integration responsibilities / limitations

- Supply normalized `kind` and validated child-substance metadata; do not infer source kind from a bare keyword. Semantic validation is supplied through a trusted classifier implementation, not an untrusted record field. Quotes establish source grounding, not the truthfulness of the semantic verdict.
- Keep the deterministic fake test-only. No production classifier is supplied or invoked here.
- Reconciliation accepts typed `Claim` records, validates graph/provenance values, and does not parse arbitrary untrusted transport payloads. The transport adapter must normalize/validate those payloads before invoking this pure contract.
- Apply explicit policy version changes for customized type maps; review any decision to enable Bug/Test Case promotion beyond default v1.
- Preserve source revisions, historical provenance and conflicting claims. Do not project a conflicting resolution's individual promoted members as independent official requirements.
- No Wiki connectivity, fetch/collect integration, persistent store, scheduling, global catalog or retrieval backend was modified.

## Validation

- `node scripts/node24.mjs --bin vitest run packages/shared/src/ado/knowledge-gate/gate.test.ts`: PASS, 43 tests.
- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS across workspace packages.
- `pnpm build`: PASS, web and runtime.
- `git diff --check`: PASS (also checked staged files before commit).
- Full repository `pnpm test`: intentionally NOT RUN while D4 runs.
- Installed existing locked dependencies with `pnpm install --frozen-lockfile --offline`; no manifest/lockfile changes. Host pnpm emits a Node 22 engine warning; repository scripts run validation using their canonical Node >=24 wrapper.
- Initial checks exposed deterministic claim ordering and older TypeScript-target compatibility issues; corrected locally and reran the complete required validation chain successfully.

## Handoff

Next step: `ADO_INTEGRATION`. Commit only this directory and this handoff; no push. Shared integration zone unchanged. No customer/project-specific identifiers in core rules or test fixtures. No implementation blocker; separate external requirements reconciliation remains an integration review item if such a document is supplied later.

## Durable handoff gate closure

Mission: `IRIS_VNEXT_ADO_D_HANDOFF_GATE_CLOSE`
Verified: 2026-09-15.

```text
HANDOFF_READY=YES
KNOWLEDGE_GATE_READY=YES
PRIMARY_STATUSES_DEFINED=YES
DETERMINISTIC_FILTER_READY=YES
PROMOTION_POLICY_READY=YES
FINAL_IMPLEMENTATION_HEAD_SHA=bc34bb0c005529d890cac63be12be556a08a4260
IMPLEMENTATION_UNCHANGED=YES
FOCUSED_VALIDATION=PASS (43/43; retained validation receipt)
SHARED_INTEGRATION_ZONE_CHANGED=NO
PUSHED=NO
NEXT_STEP=ADO_INTEGRATION
```

The implementation checkpoint is the exact SHA above on `codex/ado-m5-knowledge-gate` in `/Users/bill/iris-wt-ado-m5-knowledge-gate`. The worktree was clean at verification, and implementation/tests have not changed since validation; no tests were rerun. The gate-closure commit changes only this handoff. Its final delivery HEAD is the enclosing handoff-only commit, returned in the mission result and resolvable with `git log -1 --format=%H -- .agents/handoffs/knowledge/ado-m5-knowledge-gate.md`.
