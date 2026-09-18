# IRIS vNext tool surface contract

Status: Phase 0 design/specification only. These tools are not implemented by this document.

The vNext rule is: **granular internal capability IDs for policy; grouped MCP tools for ergonomics**. Grouping must never weaken per-operation effect derivation, scope validation, approval, or audit.

Proposed grouped MCP surfaces are additive to the current catalog during the compatibility window:

```text
fs(operation=...)
shell(operation=run|start)
job(operation=status|logs|result|cancel)
git(operation=...)
workspace(operation=...)
artifact(operation=...)
archive(operation=...)
document(operation=inspect|render)   # later phase
mobile(operation=...)                # later phase
browser(operation=...)               # later phase
```

Media does not require a new execution authority. It composes `fs + shell/job + artifact`; a later low-risk `media.probe` convenience operation may be added only if it remains a fixed, typed wrapper.

## 1. Shell and job contract

### 1.1 `shell.run`

Conceptual request:

```text
operation = run
executable: string
argv: string[]
workspaceId: string
cwd: workspace-relative path | "."
executionProfile: string
envOverrides: map<string,string>
timeoutMs: integer
expectedEffects: Effect[]
stdinArtifactId?: string
```

Conceptual response:

```text
executionId
workspaceId
executableIdentity
normalizedArgvDigest
effectiveEffects
exitCode
signal
timedOut
stdoutTail
stderrTail
stdoutTruncated
stderrTruncated
logArtifactIds[]
producedArtifactIds[]
startedAt
finishedAt
```

Rules:

1. No shell command string is accepted.
2. No implicit `sh -c`, `bash -c`, `zsh -c`, `cmd /c`, PowerShell string mode, or equivalent interpolation layer is used.
3. The server resolves the executable against `executionProfile`; caller PATH cannot substitute an arbitrary binary.
4. `cwd` must resolve physically inside the selected `ACTIVE` workspace. Relative paths cannot escape the workspace.
5. `envOverrides` is an allowlisted overlay, not an inherited arbitrary environment. Secret values are redacted from audit and result payloads.
6. `timeoutMs` is bounded by the execution profile and project policy.
7. The server derives effective effects and compares them with `expectedEffects` as defined by `VNEXT_EFFECT_RESOURCE_IDENTITY.md`.
8. Output is streamed/spooled to controlled logs. MCP receives only bounded redacted windows/tails.
9. No sudo/root/elevation is expressible. `system.sudo` remains a separate SYSTEM capability.
10. Unknown executable/profile/argv classification fails closed.

### 1.2 Interpreter inline-code policy

The default vNext profiles reject inline interpreter-code forms such as:

```text
python -c
python3 -c
node -e
node --eval
ruby -e
perl -e
sh -c
bash -c
zsh -c
```

Project scripts must be physical files inside the authorized workspace or fixed scripts owned by an explicitly reviewed execution profile. If a future owner-authorized inline-code profile is added, it is a separate capability policy and cannot reuse the default project-script profile.

Generic interpreter execution is conservatively effect-classified unless an enforceable restricted profile proves a narrower envelope. Merely naming a script “read-only” does not lower effects.

### 1.3 `shell.start`

Request fields are the same as `shell.run`, plus a stable idempotency `requestId` when used through a mission/job flow.

Response returns immediately after durable job intent and process ownership are established:

```text
jobId
requestId
status=RUNNING
workspaceId
startedAt
effectiveEffects
```

Starting a process is successful only after the durable job record and verified process ownership identity are published.

### 1.4 Generic job contract

Operations:

```text
job.status
job.logs
job.result
job.cancel
```

Durable job record contains at least:

```text
jobId
requestId
projectId
workspaceId
missionId | null
taskId | null
actionId | null
executionProfile
executableIdentity
argvDigest
effectiveEffects
runnerIdentity
pid
processStartMarker
processGroupId
state
startedAt
finishedAt | null
exitCode | null
signal | null
logArtifactIds[]
artifactIds[]
```

States:

```text
QUEUED
RUNNING
SUCCEEDED
FAILED
CANCELLED
LOST
INTERRUPTED
```

`job.logs` is cursor/window based and returns bounded redacted chunks. It never returns an unlimited accumulated process log.

