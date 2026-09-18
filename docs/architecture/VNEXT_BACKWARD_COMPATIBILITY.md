# IRIS vNext backward compatibility contract

Status: Phase 0 contract. Current catalog baseline: 42 FULL tools, catalog version 2.3.0.

## Compatibility rules

1. No current tool is removed in the first vNext release.
2. Existing mission records remain resumable. vNext migration must preserve `missionId`, `projectId`, owner principal, binding revision semantics, task/action identity, evidence, and accepted legacy capability IDs required to continue an in-flight mission.
3. IRIS-X / IRIS-C workflows using the current catalog remain functional while new grouped tools are introduced.
4. Compatibility wrappers route through the same `CapabilityService`, effect enforcement, live workspace/resource validation, approval, and audit as the new grouped operations. A wrapper is not a legacy bypass.
5. Existing `project_validation_*` APIs later map onto the new shell/job engine using a fixed declared-script execution profile. The old restriction that only physically declared root `package.json` scripts are callable remains part of wrapper semantics.
6. Existing file/directory APIs later map onto `fs` operations while preserving current no-follow, hard-link, project containment, exact-edit and bounded-I/O guarantees unless vNext is stricter.
7. Existing Git APIs later map onto grouped `git` operations. `remote_publish` remains the safe current-feature-branch-to-origin preset and must not gain force/delete/protected-branch behavior.
8. Minimum compatibility period is two catalog versions after a replacement grouped tool becomes ACTIVE and passes compatibility acceptance. A stronger pre-existing support promise overrides this minimum.
9. Deprecation requires explicit catalog metadata, migration documentation, active-use review, and acceptance proof that durable missions created under the old schema remain resumable.
10. PRO remains read-only. New execution/mutation tools do not appear in PRO merely because FULL gains them.

## Classification of the current 42 tools

Classification meanings:

- `KEEP` — semantics remain first-class and are not scheduled for replacement by a grouped vNext primitive.
- `EXTEND` — remains first-class but may add optional identity/workspace diagnostics without breaking existing requests/responses.
- `COMPATIBILITY_WRAPPER` — stays callable and maps onto a new grouped engine once that engine is stable.
- `FUTURE_DEPRECATION` — removal is planned after the compatibility period. Phase 0 assigns no current tool directly to this class; wrapper telemetry and later ADR approval are required first.

