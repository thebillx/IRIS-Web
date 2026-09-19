# Logical schema version 1

`SyncDocument.schemaVersion = 1` is the canonical logical format. The current
durable implementation stores one complete validated v1 document plus its
generation in SQLite; the normalized table layout below remains the target schema
for a later scale-oriented migration. The bounded whole-document store and the
normalized design share the same validation and transaction invariants.

## Stores and keys

| Logical store | Key | Content / integrity |
| --- | --- | --- |
| sync runs | syncRunId | Scope tuple, mode/trigger, version, status, start/update/end timestamps, inventory snapshot, complete flag, expected IDs, duplicate IDs, current failures, policy, reconciliation, latest terminal audit, baseline publication ID |
| batch checkpoints | syncRunId + batchId | FETCH/INVALIDATE kind, payload digest, item IDs, observed fetched IDs, failure codes, optional invalidation reason, commit time; immutable acknowledgement |
| source staging | syncRunId + itemId | Revision, Changed Date, content, content hash, gate fingerprint, body-skip marker, expected comment IDs and enumeration completeness flags |
| relations | syncRunId + itemId + relationId | Relation kind and target work-item ID |
| comments | syncRunId + itemId + commentId | Source comment text |
| links | syncRunId + itemId + linkId | Opaque supporting-evidence reference; not an HTTP endpoint |
| board membership | syncRunId + itemId | Parent ID and discovered backlog IDs |
| promoted | syncRunId + itemId | PROMOTED gate decision, version, fingerprint, reason code, decision time |
| context-only | syncRunId + itemId | CONTEXT_ONLY gate decision with the same binding |
| supporting evidence | syncRunId + itemId | SUPPORTING_EVIDENCE gate decision with the same binding |
| rejected audit | syncRunId + itemId | REJECTED gate decision, retained rather than silently reclassified |
| published heads | organizationId + projectId + teamId + boardId | Pointer to the current successfully audited run |
| schema metadata | singleton | Schema version and transaction generation |

The four gate stores are mutually exclusive for a given item/run. A SQLite
implementation can enforce this with one `gate_decisions` table containing a
checked disposition column and expose four filtered views. The reference
document represents them as separate arrays and validates uniqueness across all
four. Source bodies are not copied into each classification store.

## SQLite-compatible constraints

- Use composite unique/primary keys matching the table above. Scope IDs are text;
  work-item IDs and revisions are positive integers. No UUID shape is assumed.
- Run IDs are globally unique within the store. Rows reference their owning run.
  Attachment owners and gate rows reference `(syncRunId, itemId)` in staging.
- Relation target/parent references may initially be unresolved in staging. Do
  not use an eager target foreign key to prevent recording that audit condition;
  validate target completeness before publication instead.
- Persist the expected-ID manifest independently of fetched rows, e.g. an
  `expected_items(syncRunId, itemId)` table. Derive counts using those rows,
  staging, failures and gate decisions rather than treating independently updated
  counters as authoritative.
- Persist checkpoint order explicitly; its batch ID is a unique idempotency key
  within a run. Replays compare both kind and digest. Retain original failure
  codes after a retry resolves the current failure.
- Completed rows are immutable. Replacing the corpus changes its head pointer,
  never deletes or overwrites the previously complete run or rejection audit.
  Ungated staging invalidation has its own recorded checkpoint.
- A head must reference a COMPLETE run in exactly the same scope. A changed head
  must extend the current publication through that run's baseline ID. A previous
  complete run cannot be chosen as a rollback through this sync interface.
- Timestamp fields use normalized UTC ISO strings. End time is present only for
  COMPLETE/AUDIT_FAILED and matches the final update time. Clock reversal within
  a run is rejected.

## Transaction / restart contract

One SQLite writer transaction must cover expected-generation validation, run
version validation, staging/attachment/failure changes, checkpoint insertion,
and the version increment. Transaction isolation must not allow two writers to
commit from the same generation. Retry on a concurrency conflict is a caller
decision, never an unbounded loop or a sleep-based lock.

Publication must recompute the audit and gate policy and compare the baseline
head **inside the same consistent transaction** that changes status, end time,
audit and publication pointer. If the transaction fails, all those changes roll
back. Acknowledgement occurs only after the storage durability boundary succeeds.
After a lost acknowledgement, an exact existing checkpoint is success; a
different digest is conflict. Terminal publication can be verified with status
and the persisted head before attempting any further work.

The bounded SQLite implementation configures `synchronous=FULL`, private
0700/0600 filesystem permissions and `BEGIN IMMEDIATE` generation fencing, and
its tests prove reopen persistence plus cross-instance stale-writer rejection.
Those checks prove the store boundary, not end-to-end IRIS power-loss behavior or
daemon restart orchestration. Snapshot restore still validates structure, hashes,
ownership, checkpoints, current audits and publication references; it is not an
authentication mechanism for arbitrary externally supplied state.

## Migration and recovery

Version 0 (no store) to version 1 is explicit first-open initialization of the
private SQLite state row or construction of the in-memory fake. Read/status calls
do not silently replace an invalid existing store. Unknown schema versions,
truncated data and invalid invariants fail closed with `INVALID_SNAPSHOT`; storage
setup failures fail with `PERSISTENCE_FAILURE`. No automatic repair, record
dropping or fallback to an empty corpus is permitted.

Before a future on-disk migration: obtain the storage owner lock, validate the
source version, produce a private recoverable backup, migrate atomically, then
validate all references and the latest published corpus before switching the
schema-version marker. Preserve the prior store on failure. Such a migration
runner and any explicit rollback/retention API are not implemented in M6.
