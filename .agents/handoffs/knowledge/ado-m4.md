# ADO M4 graph, comments and provenance handoff

MISSION=IRIS_VNEXT_ADO_C_M4_GRAPH_PROVENANCE
ROLE=WORKER_ADO_C
WORKSTREAM=ADO_M4_GRAPH_COMMENTS_PROVENANCE
DATE=2026-09-15
EXPECTED_ROOT=/Users/bill/iris-wt-ado-m4
EXPECTED_BRANCH=codex/ado-m4-graph-provenance
BASE_SHA=5f6b35e034d7a8d8143c0a7558b507316daa3c32
HEAD_SHA=c392f585ba15c9472b6787970656cb21ccf07023
HEAD_SHA_SCOPE=IMPLEMENTATION_CHECKPOINT

## Verification and ownership

Verified expected root, branch, HEAD, empty initial git status, and BASE_SHA ancestry (exit 0; HEAD equals BASE_SHA). Read AGENTS.md, the vNext connector/provenance boundary and effect/resource identity contract. No nested AGENTS.md was found. No legacy implementation or external customer files were read.

Only these new files belong to this workstream:

- apps/runtime/src/ado-knowledge-provenance.ts
- apps/runtime/src/ado-knowledge-graph.ts
- apps/runtime/src/ado-knowledge-comments.ts
- apps/runtime/src/ado-knowledge-m4.test.ts
- .agents/handoffs/knowledge/ado-m4.md

No shared integration file, domain enum, runtime capability, daemon route, MCP surface, DB schema, manifest or lockfile was changed. Existing tracked files remain unchanged. Dependencies were materialized with the existing frozen lockfile using the offline cache; no dependency was added. Build output and node_modules are ignored local artifacts, not handoff files.

The follow-up IRIS_VNEXT_ADO_C_M4_DURABLE_CHECKPOINT mission authorized committing these five files. The implementation checkpoint is c392f585ba15c9472b6787970656cb21ccf07023, with message `feat: add ADO graph and provenance foundation`. HEAD_SHA above identifies that implementation checkpoint; this receipt-only follow-up is a descendant whose final HEAD is returned by the checkpoint mission, avoiding a self-referential commit hash. Implementation/test content is unchanged from the validated state, so validation was not rerun. No shared integration-zone file changed and no push, merge or publication was performed.

## Contract surfaces

### Source facts and revision identities

`ado-knowledge-provenance.ts` owns:

- KnowledgeWorkItem: opaque scopeId plus workItemId. The scope is supplied by a later validated local connector binding, not a fixed organization/project or a display name. Tuple keys avoid collisions across scopes.
- KnowledgeSource: discriminated FIELD(name), COMMENT(commentId, version), or RELATION(relationId).
- KnowledgeProvenance: source work item, positive safe-integer revision, exact source locator, canonical UTC changedDate and lowercase SHA-256 contentHash.
- KnowledgeFact: schemaVersion=1, plain-text body, source authority and provenance. createKnowledgeFact normalizes NFC, line endings and control/format characters, retaining newlines and tabs. It hashes UTF-8 normalized body bytes. validateKnowledgeFact rejects mismatched authority, noncanonical body and hash mismatch, returning detached canonical data.
- KnowledgeRevisionDiff: schemaVersion=1, deterministic diffId, complete before/after provenance and contentChanged. The identity hashes both canonical provenance records. Comparisons require the same scoped work item and same field/comment/relation locator, nondecreasing changed date and advancing revision. A comment version may advance at the same work-item revision. Reversed comment versions and content changes without a new comment version are rejected. Unchanged text across revisions still has a distinct revision identity.

These are serializable storage contracts, not a persistent store implementation. There is no database, migration, storage side effect or probe mutation. The 1 Mi-character per-body limit applies before normalization. Hashes prove correspondence to normalized content, not authenticity of an external server or authorization to retrieve it. Original raw wire-byte hashes are not claimed.

### Graph and hierarchy

`ado-knowledge-graph.ts` owns createKnowledgeEdge and buildKnowledgeGraph.

