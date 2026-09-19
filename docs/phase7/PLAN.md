# IRIS Phase 7 — Browser and GitHub Connector Plan

Status: READY_FOR_SAVE_POINT
Baseline: `98ddb023f36c46c0a4d00f2443951419da8ceb31`
Branch: `codex/phase7-browser-github-impl`
No live external write is authorized by this plan.

## Goal

Add bounded Browser and GitHub connector contracts on top of Phase 6 without introducing an
arbitrary network/browser escape hatch. Read paths come first. Any external mutation remains
owner-gated and exact-action-bound.

## NEXT checklist

### NEXT-1 — Baseline and isolated workspace

Status: COMPLETE

- verify Phase 5.5 and Phase 6 PR/merge ancestry before implementation;
- rebase/recreate implementation worktree from the merged main save point if necessary;
- confirm runtime/catalog identity before any live connector activation;
- keep PRIMARY and current live Phase 6 worktree untouched.

Exit: baseline SHA, project/workspace/repository identity and clean isolated worktree proven.

### NEXT-2 — Browser navigation and download contract

Status: COMPLETE

Define a typed browser surface only:

- bounded GET/HEAD navigation;
- explicit URL identity and normalized origin;
- HTTPS policy with explicit localhost exception only where already governed;
- redirect count + redirect target revalidation;
- SSRF denial for loopback/private/link-local/metadata/internal network targets unless explicitly allowlisted;
- DNS rebinding resistance / resolved-address recheck;
- bounded response bytes, content types, decompression ratio and timeouts;
- downloads become restricted artifacts rather than caller-selected filesystem paths;
- no arbitrary JavaScript execution, shell bridge, extension install, credential extraction or file:// authority.

Exit: contract tests cover happy path + SSRF/redirect/content-size/decompression/cancellation negatives.

### NEXT-3 — GitHub repository / Pull Request connector contract

Status: COMPLETE

Typed GitHub operations:

Read:
- repository metadata;
- branch/ref/commit identity;
- Pull Request metadata/status/checks;
- bounded file/diff review surfaces.

Write, owner-gated:
- create Pull Request from exact base/head;
- update PR title/body only for exact PR identity;
- optionally comment on an exact PR;
- no merge/delete-branch/repository-settings/secrets/admin mutation in initial scope.

Every write must bind:
`owner/repo + base ref/SHA + head ref/SHA + operation + exact payload digest`.

Exit: stale head/base, cross-repo substitution, replay and changed payload fail closed.

### NEXT-4 — Browser/GitHub security acceptance

Status: COMPLETE

Must prove:

- no arbitrary URL escape;
- SSRF and hostile redirects fail closed;
- credentials never enter logs/artifacts/error strings;
- browser cookies/session data are scoped and non-exportable;
- GitHub token scope is minimum required;
- repo identity is exact, not name-only;
- writes require owner approval and ALLOW_ONCE by default;
- approval replay/cross-session/cross-repo substitution is rejected;
- downloaded/uploaded content is size/hash bound;
- no generic HTTP or generic GraphQL/REST passthrough is exposed.

Exit: `PHASE_7_SECURITY_ACCEPTANCE=PASS`.

### NEXT-5 — External platform integration

Status: COMPLETE

Compose connectors with existing IRIS primitives:

- workspace/project identity;
- durable jobs;
- artifact registry;
- output redaction;
- mission/action identity;
- owner approval continuation;
- audit receipts.

Do not register a live connector until contract + security + full regression are green.

Exit: integration tests + root lint/typecheck/build pass.

### NEXT-6 — Synthetic Browser → GitHub E2E

Status: COMPLETE

Synthetic flow:

`bounded URL read → restricted artifact/provenance → exact repo/ref validation → PR create intent → owner approval → synthetic GitHub result receipt`

Negative E2E:
- redirect to private address;
- source content changed;
- base/head SHA changed;
- repo substitution;
- stale approval;
- duplicate/replayed PR create;
- credential leakage check.

Exit: deterministic E2E receipt with no external production write.

### NEXT-7 — Final Phase 7 acceptance / save point

Status: READY_FOR_SAVE_POINT

- canonical lint/typecheck/build/test;
- serial proof for known process-sensitive runtime tests if required;
- live runtime/catalog preservation check;
- dirty/untracked audit;
- final acceptance receipt;
- save-point commit;
- only then consider controlled connector activation.

Exit: `PHASE_7=COMPLETED`.

## Parallelization

After NEXT-1:
- NEXT-2 Browser contract and NEXT-3 GitHub contract can run in parallel research/implementation lanes.
- NEXT-4 waits for both contracts.
- NEXT-5 consumes only reviewed handoffs.
- NEXT-6 waits for integration.
- NEXT-7 is serial final acceptance.

## Non-goals

- arbitrary browser automation;
- arbitrary HTTP client;
- arbitrary GitHub REST/GraphQL proxy;
- GitHub merge/admin/settings/secrets;
- background autonomous browsing;
- persistent always-allow for GitHub writes;
- live external write before explicit owner approval.
