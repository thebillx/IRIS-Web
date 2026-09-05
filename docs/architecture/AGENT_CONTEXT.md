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

The current session execution seam is implemented by a deterministic `local-development-executor`. It proves session-bound instruction → runtime execution → session output without a cloud runtime dependency, and runtime health explicitly reports that no production model is connected. The session/UI contracts do not depend on this temporary executor's response format.

IRIS still does not implement an Agent Manager, planner queue, model router, delegation scheduler, or sub-agent lifecycle service. Those remain separate orchestration work and must not bypass daemon authority or capability policy.

`AGENT_MANAGER_FOUNDATION=PASS`

`MULTI_AGENT_READY=PASS`