- Nodes carry scoped work-item identity and source provenance. Duplicate nodes or mismatched source identity are rejected.
- Every edge retains source, exact type, target and RELATION provenance. The edge factory hashes canonical [type, target] metadata; the graph verifies that hash, source identity, unique source/revision/relationId and agreement with the source node's snapshot revision.
- CHILD means source parent → target child. PARENT means source child → target parent. Returned edges preserve both original directions/evidence; the separate hierarchy projection deduplicates reciprocal arcs.
- Hierarchy is a flat, keyed adjacency representation with parents, children and roots, allowing any work-item labels/depth within the bounds. There is no Initiative/Epic/Feature/Story assumption.
- A forest or standalone zero-parent node is valid. A missing referenced source/target is reported as an ORPHAN; missing parents are not silently treated as new roots. Inputs with multiple parents or self-links are reported as invalid hierarchy.
- Iterative DFS detects rootless/deep cycles without recursive stack growth. To bound diagnostics, CYCLE contains one concrete witness path, not an exhaustive enumeration of every cycle. All nodes remain traversed. Downstream acyclic nodes are not mislabeled as cycle members.
- RELATED and DEPENDS_ON remain generic directed relation records; DEPENDS_ON points from dependent to prerequisite. Their cycles do not become hierarchy cycles. Unresolved generic references have domain=RELATION, distinct from domain=HIERARCHY issues. validHierarchy covers only hierarchy issues, not completeness of all generic relations.
- EXTERNAL_SUPPORTING_REFERENCE targets a referenceId, not a presumed work-item node. Integration joins it against the supporting index by scoped source work item plus referenceId. This module does not resolve/download external references or prove the index entry exists.
- Internal work-item relations crossing scope are rejected by graph construction. External relationships must use the external-reference contract rather than implicitly expanding connector scope.

Graph limits: 10,000 nodes and 50,000 edges. Invalid input shapes/identity contracts throw; valid but incomplete/cyclic hierarchy returns explicit issues and validHierarchy=false. Integration must not present such a graph as complete merely because some roots are available.

### Comments and page batches

`ado-knowledge-comments.ts` owns createKnowledgeComment and assembleKnowledgeComments.

- Each normalized comment retains commentId, version, COMMENT fact authority and exact provenance.
- Identity output contains only a scope-bound SHA-256 opaqueId; raw identity input, email/display/profile fields and additional caller fields are not copied. This is pseudonymization, not a guarantee of anonymity against dictionary attacks. Prefer an opaque provider identity as input; do not log raw identity data.
- Body format is explicitly PLAIN_TEXT. Markup remains literal text, never trusted HTML. Consumers must escape text/use a text node; this contract does not provide an HTML sanitizer or rich-text renderer.
- Pages retain source work item, snapshot revision, cursor, nextCursor and normalized comments. Batches reject mixed work items/revisions, cursor gaps/cycles, continuation after a terminal page, duplicate comment ID/version pairs and mismatched comment provenance.
- complete=true only when the supplied contiguous chain starts at cursor=null and ends at nextCursor=null. An empty terminal first page is complete; a resumed segment or a segment with a next cursor is partial. This flag trusts the adapter's pagination declarations, not an independent live-server completeness check.
- Multiple versions of one comment are retained, not silently overwritten. Limits are 100 pages, 1,000 comments/page, 10,000 comments/batch and 8 MiB aggregate normalized UTF-8 body content.

### Clarification and decision candidates

KnowledgeCommentClassifier is an injected synchronous interface. Only fake classifiers are provided in tests. classifyKnowledgeComment accepts only CLARIFICATION, DECISION, REJECTED_BEHAVIOR or KNOWN_LIMITATION, with at most 100 nonempty bounded statements.

Every returned interpretation has authority=DERIVED_COMMENT, status=CANDIDATE, its own normalized body/contentHash and a detached, exact sourceComment provenance including comment ID/version, work-item revision, date and original normalized comment hash. Classifier output cannot override source identity or promote a statement to an official requirement. Classifier input is cloned so mutation cannot alter retained evidence. Official description FIELD facts and COMMENT facts remain separate. No classifier provider, LLM request or autonomous classification policy is wired.

### Supporting links

indexKnowledgeSupportingLinks models DOCUMENT, DESIGN, TEST_RESULT, ATTACHMENT and SHAREPOINT_REFERENCE as metadata only: referenceId, kind, normalized title, URL and a provenance-bearing metadata fact. Duplicate reference IDs within the same scoped work item are rejected; other work items have separate namespaces.

