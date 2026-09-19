# ADO M7 Knowledge Synthesis / Wiki / Retrieval

Mission: `IRIS_VNEXT_ADO_F_M7_WIKI_RETRIEVAL`
Worker: `WORKER_ADO_F`
Date: 2026-09-15

## Verified scope

- Root: `/Users/bill/iris-wt-ado-m7`.
- Branch: `codex/ado-m7-wiki`.
- Exact initial HEAD/base: `5f6b35e034d7a8d8143c0a7558b507316daa3c32`.
- Initial Git status was clean; root `AGENTS.md` read, no nested instructions in the changed scope.
- The supplied M7 mission is the requirements baseline. No separate ADO M7 requirements document was found in the worktree docs/handoffs.
- No legacy implementation or other worker implementation was copied. M7 does not depend on the M5 worker branch.

## New isolated modules

All code and tests are under `packages/shared/src/ado/wiki/`; import these modules directly during integration rather than assuming an existing shared index export.

- `models.ts`: projection categories, sources/provenance, topic/section structure, authority, graph, build result and incremental revalidation/curation contracts.
- `projection.ts`: `buildWiki`, conservative extractive concept deduplication, graph placement, citation validation, data-driven section policy and deterministic source fingerprints.
- `incremental.ts`: `planRebuild` and `rebuildWiki`, requiring source revalidation before projection and preserving unaffected topic objects.
- `retrieval.ts`: `queryKnowledge`, deterministic field/keyword/graph-aware search and authority-labeled agent answers with provenance.
- `wiki.test.ts`: 56 focused synthetic tests, including a deterministic fake revalidator. No external semantic service.

No shared index, catalog, capability service, daemon, network adapter, persistent DB, manifest, dependency or production wiring was changed. Existing shared-package test/typecheck scripts include these new modules automatically.

## Projection and quality invariants

Every candidate requires resolving references containing generic work-item ID, revision, UTC changed date, field/comment kind and name, and opaque source-link identity. The source catalog is supplied by the integration layer; nothing is fetched. Duplicate reference identities, invalid dates and multiple purported current revisions for the same source location fail validation.

The v1 builder is deliberately extractive: the complete candidate text must equal each cited source fragment after trimming only surrounding whitespace. Internal whitespace, punctuation, case and wording remain significant. It does not infer acceptance criteria, paraphrase evidence, invent transitions, or synthesize an uncited overview. Integration must supply complete, validated source fragments rather than arbitrary misleading snippets. Upstream PROMOTED status is a trusted gate decision, not a status this module proves semantically.

All requested categories are represented: feature overview, business rules, functional behavior, UX behavior, validation, error handling, dependencies, known limitations, release information and QA/testing references.

- PROMOTED fragments may ground factual knowledge.
- SUPPORTING_EVIDENCE may enter only QA_REFERENCE concepts; it never gains official-requirement authority.
- QA_REFERENCE remains supporting authority even if its source is promoted.
- REJECTED and CONTEXT_ONLY cannot author a candidate claim. A submitted candidate citing either fails the entire build rather than returning partial factual output.
- CONTEXT_ONLY may anchor hierarchy placement. Context alone produces no concepts or generated paragraphs; empty section structures remain empty.
- Unused rejected sources can exist in the input catalog without entering Wiki content or default retrieval.
- Source resolution/quality errors return explicit issues; callers must retain the prior successful state rather than publishing a failed rebuild.

## Deduplication and topic placement

Equal category and exact trimmed text collapse into one canonical concept, retaining all source references and aliases. The canonical ID is selected deterministically from sorted aliases. Different text for one explicit concept ID fails as a conflict; identical text assigned incompatible categories fails as ambiguous rather than duplicating paragraphs. No fuzzy semantic identity is guessed.

Topic definitions are caller-supplied, not generated one-per-Story. Placement precedence is explicit concept assignment, then semantic grouping-key match, then ancestor hierarchy match. Missing or tied placement fails for review. Hierarchy references resolve to promoted/context sources; missing nodes and cycles fail. Multiple concepts and Stories can share one topic, while each canonical concept has a single placement.

Default sections: Overview, Business Rules, User Flow, Validation, Error Handling, QA References, Sources. A versioned section policy can rename/rearrange sections and map categories; each category must map exactly once and the Sources section remains citation-only. No Board/customer-specific structure exists.

## Incremental rebuild and curation

1. Compare deterministic fingerprints across the old and next complete source snapshots, including additions, revision/text/status changes and deletions.
2. Traverse old source→concept→topic and context-source→topic edges for a provisional revalidation plan.
3. Invoke the required revalidator once per changed source identity (with an empty fragment list for deletion). It may update classification statuses, but cannot rewrite text, citations or omit/add source fragments. Exceptions and unsuccessful results abort rebuilding.
4. Revalidate the complete candidate/reference/grouping graph to detect new conflicts, dedup changes and placement changes. This conservative global validation is intentional; it does not render every topic.
5. Union old/new graph dependencies and topic fingerprints. Render only affected/new topics; unaffected topics retain object identity. Removed uncurated topics are reported explicitly.

The adapter must update candidate references when source revisions change and explicitly remove candidates whose sources were deleted/rejected. Stale references fail, not silently migrate. `SourceRevalidator` and the previous `BuildState` are trusted typed application contracts, not arbitrary JSON transport payloads.

Curation policy is explicit: `PRESERVE_WITH_REVIEW` copies prior curated annotations verbatim and flags affected topics; `BLOCK_REBUILD` fails if an affected topic has curated annotations. Removing a curated topic always fails, including under preserve policy. Curated annotations are separate editorial data, not generated claims, and are never included in semantic retrieval. The module does not write editor files or storage.

