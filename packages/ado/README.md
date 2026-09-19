# Isolated ADO M3 contracts

This package has no HTTP client, credentials, filesystem writes, runtime registration,
or Knowledge Store adapter. It accepts synthetic or caller-supplied source data only.
Import through `@iris/ado` after explicitly adding a workspace dependency during integration.

## Collection ownership

`planCollection(ids, chunkSize, maxAttempts)` produces deterministic, deduplicated
batches (1–200 IDs; at most 100,000 input IDs). `recordBatchResult` is a pure reducer:
it validates complete membership, revision, Changed Date and source SHA-256 before
marking a batch successful. Missing or malformed response items throw without changing
the plan; the caller can record a transport failure for a partial response and retry
that batch. Successes are never re-fetched merely because another batch failed.

`resumableBatches` selects pending/transient failures within the attempt budget;
transport failures, timeout, throttling and server errors are retryable. Rejected
requests, including permission failures, require operator intervention, not automatic
retry. There are no sleeps, HTTP calls or background workers. The integration adapter
owns scheduling, any server-provided retry delay, cancellation and transport timeouts.

Persist returned plans explicitly, then use `restoreCollectionPlan` to validate JSON
checkpoints before resuming. The caller must serialize updates or use a persistent
compare-and-swap on its checkpoint version: `expectedAttempts` rejects stale results
against the current plan, but does not implement cross-process persistence locking.
Do not persist response error bodies or credentials in checkpoints.

## Canonical projection and sanitation

`stageRawSource(rawJson, policy)` validates an envelope with `id`, `rev`, `fields`,
and a UTC `System.ChangedDate`. It produces the full canonical model. Missing textual
fields and Created Date are nullable; malformed supplied types/dates are errors.
Raw field mapping belongs only to `normalize.ts` and the stage's `fieldSources` audit
map. Knowledge consumers use canonical keys, never ADO field names.

Standard Acceptance Criteria takes precedence. Missing/blank AC is normal. Fallbacks
are opt-in, ordered, and copied literally from description or a whitelisted custom
field. No heading guessing or generated AC occurs. `source` and `sourceKey` identify
the chosen canonical source; `fieldSources[sourceKey]` records its exact raw name.

The custom policy maps stable canonical aliases to `Custom.*` fields. Unknown fields
remain available in raw quarantine without schema changes; only whitelisted values
enter `customFields`. Values retain JSON arrays, objects, booleans, finite numbers
and null, with bounded recursion and recursive identity/metadata removal.

HTML is parsed with parse5, not regex tag stripping. Clean text retains paragraph
boundaries, list items/ordered markers, table row/cell delimiters and HTTP(S) link
labels/targets. Scripts, styling, images, embedded content and unsafe link targets
are discarded; entities decode before redaction. `normalizeHtml` alone is a text
converter, **not** a sanitizer or a knowledge-entry API. Its `links` can contain source
metadata; only the canonical result of `stageRawSource` has undergone sanitization.

All canonical text and custom values pass redaction before return: email addresses,
GUIDs, known descriptor forms, identity objects, PersonId and authentication metadata
are removed or marked as quarantined. URL credentials/avatar paths are removed;
query strings and fragments are discarded conservatively. Technical fields are
excluded by default rather than removed after indexing. Pattern-based redaction is
not a general-purpose secret/DLP classifier; opaque unlabeled values require later
validation before promotion.

## Staging is not promotion

`RawSourceStage` is always `validation: 'unvalidated'`, `searchable: false`.
It contains a sanitized canonical candidate and a distinct `quarantine-only` raw
audit snapshot (maximum 1 MiB, with original HTML and unknown fields). Raw audit can
contain PII/auth data and must never be logged, embedded, indexed or sent to semantic
retrieval. Store it locally behind explicit quarantine access and retention policy
when storage is implemented. No persistence side effects occur in this package.

The original UTF-8 JSON bytes are hashed with SHA-256; revision, Changed Date,
normalizer version and exact source map support later re-evaluation. The hash is a
source fingerprint, not a signature or an authorization decision. No function here
turns a candidate into promoted knowledge; a separate validation/promotion gate must
own that decision. These TypeScript contracts do not enforce storage ACLs by themselves.

## Validation

Run `node scripts/node24.mjs --pnpm --filter @iris/ado test` from the repository root.
All fixtures are synthetic. No live service or full repository test is needed.
parse5 is the only added runtime dependency; its exact version was already in the
workspace lockfile and avoids a bespoke, incomplete HTML parser.
