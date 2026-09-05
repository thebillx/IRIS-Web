# Storage model

IRIS stores machine-local runtime state outside the Git checkout. The default runtime data root on macOS is:

`~/Library/Application Support/IRIS`

`IRIS_RUNTIME_DATA_ROOT` exists only as an explicit local/test override and must be absolute. The canonical helper resolves filesystem aliases through the nearest existing ancestor and rejects a runtime data root inside the source checkout.

The data root contains small named foundation/security documents only:

- logical runtime identity
- runtime authority ownership
- public loopback endpoint metadata
- private instance-bound runtime control metadata
- project registry/default project
- permission settings/project overrides
- local structured permission audit

Runtime directories are private to the current user. Security-sensitive reads use no-follow file-descriptor validation. JSON state files use restrictive modes and atomic temporary-file publication. Machine-shared registry and permission mutations are serialized in process.

Project registry entries contain `id`, `name`, and a canonical `rootPath`. Registration is explicit. Paths must be absolute, must resolve to an existing non-root directory, and are canonicalized with `realpath`; IRIS performs no implicit filesystem scanning.

The machine default project and permission mode are persisted. Session current-project, connected-client state, and pending owner approvals are intentionally transient. Pending approvals expire and are not durable authority.

`permissions.json` is explicitly initialized to the owner-authorized development mode on first run. After initialization, disappearance or corruption fails closed rather than recreating implicit broad authority. `audit.jsonl` contains bounded metadata records and never stores file contents or secret values.
