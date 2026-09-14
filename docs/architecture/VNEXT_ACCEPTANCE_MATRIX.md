# IRIS vNext acceptance matrix

Status: Phase 0 specification. Cases are future acceptance requirements; Phase 0 does not implement the capabilities under test.

All destructive/security cases use temporary isolated workspaces and synthetic fixtures. No case requires production infrastructure. BBL acceptance uses synthetic VSDX/mobile fixtures and must not access `/Users/RARW` or banking systems.

Allowed test classes:

```text
UNIT
CONTRACT
INTEGRATION
SECURITY
E2E_LOCAL
```

Target phases:

```text
P1 = security/effect/identity enforcement
P2 = FS + artifact + workspace
P3 = shell + job
P4 = Git + worktree
P5 = archive + document
P6 = mobile
P7 = media + browser + connectors
P8 = compatibility convergence
```

## 1. Audit gap to requirement traceability

| Audit gap | Requirement | Capability / contract | Required acceptance coverage |
|---|---|---|---|
| G01 | REQ-SHELL-001: general local execution is executable+argv, workspace-bound, profile-governed and never an implicit shell string | `shell.run/start`, effect model | AC-SEC-006, AC-SEC-009, AC-NINJA-002/003, AC-IRIS-001, AC-RDJ-006 |
| G02 | REQ-JOB-001: background execution has durable identity, logs, result, cancel and restart reattachment | `job.*` | AC-SEC-010, AC-NINJA-003/004/005/006 |
| G03 | REQ-FS-001: bounded recursive inventory, stat, range read, hash and find work for large files without whole-file loading | `fs.*` | AC-SEC-007, AC-BBL-001/002, AC-NINJA-001, AC-RDJ-003/005 |
| G04 | REQ-ARC-001: ZIP/OPC inspection is read-only, bounded and hostile-archive safe | `archive.*` | AC-BBL-003/004/005/006, AC-DOC-002 |
| G05 | REQ-GIT-R-001: Git ancestry/object/ref reads are first-class and bounded | `git.cat_file/merge_base/ancestry/...` | AC-FARM-001/002 |
| G06 | REQ-WORK-001: worktrees become separately verified authorized workspaces without global project widening | `git.worktree_add`, workspace contract | AC-SEC-007, AC-FARM-003/004/005 |
| G07 | REQ-MOB-001: every mobile operation targets an explicit immutable device identity and never silently falls back | `mobile.*` | AC-BBL-007/008/009 |
| G08 | REQ-ART-001: large/binary outputs are artifact references with ownership/hash/provenance | `artifact.*` | AC-SEC-008, AC-BBL-002/009, AC-NINJA-001/004/007, AC-RDJ-004/005 |
| G09 | REQ-ID-001: machine/runtime/tunnel/catalog identities are jointly fenced; split identity fails closed | runtime/supervisor identity contract | AC-NINJA-006, AC-IRIS-002/003/004/008 |
| G10 | REQ-EFF-001: server-derived READ/WRITE/EXECUTE/NETWORK/DESTRUCTIVE effects drive approval/audit and cannot be downgraded | effect model | AC-SEC-001–010, AC-FARM-006, AC-IRIS-005/006/009 |
| G11 | REQ-DOC-001: structural extraction and visual interpretation retain distinct provenance | archive/document/artifact | AC-BBL-004, AC-DOC-001 |
| G12 | REQ-MEDIA-001: media work composes fs + shell/job + artifact instead of a bespoke execution authority | media placeholder | AC-NINJA-002/003/007, AC-MEDIA-001 |
| G13 | REQ-BROWSER-001: DOM/native adapter transitions are explicit and audited without scope widening | browser placeholder | AC-BROWSER-001 |
| G14 | REQ-EXEC-001: project execution profiles define executable/toolchain/env policy and do not inherit ambient secrets | shell execution profile | AC-SEC-009, AC-NINJA-008 |
| G15 | REQ-KNOW-001: append-only Markdown/log workflows and recursive source inventory are safe and preconditioned | `fs.write(APPEND)`, `fs.list/find`, scratch workspace | AC-BBL-001, AC-RDJ-001/002/003 |
| G16 | REQ-GIT-M-001: branch/worktree/fetch/push mutations are typed and safe; current remote publish semantics remain available | grouped `git` + wrapper | AC-FARM-006/007, AC-COMPAT-002 |
| G17 | REQ-CONN-001: external source/connector provenance is separate from credentials and local artifact authority | connector/artifact placeholder | AC-RDJ-004/005, AC-CONN-001 |
| G18 | REQ-DOC-002: semantic document adapters layer above archive/artifact primitives and never execute embedded code | document placeholder | AC-DOC-001/002 |

