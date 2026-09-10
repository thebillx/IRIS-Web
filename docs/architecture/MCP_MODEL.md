# MCP model

IRIS hosts a minimal stateless MCP transport on the same authoritative local daemon as the HTTP API. It binds only to `127.0.0.1` and does not require OAuth for the same-user, local-only V1.3 trust boundary.

ChatGPT is the primary conversational UX. The installed IRIS connector/plugin is the ChatGPT-to-local bridge and must route local work through governed IRIS capabilities rather than becoming a second authority. The embedded `/mcp` endpoint is one daemon-side integration surface; its deliberately narrow structured tool set is not a claim that every connector-host capability (for example governed project shell operations exposed by the installed connector) is implemented as a repo-local MCP tool.

The transport targets MCP protocol revision `2026-07-28` and uses its stateless discovery/request shape. `server/discover` reports the local server and protocol contract.

Tool registration is ordered from the canonical V2.3 catalog. FULL exposes a
non-secret `catalog_identity` diagnostic with catalog hash/count and runtime
deployment identity. The supervisor compares authenticated FULL and PRO
`tools/list` schemas against that same source catalog before L1 can pass.
Catalog reload is governed by the supervisor and preserves credentials,
connector identities, and tunnel bindings.

The FULL catalog also includes durable mission lifecycle and governed delivery
tools. In particular, `project_validation_discover`,
`project_validation_start`, `project_validation_job`, `git_local`,
`remote_publish`, `file_edit`, `mission_rebind`, and `catalog_identity` are
registered in the same ordered source catalog; they are not hidden shell
shortcuts. Validation executes only scripts declared by the selected project's
root `package.json`, and remote publication is limited to the configured
feature-branch flow.

The foundational structured tools are:

- `runtime_status`
- `list_projects`
- `file_read`
- `file_write`
- `file_delete`
- `directory_create`
- `directory_delete`

There is no arbitrary shell, remote account, credential, or cloud capability.

MCP does not own a separate permission path. Every tool call is routed through the same daemon `CapabilityService` used by the localhost Web API. File and directory tools require explicit client/session identity; the live session current project and physical target boundary are revalidated immediately before execution. `DENY` and `OWNER_REQUIRED` outcomes are returned as MCP tool errors and execute nothing.

Application sessions are IRIS runtime sessions and remain separate from MCP protocol transport state. Multiple local clients may call the same daemon; machine authority and permission mode remain machine-shared while current project remains session-scoped.

Durable missions retain a durable authenticated owner principal while their active session
binding can be renewed through the owner-only, revision-bound `mission_rebind`
tool. Rebind preserves the mission/project identity, revokes the old session's
mutation authority, and records a bounded audit/timeline event. PRO exposes no
mission or mutation tools.
