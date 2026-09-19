# IRIS Phase 7 — Implementation Status

Updated: 2026-09-19
Branch: `codex/phase7-browser-github-impl`
Baseline: `98ddb023f36c46c0a4d00f2443951419da8ceb31`
Workspace: `/Users/bill/iris-phase7-browser-github-impl`

No live Browser or GitHub connector is registered by this implementation slice, and no production external mutation has been executed.

## NEXT-1 — Baseline and isolated workspace

- Phase 5.5 commit `3ad92844375817c3603a54cb79fe32197852e00e` is in `origin/main`.
- Phase 6 commit `7fe46d9f5b4ebf2021bc01751ba1811bf6aad330` is in `origin/main`.
- Merged main baseline is `98ddb023f36c46c0a4d00f2443951419da8ceb31`.
- The Phase 7 implementation uses an isolated verified WORKTREE.
- PRIMARY and existing Phase 6 worktrees were not modified.
- Runtime/catalog identity remained COHERENT during baseline verification.

Status: IMPLEMENTATION BASELINE COMPLETE.

## NEXT-2 — Browser contract

Implemented a contract-only Browser boundary:

- GET/HEAD only;
- exact allowlisted origins;
- HTTPS by default;
- explicit governed localhost HTTP exception only;
- manual redirect mode with every target revalidated;
- URL userinfo denied;
- public and loopback resolution policies are separate;
- DNS answers are bound and revalidated;
- the actual connected address must belong to the validated answer set;
- private, loopback, link-local, multicast, documentation and other special-use addresses fail closed for public targets;
- IPv4-compatible, IPv4-mapped, NAT64, Teredo and 6to4 forms are denied to prevent address-family bypass;
- alternate numeric IPv4 URL forms are canonicalized and denied when they resolve to special-use space;
- special-use block lists preserve IANA globally reachable exceptions instead of blanket-blocking `192.0.0.0/24` or `2001::/23`;
- bounded streaming transport/decoded byte budgets;
- bounded decompression ratio, content type and timeout;
- cancellation;
- download evidence becomes an artifact intent rather than a caller-selected filesystem path;
- raw source URL is not exported to artifact/audit-shaped metadata;
- explicit DOM/native adapter-transition audit;
- adapter transition cannot widen session, project, connector binding, or upload artifact scope.

IANA registry review specifically preserves globally reachable exceptions such as IPv4 PCP/TURN anycast and the globally reachable IETF IPv6 more-specific allocations while retaining denial of non-global and translation/tunnel ranges.

Status: COMPLETE. Focused canonical Phase 7 Vitest passed 58/58 and the same Browser contract tests passed in the full runtime suite.

## NEXT-3 — GitHub connector contract

Read surface:

- repository metadata;
- branch/ref identity;
- commit identity;
- PR metadata;
- PR checks/statuses;
- bounded PR diff/file review surfaces.

Owner-gated write-intent surface:

- create PR;
- update exact PR title/body;
- comment on an exact PR.

Not exposed:

- merge;
- delete branch;
- repository settings/admin/secrets;
- generic REST;
- generic GraphQL.

Every mutation intent binds:

- project ID;
- connector binding ID;
- exact repository ID + owner/name;
- base ref/SHA;
- head ref/SHA;
- operation;
- exact PR number when applicable;
- exact payload SHA-256 digest.

Authority hardening:

- irrelevant/extraneous fields are rejected rather than ignored;
- stale base/head fails closed;
- repository substitution fails closed;
- changed payload changes intent identity;
- changed project/binding changes intent identity;
- approval is ALLOW_ONCE, session-bound, expiring and replay-protected;
- duplicate/replayed mutation intent is rejected by synthetic acceptance ledger;
- token scopes are an exact-minimum union for the declared operations: under-scoped and over-scoped grants both fail closed;
- permission levels are normalized so `pull_requests:write` satisfies and supersedes `pull_requests:read`; redundant read+write entries are rejected as over-scoped;
- PR checks require Pull requests access plus Checks read + Commit statuses read;
- GitHub mutations require Pull requests write; IRIS additionally requires Contents read to revalidate exact base/head identity before mutation.

