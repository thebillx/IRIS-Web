# WORKER_ADO_G handoff — M8 acceptance foundation

Mission: `IRIS_VNEXT_ADO_G_M8_ACCEPTANCE_FIXTURES`
Date: 2026-09-15
Root: `/Users/bill/iris-wt-ado-m8-acceptance`
Branch: `codex/ado-m8-acceptance`
Verified starting HEAD: `5f6b35e034d7a8d8143c0a7558b507316daa3c32`
Starting status: clean. The initial terminal was in `/Users/bill/iris`; it was
inspected only, then all writes and validation used the expected worktree.
Owner work in the original root was not modified.

## Delivered

- `tests/ado-acceptance/fixtures/catalog.json`: 34 generic fixtures (20 work
  items, 14 scenario records), including all requested item shapes, errors,
  pagination, bounded/malformed inputs, graph cycles and classifier errors.
- `tests/ado-acceptance/catalog.test.mjs`: six executable metadata/schema tests
  using Node's built-in runner, no production imports or new dependencies.
- `tests/ado-acceptance/README.md`: envelope/generator semantics, standalone
  command and truthful readiness states.
- `docs/acceptance/ADO_M8_ACCEPTANCE.md`: 17 contract coverage rows, nine gate
  regressions, sanitized audit contract, exact four live levels and eight MVP
  gate groupings. Production behavior remains EXECUTABLE_PENDING.

All fixtures were written from scratch with generic names, synthetic IDs,
reserved invalid hosts and no customer identity or reverse mapping. No real
sample or legacy source, tests, manifests or documentation was copied.
CUSTOMER_SPECIFIC_IDENTIFIERS_IN_CORE=NO

## Source availability limitation

Read root AGENTS.md, current vNext acceptance matrix/implementation gates,
cross-package test guidance and existing runtime test conventions. The named
ADO Knowledge/Wiki M8 source plan, separate MVP acceptance source and real-shape
samples were not found in the expected tree, main-tree documentation, adjacent
ADO worktree Markdown or legacy reference documentation. No live ADO access
was used to fill that gap. Consequently milestone/owner groupings and proposed
four-status terminology are explicitly mission-derived, not verified against
that absent plan. Integration must reconcile these before release sign-off.

Synthetic PII generation is specified for future in-memory testing; no production
redactor has been exercised. Fixture regex hygiene guards are not a universal
PII detector. Schema success must never be reported as an M1–M8 production PASS.

## Validation evidence

Executed on macOS with repository wrapper selecting Node v24.19.0:

| Command | Result |
|---|---|
| `node scripts/node24.mjs tests/ado-acceptance/catalog.test.mjs` | PASS, 6 tests, 0 failures, 0 skipped |
| `pnpm lint` | PASS after fixing two acceptance-test undefined-global lint errors |
| `pnpm typecheck` | PASS, all workspace typechecks |
| `pnpm build` | PASS, web and runtime builds |
| `git diff --check` | PASS |

Dependencies were installed from the existing lockfile with
`pnpm install --frozen-lockfile --offline`; no manifest/lock changes.
Outer pnpm warned about shell Node v22.23.2; the repository wrapper selected
Node v24.19.0 for actual checks. Full repository `pnpm test` was deliberately
not run while D4 runs. Only the acceptance-local six-test suite was executed.

## Integration next steps

1. Reconcile the unavailable source plan, milestone ownership and status vocabulary.
2. Bind future tests to real production modules, withholding oracle fields from
   parser/classifier input. Extend generated hostile/PII cases in memory.
3. Execute C01–C17 and G01–G09, attaching revision/command/digest/result evidence;
   prove audit privacy, quarantine and stale-index isolation, not just counts.
4. Obtain separately authorized read-only live access and progress strictly
   single Work Item → Feature subtree → one backlog level → full Board.
5. Close MVP gates only on actual evidence; do not confuse fixture readiness
   with release readiness or publish the draft to ADO.

SHARED_INTEGRATION_ZONE_CHANGED=NO
PUSHED=NO
NEXT_STEP=ADO_INTEGRATION_AFTER_GENERIC_BASELINE

This handoff belongs to the commit that introduces these acceptance-only paths;
obtain its immutable revision with `git log -1 --format=%H -- .agents/handoffs/knowledge/ado-m8-acceptance.md`.

## Durable handoff gate closure — 2026-09-15

Mission: `IRIS_VNEXT_ADO_G_HANDOFF_GATE_CLOSE`
Workstream: `ADO_M8_ACCEPTANCE_RELEASE_READINESS`
Verified M8 implementation commit: `f16814650bd5588e073596cef56597280b49bffe`.
This closure changes only this handoff; fixtures, tests, acceptance semantics
and production code remain unchanged.

