# V2.0 Bridge Integration Proof

- Base: `e25d416db9bceb7f7f5026ccc902f2154d47be60`
- Mission foundation input: `e49dd5b9e9836095b4e7bceb378b6ecdfb9b7ee7`
- Integration branch: `v2/bridge-integration-proof`
- Integration worktree: `/Users/bill/iris-v2-bridge-integration-proof`

## Proven in code/tests

- Durable mission-to-exact-Hermes-session mapping.
- Explicit versioned rebind; no implicit global latest session.
- Structured bounded supervisor checkpoint persistence.
- Versioned directives with idempotent duplicate IDs and fail-closed conflicting/stale/out-of-order directives.
- Directive acceptance never grants IRIS capability permission or owner approval.
- Standard Hermes MCP 2025-11-25 initialize/list/call surface.
- The standard Hermes MCP facade now exposes the bounded V2 governed profile: runtime/mission/Git/file reads, declared `project.test.run`, prepared mission task/action, and exact `file.write`; it still exposes no direct shell, delete, arbitrary command, or unrestricted Git capability.
- All local reads/writes route through existing IRIS permission policy and `CapabilityService`; successful execution is auditable and mission metadata remains correlation-only.
- The ChatGPT-facing MCP exposes pull-based `mission_list_waiting_supervisor`, broker-augmented `mission_get`, bounded `mission_events`, and versioned `mission_directive`. These broker operations transport supervisor state only and grant no local permission.
- Web Mission Control renders the broker state, exact Hermes session, current checkpoint/evidence/blockers, and last directive while remaining non-authoritative.
- Completed broker state is durable and cannot resume/replay.
- Foundation mission-execution tests remain green after integration.

## Live Hermes proof

Hermes v0.20.0 is authenticated through OpenAI Codex OAuth and the live proof completed with the exact bound session `20260905_201806_2c0919` on `gpt-5.6-luna`. The first continuation correctly failed closed when the MCP tool was unavailable. After the read-only MCP facade was available, the same Hermes session called `mcp__iris_v2_bridge_proof__project_git_status`, received the structured IRIS-governed result for branch `v2/bridge-integration-proof`, and returned a bounded supervisor checkpoint. A second versioned `COMPLETE` directive resumed the same session and returned `missionComplete=true`.

The durable broker record for mission `775d2e18-e29a-471e-8b8b-8d6db27edd94` is `COMPLETED` at mission version 3 with directive sequence 2. Hermes session history records two MCP tool calls and the governed `project_git_status` result; no direct Git/shell mutation was used for the proof.

## Delegated inner-loop checkpoint recovery

A later live mission (`e4a4d94f-9460-4033-ac9b-39f23bd915e7`) bound parent Hermes session `20260905_205024_29fc7f` and delegated exactly one read-only leaf (`20260905_205101_b45cf3`). The leaf inherited `iris_v2_inner_loop`, called only `project_git_status`, received branch `v2/bridge-integration-proof` with `clean=true`, and used no native terminal/file/git/shell mutation. The parent initially emitted a malformed checkpoint boolean. IRIS preserved the child evidence, rejected the malformed receipt, resumed the same parent session for a receipt-only repair with tools/delegation forbidden, and durably stored checkpoint `da3b4479-4a17-4022-a333-d1a243067c8c` at broker state `AWAITING_SUPERVISOR` without replaying the child.

`HERMES_SUBAGENT_DELEGATION=PASS`
`SUBAGENT_IRIS_TOOL_INHERITANCE=PASS`
`SUBAGENT_DIRECT_SHELL_BYPASS=NO`
`SUBAGENT_DIRECT_FILE_BYPASS=NO`
`HERMES_CHECKPOINT_SCHEMA=PASS`
`LIVE_HERMES_REASONING_LOOP=PASS`
`V2_0_ARCHITECTURAL_LOOP_PROVEN=YES`

## Reproducible V2.0 daily-use acceptance

The repository-owned acceptance command `pnpm --filter @iris/runtime v2-acceptance` drives a disposable project through the real daemon and mission-bound `/hermes-mcp/<missionId>` endpoint; it does not create another permission engine, mission store, protocol authority, or orchestrator. Acceptance setup registers its project/session and permission mode through the owner-authenticated daemon API, establishes the `project.test.run` project override through the real CapabilityService owner-approval path, and fails closed if either the Hermes parent or child uses native project shell/Git/file tools instead of the mission-bound MCP profile.

Final V2 hardening also requires a mission-scoped HMAC bearer credential on `/hermes-mcp/<missionId>`, serializes initial mission-action claims to prevent concurrent duplicate approval/execution, and denies Hermes reads of secret-like project paths or high-confidence credential/private-key content.

A successful live acceptance mission (`0f0f5bc1-5497-4670-93a2-f1b1c266d4b5`) used exact parent Hermes session `20260905_234315_c65015` and exactly one leaf `20260905_234413_cdb0a9`. The parent observed a failing governed `project.test.run`, delegated an IRIS-MCP-only fixture inspection, prepared one exact `file.write`, stopped at `OWNER_DECISION_REQUIRED`, and continued only after the owner-authenticated IRIS approval executed that action once. The same Hermes session then treated the durable action result as non-replayable evidence, prepared a fresh `project.test.run`, received `passed=true`, and opened a structured supervisor checkpoint.

The checkpoint was discoverable through the ChatGPT-facing pull bridge without manual mission-state copy/paste. A versioned `COMPLETE` directive resumed the same Hermes session, the broker completed durably, daemon restart preserved the completed mission, and the completed runtime session was not rehydrated or replayed. Session evidence showed the parent and leaf used the mission-bound IRIS MCP for project access; direct native project shell/Git/file mutation was not observed.

`V2_0_ACCEPTANCE_MISSION=PASS`
`HERMES_INNER_LOOP=PASS`
`HERMES_SUBAGENTS=PASS`
`HERMES_TO_IRIS_PROJECT_TEST=PASS`
`HERMES_TO_IRIS_GOVERNED_MUTATION=PASS`
`APPROVAL_CONTINUATION=PASS`
`SUPERVISOR_OUTER_LOOP=PASS`
`RESTART_RECOVERY=PASS`
`NO_REPLAY=PASS`
`NO_MANUAL_COPY_PASTE_REQUIRED_FOR_NORMAL_SUPERVISOR_STATE_TRANSFER=PASS`
