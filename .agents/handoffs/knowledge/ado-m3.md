# ADO M3 collection normalization handoff

Mission: `IRIS_VNEXT_ADO_B_M3_COLLECTION_NORMALIZATION`
Worker: `WORKER_ADO_B`
Date: 2026-09-15
Root: `/Users/bill/iris-wt-ado-m3`
Branch: `codex/ado-m3-collection`
Verified base: `5f6b35e034d7a8d8143c0a7558b507316daa3c32`
Implementation checkpoint: `502108bed17880b83c77dcf31bad20a5c3698ad6`
Delivery state: committed locally, not pushed. One handoff-only follow-up records
the implementation checkpoint; HEAD_SHA below identifies the implementation,
not the self-referential hash of this handoff follow-up.

## Delivered

- New isolated `packages/ado` package; no imports from production runtime or domain barrel changes.
- `src/batches.ts`: bounded deterministic planning, retry classification, exact response membership/version/hash checks, optimistic stale-result rejection, failure-only resumption and validated JSON checkpoint restoration.
- `src/model.ts`: complete canonical Work Item and explicitly unvalidated/non-searchable raw staging contracts.
- `src/html.ts`: parse5-based structured text with list markers, table delimiters, paragraph separation, links, decoded entities, active/style/image noise removal and input/depth bounds.
- `src/normalize.ts`: boundary-local raw field mapping, required revision/Changed Date, optional missing AC, exact standard/description/custom AC provenance, custom alias whitelist and raw SHA-256 snapshot.
- `src/sanitize.ts`: recursive text/custom value redaction and identity quarantine before canonical projection; technical metadata excluded by canonical whitelist.
- `src/ado.test.ts`: 35 synthetic focused test cases covering the above, including malicious/invalid inputs and checkpoint failure paths.
- `README.md`: public contracts, ownership, limits, integration obligations and validation instructions.
- `pnpm-lock.yaml`: only a ten-line new-package importer; parse5 8.0.1 and its transitive dependency already existed in the lockfile. No existing dependency versions changed. Installation was offline with scripts disabled.

## Validation

All final checks passed:

1. `node scripts/node24.mjs --pnpm --filter @iris/ado test` — 35/35 tests.
2. `pnpm lint`.
3. `pnpm typecheck`.
4. `pnpm build`.
5. `git diff --check`.

The shell's pnpm initially reports its Node 22 engine warning; repository validation
scripts delegate to the installed Node 24 runtime. No full repository test ran.
No live ADO access, customer data, production wiring, remote changes or publication.
No legacy implementation or artifacts consulted or reused.

## Checkpoint authorization and verification

Before staging, inspected `git diff -- pnpm-lock.yaml` and compared the exact
new importer with `packages/ado/package.json`: parse5 specifier/resolution 8.0.1,
and @types/node specifier ^24.3.0 resolving to existing 24.13.3. Removing only
that importer from the working lockfile reproduced the base lockfile byte for
byte. Thus no other importer, dependency version, transitive graph, lockfile
format or regeneration noise changed. Root package.json and pnpm-workspace.yaml
were also byte-identical to base; packageManager remains pnpm@10.15.0.

LOCKFILE_DIFF_VERIFIED_M3_ONLY=YES
LOCKFILE_INCLUDED=YES

Re-ran the focused package suite before staging: 35 tests passed. Staged exactly
12 authorized files under packages/ado, pnpm-lock.yaml and this handoff; staged
whitespace and path-allowlist checks passed. No full repository test ran during
this checkpoint operation. Earlier lint/typecheck/build results above are the
worker's recorded validation, not additional runs by the checkpoint operation.

## ADO integration obligations

- Explicitly add the package dependency only when integration is authorized.
- Own HTTP execution, retry timing, cancellation and explicit checkpoint persistence outside this pure package.
- Serialize checkpoint updates or use durable compare-and-swap; reducer attempt checks are not a filesystem/database lock.
- Partial batch responses are rejected without mutating state; record failure and retry only that batch.
- Raw snapshots preserve original HTML and can contain PII/auth material. Their contract is quarantine-only, bounded to 1 MiB, never semantic/search input. Storage ACLs and retention require an explicitly implemented owner.
- Consume only canonical field names. Resolve exact original AC/custom field names through stage audit metadata, not knowledge-facing fields.
- Redaction is deterministic and conservative, not comprehensive detection of every opaque unlabeled secret. URL query/fragment removal trades detail for privacy. Validation remains mandatory.
- A separate validation and promotion owner must admit approved data to Knowledge Store. This package has no promotion API, retrieval API or automatic storage writes.

## Result

MISSION_RESULT=PASS
CANONICAL_MODEL_READY=YES
BATCH_COLLECTION_CONTRACT_READY=YES
HTML_NORMALIZER_READY=YES
AC_EXTRACTION_READY=YES
CUSTOM_FIELDS_READY=YES
PII_SANITIZATION_READY=YES
NOISE_FILTER_READY=YES
RAW_STAGING_CONTRACT_READY=YES
CUSTOMER_SPECIFIC_IDENTIFIERS_IN_CORE=NO
TESTS_ADDED=35
FOCUSED_VALIDATION=PASS
HEAD_SHA=502108bed17880b83c77dcf31bad20a5c3698ad6
HANDOFF_READY=YES
SHARED_INTEGRATION_ZONE_CHANGED=NO
PUSHED=NO
BLOCKERS=NONE
NEXT_STEP=ADO_INTEGRATION