Only HTTPS URLs without embedded username/password are accepted. Query and fragment components are removed to avoid retaining common sharing/authentication tokens. Consequently the retained locator may not be directly usable for links requiring query-based routing; no claim of reachability is made. Path/title text can still be sensitive and belongs under the eventual connector's redaction/retention policy. No URL is fetched, no document body is downloaded, and the metadata hash is not presented as a remote document-content hash. Metadata sourced from a comment retains COMMENT authority.

Limits: 10,000 references, 8,192 characters per URL, 4,096 normalized title characters and 8 MiB aggregate normalized metadata. Linking a supporting reference never grants permission to fetch it.

## Validation evidence

The final validation sequence completed successfully:

1. `node scripts/node24.mjs --pnpm --filter @iris/runtime exec vitest run src/ado-knowledge-m4.test.ts` — PASS, 44/44 tests, one focused file.
2. `node scripts/node24.mjs --pnpm lint` — PASS.
3. `node scripts/node24.mjs --pnpm typecheck` — PASS across the workspace.
4. `node scripts/node24.mjs --pnpm build` — PASS across the workspace.
5. `git diff --check` plus per-new-file `git diff --no-index --check /dev/null <file>` — PASS, no whitespace diagnostics; the no-index exit status 1 denotes new-file differences. Ownership verification confirms exactly the five new files above, with no tracked or staged changes.

The initial broad pass exposed an unused test type import and an implicitly-any map parameter; both were corrected in owned files before the successful final run. No unrelated source was modified. No full repository test suite was run.

Focused cases cover canonical source/hash/authority validation, invalid versions/dates/IDs, stable revision diff identity, same-revision comment edits, arbitrary/deep hierarchy, reciprocal edges, orphan and multi-parent detection, rootless cycles and bounded cycle witnesses, generic relation isolation, stale/tampered graph evidence, comment pagination/version/source boundaries, aggregate limits, all four fake classification categories, provenance-mutation resistance, all five link categories, unsafe URLs and duplicate link identities. Tests use synthetic scope/item/comment/reference labels and reserved example.invalid domains only; no real customer IDs, live ADO calls or persistent DB are used.

## Integration requirements and deferred scope

- A later adapter maps authorized input into these normalized contracts; no ADO REST API shape/version mapping is asserted here. Supply stable relation identities and the source snapshot revision/date rather than deriving authority from work-item types or project names.
- Resolve organization/project/team/board values through explicit external/local configuration and allowlists. scopeId is a binding identifier, not proof of authorization. This worker adds no credential or network path.
- Maintain CapabilityService/effect/ownership boundaries when any connector retrieval or persistence is added. Do not bypass them by treating these pure builders as an execution authority.
- Revalidate serialized facts using validateKnowledgeFact; persist canonical records transactionally only in the later DB integration. Define storage ownership/migration/retention there, not as hidden behavior in these builders.
- Reconcile the supporting index with external edges and report unresolved references; keep partial graph/page status visible.
- Render normalized text safely; preserve official versus comment versus derived-candidate authority. A decision candidate is not an accepted product requirement.
- Deleted comments, rich-text conversion, live transport, document retrieval, remote link verification, durable pagination checkpoints, persistence and an official requirement-approval workflow are not implemented by this isolated M4 contract layer.

## Return status

MISSION_RESULT=PASS
HIERARCHY_GRAPH_READY=YES
GENERIC_RELATIONS_READY=YES
COMMENTS_MODEL_READY=YES
CLARIFICATION_CONTRACT_READY=YES
LINK_INDEX_READY=YES
PROVENANCE_STORE_CONTRACT_READY=YES_SERIALIZABLE_CONTRACT_ONLY
ORPHAN_DETECTION_READY=YES
CYCLE_DETECTION_READY=YES
CUSTOMER_SPECIFIC_IDENTIFIERS_IN_CORE=NO_IN_NEW_M4_MODULES_OR_TESTS
TESTS_ADDED=44
FOCUSED_VALIDATION=PASS_44_OF_44
HANDOFF_READY=YES_COMMITTED_ISOLATED_FILES
PUSHED=NO
BLOCKERS=NONE
NEXT_STEP=ADO_INTEGRATION