`GAPS_MAPPED=18/18`

## 2. Foundation and security cases — 10

| Case | Gaps | Class | Phase | Capability / requirement | Pass criteria |
|---|---|---|---|---|---|
| AC-SEC-001 | G10 | UNIT | P1 | REQ-EFF-001 | Combined effects are a deterministic server-derived set; order/duplicates do not change the set. |
| AC-SEC-002 | G10 | SECURITY | P1 | REQ-EFF-001 | Caller omits one server-derived effect from `expectedEffects`; execution is denied before adapter/process activity and audit records the mismatch. |
| AC-SEC-003 | G10 | CONTRACT | P1 | REQ-EFF-001 | A NETWORK-only read operation is not treated as WRITE; a local WRITE operation does not gain NETWORK. |
| AC-SEC-004 | G10 | CONTRACT | P1 | REQ-EFF-001 | Replace/truncate/delete operations derive DESTRUCTIVE independently from WRITE; ordinary create/append does not automatically derive DESTRUCTIVE. |
| AC-SEC-005 | G10 | SECURITY | P1 | REQ-EFF-001 | Unknown capability/effect derivation fails closed and produces no mutation/process/network traffic. |
| AC-SEC-006 | G01,G10 | SECURITY | P3 | REQ-SHELL-001 | All shell execution reaches `CapabilityService`; MCP/adapter cannot invoke an ungoverned child-process path; shell strings and implicit `sh -c` are rejected. |
| AC-SEC-007 | G03,G06,G10 | SECURITY | P2 | REQ-WORK-001 | A workspace-authorized path succeeds; sibling/parent/other-project paths remain denied after adding a worktree/scratch workspace. |
| AC-SEC-008 | G08,G10 | SECURITY | P2 | REQ-ART-001 | Artifact ID owned by project A cannot be opened/attached from project B even if the physical file is readable by the same OS user. |
| AC-SEC-009 | G01,G14 | CONTRACT | P3 | REQ-SHELL-001, REQ-EXEC-001 | Default profiles reject `python -c`, `node -e`, shell `-c` and equivalent inline-code forms; project script files use server-resolved profiles. |
| AC-SEC-010 | G01,G02,G10 | CONTRACT | P3 | REQ-JOB-001 | stdout/stderr are bounded and redacted; full logs remain controlled artifacts/cursor streams; secret fixture values never appear in normal audit/result text. |

## 3. BBL-derived cases — 9

| Case | Gaps | Class | Phase | Capability / requirement | Pass criteria |
|---|---|---|---|---|---|
| AC-BBL-001 | G03,G15 | INTEGRATION | P2 | `fs.list/find` | Synthetic Obsidian vault including hidden `.obsidian` tree is recursively inventoried with pagination/depth bounds; symlink escape is not followed. |
| AC-BBL-002 | G03,G08 | INTEGRATION | P2 | `fs.stat/hash`, artifact | A synthetic large/sparse source is stat'ed and SHA-256 hashed by streaming without embedding/reading the whole file into MCP output. |
| AC-BBL-003 | G04 | INTEGRATION | P5 | `archive.list/stat` | Synthetic VSDX/OPC fixture lists package entries/relationships/pages within limits and without source mutation. |
| AC-BBL-004 | G04,G11 | INTEGRATION | P5 | `archive.read_text`, document provenance | VSDX XML is read as bounded structural evidence; pre/post source SHA-256 is identical; no XML/package order is labeled as visual sequence semantics. |
| AC-BBL-005 | G04 | SECURITY | P5 | archive extraction | ZIP entries using `../`, absolute paths, normalization collisions or link/device entries are rejected and no file escapes the temporary scratch workspace. |
| AC-BBL-006 | G04 | SECURITY | P5 | archive limits | Entry-count, per-entry size, total decompressed bytes and 100:1 ratio limits stop a synthetic bomb while leaving source and scratch boundary intact. |
| AC-BBL-007 | G07 | CONTRACT | P6 | mobile target contract | Any device-targeting operation lacking both explicit `deviceSerial` and valid immutable `deviceBindingId` is rejected before ADB/Appium activity. |
| AC-BBL-008 | G07 | SECURITY | P6 | mobile target contract | Bound device disappears while a second device is connected; action fails and does not target the second device. |
| AC-BBL-009 | G07,G08 | E2E_LOCAL | P6 | `adb.logcat`/artifact placeholder | Local synthetic/fake-device adapter proves explicit serial propagation, bounded/redacted log capture and artifact ownership/sensitivity without production device infrastructure. |

