# IRIS Multi-Worker Orchestration V1 — M01 Architecture Assessment

Status: M01_RECON_COMPLETE
Mission: IRIS_MULTI_WORKER_ORCHESTRATION_V1
Mode: READ-ONLY reconnaissance; report output only
Repository: /Users/RARW/iris-m9-external-knowledge
Branch: codex/m9-external-knowledge

## CURRENT_STATE

IRIS already contains several worker/orchestration primitives, but they form a **single-worker-per-mission durable lifecycle**, not native multi-worker orchestration.

### Runtime / session / mission

- Runtime sessions already bind client, agent identity/role, and current project.
- Current agent roles are `owner | planner | implementer | reviewer | security | explorer | other`.
- Mission tasks already exist with `PENDING | RUNNING | BLOCKED | COMPLETED | FAILED | CANCELLED` states and mission actions beneath them.
- Prepared mission actions already bind mission/task/action identity and are validated again by `CapabilityService`.
- The current principal model does **not** expose a durable `principalId` primitive for worker authority.

### Existing worker lifecycle

`durable-mission-lifecycle.ts` already defines:

- `WorkerAdapter`
- `WorkerBinding`
- worker start/checkpoint/resume/cancel/status receipts
- durable checkpoints/directives
- restart recovery

`WorkerAdapterRegistry` is provider/model neutral and currently ships an `IRIS_LOGICAL` adapter.

The limiting invariant is structural: `DurableMissionLifecycleSnapshot` has exactly one `workerBinding: WorkerBinding | null`. The lifecycle is therefore mission → one worker, not mission → many worker tasks → many workers.

### Capability governance

`CapabilityService` is already the correct execution choke point.

It currently:

- validates project/session/mission action identity;
- routes project/workspace/filesystem/artifact/shell/job/Git operations;
- derives effects server-side;
- invokes permission policy;
- enforces owner approval;
- records permission audit;
- prevents direct caller authority from becoming execution authority.

Mission-associated execution currently uses a single `missionActionTail` promise chain. That globally serializes mission-associated capability operations and is a direct blocker for true worker parallelism.

### Project / workspace / resource authority

`VNextResourceRegistry` is reusable and strong:

- explicit project/workspace IDs;
- ACTIVE workspace validation;
- verified physical identity;
- PRIMARY / WORKTREE / SCRATCH roles;
- repository identity binding;
- artifact project/workspace ownership;
- worktree lifecycle;
- contained artifact physical paths.

Filesystem, durable jobs, and governed Git already resolve authority through active workspace identity rather than trusting raw paths.

### Durable jobs / processes

`DurableJobManager` already provides the process substrate needed by workers:

- server-owned execution profiles;
- explicit executable + argv;
- no arbitrary shell string;
- durable job identity;
- process group ownership;
- runner/target process start markers;
- restart recovery;
- cancellation;
- bounded/redacted logs;
- artifact correlation.

A second worker job system should not be created.

### Audit

`PermissionAuditStore` provides durable append-only capability audit.

Current attribution includes client/session/agent/capability/project/target/decision/result, but it does not carry native:

- orchestrationRunId;
- workerTaskId;
- workerId;
- assignmentId;
- authority-envelope digest.

Those fields are required for the requested Mission → Run → Task → Worker → Capability → Result chain.

### Tunnel / catalog / admin-workload identity

Existing identity fencing is already suitable as the root of worker execution trust:

- FULL and PRO have separate catalog/tool manifests;
- connector identity binds machineId/runtimeId/deploymentEpoch/catalogHash/leaseGeneration;
- tunnel claims fail closed on ownership/profile/catalog/runtime mismatch;
- ADMIN is a separate connector identity and must not reuse FULL/PRO tunnel IDs;
- admin/workload lifecycle separation already exists.

Multi-worker must consume these invariants, not define another runtime/tunnel authority model.

## REUSABLE_COMPONENTS