`job.result` returns terminal metadata plus artifact references. Large output is never embedded.

`job.cancel` may signal only the verified process group owned by the job runner. Before cancellation IRIS revalidates PID, process-start marker, runner identity, process group, project/workspace ownership, and job state. Ambiguity fails closed; IRIS does not kill a PID merely because it matches a stale record.

### 1.5 Restart reattachment

A RUNNING job must not become interrupted solely because the MCP/runtime process restarted. The durable job runner contract is:

1. persist start intent;
2. spawn under an IRIS-owned runner/supervisor identity;
3. persist PID, process-start marker, process group and runner identity;
4. after runtime restart, load RUNNING jobs;
5. re-observe the process and require exact identity match;
6. reattach observation when exact ownership is proven;
7. mark `LOST`/`INTERRUPTED` when identity cannot be proven;
8. never kill or adopt an ambiguous process.

This is intentionally stronger than the current validation-job behavior.

## 2. Filesystem contract

Grouped MCP tool:

```text
fs(operation=...)
```

Internal operations:

```text
list
stat
read
write
edit
mkdir
delete
hash
find
```

Every operation uses `workspaceId` plus a workspace-relative target. The server resolves a physical target from the authorized workspace and never trusts a raw caller path as authority.

### 2.1 `fs.list`

Conceptual fields:

```text
workspaceId
path
recursive: boolean
maxDepth: integer
maxEntries: integer
cursor?: string
ignoreMode: NONE | PROJECT
includeHidden: boolean
```

Defaults are bounded: non-recursive, finite `maxEntries`, and no implicit traversal outside the selected directory. Recursive listing uses a deterministic traversal/cursor contract so pagination never requires returning an unbounded tree.

Each entry returns bounded metadata:

```text
relativePath
type
size
mtime
mode
symlink: boolean
hardLinkCount
```

Listing reports symlink identity but does not follow the symlink.

### 2.2 `fs.stat`

Returns metadata without reading file contents. It is valid for multi-gigabyte files and is the preferred way to inspect large media/source size, mtime, type, link count, and identity.

### 2.3 `fs.read`

Modes:

```text
TEXT
BYTE_RANGE
```

Required range fields for byte mode:

```text
offset
length
```

Both are bounded. A large file cannot be returned whole merely because it is within workspace scope. Text mode has explicit byte limits and encoding validation; binary data is not silently converted to lossy replacement text.

For large/binary data, use byte ranges or an artifact reference.

### 2.4 `fs.write`

Modes:

```text
CREATE
REPLACE
APPEND
```

- `CREATE`: fails if target exists.
- `REPLACE`: requires overwrite authorization and derives `WRITE + DESTRUCTIVE`.
- `APPEND`: never truncates. It requires a concurrency precondition such as `expectedSize`, optionally strengthened with `expectedSha256`; IRIS uses a locked/verified descriptor and rechecks target identity and precondition immediately before append.

A stale append precondition fails without partial publication.

### 2.5 `fs.edit`

Preserves the current strong exact-edit concept: bounded UTF-8 edit, exact-match requirements, expected SHA-256 precondition, atomic publication, and dry-run support. Future richer patch operations must not weaken concurrency preconditions.

### 2.6 `fs.mkdir` / `fs.delete`

`mkdir` creates only the explicit target and does not create arbitrary missing ancestor trees unless a future separately typed mode is approved.

`delete` is `WRITE + DESTRUCTIVE`. Recursive delete is not part of the Phase 0 contract. Any future recursive delete requires a separate bounded design and cannot be smuggled through `fs.delete` flags.

### 2.7 `fs.hash`

Streams SHA-256 from a verified descriptor; it never loads the whole file into memory and never follows a symlink.

### 2.8 `fs.find`

Bounded project/workspace search with explicit query type, root, depth/result limits, pagination and ignore behavior. Search cannot escape via symlinked directories.

### 2.9 Link and TOCTOU policy

- Existing components are inspected with no-follow semantics.
- Content read/hash/edit/write/delete on hard-linked files (`nlink != 1`) is denied in the initial vNext contract, preserving the current protection against aliases to outside-owned bytes.
- `list/stat` may report a hard-link count without granting content authority.
- Symlinks may be listed/stat'ed as links but are not followed by default. Phase 0 defines no caller option to bypass this.
- Mutating operations use descriptor-relative/no-follow execution and revalidate inode/device/path identity immediately before publication.
- Canonical path checks are performed against the selected workspace physical root, not only the project's primary root.