Status: COMPLETE. Focused canonical Phase 7 Vitest passed 58/58 and GitHub connector tests passed in the full runtime suite.

## NEXT-4 — Security acceptance

Security specs cover:

- arbitrary URL escape;
- hostile redirect;
- private/metadata destination;
- DNS rebinding;
- connected-address substitution;
- alternate IPv4 notation;
- IPv4/IPv6 special-use classification;
- signed/query URL metadata leakage;
- browser cookie/session/header authority non-export;
- streaming byte/decompression/time bounds;
- explicit DOM/native transition audit and scope preservation;
- exact GitHub repository identity;
- exact-minimum token scope;
- exact payload/ref/project/binding approval identity;
- ALLOW_ONCE cross-session/stale/replay rejection;
- generic HTTP/REST/GraphQL/admin escape absence;
- bounded error values without credential echo.

A production-source scan found no direct raw `fetch`, Node HTTP/HTTPS authority, child-process authority, dynamic code execution, generic GraphQL or merge implementation in the Phase 7 Browser/GitHub contract files.

Status: `PHASE_7_SECURITY_ACCEPTANCE=PASS`. The Phase 7 security acceptance suite passed focused canonical Vitest and passed again inside the full runtime suite.

## NEXT-5 — External integration

Browser chain:

`mission -> task -> action -> durable job -> bounded Browser request -> restricted artifact intent`

`BrowserReadActionPlan` binds mission/task/action/job/project/binding/request identity and records only source origin + SHA-256 of the exact normalized request URL. The raw URL remains transport-local and is not stored in audit/artifact-shaped metadata.

Browser artifact intent:

- exact action/request parity is mandatory;
- project/workspace/job/action identity;
- content type, size and SHA-256;
- source byte recheck;
- RESTRICTED sensitivity;
- EPHEMERAL retention;
- REVIEW_REQUIRED export state.

GitHub chain:

`mission -> task -> action -> ALLOW_ONCE approval -> exact mutation intent -> provider result -> audit receipt`

The receipt revalidates repository/base/head identity and retains only bounded IDs/digests/results.

Status: COMPLETE. Integration tests passed focused canonical Vitest and passed again inside the full runtime suite. No live connector activation.

## NEXT-6 — Synthetic Browser -> GitHub E2E

Positive synthetic flow:

`bounded URL -> DNS policy -> connected-address pin -> response budget -> Browser action/job -> restricted artifact -> exact repo/ref -> PR create intent -> ALLOW_ONCE -> synthetic provider result -> audit receipt`

Negative coverage includes:

- redirect/private-address escape;
- changed source bytes;
- action from a different Browser request;
- moved base/head SHA;
- repository substitution;
- project/binding substitution;
- stale/cross-session approval;
- duplicate/replayed PR creation;
- credential and signed-URL leakage checks.

No production GitHub write is part of the E2E.

Status: COMPLETE. Synthetic Browser -> GitHub E2E passed focused canonical Vitest and passed again inside the full runtime suite; no production write was executed.

## Media gate

Phase 7 architecture also requires media acceptance.

Media work composes only existing primitives:

- `artifact.open_ref`;
- governed `shell.run` / `shell.start`;
- existing `ffprobe` / `ffmpeg` profiles;
- `job.status` / `job.logs` / `job.result`;
- `artifact.register_existing`.

No media-specific execution or permission authority was introduced.

Media artifact registration binds project/workspace/job/action + type/MIME/size/SHA-256, validates the resulting ArtifactRecord before returning a safe ArtifactReference, never exports the physical path, and rejects zero-byte outputs.

Real local proof:

- ffmpeg generated a synthetic 16x16 MP4;
- ffprobe returned duration `0.200000` and size `965`;
- fixture was deleted after validation.

