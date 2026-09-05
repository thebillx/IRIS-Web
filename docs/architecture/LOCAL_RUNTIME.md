# Local runtime

IRIS V0 is a macOS-first local daemon. The daemon is the one machine-shared runtime authority for the canonical runtime data root and listens only on IPv4 loopback.

## Identity

`runtimeId` identifies the logical machine-local IRIS runtime and persists across daemon restarts. `instanceId` identifies one concrete daemon process. Runtime status also carries `pid`, `startedAt`, `platform`, and `version`. PID alone is never authoritative identity.

## Authority

The runtime owns one physical `authority/owner.lock` file under the runtime data root. A contender first writes and syncs a private claim file, then uses an atomic hard-link to publish the owner without replacing an existing owner. Acquisition fails closed when a recorded owner is alive or its liveness cannot be determined. A stale owner is isolated and removed only after its full identity is reverified and its recorded PID is proven absent. Authority probes are observational and do not repair, acquire, release, or advance ownership.

Port availability is independent from authority. A preferred loopback port may fall back to an ephemeral port when occupied by an unrelated process, but a second IRIS daemon cannot use port fallback to bypass an existing runtime authority.

## Lifecycle

`start` checks existing authority/status, creates a new `instanceId` only when a daemon must actually be started, acquires authority before binding the API, and publishes endpoint metadata only after the listener is ready. `status` requires endpoint identity, HTTP status identity, and authority identity to agree before reporting `running`.

`stop` first verifies exact endpoint and authority identity, reads the private instance-bound runtime control credential, and asks that verified daemon to shut itself down. It does not send a termination signal to a PID based only on metadata. API unreachability is not accepted as successful shutdown.

`STOP_COMPLETE` means all four conditions are true for the verified target instance:

1. the target PID no longer exists;
2. the exact target endpoint descriptor is absent;
3. the target private control record is absent; and
4. the runtime authority probe reports `unowned`.

If a different endpoint descriptor, control record, or live authority appears during shutdown, stop fails closed with an authority-change error. The private authority owner record also carries a macOS process-start marker so a reused PID is not treated as the previous daemon process.

## State scopes

Machine-shared state: runtime authority, logical runtime identity, project registry, and default project.

Session-scoped state: session identity, logical `agentId`/agent role attribution, and current project.

Client-scoped state: explicit `clientId`, connected/disconnected state, and last-seen time. Session read/update/delete routes require the matching client identity, so one client cannot silently operate another client's session. Multiple agent sessions may coexist on one daemon; agent identity is attribution rather than a separate authority boundary. Client and session state are in memory; unnecessary transient state is not persisted.

The Web client may list only sessions owned by its stable browser `clientId`. A browser refresh or reconnect to the same daemon can therefore resume an existing authoritative session without creating another one. The selected session ID stored in browser session storage is only a UI preference: it is accepted only when that session still exists in the daemon's client-scoped list. A daemon restart intentionally drops transient sessions and pending approvals; the Web client clears any stale selection and reloads the persisted project registry/default project instead of recreating session authority from browser state.

## Endpoint discovery

The default preferred API port is `43110`. The daemon binds `127.0.0.1` only. The actual API and MCP URLs are printed at startup and persisted in machine-local endpoint metadata so clients can discover a safe fallback port.

## Failure taxonomy

V0 uses machine-readable codes including `AUTHORITY_HELD`, `AUTHORITY_INDETERMINATE`, `AUTHORITY_CHANGED`, `CONTROL_DENIED`, `STALE_AUTHORITY`, `PORT_UNAVAILABLE`, `INVALID_PROJECT_PATH`, `PROJECT_NOT_FOUND`, `SESSION_NOT_FOUND`, `RUNTIME_NOT_RUNNING`, `RUNTIME_SHUTTING_DOWN`, `PERSISTENCE_FAILURE`, and `INVALID_REQUEST`.
