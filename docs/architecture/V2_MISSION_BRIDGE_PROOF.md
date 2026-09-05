# V2 Mission Bridge Integration Proof

## Authority boundary

- Owner remains final authority.
- ChatGPT supplies supervisory directives and does not grant local execution permission.
- Hermes remains orchestration authority for the reasoning session.
- The IRIS mission broker stores durable correlation, checkpoints, and versioned directives only.
- `CapabilityService` remains the only local capability execution authority.
- IRIS Web remains Mission Control / visibility / approval surface.

`MISSION_ASSOCIATION_IS_CORRELATION_ONLY=YES`
`MISSION_BROKER_IS_EXECUTION_AUTHORITY=NO`
`MISSION_BROKER_IS_PERMISSION_AUTHORITY=NO`
`HERMES_IS_EXECUTION_AUTHORITY=NO`
`IRIS_CAPABILITY_SERVICE_IS_EXECUTION_AUTHORITY=YES`
`SUPERVISOR_DIRECTIVE_IS_PERMISSION_APPROVAL=NO`

## Proof bridge

The proof extends the committed mission-execution foundation without changing its ledger schema. A private `mission-broker.json` sidecar correlates one mission with one exact Hermes session, worktree, branch, checkpoint chain, and supervisor directive sequence. Hermes transcript/history remains Hermes-owned and is not duplicated into IRIS.

A supervisor checkpoint is bounded structured data. Recording a checkpoint puts the broker into `AWAITING_SUPERVISOR`; it does not execute any capability. Supervisor directives use optimistic mission versions plus directive IDs/sequences. Duplicate identical directives are idempotent; conflicting duplicates, stale versions, and out-of-order sequences fail closed. Accepting a directive increments the broker mission version exactly once and does not satisfy owner approval.

## Hermes resume

The resume adapter uses an exact `--resume <hermesSessionId>` plus the bound `--in <worktree>`. `latest` is forbidden. Hermes itself fails closed for a missing exact session, and IRIS accepts completion only when stderr confirms both the exact resumed session and exact returned `session_id`. A receipt-repair turn may resume that same session with tools/delegation explicitly forbidden; it never replays completed child work. Missing or stale mappings never create a replacement session.

## Standard governed MCP facade

The Hermes facade speaks MCP protocol `2025-11-25` and implements `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`. The V2 Loop Engineer profile exposes bounded runtime/mission/Git/file reads plus mission task/action preparation and exact `project_file_write`. It exposes no direct shell, delete, or unrestricted Git command. Every local capability still enters `CapabilityService`; the MCP facade is translation only.

`project_git_status` verifies the broker mapping, foundation mission, registered worktree, live session, and current project, then calls the existing `CapabilityService` using the LOW / PROJECT / read-only `project.git_status` capability. Git is inspected by IRIS with a bounded `/usr/bin/git status --porcelain=v1 --branch` process; Hermes never receives direct Git execution authority. Prepared `project_file_write` preserves the existing IRIS permission/approval path and exact mission/task/action association.

## Pull-based supervisor transport

The owner-authenticated ChatGPT-facing MCP can list missions waiting for supervisor review, read broker-augmented mission state and bounded events, and submit a versioned directive. These operations read/write only the durable mission broker correlation state. A supervisor directive never satisfies permission approval and never executes a local capability. Push-style unsolicited messages into ChatGPT are not required; durable pull-based `AWAITING_SUPERVISOR` state is the V2 transport contract.

## Live proof status

The durable broker, exact-session adapter, standard MCP handshake/tool contract, governance routing, and replay rules are covered by focused automated tests and a real Hermes end-to-end proof. Hermes v0.20.0 authenticated through OpenAI Codex OAuth, resumed the exact mission-bound session `20260905_201806_2c0919`, discovered the read-only `project_git_status` tool through the standard MCP facade, and called it through IRIS governance. IRIS returned structured branch/cleanliness evidence for the bound integration worktree. Hermes converted that result into a bounded supervisor checkpoint.

The broker then accepted a second versioned `COMPLETE` directive and resumed the same Hermes session. Hermes returned a structured completion receipt with `missionComplete=true`, and the broker durably transitioned the mission to `COMPLETED` without replay or session substitution.

`V2_0_ARCHITECTURAL_LOOP_PROVEN=YES`
