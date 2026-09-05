# V1.3 ChatGPT-primary workflow

Baseline: `2a9729d06910aaef508a8695fc28b99895671414` (`feat(agent): connect production model executor`).

## Canonical product roles

- `PRIMARY_UX=ChatGPT`
- `LOCAL_WEB_ROLE=ControlAndVisibility`
- `LOCAL_DAEMON_ROLE=ExecutionAuthority`
- `PLUGIN_ROLE=ChatGPTToLocalBridge`
- `STANDALONE_EXECUTOR_ROLE=Optional`

The normal V1.3 daily path is:

`ChatGPT → IRIS connector/plugin → authoritative local daemon → live session/project → permission decision → governed local capability → structured result → ChatGPT`

The connector/plugin is a bridge, not a second authority. Local execution must remain governed by IRIS capability policy, live session/project identity, approval state, and audit. Approval-required work must preserve originating action/session identity until owner resolution; the bridge must not reinterpret approval as execution authority.

The repo-local `/mcp` endpoint remains a deliberately narrow stateless daemon integration surface. It exposes runtime/project observation and structured project file/directory capabilities through the same `CapabilityService` as Web/API. It does not claim arbitrary shell. The installed ChatGPT IRIS connector may expose additional governed host/project operations; those must remain policy-governed and must not be misrepresented as repo-local MCP tools until implemented there.

## Web role

The localhost Web app exists primarily for active project/session visibility, runtime health, permissions/settings, Approval Center, recent activity, and diagnostics. Its existing session conversation composer is retained as an optional standalone/validation surface and is not the V1.3 primary conversational UX.

## Standalone executor

The OpenAI-backed production `AgentExecutor` remains implemented and preserved. It is optional for standalone IRIS execution, local background/autonomous work, and future automation. The current real-provider operational proof failed safely because required configuration was not visible to the authoritative runtime:

- `REAL_PROVIDER_SMOKE=FAILED_SAFE`
- `PRODUCTION_MODEL_CONNECTED=NO`
- `STANDALONE_REAL_MODEL_USABLE=BLOCKED`
- `PRIMARY_CHATGPT_WORKFLOW_DEPENDENCY=NO`

## V1.3 done criteria

`V1_3_DONE_CRITERIA=`

1. ChatGPT can invoke the installed IRIS connector against the registered local IRIS workspace.
2. The connector can return bounded local workspace/project/runtime information to ChatGPT.
3. Governed local project actions remain under IRIS permission policy rather than bridge authority.
4. Project/session identity remains daemon-authoritative where runtime capabilities require it.
5. Approval-required actions are explicit, execute nothing before approval, and retain exact action/session identity through resolution.
6. The localhost Web app exposes control/visibility and Approval Center without becoming a second authority.
7. Existing trust-hardening, session isolation, MCP policy enforcement, audit, and local permission smoke remain green.
8. Standalone production-model connectivity is optional and may remain safely blocked without blocking ChatGPT-driven V1.3 use.

## V1.4 direction

`V1_4_DIRECTION=` richer ChatGPT→IRIS execution workflows, approval-aware action continuation, execution timeline, stronger task/session continuity, and optional standalone autonomous mode. Multi-agent orchestration, model routing, and autonomous tool loops are not implied by V1.4 and require separate authorization.

## Bounded connector proof

During this realignment, the active ChatGPT conversation used the installed IRIS connector to resolve the registered `/Users/bill/iris` workspace and execute the read-only governed project command `git status --short --branch`, returning the local repository status to ChatGPT. Connector discovery also confirmed native persisted session context/resume/history tools and governed workspace/shell/project operations are available to ChatGPT. No destructive mutation was used for proof.

The connector's external child-MCP catalog was empty during this proof. That is not a bridge failure: these ChatGPT-facing IRIS capabilities are native connector tools and are intentionally not flattened into child MCP servers. The clean-sheet daemon's repo-local `/mcp` contract remains the narrow structured capability surface documented above.