`BBL_ACCEPTANCE_CASES=9`

## 4. Farmer / AgriScope-derived cases — 7

| Case | Gaps | Class | Phase | Capability / requirement | Pass criteria |
|---|---|---|---|---|---|
| AC-FARM-001 | G05 | INTEGRATION | P4 | `git.cat_file` | Temporary repo can verify an expected baseline object/type/content/size with bounded output; invalid/oversized object handling fails safely. |
| AC-FARM-002 | G05 | INTEGRATION | P4 | `git.merge_base/ancestry` | Synthetic divergent branch graph returns deterministic merge-base and ancestor booleans matching native Git ground truth. |
| AC-FARM-003 | G06 | E2E_LOCAL | P4 | `git.worktree_add` + workspace registry | Worktree creation produces a new `WORKTREE` workspace only after Git common-directory/physical-root verification; subsequent fs read through that workspace succeeds. |
| AC-FARM-004 | G06 | SECURITY | P4 | worktree isolation | Primary repo starts with modified + untracked owner files; worktree creation leaves byte hashes/status of those paths unchanged and performs no reset/clean/stash/restore. |
| AC-FARM-005 | G06 | SECURITY | P4 | repository identity | A foreign or forged worktree path with similar branch/remote metadata but different Git common-directory identity is not authorized as the project repository workspace. |
| AC-FARM-006 | G10,G16 | CONTRACT | P4 | `git.fetch` | Effects are `READ+WRITE+EXECUTE+NETWORK`; configured remote only; prune/destructive flags are unrepresentable initially. |
| AC-FARM-007 | G16 | E2E_LOCAL | P4/P8 | `remote_publish` compatibility preset | Temporary bare origin proves current feature branch push + remote HEAD verification; main/default/protected/force/delete forms remain rejected. |

`FARMER_ACCEPTANCE_CASES=7`

## 5. Ninja / trading-video-derived cases — 8

| Case | Gaps | Class | Phase | Capability / requirement | Pass criteria |
|---|---|---|---|---|---|
| AC-NINJA-001 | G03,G08 | INTEGRATION | P2 | `fs.stat/hash`, artifact | Multi-hundred-MB synthetic media is inspected by metadata/hash/reference without whole-file MCP transfer. |
| AC-NINJA-002 | G01,G12 | E2E_LOCAL | P3/P7 | governed `ffprobe` | If ffprobe is present in the local test profile, probe a generated tiny media fixture through argv-governed shell and return structured/bounded metadata; otherwise fixture adapter contract test covers profile resolution without production dependency. |
| AC-NINJA-003 | G01,G02,G12 | E2E_LOCAL | P3 | `shell.start` + `job.*` | Background ffmpeg/synthetic long process returns a durable `jobId` promptly; process completes independently from one MCP call and result references artifacts. |
| AC-NINJA-004 | G02,G08 | INTEGRATION | P3 | durable logs | Job emits output beyond inline bounds; cursor log reads recover complete controlled log evidence while each response remains bounded/redacted. |
| AC-NINJA-005 | G02 | E2E_LOCAL | P3 | restart reattachment | Restart runtime while verified runner process is active; same job remains RUNNING/observable and later reaches terminal result without duplicate spawn. |
| AC-NINJA-006 | G02,G09 | SECURITY | P3 | process identity | Persisted PID is reused/mismatched against process-start marker/runner identity; IRIS marks LOST/INTERRUPTED and does not signal/adopt the unrelated process. |
| AC-NINJA-007 | G08,G12 | INTEGRATION | P3/P7 | artifacts | Generated frame/audio/video outputs register distinct artifact IDs with SHA-256, size, producer job/action and workspace ownership; MCP returns refs, not bytes. |
| AC-NINJA-008 | G14 | CONTRACT | P3 | execution profiles | Synthetic Python/Node/model profile uses deterministic executable/PATH/env allowlist; ambient secret fixture variables are absent unless explicitly approved. |

`NINJA_ACCEPTANCE_CASES=8`

## 6. IRIS self-maintenance/runtime cases — 9

