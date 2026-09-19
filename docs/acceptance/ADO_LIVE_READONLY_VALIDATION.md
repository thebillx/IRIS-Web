# ADO live read-only validation plan

Date: 2026-09-19

This plan is the live counterpart to the local M8 acceptance suite. It does not
grant network authority or credentials. Execute it only after an owner-authorized
Azure DevOps binding exists.

## Provider facts rechecked against Microsoft Learn

- Azure DevOps Work Item Tracking REST remains documented at API version 7.1.
- WIQL Query By WIQL is a POST request but is a read/query operation. The MVP
  capability must therefore derive READ + NETWORK from the named operation and
  must not treat POST as generic write authority.
- Work Items Batch is POST and supports at most 200 IDs per request.
- Single Work Item GET supports `$expand`, including Relations.
- Work Item comments use a pageable GET endpoint with `continuationToken`;
  Microsoft currently documents the comments endpoint as `7.1-preview.4`.
- Backlog level configuration exposes provider-defined `type`
  (portfolio / requirement / task) and `workItemTypes`; these values remain the
  authority for generic process mapping instead of hardcoded Epic/Feature/PBI names.
- The least-privilege Work Item Tracking read scope is `vso.work`.
  `vso.work_write` is not required for this MVP read path and must not be
  requested by the read-only binding.

Provider references:
- Microsoft Learn — WIQL: Query By WIQL (Azure DevOps REST 7.1)
- Microsoft Learn — Work Items: Get Work Items Batch (Azure DevOps REST 7.1)
- Microsoft Learn — Work Items: Get Work Item / List (Azure DevOps REST 7.1)
- Microsoft Learn — Comments: Get Comments (Azure DevOps REST 7.1-preview.4)
- Microsoft Learn — Work: Backlogs / BacklogLevelConfiguration (Azure DevOps REST 7.1)

## Allowed live operation ledger

The live adapter must expose only the named semantic operations already modeled by
the IRIS ADO contract:

1. board read
2. team scope / area-path read
3. backlog-level list/read
4. WIQL query
5. single Work Item GET
6. Work Items Batch GET-by-IDs semantic read (provider POST)
7. comments list
8. relation/link list

Every request receipt must include a sanitized operation category, target-bound
project/board identity, response outcome and bounded counts. Do not store headers,
tokens, cookies, raw auth errors or credential identifiers in acceptance artifacts.

Explicitly forbidden in the M8 live run:

- Work Item create/update/delete
- query create/update/delete
- add/update/delete comment
- board mutation
- arbitrary HTTP URL/method escape hatch
- redirects to unbound hosts/projects
- `vso.work_write` acquisition for this read path

## Live progression

### Level 1 — single Work Item

- Read one owner-approved Work Item.
- Fetch requested canonical fields, relations and all comment pages.
- Compare the Work Item revision before/after.
- Retain the IRIS request ledger proving zero mutation attempts.
- Run normalization, redaction, gate, persistence and a local Wiki projection.
- No ADO write-back.

### Level 2 — one Feature/subtree

- Resolve an owner-approved subtree.
- Exhaust descendants without inventing missing parents.
- Reconcile unique IDs and relation targets.
- Run complete M3–M7 processing and confirm review/history isolation.

### Level 3 — one discovered backlog level

- Discover the level from provider metadata; do not hardcode its WIT name.
- Exhaust all membership pages.
- Fetch in batches <= 200.
- Verify discovered == fetched == classified and no failed IDs.

### Level 4 — full authorized Board

- Discover all visible backlog levels.
- Exhaust all pages and unique Board membership.
- Recheck revisions/comments/relations/links needed for completeness.
- Run Full Sync audit and M7 projection.
- Capture zero-write ledger and unchanged source revisions.

## Executable owner-only runner

The repository includes an owner-invoked live runner that accepts the credential
from stdin only. It never accepts a token in argv, never stores the credential,
constructs every Azure DevOps URL itself, follows no redirects, and records only
GET requests in the zero-mutation ledger.

Example shape (replace placeholders locally; do not paste credentials into chat):

```sh
read -s ADO_PAT
printf '%s' "$ADO_PAT" | pnpm --filter @iris/runtime ado:live-acceptance -- \
  --token-stdin \
  --organization <organization> \
  --project <project> \
  --board "<exact-board-name>" \
  --level1-work-item <work-item-id> \
  --story-work-item <story-id>
unset ADO_PAT
```

Use a temporary Work Items **Read** credential for acceptance only. Production
automation should use the separately governed Microsoft Entra identity path.
The runner writes its sanitized snapshot and receipt only under the private IRIS
runtime data root.

## Release gate

C7 can move from LOCAL_PASS / LIVE_PENDING to COMPLETED only when Levels 1–4 have
separately authorized evidence and the zero-mutation ledger is retained. Until
then, C8 protected-main handoff remains blocked even though local production-module
acceptance passes.
