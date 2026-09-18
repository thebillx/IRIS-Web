# ADO M1–M8 integration-readiness audit

MISSION=IRIS_VNEXT_ADO_POLICY_RECONCILIATION
ROLE=ADO_POLICY_REVIEWER
WORKSTREAM=ADO_POLICY_RECONCILIATION
DATE=2026-09-15
MISSION_RESULT=POLICY_RECONCILIATION_COMPLETE_INTEGRATION_GATES_REMAIN
ALL_WORKERS_VERIFIED=NO_REQUIRED_HANDOFF_MARKERS_MISSING_D_F_G
WORKER_COMMITS_AND_OWNERSHIP_VERIFIED=7_OF_7
WORKER_COUNT=7
OVERLAPPING_PATHS=0
BLOCKING_CONFLICTS=0_UNRESOLVED_SEMANTIC_POLICY_DECISIONS_0_PATH_CONFLICTS
TYPE_RECONCILIATION_REQUIRED=YES
M6_DURABILITY_REQUIREMENTS=DEFINED_PRODUCTION_IMPLEMENTATION_PENDING
M8_PLAN_RECONCILED=YES_OWNER_SUPPLIED_POLICY_AND_MVP_PRINCIPLES
PRODUCTION_WIRING_REQUIRED=YES
GENERICIZATION_DEPENDENCY=BLOCKED_AWAIT_APPROVED_GENERIC_BASELINE
LIVE_TEST_PLAN=DEFINED_NOT_EXECUTED
INTEGRATION_READY_AFTER_GENERIC_BASELINE=NO_NOT_SUFFICIENT_ALONE
HANDOFF_READY=YES

## Scope, safety and evidence strength

This is source/Git/handoff review only. No worker integration, cherry-pick, merge,
production/test edit, worker-branch change, master-status update, live ADO access,
credential/auth probe, security exploitation, network request or push occurred.
No implementation tests were executed in this audit. Worker validation below is
reported evidence at the supplied checkpoints, not independently rerun proof.

The audit artifact is created in the primary checkout /Users/bill/iris on
v2.3/mcp-activation-rebind, initial HEAD
eff6c36cd4bd23bce4d4d3de6d2e4f024c3b9749. No audit destination worktree was
specified. This primary checkout is only the receipt location, NOT a proposed
integration baseline. Eight existing untracked owner handoff files were recorded
for preservation; only this artifact is authorized for staging. In particular,
vnext-master-status.md is neither edited nor staged.

All workers fork from 5f6b35e034d7a8d8143c0a7558b507316daa3c32. Each supplied
SHA exists as a commit, its common base matches, its worktree HEAD matches the
supplied SHA and its status was clean at inspection. Complete branch deltas,
not merely the final handoff-only commits, were inspected with Git. Source reads
use immutable git show SHA:path. Root AGENTS.md and the local handoff README
supply ownership/shared-zone boundaries. No legacy implementation was used.

## Worker verification and handoff gate

| Worker | Scope | Authoritative checkpoint | Changed paths | Committed HANDOFF_READY marker |
|---|---|---|---:|---|
| A | M1/M2 connectivity/discovery | `94f636e582d6298d8e478083c93cb56ab5e76657` | 6 | YES |
| B | M3 collection/normalization | `b348e8a70afee837dbb725ce98aadda3757ebbe5` | 12 | YES |
| C | M4 graph/comments/provenance | `6d0b458df74cf1390c7a4918e353b2f74ed08684` | 5 | YES_COMMITTED_ISOLATED_FILES (qualified affirmative) |
| D | M5 Knowledge Gate | `bc34bb0c005529d890cac63be12be556a08a4260` | 5 | MISSING |
| E | M6 persistence/sync | `eaae0065101e3389f6d34da97e1d42678f26e3d9` | 7 | YES |
| F | M7 Wiki/retrieval | `d2cbe9c59f385a818473e5028df90def5b24e3c0` | 6 | MISSING |
| G | M8 acceptance | `f16814650bd5588e073596cef56597280b49bffe` | 5 | MISSING |

All seven corresponding handoffs were read. D, F and G have substantive handoffs
and completion prose but **no HANDOFF_READY=YES marker** at the supplied commits.
Do not infer it from conversational return fields or the existence of a file.
C has an affirmative marker with an explanatory suffix; strict exact-line
consumers should normalize that receipt through its owner as well. This audit
does not edit any worker receipt. Obtain owner-authorized receipt corrections
and new checkpoint SHAs for D/F/G before satisfying the required handoff gate.

A reports 39 focused tests; B 35; C 44; D 43; E 43; F 56; G 6 fixture-only tests:
266 reported tests in total. Their handoffs report lint/typecheck/build success.
These isolated reports do not establish cross-worker compatibility, SQLite
durability or live transport correctness. G explicitly leaves production tests
EXECUTABLE_PENDING; its six schema tests do not close MVP gates.

### Exact file ownership — 46 unique paths

A/M = added/modified relative to the common worker base. No path is shared by
workers. The only modified pre-existing path is B's pnpm-lock.yaml.

