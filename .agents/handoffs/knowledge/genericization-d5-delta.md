# D5 delta genericization audit and merged implementation map

MISSION=IRIS_VNEXT_GENERICIZATION_D5_DELTA_REFRESH
DATE=2026-09-15
STATUS=AUDIT_ONLY_OWNER_APPROVAL_REQUIRED

## Immutable evidence and scope

D4_HEAD=8dda9481864f4fa2af1f74d9c08a3aa19e39e4e6
D5_HEAD=1d591e9002cbfb5df717c8ebacebec995b1adb7a
AUTHORITATIVE_GEN_AUDIT=b81e597b09e5bf95ecb485e8fb83912e14a2fa92

The authoritative prior artifact is .agents/handoffs/knowledge/genericization-post-d4.md at AUTHORITATIVE_GEN_AUDIT. Both source commit objects exist and D4 is an ancestor of D5. Reviewed the complete eight-path D4-to-D5 diff (644 insertions, 94 deletions). Source evidence is read from immutable Git objects, not assumed from the current checkout. The audit checkout is branch v2.3/mcp-activation-rebind with initial HEAD e48823c91bffed45933258c5bec0ef4d22265e6d. Existing owner untracked handoffs remain untouched. Root instructions apply; no nested AGENTS.md exists under .agents.

No external requests, live ADO access, credential probes, source/test edits, renames, master-status updates, or worker-branch changes. The only new artifact is this audit. It is excluded from the source inventory and destination collision scan.

## Changed-file inventory

| D5 path | Prior references | Current references | Added | Removed/replaced |
|---|---:|---:|---:|---:|
| .agents/handoffs/phase5/final-source-byte-identity.md | 0 | 1 | 1 | 0 |
| .agents/handoffs/phase5/integration.md | 14 | 15 | 3 | 2 |
| apps/runtime/src/archive-engine.ts | 4 | 4 | 0 | 0 |
| apps/runtime/src/capability-service.ts | 0 | 0 | 0 | 0 |
| apps/runtime/src/document-engine.ts | 0 | 0 | 0 | 0 |
| apps/runtime/src/opc-package.ts | 2 | 2 | 0 | 0 |
| apps/runtime/src/phase5-integration.test.ts | 0 | 0 | 0 | 0 |
| apps/runtime/src/phase5-source-identity.test.ts | 0 | 0 | 0 | 0 |

## Counting and conceptual merge

One reference is a distinct tracked file plus line, not a token count or a defect. Use the prior literal and supplementary path criteria; review neutral acceptance IDs and fixture identifiers qualitatively rather than counting every generic name. Retain the 296 references in unchanged files without reclassification. Of 20 prior references in changed files, 18 survive with the same classification and two historical log lines are superseded. Four new historical lines yield 316 + 4 - 2 = 318 current references across 70 files. Active implementation scope remains 21 files.

| Classification | D4 | Added | Removed | Final D5 |
|---|---:|---:|---:|---:|
| MUST_GENERICIZE | 123 | 0 | 0 | 123 |
| EXTERNALIZE_TO_CONFIG | 5 | 0 | 0 | 5 |
| MAY_RETAIN | 93 | 0 | 0 | 93 |
| FALSE_POSITIVE | 36 | 0 | 0 | 36 |
| HISTORICAL_ONLY | 59 | 4 | 2 | 61 |

### New current references

| D5 location | Class | Evidence |
|---|---|---|
| .agents/handoffs/phase5/final-source-byte-identity.md:13 | HISTORICAL_ONLY | WORKTREE=/Users/bill/iris-wt-p5-source-byte-binding-final |
| .agents/handoffs/phase5/integration.md:16 | HISTORICAL_ONLY | O_WORKTREE=/Users/bill/iris-wt-p5-source-byte-binding-final |
| .agents/handoffs/phase5/integration.md:409 | HISTORICAL_ONLY | VALIDATION_LOGS=/tmp/iris-d5-focused.log; /tmp/iris-d5-full.log; /tmp/iris-d5-lint.log; /tmp/iris-d5-typecheck.log; /tmp/iris-d5-build.log |
| .agents/handoffs/phase5/integration.md:410 | HISTORICAL_ONLY | PROCESS_LOGS=/tmp/iris-d5-process-before.log; /tmp/iris-d5-process-during.log; /tmp/iris-d5-process-after.log |

