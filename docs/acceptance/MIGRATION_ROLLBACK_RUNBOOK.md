# IRIS migration and rollback runbook

This is a candidate design for a later, separately authorized operation. It has not been executed against the live installation. Existing two- or three-connector state must remain intact until the owner approves a migration window and a rollback point.

## Contract

`Preflight → Quiesce → Backup → Verify → Explicit Migration → Validate → Confirm or Rollback`

The unified setup command is a fresh-install command. It refuses an existing registry unless it is already the same one-connector IRIS binding. Never delete a registry to force setup and never treat a source checkout rollback as a persistent-data rollback.

## Preflight and backup

1. Work from a verified checkout and record the exact Git branch and commit.
2. Resolve the intended IRIS data root and confirm it is outside the source checkout. Do not inspect or mutate another machine's root.
3. For a disposable or parallel target, run `scripts/iris-acceptance.mjs` with the verified root and protected roots for every command. For an existing owner installation, set `IRIS_RUNTIME_DATA_ROOT` explicitly for each command; never rely on a remembered shell export. Run the correctly scoped `doctor`, `status` and `connectors` checks while the installation is still observable. Save only redacted status output.
4. Record project and workspace identifiers, connector labels, tunnel IDs, runtime identity, checkpoint location, and the list of IRIS-owned paths. Do not copy secret contents into the evidence.
5. With the intended daemon observable, set the owner token only in `IRIS_OWNER_ACCESS_TOKEN` and inspect the persisted writer inventory:
   `pnpm --filter @iris/runtime safety inspect --data-root "$IRIS_RUNTIME_DATA_ROOT"`.
6. Quiesce through the owner-local fence:
   `pnpm --filter @iris/runtime safety quiesce --data-root "$IRIS_RUNTIME_DATA_ROOT"`.
   CLI writer labels are not accepted as evidence; unknown or detached writers
   keep the result `BLOCKED`.
   A `BLOCKED` result is a hard stop. Do not substitute PID removal, recursive copying, or LaunchAgent removal.
7. Set `IRIS_CHECKPOINT_FILE` to the owner-controlled canonical checkpoint file (outside the runtime data root), then create and verify a new private destination outside the data root:
   `pnpm --filter @iris/runtime safety backup --data-root "$IRIS_RUNTIME_DATA_ROOT" --destination "$IRIS_BACKUP_ROOT" --checkpoint-file "$IRIS_CHECKPOINT_FILE"`,
   followed by `pnpm --filter @iris/runtime safety verify --data-root "$IRIS_RUNTIME_DATA_ROOT" --backup "$IRIS_BACKUP_ROOT"`.
   The manifest hashes every regular durable file and contains identity metadata without file contents or secrets.
8. Restore drills are disposable-only and never resume jobs:
   `pnpm --filter @iris/runtime safety restore --data-root "$IRIS_RUNTIME_DATA_ROOT" --backup "$IRIS_BACKUP_ROOT" --destination "$IRIS_RESTORE_ROOT" --checkpoint-file "$IRIS_RESTORE_CHECKPOINT_FILE" --disposable true`.
   Readiness remains blocked until both backup and restore evidence are recorded.
9. After the owner window, inspect `safety readiness`; release a verified fence
   with `safety unfence`, or recover a blocked fence only after fresh idle
   instance-bound observations using `safety recover`; do not pass writer labels
   or edit the persisted safety document.

## Explicit migration

Perform this only after the owner approves the recorded preflight and backup. The migration implementation must read the expected legacy registry shape, preserve project/workspace IDs and owner files, write atomically, and refuse unknown connector identities or ambiguous source roots. A dry run must report the planned unified binding without changing persistent state.

After publication, validate all of the following before confirmation:

- exactly one `IRIS` public binding at `/mcp`;
- no `IRIS PRO`, `IRIS ADMIN`, or extra tunnel binding;
- the recorded machine and runtime identity are unchanged or explicitly rotated;
- project and workspace IDs and owner files are byte-for-byte preserved;
- authenticated `/mcp` accepts the intended local credential and rejects an incorrect one;
- `doctor` and `status` report the expected local readiness;
- the checkpoint inspection result is reviewed before resuming any task.

If any validation fails, do not retry the migration blindly. Leave the candidate stopped and enter rollback.

## Rollback

Rollback requires the same quiescence and owner authorization as migration:

1. Stop candidate-owned lifecycle components through supported commands.
2. Preserve the failed data root as evidence; do not overwrite it.
3. Verify the backup manifest again.
4. Restore only the IRIS-owned paths into the designated disposable or owner-approved target root.
5. Re-run `doctor`, `status`, `connectors`, and the governed Git or project checks appropriate to that target.
6. If a mutation result is unknown, inspect the actual registry and process state before any retry. Treat an uncertain result as `VERIFY`, not success.

Source rollback is separate: use a fresh checkout at the known-good commit and keep the failed checkout for evidence. Do not reset or clean an owner worktree.

## Current gate

The candidate now has an owner-authenticated writer fence, manifest/hash backup, and disposable restore drill with focused tests. Production quiescence, provider ownership, legacy migration execution, and live rollback remain **UNVERIFIED/BLOCKED** until an owner-authorized acceptance exercise supplies real evidence.
