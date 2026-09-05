# MCP model

IRIS hosts a minimal stateless MCP transport on the same authoritative local daemon as the HTTP API. It binds only to `127.0.0.1` and does not require OAuth for the same-user, local-only V1.3 trust boundary.

ChatGPT is the primary conversational UX. The installed IRIS connector/plugin is the ChatGPT-to-local bridge and must route local work through governed IRIS capabilities rather than becoming a second authority. The embedded `/mcp` endpoint is one daemon-side integration surface; its deliberately narrow structured tool set is not a claim that every connector-host capability (for example governed project shell operations exposed by the installed connector) is implemented as a repo-local MCP tool.

The transport targets MCP protocol revision `2026-07-28` and uses its stateless discovery/request shape. `server/discover` reports the local server and protocol contract.

Exposed tools are intentionally structured:

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
