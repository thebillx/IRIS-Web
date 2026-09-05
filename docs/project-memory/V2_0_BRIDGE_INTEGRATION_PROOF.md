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
- Only `project_git_status` is exposed to Hermes in this proof.
- `project_git_status` routes through existing IRIS permission policy and `CapabilityService`; successful execution is auditable.
- Completed broker state is durable and cannot resume/replay.
- Foundation mission-execution tests remain green after integration.

## Live Hermes proof

Hermes v0.20.0 is authenticated through OpenAI Codex OAuth and the live proof completed with the exact bound session `20260905_201806_2c0919` on `gpt-5.6-luna`. The first continuation correctly failed closed when the MCP tool was unavailable. After the read-only MCP facade was available, the same Hermes session called `mcp__iris_v2_bridge_proof__project_git_status`, received the structured IRIS-governed result for branch `v2/bridge-integration-proof`, and returned a bounded supervisor checkpoint. A second versioned `COMPLETE` directive resumed the same session and returned `missionComplete=true`.

The durable broker record for mission `775d2e18-e29a-471e-8b8b-8d6db27edd94` is `COMPLETED` at mission version 3 with directive sequence 2. Hermes session history records two MCP tool calls and the governed `project_git_status` result; no direct Git/shell mutation was used for the proof.

`LIVE_HERMES_REASONING_LOOP=PASS`
`V2_0_ARCHITECTURAL_LOOP_PROVEN=YES`
