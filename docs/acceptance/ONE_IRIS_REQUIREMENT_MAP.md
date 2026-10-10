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

| Requirement | Code implementation status | Automated test evidence | Required acceptance status | Blocker classification | Source/commit evidence | Owner and exact next action |
|---|---|---|---|---|---|---|
| R01 one connector/tunnel and machine identity isolation | IMPLEMENTED | Connector registry, MCP catalog and unified connector tests pass | DISPOSABLE_ONLY | External provider and machine routing are unverified | `connector-registry.ts`, `server.ts`, `supervisor.ts`; PR30, `214587e`, `70086a7` | Owner proves non-production tunnel ownership and intended-host routing with read-only evidence |
| R02 workload OFF/ON separate from whole-stack shutdown | IMPLEMENTED | Supervisor OFF → status/doctor → ON, repeated OFF, concurrent ON binding verification, persisted-OFF dead-tunnel recovery, explicit stack-down persistence, workload restart intent, unified admin-channel profile and native-control authentication tests pass | DISPOSABLE_ONLY | Public provider routing while workload is OFF remains owner acceptance; daemon deliberately preserves persisted OFF | `supervisor.ts`, `supervisor-native-control.ts`, `control.ts`; `70086a7`, `c2042ab`, `ec5f199`, `6ed0297` | Owner runs authenticated unified-tunnel OFF → status/doctor → ON and records same-machine identity |
| R03 workspace-scoped autonomy and containment | IMPLEMENTED | Capability, path, symlink/hardlink, governed Git and repository reconciliation tests pass | DISPOSABLE_ONLY | Owner UI/OS approval boundary and representative real project workflow are unverified | `capability-service.ts`, `permissions.ts`, `execution-profiles.ts`, `project-path.ts`, `governed-git-engine.ts`; PR29–31 chain | Owner runs in-scope edit/test/Git and out-of-scope/reference/interpreter escape checks |
| R04 durable sessions, jobs and multi-project isolation | IMPLEMENTED | Durable session authority/binding, published atomic workspace selection, versioned `workspace_select_v27` workspace binding, legacy workspace selection rejects out-of-schema workspace arguments, concurrent mismatch denial, fenced admission/completion publication rollback, explicit UNCERTAIN completion outcome without replay, new submissions fenced until verification, revoked-session detach through the real MCP close path, interleaved project selection, lifecycle/mission/daemon restart tests, durable-job and mission-bridge tests pass; immutable job targets and duplicate prevention remain existing contracts | DISPOSABLE_ONLY | Real replacement, workspace revocation and two-project routing evidence are absent | `state.ts`, `capability-service.ts`, `mcp.ts`, `mcp-catalog.ts`, `durable-job-manager.ts`, `mission-broker.ts`, `resource-registry.ts`; `70086a7`, `49290d8`, `c744abe`, `c2042ab`, `ec5f199`, `6ed0297`, `b06300e`, `19cdf53`, `256805a`, `c7a890b` | Owner verifies session resume, duplicate submission, captured job cancel, project/workspace revocation and switching on registered target |
| R05 one canonical task checkpoint | IMPLEMENTED | `scripts/task-checkpoint.test.mjs` passes, including unknown-outcome verification | IMPLEMENTED (source/local) | No current code blocker; acceptance still records the checkpoint | `scripts/task-checkpoint.mjs`; prior checkpoint revisions 5–6 | Coordinator inspects/saves the canonical checkpoint before each handoff |
| R06 keep-awake and truthful physical evidence | BLOCKED | No provider/lease implementation exists; only bounded macOS safety tests are present | BLOCKED | No documented provider contract or owner-authorized Amphetamine integration | Source-authority audit of `macos-safety.ts`, Supervisor and platform files; no speculative code added | Owner supplies a documented provider interface and authorizes a disposable ownership/restart test; then implement one Supervisor-owned lease |
| R07 truthful UI/backend state and intended host | PARTIAL | Existing web tests/build plus explicit UNCERTAIN non-ready/blocked-send coverage pass; backend lifecycle controls are authenticated native Supervisor tools, not yet exposed as Web controls | DISPOSABLE_ONLY | Web lifecycle/keep-awake/job controls and intended-host interaction remain unverified | `apps/web/src/App.tsx`, `server.ts`, native control; `70086a7`, `19cdf53` | UI worker wires only stable backend contracts, then owner verifies pending/failure/stale/wrong-machine states |
| R08 fresh setup, isolation, login persistence and reinstall | PARTIAL | Acceptance wrapper and checkpoint tests pass; remote startup remains fail-closed | BLOCKED | No supported authoritative provider verifier/local startup evidence path is authorized | `scripts/iris-acceptance.mjs`; existing guard and docs | Owner authorizes the documented provider lookup implementation or keeps remote startup blocked; no `--force` bypass |
| R09 writer lifecycle, backup/restore, migration and rollback | IMPLEMENTED | 22 production-safety tests plus focused supervisor/activation tests pass in disposable roots | DISPOSABLE_ONLY | Live writer inventory/quiescence and migration window are owner-controlled | `production-safety.ts`, `production-safety.test.ts`; PR31 | Owner supplies exact maintenance window, independent writer evidence, disposable restore proof and rollback observation |

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
| A08 functional UI | DISPOSABLE_ONLY | Existing UI/session truth tests pass; lifecycle/job controls are not yet exposed in Web and intended-host interaction is unverified |
| A09 clean setup/reinstall | DISPOSABLE_ONLY | Disposable setup wrapper passes; clean-machine reinstall is unverified |
| A10 login persistence | UNVERIFIED | LaunchAgent rendering is tested; no login/reboot run was authorized |
| A11 migration/safety | DISPOSABLE_ONLY | Disposable fence/backup/restore passes; live migration and rollback are blocked |
| A12 RARW/bill isolation | UNVERIFIED | No two-Mac acceptance was authorized or run |
| A13 regression/review | DISPOSABLE_ONLY | Runtime 85 files/778 tests, Web 24 tests/build, typechecks, lint and diff checks pass; independent current review is closed at `256805a`; exact-head CI run `38072768326` passed for candidate `0bc52b4` (focused job `114273434851`) |

No row above is a production acceptance claim. `NOT_RUN`, `UNVERIFIED` and
`BLOCKED` remain non-passing under the merge gate. The original Enhance01
authorization is not reported as restored until governed Git access to that
original workspace is independently verified.
