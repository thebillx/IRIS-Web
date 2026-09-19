# IRIS 2.4 Activation Hardening

Status: H3_VALIDATED
Mission: `313a2df1-1928-415c-bcba-a3c55719c2da`
Branch: `codex/v24-activation-hardening`
Baseline: `34bc6d9a4f2e4e8b64c13d4490eba2aa2e0bbd96`

## Why this follow-up exists

Phase 8 merged successfully, but the first controlled attempt to move the workload source from the older Phase 6 checkout to merged main exposed two activation-path defects.

The attempted activation used candidate:

- sourceRoot: `/Users/bill/iris-v24-activation-main`;
- HEAD: `34bc6d9a4f2e4e8b64c13d4490eba2aa2e0bbd96`;
- tracked modifications: `0`;
- fingerprint: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
- fingerprint algorithm: `sha256:sorted-tracked-path-content-v1`.

Transaction:

- id: `0dda73e9-2bf8-4e3d-871a-1d9f649da46b`;
- prepared successfully;
- apply failed with `RUNTIME_NOT_RUNNING`;
- rollback completed successfully;
- final transaction state: `ROLLED_BACK`.

The original runtime identity, catalog, deployment epoch, and workload source were restored.

## Incident root cause

The activation candidate was a clean Git worktree but had not been hydrated with package dependencies.

IRIS runtime startup in source mode requires source-local runtime dependencies:

- `apps/runtime/node_modules/tsx/dist/preflight.cjs`;
- `apps/runtime/node_modules/tsx/dist/loader.mjs`;
- workspace package `apps/runtime/node_modules/@iris/domain/package.json`.

The supervised web process requires:

- `apps/web/node_modules/.bin/vite`;
- `apps/web/node_modules/vite/package.json`;
- `apps/web/node_modules/@vitejs/plugin-react/package.json`;
- `apps/web/node_modules/react/package.json`;
- `apps/web/node_modules/react-dom/package.json`.

Before this hardening, candidate identity inspection validated Git/source identity but did not validate these runtime prerequisites. The transaction could therefore be PREPARED and progress into APPLY. In the observed incident, the isolated target-catalog probe failed to start the unhydrated candidate before the cutover step, so the healthy baseline workload was not retired. The transaction still entered APPLY_FAILED and required the normal durable rollback lifecycle to close cleanly.

## H1 — Candidate runtime-readiness preflight

The activation source identity remains defined by tracked source state only. Installed dependencies are deliberately not included in the Git candidate fingerprint.

A separate runtime-readiness preflight now checks the exact startup dependencies required by the supervisor:

1. candidate root must resolve physically;
2. if runtime source mode is active, both tsx loader files must exist inside the candidate root;
3. the workspace `@iris/domain` package must resolve inside the candidate root;
4. if built runtime mode is used, `apps/runtime/dist/main.js` must exist while `@iris/domain` remains required;
5. the web Vite executable must resolve inside the candidate root and be executable;
6. Vite, React plugin, React, and ReactDOM package manifests must resolve physically inside the candidate root;
7. dependency paths may traverse package-manager symlinks only when the final physical target remains inside the candidate root.

The preflight is run both:

- by the production activation candidate inspector during prepare/apply reinspection;
- again at the supervisor workload-replacement boundary before any tunnel, web, or runtime process is retired.

This second check closes the dependency TOCTOU window between activation inspection and cutover.

The preflight intentionally does **not** claim that installed package bytes match the lockfile. pnpm workspace metadata exposes layout and package-manager state but no lockfile digest suitable for this authority decision. Dependency fidelity therefore remains an explicit prerequisite: hydrate the final activation candidate through the governed `pnpm run hydrate` entrypoint, which runs `corepack pnpm install --frozen-lockfile` with package-manager cache/state contained under the worktree, then run the runtime-readiness preflight. The preflight proves the bounded startup dependency closure is present, physical, contained, and executable where required.

## H2 — Cross-source catalog diagnostics

The earlier `catalog status` output showed:

- FULL source/live as 2.3.0;
- PRO source as 2.3.0 but PRO live as 2.4.0.

