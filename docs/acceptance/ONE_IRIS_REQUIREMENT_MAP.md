# One IRIS requirement-to-code map

This is the M00 source and authority record for the candidate branch. The
attached Markdown and TXT mission files are byte-identical; the user request
authorizes work on this candidate and forbids merge, deploy, live-runtime
changes, registry edits, credential changes, push to `main`, and any claim of
`ONE_IRIS_ACCEPTED`. The attached documents define the requirements and gates;
they do not replace those user boundaries.

## Source and authority

| Source | Candidate evidence | Authority / limit |
|---|---|---|
| PR #30 (`5aa0249b6c0ce3c312776096a49c6e378f2a1145`) | Unified connector, supervisor, setup, UI and checkpoint chain is an ancestor of this candidate | Draft source; disposable evidence only until required acceptance |
| PR #29 (`112be52873bafd0b0df6884b92fa45c1ee770202`) | Repository identity reconciliation files are integrated by `f35d22e` | Draft source; no live registry operation was run |
| PR #31 (`9a4e13ca1318af097d53f8d89f608d0879dcf2b4`) | Production safety fence, writer proof and backup/restore safety files are ancestors of this candidate | Draft source; live quiescence/migration remains owner-controlled |
| Candidate | `codex/one-iris-completion`, current HEAD recorded in the final report | Reviewable branch only; `main` remains unchanged at `b0aa47dc00784452f5ecb98d5297d9a91f64b8e2` |
| Existing acceptance evidence | `docs/acceptance/RELEASE_ACCEPTANCE.md`, `OWNER_ACCEPTANCE_PLAN.md`, `MIGRATION_ROLLBACK_RUNBOOK.md` | Existing records are evidence and runbook, not proof of a new real-machine PASS |

Status vocabulary: **IMPLEMENTED** means source and disposable tests cover the
contract; **DISPOSABLE_ONLY** means the local contract is tested but real
machine/provider/ChatGPT evidence is missing; **UNVERIFIED** means the required
observation was not run; **BLOCKED** means the supported operation cannot safely
be run under the current authorization or the implementation is incomplete.

## R01–R09

| Requirement | Source / commit | Focused evidence | Status | Gap, owner and next action |
|---|---|---|---|---|
| R01 one connector/tunnel and machine identity isolation | `connector-registry.ts`, `server.ts`, `supervisor.ts`; PR30 + `214587e` | `connector-registry.test.ts`, `mcp-catalog.test.ts`, `unified-iris.test.ts` | DISPOSABLE_ONLY | Owner must prove non-production provider tunnel ownership and two-machine routing; do not reuse credentials or registry. |
| R02 workload OFF/ON separate from whole-stack down | `supervisor.ts`, `lifecycle.ts`, `supervisor-admin.ts` | `supervisor.test.ts`, lifecycle integration | BLOCKED | Candidate has whole-stack `down()` and idempotent `up()/restart()`, but no supported workload-only OFF/ON path that keeps gateway/tunnel authority available. Add and test that lifecycle before acceptance. |
| R03 workspace-scoped autonomy and containment | `capability-service.ts`, `permissions.ts`, `execution-profiles.ts`, `project-path.ts`, `governed-git-engine.ts` | capability, path, governed Git and repository reconciliation tests | DISPOSABLE_ONLY | Real owner UI workflow and OS/Codex approval boundary remain unverified; owner runs representative in-scope and out-of-scope checks. |
| R04 durable sessions/jobs and multi-project isolation | `state.ts`, `durable-job-manager.ts`, `mission-broker.ts`, `server.ts` | lifecycle integration, mission bridge, MCP v2.1 and job tests | DISPOSABLE_ONLY | Two real projects/connectors and restart/replacement recovery are not run; owner must capture job target/result evidence. |
| R05 one canonical task checkpoint | `scripts/task-checkpoint.mjs`, `docs/architecture/UNIFIED_IRIS.md` | `scripts/task-checkpoint.test.mjs` | IMPLEMENTED | Keep one checkpoint per task and inspect it before handoff; verify current candidate revision after saving. |
| R06 keep-awake and truthful physical evidence | `macos-safety.ts`, supervisor lifecycle | macOS safety and lifecycle tests | BLOCKED | No verified candidate keep-awake provider/lease lifecycle or real physical sleep evidence is available. Owner must supply a supported macOS test window; do not claim physical PASS. |
| R07 truthful UI/backend state and intended host | `apps/web/src/App.tsx`, `mission-control-v21.tsx`, `server.ts` | web typecheck and runtime server/UI tests | DISPOSABLE_ONLY | Authenticated Owner UI interaction with the registered candidate and failure/pending timestamps remain unverified. |
| R08 fresh setup, isolation, login persistence and reinstall | `control.ts`, `scripts/iris-acceptance.mjs`, `docs/INSTALLATION.md` | `control-setup.test.ts`, `scripts/iris-acceptance.test.mjs`, launchd tests | DISPOSABLE_ONLY | Fresh macOS install, owned login/reboot/uninstall/reinstall and real credential persistence require an owner-authorized disposable machine. |
| R09 writer lifecycle, backup/restore, migration and rollback | `production-safety.ts`, `production-safety.test.ts`, migration runbook | 22 production-safety tests and focused runtime suite | DISPOSABLE_ONLY | Live quiescence, provider/state migration and rollback are explicitly blocked until the owner authorizes a controlled window with independent evidence. |

## Required acceptance A01–A13

| Gate | Current result | Evidence / missing action |
|---|---|---|
| A01 unified surface/auth | DISPOSABLE_ONLY | Authenticated local `/mcp` and catalog tests pass; real Owner UI and remote tunnel are unverified. |
| A02 workload OFF→ON | BLOCKED | No workload-only lifecycle endpoint/command exists; implement and test before real acceptance. |
| A03 scope autonomy | DISPOSABLE_ONLY | Local capability and path denial tests pass; owner UI and OS approval boundary unverified. |
| A04 multi-project | DISPOSABLE_ONLY | Durable project/session tests pass locally; two-machine/project routing unverified. |
| A05 durable recovery | DISPOSABLE_ONLY | Restart/recovery fixtures pass; live restart and durable job evidence unverified. |
| A06 handoff | DISPOSABLE_ONLY | Checkpoint and mission handoff tests pass; owner handoff on registered target unverified. |
| A07 keep-awake | BLOCKED | Physical provider/lease evidence is unavailable under the current authorized window. |
| A08 functional UI | DISPOSABLE_ONLY | UI/runtime checks pass locally; authenticated intended-host interaction unverified. |
| A09 clean setup/reinstall | DISPOSABLE_ONLY | Disposable setup wrapper and setup tests pass; real clean-machine reinstall unverified. |
| A10 login persistence | UNVERIFIED | LaunchAgent rendering is tested; no authorized login/reboot run was performed. |
| A11 migration/safety | DISPOSABLE_ONLY | Safety fence/backup/restore tests pass; live migration and rollback are blocked. |
| A12 RARW/bill isolation | UNVERIFIED | No two-Mac acceptance was authorized or run. |
| A13 regression/review | DISPOSABLE_ONLY | Focused tests, typechecks and existing review artifacts pass locally; independent current candidate review/CI remains required. |

No row above is a production acceptance claim. `NOT_RUN`, `UNVERIFIED` and
`BLOCKED` remain non-passing states under the merge gate.
