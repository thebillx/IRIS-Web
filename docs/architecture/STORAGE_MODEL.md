# Storage model

IRIS V0 stores foundation state outside the Git checkout. The default runtime data root on macOS is:

`~/Library/Application Support/IRIS`

`IRIS_RUNTIME_DATA_ROOT` exists only as an explicit local/test override and must be absolute. The canonical helper resolves filesystem aliases through the nearest existing ancestor and rejects a runtime data root inside the source checkout.

The V0 data root contains only small foundation documents: logical runtime identity, authority ownership, private endpoint/control metadata, and the project registry/default project. The endpoint control token is stored in an owner-only file and is excluded from public status. Writes use restrictive file/directory modes, temporary-file publication for JSON state, schema validation, and one in-process serialization queue for machine-shared registry mutations.

Project registry entries contain `id`, `name`, and a canonical `rootPath`. Registration is explicit. Paths must be absolute, must resolve to an existing directory, and are canonicalized with `realpath`; IRIS performs no implicit filesystem scanning.

The machine default project is persisted. Session current-project state is intentionally transient and separate from the machine default.
