# IRIS Security Audit Engine Phase 2

## Scope

Phase 2 adds an on-demand, project-bound Security Audit Engine to the IRIS-C runtime on RARW. It builds on Direct Tools and Multi-Worker V1 rather than introducing a second scheduler or a second permission system.

The engine is invoked through the FULL-only `security_audit` MCP tool. PRO remains exactly five read-only tools.

## Security invariants

1. **No per-command audit lock or approval ceremony.** Proof Gate evaluates evidence quality and finding truth. It never grants execution authority.
2. **Hunter and Verifier are read-only Multi-Worker tasks.** Their immutable authority envelope has `mutablePaths=[]`, `mutablePathOwnership=READ_ONLY`, and read-only capabilities only.
3. **Verifier independence is structural.** A verification must use a different durable worker identity, role/task, result provenance, and read-only authority envelope from the Hunter that produced the candidate. Phase 2 does not claim separate model-process isolation because Multi-Worker V1 exposes `IRIS_LOGICAL` worker provenance rather than a distinct model-process attestation primitive.
4. **Runtime identity is fenced.** Worker assignment records machine/runtime/instance/deployment/catalog identity through the existing Multi-Worker runtime fence.
5. **Evidence is durable and bound.** Security evidence references are restricted to:
   - `file:<workspace-relative-path>#L<start>-L<end>`, and the path must be present in `filesRead`;
   - `artifact:<artifact-uuid>`, and the artifact must belong to the audit workspace;
   - `receipt:sha256:<digest>` for non-source receipts.
   When a source ref is accepted, the engine records a SHA-256 binding receipt over the exact reference identity plus current source bytes. Proof Gate revalidates the source and requires the binding receipt to match; changed files/artifacts become NEEDS_MORE_EVIDENCE even when the path/range still exists. Receipt-only model agreement remains insufficient for VERIFIED.
6. **Mission completion is gated only by active audit lifecycle.** A mission with an active Security Audit run cannot complete until the run is finalized or cancelled.
7. **Cross-chat continuation remains fail-closed.** Mission rebind is authoritative. An audit may rebind the underlying Multi-Worker session only when every task in that run is read-only; assignment authority digests are recomputed atomically.
8. **Durability uses generation CAS and atomic publication.** Security audit state is persisted separately from Multi-Worker state but all references are validated on read/write.

## Pipeline

```text
Mission / Direct Tools
        |
        v
SecurityAuditRun
        |
        +--> Coverage Planner / Ledger
        |        |
        |        +--> Hunter worker per target (read-only)
        |                 |
        |                 v
        |             Hunter result
        |                 |
        v                 v
Candidate findings --> fingerprint / dedupe / severity promotion
        |
        v
Independent Verifier worker (read-only)
        |
        v
Verifier result
        |
        v
Proof Gate
   | VERIFIED
   | REJECTED
   | NEEDS_MORE_EVIDENCE
        |
        v
Decision Package
        |
        +--> optional comparison with completed baseline run
```

## Finding identity and lifecycle

The server derives a SHA-256 fingerprint from canonicalized `category + location + title`. Callers cannot supply their own fingerprint. Repeated candidates inside a run merge into one finding, increment occurrence count, union evidence, and keep the highest severity.

Lifecycle:

`CANDIDATE -> VERIFYING -> VERIFIED | REJECTED | NEEDS_MORE_EVIDENCE`

A later verification attempt may be recorded for a finding that needs more evidence. Proof Gate always evaluates the latest durable verification.

## Proof Gate requirements

A finding can become VERIFIED only when all of the following are true:

- Hunter task has a successful durable read-only WorkerResult.
- Hunter has source evidence whose current bytes still match its durable binding receipt.
- Verifier worker identity differs from Hunter worker identity.
- Verifier task has a successful read-only WorkerResult.
- Verifier has source evidence whose current bytes still match its durable binding receipt.
- The latest verifier decision is VERIFIED.

A verifier REJECTED decision produces REJECTED only when evidence requirements are satisfied. Missing evidence always resolves to NEEDS_MORE_EVIDENCE.

## Coverage and decision package

Each requested coverage target is durable and ends as `COVERED` or `GAP`. A GAP cannot publish findings.

Finalization requires:
- no target remains `IN_PROGRESS`;
- every finding has a Proof Gate result.

The Decision Package contains verified, rejected, and needs-more-evidence finding IDs plus coverage gaps and bounded counts. It is evidence for the owner; it is not an authorization grant.

## Repeated-run comparison

A new run may name one completed run in the same project as its baseline. At completion the engine compares VERIFIED finding fingerprints and records:
- new verified findings;
- persistent verified findings;
- resolved verified findings.

## Recovery and cancellation

Startup recovery maps an active audit to FAILED/CANCELLED when its underlying Multi-Worker run is unavailable or terminal without success. Explicit audit cancellation cancels the underlying Multi-Worker run first and then publishes the audit terminal state.

## MCP surface

`security_audit` operations:
- `list_runs`
- `get_run`
- `create_run`
- `hunter_report`
- `verifier_report`
- `proof_gate`
- `finalize`
- `compare_runs`
- `cancel_run`

Tunnel-service callers may omit `sessionId`; Direct Context resolves/reuses a project-bound session. Non-connector callers remain session-bound.

## Catalog compatibility

Phase 2 advances the FULL catalog to **2.7.0** and adds exactly one additive FULL tool: `security_audit`.

The exact 42 legacy 2.3.0 schemas remain unchanged. PRO remains exactly five read-only tools. Existing Direct Tools and Multi-Worker capability authority remains authoritative.

## Acceptance evidence

The Phase 2 validation gate requires:

- TypeScript typecheck PASS.
- ESLint PASS.
- Build PASS.
- Focused Security Audit tests covering Hunter/Verifier/Proof Gate, dedupe, evidence rejection, session rebind, cancellation/recovery, completion guard, comparison, and Direct Context.
- Multi-Worker routing/recovery/security acceptance regression PASS.
- MCP V2.1/server integration PASS.
- Catalog compatibility PASS.
- Mobile security contract PASS.
- Full runtime regression using the established timing-isolation strategy.
- Controlled activation followed by a live self-dogfood audit on IRIS-C/RARW.