1. **CapabilityService** — remain the only machine capability execution authority.
2. **PermissionPolicyEngine + approval flow** — keep current risk/scope/owner semantics.
3. **Mission + MissionTask + MissionAction** — parent mission authority and action-level approval are reusable.
4. **WorkerAdapter abstraction** — already model/provider neutral.
5. **DurableMissionLifecycleStore / recovery patterns** — reusable durability and optimistic revision techniques.
6. **DurableJobManager** — use for real worker process execution and recovery.
7. **VNextResourceRegistry** — authoritative project/workspace/repository/artifact identity.
8. **WorkspaceFilesystemEngine / GovernedGitEngine** — retain existing path and Git safety.
9. **PermissionAuditStore** — extend attribution; do not replace.
10. **Connector registry / identity coherence** — authoritative machine/runtime/tunnel/catalog fence.
11. **FULL / PRO split** — worker mutation/control must remain FULL-only; PRO stays read-only.
12. **Existing mission-control UI** — extend for tree observability rather than build a parallel console.

## MISSING_PRIMITIVES

### 1. Multi-worker domain model

Missing durable first-class entities:

- `OrchestrationRun`
- `Worker`
- `WorkerTask`
- `WorkerAssignment`
- `WorkerAuthority`
- `WorkerResult`

Current mission tasks do not contain worker assignment, dependencies, immutable execution authority, resource budgets, or structured result contracts.

### 2. Worker principal / authority envelope

There is no native worker principal. Capability requests know client/session/project and optional mission action, but not an immutable Worker execution envelope.

Required envelope must bind at minimum:

- workerId / taskId / missionId / sessionId;
- projectId / workspaceId;
- principalId / parentOrchestratorId;
- allowedCapabilities;
- allowedPaths / readOnlyPaths / mutablePaths;
- allowedProcesses;
- approval policy;
- resource budget;
- concurrency policy;
- createdAt / expiresAt;
- runtime identity fence (machine/runtime/deployment/catalog profile identity or a server-derived equivalent).

### 3. Dependency graph and scheduler

No current WorkerTask DAG exists.

Need:

- dependency IDs;
- ready/block calculation;
- bounded concurrency;
- deterministic transitions;
- cancellation propagation;
- timeout handling;
- no recursive worker creation.

### 4. Concurrent path ownership

Current authority is workspace-level, not worker-subpath ownership.

IRIS can prove a worker is inside the correct workspace, but cannot yet prove two concurrent workers own disjoint mutable subsets.

A path lease/ownership primitive is required before parallel source mutation.

### 5. Parallel mission capability execution

`CapabilityService.missionActionTail` currently serializes all mission-associated operations.

For multi-worker this must become safely keyed/controlled rather than simply removed. Read-only workers may run concurrently; mutable operations require WorkerAuthority + path/process ownership before execution.

### 6. Structured worker result

Current worker checkpoint/state receipts do not meet M07.

Need a bounded persisted result including:

- summary;
- evidence / artifacts;
- filesRead / filesChanged;
- commandsExecuted;
- validationResults;
- risks / blockers;
- recommendedNextActions.

### 7. Orchestrator worker-review decisions

Current mission broker supervisor decisions are mission-level `CONTINUE | REVISE | PAUSE | COMPLETE`.

Need worker-result decisions:

- ACCEPT
- RETRY
- REASSIGN
- SPLIT_TASK
- REQUEST_MORE_EVIDENCE
- CANCEL

Worker completion must never complete the parent Mission.

### 8. Worker-level observability and audit

Current views expose one worker binding / mission state.

Need run/task/worker tree, dependency/block reason, active capability/job, elapsed time, artifacts, errors, and worker-attributed audit fields.

## SECURITY_IMPACT

Multi-worker increases concurrency and impersonation attack surface without changing the root trust model.

Required security posture:

1. **No ambient worker authority.** Worker identity alone grants nothing.
2. **Envelope validation on every capability call.** Mission/task/session/project/workspace/capability/path/process/expiry must all match.
3. **Server-derived effects remain authoritative.**
4. **Project and workspace mismatches fail before execution.**
5. **Path ownership is checked after canonicalization/physical containment, not lexical prefix matching alone.**
6. **Overlapping mutable ownership is denied or BLOCKED until the Orchestrator resolves it.**
7. **Worker cannot create Worker or widen its own envelope.**
8. **ParentOrchestratorId is immutable and validated.**
9. **Tunnel/runtime/catalog identity is checked through existing coherence primitives; do not trust worker-supplied identity as authority.**
10. **Owner approval remains action-specific and cannot be inherited by sibling workers.**
11. **Worker audit attribution must be immutable and included in the exact approval/action digest where mutation is approval-gated.**
12. **PRO stays read-only and must not gain multi-worker mutation tools.**
13. **ADMIN remains outside workload-worker authority.**