HANDOFF_READY=YES
FIXTURE_CATALOG_READY=YES
AUDIT_CONTRACT_READY=YES
CONTRACT_TEST_MATRIX_READY=YES
KNOWLEDGE_GATE_REGRESSION_MATRIX_READY=YES
LIVE_TEST_PROGRESSION_READY=YES
M8_AUTHORITATIVE_PLAN_RECONCILED=YES
MVP_PRODUCTION_ACCEPTANCE=EXECUTABLE_PENDING

The readiness markers certify the existing foundation artifacts and specified
live progression, not executed production acceptance or live ADO integration.
The validation evidence above belongs to the unchanged implementation commit.

Policy reconciliation is durably recorded in
`.agents/handoffs/knowledge/ado-integration-readiness.md` at commit
`82418a321ffd780018181ca7414d5504da820ba2`, section
“M8 source-plan reconciliation”. It reconciles the owner-supplied policy and MVP
principles, not an unseen full source document. This supersedes the historical
source-availability blocker and integration step 1 above: no further policy
receipt is required for those resolved decisions. Applying the recorded policy,
vocabulary, fixture-adapter and integration adjustments remains future integration
work; this handoff-only closure does not implement them or alter acceptance
semantics. Live ADO integration has not occurred, so production acceptance
remains executable pending. Integration proceeds only after the generic baseline.

## 2026-09-19 convergence execution receipt

The M8 fixture foundation is now bound to the converged M1–M7 production modules
on `codex/ado-knowledge-mvp-convergence`.

Resolved policy corrections applied:
- relevance statuses: PROMOTED / CONTEXT_ONLY / SUPPORTING_EVIDENCE / REJECTED
- review/quarantine is orthogonal TruthStatus, not a fifth relevance status
- supporting evidence remains lower-authority and controlled
- M6 persists classification category/digest/evidence plus TruthStatus
- CURRENT/DUPLICATE promoted content can enter the M7 knowledge projection
- SUPERSEDED goes to history; CONFLICTING/AMBIGUOUS/NEEDS_REVIEW go to review
  and are excluded from substantive Wiki authority
- source-defined backlog type/workItemTypes remain the generic process authority

Executable local evidence:
- fixture catalog schema: PASS 6/6
- converged M8 production-module acceptance: PASS 6/6
- @iris/ado focused suite: PASS 35/35
- @iris/shared ADO Gate + Wiki focused suite: PASS 107/107
- @iris/runtime converged ADO focused suite: PASS 161/161
- typecheck: PASS
- lint: PASS
- build: PASS (final C7 checkpoint)

The converged acceptance exercises read-only adapter/error/pagination behavior,
PII-safe canonical projection, approved custom fields, comment pagination,
graph-cycle handling, all 20 fixture relevance oracles, duplicate/superseded/
conflicting/ambiguous truth state, M6 review isolation, grounded Wiki retrieval
with classification provenance, and durable SQLite reopen behavior.

M8_LOCAL_PRODUCTION_ACCEPTANCE=PASS
M8_LIVE_ADO_LEVEL_1=PASS
M8_LIVE_ADO_LEVEL_2=PASS
M8_LIVE_ADO_LEVEL_3=PASS
M8_LIVE_ADO_LEVEL_4=PASS
ZERO_ADO_MUTATION_LIVE_LEDGER=PASS
LIVE_REVISION_STABILITY=PASS
LIVE_REQUEST_METHODS=GET_ONLY
LIVE_UNIQUE_WORK_ITEMS=1221
LIVE_COMMENTS=1331
LIVE_RELATIONS=6067
LIVE_REQUEST_COUNT=589
LIVE_AREA_PATH_MISMATCH_COUNT=0
LIVE_TARGET_DIGEST=b406814ba1dec62cecc03d79b4fb03e01149fe48d76540ca11440829fdd35039
C7_STATE=COMPLETED
C8_READY=YES

Live execution occurred on the owner-run RARW host behind the required VPN.
The exact Team was `Board OPO Build`; the authorized backlog context was
`Epics` + `Stories`. Historical Story reference `94747` was correctly detected
outside Team membership and was not forced into scope. Level 2 instead derived
Feature root `14288` from authorized Epic `15126`.

The sanitized live receipt is recorded in
`docs/acceptance/ADO_LIVE_ACCEPTANCE_RECEIPT_2026-09-20.md`. The private
1,221-item snapshot remains outside Git. C7 is closed; C8 canonical convergence
validation and protected-main handoff may proceed.
