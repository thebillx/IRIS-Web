# IRIS vNext effect and resource identity contract

Status: Phase 0 architecture contract. No production implementation is implied by this document.

## 1. Effective effect model

Every executable capability has a server-derived set of effective effects. Effects are independent flags and may be combined:

- `READ` — observes resource state or content without intentionally changing that resource.
- `WRITE` — creates or changes state locally or remotely. `NETWORK` does not imply `WRITE`, and `WRITE` does not imply `NETWORK`.
- `EXECUTE` — causes code, a process, interpreter, device command, browser engine, or equivalent active adapter behavior to run.
- `NETWORK` — communicates outside the local process/resource boundary through a network-capable transport. It is independent from local mutation.
- `DESTRUCTIVE` — can remove, replace, truncate, revoke, overwrite, force-update, or otherwise make prior state unavailable without a guaranteed IRIS-managed rollback. It is independent from ordinary `WRITE`.

The effect set is not a caller-controlled risk label.

### 1.1 Derivation rules

1. The server derives effective effects from the capability operation, normalized arguments, execution profile, target type, transport, and project policy.
2. A caller may provide `expectedEffects` only as a surprise-prevention assertion. It never lowers the server-derived set and never grants an effect.
3. If the derived set contains an effect absent from `expectedEffects`, execution fails closed before process/device/browser activity begins.
4. Supplying additional expected effects does not widen authority; approval and audit use the derived set.
5. If IRIS cannot classify the operation conservatively, the operation fails closed. A policy may intentionally classify an operation with a conservative superset.
6. The effective set is recorded in permission decisions, approvals, execution audit, and mission evidence summaries.
7. Approval derives from effective effects plus capability scope, project/workspace policy, sensitivity, remote target policy, and existing risk class. Effect flags do not replace `LOW` / `MODERATE` / `HIGH` / `SYSTEM`; they are additional policy inputs.
8. Adapters must not execute before effect derivation and live resource identity validation complete.

### 1.2 Required examples

| Operation | Minimum effective effects | Notes |
|---|---|---|
| `fs.stat` | `READ` | Metadata only; no file-content load. |
| `fs.write` create | `WRITE` | Creating a new file is not automatically destructive. |
| `fs.write` replace/truncate | `WRITE + DESTRUCTIVE` | Existing bytes are made unavailable. |
| `shell.run python script.py` | `EXECUTE` plus the server-derived conservative profile envelope | A generic Python project-script profile is conservatively `EXECUTE + WRITE + NETWORK + DESTRUCTIVE` unless a separately reviewed restricted profile makes lower effects enforceable. Caller claims do not narrow it. |
| `shell.run curl https://…` GET to stdout | `EXECUTE + NETWORK` | Adding output-to-file adds `WRITE`; remote mutating HTTP methods add `WRITE`, and delete/overwrite semantics may add `DESTRUCTIVE`. Unsupported/ambiguous argv fails closed. |
| `git.fetch` | `READ + WRITE + EXECUTE + NETWORK` | Reads remote state and updates local object/ref state. Prune/destructive forms are not in the initial contract. |
| `git.push` safe feature-branch form | `READ + WRITE + EXECUTE + NETWORK` | Force, delete, protected/default branch, and non-fast-forward destructive forms remain unrepresentable initially. |
| `git.worktree_add` | `READ + WRITE + EXECUTE` | Creates filesystem/Git metadata and then a separately authorized workspace. |
| `adb.install` new package | `WRITE + EXECUTE` | If the explicit install mode replaces an existing package, add `DESTRUCTIVE`. Remote TCP device transport also adds `NETWORK`. |
| `adb.logcat` | `READ + EXECUTE` | Device transport is explicit; TCP transport adds `NETWORK`. Output is bounded/redacted and may become an artifact. |
| `browser.navigate` | `READ + EXECUTE + NETWORK` | Browser-session internal ephemeral state does not itself become project `WRITE`; explicit external mutations are separate operations. |
| `browser.upload` | `READ + WRITE + EXECUTE + NETWORK` | Reads an authorized local artifact/file and writes to an external destination. |

### 1.3 Effect-policy invariants