The PRO value was not evidence that the PRO runtime had already moved to 2.4.

FULL has the `catalog_identity` tool, so the supervisor can read an authoritative runtime catalog identity.

PRO intentionally exposes exactly five read-only tools and does not expose `catalog_identity`. In strict same-source mode, the supervisor may derive the PRO identity from `tools/list` using the same source catalog version. In cross-source compatibility mode, doing that with a newer control-plane source can fabricate a newer apparent PRO catalog version even when the workload runtime is still older.

Hardening rule:

- strict same-source mode: report `sourceMode=STRICT_CONTROL_SOURCE` and preserve existing PRO derivation;
- cross-source mode: report `sourceMode=BOUND_WORKLOAD_COMPATIBILITY`;
- cross-source mode with matching PRO tool names: do not fabricate an authoritative catalog identity; report `live: null`, the observed tool count, and state `UNKNOWN`;
- cross-source mode with mismatching PRO tool names: report `STALE_RUNTIME`;
- FULL behavior remains authoritative through `catalog_identity`;
- when cross-source status is not ACTIVE, recommended action is `USE_CONTROLLED_ACTIVATION_BEFORE_CATALOG_RELOAD` rather than a blind catalog reload;
- `catalogReload()` itself fails closed with `PRECONDITION_FAILED` while the control source and active workload source differ, so an operator cannot accidentally bypass controlled source-root activation.

This prevents a cross-source diagnostic artifact from recommending a catalog reload on false evidence and makes the authority behind the displayed source identity explicit.

Persisted connector bindings from the immediately prior catalog version are accepted only when their structural ownership identity remains valid. A valid-shaped prior catalog hash is classified as stale derived metadata and can be reconciled without changing tunnel ID, machine identity, runtime identity, or lease generation. Malformed hashes and unknown connector identities remain invalid.

### Version-bound PRO manifest identity

The PRO schema surface remains exactly five read-only tools across the 2.3 → 2.4 compatibility transition, but the canonical catalog hash includes `catalogVersion`. An unchanged PRO schema therefore has a different catalog hash in 2.3 and 2.4.

The isolated target-catalog probe must not preserve the old connector PRO hash merely because the five tool names are unchanged. It now:

1. reads the authoritative target catalog version from FULL `catalog_identity`;
2. rejects unsupported target catalog versions;
3. re-hashes the target PRO `tools/list` at the authoritative baseline FULL catalog version and requires that hash to match the currently bound PRO connector hash, proving the five-tool PRO input-schema surface has not changed;
4. derives the PRO identity from the same target definitions using the target FULL catalog version;
5. preserves the exact five-tool PRO name allowlist;
6. writes the version-bound target PRO hash into the connector manifest together with the target FULL hash.

Matching five tool names alone is not sufficient: a target that changes a PRO input schema is rejected before cutover. This keeps FULL and PRO connector identities on one catalog version after cutover while preserving the read-only PRO surface.

## Active workload before retry

Persistent supervisor state at the incident boundary:

- workloadSourceRoot: `/Users/bill/iris-phase6-mobile-current`;
- runtimeId: `0dd6afb3-1694-437b-a56c-fd36d3d3f7be`;
- instanceId: `cc489c96-0923-418e-8e83-f1a46f742e59`;
- deploymentEpoch: `20`;
- FULL tool count: `49`;
- PRO tool count: `5`;
- FULL catalog: 2.3 identity;
- activation transaction after recovery: none active.

## Control-plane promotion before workload activation

The persistent outer supervisor and admin child currently run from `/Users/bill/iris`, whose tracked HEAD `d5e5aa029ce175b11503e97858819d4a6c2fd43d` is an ancestor of merged main. PRIMARY contains no tracked control-plane change that is absent from main, so PRIMARY does not need to be checked out, reset, or overwritten.

The current LaunchAgent preserves:

- runtime data root: `/Users/bill/Library/Application Support/iris`;
- protected reference root: `/Users/bill/iris`;
- Node 24 executable family;
- workload runtime/tunnel identities through the external runtime data root.

