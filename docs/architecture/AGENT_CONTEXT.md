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

Canonical roles are `owner`, `planner`, `implementer`, `reviewer`, `security`, `explorer`, and `other`.

## Authority and policy inheritance

An `agentId` is attribution, not authority. Agents do not receive a separate permission engine and cannot create a second daemon to escape policy.

All agent work inherits the machine permission mode and uses the existing flow:

`client + session → live agent attribution → current project → capability → physical scope validation → permission decision → audit → execution`

For operations tied to an existing session, the daemon derives audit `agentId` from the live session owned by the supplied `clientId`; a caller cannot override audit attribution with a different agent identifier.

## Concurrency

Planner, Implementer, Reviewer, Security, and Explorer sessions may coexist concurrently on the same authoritative daemon. Their current-project state remains session-scoped, while runtime authority, project registry, default project, permission mode, and capability registry remain machine-shared.

This contract deliberately does not serialize independent read/work contexts into one global active agent or one global active project.

## Audit

Permission audit records include `agentId` in addition to client/session/project/capability/risk/decision/result metadata. Secrets and file contents remain excluded.

## Deliberate V1.3 limit

V1.3 does not implement an Agent Manager, planner queue, model router, delegation scheduler, or sub-agent lifecycle service. The runtime/session/policy/audit contracts are intentionally sufficient for such a manager to allocate multiple agent sessions later without redesigning daemon authority or bypassing capability policy.

`AGENT_MANAGER_FOUNDATION=PASS`

`MULTI_AGENT_READY=PASS`

A full Agent Manager is the next orchestration milestone after V1.3 acceptance.
