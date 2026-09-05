# Real model provider integration

Baseline: `d4a7716f5d515db0074aa14fbedc4a4f7f92f605` (`feat(agent): add session conversation execution flow`).

## Product slice

IRIS keeps the existing authoritative session/execution path and adds exactly one real production provider behind `AgentExecutor`: OpenAI Responses API.

Canonical behavior:

- Executor selection is explicit and deterministic through `IRIS_AGENT_EXECUTOR=development|openai`; unset remains the local development executor.
- OpenAI mode uses daemon-only `OPENAI_API_KEY` plus required `IRIS_OPENAI_MODEL`. Missing production configuration fails intentionally and never falls back to development execution.
- The lifecycle child environment forwards only those named provider variables in addition to the existing bounded runtime variables. Arbitrary inherited tokens and `NODE_OPTIONS` remain excluded.
- The production executor is `production-provider-executor`. It uses one non-streaming Responses API request with `store=false`, bounded instruction, bounded response body/text, explicit model, finite timeout, and no automatic retries.
- Provider context is deliberately small: current user instruction plus stable IRIS agent role and whether an active project is selected. Project names, local paths, repository contents, client/session/execution IDs, secrets, audit/permission state, MCP state, other sessions, and conversation dumps are not sent.
- Provider output is mapped to the existing `AgentExecutionResult{text}`. `RuntimeState` remains authoritative for submission binding, duplicate protection, session ownership, execution state, failure state, and conversation history.
- Provider/network/authentication/timeout/malformed-response failures remain behind the existing safe executor failure boundary. Raw provider diagnostics never become normal API/Web/history text.
- `productionModelConnected` begins false and changes to true only after the production executor completes a real provider request with a valid bounded response; configuration presence alone does not claim connectivity.
- Normal tests use injected fake provider HTTP behavior and never require a real API key or billable request.

Out of scope: multi-provider routing, fallback, tool calling, autonomous orchestration, streaming UX, remote session storage, cloud IRIS runtime, provider-specific Web UI, Electron, Windows runtime, or changes to `/Users/bill/iris-native-runtime`.