These are run-receipt paths, not executable defaults or customer targets. Preserve historical provenance; do not substitute synthetic paths and imply those runs used them.

### Superseded prior references

| D4 location | Prior class | Superseded evidence |
|---|---|---|
| .agents/handoffs/phase5/integration.md:289 | HISTORICAL_ONLY | VALIDATION_LOGS=/tmp/iris-d4-red.log; /tmp/iris-d4-containment.log; /tmp/iris-d4-focused.log; /tmp/iris-d4-full.log; /tmp/iris-d4-lint.log; /tmp/iris-d4-typecheck.log; /tmp/iris-d4-build.log |
| .agents/handoffs/phase5/integration.md:290 | HISTORICAL_ONLY | PROCESS_LOGS=/tmp/iris-d4-process-before.log; /tmp/iris-d4-process-during.log; /tmp/iris-d4-process-after.log |

### Retained changed-file crosswalk

Use these D5 locations in place of stale D4 line numbers. No category changes.

| File | D4 line | D5 line | Class |
|---|---:|---:|---|
| .agents/handoffs/phase5/integration.md | 8 | 8 | HISTORICAL_ONLY |
| .agents/handoffs/phase5/integration.md | 16 | 133 | HISTORICAL_ONLY |
| .agents/handoffs/phase5/integration.md | 54 | 171 | HISTORICAL_ONLY |
| .agents/handoffs/phase5/integration.md | 58 | 175 | HISTORICAL_ONLY |
| .agents/handoffs/phase5/integration.md | 187 | 304 | HISTORICAL_ONLY |
| .agents/handoffs/phase5/integration.md | 188 | 305 | HISTORICAL_ONLY |
| .agents/handoffs/phase5/integration.md | 189 | 306 | HISTORICAL_ONLY |
| .agents/handoffs/phase5/integration.md | 190 | 307 | HISTORICAL_ONLY |
| .agents/handoffs/phase5/integration.md | 297 | 419 | HISTORICAL_ONLY |
| .agents/handoffs/phase5/integration.md | 298 | 420 | HISTORICAL_ONLY |
| .agents/handoffs/phase5/integration.md | 300 | 422 | HISTORICAL_ONLY |
| .agents/handoffs/phase5/integration.md | 341 | 466 | HISTORICAL_ONLY |
| apps/runtime/src/archive-engine.ts | 18 | 18 | MAY_RETAIN |
| apps/runtime/src/archive-engine.ts | 282 | 326 | FALSE_POSITIVE |
| apps/runtime/src/archive-engine.ts | 285 | 329 | FALSE_POSITIVE |
| apps/runtime/src/archive-engine.ts | 325 | 369 | FALSE_POSITIVE |
| apps/runtime/src/opc-package.ts | 278 | 273 | FALSE_POSITIVE |
| apps/runtime/src/opc-package.ts | 279 | 274 | FALSE_POSITIVE |

## Search and semantic review

Case-insensitive added-line hits are zero for each required term: BBL, Bangkok Bank, RARW, NTB, ETB, RDJ, Grab, Ninja, Farmer, farmer-project, BBLConsumer. Current changed-file contents retain eight BBL matching lines and two RARW matching lines in historical receipts, and five NTB substring matches in commentBytes (FALSE_POSITIVE). Other required terms have zero current changed-file hits. Overlapping term hits are not summed as distinct references.

Supplemental inventory uses the prior AC-FARM, AgriScope, /Users/, /home/, iris_v2_bridge_proof literals and absolute/native/adversarial path patterns: /Users/, /home/, /Volumes/, /opt/, /usr/, /private/, /tmp/, /var/, .nofollow, drive-letter paths and server/UNC paths.