## PROPOSED_ARCHITECTURE

```text
Mission
  └─ OrchestrationRun
       ├─ WorkerTask A ─ WorkerAssignment ─ Worker
       │    └─ WorkerAuthority (immutable)
       ├─ WorkerTask B ─ WorkerAssignment ─ Worker
       │    └─ WorkerAuthority (immutable)
       └─ WorkerTask C ...

MultiWorkerOrchestrator
  ├─ dependency scheduler
  ├─ bounded concurrency
  ├─ path ownership registry
  ├─ assignment/result store
  └─ orchestrator review transitions
            │
            ▼
      CapabilityService
            │
      WorkerAuthorityValidator
            │
      existing Policy / Approval
            │
   Workspace / FS / Artifact / Shell / Job / Git
            │
      existing Audit + Results
```

### Important integration rule

Do **not** put a new unrestricted executor under WorkerAdapter.

A WorkerAdapter may manage model/process lifecycle, but all machine effects must return through `CapabilityService` with a validated worker execution context.

### Proposed capability execution context

Extend the existing optional mission association with a server-validated worker association rather than adding a second capability API.

Conceptually:

```ts
executionContext = {
  mission,
  worker: {
    orchestrationRunId,
    workerTaskId,
    assignmentId,
    workerId,
    authorityDigest
  }
}
```

The durable authority document stays server-owned. A worker supplies only opaque identity references sufficient to resolve the immutable envelope.

### Concurrency model

- Reads: concurrent when envelope scope allows.
- Writes: require non-overlapping mutable path ownership.
- Shell/jobs: require explicit process/profile grants and task resource budget.
- Git mutation: initially single-writer per workspace/repository unless explicitly partitioned by safe operation.
- Mission/store transitions: optimistic revision/CAS style.
- Capability execution: no global mission serialization; use authority/ownership-aware keyed coordination.

## PROPOSED_FILE_TOUCH_SET

### M02-M03 core

- `packages/domain/src/index.ts`
- new `apps/runtime/src/multi-worker/model.ts`
- new `apps/runtime/src/multi-worker/validation.ts`
- new `apps/runtime/src/multi-worker/store.ts`
- new `apps/runtime/src/multi-worker/authority.ts`
- corresponding unit tests

### M04-M08 orchestration

- new `apps/runtime/src/multi-worker/service.ts`
- new `apps/runtime/src/multi-worker/scheduler.ts`
- new `apps/runtime/src/multi-worker/concurrency.ts`
- new `apps/runtime/src/multi-worker/results.ts`
- new `apps/runtime/src/multi-worker/review.ts`
- `apps/runtime/src/durable-mission-workers.ts` (adapter integration, not replacement)
- `apps/runtime/src/capability-service.ts`
- `apps/runtime/src/capability-registry.ts`
- `apps/runtime/src/capability-effects.ts`
- `apps/runtime/src/permissions.ts`

### M09 durability / M10 transport + UI

- new `apps/runtime/src/multi-worker/recovery.ts`
- `apps/runtime/src/durable-job-manager.ts` only if worker correlation fields cannot remain external
- `apps/runtime/src/mcp-v21-definitions.ts`
- `apps/runtime/src/mcp-v21-tools.ts`
- `apps/runtime/src/mcp-catalog.ts`
- `apps/runtime/src/server-v21-routes.ts` if REST route parity is retained
- `apps/web/src/mission-control-v21.tsx`
- UI tests

### M11 audit/security

- `packages/domain/src/index.ts` audit event extension
- `apps/runtime/src/audit.ts`
- multi-worker security/acceptance tests
- existing capability/workspace/Git/job regression suites

Avoid changing supervisor/connector identity code unless tests prove a worker-specific identity hook is necessary. Existing tunnel/runtime fencing should be consumed, not duplicated.

## IMPLEMENTATION_SLICES

### Slice 1 — M02 Domain + persistence only