- Unknown capability: deny.
- Unknown effect derivation: deny.
- Unknown target ownership: deny.
- `NETWORK` is never inferred from `WRITE`; it must be explicitly derived.
- `DESTRUCTIVE` is never hidden under generic `WRITE`.
- `system.sudo`, root escalation, and equivalent privilege elevation remain separate `SYSTEM` authority and are not expressible through shell profiles.
- Banking/restricted project policy may require stronger approval, retention, or network denial for the same effect set.

## 2. Resource identity hierarchy

The vNext ownership hierarchy is:

```text
Machine
  → Runtime
    → Tunnel binding(s)
      → Projects
        → Repositories
          → Workspaces
            → Missions / Jobs / Artifacts
```

The hierarchy is an authorization/correlation model, not an assertion that each level has only one child.

### 2.1 Machine and runtime identity

`machineId`
: Stable, private, generated machine enrollment identity for one macOS host. It persists across IRIS runtime restarts and catalog deployments. It is not derived from hostname, username, network address, or mutable hardware display names.

`runtimeId`
: Stable logical IRIS runtime identity on that machine. It persists across daemon restarts as today.

`instanceId`
: Identity for one concrete runtime daemon process. A successful runtime restart keeps `runtimeId` and changes `instanceId`.

`tunnelId`
: Stable identity of one configured tunnel/connector binding. It is never treated as sufficient proof of ownership by itself.

`deploymentEpoch`
: Positive monotonic generation for connector/catalog deployment state. It is version/fencing metadata, not a replacement for runtime or machine identity.

`catalogHash`
: Deterministic SHA-256 identity of the ordered tool schemas and catalog metadata. Credentials, timestamps, machine IDs, and runtime IDs are excluded from the hash.

A live tunnel binding is valid only when expected `machineId`, `runtimeId`, runtime `instanceId` where applicable, `tunnelId`, `deploymentEpoch`, connector profile, and `catalogHash` are mutually consistent with the supervisor/control-plane lease contract. Ambiguity fails closed.

### 2.2 Project, repository, and workspace identity

`projectId`
: Durable IRIS authorization container registered by the owner. A project may own zero or more repositories and one or more workspaces. Project identity does not mean one physical path forever.

`repositoryId`
: Durable identity for one Git repository known to a project. It is not the remote URL. The repository binding records the verified Git common-directory physical identity and may record remote metadata as mutable attributes. Non-Git projects may have no repository.

`workspaceId`
: Durable identity for one explicitly authorized physical workspace root. Filesystem, shell, job, Git, archive, artifact, mobile-support files, and document operations resolve through a workspace rather than assuming `project root == repository root == worktree root`.

Required rule:

```text
project root != repository root != worktree root
```

must be representable without weakening containment.

### 2.3 Mission and execution identities

`missionId`
: Existing durable mission identity. It remains project-bound and survives session rebind.

`taskId`
: Durable task identity within a mission.

`actionId`
: Exact governed capability action identity within a task.

`jobId`
: Durable process/job identity created only after an authorized start request is persisted. A job belongs to one project and workspace and may correlate to one mission action.

`artifactId`
: Durable reference to one governed artifact record. Artifact identity is independent from physical filename and cannot be forged by passing a path string.

## 3. Workspace contract

Workspace roles are frozen as:

- `PRIMARY` — an owner/project-authorized primary working root. Registration does not imply that it is a Git repository.
- `WORKTREE` — an associated Git worktree whose repository identity and worktree metadata were verified before authorization.
- `SCRATCH` — an isolated IRIS-created or owner-approved temporary workspace for extraction, test fixtures, or derived artifacts. Scratch does not grant authority over its parent directory.

Every workspace record contains:

```text
workspaceId
projectId
repositoryId | null
physicalRoot
role = PRIMARY | WORKTREE | SCRATCH
authorizationSource
createdByAction | null
lifecycleState
createdAt
```

Required `authorizationSource` values initially:

```text
PROJECT_REGISTRATION
GIT_WORKTREE_ADD
OWNER_APPROVAL
SYSTEM_SCRATCH
```

Required lifecycle states initially:

```text
ACTIVE
REVOKING
REVOKED
DELETING
DELETED
```

Only `ACTIVE` workspaces authorize normal capabilities. A workspace transition cannot silently alter another workspace record.

### 3.1 `git.worktree_add` authorization sequence

`git.worktree_add` must follow this sequence:

1. Resolve the selected `projectId`, `repositoryId`, source `workspaceId`, base ref/commit, branch request, and destination policy before mutation.
2. Verify the source workspace and repository common-directory identity.
3. Verify the destination lies under an explicitly approved worktree parent/root policy. Authorization of that destination parent is not equivalent to project-wide filesystem authority.
4. Derive effects and complete permission/approval handling.
5. Invoke Git with server-built argv; no caller shell string.
6. Verify the resulting physical worktree root, `.git` indirection, repository common-directory identity, branch identity, and absence of symlink/alias escape.
7. Persist a new `WORKTREE` workspace record with `authorizationSource=GIT_WORKTREE_ADD` and `createdByAction=<actionId>`.
8. Only after persistence succeeds may other IRIS capabilities operate in the new root.
9. A failure before step 7 does not authorize the path. Any cleanup may touch only bytes that this exact action created and whose identity is reverified.

The primary workspace may be dirty. Worktree creation must not reset, clean, restore, stash, checkout over, stage, or otherwise mutate unrelated primary owner work.

### 3.2 No global widening

Adding a workspace changes only the project's explicit workspace set. It does not:

- authorize the destination parent directory generally;
- authorize sibling worktrees;
- authorize another repository with a similar remote URL;
- authorize symlink aliases;
- convert arbitrary external paths into project paths;
- change permissions of the `PRIMARY` workspace.

## 4. Artifact contract

Artifacts are references, not inline MCP payloads.

Every project artifact record contains:

```text
artifactId
physicalPath
projectId
workspaceId
producerJobId | null
producerActionId | null
mime
artifactType
size
sha256
sensitivity
createdAt
retentionPolicy
```

`artifactType` is an open controlled value such as:

```text
video
audio
screenshot
apk
vsdx-render
log
xml
report
frame
pdf
archive
binary
text
```

Initial sensitivity values:

```text
PUBLIC
INTERNAL
SENSITIVE
RESTRICTED
```

Banking/mobile screenshots, logcat containing customer-like data, and similar evidence may be classified `RESTRICTED` by project policy.

A `retentionPolicy` contains a named policy plus optional expiry, for example:

```text
EPHEMERAL
SESSION
MISSION
PROJECT
MANUAL
```

### 4.1 Artifact invariants

1. `physicalPath` is internal metadata. Authorization uses `artifactId` plus owner/project/workspace validation, not a caller-supplied path alone.
2. Size and SHA-256 are computed by streaming operations; the file is not loaded into memory to produce metadata.
3. Artifact creation does not make its containing directory generally readable.
4. Artifact reads/downloads enforce project/workspace ownership and sensitivity policy.
5. Artifact metadata and audit never store secret file contents.
6. Logs may be append-only artifacts; stdout/stderr views return bounded redacted windows/cursors rather than the whole file.
7. Derived frames/audio/video preserve producer job/action provenance.
8. External source references may point to an artifact, but artifact identity never implies truth/verification of its contents.

## 5. Split identity contract

IRIS reports ready only when the selected local identities are coherent. vNext diagnostics must expose at least:

```text
machineId
runtimeId
instanceId
tunnelId
deploymentEpoch
catalogHash
connectorProfile
```

A tunnel lease/binding additionally carries a monotonic fencing generation or equivalent exclusive-owner token. Two machines claiming the same exclusive tunnel identity are a conflict even if each machine is locally healthy.

Required failure behavior:

- different machine owns active lease → `TUNNEL_OWNERSHIP_CONFLICT`;
- local runtime/catalog/tunnel records disagree → `SPLIT_IDENTITY` or an existing more-specific fail-closed code;
- stale runtime instance after restart → not ready until reconciled;
- catalog mismatch → not ready;
- ambiguous process/tunnel ownership → no automatic kill or takeover.

This contract extends existing runtime/supervisor identity checks; it does not create a second authority service.

## 6. Traceability to audit gaps

- G03 → filesystem metadata/range identity and workspace containment.
- G06 → explicit repository/workspace separation and authorized worktrees.
- G08 → artifact references for large/binary outputs.
- G09 → machine/runtime/tunnel/catalog split-identity fencing.
- G10 → server-derived effective effects and approval/audit input.
- G15 → scratch/knowledge workspace and append-capable future filesystem contract.
- G17 → project/artifact ownership for external source provenance.

The remaining gaps are mapped in the tool contract and acceptance matrix.
