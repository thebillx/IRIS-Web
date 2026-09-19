# ADO Knowledge/Wiki M8 acceptance and release contract

Date: 2026-09-15. Mission: `IRIS_VNEXT_ADO_G_M8_ACCEPTANCE_FIXTURES`.
Base: `5f6b35e034d7a8d8143c0a7558b507316daa3c32`.

## Authority, scope and readiness

This document began as a synthetic acceptance foundation. The owner-policy
reconciliation recorded in `.agents/handoffs/knowledge/ado-integration-readiness.md`
is now authoritative for the converged MVP status algebra and source boundaries.

As of 2026-09-19, the fixture catalog is bound to the real converged M1–M7 modules
through `apps/runtime/src/ado-m8-acceptance.test.ts`. Local acceptance now executes
read-only adapter contracts, pagination, normalization/redaction, comments/graph,
Knowledge Gate, orthogonal truth state, M6 quarantine/publication and SQLite
durability, then M7 Wiki projection/retrieval. This is local production-module
evidence, not live Azure DevOps evidence.

Fixtures: `FIXTURE_READY`. Converged local module acceptance:
`LOCAL_EXECUTED_PASS`. Live Levels 1–4 remain `LIVE_PENDING` until a separately
authorized ADO binding/credential is available and the read-only request ledger is
captured. Local success must not be reported as live release acceptance.

`CUSTOMER_SPECIFIC_IDENTIFIERS_IN_CORE=NO`

## Contract/unit acceptance matrix

Fixture keys resolve in `tests/ado-acceptance/fixtures/catalog.json`.
Future tests must not give oracle fields to the system under test.

| ID / coverage | Fixture(s) | Required behavior | Owner layer / workstream | Future test type |
|---|---|---|---|---|
| C01 parser | normal-story, malformed-item, bounded-description | Accept typed source fields; reject wrong ID/fields shapes; enforce limits before promotion; malformed record cannot disappear from completeness accounting | ADO parser / M3 ingestion | UNIT, SECURITY |
| C02 normalizer | story-no-description, story-acceptance-criteria, placeholder | Missing description remains missing, HTML becomes safe text; preserve criteria and meaning; whitespace-only HTML is empty; never execute markup | ADO normalizer / M3 | UNIT |
| C03 PII redaction | pii-redaction, story-comments, story-custom-fields | Inject synthetic email, identity GUID and credential sentinels in memory; redact all surfaces before persistence/model/projection; source entity ownership is not an identity leak | Redaction / M4 privacy | UNIT, SECURITY |
| C04 graph | feature-subtree, orphan-relation, graph-cycle | Rebuild parent/child edges, detect cycles, do not invent missing parents; inconsistent reciprocal edges flagged; unresolved required graph blocks completeness | Hierarchy / M3 | UNIT, CONTRACT |
| C05 comments | story-comments | Consume all comment pages once; preserve order, comment ID/date and source revision; scrub identity fields; partial/error page makes evidence incomplete | Comment ingestion / M3–M4 | UNIT, CONTRACT |
| C06 links | unsafe-links, normal-story | Canonicalize validated source references; reject unsafe schemes and cross-project traversal; never fetch arbitrary related URLs automatically | Link/provenance / M3–M4 | UNIT, SECURITY |
| C07 custom fields | story-custom-fields | Preserve reference names and scalar types including false/zero/null; normalize HTML safely; unknown fields do not silently vanish; bounded/redacted before model use | Normalizer / M3–M4 | UNIT |
| C08 provenance | normal-story, story-comments, pagination | Retain logical source, ID, revision, field/comment locator, observed time, content digest and classification version through projection; never assert comments are description text | Source evidence / M4 | CONTRACT, INTEGRATION |
| C09 deterministic noise | execution-only-task, support-only-story, retest, prepare-data, admin-only-story, valid-support-requirement | Stable reason codes exclude execution/admin/QA work; keyword support alone is insufficient; repeated runs/order changes produce same deterministic result | Knowledge Gate / M5 | UNIT |
| C10 semantic classifier contract | classifier-invalid, ambiguous-story, conflicting-story | Require bounded schema, valid source binding, evidence references, status, reason and classifier/policy version; unknown status, invented ID, timeout, malformed output fail closed to quarantine; source text is data, not instructions | Classifier / M5 | CONTRACT, SECURITY |
| C11 promotion | normal-story, story-acceptance-criteria, supporting-evidence | Behavior-rich requirements may promote only with valid evidence and policy; deterministic rejection cannot be overridden by model; evidence-only record cannot self-promote | Promotion / M5 | UNIT, INTEGRATION |
| C12 context-only | epic-container, context-only-epic, supporting-evidence | Preserve grouping/context with explicit non-authoritative labels; never turn container titles into independent requirements | Knowledge Gate / M5 | UNIT, CONTRACT |
| C13 quarantine isolation | ambiguous-story, conflicting-story, orphan-relation | Persist review reason separately from promoted content; exclude from default semantic retrieval and Wiki; failure or retry never bypasses gate | Knowledge storage / M5–M6 | INTEGRATION, SECURITY |
| C14 duplicate/superseded/conflict | duplicate-story, superseded-story, conflicting-story | Explicit canonical/obsolete/conflicting relationships and evidence survive normalization; deduplicate primary content without deleting history; uncertainty quarantines, no silent winner | Relationship policy / M5–M6 | UNIT, INTEGRATION |
| C15 Wiki projection | normal-story, context-only-epic, supporting-evidence, execution-only-task | Local draft only, promoted requirements with resolvable provenance; context labeled, evidence not official; no rejected/quarantined content, no obsolete duplicate assertions | Wiki projection / M7 | CONTRACT, INTEGRATION |
| C16 upstream errors | upstream-401, upstream-403, upstream-429, upstream-5xx | Sanitize error, no auth fallback or scope widening; 401/403 stop; 429/5xx bounded cancellable retry respecting capped Retry-After; exhausted retry reports incomplete, not success | ADO reader / M1–M2 | CONTRACT, SECURITY |
| C17 pagination/completeness | pagination, pagination-cycle, backlog-discovery | Dynamic levels, deduplicated IDs, exhausted cursor and exact counts; repeated cursor, missing page, cancellation, per-item failure and changing revisions invalidate full-sync claim | Board collection / M2–M3, audit / M6 | CONTRACT, INTEGRATION |

