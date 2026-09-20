# 0007 — Native bounded code-review capability

## Status

Accepted for implementation on 2026-09-20 by the project owner.

## Context

IRIS can already build exact review context from governed Git, workspace, artifact,
mission, and validation capabilities, but the live runtime cannot execute the
repository-local `.codex/agents/code_review.toml` reviewer. The existing
`WorkerAdapterRegistry` is mission-wide and is therefore the wrong abstraction
for a terminal LOCAL_NATIVE review action.

A reviewer must be read-only, exact-workspace scoped, fail closed on malformed
output, and must not gain generic mutation authority.

## Decision

Add one native FULL-only grouped MCP tool, `code_review`, backed by dedicated
governed capabilities and the existing `DurableJobManager`.

The review process is a bounded four-step flow:

1. `code_review.prepare` records a new `code_review.start` mission action
   without widening the legacy `mission_action_prepare` MCP schema.
2. `code_review.start` requires that prepared mission action, an ACTIVE PRIMARY
   or WORKTREE workspace, and a project-bound `local-native-review-context`
   artifact.
3. IRIS launches a server-owned review runner through a dedicated execution
   profile. Callers cannot supply executable paths, argv, environment, model,
   sandbox, or arbitrary prompt text.
4. The runner reads only the repository-local
   `.codex/agents/code_review.toml` profile and an IRIS-generated launch spec
   containing the exact reviewed context identity.
5. The runner creates an ephemeral `CODEX_HOME` with a generated named
   permission profile. The profile sets filesystem `:root = "deny"`,
   `:minimal = "read"`, and `:workspace_roots "." = "read"`, disables
   command-level network access, and uses approval policy `never`.
6. IRIS initializes Codex App Server with the experimental permission-profile
   capability, starts the thread with `permissions = "iris-review"` and the
   exact runtime workspace root, verifies the returned active profile and
   effective `readOnly` sandbox, then lets the turn inherit those permissions.
   Caller/project Codex config is not inherited.
7. For a linked Git worktree, the only extra readable path is the
   repository `commonGitDir` already verified and stored by IRIS; callers
   cannot supply additional readable roots.
8. The reviewer returns a bounded structured report. `code_review.status` may
   report only that valid terminal output is ready; it never exposes an approval
   receipt.
9. `code_review.result` is the sole operation that derives and returns either
   `REVIEW_DECISION: APPROVED` or
   `REVIEW_DECISION: CHANGES_REQUIRED`, while idempotently attaching the
   decision/report evidence to the original mission action.
10. Missing/malformed output, a failed job, an invalid reviewer profile,
   permission-profile widening, or ambiguous process ownership never produces
   approval. Launch success alone is never review approval.

## Authority boundary

- Reviewer target workspace is read-only.
- Review context may come from an IRIS SCRATCH artifact. Before launch IRIS
  revalidates its raw artifact hash, normalizes the exact text sent to the
  reviewer, hashes that reviewed text separately, and writes a server-generated
  launch spec. The scratch artifact path is never added to the reviewer's
  readable roots.
- The runner may use local Codex authentication, copied into an ephemeral
  `CODEX_HOME`; it never exposes authentication bytes to the model or job logs.
- No reviewer action may stage, commit, push, mutate files, approve security, or
  authorize deployment.
- PRO catalog remains the exact read-only five tools.

## Consequences

This adds a FULL catalog surface and therefore bumps the current catalog to
2.5.0 while preserving the exact legacy 2.3 schemas and the 2.3/2.4 compatibility
identities. Feature workflows can now
obtain a real Ponytail LOCAL_NATIVE terminal receipt without depending on another
machine connector.


## Review hardening after independent Ponytail finding set

The first real pre-activation Ponytail review returned `CHANGES_REQUIRED` and identified five blocking trust-boundary defects. The candidate was not committed or activated. This decision record is amended to make the corrections part of the native review contract:

1. **Private launch input.** The normalized review context is copied into a server-private `iris-code-review-input-*` directory, never a project SCRATCH workspace or project artifact. The durable request fingerprint binds the complete review identity contract.
2. **Private canonical result.** The reviewer writes its structured terminal payload only to `vnext-job-runtime/<jobId>/review-output.json`. Project-visible stdout/stderr are diagnostics only and never determine review approval.
3. **Trusted result binding.** The outer durable runner validates the canonical output as a bounded physical file and binds its SHA-256 and exact byte count into the private runner result together with `jobId` and `runnerIdentity`. `code_review.result` re-reads and verifies those bytes before parsing.
4. **Expected identity binding.** The job record durably retains the original context artifact ID/raw hash, normalized context hash, workspace hash, reviewer-profile hash, and verified repository common-Git identity/hash. Every identity returned by the reviewer must match before a receipt can be exposed or recorded.
5. **Result-only finalization.** `code_review.status` reconciles lifecycle/cleanup and reports only whether a terminal payload is ready; it never returns a decision. Only `code_review.result` may validate identities, append one idempotent mission receipt, return the terminal receipt, and mark the review finalized.
6. **Guaranteed private credential cleanup.** Codex authentication is resolved only from an explicit server-configured `IRIS_CODEX_AUTH_FILE` or the operating-system account home returned by `userInfo().homedir`; it never follows the target workspace `HOME`. The auth source must be a private physical owner file. The outer durable runner owns cleanup of the private launch directory and ephemeral Codex home and performs it before publishing terminal result state. DurableJobManager repeats cleanup defensively on bootstrap/claim/lost/duplicate paths. Cleanup failure makes the review fail closed.
7. **No live/unfinalized eviction.** Durable capacity never evicts running jobs or terminal code-review jobs whose receipt has not been finalized. Capacity is refused instead.
8. **Generic job isolation.** Generic job status/log/result/compatibility/cancel surfaces all reject `codex-review` job IDs. Only the `code_review` surface can observe/finalize them.
9. **Unambiguous JSON only.** Both model-report and terminal/launch JSON decoding reject duplicate object keys before normal parsing and shape validation, including nested duplicate fields.
10. **Adversarial evidence.** Focused tests must prove forged project-visible logs/context cannot alter a decision, canonical private-result tampering fails, bootstrap/restart/duplicate/timeout cleanup removes private credentials, capacity refuses rather than evicting live reviews, and duplicate-key payloads fail closed.

These constraints are part of the approval boundary. Regressing any of them requires `CHANGES_REQUIRED`, regardless of ordinary test-suite health.
