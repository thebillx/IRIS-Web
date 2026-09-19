# ADO M6: isolated persistence and sync

This directory owns a versioned logical persistence model, a synchronous
transactional store port, pure incremental/reconciliation/audit functions, an
in-memory reference harness, and a bounded durable SQLite-backed `SyncStore`.
It does not call ADO, implement Knowledge Gate, register capabilities, or start
scheduler timers. The SQLite store is an internal persistence owner, not an
agent-exposed API and not a network capability.

## Ownership and trust boundaries

- `model.ts` owns scope keys, source/attachment observations, gate decisions,
  run/checkpoint state, content fingerprints, membership reconciliation, and audit.
- `store.ts` owns snapshot validation, detached reads, schema-version admission,
  generation compare-and-swap, transition validation, completed-history
  immutability, and the fake store.
- `sqlite-store.ts` owns the durable bounded SQLite representation of the same
  validated `SyncDocument`, private filesystem permissions, FULL synchronous
  durability, and cross-instance generation fencing with `BEGIN IMMEDIATE`.
- `sync.ts` owns the explicit sync lifecycle and atomic publication. It consumes
  observations and decisions supplied by trusted integration code; it performs
  neither fetching nor classification.
- `m6.test.ts` and `sqlite-store.test.ts` supply synthetic fixtures, injected
  storage faults, restart proof, private-file checks, and cross-instance CAS proof.
  No live ADO adapter is used.

Organization/project/team/board **IDs**, not names, form the scope tuple. Item IDs
are scoped through their owning run; IDs from different boards cannot collide.
The future caller must authorize that tuple, validate actual adapter responses,
and bind a complete inventory to one board snapshot before invoking this module.
These ports are not agent-exposed APIs and do not confer permission or validate
an arbitrary caller's authority to issue a Knowledge Gate decision.

## Full sync and publication

1. `start` explicitly records `syncRunId`, start time, scope, mode, trigger,
   inventory snapshot identity, expected IDs, duplicate observations, policy, and
   the current published run as a compare-and-swap baseline.
2. `checkpoint` validates a batch and atomically commits source staging,
   comments/relations/links, current failures and the batch acknowledgement.
   Checkpoints retain observed fetched IDs and failure codes even after recovery.
3. `inspect` derives current expected/fetched/failed counts from the authoritative
   rows. Counts are not independently updated mutable counters that can drift.
4. `decide` records one immutable classification per item/run, bound to the source
   fingerprint and configured gate version. The persisted gate row also retains
   the classification category, a SHA-256 digest of the complete classification,
   and exact source-grounded semantic evidence quotes when present. Classification
   remains an external Knowledge Gate responsibility. Staging alone is never a
   promotion.
5. `finish` recomputes completeness and policy from the same store snapshot.
   Success commits `COMPLETE`, its end time, audit, and the scope's publication
   pointer together. Failure commits `AUDIT_FAILED` and its end time/audit, without
   modifying the previously published corpus.

Transitions:

```text
start -> RUNNING -> PAUSED -> resume -> RUNNING
             |                            |
             +-> finish -> AUDIT_FAILED -> resume
             |
             +-> finish -> COMPLETE (immutable)
```

Explicit `resume` also accepts a persisted RUNNING record after worker restart.
It increments the run version, fencing a stale worker's subsequent commands.
Every mutation supplies an expected run version, and every store commit checks
the global generation. A second completed run cannot be overwritten by an older
run that started from an obsolete publication pointer. Publication conflicts do
not automatically rebase; start a fresh run against the current corpus.

Exact checkpoint replay, including a lost acknowledgement, returns the existing
acknowledgement without changing state. Reusing a batch ID with a different
payload or checkpoint kind fails. A repeated item in a different fetch batch is
recorded as a duplicate and blocks completion. Duplicate inventories require a
new unambiguous run; the first observation is never silently published.

Failed fetches can be retried with a new batch ID. For a fetched but incomplete
**ungated** item, `retryItems` explicitly invalidates staging and attachments in
one transaction, retains its membership and checkpoint history, and returns it
to the pending set. Old fetch acknowledgements do not resurrect invalidated
content; re-fetch under a new batch ID. An already classified item requires a
new run rather than erasing a gate decision or rejection audit.

