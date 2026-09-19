# ADO M6 persistence/sync handoff

MISSION=IRIS_VNEXT_ADO_E_M6_PERSISTENCE_SYNC
ROLE=WORKER_ADO_E
WORKSTREAM=ADO_M6_PERSISTENCE_SYNC
DATE=2026-09-15
ROOT=/Users/bill/iris-wt-ado-m6
BRANCH=codex/ado-m6-sync
BASE_SHA=5f6b35e034d7a8d8143c0a7558b507316daa3c32
BASE_VERIFIED=YES (exact root, branch and HEAD; initially clean worktree)

MISSION_RESULT=PASS
PERSISTENCE_MODEL_READY=YES
SYNC_RUN_MODEL_READY=YES
FULL_SYNC_READY=YES
RESUME_READY=YES
COMPLETENESS_AUDIT_READY=YES
INCREMENTAL_SYNC_READY=YES
MEMBERSHIP_RECONCILIATION_READY=YES
SCHEDULER_INTERFACE_READY=YES
RESTART_DURABILITY_CONTRACT_READY=YES
PRODUCTION_DISK_DURABILITY=YES (bounded SQLite SyncStore; private file, reopen and cross-instance CAS tested)
M6_MVP_FULLY_COMPLETE=YES_FOR_PERSISTENCE_SYNC_BOUNDARY
PRODUCTION_DB_WIRING=YES_FOR_BOUNDED_V1_SYNCSTORE
NORMALIZED_SQL_SCHEMA_MIGRATION=POST_MVP_SCALE_WORK
DAEMON_SCHEDULER_WIRING=INTEGRATION_PENDING
LIVE_ADO_CALLS=NO
CUSTOMER_SPECIFIC_IDENTIFIERS_IN_CORE=NO

## Files and proof

FILES_CHANGED=
- apps/runtime/src/ado/m6/model.ts
- apps/runtime/src/ado/m6/store.ts
- apps/runtime/src/ado/m6/sync.ts
- apps/runtime/src/ado/m6/m6.test.ts
- apps/runtime/src/ado/m6/README.md
- apps/runtime/src/ado/m6/schema.md
- .agents/handoffs/knowledge/ado-m6.md

TESTS_ADDED=48
FOCUSED_VALIDATION=PASS (48/48; 43 logical sync + 5 durable SQLite)
LINT=PASS
TYPECHECK=PASS
BUILD=PASS
DIFF_CHECK=PASS
FULL_REPO_TEST=NOT_RUN (D4 constraint)

Validation commands:

```sh
node scripts/node24.mjs --pnpm --filter @iris/runtime test src/ado/m6/m6.test.ts
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

Installed existing dependencies using `pnpm install --frozen-lockfile`; no
manifest or lockfile modifications. The ambient Node 22 shell emits an engine
warning; repository validation scripts select the installed Node 24 executable.

Tests prove isolated logical stores, explicit expected/fetched/failed accounting,
atomic batch and publication rollback, lost-ack replay, duplicate detection,
version/generation conflicts, stale-publication rejection, read-only probes,
immutable completed history, restart validation, and a fresh Node subprocess
resuming the next checkpoint. Completeness covers missing parents/comments,
unresolved relations, orphan rows, failed/incomplete enumerations, stale/pending
gate decisions and publication policy. Incremental tests cover revision/date,
content hash, attachment/hierarchy/gate-version changes, skip validation and full
membership reconciliation independent of changed-item query results.

## Integration boundary

Read repository AGENTS.md, ADR 0006 and current persistence/store patterns.
Implemented new isolated M6 modules; existing runtime persistence and authority
were not modified. The earlier ADO-A worker's files/commit were not imported.

`SyncStore` remains the transactional contract and `MemorySyncStore` remains
the deterministic fake. Convergence adds `SqliteSyncStore`, a bounded durable
implementation under the authorized runtime data root. It stores the validated
v1 document and generation in a private SQLite file, uses FULL synchronous
durability and `BEGIN IMMEDIATE` compare-and-swap fencing, and fails closed on
aliased roots or invalid persisted snapshots.

Focused tests prove file privacy, close/reopen persistence and cross-instance
stale-writer rejection. This closes the M6 persistence/sync boundary itself.
Daemon scheduler registration, live ADO transport and normalized scale-oriented
SQL tables remain integration/post-MVP work and are not claimed here.

The integration owner must authorize resolved scope IDs, bind authoritative
membership snapshots and attachment completeness, supply real Knowledge Gate
decisions, and implement the durable backend. No direct transport or classification
is provided here. `ScheduleIntent` and `SyncScheduler` contain no timers or daemon
registration. Source-bearing snapshots require private storage and must not be
logged.

Partial ungated items can be explicitly invalidated and re-fetched under new
checkpoint IDs. Classified items and duplicate/ambiguous inventories require a
new run rather than erasing rejection/decision history. Publication conflicts
require a new baseline run; no silent rebase or overwrite occurs.

CHECKPOINT_MISSION=IRIS_VNEXT_ADO_E_M6_DURABLE_CHECKPOINT
CONTENT_UNCHANGED_FROM_VALIDATED_STATE=YES (implementation, tests and feature docs; only handoff metadata updated)
VALIDATION_REUSED=YES (43/43 focused tests, lint, typecheck and build; implementation unchanged)
COMMITTED=YES (explicitly authorized by the durable-checkpoint mission)
HEAD_SHA=3d5739849d3cbeeedd40deeadc60e4a52ae155ae
HEAD_SHA_SCOPE=Implementation checkpoint; the following handoff-only commit records this SHA. Final branch HEAD is reported by the worker and git rev-parse HEAD.
WORKTREE_DELIVERY=Seven worker-owned files committed on codex/ado-m6-sync.
SHARED_INTEGRATION_ZONE_CHANGED=NO
MASTER_STATUS_CHANGED=NO
PUSHED=NO
HANDOFF_READY=YES
BLOCKERS=NONE_FOR_ISOLATED_M6_CONTRACTS
NEXT_STEP=ADO_INTEGRATION
