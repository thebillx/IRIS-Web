# ADO M7 convergence review

Date: 2026-09-19
Legacy source: `codex/ado-m7-wiki` / `088e43fff180e85b8d1879671015fe057cc21157`

## Reused invariants

- Wiki synthesis is extractive and citation-first.
- REJECTED and CONTEXT_ONLY content cannot author factual claims.
- SUPPORTING_EVIDENCE is limited to QA reference authority.
- conflicting concept identity/category fails closed rather than silently merging.
- topic placement is explicit and deterministic; missing/tied placement is an error.
- incremental rebuild traverses source -> concept -> topic dependencies and preserves unaffected topics.
- curated annotations are not semantic retrieval evidence and require explicit review on affected rebuilds.
- query answers contain claim-level provenance rather than returning uncited text.

## Convergence corrections

### 1. M5 classification provenance survives M6 -> M7

M6 gate rows now retain:
- gate policy version
- classification SHA-256 digest
- classification category
- exact semantic evidence quotes, when present

M7 `SourceReference` accepts an optional classification binding. The bridge always
sets it for integrated ADO sources, and `referenceKey` includes it. A gate-policy
or classification change therefore participates in incremental source identity and
cannot be silently reused as the same Wiki citation.

### 2. No lossy category translation

The original isolated M7 category set did not contain every generic M5 category.
The converged set retains the original categories and additionally accepts:
`USER_FLOW`, `INTEGRATION`, `PRODUCT_CONFIGURATION`, and `RELEASE_CHANGE`.
The default section policy places those explicitly instead of coercing them into a
different semantic category.

### 3. Claims come from persisted gate evidence

`apps/runtime/src/ado-wiki-bridge.ts` only creates a PROMOTED candidate when the
persisted M6 gate evidence still resolves as an exact substring of the canonical
M3/M4 source field named by that evidence.

This avoids promoting an entire Description merely because one sentence inside it
was semantically validated. The Wiki claim is the exact validated source quote.

### 4. Scope isolation

One Wiki build consumes one M6 published board corpus. Persisted envelope scope IDs
must agree; mixed board scopes fail closed. Work-item numeric IDs can therefore be
kept human-readable while opaque source-link identities remain board-scoped.

### 5. Topic authority remains explicit

The bridge requires caller-supplied topic definitions. It does not infer one page
per Work Item and does not invent product information architecture from ADO IDs.
Backlog IDs are available as grouping keys and validated parent relationships are
available as hierarchy anchors, but final topic definitions remain trusted
configuration.

## M3 -> M7 integration proof

The focused integration test executes this path with synthetic inputs:

M3 normalize -> M4 canonical provenance -> M5 source-defined gate -> M6 sync/publish
-> M7 Wiki projection -> grounded retrieval.

The final retrieval assertion verifies that the returned claim text is the exact
source-grounded semantic quote and that its provenance retains the M5
classification digest.

## External-document boundary

M7 may carry sanitized link metadata as supporting evidence, but no Figma,
SharePoint, PDF, Excel, or other external document is acquired or reclassified as
authoritative content here. External document acquisition and authority remain
M9/post-MVP.
