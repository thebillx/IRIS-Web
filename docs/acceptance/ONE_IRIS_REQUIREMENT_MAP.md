# One IRIS requirement-to-code map

This is the single M00–M02 requirement map for PR #32. It records source
contracts separately from automated evidence and owner acceptance. The
candidate remains review-only; the map is not an acceptance claim.

## Source and authority

| Source | Candidate evidence | Authority / limit |
|---|---|---|
| PR #30 | Unified connector, Supervisor, setup, UI and checkpoint chain through `5aa0249b6c0ce3c312776096a49c6e378f2a1145` | Draft source; disposable evidence only until owner acceptance |
| PR #29 | Repository identity reconciliation integrated by `f35d22e` | Draft source; no live registry operation was run |
| PR #31 | Production safety fence and backup/restore foundation through `9a4e13ca1318af097d53f8d89f608d0879dcf2b4` | Draft source; live quiescence/migration remains owner-controlled |
| M02 implementation | `70086a7a476a001888f3d6abbf8fd670cc3f9e44`, restart-contract test `49290d8`, integrated session fence/authority plus unified control-channel fix `c2042ab`, P1 closure `ec5f199`, lifecycle/workspace authority fix `6ed0297`, published workspace/uncertain-outcome fix `b06300e`, uncertain-session/detach fix `19cdf53`, MCP boundary/catalog compatibility fix `256805a`, and legacy workspace boundary fix `c7a890b` | Candidate source only; `main` remains unchanged |
| Existing acceptance records | `docs/acceptance/RELEASE_ACCEPTANCE.md`, `OWNER_ACCEPTANCE_PLAN.md`, `MIGRATION_ROLLBACK_RUNBOOK.md` | Runbooks and disposable evidence, not new real-machine PASS evidence |

Status vocabulary: **IMPLEMENTED** means the source contract exists and local
tests cover it; **PARTIAL** means a bounded portion is implemented but a
required source path is still absent; **DISPOSABLE_ONLY** means local evidence
exists while real provider/machine/ChatGPT evidence is missing; **BLOCKED**
means the supported operation cannot safely proceed under current authority.

## R01–R09

| Requirement | Code implementation status | Automated test evidence | Independent review status | Required acceptance status | Blocker classification | Source/commit evidence | Owner and exact next action |
|---|---|---|---|---|---|---|
| R01 one connector/tunnel and machine identity isolation | IMPLEMENTED | Connector registry, MCP catalog and unified connector tests pass | READY (prior review) | DISPOSABLE_ONLY | External provider and machine routing are unverified | `connector-registry.ts`, `server.ts`, `supervisor.ts`; PR30, `214587e`, `70086a7` | Owner proves non-production tunnel ownership and intended-host routing with read-only evidence |
| R02 workload OFF/ON separate from whole-stack shutdown | IMPLEMENTED | Supervisor OFF → status/doctor → ON, repeated OFF, concurrent ON binding verification, persisted-OFF dead-tunnel recovery, explicit stack-down persistence, workload restart intent, unified admin-channel profile and native-control authentication tests pass | READY (prior review) | DISPOSABLE_ONLY | Public provider routing while workload is OFF remains owner acceptance; daemon deliberately preserves persisted OFF | `supervisor.ts`, `supervisor-native-control.ts`, `control.ts`; `70086a7`, `c2042ab`, `ec5f199`, `6ed0297` | Owner runs authenticated unified-tunnel OFF → status/doctor → ON and records same-machine identity |
| R03 workspace-scoped autonomy and containment | IMPLEMENTED | Capability, path, symlink/hardlink, governed Git and repository reconciliation tests pass | READY (prior review) | DISPOSABLE_ONLY | Owner UI/OS approval boundary and representative real project workflow are unverified | `capability-service.ts`, `permissions.ts`, `execution-profiles.ts`, `project-path.ts`, `governed-git-engine.ts`; PR29–31 chain | Owner runs in-scope edit/test/Git and out-of-scope/reference/interpreter escape checks |
| R04 durable sessions, jobs and multi-project isolation | IMPLEMENTED | 70 focused runtime audit tests pass across state, capability, daemon, MCP and mission bridges; durable session authority/binding, versioned workspace selection, fenced admission/completion rollback, UNCERTAIN handling, revoked detach and duplicate prevention remain covered | READY (prior review; call-site audit clean) | DISPOSABLE_ONLY | Real replacement, workspace revocation and two-project routing evidence are absent | `state.ts`, `capability-service.ts`, `mcp.ts`, `mcp-catalog.ts`, `durable-job-manager.ts`; `6ed0297`, `b06300e`, `19cdf53`, `256805a`, `c7a890b` | Owner verifies session resume, duplicate submission, captured job cancel, project/workspace revocation and switching on registered target |
| R05 one canonical task checkpoint | IMPLEMENTED | `scripts/task-checkpoint.test.mjs` passes, including unknown-outcome verification | READY (prior review) | IMPLEMENTED (source/local) | No current code blocker; acceptance still records the checkpoint | `scripts/task-checkpoint.mjs`; prior checkpoint revisions 5–6 | Coordinator inspects/saves the canonical checkpoint before each handoff |
| R06 keep-awake and truthful physical evidence | BLOCKED | No provider/lease implementation exists; Amphetamine 5.3.2 cannot identify or release IRIS-owned sessions safely; no privileged Power Protect path used | CHANGES_REQUIRED (provider blocker) | BLOCKED | No documented provider contract or ownership-safe integration | Source-authority audit of `macos-safety.ts`, Supervisor and platform files; no speculative code added | Owner supplies a documented provider interface and authorizes a disposable ownership/restart test; then implement one Supervisor-owned lease |
| R07 truthful UI/backend state and intended host | PARTIAL | Web 25 tests plus Supervisor-control rendering; authenticated Vite owner bridge forwards native Supervisor status/doctor/workload ON/OFF/restart; keep-awake/jobs remain blocked or incomplete | CHANGES_REQUIRED | DISPOSABLE_ONLY | Keep-awake and job surfaces are unavailable; intended-host interaction remains unverified | `apps/web/src/App.tsx`, `apps/web/vite.config.ts`, `apps/runtime/src/supervisor.ts`; `2c85124` | UI/owner verifies pending/failure/stale/wrong-machine states and completes job/keep-awake contracts after R06/R04 backend closure |
| R08 fresh setup, isolation, login persistence and reinstall | IMPLEMENTED | Acceptance wrapper 21 tests pass, including positive non-production evidence path, process identity and acceptance-registry binding, and rejection of malformed/stale/process-mismatch evidence | READY for independent review | BLOCKED | Physical provider evidence and real startup remain owner-controlled | `scripts/iris-acceptance.mjs`, `scripts/iris-acceptance.test.mjs`, `OWNER_ACCEPTANCE_PLAN.md`; `5359c70` | Owner supplies redacted evidence file, runs wrapper preflight and authorized startup; no `--force` bypass |
| R09 writer lifecycle, backup/restore, migration and rollback | PARTIAL | 25 production-safety tests pass, including fresh stale-writer rejection and persisted external ACTIVE/inFlight accounting; full reservation/copy fencing and production writer inventory remain unresolved | CHANGES_REQUIRED (S03 remains) | BLOCKED | S03 requires a real maintenance fence or complete writer admission instrumentation; live inventory is not claimed | `production-safety.ts`, `production-safety.test.ts`; `2c85124`, PR31 foundation | Safety owner implements/authorizes a held maintenance boundary and proves all production writers before acceptance |

