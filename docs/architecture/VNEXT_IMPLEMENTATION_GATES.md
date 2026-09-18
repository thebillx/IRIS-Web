# IRIS vNext implementation phase gates

Status: Phase 0 specification. This document authorizes no production implementation by itself.

The dependency order is frozen by ADR 0006:

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

## Phase 0 — architecture freeze

Required deliverables:

- ADR 0006 approved;
- effective effect model contract complete;
- resource/repository/workspace/artifact identity contract complete;
- grouped tool surface contract complete;
- all current 42 tools classified for compatibility;
- acceptance matrix maps G01–G18;
- every P0 gap G01–G10 has direct acceptance coverage;
- no implementation code added.

Exit criteria:

```text
EFFECT_MODEL_APPROVED=YES
IDENTITY_WORKSPACE_MODEL_APPROVED=YES
BACKWARD_COMPATIBILITY_APPROVED=YES
ACCEPTANCE_MATRIX_COMPLETE=YES
```

**Phase 1 must not start until all four are true.**

## Phase 1 — security effects and identity enforcement

Scope:

- effect-set type/derivation policy;
- permission/audit representation of effective effects;
- machine identity and split-identity/tunnel fencing model;
- resource identifiers required by later phases;
- compatibility-safe schema groundwork only.

Must-have tests before Phase 1 can exit:

- AC-SEC-001 through AC-SEC-005;
- AC-IRIS-002, AC-IRIS-003, AC-IRIS-004, AC-IRIS-006, AC-IRIS-008;
- unknown effect/capability/resource identity fails closed;
- existing permission/catalog/runtime tests remain green.

Exit criteria:

- server, not caller, derives effective effects;
- audit records effective effects without secrets;
- runtime can represent machine/runtime/tunnel/catalog identity coherently;
- split identity does not report ready;
- current catalog compatibility is unchanged.

**Phase 2 must not start until Phase 1 enforcement tests exist and pass.**

## Phase 2 — filesystem, artifact and workspace foundation

Scope:

- workspace registry and PRIMARY/SCRATCH identity;
- `fs.list/stat/read/write/edit/mkdir/delete/hash/find` foundations;
- artifact identity/stat/reference model;
- append preconditions;
- descriptor/no-follow/TOCTOU protections generalized to workspace roots.

Required exit acceptance:

- AC-SEC-007, AC-SEC-008;
- AC-BBL-001, AC-BBL-002;
- AC-NINJA-001;
- AC-RDJ-001 through AC-RDJ-005;
- current file wrapper compatibility tests remain green.

Exit criteria:

- no global project-scope widening from adding a workspace;
- large-file stat/hash does not require whole-file buffering;
- artifacts are references with project/workspace ownership;
- symlink/hard-link protections are same or stricter than current behavior;
- append conflict produces no partial write.

## Phase 3 — shell and durable job foundation

**Shell implementation must not start until all of the following already exist:**

```text
effect enforcement
workspace enforcement
audit/redaction contract and tests
artifact/log storage foundation
```

Scope:

- `shell.run` and `shell.start` only with executable + argv;
- execution profiles and environment allowlists;
- `job.status/logs/result/cancel`;
- verified process-group ownership;
- durable restart reattachment.

Hard prohibitions:

- no implicit shell string;
- no implicit `sh -c` or equivalent;
- no sudo/root;
- no caller PATH authority;
- no silent ambient secret inheritance;
- no unbounded stdout/stderr.

Required exit acceptance:

- AC-SEC-006, AC-SEC-009, AC-SEC-010;
- AC-NINJA-003 through AC-NINJA-006 and AC-NINJA-008;
- AC-IRIS-001 and AC-IRIS-009;
- AC-RDJ-006.

Exit criteria:

- background jobs survive runtime restart when exact runner/process identity is provable;
- ambiguous/stale PID is never killed/adopted;
- cancellation owns only the verified process group;
- generic project execution no longer requires creation of `package.json` validation scripts;
- current validation APIs remain functional.

## Phase 4 — Git and worktree

Prerequisites:

- Phase 2 workspace registry stable;
- Phase 3 execution/effect/audit primitives stable;
- existing `git_local` and `remote_publish` acceptance remains green.

Scope:

- read operations: status, head, diff, log, show, cat-file, merge-base, ancestry, refs, branch list, worktree list;
- mutation/network: branch create, worktree add/remove, add, commit, fetch, push;
- repository identity and Git common-directory verification;
- WORKTREE workspace authorization sequence.

Required exit acceptance:

- AC-FARM-001 through AC-FARM-007;
- AC-SEC-007 remains green;
- primary dirty workspace stays unchanged during worktree creation;
- worktree list alone never authorizes paths.

Exit criteria:

- baseline/ancestry verification is first-class;
- worktree add authorizes only the verified created root;
- fetch/push effects include NETWORK independently;
- force/delete/protected/default destructive push forms remain unrepresentable initially;
- `remote_publish` behavior is preserved.

## Phase 5 — archive and document evidence

Prerequisites:

- streaming fs/hash available;
- scratch workspaces available;
- artifact identity available;
- archive limits have reviewed defaults.

Scope:

- `archive.list/stat/read_text/extract_to_workspace`;
- VSDX primary acceptance;
- DOCX/XLSX/PPTX/ZIP common OPC/container support;
- document structural versus visual provenance contract;
- document render artifact interface as needed.

Required exit acceptance:

- AC-BBL-003 through AC-BBL-006;
- AC-DOC-001 and AC-DOC-002.

Exit criteria:

- source package SHA is unchanged by inspection;
- zip-slip, absolute path, symlink/device entry and bomb fixtures fail closed;
- external OPC relationships are never auto-fetched;
- macros/embedded code are never executed;
- structural extraction cannot be mislabeled as visual semantics.

## Phase 6 — mobile

**Mobile implementation must not start before shell/job/artifact foundations are stable.**

Additional prerequisites:

- explicit device identity schema approved;
- project sensitivity/retention policy available for screenshots/logs;
- execution effects and transport NETWORK derivation implemented.

Scope:

- typed device discovery/identity;
- explicit-target ADB/Appium foundations;
- screenshot/log artifact creation;
- Robot Framework may run through shell/job rather than creating a second runner.

Required exit acceptance:

- AC-BBL-007, AC-BBL-008, AC-BBL-009.

Exit criteria:

- every action targets an explicit serial/binding;
- missing device never triggers fallback;
- device logs/screenshots are bounded governed artifacts;
- TCP device transport derives NETWORK.

## Phase 7 — media, browser and connectors

**Browser/network/connectors must not start before shell/job/artifact foundations are stable.**

Scope:

- media composition and optional fixed probe wrapper;
- browser session/adapters and transition audit;
- connector provenance/network/secret handling.

Required exit acceptance:

- AC-NINJA-002 and AC-NINJA-007;
- AC-BROWSER-001;
- AC-MEDIA-001;
- AC-CONN-001;
- AC-RDJ-004/005 remain green.

Exit criteria:

- media introduces no new permission authority;
- browser DOM/native transition is explicit and audited;
- uploads reference authorized file/artifact identity;
- connector secrets do not leak to argv/audit/artifact metadata/logs;
- external mutation and network effects remain separately derived.

## Phase 8 — compatibility convergence

Prerequisites:

- replacement grouped engines are stable;
- compatibility wrappers have equivalence tests;
- old durable mission fixtures exist;
- at least one full vNext catalog version has shipped with wrappers active.

Scope:

- route old file/directory tools through fs engine;
- route Git tools through grouped git;
- route project validation through shell/job preset;
- preserve safe remote publish wrapper;
- add deprecation metadata only if separately approved.

Required exit acceptance:

- AC-IRIS-005, AC-IRIS-007;
- AC-COMPAT-001 through AC-COMPAT-004;
- current 42 tool schemas remain available through the minimum compatibility period.

Removal gate:

A current tool may not be removed until:

1. replacement operation has been ACTIVE for at least two catalog versions;
2. wrapper-equivalence acceptance is green;
3. durable old-mission resume acceptance is green;
4. usage review finds no unresolved active dependency;
5. a later ADR explicitly authorizes removal;
6. migration documentation is published.

Phase 0 does not satisfy or waive this removal gate.

## Cross-phase non-negotiable gates

The following fail any phase regardless of feature success:

- any execution path bypasses `CapabilityService`;
- caller can downgrade server-derived effective effects;
- adding a workspace authorizes a parent/sibling/unrelated root;
- raw secrets appear in normal audit/log/artifact metadata;
- ambiguous PID/device/tunnel identity is acted upon instead of denied;
- a compatibility wrapper is less restrictive than the capability it replaces;
- PRO gains mutation/execution authority without a separate approved architecture change;
- acceptance requires production banking/project infrastructure when a synthetic fixture can prove the invariant.

## Phase 0 next action

After owner review/approval of these contracts, the first implementation mission should be limited to **Phase 1 security effects and identity enforcement**. It should not include shell, worktree, archive, mobile, browser, or media implementation.