After hardening merges, create one new clean worktree from exact merged main and hydrate it with the governed `pnpm run hydrate` entrypoint. Use that same immutable worktree as:

1. the outer supervisor control source;
2. the source for the recycled persistent admin child;
3. the final workload activation candidate.

Promote control-plane code before workload code:

1. reinstall the LaunchAgent from the new hydrated main worktree while preserving the existing runtime data root and protected reference root;
2. verify native `supervisor_status` reports the new `controlSourceRoot`, unchanged workload runtimeId/instanceId/catalogId/deploymentEpoch, and cross-source transition readiness no worse than `DEGRADED`;
3. read native `admin_status` and capture the current admin child identity/profile digest;
4. call bounded `admin_recycle` with fail-closed expected identity/digest preconditions;
5. require `adminSourceCoherent=true`, a changed admin child identity, a ready admin route, and unchanged workload runtime/catalog/tunnel/web anchors;
6. require all bounded activation tools to remain visible and `activation_status.activeTransactionId=null`.

Cross-source local MCP readiness is intentionally `DEGRADED`, not READY, while PRO catalog identity is non-authoritative. This state is operable only for controlled activation. `catalog reload` is blocked until control and workload source roots converge.

## Retry protocol

Do not retry activation from the old candidate after this hardening merges.

After validation, merge, and control-plane promotion:

1. use the already hydrated clean control worktree from exact merged main as the activation candidate;
2. verify candidate HEAD, clean tracked tree, runtime-readiness preflight, and activation fingerprint;
3. verify native supervisor/admin source coherence and no active activation transaction;
4. prepare with exact project/workspace/repository IDs, HEAD, fingerprint, current deployment epoch, runtimeId, and current FULL catalogId;
5. inspect PREPARED transaction;
6. apply;
7. verify READY, `workloadSourceRoot == controlSourceRoot`, persistent runtimeId unchanged, runtime instanceId replaced, deployment epoch advanced, FULL count 49, PRO count still 5, and both FULL/PRO connector hashes bound to the target 2.4 catalog version;
8. verify catalog diagnostics return to `STRICT_CONTROL_SOURCE` and no longer report compatibility-mode UNKNOWN;
9. confirm only after all post-apply invariants pass.

Any post-apply mismatch must remain unconfirmed and use the same transaction's rollback path. Rollback is complete only when the prior source root is READY with the captured persistent runtimeId, catalog identity, and bounded FULL/PRO tool counts restored; deployment epoch may advance during recovery but may never move backwards.

## H3 — Canonical validation gate

No hardening commit, publication, merge, LaunchAgent promotion, or activation retry is allowed before this gate is complete.

Focused validation must cover:

1. `activation-source-identity.test.ts` — missing hydration, valid pnpm-style contained dependencies, built runtime mode, stable source fingerprint after ignored hydration, external symlink rejection, and partial web dependency rejection;
2. `supervisor.test.ts` — pre-cutover dependency TOCTOU rejection, baseline workload preservation, cross-source PRO identity UNKNOWN semantics, baseline-version PRO schema binding and schema-drift rejection, target-version PRO hash derivation, controlled-activation recommendation, catalog-reload refusal, degraded-but-operable cross-source readiness, outer supervisor/admin source coherence, and admin-only recycle anchor preservation;
3. `supervisor-native-control.test.ts` — native endpoint authentication, bounded tool list, arbitrary authority rejection, admin recycle continuity, and activation proxy surface;
4. `supervisor-admin-activation.test.ts` — durable prepare/apply/confirm/rollback semantics remain intact;
5. `activation-controller.test.ts` — transaction state machine remains intact, apply preserves runtimeId and replaces instanceId, PRO tool-count drift fails closed, confirmation detects count drift, and rollback/recovery require the captured runtime/catalog/count baseline;
6. `mcp-catalog.test.ts` — version-bound catalog identity changes hash with catalog version while preserving the five-tool PRO schema surface, and the default identity remains the current 2.4 identity;
7. `connector-registry.test.ts` — a valid-shaped prior-version catalog manifest is detected as stale and reconciled to current FULL/PRO hashes with one deployment-epoch advance while preserving tunnel/machine/runtime/lease ownership.