## 3. Git and worktree contract

Grouped MCP tool:

```text
git(operation=...)
```

All operations receive an explicit `workspaceId`; repository operations additionally resolve `repositoryId`. Git argv is constructed server-side with terminal prompting disabled and bounded/redacted output.

### 3.1 Read operations and effects

| Operation | Effective effects |
|---|---|
| `status` | `READ + EXECUTE` |
| `head` | `READ + EXECUTE` |
| `diff` | `READ + EXECUTE` |
| `log` | `READ + EXECUTE` |
| `show` | `READ + EXECUTE` |
| `cat_file` | `READ + EXECUTE` |
| `merge_base` | `READ + EXECUTE` |
| `ancestry` | `READ + EXECUTE` |
| `refs` | `READ + EXECUTE` |
| `branch_list` | `READ + EXECUTE` |
| `worktree_list` | `READ + EXECUTE` |

Outputs are bounded. Large/binary `cat_file` results use range/artifact semantics rather than unbounded stdout.

### 3.2 Mutation/network operations and effects

| Operation | Effective effects | Initial restrictions |
|---|---|---|
| `branch_create` | `READ + WRITE + EXECUTE` | Explicit name/base; no checkout-over-owner-work side effect. |
| `worktree_add` | `READ + WRITE + EXECUTE` | Must create and authorize a `WORKTREE` workspace using the resource contract. |
| `worktree_remove` | `READ + WRITE + EXECUTE + DESTRUCTIVE` | Only an IRIS-authorized worktree; dirty/unverified removal fails closed. |
| `add` | `READ + WRITE + EXECUTE` | Explicit bounded paths only. |
| `commit` | `READ + WRITE + EXECUTE` | No amend by default; bounded message; existing hooks policy remains explicit. |
| `fetch` | `READ + WRITE + EXECUTE + NETWORK` | Configured remote; no prune/destructive flags initially. |
| `push` | `READ + WRITE + EXECUTE + NETWORK` | Safe feature-branch preset initially; no force/delete/protected/default/non-fast-forward destructive form. |

`remote_publish` remains a compatibility wrapper for the current safe `push current feature branch to origin and verify remote HEAD` behavior. The grouped `git.push` implementation may not weaken that preset.

### 3.3 Worktree authorization

`git.worktree_add` is the only initial Git mutation that may create a new workspace authority. The created path becomes callable by `fs/shell/job/git/archive` only after repository common-directory and physical-root verification and successful workspace persistence.

`git.worktree_list` alone never authorizes listed worktrees.

## 4. Workspace MCP contract

The grouped workspace surface initially needs only identity/read lifecycle plus controlled scratch support; Git owns Git-worktree creation.

Conceptual operations:

```text
workspace.list
workspace.get
workspace.create_scratch
workspace.revoke_scratch
```

`create_scratch` allocates under a policy-approved IRIS/project scratch parent and authorizes only the created physical root. It does not authorize its parent or siblings.

## 5. Artifact MCP contract

Conceptual operations:

```text
artifact.stat
artifact.open_ref
artifact.register_existing
artifact.release
```

Artifact creation from jobs/processes should normally be automatic from declared outputs rather than callers inventing metadata. `register_existing` verifies workspace ownership, physical identity, size, hash, sensitivity policy and type before returning `artifactId`.

`open_ref` returns a bounded reference/handle suitable for a following typed capability; it is not a raw unbounded byte response.

## 6. Archive contract

Grouped MCP tool:

```text
archive(operation=...)
```

Operations:

```text
list
stat
read_text
extract_to_workspace
```

Initial supported container families:

```text
ZIP
VSDX
DOCX
XLSX
PPTX
```

VSDX is the primary acceptance format.

### 6.1 Frozen security defaults

Initial default limits:

```text
maximum entries: 10,000
maximum decompressed bytes per entry: 64 MiB
maximum total decompressed bytes: 512 MiB
maximum compression ratio: 100:1 per entry and aggregate
maximum read_text returned bytes: 8 MiB, additionally bounded by MCP response policy
```

