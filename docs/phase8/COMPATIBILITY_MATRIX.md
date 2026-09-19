# Phase 8 Compatibility Matrix

Compatibility baseline: IRIS catalog `2.3.0` / 42 legacy tools.
Live runtime during Phase 8: `2.3.0` / 49 FULL tools.
Source candidate: `2.4.0` / 49 FULL tools.

Frozen compatibility hashes:

- legacy 42-tool name/schema/capability/effect metadata: `1770afee25ea16845137464de238c36c51465ada722ad7206cee38f14b5e0f54`;
- PRO five-tool read-only metadata: `ae0be3214fdf8b60275027394a7bd43d5b5121a69f31bebc3011b01789ce15e1`.

## Classification

| Class | Count |
| --- | ---: |
| KEEP | 20 |
| EXTEND | 7 |
| COMPATIBILITY_WRAPPER | 15 |
| FUTURE_DEPRECATION | 0 |
| Legacy baseline total | 42 |

## Compatibility wrappers

| Legacy MCP tool | Legacy capability | vNext engine/preset | Acceptance | Phase 8 rule |
| --- | --- | --- | --- | --- |
| `git_status` | `project.git_status` | governed Git status compatibility view | AC-COMPAT-002 | Preserve old status shape; no mutation authority |
| `search` | `project.search` | PRIMARY fs bounded range text-search preset | AC-IRIS-007 / search equivalence | Preserve up to 100 `path/line/text` matches; non-exhaustive scans are truncated |
| `project_test_run` | `project.test.run` | declared-script `shell.run` preset | AC-COMPAT-003 | Script `test` only |
| `project_validation_run` | `project.command.run` | declared-script `shell.run` preset | AC-COMPAT-003 | Root package.json declaration only |
| `project_validation_discover` | `project.validation.discover` | declared-script profile inventory | AC-COMPAT-003 | Read-only, same result shape |
| `project_validation_start` | `project.validation.start` | `shell.start` + DurableJobManager | AC-COMPAT-003 | Stable requestId and project ownership |
| `project_validation_job` | `project.validation.job.read` | durable job compatibility view | AC-COMPAT-003 | Legacy status/log/result shape; old persisted jobs remain readable |
| `git_local` | `git.local` | GovernedGitEngine + internal compatibility presets | AC-COMPAT-002 | Old operation allowlist only |
| `remote_publish` | `remote.publish` | governed safe push preset | AC-COMPAT-002 | Origin/current feature branch only; no force/delete |
| `file_read` | `file.read` | PRIMARY fs read | AC-COMPAT-001 | Legacy 1 MiB bound/result shape |
| `file_write` | `file.write` | PRIMARY fs CREATE/REPLACE preset | AC-COMPAT-001 | Preserve bounded legacy upsert |
| `file_edit` | `file.edit` | PRIMARY fs exact edit | AC-COMPAT-001 | SHA-256 precondition |
| `file_delete` | `file.delete` | PRIMARY fs delete | AC-COMPAT-001 | Non-recursive physical file only |
| `directory_create` | `directory.create` | PRIMARY fs mkdir preset | AC-COMPAT-001 | Preserve idempotent `created:false` |
| `directory_delete` | `directory.delete` | PRIMARY fs delete | AC-COMPAT-001 | Empty physical directory only |

## Acceptance map

| Acceptance | Result | Proof |
| --- | --- | --- |
| AC-IRIS-005 | PASS | Frozen 2.3.0 fixture equals 2.4.0 legacy 42-tool compatibility hash; FULL remains 49 |
| AC-IRIS-007 | PASS | Legacy `file.write` action survives owner rebind + resume with stable mission/task/action/evidence and no replay |
| AC-COMPAT-001 | PASS | File/directory/search wrappers execute through PRIMARY fs with same or stricter scope/effects/results |
| AC-COMPAT-002 | PASS | Git wrappers use governed Git; safe-publish behavior preserved and mutation surface not widened |
| AC-COMPAT-003 | PASS | Declared-script validation routes through shell/job with lifecycle scripts suppressed and old persisted jobs readable |
| AC-COMPAT-004 | PASS | 2.3.0 frozen schemas/capability IDs are preserved by source catalog 2.4.0; PRO remains five read-only tools |

## Catalog overlap

Supported source compatibility window is bounded to:

- `2.3.0` — frozen previous catalog;
- `2.4.0` — Phase 8 source candidate.

No arbitrary/future catalog version is accepted by the compatibility parser.

The live Bill runtime remains `2.3.0` until controlled activation is explicitly approved.

## Removal gate

Phase 8 does not authorize removal. A wrapper may be removed only after:

1. replacement operation has been ACTIVE for at least two catalog versions;
2. wrapper-equivalence acceptance is green;
3. durable old-mission resume acceptance is green;
4. usage review has no unresolved active dependency;
5. a later ADR explicitly authorizes removal;
6. migration documentation is published.

`CURRENT_42_TOOLS_BREAKING_CHANGE=NO`