## Retrieval and agent response

`queryKnowledge` supports exact concept/alias/source ID, title, feature/topic ID or title, hierarchy ID/title, iteration, release, keyword and related-concept graph context. Filters combine with AND. Related-concept lookup expands through shared topic/hierarchy context. Ordering is deterministic; no vector search or external service is required.

Default corpus is validated knowledge plus controlled QA supporting evidence; callers can disable the latter with `includeSupportingEvidence: false`. Context-only and rejected sources never enter answers. Unknown related IDs or absent matches return `INSUFFICIENT_EVIDENCE`; malformed queries return `INVALID_QUERY`.

Responses contain an extractive answer plus per-claim provenance, concept/topic IDs, knowledge status, authority and policy version. Supporting evidence is explicitly labeled in both aggregate text and structured claims. Treat section labels, candidate titles, hierarchy labels and grouping/iteration/release metadata as navigational metadata, not additional cited requirements. Any future HTML/Markdown renderer must safely render untrusted source text; this worker emits data only.

## Validation and delivery

- Focused: `node scripts/node24.mjs --bin vitest run packages/shared/src/ado/wiki/wiki.test.ts` — PASS, 56 tests.
- `pnpm lint` — PASS.
- `pnpm typecheck` — PASS.
- `pnpm build` — PASS (web and runtime).
- `git diff --check` — PASS; new untracked files also checked individually with `git diff --no-index --check /dev/null <file>`.
- Full repository test suite intentionally not run.
- Existing dependencies installed via `pnpm install --frozen-lockfile --offline`; no manifest/lockfile changes. Host pnpm emits a Node 22 engine warning, but repository validation scripts use their canonical Node >=24 wrapper.
- Initial typecheck found callback inference issues after runtime array guards; fixed with explicit annotations and reran validation.

## Durable checkpoint

The follow-up mission `IRIS_VNEXT_ADO_F_M7_DURABLE_CHECKPOINT` explicitly authorized committing the already-validated implementation on 2026-09-15.

- Implementation checkpoint HEAD_SHA: `088e43fff180e85b8d1879671015fe057cc21157`.
- Message: `feat: add ADO wiki and retrieval foundation`.
- Six M7-owned files committed: five isolated TypeScript modules/tests and this handoff.
- Source/test contents and timestamps remained unchanged from the final validation receipt; focused validation remains PASS 56/56. Tests were not rerun for this checkpoint.
- All nine readiness flags remain YES: knowledge projection, deduplication, topic builder, Wiki structure, provenance, incremental rebuild contract, quality validation, retrieval and agent query contract.
- This handoff-only follow-up records the implementation SHA and supersedes the earlier uncommitted-delivery note. The final delivery HEAD is the follow-up commit containing this record, returned in the mission result; resolve it with `git log -1 --format=%H -- .agents/handoffs/knowledge/ado-m7.md`.
- No feature, shared integration-zone, remote, branch creation or push changes.

Next step: `ADO_INTEGRATION`. Adapt validated gate output to the new pure source/candidate contracts, provide grouping/topic definitions and a trusted revalidator, then enforce successful projection at the storage/retrieval boundary. No implementation blocker.

## Explicit handoff gate

The 2026-09-15 `IRIS_VNEXT_ADO_F_HANDOFF_GATE_VERIFY` mission verified that HEAD includes `d2cbe9c59f385a818473e5028df90def5b24e3c0` and the worktree was clean. That committed receipt already records the implementation checkpoint, successful validation and readiness in prose; this metadata-only update makes the required gate fields explicit. No implementation or test changed and validation was not rerun.

HANDOFF_READY=YES
KNOWLEDGE_PROJECTION_READY=YES
DEDUP_READY=YES
TOPIC_BUILDER_READY=YES
QUALITY_VALIDATION_READY=YES
RETRIEVAL_READY=YES
AGENT_QUERY_CONTRACT_READY=YES
PUSHED=NO
NEXT_STEP=ADO_INTEGRATION

## 2026-09-19 convergence update

The isolated M7 implementation is now converged on the IRIS 2.4 ADO MVP branch.
Current integration no longer trusts an arbitrary caller-supplied PROMOTED flag:
the M6 published corpus carries the exact gate version, classification digest,
category and source-grounded evidence quotes.

`apps/runtime/src/ado-wiki-bridge.ts` converts one successfully published M6
board corpus into M7 input with these invariants:

- PROMOTED claims come only from exact persisted gate evidence that still resolves
  inside the canonical M3/M4 source field.
- CONTEXT_ONLY rows may provide hierarchy placement but never factual candidates.
- SUPPORTING_EVIDENCE may create only `QA_REFERENCE` candidates.
- classification gate version + digest are retained in Wiki source provenance and
  participate in source reference identity/fingerprints.
- topic definitions remain explicit trusted integration input; the bridge does not
  create one page per Work Item or guess a product information architecture.
- M5 generic knowledge categories are preserved directly. M7 sections now also
  recognize USER_FLOW, INTEGRATION, PRODUCT_CONFIGURATION and RELEASE_CHANGE
  rather than losing those categories through lossy remapping.
- one Wiki build accepts one board scope only; mixed scopes fail closed.
- external document/design links remain supporting evidence metadata only. M7 does
  not acquire or promote Figma/SharePoint content; that boundary remains M9.

Focused convergence proof covers M3 -> M4 -> M5 -> M6 -> M7 in one synthetic
pipeline and verifies grounded retrieval with classification provenance.
NEXT_STEP=C7_M8_ACCEPTANCE
