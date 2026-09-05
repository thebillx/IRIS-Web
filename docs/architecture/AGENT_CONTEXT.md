# Agent context foundation

IRIS V1.3 is agent-ready without implementing a full multi-model orchestrator.

## Identity contract

`agentId` identifies the logical agent participant responsible for work. `clientId` identifies the local client connection identity. `sessionId` identifies one isolated runtime work context. These identifiers are separate from the machine-shared daemon `runtimeId` and per-process `instanceId`.

Each runtime session carries:

- `sessionId`
- `clientId`
- `agentId`
- `agentRole`
- session-scoped current project
- bounded provider-neutral interaction events
- session-scoped `READY` / `WORKING` / `FAILED` execution state

Canonical roles are `owner`, `planner`, `implementer`, `reviewer`, `security`, `explorer`, and `other`.

## Authority and policy inheritance

An `agentId` is attribution, not authority. Agents do not receive a separate permission engine and cannot create a second daemon to escape policy.

All agent work inherits the machine permission mode and uses the existing flow:

`client + session → live agent attribution → current project → capability → physical scope validation → permission decision → audit → execution`

For operations tied to an existing session, the daemon derives audit `agentId` from the live session owned by the supplied `clientId`; a caller cannot override audit attribution with a different agent identifier.

## Interaction and concurrency

The daemon exposes one provider-neutral instruction execution seam per session. A unique submission ID makes retry of the same accepted instruction idempotent, and a second distinct instruction fails with `SESSION_BUSY` while that session is already working. Independent sessions may execute concurrently without a global working lock.

Planner, Implementer, Reviewer, Security, and Explorer sessions may coexist concurrently on the same authoritative daemon. Their current-project, interaction history, and execution state remain session-scoped, while runtime authority, project registry, default project, permission mode, and capability registry remain machine-shared.

This contract deliberately does not serialize independent read/work contexts into one global active agent or one global active project. Switching the Web selection never changes runtime execution ownership.

## Audit

Permission audit records include `agentId` in addition to client/session/project/capability/risk/decision/result metadata. Secrets and file contents remain excluded.

## Current executor boundary

The session execution seam remains the provider-neutral `AgentExecutor` contract. Runtime construction deterministically selects either the deterministic `local-development-executor` or one OpenAI-backed `production-provider-executor`; session identity, replay protection, execution state, and authoritative history stay in `RuntimeState` rather than moving into provider code.

The production executor sends only the current bounded instruction plus a minimal agent-role/project-selected instruction. It does not send the project name, repository contents, filesystem paths, session/client IDs, permission state, MCP state, audit history, secrets, or other sessions. Provider output is reduced to bounded text before it returns through the existing executor result contract.

IRIS still does not implement an Agent Manager, planner queue, model router, provider fallback, delegation scheduler, tool-calling loop, or sub-agent lifecycle service. Those remain separate orchestration work and must not bypass daemon authority or capability policy.

`AGENT_MANAGER_FOUNDATION=PASS`

`MULTI_AGENT_READY=PASS`