- Add immutable domain records/states.
- Add schema/versioned store and validators.
- No execution, MCP, catalog, runtime restart, or public tool changes.
- Prove malformed identity, duplicate IDs, stale revision, and Worker→Worker parenting fail closed.

### Slice 2 — M03 WorkerAuthority

- Resolve authority server-side.
- Validate capability/path/process/budget/expiry/project/workspace/parent orchestrator.
- Add authority digest.
- Unit/security tests only.

### Slice 3 — M04 Routing with logical workers

- Create/assign/start/fail/cancel worker tasks.
- Reuse WorkerAdapterRegistry with logical test workers first.
- Still no true parallel mutation.

### Slice 4 — M05 DAG + bounded parallel reads

- Add dependency scheduler and bounded concurrency.
- Prove >=2 independent read-only workers execute concurrently.
- Preserve deterministic states/cancellation/timeouts.

### Slice 5 — M06 Path ownership

- Add canonical path ownership leases.
- Integrate enforcement at CapabilityService preflight.
- Block overlapping writes; allow safe shared reads.
- Initially conservative: one Git writer per workspace.

### Slice 6 — M07 Structured results

- Persist bounded WorkerResult.
- Link evidence/artifacts/jobs/files/validation receipts by ID, not raw secret-bearing logs.

### Slice 7 — M08 Review loop

- Add ACCEPT/RETRY/REASSIGN/SPLIT/REQUEST_MORE_EVIDENCE/CANCEL.
- Only Orchestrator can finalize parent Mission.

### Slice 8 — M09 Recovery

- Recover run/task/assignment state.
- Reattach durable jobs through existing DurableJobManager.
- Never replay completed effects.

### Slice 9 — M10 Observability

- Extend mission-control tree.
- No secrets/raw credentials.

### Slice 10 — M11 Security acceptance

- Cross-project/workspace, impersonation, spoofing, expiry, escalation, symlink escape, overlap collision.
- FULL/PRO/admin/runtime/catalog regression.

### Slice 11 — M12 presets

- CODE / QA / RESEARCH / DOCS as convenience policy templates only.
- Effective authority remains the intersection with mission envelope.

### Slice 12 — M13 dogfood

- One read-only IRIS subsystem review.
- >=3 WorkerTasks, >=2 concurrent.
- Structured results + consolidated Orchestrator review.
- No production activation.

## RISKS

### HIGH — mission serialization removal

Removing `missionActionTail` without replacement would create approval/action replay and concurrent mutation races. It must be replaced by WorkerAuthority + resource/path ownership-aware coordination, not deleted.

### HIGH — path partition correctness

Glob patterns alone are insufficient security boundaries. Ownership must normalize and verify physical workspace containment, reject symlink/path escape, and define ancestor/descendant overlap correctly.

### HIGH — worker impersonation / stale assignment

Assignment and authority must be immutable, expiring, revisioned, and bound to parent orchestrator/mission/task/session/project/workspace.

### HIGH — approvals leaking across workers

An owner approval for Worker A must never authorize the same capability for Worker B. Approval identity/digest must include worker assignment authority.

### MODERATE — durability complexity

Current durable mission lifecycle assumes one worker binding. Reusing it by simply adding an array risks incompatible recovery semantics. Prefer a dedicated multi-worker store/service that reuses validation/recovery patterns and DurableJobManager, while keeping the legacy single-worker lifecycle unchanged for backward compatibility.

### MODERATE — catalog compatibility

New public orchestration tools would change FULL catalog identity. Do not expose them until internal service/domain/security tests are stable. PRO should remain unchanged.

### MODERATE — UI/state fan-out

Worker trees can become large. All APIs/UI outputs need bounded pagination/summary behavior from the first public observability slice.

## RECOMMENDED_NEXT_MISSION

`MW-M02_DOMAIN_MODEL`

Recommended scope:

- domain entities/states;
- immutable authority metadata shape (type only, enforcement stays M03);
- versioned persistence schema + validation;
- backward-compatible mapping to existing Mission/MissionTask;
- no public MCP/catalog change;
- no runtime restart/activation/deploy;
- focused tests + typecheck/lint/build;
- small reviewable commit.

Do not begin parallel execution in M02.