| # | Current tool | Classification | vNext contract |
|---:|---|---|---|
| 1 | `runtime_status` | EXTEND | Add machine/tunnel/split-identity diagnostics additively; preserve existing fields. |
| 2 | `list_projects` | EXTEND | May expose repository/workspace summaries additively; current project list remains valid. |
| 3 | `project_info` | EXTEND | May expose repository/workspace identities additively. |
| 4 | `git_status` | COMPATIBILITY_WRAPPER | Maps to `git(operation=status)`. |
| 5 | `search` | COMPATIBILITY_WRAPPER | Maps to bounded `fs(operation=find)` / text-search preset. |
| 6 | `mission_list` | KEEP | Existing durable mission visibility preserved. |
| 7 | `session_open` | KEEP | Session semantics preserved. |
| 8 | `session_get` | KEEP | Session read semantics preserved. |
| 9 | `session_close` | KEEP | Session ownership semantics preserved. |
| 10 | `workspace_select` | EXTEND | Current project selection remains valid; optional workspace selection may be added without changing old project-only calls. |
| 11 | `mission_list_waiting_supervisor` | KEEP | Supervisor transport unchanged. |
| 12 | `mission_get` | KEEP | Durable mission read unchanged. |
| 13 | `mission_events` | KEEP | Timeline semantics unchanged. |
| 14 | `mission_directive` | KEEP | Directive remains orchestration input, never permission approval. |
| 15 | `mission_orchestrator_handoff` | KEEP | Handoff changes orchestration only. |
| 16 | `mission_create` | KEEP | Durable project-bound mission identity preserved. |
| 17 | `mission_state_set` | KEEP | Orchestration state contract preserved. |
| 18 | `mission_task_create` | KEEP | Task identity preserved. |
| 19 | `mission_task_state_set` | KEEP | Task state contract preserved. |
| 20 | `mission_action_prepare` | EXTEND | Future capability IDs may be accepted; legacy IDs remain valid during compatibility. |
| 21 | `mission_supervisor_gate_set` | KEEP | Gate remains non-permission authority. |
| 22 | `project_test_run` | COMPATIBILITY_WRAPPER | Maps to declared-script shell/job preset for script `test`. |
| 23 | `project_validation_run` | COMPATIBILITY_WRAPPER | Maps to synchronous declared-script `shell.run` preset. |
| 24 | `project_validation_discover` | COMPATIBILITY_WRAPPER | Reads declared-script execution profile inventory. |
| 25 | `project_validation_start` | COMPATIBILITY_WRAPPER | Maps to declared-script `shell.start` + generic durable job. |
| 26 | `project_validation_job` | COMPATIBILITY_WRAPPER | Maps to `job(status|logs|result)` with the existing project ownership check. |
| 27 | `git_local` | COMPATIBILITY_WRAPPER | Maps operation-by-operation to grouped `git`. Unsupported vNext operations do not become callable through this wrapper. |
| 28 | `remote_publish` | COMPATIBILITY_WRAPPER | Maps only to the safe `git.push` feature-branch preset and verifies remote HEAD as today. |
| 29 | `file_read` | COMPATIBILITY_WRAPPER | Maps to bounded `fs.read`; old request remains accepted. |
| 30 | `file_write` | COMPATIBILITY_WRAPPER | Maps to `fs.write` create/replace semantics; current bounded exact action remains valid. |
| 31 | `file_edit` | COMPATIBILITY_WRAPPER | Maps to exact `fs.edit` with SHA-256 precondition and atomic publication. |
| 32 | `file_delete` | COMPATIBILITY_WRAPPER | Maps to non-recursive `fs.delete`; destructive effect is derived server-side. |
| 33 | `directory_create` | COMPATIBILITY_WRAPPER | Maps to `fs.mkdir`. |
| 34 | `directory_delete` | COMPATIBILITY_WRAPPER | Maps to empty-directory `fs.delete`/rmdir preset only. |
| 35 | `mission_start` | KEEP | Worker lifecycle remains durable and project-bound. |
| 36 | `mission_checkpoint` | KEEP | Checkpoint semantics preserved. |
| 37 | `mission_resume` | KEEP | Same durable mission resumes; no replay/substitution. |
| 38 | `mission_rebind` | KEEP | Owner-only CAS rebind semantics preserved. |
| 39 | `mission_cancel` | KEEP | Mission cancellation remains separate from generic job cancellation. |
| 40 | `mission_complete` | KEEP | Terminal mission completion semantics preserved. |
| 41 | `mission_evidence` | EXTEND | May accept artifact/job references additively; evidence never authorizes execution. |
| 42 | `catalog_identity` | EXTEND | Add `machineId`/binding diagnostics additively while preserving catalog hash/count/runtime fields. |

Classification totals:

```text
KEEP=20
EXTEND=7
COMPATIBILITY_WRAPPER=15
FUTURE_DEPRECATION=0
TOTAL=42
```

## Wrapper equivalence requirements

A compatibility wrapper passes only when all of the following are true:

- same or stricter scope validation;
- same or stricter effect classification;
- no new implicit network/destructive behavior;
- same mission action ownership/correlation behavior where applicable;
- same owner approval requirement or stricter;
- same audit visibility plus vNext effective effects;
- same output bound or stricter artifact/reference behavior;
- no hidden shell string/interpolation path;
- no global workspace authorization side effect.

## Durable mission compatibility

A mission prepared under a legacy capability ID such as `file.write`, `git.local`, `project.command.run`, `project.validation.start`, or `remote.publish` may continue after vNext activation if that capability remains in its compatibility window. IRIS must not require recreating the mission merely to obtain a new grouped capability ID.

New actions prepared after vNext may use new granular capability IDs, but replay/idempotency remains action-specific. A completed legacy action is never replayed through the new engine simply to produce a new receipt.

## Catalog migration sequence

1. Ship grouped tools additively while all 42 current tools remain ACTIVE.
2. Run wrapper equivalence and old-mission-resume acceptance.
3. Maintain at least two catalog versions of overlap.
4. Only after a later ADR explicitly approves deprecation may selected wrappers gain `FUTURE_DEPRECATION` metadata.
5. Removal is a separate breaking-change decision and is not authorized by Phase 0.

## Explicit non-breaking statement

`CURRENT_42_TOOLS_BREAKING_CHANGE=NO`

The Phase 0 documents themselves do not change the live catalog, capability IDs, permission behavior, or runtime schemas.