New P5-SOURCE-001 through P5-SOURCE-006 and the revised P5-AUTH-004 title describe capability/security behavior: MAY_RETAIN, not additions to the workload rename map. Reviewed phase5-integration.test.ts:110,187,230 and phase5-source-identity.test.ts:19,20,66,79,92. Their fixture values identity.vsdx, source.vsdx, source.zip, bounded.zip, output and iris-source-snapshot- are generic synthetic identifiers. visio/pages/page1.xml is format structure; the localhost MCP URL is a fake local request target. No new customer-specific E2E label, customer target, fixture name or workload comment was found.

Preserve ZIP/OPC/VSDX, macOS/Darwin, /.nofollow and ArchiveSourceSnapshot as neutral format/platform/security names. D5 binds authorized immutable source bytes through CapabilityService into archive/OPC/VSDX parsers, checks expected identity, uses detached buffer copies and bounded acquisition, and rejects mismatches before parsing or mutation. Genericization must preserve these invariants, policy-denial ordering and source-preservation tests, as well as D4 containment proofs. This audit does not claim new executable test results.

## Merged active implementation map

The following active map is inherited unchanged from the immutable authoritative audit. Its active source/doc files are not changed by D5. The exhaustive final location inventory is the prior 316-row inventory composed with the removal/addition and relocation tables above; do not rescan/reclassify its untouched rows. Historical location references elsewhere in the inherited plan are D4 evidence unless replaced by the crosswalk above.

## Responsible implementation owners and security dependencies

| Owner / location | Classification and implementation action |
|---|---|
| apps/runtime/src/permissions.ts:15 (uses at 51,90,96); daemon.ts:109 composition | EXTERNALIZE_TO_CONFIG: supply validated owner protected-reference roots using existing policy injection. Preserve current owner exclusion before removing baked-in path; invalid/missing migrated configuration fails closed. Never broaden authority silently. |
| apps/runtime/src/hermes-session-adapter.ts:6 and :57 | EXTERNALIZE_TO_CONFIG: use IRIS_HERMES_BIN/existing runner injection and validated toolset configuration. No arbitrary cwd/PATH binary fallback, no invented installed toolset; retain exact session binding and tool availability validation. |
| apps/runtime/src/v2-acceptance.ts:16 | EXTERNALIZE_TO_CONFIG: acceptance runner uses the same executable policy, not a second personal fallback. |
| scripts/permission-smoke.mjs:81 | EXTERNALIZE_TO_CONFIG: configure a dedicated protected test root through governed daemon composition, never probe a real legacy tree by default. |
| apps/runtime/src/permission-smoke.integration.test.ts:65,69 | MUST_GENERICIZE: inject test-owned protected root in daemon setup and coupled assertions. Preserve pre-inspection denial, resolved alias/symlink denial and no project registration. |
| apps/runtime/src/mission-bridge.test.ts:101,102 and constructor setup :95 | MUST_GENERICIZE: inject fixture-toolset and retain denial of the narrowed :project_git_status selector. |
| Runtime/web fixture owners in inventory | MUST_GENERICIZE: change values and expectations together; preserve two distinct projects and redaction tests. Real filesystem work uses owned mkdtemp roots, not synthetic display paths. |
| Acceptance matrix, implementation gates and Phase 5 acceptance doc | MUST_GENERICIZE: exact-ID/title/receipt crosswalk below; no scope, phase, security or case deletion. |
| Permission/security model prose | MUST_GENERICIZE: describe registered project and configured protected roots, not a developer username. Coordinate with protected-root migration first. |
| Historical handoff owners | HISTORICAL_ONLY: retain original receipts and locations; an optional append-only crosswalk requires owner approval. No shared integration-zone edits authorized here. |

The five externalized rows are counted literal occurrences, not five independent
services. Daemon composition, constructor sites and persistence migration are
implementation dependencies even where they do not themselves contain literals.
Settings migration must be explicit, owner-reviewed and reversible. Preserve
literal pre-inspection and physical resolved-target checks, server-derived
effects, CapabilityService authority, resource ownership and existing durable
mission/42-tool compatibility. This is not a search-and-replace security patch.

## Acceptance identifier crosswalk — refreshed, zero collisions

ACCEPTANCE_IDS_REQUIRING_RENAME=30
RENAME_COLLISIONS=0

