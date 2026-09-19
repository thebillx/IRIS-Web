# IRIS Phase 8 — Implementation Status

Updated: 2026-09-19
Branch: `codex/phase8-compat-convergence`
Baseline: `d514b10afa4c06cdd6afa211d4c3fbf573a9b3c2`
Mission: `231bc628-6256-413a-b82e-1195f2d5b48c`
Workspace: `/Users/bill/iris-phase8-compat-convergence`
Live catalog: `2.3.0`
Source candidate catalog: `2.4.0`

## Scope

Phase 8 converges the 15 legacy wrappers onto stable vNext grouped engines. It does not remove or deprecate a legacy tool and does not activate the 2.4.0 candidate runtime.

## Key implementation results

### File / directory / search

Legacy file and directory capability IDs continue to own policy, approval, mission correlation and audit while execution routes through the PRIMARY `WorkspaceFilesystemEngine`.

Compatibility fixes include:

- bounded CREATE→REPLACE upsert for `file.write`;
- explicit legacy-only result projection for `file.edit`;
- non-recursive delete and idempotent mkdir behavior;
- large-file search via bounded byte ranges rather than silently skipping files over the normal 1 MiB text-read bound;
- binary-file exclusion;
- chunk-boundary literal matching;
- total search-byte bound;
- `truncated=true` whenever a scan is incomplete;
- byte-range file-size revalidation against inventory to fail closed on concurrent mutation.

### Git

Legacy Git wrappers use `GovernedGitEngine` compatibility methods.

Preserved:

- old result shapes and operation allowlists;
- exact repository identity derived internally from the PRIMARY workspace;
- safe current-feature-branch publish only;
- no force/delete/protected/default branch mutation;
- no raw Git passthrough.

### Validation / jobs

Legacy validation wrappers use declared-script execution profiles plus `DurableJobManager`.

Hardening discovered during canonical tests:

- pnpm requires the exact server-owned pair `--config.ignore-scripts=true --config.enable-pre-post-scripts=false` to suppress lifecycle hooks;
- npm uses exact `run --ignore-scripts <script>`;
- execution profiles reject caller-supplied alternate/extra package-manager flags;
- terminal retries return the reconciled terminal state instead of reverting to a fake RUNNING state;
- pre-Phase-8 validation job records remain readable;
- short-lived durable jobs may finalize from a verified runner result when the target exits before live PID/start-marker revalidation.

### Legacy construction compatibility

Full regression showed that old internal `CapabilityService` construction paths did not inject Phase 2/3 dependencies.

Compatibility was restored without global-path guessing:

- `RuntimeState` exposes its existing FoundationStateStore data root read-only;
- `CapabilityService` lazily constructs `VNextResourceRegistry` and `DurableJobManager` from that exact root only when old callers omitted them;
- the production daemon continues to inject and reuse the normal resource/job instances.

### Durable missions

The Phase 8 old-mission acceptance fixture proves:

- legacy capability ID `file.write` remains accepted;
- action is STARTED then SUCCEEDED before migration;
- owner CAS rebind preserves mission/project/task/action identity;
- old session loses control;
- new owner session resumes the same durable mission;
- duplicate resume is idempotent;
- completed action result/evidence remains byte-structurally unchanged and is not replayed.

### Two-version catalog overlap

Frozen 2.3.0 fixture:

- legacy tools: 42;
- FULL overlap before/after: 49;
- PRO: exact five read-only tools;
- legacy compatibility hash: `1770afee25ea16845137464de238c36c51465ada722ad7206cee38f14b5e0f54`;
- PRO compatibility hash: `ae0be3214fdf8b60275027394a7bd43d5b5121a69f31bebc3011b01789ce15e1`.

The 2.4.0 source candidate keeps the 42-tool legacy compatibility payload unchanged and keeps the seven grouped tools additive.

## Canonical evidence

Focused compatibility:

- 5 files / 31 tests PASS.

Catalog/identity compatibility:

- 3 files / 13 tests PASS.

Supervisor/catalog transition:

- 3 files / 28 tests PASS, including cross-catalog handoff.

Other focused proofs:

- `mcp-v21.test.ts`: 5/5 PASS;
- Phase 3 serial proof: 8/8 PASS;
- Phase 8 validation serial proof: 3/3 PASS.

Canonical commands:

- typecheck: PASS;
- lint: PASS;
- build: PASS.

Fresh full regression job:

- jobId: `23aaf4c8-a45e-4895-b3e5-33b5466542be`;
- mobile: 48/48 PASS;
- shared: 2/2 PASS;
- web: 21/21 PASS;
- runtime parallel: 379/381 PASS;
- no Phase 8 test failed;
- exactly two known Phase 3 process-sensitive timing assertions failed under parallel load;
- the same Phase 3 file passes 8/8 serially.

Regression disposition:

`FULL_REGRESSION=PASS_WITH_SERIAL_PROCESS_SENSITIVE_PROOF`

## Runtime/catalog preservation

Final pre-save-point observation:

- runtime: READY;
- identity: COHERENT;
- runtimeId: `0dd6afb3-1694-437b-a56c-fd36d3d3f7be`;
- instanceId: `cc489c96-0923-418e-8e83-f1a46f742e59`;
- live catalog: `2.3.0`;
- live FULL tool count: 49.

The 2.4.0 source candidate was not activated during implementation or validation.

## Generated dependency cache

Manual lockfile-frozen dependency hydration created untracked `.cache/` and `Library/` package-manager cache content in the isolated worktree.

Those paths are generated environment state and MUST NOT be staged or committed. Final staging uses an explicit reviewed source/document allowlist only.

## Final acceptance

Implementation save point:

`1225a7578a0e79218d2e2795e5bf546097950daa` — `Phase 8: converge compatibility wrappers`

Final acceptance state:

- NEXT-1 through NEXT-6: COMPLETED;
- NEXT-7 acceptance evidence is complete and this receipt is the closing save-point document;
- `AC-IRIS-005=PASS`;
- `AC-IRIS-007=PASS`;
- `AC-COMPAT-001=PASS`;
- `AC-COMPAT-002=PASS`;
- `AC-COMPAT-003=PASS`;
- `AC-COMPAT-004=PASS`;
- `CURRENT_42_TOOLS_BREAKING_CHANGE=NO`;
- `FULL_REGRESSION=PASS_WITH_SERIAL_PROCESS_SENSITIVE_PROOF`;
- no wrapper removal/deprecation;
- no live catalog activation.

`PHASE_8=COMPLETED`

After this receipt commit, the durable NEXT-7 task and existing Phase 8 mission are recorded COMPLETED. Feature-branch publication is governed separately; activation of source catalog 2.4.0 remains a separate controlled decision.
