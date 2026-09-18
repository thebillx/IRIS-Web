# Phase 5.5 isolated artifact bridge contract

Status: prototype contract; no runtime activation, network transport, MCP registration,
filesystem publication, or change to Phase 2 identity. This is a clean-sheet module.
The historical `PACKAGE_NOT_LOCALLY_AVAILABLE` blocker remains in production until
integration supplies an authenticated transport and local artifact publication.

## Identity and ownership

`TransferIdentity` freezes transferId, sourceArtifactId, sourceRuntimeId,
destinationRuntimeId, destinationProjectId, destinationWorkspaceId,
destinationArtifactId, size (bytes), SHA-256 (lowercase hex), sensitivity,
provenance, and absolute expiresAt (epoch milliseconds). A destination artifact ID
is newly reserved, never a source physical path. IDs are bounded opaque tokens;
paths and parent/sibling directory authority are not accepted. Phase 2 UUIDs fit.
`TransferRecord` adds offset, prefixSha256, and transferState. Offsets are safe
nonnegative integer byte counts; the expected total size is bounded by local policy
(default fake limit 16 MiB). The receiving runtime must choose its own limit.

The fake authority's provisioning methods are trusted test setup, not callable
operations for a remote principal. Opaque object tokens are checked by WeakMap
membership, not caller-provided claims. Source proof binds artifact and runtime;
destination proof binds runtime, project, workspace, artifact-write reservation,
transfer ID, and expiry. Every data, resume, verify, and read operation rechecks
both proofs. Revocation denies further use. A grant for project A cannot write
project B, another workspace, another artifact, or another transfer. An explicitly
separately authorized destination may receive cross-runtime evidence; no implicit
cross-project authority is inferred from source ownership or a raw path.

Production integration must derive these proofs from authenticated runtime peers,
a source-owned artifact registry, and destination project/workspace authorization.
It must validate active project/workspace membership and artifact-write authority
before issuing a destination grant, bind grants to the authenticated principal,
and enforce expiry/revocation using trusted runtime time. The fake issuer does not
implement authentication, signatures, project membership, or filesystem controls.
Do not expose its minting methods or serialize its tokens as production proofs.

## Minimal operations

- `artifact.transfer(identity, proofs)` validates and reserves the exact destination.
  Repeated identical identities return the existing record; conflicting transfer IDs
  fail. Terminal IDs and destination reservations are not reused in this prototype.
- `artifact.push(id, offset, bytes, proofs)` is the single receiving append path.
  Only the next verified offset can advance it. Exact duplicate ranges are no-ops;
  overlapping partial ranges, changed duplicate bytes, and gaps fail.
- `artifact.pull(id, offset, length, proofs)` is a fake source-read convenience
  delegating to push. Production pull/push are direction choices for the same
  transfer lifecycle, not separate authority or publication mechanisms.
- `artifact.resume(id, offset, prefixSha256, proofs)` compares the claimed checkpoint
  with the receiver's actual retained prefix. The transfer ID resolves the entire
  immutable identity; arbitrary caller-supplied files cannot be attached.
- `artifact.verify(id, proofs)` checks total length and full SHA-256 and publishes
  exactly once. Repeated verification returns the completed record.

Cancellation is a lifecycle action on the same transfer; it discards private bytes
and leaves a CANCELLED tombstone/reservation. Reads before publication report
`PACKAGE_NOT_LOCALLY_AVAILABLE`. Fake reads require both live proofs even after
completion; production artifact reads will require independent Phase 2 authority.

## Resume and checksum model

PENDING → TRANSFERRING → VERIFYING → COMPLETED. Empty artifacts may move directly
from PENDING to VERIFYING. VERIFYING is synchronous and not externally observable
in the fake. Bad incoming bytes or final digest mismatch lead to FAILED. Active
transfers can become CANCELLED. FAILED/CANCELLED cannot append or verify. Invalid
authority, expiry, stale offset, duplicate conflict, or source mutation denies the
operation without changing bytes or publishing. Expiry does not renew automatically.

The fake hashes the authoritative whole source on every operation and compares each
chunk with the exact source range before accepting it. Offset therefore denotes a
verified prefix, not merely acknowledged network bytes. Resume recomputes the
retained prefix digest and compares it with the caller's checkpoint. Verification
recomputes the full destination digest independently before publication. A source
whose current length or hash changes cannot continue, even at the same length.
This correctness-oriented fake copies and hashes bytes in memory; it is not a
streaming-performance implementation.

Network interruption is modeled by stopping calls, retaining the receiver record,
and resuming on that same bridge instance. Lost acknowledgments are handled by
exact chunk retry. Synchronous methods serialize reservation, append, and publish
within a bridge instance without sleeps. No state is shared between instances.

Production restart recovery requires durable private staging, immutable source
snapshots or authenticated range proofs, a journal binding the full identity and
a verified checkpoint, and a per-transfer lock/transaction. Persist bytes before
acknowledging a checkpoint; after a crash rehash retained bytes and reconcile the
journal before returning an offset. Atomically create the destination artifact
without replacement and commit bytes plus metadata exactly once. Check the actual
artifact namespace for preexisting objects under that transaction, not merely an
in-memory reservation. Never use an arbitrary existing file as staging. No-follow
path resolution beneath the authorized workspace, disk quota and aggregate transfer
limits, crash reconciliation, and explicit expiry/tombstone cleanup belong to that
integration. This prototype intentionally claims neither disk durability nor
multi-process synchronization.

## Sensitivity and provenance

The ordering is PUBLIC < INTERNAL < SENSITIVE < RESTRICTED, matching Phase 2.
The receiver may choose the same or a stricter label at creation; a label is then
immutable for that transfer ID. Downgrades, unknown labels, and provenance changes
are denied. Provenance chains are bounded opaque strings (up to 64 entries each,
2,048 characters per entry), never executable instructions or authority.

The published destination record retains sourceArtifactId, sourceRuntimeId,
transferId, expected/verified sha256, source provenance, and acquisition provenance
when present, along with the destination tuple and final sensitivity. The fake
clones metadata and bytes at boundaries so callers cannot mutate retained evidence.
Production must preserve this envelope alongside the Phase 2 artifact record rather
than overloading its physicalPath, producerJobId, or producerActionId. For
Figma → BBL Wiki, acquisition identifiers remain attached to the original source
chain across the connector-plane → IRIS transfer. These strings preserve supplied
claims; they do not independently establish authenticity of upstream acquisition.

## Acceptance and security cases

The adjacent contract tests cover verified-prefix interruption/resume, no early
publication, full-byte and provenance retention, immutable returned data, retries,
forged and revoked authority, raw-path claims, all seven identity-grant substitutions,
destination collision, conflicting transfer ID, offset gaps, wrong checkpoint,
conflicting duplicate delivery, corrupt incoming bytes, same-size source mutation,
sensitivity downgrade and stricter labels, altered provenance, oversized/negative
size, malformed/incorrect SHA-256, sibling path identity, expiry, cancellation,
and zero-byte artifacts. Production adapters must run this same contract plus
transport authentication, durable crash/restart, quota, filesystem collision,
symlink, and concurrent publication acceptance before activation.