## Completeness

Audit includes expected/fetched/missing IDs, current failures, duplicates,
orphans, missing parents, expected-but-missing comments, unresolved relation
targets, incomplete comment/relation/link enumeration, pending gate decisions,
and promotion/context/evidence/rejection counts.

Every expected item must be fetched. Every attachment enumeration must be
explicitly complete; an empty array alone is not proof. Both missing and extra
comments relative to the expected-comment catalog block completion. Parent and
relation targets must be fetched in this run. No broad project fallback or
automatic exception for out-of-scope dependencies exists.

Publication also requires the configured minimum promotion count and rejection
policy. A confirmed empty inventory can replace a corpus only when the caller
explicitly permits zero promoted items. `published` returns only the current
validated generation, partitioned into promoted, context-only and supporting
evidence. Rejected content is excluded from that corpus projection while its
classification remains available in the rejection audit store.

## Incremental sync

Incremental runs require a previously published baseline and still consume a
fresh full membership snapshot. `planIncremental` combines that snapshot with
Changed Date / Revision hints, never with just a changed-item query. Every member
requires revision/date and comment/relation/link rechecks, even if omitted from
the query. Missing or changed baseline stamps require a body fetch.

A null observation body means an explicit skip: it is valid only when the
baseline exists and the rechecked revision and timestamp match exactly. Full
syncs and new members cannot skip bodies. Backwards revisions/timestamps fail.
Content uses SHA-256; a second canonical fingerprint includes stamps, content
hash, membership hierarchy, comments, relations, links and completeness flags.
Sorting is locale-independent and excludes run IDs. A baseline gate decision may
be reused only when that entire fingerprint and gate version match. Changed
content, revisions, timestamps, hierarchy, attachments or gate policy version
therefore require a fresh Knowledge Gate decision.

Reconciliation separately identifies new, moved-in, moved-out and
hierarchy-changed IDs. Previously known IDs are derived only from completed runs
in the same organization/project. Members that leave a board disappear from the
published view only when the replacement run succeeds; prior generations remain
immutable for audit.

## Scheduler and durability

`SyncScheduler` is an explicit request/status interface, implemented without a
timer. Triggers model manual, incremental and future-schedule requests.
`ScheduleIntent` describes a future scheduler's input; there is no registration,
polling, background thread, daemon hook or network activity. Status reports the
current publication's last successful end time, latest run and active run IDs.

`SyncStore.compareAndSwap` is an all-or-nothing transaction boundary. A real
implementation must durably commit every included row and checkpoint **before**
acknowledging. Its reads must be detached consistent snapshots. See `schema.md`
for keys, constraints and migration requirements.

`MemorySyncStore` remains a fake for deterministic tests. `exportSnapshot`
and `restore` continue to prove the serialization/lifecycle contract.

`SqliteSyncStore` is the durable implementation for the bounded v1 document. It
stores exactly one validated `SyncDocument` and generation in a private SQLite
file under `<runtime-data-root>/ado-sync/state.sqlite3`, enforces directory mode
0700 and database mode 0600, uses `synchronous=FULL`, and wraps compare-and-swap
in `BEGIN IMMEDIATE`. Reopening the file preserves RUNNING runs and checkpoints;
two store instances cannot both commit from the same generation. The store
refuses aliased runtime-data roots and invalid persisted snapshots rather than
falling back to an empty corpus.

This durable store does not by itself wire a daemon scheduler, live ADO transport,
or power-loss integration test for the entire IRIS process. It is also intentionally
a bounded whole-document representation rather than the future normalized table
layout described in `schema.md`. The production integration owner must still bind
this store to the authorized runtime data root and scheduler lifecycle.

Persisted snapshots contain source content and are private data; they must not be
placed in logs or exported as generic artifacts. No auth token or secret field
exists in this model. Failures persist bounded codes rather than upstream
diagnostic strings. Collections remain capped at 10,000 entries, individual text
at 1 MiB and encoded snapshots at 32 MiB.

## Validation

```sh
node scripts/node24.mjs --pnpm --filter @iris/runtime test src/ado/m6/m6.test.ts src/ado/m6/sqlite-store.test.ts
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

Do not run the full repository suite while the separate D4 work is running.
