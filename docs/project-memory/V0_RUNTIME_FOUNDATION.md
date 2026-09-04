# V0 local runtime foundation

Implemented from the clean-sheet repository baseline.

- `ONE_DAEMON_PER_MACHINE=YES` for the canonical machine-local runtime data root.
- `MULTI_CLIENT_PER_DAEMON=SUPPORTED` with explicit client IDs.
- `MULTI_SESSION_PER_MACHINE=SUPPORTED` with explicit session IDs; session operations are bound to the owning client ID.
- `DEFAULT_PROJECT_MACHINE_SHARED=YES` and persisted in the project registry.
- `CURRENT_PROJECT_SESSION_SCOPED=YES` and intentionally transient in V0.
- `RUNTIME_DATA_ROOT=~/Library/Application Support/IRIS` by default and outside source.
- `LOCAL_ENDPOINT_DISCOVERY=startup output + endpoint.json` with loopback-only preferred-port fallback.
- `STOP_REQUEST=instance-bound owner-only control token`; public status never exposes the token and lifecycle control does not signal a PID directly.
- `STOP_COMPLETE=target PID absent + target descriptor absent + authority unowned`.
- Machine-shared project-registry mutations are serialized before atomic publication.
- `MCP_TRANSPORT=local stateless 2026-07-28 skeleton` with informational tools only.
- `CLONE_AND_RUN=git clone; pnpm install; pnpm dev`; runtime directories are created automatically and GitHub is not a runtime dependency.
- No cross-machine synchronization, cloud state, Electron, Docker, Windows implementation, arbitrary shell execution, broad native capabilities, or ChatGPT tunnel exists in V0.