Limits are policy maxima; restricted projects may lower them. Raising them is a policy/configuration change, not a caller argument that bypasses limits.

Required protections:

- reject absolute entry paths;
- reject `..`/zip-slip traversal after normalization;
- reject path collisions that normalize to the same target;
- reject symlink, device, FIFO and other non-regular/non-directory extraction entries initially;
- validate entry count before extraction;
- enforce per-entry, total decompression and ratio limits while streaming, not only from untrusted metadata;
- `read_text` rejects binary entries and validates encoding/bounds;
- extraction destination must be an authorized `SCRATCH` or other explicitly writable workspace;
- source archive remains immutable/read-only;
- external OPC relationships may be reported as metadata but are never automatically fetched;
- macros or embedded executable content are never executed;
- macro-bearing binaries may be listed/copied under policy, but extraction does not grant execution authority and format adapters must mark their presence.

### 6.2 Structural versus visual document evidence

Archive order is structural evidence only. For VSDX, XML/package relationships may establish page/master/shape metadata, but XML order must not be presented as visual reading or sequence semantics.

Later `document.render` returns a render artifact with provenance. A higher-level agent may combine structural and visual evidence while preserving which source supported each observation.

## 7. Mobile placeholder contract

Phase 0 freezes only the foundations required for later mobile work.

Grouped future surface:

```text
mobile(operation=...)
```

Initial operation families may include typed ADB/Appium observations and actions. Every device-targeting request must provide exactly one of:

```text
deviceSerial
immutable deviceBindingId
```

A discovery result is not authorization. If the bound device disappears, the operation fails; IRIS never selects another connected device automatically.

Device identity records should include serial, transport, state, model, manufacturer, OS/API version and emulator/physical classification. Remote TCP transports derive `NETWORK` in addition to the operation's normal effects.

Screenshots/logs become artifacts with project sensitivity/retention policy.

## 8. Browser placeholder contract

Grouped future surface:

```text
browser(operation=...)
```

Browser sessions are explicit resources. DOM mode and native-computer-use fallback are different adapters.

Any adapter transition produces an audit event containing at least:

```text
browserSessionId
fromAdapter
toAdapter
reason
projectId
workspaceId | null
mission/action correlation
```

The transition itself grants no additional scope. Uploads must reference an authorized workspace file/artifact and derive `READ + WRITE + EXECUTE + NETWORK`.

## 9. Media placeholder contract

Media workflows compose existing primitives:

```text
fs.stat/hash
shell.run/start
job.*
artifact.*
```

Examples:

- `ffprobe` metadata → governed shell/read result;
- `ffmpeg` clip/frame/audio extraction → background job + artifacts;
- Whisper/local-model CLI → execution profile + job + artifacts;
- large source media → stat/hash/artifact reference, never full text/file read.

A future `media.probe` may be a typed fixed ffprobe wrapper with `READ + EXECUTE`; it must still execute through `CapabilityService`.

## 10. Connector placeholder contract

Connectors remain external-source adapters, not a second local authority. Connector credentials never appear in argv, normal audit text, artifact metadata, or user-visible logs. Network actions derive `NETWORK`; external mutations derive `WRITE` independently. External source identity/provenance is recorded separately from artifact truth/verification.

## 11. Audit-gap traceability

- G01 → `shell.run/start` argv-governed execution.
- G02 → generic durable `job.*` with restart reattachment.
- G03 → `fs.list/stat/read/hash/find` and large-file handling.
- G04 → safe generic `archive.*` with OPC support.
- G05 → expanded typed Git read operations.
- G06 → worktree creation + workspace authorization.
- G07 → explicit-device mobile contract.
- G08 → artifact references.
- G10 → per-operation effective effects and no bypass.
- G11 → structural/visual document separation.
- G12 → media composition.
- G13 → browser adapter transition audit.
- G14 → execution profiles and environment policy.
- G15 → append preconditions/source inventory/scratch workspaces.
- G16 → branch/fetch/push typed Git mutations.
- G17 → connector provenance and secret separation.
- G18 → document adapters layered above archive/artifact foundations.

G09 is primarily defined by the identity contract and acceptance matrix.