All 30 current workload definitions in the canonical matrix match the previous
crosswalk. Thirty distinct destinations; no destination already occurs in any
tracked current source text, including underscore receipt spelling. Existing
AC-DOC/SEC/IRIS/COMPAT/CONN and P5-* identifiers remain unchanged.

| Old acceptance ID | New acceptance ID | Preserved meaning |
|---|---|---|
| AC-BBL-001 | AC-KNOW-101 | Bounded hidden-metadata vault inventory and symlink isolation |
| AC-BBL-002 | AC-ARTIFACT-101 | Streaming sparse-source metadata/hash reference |
| AC-BBL-003 | AC-ARCHIVE-101 | Read-only OPC/VSDX package inventory |
| AC-BBL-004 | AC-DOCUMENT-101 | Bounded structural XML provenance and source preservation |
| AC-BBL-005 | AC-ARCHIVE-102 | Extraction traversal/collision/link/device containment |
| AC-BBL-006 | AC-ARCHIVE-103 | Entry/size/aggregate/ratio bomb bounds |
| AC-BBL-007 | AC-MOBILE-101 | Explicit immutable device target required |
| AC-BBL-008 | AC-MOBILE-102 | No fallback to a second device |
| AC-BBL-009 | AC-MOBILE-103 | Serial-bound redacted logs and owned artifacts |
| AC-FARM-001 | AC-GIT-101 | Bounded baseline object validation |
| AC-FARM-002 | AC-GIT-102 | Merge-base and ancestry |
| AC-FARM-003 | AC-WORKSPACE-101 | Verified worktree registration |
| AC-FARM-004 | AC-WORKSPACE-102 | Preserve dirty primary owner work |
| AC-FARM-005 | AC-WORKSPACE-103 | Reject foreign repository/worktree identity |
| AC-FARM-006 | AC-GIT-103 | Configured remote fetch and server-derived effects |
| AC-FARM-007 | AC-GIT-104 | Safe feature-branch publish compatibility |
| AC-NINJA-001 | AC-ARTIFACT-102 | Large synthetic media metadata/hash without inline payload |
| AC-NINJA-002 | AC-MEDIA-101 | Governed media probe/profile contract |
| AC-NINJA-003 | AC-JOB-101 | Prompt durable background start |
| AC-NINJA-004 | AC-JOB-102 | Bounded redacted cursor logs |
| AC-NINJA-005 | AC-JOB-103 | Restart reattachment without duplicate spawn |
| AC-NINJA-006 | AC-JOB-104 | PID/start-marker identity fencing |
| AC-NINJA-007 | AC-ARTIFACT-103 | Produced media artifact ownership and provenance |
| AC-NINJA-008 | AC-EXEC-101 | Deterministic executable/PATH/environment profiles |
| AC-RDJ-001 | AC-FS-101 | Atomic append with size/hash precondition |
| AC-RDJ-002 | AC-FS-102 | Stale/concurrent append rejection |
| AC-RDJ-003 | AC-KNOW-102 | Bounded research/source inventory |
| AC-RDJ-004 | AC-KNOW-103 | Source-to-artifact provenance references |
| AC-RDJ-005 | AC-KNOW-104 | Cross-project source/artifact isolation |
| AC-RDJ-006 | AC-EXEC-102 | Governed script without package.json |

Expand compact ranges and slash shorthand into explicit new IDs, especially
AC-BBL-003 through AC-BBL-006 and AC-RDJ-004/005: new namespaces differ.
Update current underscore labels consistently. Historical IDs remain evidence
aliases, never rewritten proof. Do not rename runtime capability or persisted
mission/action IDs. Verify all 30 definitions and every active cross-reference.

Replace workload summary keys BBL_ACCEPTANCE_CASES, FARMER_ACCEPTANCE_CASES,
NINJA_ACCEPTANCE_CASES, RDJ_KNOWLEDGE_ACCEPTANCE_CASES and their summary groups
with recomputed capability-group totals; former groups split across namespaces.
Preserve total case count/classes/phases, not just four renamed headings.

