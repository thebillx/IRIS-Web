# ADO requirement context foundation and runtime V1

The original M1/M2 domain/adapter foundation remains the authority for Azure
DevOps read semantics and scope governance. `IRIS_ADO_REQUIREMENT_CONTEXT_V1`
adds a bounded production runtime integration around that foundation without
adding any ADO write authority.

Source catalog 2.6.0 adds four **FULL-only** read tools:

- `ado_discovery`
- `ado_workitem_read`
- `ado_hierarchy_read`
- `ado_context_search`

PRO remains the exact five-tool read-only surface and exposes no ADO tool.
All four ADO capabilities are LOW / PROJECT / non-mutating and derive
`READ + NETWORK` server-side. They require a live IRIS session whose selected
project has an exact protected ADO binding. Raw URL, HTTP method, headers, raw
WIQL and credentials are never accepted from MCP callers.

This source integration is not proof that the currently running 2.4 live
runtime has been activated to 2.6.0. Merge and controlled activation remain a
separate release step.

## Protected runtime binding

Production binding state is intentionally separate from the FULL/PRO connector
registry:

- binding metadata: `<IRIS_RUNTIME_DATA_ROOT>/integrations/ado/bindings/<iris-project-id>.json`
- credential: `<IRIS_RUNTIME_DATA_ROOT>/credentials/ado/<credential-ref>.json`
- directories are private and files must be private regular files;
- binding metadata contains only opaque credential/session references, exact
  ADO organization/project/team/board identity, allowlisted resources and
  bounded limits;
- the credential record is resolved only inside the trusted runtime transport;
- binding manifests reject unknown fields so a token cannot be smuggled into
  binding metadata.

Owner-local provisioning is available through:

```sh
# Store PAT/Bearer material from hidden stdin only.
printf '%s' "$ADO_TOKEN" | pnpm --filter @iris/runtime ado:binding -- \
  credential-set --credential-ref <ref> --kind PAT --token-stdin

# Store the non-secret exact binding manifest from stdin.
cat binding.json | pnpm --filter @iris/runtime ado:binding -- \
  binding-set --manifest-stdin

# Inspect non-secret binding readiness.
pnpm --filter @iris/runtime ado:binding -- \
  status --iris-project-id <registered-iris-project-id>
```

The CLI never accepts the secret in argv and never prints it. The V1 production
reader supports PAT or Bearer material behind the same opaque credential
reference; provider identity acquisition/rotation policy remains an owner
operation outside the MCP read surface.
## Contracts and authority

`AzureDevOpsAdapter` exposes eight named read operations only. It deliberately
has no generic URL, HTTP method, header, request, PATCH, or DELETE entry point.
`READ_QUERY` describes a query's read-only semantics, even if a future transport
uses POST. It is not a new core effect or permission bypass. Integration must
derive the existing READ + NETWORK effects inside CapabilityService.

`ReadPolicy` is mandatory trusted adapter-construction configuration. Its
allowlist contains exact organization/project/team/board **ID tuples**, with a
resource list for each tuple; independent lists must not be combined into an
accidental Cartesian grant. Empty allowlists deny. `READ_ONLY` is the sole mode.
Timeout, response-byte, page-count, page-size, batch-size and rate-window bounds
must be enforced before returning results. Policy and response snapshots are
detached by the fake; it cannot expand its allowlist through a returned object.

Auth and session references are separate branded opaque objects, not credential
strings. A future trusted credential owner must mint and resolve these references,
bind them to the caller/session and target, and retain all secret material outside
agent-visible requests/results. Never serialize upstream errors, headers, tokens
or credential objects into diagnostics. Failures expose only the enumerated code
and, for throttling, a bounded retry delay. No retry is performed automatically.

## Current 2.4 governance binding

`governance.ts` is the current-IRIS binding layer around these isolated contracts.
It accepts only eight named ADO read operations and returns detached bound requests
with server-declared `READ + NETWORK` effects. A WIQL request remains semantically
`READ_QUERY` even though the provider REST operation is POST; this does not grant
generic write authority.

The trusted grant binds one IRIS project, connector binding, opaque credential/session
references, network state, expiry/revocation state, the exact board tuple policy, and
the least-privilege `vso.work` provider scope. Credential and session references are
validated but deliberately omitted from bound agent-visible requests. Wider or extra
OAuth scopes fail closed for this MVP.

The binding layer additionally caps Work Items Batch at 200 IDs, rejects duplicate or
invalid work-item IDs, bounds WIQL and pagination, and requires resource-specific
authorization before returning a transport intent. It still performs no live network
I/O. A production adapter must resolve the opaque credential through the trusted
credential owner and execute only the bound named operation; arbitrary URLs, headers,
methods, tokens, redirects, or caller-selected scopes must never be introduced as an
escape hatch.

## Discovery invariants

Identity resolution requires a complete, bounded, authorized catalog snapshot.
Selectors explicitly distinguish exact IDs from exact display names. Parent IDs
constrain every child lookup. Non-UUID IDs are valid; missing or ambiguous names
fail rather than selecting the first result. Names are never authorization keys.

Scope resolution requires the selected team's field/iteration snapshot. Only
`System.AreaPath` is supported in this version; unknown team fields fail closed.
Explicit Area Paths retain `includeChildren`. Descendant matching uses a path
separator boundary, not a raw prefix. Paths must belong to the resolved project's
display-name root. Invalid, empty, duplicate, oversized or mismatched scope fails.
Iterations and backlog iteration are retained, but are not silently applied as a
filter to full-board collection. Shared area configuration can legitimately
overlap another team: this module enforces configured scope, not exclusive team
ownership. No broader project-wide fallback is permitted.

Backlog IDs, names, ranks and work-item types come from discovery. Rank ties are
valid and retain input order; there are no fixed hierarchy labels or types.

`planEnumeration` consumes one catalog and an ordered accumulated sequence of
membership pages **from the same authorized board/scope snapshot**. The adapter
integration must bind that provenance; untrusted callers must not mix snapshots.
Each backlog begins with a null cursor; each subsequent page must match its
predecessor. Null next cursor completes that level; repeated/unknown/skipped
cursors fail. A level with no pages is pending, not empty. Explicit empty terminal
pages are valid. Unique IDs retain all backlog-level metadata as provenance.
To resume, append the fetched pending pages and recompute the bounded pure plan.
No detail I/O occurs. Detail chunks become available only after all levels finish,
so later pages cannot silently add provenance to an already emitted item.
Chunk offsets apply only to that completed plan, not another/new snapshot.

## Fake and future integration

`FakeAzureDevOpsAdapter` uses synthetic in-memory fixtures only. Its context
factory mints paired references scoped to that fake instance. It demonstrates all
six failure codes, bounded UTF-8 responses, timeout classification, deterministic
pagination, exact allowlists and rate windows without sleeps. Simulated latency
does not wait; queries return configured in-scope IDs and do **not** parse WIQL.
Invalid fixture/cursor/scope responses produce a sanitized UPSTREAM_FAILURE.
Work-item access fails closed outside the configured areas, including link targets.

A production transport remains future work: authenticate through the trusted
credential owner, validate upstream schemas and target binding, constrain query
results to the discovered scope, bound streamed bytes before decoding, abort on
deadline, validate opaque upstream cursors, implement documented pagination, and
map status/transport errors to these codes. The fake's cursor syntax is not an
ADO protocol claim. No live API behavior or credential handling is verified here.

Focused proof (from repository root):

```sh
node scripts/node24.mjs --pnpm --filter @iris/runtime test src/ado/ado.test.ts
```