## Knowledge Gate regression matrix

The resolved relevance statuses are `PROMOTED`, `CONTEXT_ONLY`,
`SUPPORTING_EVIDENCE`, and `REJECTED`. `QUARANTINED` is not a fifth relevance
status. Review is modeled orthogonally through truth/admission state:
`CURRENT`, `DUPLICATE`, `SUPERSEDED`, `CONFLICTING`, `AMBIGUOUS`,
`NEEDS_REVIEW`.

Keep raw-source evidence physically/logically separate from promoted knowledge.
Raw means source-stage evidence, not permission to retain unredacted secrets.
Default retrieval admits current/duplicate promoted knowledge plus controlled,
lower-authority supporting evidence that passed the governed pipeline. Superseded
history and unresolved truth states use separate history/review partitions and
never gain substantive Wiki authority.

| ID | Fixture | Eventual proof | Owner / test |
|---|---|---|---|
| G01 | execution-only-task | Source-stage record may exist; primary Knowledge Store and default retrieval contain no ordinary Task | M5–M6 / INTEGRATION |
| G02 | support-only-story, retest, prepare-data | Support QA / Retest / Prepare Data absent from default Wiki | M5–M7 / INTEGRATION |
| G03 | valid-support-requirement | The word support alone never rejects this valid behavior-rich requirement | M5 / UNIT |
| G04 | placeholder | Empty/TBD item is REJECTED with PLACEHOLDER reason | M5 / UNIT |
| G05 | epic-container | Container is CONTEXT_ONLY, not an official requirement | M5 / UNIT |
| G06 | normal-story, story-acceptance-criteria | Behavior-rich Story can be PROMOTED with source-backed assertions | M5 / CONTRACT |
| G07 | supporting-evidence | Evidence cannot silently enter official requirements, including via linked-item expansion or Wiki synthesis | M5–M7 / SECURITY, INTEGRATION |
| G08 | placeholder, support-only-story | REJECTED records absent from default semantic retrieval, including text search, vector results, caches and linked expansion | M6 / SECURITY, INTEGRATION |
| G09 | duplicate-story, superseded-story, conflicting-story | One canonical assertion; obsolete evidence labeled; unresolved contradictions quarantined, never silently merged | M5–M7 / INTEGRATION |

