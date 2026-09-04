# Storage model

IRIS V0 stores foundation state outside the Git checkout. The default runtime data root on macOS is:

`~/Library/Application Support/IRIS`

`IRIS_RUNTIME_DATA_ROOT` exists only as an explicit local/test override and must be absolute. The canonical helper resolves filesystem aliases through the nearest existing ancestor and rejects a runtime data root inside the source checkout.

The V0 data root contains only small foundation documents: logical runtime identity, runtime authority ownership, loopback endpoint metadata, and the project registry/default project. Runtime directories are private to the current user, JSON state files use restrictive modes and atomic temporary-file publication, and machine-shared registry mutations are serialized in process.

Project registry entries contain `id`, `name`, and a canonical `rootPath`. Registration is explicit. Paths must be absolute, must resolve to an existing non-root directory, and are canonicalized with `realpath`; IRIS performs no implicit filesystem scanning.

The machine default project is persisted. Session current-project and client connection state are intentionally transient and separate from the machine default.