| Worker | Git delta | Exact path | Ownership class |
|---|---|---|---|
| A | A | `.agents/handoffs/knowledge/ado-m1-m2.md` | Worker handoff |
| A | A | `apps/runtime/src/ado/README.md` | Worker specification/documentation |
| A | A | `apps/runtime/src/ado/adapter.ts` | Isolated module; integration not wired |
| A | A | `apps/runtime/src/ado/ado.test.ts` | Isolated worker test/fixture/helper |
| A | A | `apps/runtime/src/ado/discovery.ts` | Isolated module; integration not wired |
| A | A | `apps/runtime/src/ado/fake-adapter.ts` | Isolated module; integration not wired |
| B | A | `.agents/handoffs/knowledge/ado-m3.md` | Worker handoff |
| B | A | `packages/ado/README.md` | Worker specification/documentation |
| B | A | `packages/ado/package.json` | B-owned new package metadata |
| B | A | `packages/ado/src/ado.test.ts` | Isolated worker test/fixture/helper |
| B | A | `packages/ado/src/batches.ts` | Isolated module; integration not wired |
| B | A | `packages/ado/src/html.ts` | Isolated module; integration not wired |
| B | A | `packages/ado/src/index.ts` | Isolated module; integration not wired |
| B | A | `packages/ado/src/model.ts` | Isolated module; integration not wired |
| B | A | `packages/ado/src/normalize.ts` | Isolated module; integration not wired |
| B | A | `packages/ado/src/sanitize.ts` | Isolated module; integration not wired |
| B | A | `packages/ado/tsconfig.json` | B-owned new package metadata |
| B | M | `pnpm-lock.yaml` | Shared generated metadata; verified B-only importer |
| C | A | `.agents/handoffs/knowledge/ado-m4.md` | Worker handoff |
| C | A | `apps/runtime/src/ado-knowledge-comments.ts` | Isolated module; integration not wired |
| C | A | `apps/runtime/src/ado-knowledge-graph.ts` | Isolated module; integration not wired |
| C | A | `apps/runtime/src/ado-knowledge-m4.test.ts` | Isolated worker test/fixture/helper |
| C | A | `apps/runtime/src/ado-knowledge-provenance.ts` | Isolated module; integration not wired |
| D | A | `.agents/handoffs/knowledge/ado-m5-knowledge-gate.md` | Worker handoff |
| D | A | `packages/shared/src/ado/knowledge-gate/concepts.ts` | Isolated module; integration not wired |
| D | A | `packages/shared/src/ado/knowledge-gate/gate.test.ts` | Isolated worker test/fixture/helper |
| D | A | `packages/shared/src/ado/knowledge-gate/gate.ts` | Isolated module; integration not wired |
| D | A | `packages/shared/src/ado/knowledge-gate/models.ts` | Isolated module; integration not wired |
| E | A | `.agents/handoffs/knowledge/ado-m6.md` | Worker handoff |
| E | A | `apps/runtime/src/ado/m6/README.md` | Worker specification/documentation |
| E | A | `apps/runtime/src/ado/m6/m6.test.ts` | Isolated worker test/fixture/helper |
| E | A | `apps/runtime/src/ado/m6/model.ts` | Isolated module; integration not wired |
| E | A | `apps/runtime/src/ado/m6/schema.md` | Worker specification/documentation |
| E | A | `apps/runtime/src/ado/m6/store.ts` | Isolated module; integration not wired |
| E | A | `apps/runtime/src/ado/m6/sync.ts` | Isolated module; integration not wired |
| F | A | `.agents/handoffs/knowledge/ado-m7.md` | Worker handoff |
| F | A | `packages/shared/src/ado/wiki/incremental.ts` | Isolated module; integration not wired |
| F | A | `packages/shared/src/ado/wiki/models.ts` | Isolated module; integration not wired |
| F | A | `packages/shared/src/ado/wiki/projection.ts` | Isolated module; integration not wired |
| F | A | `packages/shared/src/ado/wiki/retrieval.ts` | Isolated module; integration not wired |
| F | A | `packages/shared/src/ado/wiki/wiki.test.ts` | Isolated worker test/fixture/helper |
| G | A | `.agents/handoffs/knowledge/ado-m8-acceptance.md` | Worker handoff |
| G | A | `docs/acceptance/ADO_M8_ACCEPTANCE.md` | Worker specification/documentation |
| G | A | `tests/ado-acceptance/README.md` | Isolated worker test/fixture/helper |
| G | A | `tests/ado-acceptance/catalog.test.mjs` | Isolated worker test/fixture/helper |
| G | A | `tests/ado-acceptance/fixtures/catalog.json` | Isolated worker test/fixture/helper |

Shared integration zone checked: packages/domain/src/index.ts;
apps/runtime/src/capability-service.ts, capability-registry.ts,
capability-effects.ts, mcp-catalog.ts, mcp-v21.ts, mcp-v21-definitions.ts, daemon.ts.
Changes by A–G: **zero**. No shared package index export, root package.json,
pnpm-workspace.yaml, existing test helper, catalog or migration file was changed.
A/E share an ado directory prefix, and D/F share a shared/ado prefix, not files.
B alone introduces packages/ado and its package metadata. G uses standalone
Node test discovery; that suite is not automatically a recursive package test.

### Shared generated artifact verification

