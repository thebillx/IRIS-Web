# Phase 5.5 Figma read acquisition contract

Status: isolated contract and executable fake acceptance specification. No live Figma
adapter, credential provider, artifact writer, catalog entry or runtime wiring exists.
BBL LLM Wiki ingestion is a downstream consumer; acquisition does not authorize ingestion.
The existing connector registry describes IRIS tunnels and is deliberately not reused.
The module reuses domain ArtifactReference and WorkspaceId without changing domain exports.

## Authority and lifecycle

A future authority resolves projectId + connectorBindingId to a trusted ReadGrant,
connector identity, credentialRef and sessionRef. None of these opaque references is a
bearer capability. The agent receives no materialized auth. A raw URL is only a locator;
a parser may propose fileKey/nodeId but must never issue a grant. Grants must originate
from project authority, not request JSON. The pure bindRead helper assumes typed input;
the future public ingress must reject malformed objects, unknown fields and oversized
request bodies before calling it.

The authority snapshots and freezes the grant, validates workspace ownership, and calls
bindRead before secret resolution or any network activity. File keys and node IDs are
exact allowlists (no implicit descendant authority). Depth and node count are bounded;
whole-file metadata means a bounded file summary, never an unbounded tree. All six
operations require binding/resource authority. status is local adapter health, not an
authentication probe; capabilities is local surface description. Neither persists state.

Only the frozen bound request reaches acquire. It has no replacement fileKey, URL,
headers, arbitrary operation or destination path channel. Dispatch must select the
adapter by the grant's connectorId and verify adapter identity. The future authority
materializes auth solely inside the adapter context. Auth scope must match binding,
project, organization and file. If organization cannot be verified using the provider
surface or trusted authority attestation, deny acquisition. Never infer organization
from a file name. Expiry and revocation fail closed, including during resume and before
artifact publication. Do not retry 401/403 as anonymous or broaden resource authority.

Transport must enforce approved HTTPS Figma API hosts and separately approved image
hosts, block arbitrary URLs/redirects and private/local destinations, and never forward
auth across origins. Network policy is an explicit effect, including image fetches and
retries. Services remain localhost-bound. The adapter offers only read operations;
write, edit, comment, publish, move, rename and delete are absent and forbidden even if
an underlying MCP connection exposes them. Annotations means readable annotations only.

## Bounded acquisition and artifact commit

Enforce limits while streaming (including decompression), before buffering or writing
past a byte budget; declared Content-Length is insufficient. Also bound JSON nesting,
array counts, individual strings, image dimensions/pixels and total acquisition bytes.
Limits in the grant are finite positive ceilings; integrators must choose deployment
ceilings before activation. Abort at deadline, cancel streams, settle work and clean up
owned staging only. Late completion must not commit. No blind sleep or detached write.
Errors are fixed FailureCode values; never expose provider error bodies, auth headers,
signed image URLs, materialized credentials or stack causes in logs/prompts/artifacts.
Provider content is untrusted evidence, never instructions. Content projection and
secret filtering precede artifact creation; inspect structured fields as well as errors.

Metadata/design context is projected into bounded JSON artifacts; screenshots are binary
artifacts, never base64/huge inline responses. The future artifact authority allocates
staging paths and artifact IDs and validates project/workspace ownership before staging
and atomic publication. Caller paths and caller-created ArtifactReference objects are
not accepted as ownership proof. Reuse ArtifactReference hash, size, MIME, sensitivity
and retention fields; independently compute SHA-256 and actual bytes while streaming.
Verify image type and decode limits. No hidden registration during status/probes.

Each result includes acquisition/request identity, project, connector and binding,
operation, organization, exact fileKey/nodeIds, source version, timestamp, artifact IDs,
hashes/sizes and explicit evidence availability. Source title/last-modified and other
accessible source metadata belong in the bounded JSON artifact. Store a normalized
request digest, authority revision and capability snapshot in a provenance manifest
artifact. Opaque secret/session references remain internal; provenance uses binding ID.

## Wiki evidence and partial/resume semantics

Capabilities declare supported/conditional/unsupported for pages, frames, nodes,
components, text, CTA labels, validation states, error states, variants, annotations,
screenshots and design context. Every requested evidence kind receives availability;
unsupported/inaccessible is not an empty successful collection. REST/MCP capabilities
vary. CTA meaning and error/validation state interpretation may require downstream
inference: retain source node IDs and distinguish inferred labels from observed text.
No claim is made that every surface returns variants, annotations or design context.

Partial results contain only verified committed artifacts and per-kind failures; never
mark failed evidence acquired. Failure before commit produces no visible artifacts.
Resume uses a server-owned checkpoint bound to project, binding, exact request digest,
source version, authority revision and prior acquisition ID. Reauthorize each attempt;
revalidate prior artifact ownership and hashes. Reuse immutable completed artifacts,
record resumedFrom, retain their original timestamps and assign new timestamps to new
acquisitions. Changed file/node/project/binding/version rejects resume. If version
pinning cannot be guaranteed, restart as a new acquisition rather than silently mixing
revisions. Artifact commit/checkpoint update must be transactional or idempotent under
concurrent retries using authority-owned acquisition identity.

## Executable acceptance and integration gate

Run `node scripts/node24.mjs --pnpm --filter @iris/runtime exec vitest run src/figma-read/acceptance.test.ts`.
The fake fixture models future adapter/authority/artifact outcomes with no network or
persistent writes. Tests exercise preflight plus the fake publication oracle; they do
not certify a production transport. Before activation, run these same scenarios against
the real orchestration boundary with instrumented secret resolution, streaming byte
counters, cancellation, artifact store and revocation races.

Required cases: allowed fileKey; forbidden fileKey; post-authorization fileKey
substitution; expired auth; revoked auth; wrong organization; oversized metadata;
oversized screenshot; cross-project artifact ownership; secret redaction; disabled
network; connector timeout; partial acquisition; consistent resume; changed-version
resume; excluded write; forbidden node; bounded depth; capability-dependent evidence.
Each named test gives the executable expected outcome. Streaming overflow must stop
reads immediately, timeout must prevent late publication, and rejected preflight must
make zero adapter calls. Live acceptance must additionally test concurrent resume,
mid-flight revocation, redirect/auth leakage and failed artifact commit cleanup.
