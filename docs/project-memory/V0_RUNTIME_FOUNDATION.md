# V0 local runtime foundation

Implemented from the clean-sheet base commit `109c117716d56475bde946addbf4d7c0f14fabae`.

## Canonical contracts

- `ONE_DAEMON_PER_MACHINE`: one authoritative daemon for the canonical machine-local data root.
- `RUNTIME_DATA_ROOT`: `~/Library/Application Support/IRIS`, with `IRIS_RUNTIME_DATA_ROOT` reserved for explicit local/test isolation.
- `RUNTIME_IDENTITY`: persistent `runtimeId` plus per-process `instanceId`, `pid`, `startedAt`, `platform`, and `version`. PID alone is not authoritative.
- `AUTHORITY`: authority is published as a prewritten private claim file atomically hard-linked to `authority/owner.lock`. Live or ambiguous ownership fails closed. A valid stale owner is isolated and removed only after exact identity reverification and proof that its recorded PID is absent. Probes do not mutate authority.
- `STOP_COMPLETE`: target PID absent, exact endpoint descriptor absent, and runtime authority observed unowned. API unreachability alone is insufficient.
- `PORT_DISCOVERY`: prefer loopback port `43110`, fall back to an ephemeral loopback port only after authority is established, print and persist the actual API/MCP URLs.
- `MULTI_CLIENT`: explicit client identities attach to one daemon.
- `MULTI_SESSION`: explicit sessions coexist in one daemon; sessions are not daemon instances.
- `MACHINE_SHARED_STATE`: authority, runtime identity, project registry, and default project.
- `SESSION_SCOPED_STATE`: current project and transient request/UI context.
- `CLIENT_SCOPED_STATE`: client identity, connected/disconnected state, and last-seen time.
- `DEFAULT_PROJECT`: machine-shared and persisted.
- `CURRENT_PROJECT`: session-scoped and transient.
- `PROJECT_REGISTRY`: explicit `id`, `name`, and canonical existing absolute non-root `rootPath`; no scanning or implicit registration.
- `HEALTH`: stable runtime identity, uptime, authority, endpoint, and connected client/session counts.
- `DOCTOR`: bounded checks for authority identity, private writable data root, loopback bind, readable registry, and duplicate authority.
- `MCP`: local stateless JSON-RPC transport on `/mcp`, `server/discover`, and only `runtime_status` plus `list_projects` informational tools.
- `WEB`: a minimal React client for observing the runtime, creating a session, registering a project, and selecting that session's current project.
- `CLONE_AND_RUN`: after `pnpm install`, `pnpm dev` starts the authoritative runtime first, discovers its actual URL, and starts the Vite client without an installer or machine-specific source path. The coordinator signals and waits for both development children during shutdown.
- `MULTI_MACHINE`: each Mac has an independent data root, authority, registry, and sessions. No cloud state or cross-machine synchronization exists.

## Failure codes

`AUTHORITY_HELD`, `AUTHORITY_INDETERMINATE`, `AUTHORITY_CHANGED`, `CONTROL_DENIED`, `STALE_AUTHORITY`, `PORT_UNAVAILABLE`, `INVALID_PROJECT_PATH`, `PROJECT_NOT_FOUND`, `SESSION_NOT_FOUND`, `RUNTIME_NOT_RUNNING`, `RUNTIME_SHUTTING_DOWN`, `PERSISTENCE_FAILURE`, and `INVALID_REQUEST`.

## Deliberate limits

V0 does not provide remote access, a ChatGPT tunnel, broad filesystem/process/native tools, arbitrary shell execution, cloud state, cross-machine coordination, Electron, Windows support, Docker, or a full diagnostic/permission UI. Same-user local request authentication and stronger process-start attestation remain future hardening areas.