At B's immutable checkpoint the lockfile adds exactly one ten-line packages/ado
importer. Its parse5 dependency is specifier/resolution 8.0.1; @types/node is
specifier ^24.3.0/resolution 24.13.3, matching packages/ado/package.json.
Removing exactly that importer reproduces the base lockfile byte-for-byte.
Existing importers, transitive versions, lockfile settings and package-manager
metadata are unchanged; root packageManager remains pnpm@10.15.0. Existing
packages/* workspace discovery covers the new package; no extra project is
introduced. This is the previously authorized worker-owned generated artifact.
Recheck against the future generic baseline; no blind regeneration or unrelated
lockfile replacement is authorized by this audit.

## Pairwise file-overlap matrix

OVERLAP_MATRIX=COMPLETE_21_PAIRS
NC = NO_CONFLICT at the exact file-path level, NOT semantic compatibility.

| Worker | A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|---|
| A | — | NC | NC | NC | NC | NC | NC |
| B | NC | — | NC | NC | NC | NC | NC |
| C | NC | NC | — | NC | NC | NC | NC |
| D | NC | NC | NC | — | NC | NC | NC |
| E | NC | NC | NC | NC | — | NC | NC |
| F | NC | NC | NC | NC | NC | — | NC |
| G | NC | NC | NC | NC | NC | NC | — |

No actual file overlap needs MERGEABLE_ADDITIVE or BLOCKING_CONFLICT resolution.
Shared directory additions are additive topology only. Pair-level semantic
reconciliation is separate:

| Pair/group | Classification | Required reconciliation |
|---|---|---|
| A/B | SEMANTIC_RECONCILIATION_REQUIRED | Transport envelope/revision/raw bytes versus M3 canonical/raw stage; error and pagination adapters |
| A/C, A/E | SEMANTIC_RECONCILIATION_REQUIRED | Scoped identities, revision-rich comments/relations, snapshot membership and completeness evidence |
| B/C, B/D, B/E, B/F | SEMANTIC_RECONCILIATION_REQUIRED | Scope binding, timestamps, hash domains, authority, canonical projection and status admission |
| C/D, C/E, C/F | SEMANTIC_RECONCILIATION_REQUIRED | Source locators/comment versions, graph edge semantics, retained provenance and comment authority |
| D/E, E/F | SEMANTIC_RECONCILIATION_REQUIRED | Persisted truth/conflict state, gate version/fingerprint, published generation and stale corpus isolation |
| D/F | POLICY_RESOLVED_IMPLEMENTATION_PENDING | Apply BC2 controlled-evidence default to differing worker contracts |
| D/G, E/G, F/G | POLICY_RESOLVED_IMPLEMENTATION_PENDING | Apply BC1 four-status vocabulary/evidence destinations; F/G also BC2 |
| B/G | POLICY_RESOLVED_IMPLEMENTATION_PENDING | Apply BC3 raw/privacy projection boundary; fixtures/custom-field semantics still need adapters |
| A/G, C/G | SEMANTIC_RECONCILIATION_REQUIRED | Fixture completeness, dates/versions, error vocabulary and generator-to-wire schemas |

### Three semantic-policy conflicts — resolved by owner policy

Authority: the owner's IRIS_VNEXT_ADO_POLICY_RECONCILIATION instruction supplied
on 2026-09-15. It supersedes the original audit's proposed defaults below; no
separate complete plan artifact or immutable plan version was supplied or claimed
reviewed. These are policy decisions, not claims that worker code now complies.

**BC1 — status algebra, not a type alias.** D PrimaryStatus
(models.ts:1), E Disposition (model.ts:27), F KnowledgeStatus (models.ts:4)
are PROMOTED / CONTEXT_ONLY / SUPPORTING_EVIDENCE / REJECTED. G instead asserts
PROMOTED / CONTEXT_ONLY / QUARANTINED / REJECTED in docs:53, catalog and tests:7;
its supporting-evidence oracle is CONTEXT_ONLY. D also has a separate TruthStatus
(CURRENT, DUPLICATE, SUPERSEDED, CONFLICTING, AMBIGUOUS, NEEDS_REVIEW).
Approved resolution: reuse D/E/F's four relevance statuses and model
quarantine/review as disposition plus explicit truth/admission state; never
silently coerce supporting evidence into context or promote unresolved conflicts.
QUARANTINED is not a fifth knowledge status. Review/truth/admission state stays
orthogonal; unresolved truth must not gain substantive Wiki authority.

**BC2 — default retrieval corpus.** D concepts.ts includedInDefaultRetrieval
admits PRIMARY_KNOWLEDGE_STORE only (promoted current/duplicate). G docs:56–59
also require promoted-only default retrieval. F retrieval.ts:48 defaults
includeSupportingEvidence to true, intentionally admitting labeled QA_REFERENCE.
Both behaviors are internally tested, but cannot be the same default. Approved
default: PROMOTED plus CONTROLLED SUPPORTING_EVIDENCE. The original proposed
promoted-only default with evidence opt-in is superseded. Controlled evidence
requires explicit admission through the governed knowledge pipeline, authorized
scope and preserved status/provenance/lower authority. A caller boolean or an
evidence status alone cannot admit arbitrary source content. F's QA_REFERENCE
and citation checks are useful existing controls, not proof of integrated Gate,
scope or current-source admission. Do not flatten evidence into primary knowledge.

**BC3 — raw-source privacy/retention.** B model.ts RawSourceStage and
normalize.ts stageRawSource retain exact raw JSON including possible PII/auth
material in quarantine-only rawAudit; B test:131 explicitly expects synthetic
email there. G C03 requires redaction before persistence and docs:55 forbid
retaining unredacted secrets as raw evidence. Neither implementation performs
storage writes today. Approved boundary: raw/canonical Board source is separate
from promoted knowledge. Unvalidated source is not automatically searchable.
Raw audit snapshots may exist separately under controlled access; sanitize
PII/identity/authentication metadata before any searchable or knowledge-layer
projection. G's blanket pre-persistence rule must distinguish private raw audit
storage from searchable persistence. This is not blanket permission to retain
credentials or expose rawAudit to E published content or models. Raw hash
integrity is not retention authorization. The plan specifies no retention
duration: TTL/retention duration remains unspecified, with no invented default.

| Exact knowledge status | Projection | Retrieval / Wiki authority |
|---|---|---|
| PROMOTED | Primary Knowledge Store | Validated knowledge, subject to scope/current truth |
| CONTEXT_ONLY | Hierarchy/graph/context only | No independent substantive Wiki fact synthesis |
| SUPPORTING_EVIDENCE | Evidence/reference index | Controlled default retrieval; labeled lower authority, never silently an official requirement |
| REJECTED | Audit/quarantine only | Excluded from user-facing/default semantic retrieval |

STATUS_VOCABULARY_CONFLICT_RESOLVED=YES
SUPPORTING_EVIDENCE_RETRIEVAL_CONFLICT_RESOLVED=YES
RAW_SOURCE_PRIVACY_CONFLICT_RESOLVED=YES

### Required integration adjustments — not applied here

Reviewed A/D/G at the immutable checkpoints in the worker table. A's
`apps/runtime/src/ado/adapter.ts` exposes READ_ONLY operations and policy scope;
`discovery.ts` supports dynamic backlogs and complete enumeration. No status or
retrieval vocabulary change is required in A. Preserve those boundaries and
extend the existing transport composition for revision/provenance and sanitized
downstream projection, without filtering full collection to promoted items.

| Worker paths / contracts | Future code or test adjustment |
|---|---|
| D `packages/shared/src/ado/knowledge-gate/concepts.ts` / `includedInDefaultRetrieval`; `gate.test.ts` | Extend existing retrieval eligibility to controlled evidence while preserving `projectionFor` destinations and truth exclusions. Replace blanket evidence=false oracle with admitted evidence=true and unadmitted evidence=false cases; preserve rejected/context/unresolved exclusions. |
| F `packages/shared/src/ado/wiki/retrieval.ts`, `projection.ts`, `wiki.test.ts` | Reuse lower-authority results and provenance checks; bind evidence admission to trusted Gate/scope/current source at integration. Prove default admitted evidence inclusion, non-admitted exclusion, and no elevation to official requirements or independent context facts. A query flag may narrow, not bypass admission. |
| G `tests/ado-acceptance/catalog.test.mjs`, `fixtures/catalog.json`, `docs/acceptance/ADO_M8_ACCEPTANCE.md` | Replace QUARANTINED knowledge status with separate review/truth/admission expectations; supporting-evidence oracle becomes SUPPORTING_EVIDENCE, not CONTEXT_ONLY. Reconcile C10–C15/default retrieval assertions; preserve isolation for ambiguous/conflicting items rather than blindly renaming them PROMOTED. |
| B `packages/ado/src/model.ts`, `normalize.ts`, `sanitize.ts`, `ado.test.ts`; G C03 / G01 / G07 | Keep rawAudit distinct from sanitized canonical/searchable projection. Private synthetic raw-email retention is not itself a violation; test restricted audit access and absence of PII/identity/auth metadata in search, query results, Wiki and public audit. Change G's blanket persistence oracle to the actual projection boundary; no TTL assertion. |
| A `apps/runtime/src/ado/ado.test.ts`; integrated A/B/C/D/E/F/G contracts | Prove full dynamically discovered Board collection reaches raw staging and every Work Item reaches Gate; preserve hierarchy/provenance and incremental invalidation. Assert read-only operation ledger, no ADO mutations, validated-only Wiki and no raw semantic admission. Existing fake tests alone do not prove runtime wiring. |

POLICY_CODE_CHANGES_REQUIRED_AT_INTEGRATION=YES
POLICY_TEST_CHANGES_REQUIRED_AT_INTEGRATION=YES

## Recommended integration order — conditional, not executed

RECOMMENDED_INTEGRATION_ORDER=A_THEN_B_CHAIN_THEN_C_CHAIN_THEN_D_THEN_E_CHAIN_THEN_F_CHAIN_THEN_G

First obtain an exact approved **generic vNext baseline SHA**, required handoff
receipts and authoritative-plan/policy decisions. No integration against the
workers' Phase 5 pre-genericization base. On a separate owner-authorized
integration branch, the proposed chronological commit order is:

| Order | Worker | Exact commit to cherry-pick | Kind |
|---:|---|---|---|
| 1 | A | `94f636e582d6298d8e478083c93cb56ab5e76657` | Implementation + worker receipt |
| 2 | B | `502108bed17880b83c77dcf31bad20a5c3698ad6` | Implementation + worker receipt |
| 3 | B | `b348e8a70afee837dbb725ce98aadda3757ebbe5` | Handoff-only follow-up |
| 4 | C | `c392f585ba15c9472b6787970656cb21ccf07023` | Implementation + worker receipt |
| 5 | C | `6d0b458df74cf1390c7a4918e353b2f74ed08684` | Handoff-only follow-up |
| 6 | D | `bc34bb0c005529d890cac63be12be556a08a4260` | Implementation + worker receipt |
| 7 | E | `3d5739849d3cbeeedd40deeadc60e4a52ae155ae` | Implementation + worker receipt |
| 8 | E | `eaae0065101e3389f6d34da97e1d42678f26e3d9` | Handoff-only follow-up |
| 9 | F | `088e43fff180e85b8d1879671015fe057cc21157` | Implementation + worker receipt |
| 10 | F | `d2cbe9c59f385a818473e5028df90def5b24e3c0` | Handoff-only follow-up |
| 11 | G | `f16814650bd5588e073596cef56597280b49bffe` | Implementation + worker receipt |

B/C/E/F final SHAs are receipt-only commits; picking just those four SHAs would
omit their implementations. Preserve both commits in each chain. No file topology
forces a deviation from conceptual A→B→C→D→E→F→G. Stage production activation only
after reconciliation; clean textual application is not permission to expose
new runtime capabilities. Review G's contract early, even though its commit is
last in this order. Subsequent owner receipt fixes need new authoritative SHAs
and must be appended for the affected workers; this audit cannot invent them.

## Type reconciliation map

Introduce one integration-owned, runtime-independent ADO contract leaf; prefer
extending existing model owners and explicit export paths over a parallel model
framework. No runtime implementation import may leak into pure shared/package
contracts. Check package dependency direction before adding exports: B's package
currently depends only on parse5, D/F live in shared without public index exports,
and A/C/E live in runtime. Do not create shared↔ado cycles or import runtime into
shared. The names below are proposed integrated contracts, not existing types.

| Worker type(s) → canonical integrated type | Required behavior/ownership |
|---|---|
| A BoardIdentity / Target / AllowedBoard; E BoardKey → AdoScopeBinding / BoardKey | Preserve explicit organization/project/team/board tuple and local project owner. Resolve names only in authorized configuration; assign opaque local scopeId. Same numeric work item in different scopes must never collide. |
| A WorkItem; B CanonicalWorkItem → AdoWireWorkItem then CanonicalWorkItem | Keep wire and canonical types distinct. A currently lacks top-level rev and original raw envelope; B requires rev and System.ChangedDate. Extend transport contract at its owner, not unsafe casts or fabricated revisions. Preserve raw-byte hash meaning and field type bounds. |
| B CanonicalWorkItem.provenance; C KnowledgeWorkItem/KnowledgeProvenance/KnowledgeSource; D SourceReference; F SourceIdentity/SourceReference → ScopedWorkItemIdentity / SourceProvenance | Reuse C's scoped, revisioned FIELD/COMMENT(version)/RELATION locator. D's source/id/revision strings and F's sourceLinkIdentity need lossless scoped mapping. Keep positive numeric source revisions and canonical UTC date plus raw original date if needed; B accepts precision up to seven digits, C requires canonical milliseconds, F accepts zero/three digits. |
| A Comment/WorkItemLink; C KnowledgeComment/KnowledgeCommentPage/KnowledgeEdge; E Comment/Relation/Link → VersionedComment / SourceRelation / EvidenceLink | A/E comments only carry id/text; do not lose comment version, source revision, locator, hash or redacted-author provenance. A links lack relation ID and provenance. Normalize reciprocal parent/child edges explicitly; retain related/duplicate links without asserting parenthood. C-only normalization is not PII scrubbing. |
| B RawSourceStage → RawSourceStage plus explicit access/admission policy | Remains unvalidated/non-searchable and separate from promoted store. Apply resolved BC3 projection/privacy boundary; retention duration is unspecified. |
| B ItemVersion/CollectionPlan/CollectionBatch; E ChangeStamp/Batch/Checkpoint/SyncRun → ItemRevision / CollectionPlan / SyncCheckpoint / SyncRun | Plans and durable runs are not identical types. Bind B's chunk hash to E's run/scope; attempts, version, checkpoint kind and digest must survive resume. E owns durable acknowledgement, not an in-memory collector result. |
| A EnumerationPlan/PlannedItem; E Inventory/Membership → MembershipSnapshot | Bind ordered complete enumeration to scope, snapshot ID, backlog memberships and observed revisions. Parent resolution comes from normalized graph, not guessed Board membership. |
| D PrimaryStatus; E Disposition; F KnowledgeStatus; G expectedStatus → KnowledgeStatus | BC1 approved above; implement one definition, four relevance states, separate review/truth state. No fifth implicit primary status or status-string casts. |
| D Classification/ConceptResolution/TruthStatus; E GateDecision/GateRow → GateDecision plus ConceptResolution | Persist decision policy/classifier version, evidence/quotes, exact source fingerprint, all reason codes and explicit truth state. E currently stores one reasonCode and no concept resolution; never lose conflict/supersession semantics when publishing an item. |
| C KnowledgeFact.authority; F Authority/Provenance → SourceAuthority and ClaimAuthority | OFFICIAL_FIELD indicates origin only, not validated knowledge. COMMENT/RELATION may support context/evidence but cannot silently gain official authority. Gate/truth resolution must precede claim authority. |
| D KnowledgeCategory/Claim; F Category/Candidate/KnowledgeConcept → KnowledgeClaim with explicit Wiki category projection | D has USER_FLOW/INTEGRATION/PRODUCT_CONFIGURATION/RELEASE_CHANGE; F has FEATURE_OVERVIEW/DEPENDENCIES/RELEASE_INFORMATION/QA_REFERENCE. Map intentionally; no inferred overview/config meaning or supporting-evidence promotion. |
| D claim equality; F normalize/dedup → Canonical claim normalization contract | D collapses internal whitespace; F trims edges only and requires exact cited fragment text. Establish one evidence-preserving normalization point; do not merge claims then invent an exact citation that no longer exists. |
| C contentHash; B rawHash; E fingerprint; F sourceFingerprints → Versioned digest domains | Raw wire bytes, canonical body, attachment/gate fingerprint and topic/source projection are distinct hashes. Persist domain/version and never compare them as interchangeable source hashes. |
| A/E FailureCode; B BatchFailure; G expectedCode → SanitizedAdoFailure and RetryDisposition | A/E agree on six codes; G FORBIDDEN→UNAUTHORIZED and UPSTREAM_UNAVAILABLE→UPSTREAM_FAILURE need explicit adapter mapping. Retain permanent vs bounded retry; never log raw response. |
| E Audit; G audit fields → PrivateCompletenessAudit plus SanitizedAuditEvent | E carries detailed IDs; G public audit requires aliases/counts/enum errors, durations and reason statistics. Keep private audit rows separate from observability projection; do not dump E's document to logs. |
| E PublishedCorpus; F BuildInput/BuildState/SourceRevalidator → PublishedKnowledgeSnapshot / WikiBuildState | Build only from successful scope-bound published head and resolved current concepts. Retain syncRunId, generation and policy in derived state; preserve curation. Revalidation cannot invent source text. |
| G fixture envelope/scenario kinds → AcceptanceFixtureCatalog and explicit adapters | Never pass expectedStatus/reason into parser or classifier. Adapt metadata to real source schema with required dates, comment versions and scope, then assert actual results. |

Additional mandatory reconciliation: B limits collection plans to 100,000 IDs;
E caps MAX_ITEMS at 10,000 and snapshots at 32 MiB; C bounds comment batches and
body normalization separately. Full Board collection must report an explicit
incomplete/limit condition, not truncate and pass M8. Select a consistent bounded
policy and include UTF-8, cursor exhaustion, revision churn and cardinality tests.

## M6 production durability requirements

M6_PRODUCTION_DURABILITY_GAP_DEFINED=YES
PRODUCTION_SQLITE_OR_DISK_STORE=NOT_IMPLEMENTED
INTEGRATED_MIGRATION=NOT_IMPLEMENTED
INTEGRATED_RUNTIME_RESTART_PROOF=NOT_EXECUTED

E store.ts:3–6 exposes SyncStore.read and compareAndSwap; MemorySyncStore is a
reference fake. Its snapshot restore and fresh-process tests feed serialized
state from the harness. They do not prove disk commit/fsync, process-shared
locking, schema migration, daemon restart or power-loss recovery. E's handoff
explicitly says M6_MVP_FULLY_COMPLETE=NO; preserve that distinction.

Minimal production work, retaining E's logical contract:

1. Implement a local SQLite SyncStore at a private runtime data-root path, with
   explicit initialization/migration and owner lifecycle. No store creation or
   migration as a hidden side effect of status/probe. Reuse approved runtime
   storage/private-path validation. Inspect installed SQLite API support offline
   before choosing a driver; no need for a new cloud service or parallel DB tier.
   A single versioned SyncDocument row plus generation is a possible minimal
   first backend, provided transactional validation enforces all E invariants;
   relational tables/views can instead follow E schema.md if integration needs
   direct queries. Do not run both as competing authoritative stores.
2. Persist schemaVersion/generation, run/scope, independent expected-ID inventory,
   all staging/attachment rows, ordered checkpoints/digests/failures, gate and
   truth records, and published heads. One item/run has exactly one relevance
   disposition. Composite identity is scope/run/item, never item ID alone.
   Add retained rich provenance/truth metadata identified above rather than
   reducing C/D facts to E's current simple strings.
3. Version 0→1 creation is explicit. Add an atomic versioned migration for the
   integrated contract, reject unknown/corrupt versions without resetting state,
   take a private recoverable pre-migration backup and preserve rollback data.
   Do not silently reuse the runtime FoundationStateDocument's unrelated version
   1; persistence.ts is a separate JSON store, not an existing ADO SQLite owner.
4. One writer transaction covers generation/run-version check, staging,
   comments/relations/links, current failures, checkpoint insert and version
   increment. Enforce digest/kind idempotency and cross-process CAS. Validate the
   candidate and current baseline under the transaction, not via a read→blind
   overwrite race. Use lifecycle/locking/CAS, never sleeps as synchronization.
5. Publication validates completeness, gate/truth admissibility and baseline head
   in the same consistent transaction that commits terminal status, audit and
   new head. Partial fetch, stale gate, unresolved conflict or changed baseline
   cannot publish. Previous successful corpus remains available under its
   original run identity; do not mislabel it as current successful sync.
6. Acknowledge batch/publication only after SQLite commit reaches the configured
   durability boundary. Explicitly configure and verify journal/synchronous
   behavior, including WAL/sidecar privacy and shutdown/reopen semantics. Exact
   lost-ACK replay succeeds once; mismatched digest/kind fails. Durable scheduler
   intent and run resumption must not duplicate a commit after restart.
7. Add temporary-local-DB contract tests: schema initialization, version upgrade,
   invalid snapshot/version rejection, two-writer conflict, rollback after batch
   or publication failure, reopen after commit, lost ACK, stale head/gate, and
   moved-out/rejected index invalidation. Then actual daemon stop/start with
   same private DB: inspect without mutation, recover checkpoint, complete once,
   preserve prior corpus and all provenance/curation. Test crash boundaries in
   an explicitly authorized local validation mission, not here. Do not claim
   power-loss durability from a clean subprocess exit.

Apply the resolved BC3 source privacy boundary. Neither in-memory annotations nor
SQLite isolation alone authorize storing raw credentials. Local artifact/export
access must independently enforce owner and scope boundaries. Retention duration
is unspecified by this plan and must not be fabricated during integration.

## M8 source-plan reconciliation

M8_AUTHORITATIVE_PLAN_RECONCILED=YES

The original audit lacked an authoritative plan. The owner has now supplied the
authoritative policy and MVP principles in this mission. A/D/G contracts are
reconciled against that supplied scope, not an unseen full document/version.
No external lookup or live ADO access was performed. All nine supplied MVP
principles are represented below; policy reconciliation does not execute M8.

| Required eventual gate | G coverage / worker foundation | Remaining evidence or divergence |
|---|---|---|
| Read-only configured Board access | G M1/C16/Levels; A adapter contract | Only fake transport; real auth/read-only endpoint wiring and ledger pending |
| Dynamic backlog discovery | G M2/C17; A discoverBacklogs | Bind real catalogs and area/scope semantics, no fixed hierarchy |
| Full Board collection | G M2/C17; A enumeration + B plan + E inventory | Independent expected set, all pages, revision consistency and size-limit policy pending |
| Hierarchy reconstruction | G M3/C04; C graph | Preserve arbitrary levels, scoped nodes, reciprocity, orphans/cycles and E completeness |
| Normalization/sanitization | G M3/M4/C01–C07; B/C | Apply resolved BC3: sanitize before searchable/knowledge projection; comments require sanitization before C facts; custom-field mapping remains integration work |
| Raw staging / raw-promoted separation | G M4/G01/G07; B stage + E partitions | Controlled raw audit storage separate from semantic corpus; production access/exclusion tests pending, no specified retention duration |
| Gate for every Work Item | G M5/C09–C13; D/E | Real trusted classifier/admission and current fingerprint/truth integration pending |
| Noise isolation | G G01–G04/G08; D | Preserve valid support requirement, reject task/admin/QA execution; refresh stale indexes |
| Four knowledge statuses | G M5/C10 | Apply resolved BC1: update G vocabulary and evidence oracle; keep review/admission separate |
| Duplicate/superseded/conflict semantics | G M6/C14/G09; D/F | Persist all D truth/history; F cannot replace that with independent text dedup |
| Full Sync completeness audit | G M6/audit; E | Persistent transactional proof, private/public audit split, actual source counts pending |
| Incremental sync | E checkpoints/membership; F incremental projection | Preserve revisions, deletions, moved-out membership and status/policy invalidation; durable restart proof pending |
| Wiki from validated knowledge / provenance | G M7/C15; C/F | Only validated substantive facts; context cannot synthesize facts, controlled evidence stays lower authority. Apply BC2 and lossless locators/fragment semantics |
| Zero ADO mutation | G M8/Levels | All current pure modules avoid network; integrated endpoint/method ledger still required |

Concrete additional G divergences, not false executable failures:
- All 20 Work Item fixtures omit System.ChangedDate, required by B's parser.
  They are behavior envelopes, not valid end-to-end wire payloads. Supply explicit
  synthetic source dates and versioned comment/scope metadata via fixture adapters
  before using them for integrated positive parser tests; retain malformed cases.
- G expects unknown custom fields not to silently disappear, while B exposes only
  explicitly whitelisted custom aliases and retains originals in raw source
  metadata. Specify approved aliases plus excluded-field audit and privacy policy;
  do not broaden canonical projection to arbitrary unknown keys.
- G's supporting-evidence item lacks D's typed RecordKind evidence metadata; an
  English title/description alone is not a reliable classifier adapter. Supply
  trusted kind/evidence provenance, not an oracle-fed classification.
- G errors use different names from A/E, and its 4096-character bounded scenario
  is an injected test limit, not B/C/E production limits. Map errors and bytes
  explicitly rather than forcing production to fit fixture shorthand.
- G's six schema checks verify no pipeline execution. C01–C17, G01–G09 and live
  gates stay SPEC_READY/EXECUTABLE_PENDING until attached actual run evidence.

## Production wiring plan — future owner-only changes

| Responsible existing/new owner | Exact future wiring and invariant |
|---|---|
| packages/domain/src/index.ts; apps/runtime/src/capability-registry.ts | Review typed ADO read/discovery/sync/draft/query operations and resource scope, no arbitrary URL/HTTP or write-to-ADO action. Maintain existing compatibility IDs. |
| apps/runtime/src/capability-service.ts executeGoverned / executeAndAudit / executeAuthorized | Add authorized ADO dispatch behind existing authority, validate local project/scope/mission/session before adapter use; do not expose pure workers as bypass routes. |
| apps/runtime/src/capability-effects.ts | Server-derive READ+NETWORK for upstream reads; local sync/staging/Wiki persistence adds WRITE; local query READ only when truly read-only. Invalidation/deletion follows existing effect rules. READ_QUERY is not a core effect and HTTP POST does not itself prove semantic mutation or read safety. |
| New runtime ADO transport/auth resolver adjacent to A adapter.ts; daemon.ts composition | Eight named read methods only, allowlisted endpoint/path/method/query, streaming bounds and cancellation, bounded retry. Auth/session references resolve inside trusted authority; no raw credentials in source args, logs, snapshots or fixture defaults. Treat redirects and relation URLs as untrusted source data. |
| apps/runtime/src/connector-registry.ts boundary | Existing registry binds IRIS FULL/PRO deployment/tunnel identities, not ADO credentials. Do not repurpose it as a customer secret database; use a separate validated local ADO binding under existing runtime owner policy. |
| apps/runtime/src/mcp-v21.ts, mcp-v21-definitions.ts, mcp-catalog.ts and new grouped ADO surface | Add reviewed schemas/serialization that call CapabilityService, preserving FULL/PRO and old catalog semantics. Query/status may not initialize stores or trigger sync. No implicit promotion or remote Wiki publication. |
| apps/runtime/src/ado/m6/store.ts contract; new SQLite backend; daemon.ts; private-fs.ts/data-root lifecycle | Explicit store open/migrate/close, transactions, private files and restart recovery described above. Existing persistence.ts remains its own owner; avoid schema/version collisions. |
| E SyncScheduler/ScheduleIntent; approved workflow owner | E has no timer registration. Persist schedule and idempotent run identity, serialize per authorized scope, cancel/disable explicitly and recheck authority on execution. Optional autonomy workflow worker is not among A–G and cannot be silently integrated. |
| apps/runtime/src/resource-registry.ts VNextResourceRegistry; C provenance; F Wiki BuildState | Register local draft artifacts with authorized owner/hash/size/provenance after successful publication. Preserve scope/run/policy/field/comment lineage and distinguish canonical body hash from raw wire hash. No live URL becomes artifact authority. |
| F queryKnowledge/rebuildWiki; E published(scope) | Serve only authorized published generation and resolved concept truth, never raw/staging/direct caller-supplied PROMOTED flags. Default retrieval includes controlled lower-authority supporting evidence under resolved BC2, not mandatory opt-in. Invalidate caches/indexes on status, source revision, deletion, moved-out membership or policy change. |
| Package metadata/test discovery | Explicit runtime dependency on @iris/ado and a cycle-free shared contract import/export strategy; minimal lockfile update owned by integrator. Wire G's standalone node suite into acceptance checks deliberately. |

Source locations refer to supplied workers; existing integration owners were
inspected at local Phase 5 source checkpoint 3a0ee82 (not asserted generic).
The final generic baseline may move lines/APIs; revalidate wiring there rather
than integrating into this older audit-receipt checkout.

## Genericization and external configuration gate

GENERIC_EXTERNAL_CONFIG_BOUNDARY_READY=YES_SPECIFICATION_ONLY
CUSTOMER_SPECIFIC_IDENTIFIERS_FOUND_IN_NEW_CORE=NO_OBSERVED

Scanned all new non-handoff worker source/test/fixture/docs for case-insensitive
BBL, Bangkok Bank, RARW, NTB, ETB, RDJ, Grab, Ninja, Farmer, farmer-project,
BBLConsumer, AgriScope and personal /Users/ or /home/ paths: zero hits.
Reviewed synthetic target and URL/PII test values: A ExampleOrg/TeamOne/Delivery
with org-1/project-1 IDs; B example.test synthetic identity/auth sentinels;
C scope-fixture and example.invalid links; E org-example/project-example;
G sample-org/sample-project and reserved invalid hosts. D/F use generic source
and concept fixtures. These are not observed customer identifiers. The synthetic
email/GUID/credential-shaped strings are negative redaction test inputs, not
real credentials; do not treat their presence as a real-data discovery.

Personal worktree paths occur only in worker handoff provenance, not new core
modules. Existing base lockfile metadata is not customer configuration. This is
bounded static evidence, not proof about arbitrary unseen deployment values.

Real organization/project/team/board names and IDs, area/iteration restrictions,
service URL, credentials and allowlists belong only in validated external/local
owner configuration. Runtime source IDs may be stored in private scoped
provenance, never hardcoded into generic source/fixtures or exposed as secret
configuration in logs. Keep synthetic ID remapping consistent across edges and
comments; no live reverse map in generic IRIS core. Never choose first/default
Board or wildcard scope on missing/ambiguous config.

The genericization worker b81e597b09e5bf95ecb485e8fb83912e14a2fa92 is an
**audit-only map**, not a genericized baseline. The local Phase 5 integration
branch now points to 3a0ee82, newer than that audit's 8dda948 checkpoint; its
additional security fix must be included/reviewed in final baseline approval.
No exact approved final generic baseline was supplied or verified here.
A–G's clean generic new modules do not make their inherited pre-genericization
base suitable for integration. Require owner-approved baseline SHA, completed
rename/config migration evidence and retained D4 security proofs first.

## Future test sequence — no live tests executed

Keep execution state and result separate: SPEC_READY → EXECUTABLE_PENDING →
EXECUTED with PASS/FAIL/SKIP and immutable implementation/fixture digests. Report
actual versus expected counts, policy/classifier version, scope aliases and
sanitized evidence for each stage. Isolated worker PASS is not integrated PASS.

| Stage, in required order | Test scope and exit evidence |
|---|---|
| 1. Contract/unit | Re-run A 39, B 35, C 44, D 43, E 43, F 56 and G 6 after reconciliation; add adapters/status/truth/date/hash/error/category matrices, no expectedStatus fed to SUT. Resolve changed counts explicitly. |
| 2. Integrated fake adapter | A→B→C→D→E→F with G synthetic generators; account each expected ID and all comment/link pages. Valid/invalid data, failure/cancel/retry, scoped identity, provenance and noise isolation. All fake I/O, no external endpoints. |
| 3. SQLite/restart | Real temporary local SQLite, explicit migrations/transactions, lost ACK, concurrent writers, restart recovery and publication/index/curation consistency. No live source needed. |
| 4. Single synthetic Work Item | Required source date/revision/comments and one status; expected 1=fetched 1=classified 1, exact field provenance and successful draft or explicit rejection. |
| 5. Synthetic subtree | Feature with arbitrary descendants and relations; independently expected set, dedup reciprocal edges, orphans/cycles fail completeness, evidence and context not official. |
| 6. Synthetic backlog | Dynamic type/level configuration, all pages, duplicate rows, empty level and bounded over-limit handling; independent unique counts reconcile. Include a multi-backlog synthetic full-Board fixture here before live progression. |
| 7. Live read-only one Work Item (Level 1) | Separately owner-authorized credential/scope; one exact ID/revision and complete comments, manual classification sample of that item, resolvable provenance, approved read request ledger and zero mutation. |
| 8. Live Feature subtree (Level 2) | Independent subtree expected/fetched/classified ID sets and type/status subtotals; sample each represented type/status plus every ambiguity/conflict; validate every promoted citation and parent; zero mutation ledger. |
| 9. Live backlog (Level 3) | Discover chosen backlog dynamically, exhaust pages; compare independently captured membership/counts; reproducible stratified classification sample plus every exception; provenance and revision-window checks; zero mutation ledger. |
| 10. Live full Board (Level 4) | All discovered levels/all Board Work Items, full comments/relations; independent manifest and counts, failed=0 or explicit incomplete, all classified once; stratified level/type/status/reason sample and all review cases; Full Sync audit and Wiki provenance; zero remote mutation. |

All live stages are future conditional procedures, not permission to execute now.
Read-only guarantee requires an allowlisted read-semantic request ledger, no
work-item/comment/link/attachment/Wiki mutation endpoints, and source revision
comparison; unchanged revisions alone cannot prove no attempted writes. A read
query using POST requires exact endpoint/payload approval, not blanket POST
access. Revision churn invalidates a completeness claim until reconciled.
No failures are hidden as empty success. Preserve previous corpus with its true
run identity, not a falsely fresh Wiki. Customer live evidence stays private,
not committed into synthetic fixture catalog. Retain sampling limitations.

## Integration blockers and release distinction

| Blocker | Required closure |
|---|---|
| R1 handoff readiness | Owner-authorized D/F/G affirmative committed receipts and updated authoritative SHAs; normalize C if consumer requires literal exact YES. |
| R2 generic baseline | Exact owner-approved post-genericization vNext baseline with latest Phase 5 security proofs; audit map alone is insufficient. |
| R3 policy implementation / fixture reconciliation | BC1–BC3 and supplied M8 principles are resolved by owner instruction. Apply the listed code/test adjustments and schema/custom-field mappings during integration; no further policy receipt is required for these three decisions. |
| R4 contract composition | Implement/review lossless boundary mappings, persisted truth/provenance, trusted classifier and cycle-free package exports on the integration branch. |
| R5 production completion | Implement durable store/migration/runtime wiring and pass integrated fake/SQLite/restart tests before claiming M6 MVP or exposing production service. |
| R6 eventual release evidence | Complete separately authorized live Levels 1–4 and M8 gates; do not mark source-plan or production PASS from this read-only audit. |

INTEGRATION_READY_AFTER_GENERIC_BASELINE=NO
The generic baseline is necessary but not sufficient: R1 handoff receipts remain
pre-integration gates. R3/R4/R5 are planned integration deliverables, not a
reason to claim the worker foundations missing; R6 gates MVP release, not textual
cherry-pick feasibility. There are zero file collisions and zero unresolved
BC1–BC3 policy decisions; contrary worker implementations/oracles still require
adjustment. No worker source was changed and no integration or release PASS is claimed.

## Audit validation and handoff

Static checks verify all seven commit objects and ancestry, 46 distinct changed
paths, zero pairwise intersections (21 pairs), zero shared-zone modifications,
B's exact importer-only lockfile delta, 11 required commits in ancestry order,
worker handoff-marker presence/absence, and generic-source scan results.
Those checks describe the original audit evidence, not newly executed suites.
This policy follow-up statically reviewed pinned A/D/G contracts plus D/F retrieval
and G acceptance expectations. Its validation is document consistency,
`git diff --check` and exact single-path staging. Existing untracked owner files
are outside the patch and staging scope; no worker checkout is mutated.
No build/test/probe or external request is part of this audit. The final audit
commit SHA is returned separately to avoid a self-referential document hash.

PRODUCTION_SOURCE_CHANGED=NO
TESTS_CHANGED=NO
SHARED_INTEGRATION_ZONE_CHANGED=NO
MASTER_STATUS_CHANGED=NO
WORKER_BRANCHES_CHANGED=NO
PUSHED=NO
HANDOFF_READY=YES
NEXT_STEP=ADO_INTEGRATION_AFTER_GENERIC_BASELINE