| Active report/E2E label | Proposed label |
|---|---|
| BBL_SYNTHETIC_E2E | ARCHIVE_DOCUMENT_SYNTHETIC_E2E |
| BBL_SYNTHETIC_E2E_EVIDENCE | ARCHIVE_DOCUMENT_SYNTHETIC_E2E_EVIDENCE |
| BBL_VSDX_ACCEPTANCE | VSDX_PACKAGE_ACCEPTANCE |
| FARMER_WORKTREE_ACCEPTANCE | WORKTREE_ISOLATION_ACCEPTANCE |
| NINJA_DURABLE_MEDIA_JOB_ACCEPTANCE | DURABLE_JOB_ARTIFACT_ACCEPTANCE |

These label destinations and the ten concrete fixture destination strings below
are absent at BASE_SHA. The eleventh fixture rule is dynamically allocated
protected-root injection, not a global name to reserve. Acceptance, label and
fixture maps are one-to-one within their respective namespaces. Display-path
prefix overlap is intentional hierarchy, not collision: match exact values or
longest paths first. No filename rename is needed. Recheck after other workers
integrate; audit prose itself is not destination occupancy.

## TEST_RENAME_MAP

13 test titles require ID-only edits. Keep behavioral prose and assertions unless separately mapped fixture text changes. No test filenames require renaming; phase filenames are generic. The exact current titles and replacements are:

| Location | Current title | Proposed title |
|---|---|---|
| apps/runtime/src/phase2-foundation.test.ts:88 | AC-BBL-001 + AC-RDJ-003 recursively inventories a synthetic Obsidian vault with bounded pagination and never follows symlink escape | AC-KNOW-101 + AC-KNOW-102 recursively inventories a synthetic Obsidian vault with bounded pagination and never follows symlink escape |
| apps/runtime/src/phase2-foundation.test.ts:150 | AC-BBL-002 + AC-NINJA-001 stats/hashes a 256MiB sparse source by metadata/streaming and exposes only an artifact reference | AC-ARTIFACT-101 + AC-ARTIFACT-102 stats/hashes a 256MiB sparse source by metadata/streaming and exposes only an artifact reference |
| apps/runtime/src/phase2-foundation.test.ts:197 | AC-RDJ-001 + AC-RDJ-002 provides atomic APPEND with size/hash preconditions and zero partial bytes on stale conflicts | AC-FS-101 + AC-FS-102 provides atomic APPEND with size/hash preconditions and zero partial bytes on stale conflicts |
| apps/runtime/src/phase2-foundation.test.ts:322 | AC-SEC-008 + AC-RDJ-004 + AC-RDJ-005 binds artifacts to project/workspace identity and rejects cross-project/forged dereference | AC-SEC-008 + AC-KNOW-103 + AC-KNOW-104 binds artifacts to project/workspace identity and rejects cross-project/forged dereference |
| apps/runtime/src/phase3-shell-jobs.test.ts:27 | AC-SEC-009 + AC-RDJ-006 rejects unknown/raw/inline execution forms and still runs a physical script in a project without package.json | AC-SEC-009 + AC-EXEC-102 rejects unknown/raw/inline execution forms and still runs a physical script in a project without package.json |
| apps/runtime/src/phase3-shell-jobs.test.ts:110 | AC-NINJA-003 + AC-NINJA-004 + AC-NINJA-008 starts promptly, persists bounded cursor logs/artifact refs, and requestId is idempotent | AC-JOB-101 + AC-JOB-102 + AC-EXEC-101 starts promptly, persists bounded cursor logs/artifact refs, and requestId is idempotent |
| apps/runtime/src/phase3-shell-jobs.test.ts:157 | AC-NINJA-005 + AC-NINJA-006 reattaches across manager restart and duplicate requestId never duplicates target spawn | AC-JOB-103 + AC-JOB-104 reattaches across manager restart and duplicate requestId never duplicates target spawn |
| apps/runtime/src/phase4-git-worktree.test.ts:58 | AC-FARM-001 + AC-FARM-002 provides bounded object reads, merge-base, ancestry, refs/log/show and non-checkout branch creation | AC-GIT-101 + AC-GIT-102 provides bounded object reads, merge-base, ancestry, refs/log/show and non-checkout branch creation |
| apps/runtime/src/phase4-git-worktree.test.ts:139 | AC-FARM-003 + AC-FARM-004 + AC-SEC-007 authorizes only a verified linked WORKTREE and preserves dirty PRIMARY bytes/status exactly | AC-WORKSPACE-101 + AC-WORKSPACE-102 + AC-SEC-007 authorizes only a verified linked WORKTREE and preserves dirty PRIMARY bytes/status exactly |
| apps/runtime/src/phase4-git-worktree.test.ts:184 | AC-FARM-005 rejects a forged WORKTREE whose .git indirection changes to a foreign common-directory identity | AC-WORKSPACE-103 rejects a forged WORKTREE whose .git indirection changes to a foreign common-directory identity |
| apps/runtime/src/phase4-git-worktree.test.ts:265 | AC-FARM-006 derives NETWORK server-side, fetches configured remotes only, preserves working-tree state, and redacts credential-like failure diagnostics | AC-GIT-103 derives NETWORK server-side, fetches configured remotes only, preserves working-tree state, and redacts credential-like failure diagnostics |
| apps/runtime/src/phase4-git-worktree.test.ts:305 | AC-FARM-007 keeps safe push verified and preserves legacy git_local/remote_publish compatibility while protected/force/delete forms stay unavailable | AC-GIT-104 keeps safe push verified and preserves legacy git_local/remote_publish compatibility while protected/force/delete forms stay unavailable |
| apps/runtime/src/phase5-archive.test.ts:150 | AC-BBL-006 enforces each bomb bound before scratch mutation and preserves source bytes | AC-ARCHIVE-103 enforces each bomb bound before scratch mutation and preserves source bytes |