Execute eventual regressions before and after resync, source revision changes,
status transitions and restart. Reclassification must remove old promoted index
entries atomically; stale retrieval/Wiki caches cannot retain rejected content.

## Sanitized audit contract

Use an allowlisted structured record, reject unknown fields, bound strings/arrays,
and validate counters as nonnegative safe integers. Never log source payloads,
model prompts/responses, request headers or raw upstream error bodies.

| Field | Contract |
|---|---|
| schemaVersion | Fixed integer version; reject unsupported versions |
| runRef | Local opaque correlation reference, not an upstream identity GUID |
| capabilityCategory / actionCategory | Reviewed enum such as ADO_READ / DISCOVER, COLLECT, NORMALIZE, CLASSIFY, AUDIT, PROJECT_DRAFT |
| projectRef / boardRef | Local logical aliases only; no real names, URLs or upstream IDs |
| outcome | SUCCEEDED, INCOMPLETE, DENIED, FAILED or CANCELLED; never success on partial reads |
| objectCount | Unique work items considered, not page rows or relation count |
| durationMs | Finite nonnegative elapsed monotonic duration |
| sanitizedError | Null or allowlisted code + stage + retryable boolean; no free upstream message |
| classificationCounts | PROMOTED / CONTEXT_ONLY / SUPPORTING_EVIDENCE / REJECTED counters; truth/review counts are separate |
| promotionReasonCounts / rejectionReasonCounts | Versioned allowlisted reason enum counters; never generated free text |
| discoveredCount / fetchedCount / classifiedCount / failedCount | Distinct IDs; explicit per-stage accounting |
| duplicatePageRows / unresolvedRelationCount | Separate nonnegative counters; do not inflate objectCount |
| completeness | COMPLETE or INCOMPLETE, with bounded enumerated incompleteReasons |
| policyVersion / classifierVersion | Local version labels, not prompts, credentials or model output |

Full Sync audit passes only if discovery finished all levels/pages, discovered ID
set equals fetched ID set, fetched equals classified, failedCount is zero, each
item has exactly one status, sum(classificationCounts) equals classifiedCount,
and promotion/rejection reason totals equal their respective status counts (one
primary reason per record; auxiliary reasons tracked separately). Repeated pages
must not inflate counts. Orphans/cycles and revision churn must be resolved or
reported INCOMPLETE, not hidden to make counts agree. Promotion and provenance
integrity checks are required in addition to counts. Audit failures must not
publish a complete Wiki draft or expose partially classified primary knowledge.

Explicitly forbidden: **token, raw credentials, email, identity GUID, raw secret**.
Also forbid authentication metadata, authorization/cookie headers, query secrets,
raw URLs and free-text identifiers. Pagination cursors can exist transiently in
transport state but are not audit tokens. Future audit tests must inject synthetic
sentinels into every input/error surface and capture logs, persistence, artifacts,
model inputs and Wiki output; assert absence and verify no denied action mutates
state. This contract does not authorize global bypasses or real PII fixtures.

## Future live-integration progression

No live access was performed by this worker. Each stage needs separately approved
read-only scope, a credential held outside fixtures/logs, exact run evidence and
the preceding stage's acceptance. Counts use independently obtained read-only ADO
inventory at a recorded observation window; revision churn requires retry or an
explicit INCOMPLETE result, not a false snapshot claim.

