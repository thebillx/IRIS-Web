# ADR 0006: vNext governed capability architecture

## Context
Real IRIS workloads across local engineering, Git/worktrees, mobile automation, document/package inspection, long-running media jobs, browser/computer use, and knowledge work expose capability gaps that cannot be solved safely by adding domain-specific tools one at a time. The completed `IRIS_VNEXT_REAL_WORK_CAPABILITY_GAP_AUDIT` identified gaps G01–G18 and confirmed that the existing local daemon, `CapabilityService`, permission policy, durable mission model, project containment, and catalog identity must remain authoritative.

The current 42-tool catalog is already in active use by IRIS-X / IRIS-C workflows and durable missions. vNext therefore needs additive capability growth with an explicit migration path rather than a replacement authority or a breaking catalog rewrite.

## Decision
IRIS vNext will use the following implementation dependency chain:

```text
SECURITY EFFECT MODEL
    ↓
FS + ARTIFACT + WORKSPACE
    ↓
SHELL + JOB
    ↓
GIT + WORKTREE
    ↓
ARCHIVE / DOCUMENT
    ↓
MOBILE
    ↓
MEDIA / BROWSER / CONNECTORS
```

The following architecture rules are frozen for vNext:

1. `CapabilityService` remains the only local capability execution authority. MCP, browser UI, mission workers, adapters, shell/process runners, device adapters, and connector adapters do not gain a bypass path.
2. Every executable capability has server-derived effective effects from `READ`, `WRITE`, `EXECUTE`, `NETWORK`, and `DESTRUCTIVE`. Callers may declare expected effects but cannot reduce the effective set.
3. Project identity, repository identity, and workspace identity are separate. A registered project may authorize multiple explicit workspaces without globally widening project scope.
4. Large or binary outputs are represented by governed artifact references. They are not returned as unbounded MCP payloads.
5. Generic local process execution uses executable + argv, explicit workspace/cwd, a server-side execution profile, bounded/redacted output, and durable job ownership. There is no implicit shell string or implicit `sh -c`.
6. Git worktrees become authorized workspaces only after repository identity and physical root checks succeed. Creating a worktree never expands access to unrelated filesystem paths.
7. ZIP/OPC inspection is generic. VSDX, DOCX, XLSX, and PPTX use common archive primitives; format-specific reasoning is layered above them.
8. Mobile automation requires an explicit `deviceSerial` or immutable `deviceBindingId`; IRIS never silently falls back to another connected device.
9. Browser/native-computer-use adapter transitions are auditable. Media workflows compose filesystem, shell/job, and artifact primitives rather than creating a separate execution authority.
10. Machine/runtime/tunnel/catalog identities are jointly validated. Ambiguous tunnel ownership or split identity fails closed.
11. The existing 42 tools are not removed in the first vNext release. Compatibility wrappers remain for at least two catalog versions unless a stronger existing compatibility rule requires longer support.
12. Existing durable mission records and accepted legacy capability IDs remain resumable through the compatibility window.

## Consequences
vNext gains a small set of composable grouped MCP surfaces while keeping fine-grained internal capability IDs for policy and audit. The first implementation work must establish effect enforcement and resource identity before generic shell execution is allowed.

Some existing APIs such as `file_*`, `git_local`, `remote_publish`, and `project_validation_*` will later become compatibility wrappers over the new engines. That mapping is additive first; deprecation is delayed until compatibility acceptance passes.

The architecture intentionally accepts more up-front identity and policy work to avoid unsafe shortcuts such as unrestricted shell access, global worktree scope, arbitrary device selection, or binary data flowing through text APIs.

## Out of scope
Phase 0 does not implement production capabilities, modify the current runtime catalog, add shell execution, create worktrees, access BBL systems, change permission mode, commit, push, merge, or deploy. Detailed contracts and acceptance gates are defined in the vNext architecture documents under `docs/architecture/`.
