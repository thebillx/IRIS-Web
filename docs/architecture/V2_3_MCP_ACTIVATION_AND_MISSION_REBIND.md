# IRIS V2.3 catalog activation and durable mission rebind

V2.3 makes the MCP catalog an explicit, deterministic deployment contract and
makes durable mission ownership independent from one transient ChatGPT session.
The local daemon remains the authority for both contracts.

## Canonical catalog

`apps/runtime/src/mcp-catalog.ts` is the source catalog. Each entry records the
tool name, `FULL` or `PRO` profile, MCP schema version, mutation class,
capability binding, availability, and introduced IRIS version. Catalog identity
is a SHA-256 hash over the ordered tool schemas and catalog metadata. It does
not include credentials, runtime IDs, timestamps, or other nondeterministic
values.

The current FULL catalog includes the governed project capabilities
`project_validation_run`, `git_local`, and `remote_publish`. PRO remains the
exact read-only allowlist:

```text
list_projects
project_info
git_status
file_read
search
```

The runtime orders `tools/list` from the canonical catalog and exposes the
non-secret FULL-only `catalog_identity` tool. The identity includes the catalog
version/hash/count, runtime and instance identity, connector profile, and
deployment epoch.

## Activation and readiness

The supervisor compares the source catalog with authenticated local `tools/list`
schemas. `iris status` cannot report a ready local layer while those catalogs
differ. The diagnostic command is:

```text
pnpm iris catalog status
```

It reports source/live identity for FULL and PRO, connector metadata, runtime
identity, deployment epoch, and one of `ACTIVE`, `STALE_RUNTIME`,
`STALE_CONNECTOR`, `MISMATCH`, or `UNKNOWN`.

For a stale runtime or connector deployment, use:

```text
pnpm iris catalog reload
```

This is a governed, serialized restart only when activation is needed. It
preserves the runtime ID, credentials, connector tunnel IDs, missions, and
supervisor ownership. It regenerates managed profiles and verifies both
authenticated profiles before returning success. A stale source catalog is
reconciled into derived connector deployment metadata; connector identity is
not recreated.

If source and local runtime identities match but ChatGPT still presents an old
manifest, the platform-side connector is stale. IRIS reports
`STALE_CONNECTOR` where its deployment metadata is stale and otherwise exposes
the runtime/connector identities through `catalog_identity`. A new connector
session or new ChatGPT conversation may be required by the platform to refresh
its cached schema; IRIS does not claim that refresh happened locally.

## Durable mission ownership and rebind

Each durable mission keeps a stable owner principal (`ownerClientId`) and a
renewable active session binding (`clientId`, `sessionId`). A new authenticated
owner session can call `mission_rebind` with the same mission ID, project ID,
and expected `bindingRevision`. IRIS verifies the registered session's current
project, non-terminal mission state, owner authentication, and compare-and-swap
revision before changing the active binding.

The winning rebind increments `bindingRevision`, preserves the mission and
project IDs, revokes the previous session's mission mutation authority, and
adds a durable timeline and audit event. A stale concurrent claimant fails
closed. Knowing a mission ID is not authorization, and PRO cannot call rebind.

Typical continuation from a new ChatGPT session is:

```text
mission_resume → MISSION_SESSION_STALE
mission_rebind(missionId, projectId, expectedBindingRevision)
mission_resume
```

For the AgriScope correction case, the existing mission ID remains the same;
rebind is not mission recreation and does not alter project implementation.

## Troubleshooting

```text
SOURCE_COUNT != LIVE_COUNT
→ STALE_RUNTIME
→ pnpm iris catalog reload

SOURCE == LIVE but ChatGPT toolset is old
→ STALE_CONNECTOR / connector manifest cache
→ refresh the IRIS connector or open a new ChatGPT conversation if required

MISSION_SESSION_STALE
→ governed mission_rebind
→ resume the same mission ID
```

Catalog and mission diagnostics never print credentials or secret material.

## AgriScope execution handoff

The IRIS-side delivery surface for a registered project is:

```text
project_validation_discover
project_validation_start
project_validation_job
git_local
file_edit
remote_publish
```

The project owner remains responsible for declaring the validation scripts and
their runtime dependencies in the project's root `package.json` and local
environment. IRIS does not install project dependencies, infer Python virtual
environments, or embed commit/push operations in a validation script. For a
long-running check, discover the declaration, prepare one mission action, start
it with a stable `requestId`, then poll the returned `jobId`; reconnecting and
retrying the same request does not start a second job.

For the AgriScope correction mission, resume the existing mission after the
FULL connector exposes the current catalog. If the selected session is new,
call the governed `mission_rebind` with the existing mission ID, registered
project ID, and current `bindingRevision`, then continue using that same
mission. Do not create a replacement mission. `remote_publish` remains
permission-gated and should be used only after the intended feature-branch
diff has been reviewed.

The repository currently has no callable LOCAL_NATIVE/Ponytail reviewer backend.
IRIS therefore reports reviewer availability separately and never fabricates a
review decision or APPROVED result. Delivery must retain this reviewer gate
until a real backend is installed and configured.