## Required acceptance A01–A13

| Gate | Current result | Evidence / missing action |
|---|---|---|
| A01 unified surface/auth | DISPOSABLE_ONLY | Authenticated local native/runtime paths pass; real Owner UI and remote tunnel are unverified |
| A02 workload OFF→ON | DISPOSABLE_ONLY | Unified profile now carries the authenticated native Supervisor admin channel while workload is OFF; owner must prove the public tunnel route itself remains reachable |
| A03 scope autonomy | DISPOSABLE_ONLY | Local capability/path denial and governed Git tests pass; owner UI and OS approval boundary remain unverified |
| A04 multi-project | DISPOSABLE_ONLY | Session/job target isolation passes locally; two real projects/connectors remain unverified |
| A05 durable recovery | DISPOSABLE_ONLY | Ordinary sessions and jobs survive supported replacement locally; real restart evidence is missing |
| A06 handoff | DISPOSABLE_ONLY | Canonical checkpoint and mission handoff tests pass; owner handoff on registered target is unverified |
| A07 keep-awake | BLOCKED | No authorized provider/lease integration or physical evidence exists |
| A08 functional UI | DISPOSABLE_ONLY | Web 25 tests/build pass; owner-authenticated Supervisor status/doctor/workload controls are exposed through the local bridge, while keep-awake/job controls and intended-host interaction remain unverified |
| A09 clean setup/reinstall | DISPOSABLE_ONLY | Disposable setup wrapper passes; clean-machine reinstall is unverified |
| A10 login persistence | UNVERIFIED | LaunchAgent rendering is tested; no login/reboot run was authorized |
| A11 migration/safety | DISPOSABLE_ONLY | Disposable fence/backup/restore passes; live migration and rollback are blocked |
| A12 RARW/bill isolation | UNVERIFIED | No two-Mac acceptance was authorized or run |
| A13 regression/review | DISPOSABLE_ONLY | Candidate source `5359c70` (docs head follows): runtime broad 85 files/780 tests, focused runtime 107 tests, acceptance 21 tests, Web 25 tests/build, typechecks, changed-file lint and diff checks pass; exact-head GitHub CI is NOT_RUN because the candidate was not pushed; prior run `38073274055` was for documentation-only `38c7755` |

No row above is a production acceptance claim. `NOT_RUN`, `UNVERIFIED` and
`BLOCKED` remain non-passing under the merge gate. The original Enhance01
authorization is not reported as restored until governed Git access to that
original workspace is independently verified.
