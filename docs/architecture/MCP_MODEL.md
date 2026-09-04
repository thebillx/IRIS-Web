# MCP model

IRIS V0 hosts a minimal MCP transport on the same authoritative local daemon as the HTTP API. It binds only to `127.0.0.1` and does not require OAuth for this local-only foundation.

The transport targets MCP protocol revision `2026-07-28` and uses its stateless discovery/request shape. `server/discover` reports the local server and protocol contract. V0 exposes only informational tools:

- `runtime_status`
- `list_projects`

No filesystem mutation, process execution, broad native capability, ChatGPT tunnel, or remote transport is implemented in this mission.

Application sessions are IRIS runtime sessions and are separate from MCP protocol transport state. Multiple local clients may call the same daemon; machine authority remains shared.
