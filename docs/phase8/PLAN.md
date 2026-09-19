# IRIS Phase 8 — Compatibility Convergence Plan

Status: READY_FOR_SAVE_POINT
Baseline: `d514b10afa4c06cdd6afa211d4c3fbf573a9b3c2`
Branch: `codex/phase8-compat-convergence`
Mission: `231bc628-6256-413a-b82e-1195f2d5b48c`
Workspace: `/Users/bill/iris-phase8-compat-convergence`
Live catalog during implementation: `2.3.0`
Source candidate catalog: `2.4.0`

Phase 8 changes compatibility routing only. It does not authorize removal, deprecation, live connector activation, force push, protected-branch mutation, or a new execution authority.

## Goal

Route the 15 legacy compatibility wrappers through stable vNext grouped engines while preserving the legacy MCP schemas, capability IDs, mission/action identity, approval/effect/audit behavior, output bounds, PRO read-only contract, and durable-mission resumability.

## Baseline proof

- Phase 7 receipt `c002b1bf0d2c1ce1d1c228cb24b691dbcc60f516` is an ancestor of merged `origin/main`.
- Phase 8 baseline is merged main `d514b10afa4c06cdd6afa211d4c3fbf573a9b3c2` (PR #11).
- Live Bill runtime/catalog remained READY + COHERENT during implementation.
- Live runtime remained on catalog `2.3.0` with 49 FULL tools; the `2.4.0` source candidate was not activated.
- The 42 compatibility-baseline tools remain present while additive tools `owner_approval_resolve`, `workspace`, `fs`, `artifact`, `shell`, `job`, and `git` remain active.
- The implementation worktree is an isolated verified WORKTREE based exactly on merged main.
- No legacy wrapper is classified for removal or deprecation in Phase 8.

## NEXT checklist

### NEXT-1 — Baseline and compatibility inventory

Status: COMPLETE

- froze the 42-tool compatibility baseline;
- identified all 15 compatibility wrappers;
- verified grouped replacement engines are active;
- verified Phase 7 merge ancestry;
- created the isolated Phase 8 worktree;
- versioned wrapper → grouped-engine mapping and acceptance IDs.

Exit: baseline SHA, catalog overlap, workspace/repository identity, and compatibility matrix proven.

### NEXT-2 — File and directory wrapper convergence

Status: COMPLETE

- `file_read` routes through PRIMARY workspace bounded fs read;
- `file_write` preserves bounded create/replace upsert behavior;
- `file_edit` routes through exact SHA-256-preconditioned fs edit;
- `file_delete` remains non-recursive;
- `directory_create` preserves idempotent `created:false`;
- `directory_delete` remains empty-directory only;
- legacy capability IDs remain the permission/audit/mission identity;
- no workspace/resource identity leaks into legacy result shapes;
- no-follow, hard-link and TOCTOU rules remain same or stricter.

Search compatibility also uses bounded BYTE_RANGE scanning so files larger than the normal 1 MiB text-read bound are not silently lost. Binary files remain excluded and incomplete scans set `truncated=true`.

Exit: `AC-COMPAT-001=PASS`.

### NEXT-3 — Git wrapper convergence

Status: COMPLETE

Legacy Git behavior routes through `GovernedGitEngine` while preserving old schemas:

- `git_status`;
- `git_local(status|head|diff|diff-check|diff-name-only|add|commit)`;
- `remote_publish` safe current-feature-branch → configured origin preset.

No force, delete-branch, protected/default-branch mutation, raw Git passthrough, or additional MCP operation was introduced.

Exit: `AC-COMPAT-002=PASS`.

### NEXT-4 — Validation and durable-job wrapper convergence

Status: COMPLETE

The following route through declared-script execution profiles and `DurableJobManager`:

- `project_test_run`;
- `project_validation_run`;
- `project_validation_discover`;
- `project_validation_start`;
- `project_validation_job`.

Preserved invariants:

- root `package.json` declaration restriction;
- npm/pnpm only;
- exact server-owned lifecycle-suppression forms;
- bounded legacy output/result shape;
- request idempotency and project ownership;
- mission/action correlation;
- restart-safe durable job ownership;
- pre-Phase-8 persisted validation jobs remain readable.

The legacy `CapabilityService` construction path remains compatible through lazy vNext resource/job bootstrap from the existing `RuntimeState.dataRoot`; production daemon injection remains unchanged.

Exit: `AC-COMPAT-003=PASS`.

### NEXT-5 — Search and old-mission compatibility

Status: COMPLETE

- `search` routes through bounded PRIMARY fs compatibility scanning;
- up to 100 legacy `{path,line,text}` results are preserved;
- hidden files and historical ignore rules are preserved;
- large text files are scanned in bounded ranges;
- binary files are ignored;
- non-exhaustive scans report `truncated=true`;
- pre-vNext mission/action fixture survives owner rebind and resume;
- mission/task/action IDs and evidence remain unchanged;
- completed legacy actions are never replayed.

Exit: `AC-IRIS-007=PASS` and search equivalence PASS.

### NEXT-6 — Two-version compatibility E2E

Status: COMPLETE

A frozen `2.3.0` fixture is compared against the `2.4.0` source candidate.

Proven:

- all 42 baseline tool names remain;
- input schemas, capability IDs, mutation classes and availability remain compatibility-identical;
- all 15 wrapper capability IDs remain registered;
- seven grouped tools remain additive;
- FULL remains 49 tools;
- PRO remains exactly five read-only tools with unchanged schemas;
- no wrapper receives deprecation/removal metadata;
- supervisor/catalog transition tests support the bounded `2.3.0 → 2.4.0` overlap.

Frozen hashes:

- legacy compatibility: `1770afee25ea16845137464de238c36c51465ada722ad7206cee38f14b5e0f54`;
- PRO compatibility: `ae0be3214fdf8b60275027394a7bd43d5b5121a69f31bebc3011b01789ce15e1`.

Exit: `AC-IRIS-005=PASS`, `AC-COMPAT-004=PASS`, and `CURRENT_42_TOOLS_BREAKING_CHANGE=NO`.

### NEXT-7 — Final Phase 8 acceptance and save point

Status: READY_FOR_SAVE_POINT

Canonical evidence:

- focused compatibility suites: 31/31 PASS;
- catalog/identity focused suite: 13/13 PASS;
- supervisor/catalog overlap suite: 28/28 PASS;
- typecheck: PASS;
- lint: PASS;
- build: PASS;
- mobile full-suite preflight: 48/48 PASS;
- shared full suite: 2/2 PASS;
- web full suite: 21/21 PASS;
- runtime full parallel suite: 379/381 PASS;
- the only two parallel failures are known process-sensitive Phase 3 timing assertions;
- required serial Phase 3 proof: 8/8 PASS;
- serial Phase 8 validation proof: 3/3 PASS;
- no Phase 8 test failed in the fresh full regression.

Regression disposition:

`FULL_REGRESSION=PASS_WITH_SERIAL_PROCESS_SENSITIVE_PROOF`

Remaining:

- final source/docs integrity check;
- explicit reviewed-path staging;
- save-point commit;
- final receipt commit;
- close NEXT-7 and mission;
- publish feature branch;
- live catalog activation remains a separate controlled decision.

## Parallelization

After NEXT-1:

- File/directory, Git, validation/job, and search/mission research lanes proceeded in parallel.
- Shared source mutation was serialized/reviewed where lanes touched `CapabilityService`, durable jobs, or catalog code.
- NEXT-6 consumed reviewed handoffs from all wrapper lanes.
- NEXT-7 is serial final acceptance.

## Non-goals

- removing any of the 42 baseline tools;
- changing legacy MCP request schemas;
- changing durable mission IDs solely for migration;
- adding generic shell/Git/network authority through a wrapper;
- making PRO mutable;
- adding deprecation/removal metadata without a later ADR;
- live Browser/GitHub connector activation;
- activating the `2.4.0` source candidate before the save point and controlled activation decision.
