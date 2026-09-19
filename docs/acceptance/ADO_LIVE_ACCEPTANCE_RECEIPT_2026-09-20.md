# ADO live acceptance receipt — 2026-09-20

Execution environment: owner-run RARW host behind the required corporate VPN.
Transport: bounded GET-only acceptance probe.
Credential handling: hidden local prompt; credential not stored in repo, receipt or snapshot.

## Target

- Organization: `BBLConsumer`
- Project: `ncbd`
- Team: `Board OPO Build`
- Epic board/backlog: `Epics`
- Requirement backlog: `Stories`
- Level 1 Epic: Work Item `15126`
- Historical preferred Story reference: Work Item `94747`
- Historical Story membership result: outside the authorized Team backlog membership
- Derived Level 2 Feature root: Work Item `14288`

The Story reference was not forced into scope. Level 2 was derived from the
authorized Epic hierarchy and constrained to Team backlog membership.

## Live results

- Target digest: `b406814ba1dec62cecc03d79b4fb03e01149fe48d76540ca11440829fdd35039`
- Level 1: PASS — Epic `15126`, revision 21, 0 comments
- Level 2: PASS — Feature root `14288`, authorized subtree size 2
- Level 3: PASS — `Stories` / `Microsoft.RequirementCategory`, 748 items
- Level 4: PASS — 1,221 unique Work Items
- Comments captured: 1,331
- Relations captured: 6,067
- HTTP requests recorded: 589
- Request methods observed: GET only
- Zero mutation: PASS
- Revision stability recheck: PASS
- Area Path mismatch count: 0

Visible backlog membership observed during the run:

- Initiative: 0
- Epics: 19
- Features: 141
- Stories: 748
- Tasks: 313
- Unique total after de-duplication: 1,221

## Private evidence

The owner-run probe created a private sanitized snapshot and receipt under the
RARW project-local ignored acceptance directory. The receipt was read back through
IRIS-C and matched the terminal output above. The private snapshot is intentionally
not committed to the repository.

This receipt is sufficient for the C7 transport/live-read acceptance gate because
the semantic M5–M7 production-module path is independently exercised by the local
converged acceptance suites. Live Work Item content is not copied into repository
documentation merely to prove transport correctness.
