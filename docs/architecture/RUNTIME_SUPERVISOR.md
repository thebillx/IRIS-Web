# IRIS runtime supervisor

IRIS uses one user-level supervisor for the local runtime, web UI, and both
tunnel-client profiles. The supervisor owns only processes recorded in its
private state file; it never stops an arbitrary process because it happens to
occupy a port.

## Daily operation

From the checkout, the first-use command is:

```text
pnpm iris up
pnpm iris status
```

After the repository launcher is linked into the user's PATH, the same commands
are `iris up` and `iris status`. Troubleshooting uses `iris doctor`; controlled
logs use `iris logs`.

`iris down` stops only verified supervisor-owned web, tunnel-client, and runtime
processes. `iris restart` performs that same verified stop followed by startup.
The commands are idempotent after the one-time migration.

## Credentials

Private state is stored under the macOS IRIS data root:

```text
~/Library/Application Support/IRIS/credentials/
```

The control-plane API key and the independently generated tunnel service
authorization are private files. Managed tunnel profiles contain only
`file:/absolute/path` references. Secret values are never written to the
repository, argv, normal status, doctor output, or supervisor logs.

Existing tunnel profiles are detected but are not silently copied. An owner must
explicitly migrate a selected legacy profile once:

```text
iris credentials migrate iris.yaml
```

That operation persists only the selected control-plane credential and creates a
separate `iris-tunnel-service` credential. Rotating the service credential is:

```text
iris credentials rotate-tunnel
```

Restart the supervised stack after rotation so tunnel-client rereads the file.

The service principal can authenticate only to `/mcp` and `/mcp-pro`, where the
runtime still routes every request through MCP validation and CapabilityService.
It cannot call owner control routes. Full writes remain session-bound and retain
project containment, permission policy, approvals, and audit evidence.

## Connector registry and profiles

The private connector registry binds each connector to its label, profile,
tunnel ID, runtime, MCP path, expected tool catalog, health port, managed profile
path, and deployment epoch. The generated profiles add the registry profile and
epoch headers to both normal and discovery MCP requests. A mismatch fails closed
as `CONNECTOR_BINDING_MISMATCH` or `CONNECTOR_MANIFEST_STALE`.

IRIS FULL remains the governed Full MCP surface, including V2.1 lifecycle
capabilities. IRIS PRO remains exactly `list_projects`, `project_info`,
`git_status`, `file_read`, and `search`, with no session or mutation tools.

## Readiness

`iris status` distinguishes three readiness layers:

* L1 proves the supervisor-owned runtime, authenticated MCP discovery, protocol,
  and registered tool profiles locally.
* L2 proves supervisor-owned tunnel-client processes, `/healthz`, `/readyz`, and
  healthy local tunnel-client readiness for both profiles. An idle tunnel is not
  required to receive a remote command before L2 can pass; that remote proof is
  reserved for L3.
* L3 is `UNKNOWN` unless a safe remote connector probe is configured. `/readyz`
  alone is never presented as end-to-end proof. ChatGPT connector validation is
  the current safe remote proof.

The status codes include `LOCAL_MCP_AUTH_FAILED`,
`TUNNEL_SERVICE_CREDENTIAL_MISMATCH`, `CONNECTOR_BINDING_MISMATCH`,
`CONNECTOR_MANIFEST_STALE`, `PROCESS_OWNERSHIP_AMBIGUOUS`, and
`E2E_PROBE_UNAVAILABLE`. `iris doctor` reports the failed layer and an action.

## Recovery and launchd

The supervisor records process identity, startup time, expected executable/profile,
and recovery counters in its private state. It retries transient runtime or
tunnel failures at 1s, 2s, and 4s, then enters a stable terminal degraded state.
It does not loop indefinitely or kill unverified PIDs.

The optional user LaunchAgent is generated and managed with:

```text
iris launchd install
iris launchd status
iris launchd uninstall
```

It runs the built supervisor daemon, has no embedded secret, writes to controlled
IRIS log paths, and uses a user-level `gui/<uid>` launchd domain. Build the
runtime before installing the agent. Installation is never performed implicitly
by `iris up`.