Canonical repository checks after focused tests:

- `pnpm run typecheck`;
- `pnpm run lint`;
- `pnpm run build`;
- full `pnpm run test`.

If the full parallel suite reproduces only the already documented Phase 3 process-sensitive timing assertions, rerun that exact Phase 3 file with one worker and record the qualified disposition. Any hardening/activation/supervisor test failure is a real blocker and may not be masked by the serial exception.

Before H4 publication, re-check:

- branch still descends from the intended merged-main baseline;
- only reviewed hardening source/tests/docs are staged;
- no package-manager cache is staged;
- live workload runtime/catalog/source binding is unchanged from the post-rollback 2.3 baseline;
- activation transaction store has no non-terminal transaction.

## H3 — Canonical validation plan

Run focused tests first:

1. `activation-source-identity.test.ts`;
2. `activation-controller.test.ts`;
3. `lifecycle.integration.test.ts`;
4. `connector-registry.test.ts`;
5. `mcp-catalog.test.ts`;
6. `supervisor.test.ts`;
7. `supervisor-native-control.test.ts`;
8. `supervisor-admin-activation.test.ts`.

Required focused invariants:

- an unhydrated candidate fails before any activation transaction/cutover can retire workload processes;
- dependency readiness is rechecked at candidate inspection, supervisor pre-cutover, and runtime launch boundaries;
- workspace-domain executable source is included in the activation closure;
- cross-source PRO identity is never fabricated;
- cross-source `catalog reload` is rejected;
- prior-version connector catalog hashes reconcile without changing ownership/fencing identity;
- admin-only recycle changes only the admin child and preserves workload runtime/instance/catalog/epoch/tunnel/web anchors;
- apply preserves persistent runtimeId, replaces runtime instanceId, keeps PRO tool count bounded, and advances deployment epoch;
- rollback restores source/runtime/catalog/FULL/PRO identity and never moves deployment epoch backwards;
- interrupted apply/rollback recovery uses the same identity invariants as live transitions.

Then run:

- typecheck;
- lint;
- build;
- full test suite;
- serial proof for any known process-sensitive Phase 3 failures if the parallel full suite reproduces them.

No commit, publication, merge, or 2.4 retry is accepted before these gates complete.

## Current implementation state

Implementation is isolated from the activation candidate and from live runtime state.

Changed areas:

- activation source runtime-readiness validation;
- production candidate inspection;
- supervisor pre-cutover boundary;
- cross-source PRO catalog diagnostics;
- unit and supervisor integration regressions.

Canonical H3 validation is complete before commit/publication:

- governed hydration: `pnpm run hydrate` PASS from the exact hardening worktree with the frozen lockfile;
- focused activation/source/controller/lifecycle/connector/catalog/native-control/admin-activation suites PASS;
- `supervisor.test.ts`: 29/29 PASS after making the alternate-source fixture reproduce the real TSX runtime dependency closure (`tsx` + `esbuild` + Darwin platform package) and tracking the fixture Vite stub inside its synthetic Git identity;
- `pnpm run typecheck`: PASS;
- `pnpm run lint`: PASS;
- `pnpm run build`: PASS;
- full `pnpm run test`: PASS, including mobile contract 48/48, web 21/21, shared 2/2, and runtime 404/404 across 54 files; the Phase 3 process-sensitive suite also passed in the full parallel run, so no serial exception is needed.

The hydration command uses `.iris-package-home` for Corepack state. `.gitignore` and ESLint ignore policy exclude that governed cache home plus legacy workspace-local package-manager cache paths so hydration cannot pollute the reviewed source boundary.

A fresh `git fetch origin` before H4 confirmed `origin/main` remains exactly `34bc6d9a4f2e4e8b64c13d4490eba2aa2e0bbd96`, the hardening baseline. The local `refs/heads/main` points at a separate historical line and is not an ancestor/descendant of this baseline; H4 must therefore **not** check out, reset, merge into, or otherwise use that local `main`. Publication/integration must remain anchored to the fetched `origin/main` authority or a new worktree created from that exact ref.
