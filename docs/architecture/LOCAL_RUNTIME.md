# Local runtime

IRIS V0 is a macOS-first local daemon. The daemon is the one machine-shared runtime authority for the canonical runtime data root and listens only on IPv4 loopback.

## Identity

`runtimeId` identifies the logical machine-local IRIS runtime and persists across daemon restarts. `instanceId` identifies one concrete daemon process. Runtime status also carries `pid`, `startedAt`, `platform`, and `version`. PID alone is never authoritative identity.

## Authority

The runtime owns an atomic local authority directory under the runtime data root. Acquisition fails closed when a recorded owner is alive or its liveness cannot be determined. A stale owner is recoverable only after its recorded PID is proven absent. Authority probes are observational and do not repair, acquire, release, or advance ownership.

Port availability is independent from authority. A preferred loopback port may fall back to an ephemeral port when occupied by an unrelated process, but a second IRIS daemon cannot use port fallback to bypass an existing runtime authority.

## Lifecycle

`start` acquires authority before binding the API, creates a new `instanceId`, starts the loopback listener, and publishes endpoint metadata. `status` requires endpoint identity, health identity, and authority identity to agree before reporting `running`.

`stop` sends an instance-bound request to the verified daemon using an owner-only control token stored in the private endpoint record. It does not signal a PID directly. PID is only one observed fact in the final shutdown proof, and the token is never returned by public status.

`STOP_COMPLETE` means all three conditions are true for the verified target instance:

1. the target PID no longer exists;
2. the target endpoint descriptor is absent; and
3. the runtime authority probe reports `unowned`.

API unreachability alone is not shutdown completion. If a different descriptor or live owner appears during shutdown, stop fails closed with an authority-change error.

## State scopes

Machine-shared state: runtime authority, logical runtime identity, project registry, and default project.

Session-scoped state: session identity and current project.

Client-scoped state: explicit `clientId`, connected/disconnected state, and last-seen time. Session read/update/delete routes require the matching client identity, so one client cannot silently operate another client's session. Client and session state are in memory in V0; unnecessary transient state is not persisted.

## Endpoint discovery

The default preferred API port is `43110`. The daemon binds `127.0.0.1` only. The actual API and MCP URLs are printed at startup and persisted in machine-local endpoint metadata so clients can discover a safe fallback port.

## Failure taxonomy

V0 uses machine-readable codes including `AUTHORITY_HELD`, `AUTHORITY_INDETERMINATE`, `AUTHORITY_CHANGED`, `STALE_AUTHORITY`, `PORT_UNAVAILABLE`, `INVALID_PROJECT_PATH`, `PROJECT_NOT_FOUND`, `SESSION_NOT_FOUND`, `RUNTIME_NOT_RUNNING`, `RUNTIME_SHUTTING_DOWN`, `PERSISTENCE_FAILURE`, and `INVALID_REQUEST`.