| Level | Scope | Completeness check | Count comparison | Classification sampling | Provenance checks | Read-only guarantee |
|---|---|---|---|---|---|---|
| Level 1 | single Work Item | Requested item/revision and all comments/selected fields fetched; links scoped | Requested 1 = fetched 1 = classified 1; comment counts match all pages | Manually review that item's status, reason and evidence | ID/revision, field/comment locators and redacted digest resolve | Capture method/path ledger; only approved read operations; before/after revision unchanged |
| Level 2 | Feature subtree | Recursively resolve descendants without cycles or unresolved in-scope parents | Independent subtree unique-ID set = fetched/classified set, by type and status | Review Feature plus every status/type represented and every conflict/orphan | Verify parent edges and provenance for every promoted assertion | Same read ledger; no item, relation, comment, attachment or Wiki writes; before/after revisions unchanged |
| Level 3 | one backlog level | Discover chosen level dynamically and exhaust all its pages, not a hardcoded type | Independent level set/count = fetched/classified, duplicates separated | Review at least one per status/type/reason and all ambiguous/conflict cases; record seed/sample IDs privately | Verify source and revision on sampled items and every draft assertion | Same allowlisted transport and revision comparison; local knowledge writes separately governed |
| Level 4 | full Board | Enumerate configured Board directly, all discovered levels, pages, comments and all Board Work Items in authorized scope | Independent Board set = discovery = fetch = classification; type/level/status subtotals reconcile | Stratified sample per level/type/status/reason plus all quarantine/conflict cases; document omissions, never infer success for unsampled semantics | All promoted assertions have resolvable lineage; duplicate/superseded edges preserved; Full Sync audit passes | Read-only transport ledger plus unchanged source revisions; zero remote write requests, including Wiki publication |

Transport read-only means approved read-semantic endpoints only. If ADO exposes
a read query as POST, review/allowlist that exact endpoint and read-only payload
separately; never allow arbitrary POST. Mutation endpoints/methods fail before
network dispatch. Local artifacts do not grant ADO write authority. Before/after
revision checks alone are not sufficient proof of no mutation; retain the request
ledger and assert zero write attempts. Keep live evidence outside generic fixtures.

## M1–M8 MVP gate contract

These are mission-derived acceptance groupings, pending source-plan reconciliation;
they are not a claim to have read the absent milestone definitions.

| Gate | Mandatory eventual proof | Acceptance linkage | Current state |
|---|---|---|---|
| M1 configured source / authority | Read configured Board directly through governed local capability; explicit project/board scope, no export prerequisite; no auth/scope fallback | C06, C16; Levels 1–4 | LOCAL_PASS / LIVE_PENDING |
| M2 discovery / collection | Dynamically discover backlog levels and collect all Board Work Items, every page and unique ID; no fixed backlog-type assumption | C17; Levels 3–4 | LOCAL_PASS / LIVE_PENDING |
| M3 hierarchy / normalization | Reconstruct hierarchy; normalize descriptions, criteria, all comments and custom fields; malformed/bounded input fails safely | C01–C07 | LOCAL_PASS |
| M4 privacy / provenance | Redact PII before downstream use, retain lineage, keep source-stage data separate from promoted knowledge | C03, C08 | LOCAL_PASS |
| M5 Knowledge Gate | Classify every item; four relevance statuses; exclude task/support/admin noise by default; keep truth/review orthogonal | C09–C13; G01–G08 | LOCAL_PASS |
| M6 semantic integrity / Full Sync | Preserve duplicate/superseded/conflict semantics; no rejected/review default retrieval; counts, completeness and durable persistence pass | C13–C14, C17; G08–G09; audit contract | LOCAL_PASS |
| M7 Wiki draft | Generate local Wiki draft with classification provenance; validated claims only, labeled context/evidence, no review/history authority | C15; G02, G07, G09 | LOCAL_PASS |
| M8 release readiness | Execute local contracts/regressions and live Levels 1–4; prove zero ADO mutation and generic core identifiers; no skipped live gate treated as pass | All rows; read-only ledger; hygiene review | LOCAL_PASS / LIVE_PENDING |

Required evidence per executed case: case ID, fixture key/digest, implementation
revision, environment (macOS verified only), command or approved live procedure,
actual versus expected results, run timestamp, sanitized artifact reference,
PASS/FAIL/SKIP and any limitation. A release requires PASS, not merely EXECUTED.
Schema checks prove this fixture foundation only. They cannot close M1–M8.