| Case | Gaps | Class | Phase | Capability / requirement | Pass criteria |
|---|---|---|---|---|---|
| AC-IRIS-001 | G01 | E2E_LOCAL | P3 | governed shell self-maintenance | A harmless project-local validation command runs through `CapabilityService`, selected workspace and execution profile; outside-workspace cwd/executable substitution is denied. |
| AC-IRIS-002 | G09 | E2E_LOCAL | P1 | runtime identity | Controlled daemon restart preserves `machineId`/`runtimeId`, changes `instanceId`, and reconciles deployment/catalog identity before READY. |
| AC-IRIS-003 | G09 | SECURITY | P1 | tunnel fencing | Two synthetic machine identities claim one exclusive tunnel lease; exactly one fencing generation owns it and the loser reports conflict without takeover/kill. |
| AC-IRIS-004 | G09 | SECURITY | P1 | split identity | Runtime, connector/tunnel, deployment epoch or catalog hash mismatch causes fail-closed not-ready state with diagnosable identity fields. |
| AC-IRIS-005 | G10 | CONTRACT | P8 | current FULL catalog | Snapshot of all 42 current tool names remains present/callable according to existing schemas in the first vNext release; no removal from FULL. |
| AC-IRIS-006 | G10 | CONTRACT | P1/P8 | PRO profile | PRO remains exactly the current five read-only tools until a separate approved change; no shell/job/git mutation/mobile/browser tool appears. |
| AC-IRIS-007 | compatibility | E2E_LOCAL | P8 | durable mission migration | Pre-vNext fixture mission/action IDs survive runtime/catalog upgrade, owner session rebind and resume without mission recreation or completed-action replay. |
| AC-IRIS-008 | G09 | SECURITY | P1 | catalog activation | Source/live catalog hash mismatch prevents READY/activation; credentials/tunnel identity are not regenerated merely to hide the mismatch. |
| AC-IRIS-009 | G01,G10 | CONTRACT | P3 | tool exposure boundary | No direct child-process/shell/job mutation path exists in PRO or outside `CapabilityService`; all FULL grouped execution maps to registered capability/effect metadata. |

`IRIS_ACCEPTANCE_CASES=9`

## 7. RDJ / knowledge-derived cases — 6

| Case | Gaps | Class | Phase | Capability / requirement | Pass criteria |
|---|---|---|---|---|---|
| AC-RDJ-001 | G03,G15 | INTEGRATION | P2 | `fs.write(APPEND)` | Markdown file append with correct expected size/precondition atomically appends exact bytes and preserves prior content. |
| AC-RDJ-002 | G15 | SECURITY | P2 | append concurrency | Competing/stale append precondition fails with zero partial bytes; retry requires fresh precondition. |
| AC-RDJ-003 | G03,G15 | INTEGRATION | P2 | recursive inventory | Synthetic research/source tree inventory honors max depth/entries/pagination and project ignore mode while still allowing explicitly requested hidden knowledge metadata. |
| AC-RDJ-004 | G08,G17 | CONTRACT | P2/P7 | source/artifact reference | Markdown/source registry can store artifact ID + SHA/path/provenance metadata without embedding binary payload or credential data. |
| AC-RDJ-005 | G03,G08,G10,G17 | SECURITY | P2 | ownership boundary | Knowledge/source reference cannot dereference an artifact/workspace belonging to another project and cannot escape through symlink/hard-link aliases. |
| AC-RDJ-006 | G01 | INTEGRATION | P3 | general shell | A project fixture with no `package.json` can run an allowlisted executable/script through `shell.run` when workspace/profile/effects authorize it; no fake validation script is required. |

`RDJ_KNOWLEDGE_ACCEPTANCE_CASES=6`

## 8. Document/browser/media/connector placeholder cases — 5

| Case | Gaps | Class | Phase | Capability / requirement | Pass criteria |
|---|---|---|---|---|---|
| AC-DOC-001 | G11,G18 | CONTRACT | P5 | document provenance | Structural XML evidence and rendered visual artifact evidence have distinct provenance labels; normalization cannot claim XML order as visual semantics. |
| AC-BROWSER-001 | G13 | CONTRACT | P7 | browser adapter audit | Synthetic browser session transitions DOM→native fallback only through an explicit audited adapter-transition record; project/upload scope does not widen. |
| AC-MEDIA-001 | G12 | CONTRACT | P7 | media composition | Media workflow plan resolves only to fs/shell/job/artifact primitives (or fixed typed probe wrapper) and introduces no separate execution/permission authority. |
| AC-CONN-001 | G17 | SECURITY | P7 | connector secret/provenance | Synthetic external connector call records NETWORK/provenance while secret fixture credentials are absent from argv, normal audit, artifact metadata and logs. |
| AC-DOC-002 | G04,G18 | CONTRACT | P5 | higher format adapter | DOCX/XLSX/PPTX/VSDX adapter fixture consumes archive/artifact identities, respects archive security limits and never executes macros/embedded code. |