Tests containing only personal fixture paths do not need title renames, but their input/expected values must change together as follows. Do not rename legitimate Obsidian/VSDX product/format coverage merely to remove customer provenance.

## FIXTURE_RENAME_MAP

Eleven logical fixture identifiers/patterns require coordinated changes (not eleven files or assertions).

| Existing value / pattern | Proposed synthetic value / source | Locations |
|---|---|---|
| farmer-project | secondary-project | durable-mission-service.test.ts:52,56 |
| agriscope | repository-fixture | phase4-git-worktree.test.ts:341 |
| Phase4 AgriScope | Phase4 Repository Fixture | phase4-git-worktree.test.ts:357 |
| rdj-shell-ok | script-execution-ok | phase3-shell-jobs.test.ts:30,38 |
| ninja- + randomUUID() | job-request- + randomUUID() | phase3-shell-jobs.test.ts:118; preserve same request on retries |
| /Users/bill/iris | /Users/example/project-a for inert display fixtures | agent-executor.test.ts; agent-interaction.test.tsx; mission-control-v21.test.tsx; workspace-session.test.tsx |
| /Users/bill/sandbox | /Users/example/project-b for inert display fixtures | agent-interaction.test.tsx; workspace-session.test.tsx |
| /Users/bill/iris/fixture/very-long-target.txt | /Users/example/project-a/fixture/very-long-target.txt | approval-ui.test.tsx:17,20; preserve long-action wrapping test |
| /Users/bill/iris-v2-bridge-integration-proof | /Users/example/project-a-worktree | workspace-session.test.tsx:263 |
| /Users/bill/iris-native-runtime | test-owned protected-reference root injected into policy | permission-smoke.integration.test.ts:65,69; scripts/permission-smoke.mjs:81 |
| iris_v2_bridge_proof toolset expectation | explicitly injected fixture-toolset; keep denied :project_git_status suffix assertion | mission-bridge.test.ts:101,102; adapter constructor fixture setup |

For real filesystem activity use owned mkdtemp roots, not /Users/example. For display-only strings synthetic absolute paths are appropriate. Match exact values or longest paths first, update redaction assertions with inputs, and retain sibling-project distinction, read-only-root denials, request idempotency, source hashes and source/scratch containment. No committed customer-named binary fixture or workload-named test filename was found. Existing archive/document fixtures are generated; keep that design.


## DOCUMENT_RENAME_MAP

Five active documents require content/label changes, not filename changes:

