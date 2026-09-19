# ADO M1/M2 foundation handoff

MISSION=IRIS_VNEXT_ADO_A_M1_M2_FOUNDATION
WORKSTREAM=ADO_M1_M2_CONNECTIVITY_DISCOVERY
ROLE=WORKER_ADO_A
DATE=2026-09-15
ROOT=/Users/bill/iris-wt-ado-m1-m2
BRANCH=codex/ado-m1-m2-foundation
BASE_SHA=5f6b35e034d7a8d8143c0a7558b507316daa3c32
BASE_VERIFIED=YES (exact HEAD at start; expected root/branch; clean worktree)

ADO_ADAPTER_CONTRACT_READY=YES
READ_ONLY_ONLY=YES
RAW_HTTP_ESCAPE_HATCH=NO
AUTH_REFERENCE_MODEL_READY=YES
BOARD_IDENTITY_RESOLVER_READY=YES
BOARD_SCOPE_DISCOVERY_READY=YES
BACKLOG_DISCOVERY_READY=YES
BOARD_ENUMERATION_PLANNER_READY=YES
CUSTOMER_SPECIFIC_IDENTIFIERS_IN_CORE=NO
PRODUCTION_RUNTIME_WIRING=NO

## Files

FILES_CHANGED=
- apps/runtime/src/ado/adapter.ts — eight named read operations, opaque reference types, exact ID-tuple resource allowlists, bounded policy and sanitized failure model.
- apps/runtime/src/ado/discovery.ts — parent-bound identity selection, explicit area/iteration scope, dynamic backlog catalogs, deduplicated membership provenance and bounded continuation/chunk planning.
- apps/runtime/src/ado/fake-adapter.ts — isolated in-memory fake, paired references, all six failures, scope checks, deterministic timeout/rate-limit/page behavior, bounded detached responses.
- apps/runtime/src/ado/ado.test.ts — focused unit and adapter contract tests.
- apps/runtime/src/ado/README.md — ownership, invariants, fake limitations and future transport/integration obligations.
- .agents/handoffs/knowledge/ado-m1-m2.md — this handoff.

TESTS_ADDED=39

Coverage includes synthetic non-UUID IDs, missing/ambiguous/conflicting targets,
parent isolation, area segment boundaries, includeChildren, unsafe/empty/duplicate
scope, iteration preservation, alternate backlog levels/types, membership union,
provenance, empty-vs-pending levels, cursor replay/cycle/skipping, chunk completion,
missing/numeric limits, auth-reference type and instance isolation, six distinct
failure states, tuple/resource allowlists, all read operations, cross-team reads
and link targets, response snapshots, UTF-8 byte bounds, batches, timeout, rate
windows and pagination exhaustion.

## Validation

VALIDATION=PASS
FOCUSED_VALIDATION=PASS (39/39)
LINT=PASS
TYPECHECK=PASS
BUILD=PASS
DIFF_CHECK=PASS

Commands:

```sh
node scripts/node24.mjs --pnpm --filter @iris/runtime test src/ado/ado.test.ts
pnpm lint
pnpm typecheck
pnpm build
git diff --check
git diff --cached --check
```

Dependencies installed using `pnpm install --frozen-lockfile`; no manifest or
lockfile change. The ambient shell has Node 22 and emits an engine warning;
repository scripts select Node 24 for validation. No full repository test suite
was run, respecting the D4 constraint. No live ADO call was made.

## Architecture and integration notes

Read AGENTS.md, ADR 0006 and the vNext effect/resource identity architecture.
The mission's supplied M1/M2 concepts are the feature specification for this
worker. No separate uploaded ADO plan artifact was available in the worktree or
the inspected project agent files; reconcile that artifact during integration
if it contains additional requirements.

No executable production authority is introduced. READ_QUERY is local semantic
metadata, not a core effect change; future execution still requires server-derived
READ + NETWORK through CapabilityService. No secrets are accepted or persisted
by this module. Reference creation exists only in the fake.

The pure enumeration planner expects membership pages from one authorized board
snapshot, accumulated in order; it never fetches details. Downstream integration
must bind snapshot provenance and construct/validate the real transport scope.
Configured shared areas are not proof of exclusive team ownership. Unknown team
fields fail closed; full-board enumeration does not silently filter by current
iteration. Fake queries use fixture IDs, not a WIQL parser or protocol emulator.
Transport streaming limits, actual cancellation, upstream schema/status mapping,
credential resolution, real cursor handling and query scoping remain integration
work, explicitly outside this worker's isolated-contract scope.

SHARED_INTEGRATION_ZONE_CHANGED=NO
MASTER_STATUS_CHANGED=NO
PUSHED=NO
BLOCKERS=NONE_FOR_ISOLATED_FOUNDATION; separate uploaded plan unavailable
NEXT_SESSION=ADO_INTEGRATION
NEXT_STEP=Review/cherry-pick this worker commit; bind these contracts through the authorized integration layer and verify the actual ADO transport separately.
HANDOFF_READY=YES
