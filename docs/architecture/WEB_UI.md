# Web UI

The primary interface remains a small React/Vite application in a standard browser. It is a client of the local daemon, not a runtime authority.

The V0 page shows runtime status/identity, uptime, authority state, API/MCP endpoints, session count, project registry, and the current Web session project. Safe interactions are limited to creating a Web session, explicitly registering a project path, and selecting the current project for that session.

During `pnpm dev`, the root dev coordinator starts the authoritative runtime first, reads its actual loopback URL, and then starts Vite with a same-origin proxy to that runtime. No developer-specific absolute path is required.

Visual polish, Desktop UI migration, remote hosting, and full permissions/Doctor interfaces are outside V0.
