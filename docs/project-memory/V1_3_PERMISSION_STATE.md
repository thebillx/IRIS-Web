# V1.3 local owner permission state

Base runtime checkpoint: `e84a870` (`feat(runtime): establish local daemon foundation`).

## Implemented slices

### V1.0 — policy and audit foundation

- daemon-authoritative permission modes and risk/decision taxonomy
- default development mode `FULL_LOCAL_OWNER`
- explicit capability registry
- private permission settings and structured local audit
- project/session/client-aware scope evaluation
- physical project target validation
- structured file/directory capability execution

### V1.1 — Web permission surface

- normal browser header with compact IRIS branding; no Electron/native title-bar layer
- `Settings · Permissions` with current mode, approved roots, auto/owner categories, and recent decisions
- Approval Center for pending genuine owner decisions
- viewport-bounded approval review with fixed header/footer and scrollable exact-action body
- routine `ALLOW_AUTO` actions never open a blocking approval surface

### V1.2 — shared MCP enforcement

- MCP and Web/API use the same `CapabilityService`
- structured local file/directory MCP tools only
- no arbitrary shell or separate permission bypass
- client/session/current-project checks remain live at execution time

### V1.3 — trust/lifecycle hardening

- literal legacy-reference mutation denied before filesystem inspection
- project target symlink/traversal checks and immediate pre-execution revalidation
- `O_NOFOLLOW` for private security files and regular-file capability opens
- private permission settings disappear/corrupt => fail closed
- private instance-bound runtime control credential; public status does not expose it
- shutdown requests the verified daemon instead of signaling metadata PID directly
- private macOS process-start marker detects PID reuse in authority recovery
- child daemon receives a minimal environment rather than inherited secrets/`NODE_OPTIONS`
- STOP_COMPLETE includes process exit, endpoint removal, control-record removal, and authority release
- sessions carry explicit `agentId` and canonical agent role attribution
- live session `agentId` is inherited into permission audit instead of trusting caller-supplied attribution
- Planner, Implementer, Reviewer, Security, and Explorer sessions can coexist on one daemon without sharing session current-project state

## Canonical V1.3 behavior

- `FULL_LOCAL_OWNER_MODE=PASS`
- `PROJECT_SCOPED_AUTO_APPROVAL=PASS` for implemented LOW/MODERATE runtime capabilities
- `NO_BLOCKING_ROUTINE_APPROVAL_MODAL=PASS`
- `OUTSIDE_SCOPE_FAIL_CLOSED=PASS`
- `MCP_POLICY_ENFORCEMENT=PASS`
- `AUDIT=PASS`
- `MULTI_SESSION_PERMISSION_ISOLATION=PASS`
- `AGENT_MANAGER_FOUNDATION=PASS`
- `MULTI_AGENT_READY=PASS`
- `LEGACY_REFERENCE_POLICY=READ_ONLY_NO_MUTATION`
- `ELECTRON_DEPENDENCY=NO`

Development-host operations such as local build/test/package/Git/commit/runtime/Web lifecycle are covered by the owner's explicit `/Users/bill/iris` authority during V1.3 development. They are not misrepresented as runtime capabilities until a structured capability is actually implemented.

## Residual documented risk

The product trusts processes running as the same macOS user. Project file and directory execution is anchored by the bundled macOS safety helper to the canonical project directory and walked through directory descriptors with no-follow semantics; hard-linked file targets are rejected and writes use same-directory temporary replacement with identity rechecks. V1.3 still does not claim isolation from a mutually hostile process already running with the same macOS account or from compromise of the local runtime/helper itself.

## Acceptance

`POST_V1_3_PERMISSION_REVIEW_REQUIRED=YES`.

At owner acceptance, choose whether the long-term mode remains `FULL_LOCAL_OWNER` or changes to `AUTO_APPROVE_PROJECT_SCOPED`, `AUTO_APPROVE_LOW_RISK`, or `ASK_EVERY_TIME`. No automatic post-V1.3 mode change is authorized.