AC-NINJA-002 local proof: PASS.
AC-MEDIA-001 / AC-NINJA-007: PASS in focused canonical Vitest and in the full runtime suite.

## Local deterministic evidence

Current or compatible local proof runs completed successfully:

- `PHASE7_CONTRACT_SMOKE=PASS`
- `PHASE7_SYNTHETIC_E2E_SMOKE=PASS`
- `PHASE7_BROWSER_MEDIA_SMOKE=PASS`
- `PHASE7_GITHUB_HARDENING_SMOKE=PASS`
- `PHASE7_SCOPE_BINDING_HARDENING_SMOKE=PASS`
- `PHASE7_POST_HARDENING_SMOKE=PASS`
- `PHASE7_BROWSER_STREAM_PINNING_SMOKE=PASS`
- `PHASE7_GITHUB_CHECKS_SCOPE_SMOKE=PASS`
- `PHASE7_GITHUB_PERMISSION_LEVEL_SMOKE=PASS`
- `PHASE7_BROWSER_IDENTITY_CHAIN_SMOKE=PASS`
- `PHASE7_IPV6_SPECIAL_USE_SMOKE=PASS`
- `PHASE7_IPV4_SPECIAL_USE_SMOKE=PASS`
- `PHASE7_MEDIA_IPV6_EDGE_SMOKE=PASS`
- `PHASE7_NUMERIC_IPV4_SSRF_SMOKE=PASS`
- `PHASE7_SOURCE_CHECK_FINAL=PASS files=12`
- `PHASE7_FINAL_LOCAL_SMOKE=PASS`

Temporary smoke scripts/mirrors and the synthetic media fixture were removed after use.

## NEXT-7 — Final acceptance / save point

Canonical validation now completed:

- focused Phase 7 Vitest: 8 files, 58/58 tests PASS;
- root typecheck: PASS;
- root lint: PASS;
- root build: PASS;
- mobile contract pre-suite inside full test: 48/48 PASS;
- shared package tests inside full test: 2/2 PASS;
- web tests inside full test: 21/21 PASS;
- runtime full parallel suite: 367/368 PASS, with one process-sensitive Phase 3 durable-job timing case observing SUCCEEDED instead of LOST after the 900ms child had already exited under parallel load;
- required serial proof for that known process-sensitive Phase 3 file: 8/8 PASS, including the exact failing PID/start-identity case.

Regression disposition:

`FULL_REGRESSION=PASS_WITH_SERIAL_PROCESS_SENSITIVE_PROOF`

No Phase 7 test failed in the full suite. The only parallel failure was outside Phase 7 and reproduced as PASS under the serial proof explicitly allowed by the Phase 7 plan for process-sensitive runtime tests.

The earlier dependency blocker is resolved: the isolated worktree was hydrated with the lockfile-frozen dependency set before canonical validation.

Owner/lifecycle continuation now proven:

- owner-local Bill session: `defbc966-d221-48ec-8f4b-9e2530b374b1`;
- stable mission ID preserved: `fb8636e5-6876-4dc8-bbbb-b1f8cd288880`;
- binding revision advanced atomically from 1 to 2;
- rebind audit records principal `owner`;
- no replacement mission was created;
- mission state is RUNNING;
- NEXT-1 through NEXT-6 are reconciled as COMPLETED;
- NEXT-7 is RUNNING for the save-point step.

Final audit status:

- runtime/catalog remain READY + COHERENT;
- PRIMARY and Phase 6 tracked work remain untouched;
- implementation HEAD remains descended from baseline `98ddb023f36c46c0a4d00f2443951419da8ceb31`;
- exactly 14 reviewed Phase 7 source/document paths are staged;
- generated `.cache/` and `Library/` content remains untracked and excluded from staging.

Status: READY_FOR_SAVE_POINT.

Remaining after this document state:
- implementation commit;
- final receipt commit;
- mark NEXT-7 and the existing mission COMPLETED;
- push/PR decision;
- controlled connector activation remains a separate explicit decision.