## 9. Compatibility cases — 4

| Case | Gaps | Class | Phase | Capability / requirement | Pass criteria |
|---|---|---|---|---|---|
| AC-COMPAT-001 | G03 | CONTRACT | P8 | file wrappers → fs | `file_read/write/edit/delete` and directory wrappers preserve existing request compatibility, scope/TOCTOU guarantees and same-or-stricter effects when backed by fs. |
| AC-COMPAT-002 | G05,G16 | CONTRACT | P8 | Git wrappers → grouped git | `git_status`, allowed `git_local` operations and `remote_publish` produce wrapper-equivalent behavior while new operations remain inaccessible through old schemas. |
| AC-COMPAT-003 | G01,G02 | CONTRACT | P8 | validation wrappers → shell/job | Existing project validation discover/run/start/job APIs preserve declared-script restriction, request idempotency, project ownership and result shape compatibility when mapped to generic engine. |
| AC-COMPAT-004 | compatibility | E2E_LOCAL | P8 | overlap period | Two successive catalog-version fixtures retain all 42 current tool schemas/legacy capability IDs; old durable mission resumes and no wrapper is removed before later ADR/deprecation approval. |

## 10. Coverage summary

```text
ACCEPTANCE_CASE_COUNT=58
FOUNDATION_SECURITY=10
BBL=9
FARMER=7
NINJA=8
IRIS=9
RDJ_KNOWLEDGE=6
DOCUMENT_BROWSER_MEDIA_CONNECTOR=5
COMPATIBILITY=4
TOTAL=58
```

P0 audit gaps from the capability audit are G01–G10. Every P0 gap is covered by at least one acceptance case and most have multiple domain cases.

```text
P0_GAPS_FULLY_COVERED=YES
G01=YES
G02=YES
G03=YES
G04=YES
G05=YES
G06=YES
G07=YES
G08=YES
G09=YES
G10=YES
```

Required named scenario representation:

```text
BBL_VSDX_ACCEPTANCE=AC-BBL-003,AC-BBL-004,AC-BBL-005,AC-BBL-006
FARMER_WORKTREE_ACCEPTANCE=AC-FARM-003,AC-FARM-004,AC-FARM-005
NINJA_DURABLE_MEDIA_JOB_ACCEPTANCE=AC-NINJA-003,AC-NINJA-004,AC-NINJA-005,AC-NINJA-006,AC-NINJA-007
TUNNEL_SPLIT_IDENTITY_ACCEPTANCE=AC-IRIS-003,AC-IRIS-004,AC-IRIS-008
```

## 11. Acceptance fixture rules

- Prefer `mkdtemp`/temporary physical directories and synthetic Git repositories.
- Use temporary bare remotes for fetch/push acceptance; no GitHub dependency.
- Use generated ZIP/OPC/VSDX fixtures; no BBL production/source access is required.
- Use sparse/generated large-file fixtures so tests verify streaming behavior without committing large binaries.
- Use fake/stub device/browser/connector adapters until the corresponding local adapter phase exists; E2E_LOCAL may use a local emulator/tool only when explicitly available and never require a production account/device.
- Security/destructive cases use isolated scratch/worktree fixtures and prove owner primary bytes/status remain unchanged.
- Test cleanup removes only fixture-owned temporary paths whose identity is reverified.

## 12. Validation invariants represented by this matrix

- every G01–G18 has at least one requirement and acceptance case;
- every P0 gap G01–G10 has direct acceptance coverage;
- shell bypass is represented as a security/contract failure case;
- workspace addition never globally widens project scope;
- backward compatibility and two-version minimum are explicit;
- BBL VSDX read-only/security cases are present;
- Farmer baseline/ancestry/worktree/isolation cases are present;
- Ninja durable job/log/restart/artifact cases are present;
- tunnel collision/split identity cases are present;
- cross-project escape is explicitly rejected;
- no acceptance case requires production infrastructure.
