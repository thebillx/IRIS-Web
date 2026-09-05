# Permission model

IRIS uses one daemon-authoritative permission policy for localhost Web and MCP capability execution. UI state is descriptive; it does not grant authority.

## Development owner mode

Through V1.3 the persisted machine default is `FULL_LOCAL_OWNER`.

Permission modes:

- `ASK_EVERY_TIME`
- `AUTO_APPROVE_LOW_RISK`
- `AUTO_APPROVE_PROJECT_SCOPED`
- `FULL_LOCAL_OWNER`

Risk classes are `LOW`, `MODERATE`, `HIGH`, and `SYSTEM`. Decisions are `ALLOW_AUTO`, `ALLOW_ONCE`, `DENY`, and `OWNER_REQUIRED`.

`FULL_LOCAL_OWNER` auto-allows known implemented LOW and MODERATE runtime capabilities only after their live scope is revalidated. HIGH and SYSTEM operations remain owner decisions. Unknown or unimplemented capabilities fail closed.

The development-host authority granted by the owner separately permits normal build, test, package, local Git, local commit, runtime, and Web-development operations inside `/Users/bill/iris`; those host operations are not falsely exposed as daemon capabilities until an independently reviewed structured runtime capability exists.

## Roots

The clean-sheet source root `/Users/bill/iris` is the canonical owner project root. The private runtime-data root is `~/Library/Application Support/IRIS` unless an explicit test/local override is supplied.

`/Users/bill/iris-native-runtime` is a permanent read-only knowledge reference. A literal mutation target under that root is denied before filesystem inspection. Resolved targets are checked again so aliases or symlink escapes cannot convert another approved path into legacy-root write authority.

New project registration under the canonical owner source root may be auto-approved in owner mode. Registering a new external project expands writable authority and therefore returns `OWNER_REQUIRED`; no registration occurs until the exact pending action is approved.

## Capability flow

Every exposed mutation follows:

`request → capability registry → live client/session/project validation → physical target validation → permission decision → local audit → execution → result audit`

The same `CapabilityService` is used by HTTP and MCP. No MCP mutation bypass exists.

Implemented V1.3 capability surface is deliberately narrow:

- runtime status and project listing
- session create/delete/current-project selection
- project registration and machine default-project selection
- bounded regular-file read/write/delete within the live session project
- one-level directory create and empty-directory delete within the live session project
- permission-mode changes through owner approval

Arbitrary shell execution is not exposed.

## Path and TOCTOU policy

Registered project roots are physical canonical directories. File capability requests require absolute paths, reject NUL bytes and traversal, and walk existing components with `lstat` to reject symlinks. The session's current project and requested project are compared immediately before execution.

Execution delegates project file and directory operations to the bundled macOS safety helper. The helper opens the canonical project root as a directory descriptor, walks parent components relative to directory descriptors with no-follow semantics, rejects hard-linked file targets, and performs file reads/writes and delete/directory mutations relative to the verified parent descriptor. File writes use an isolated same-directory temporary file, recheck target identity, then rename relative to the verified parent descriptor. The policy layer still performs pre-execution validation, but path-based validation alone is not treated as execution authority.

## Audit

Each policy decision and execution result is appended to private local `audit.jsonl`. Audit records contain timestamp, client/session/agent/capability/risk/project/target/decision/reason/result metadata. For an existing session, agent attribution is derived from that live client-owned session rather than trusted from the request. File contents, credentials, API keys, passwords, tokens, and secret values are not recorded. File-write exact-action review uses byte count and SHA-256 rather than content.

Permission settings are persisted privately in `permissions.json`. First initialization writes the explicit `FULL_LOCAL_OWNER` default. If the file later disappears or becomes invalid, policy evaluation fails closed instead of inferring owner authority.

## Approval Center

`OWNER_REQUIRED` creates an in-memory, bounded, expiring pending approval and executes nothing. The Web Approval Center can deny, allow the exact action once, or—only for eligible MODERATE project capabilities—persist an always-allow project/capability override.

Approval resolution re-evaluates the live scope and exact target before execution. If session, project, capability, or target changed, the action is denied.

The browser approval review surface is bounded by `100dvh`, keeps header/footer outside the scrollable details body, preserves complete exact-action text, wraps long unbroken values, uses native keyboard-operable buttons, and treats Escape/close as cancellation without execution. Routine `ALLOW_AUTO` work never opens this surface.

## Trust boundary

IRIS V1.3 remains a same-OS-user, machine-local product. HTTP and MCP bind only to `127.0.0.1`, reject hostile Host/Origin/cross-site browser requests, and accept JSON mutations only. Fine-grained authentication between mutually untrusted processes owned by the same macOS account is not claimed in V1.3.

Runtime shutdown uses a separate private instance-bound control credential and does not send a signal to a PID based only on metadata. Runtime authority records also store a private macOS process-start marker so PID reuse does not make an unrelated process the previous daemon owner.

## Post-V1.3

`POST_V1_3_PERMISSION_REVIEW_REQUIRED=YES`.

At owner acceptance, the long-term default must be explicitly chosen from `FULL_LOCAL_OWNER`, `AUTO_APPROVE_PROJECT_SCOPED`, `AUTO_APPROVE_LOW_RISK`, or `ASK_EVERY_TIME`. IRIS does not silently change the mode.