| Document | Proposed content change |
|---|---|
| docs/architecture/VNEXT_ACCEPTANCE_MATRIX.md | Capability headings, all 30 mapped IDs, compact references, derived counts and generic synthetic-data boundary instead of workload identity |
| docs/architecture/VNEXT_IMPLEMENTATION_GATES.md | Exact semantic IDs and expanded lists; preserve all phase prerequisites |
| docs/architecture/VNEXT_PHASE5_ARCHIVE_DOCUMENT_ACCEPTANCE.md | Replace BBL-specific fixture exclusion with no customer/proprietary/production files; retain generated-owned fixture requirement |
| docs/architecture/PERMISSION_MODEL.md | Registered/authorized project root and owner-configured protected reference roots, without canonical personal paths; align only after security migration |
| docs/architecture/SECURITY_MODEL.md | Describe generic protected-root semantics while retaining validation and literal/resolved denial guarantees |

Historical ADR 0006's no-BBL-access exclusion can optionally become no-external-customer-system-access wording in a superseding note. README and project-memory paths can be retained as historical context or moved to local setup notes; no false claim that historic runs used synthetic locations. Phase 5 handoffs retain original evidence labels and checkout paths unless owners approve an append-only crosswalk/redaction policy. Do not update shared integration-zone files in this mission or infer approval for doing so later.



## D5 collision proof

Checked all 190 tracked D5 files for exact destination occupancy only, not for reclassification of unchanged content. All 30 acceptance targets are unique; none occurs in either hyphen or underscore spelling. All inherited fixture and E2E-label destinations are unoccupied. RENAME_COLLISIONS=0. Recheck against the actual owner-approved integration HEAD before implementation; this proof is scoped to D5, not future merged branches.

## External/local ADO boundary

ADO customer organization/project/team/board names and IDs, customer work-item IDs, target URLs, identity GUIDs and credentials must remain in validated external/local owner configuration and protected evidence, never generic IRIS core defaults, fixture names or examples. Missing or ambiguous target scope fails closed. Real-shape samples require synthetic IDs with consistent graph/link remapping, removed identity/auth metadata and customer content, and no reverse mapping in core. D5 introduces no new target requiring externalization. This is not an audit of independently unmerged ADO worker modules.

## Implementation and validation handoff

Owner approval remains required before implementing the inherited map. Externalize protected-root and Hermes deployment inputs through their existing responsible boundaries with explicit reversible migration and fail-closed validation; genericize coupled fixtures, 13 test titles, 30 IDs and five architecture documents without weakening tests or rewriting historical execution claims. Retain the inherited 11 logical fixture rules. Integration owners must separately approve shared-zone changes and rescan newly merged ADO assets.

Future proof: focused policy/bridge/renamed-fixture/UI tests plus D4 containment and D5 source-identity/authorization tests, then appropriate lint/typecheck/build and owner-scheduled broad regression. No test/build execution is needed or claimed for this Markdown-only audit. Static assertions validate inventory arithmetic, category preservation, unique rename targets and zero destination occupancy; whitespace and exact staged-path checks gate the commit. Final commit SHA is reported externally to avoid a self-referential hash.

MISSION_RESULT=AUDIT_COMPLETE
D4_D5_DELTA_FILES=8
NEW_REFERENCES=4
REMOVED_OR_REPLACED_REFERENCES=2
NEW_MUST_GENERICIZE=0
NEW_EXTERNALIZE_TO_CONFIG=0
NEW_HISTORICAL_ONLY=4
PREVIOUS_PLAN_RECONCILED=YES
TOTAL_CURRENT_REFERENCES=318
FILES_AFFECTED=70
FINAL_MUST_GENERICIZE=123
FINAL_EXTERNALIZE_TO_CONFIG=5
FINAL_ACCEPTANCE_IDS_REQUIRING_RENAME=30
RENAME_COLLISIONS=0
GENERICIZATION_IMPLEMENTATION_PLAN_READY=YES
PRODUCTION_SOURCE_CHANGED=NO
TESTS_CHANGED=NO
MASTER_STATUS_CHANGED=NO
HANDOFF_READY=YES
PUSHED=NO
BLOCKERS=NONE_FOR_AUDIT; implementation requires owner approval.
NEXT_STEP=GENERICIZATION_IMPLEMENTATION_AFTER_OWNER_APPROVAL
