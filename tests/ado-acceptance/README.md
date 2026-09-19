# ADO acceptance fixture contract

Run from the repository root:

`node scripts/node24.mjs tests/ado-acceptance/catalog.test.mjs`

The Node standard-library test runner avoids adding dependencies or modifying
runtime test discovery. These six tests validate fixture metadata. The converged production-module
acceptance is executable separately with:

`node scripts/node24.mjs --pnpm --filter @iris/runtime test src/ado-m8-acceptance.test.ts`

That suite binds the synthetic catalog to the real M1–M7 contracts: governed
read-only adapter behavior, normalization/redaction, provenance/comments/graph,
source-defined Knowledge Gate, orthogonal truth state, M6 publication/quarantine,
durable SQLite, M7 Wiki projection and grounded retrieval. It deliberately does
not impersonate a live Azure DevOps connection.

`fixtures/catalog.json` contains 34 named fixtures: 20 work items and 14 scenarios.
The JSON is an acceptance envelope, not an ADO response: pass only the source
`id`, `rev`, `fields`, and `relations` to future parsers; never feed `expectedStatus`
or `reason` into classifiers. Comments represent separate paginated responses.
Scenario kinds intentionally include malformed payloads, overlays, graph edges,
and generator specifications, rather than pretending every fixture is a Work Item.

All content was authored synthetically from the mission's behavioral requirements.
No real-shape sample was available, imported, or copied. IDs are local synthetic
numbers; reserved `.invalid` hosts cannot identify an actual organization. There
is no reverse mapping. The fixture hygiene check is a guard, not a claim that
regexes can detect every possible customer identifier; review all new text.

The PII scenario specifies future **in-memory synthetic** identity/email/GUID and
credential construction at test time across every named surface. Never check real
PII or credentials into this catalog. The present schema tests do not test a PII
redactor. Redacted source fixtures alone cannot prove redaction correctness.

The bounded-description scenario injects a 4096-character test budget and tests
limit−1, limit, limit+1; it does not set a production limit. Integration must map
this generator to its actual configured byte/character limits, including UTF-8
multibyte input. Above-limit input must fail closed or be explicitly incomplete,
never silently be treated as a complete promotable requirement.

Readiness as of 2026-09-19: fixtures `FIXTURE_READY`; behavior specifications
`SPEC_READY`; converged local production-module acceptance `LOCAL_EXECUTED_PASS`.
Live Azure DevOps Levels 1–4 remain `LIVE_PENDING` until separately authorized
credentials/binding are available and the read-only request ledger is captured.
Local execution is not a substitute for live release acceptance.
