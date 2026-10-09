# IRIS migration and rollback runbook

This is a candidate design for a later, separately authorized operation. It has not been executed against the live installation. Existing two- or three-connector state must remain intact until the owner approves a migration window and a rollback point.

## Contract

`Preflight → Quiesce → Backup → Verify → Explicit Migration → Validate → Confirm or Rollback`

The unified setup command is a fresh-install command. It refuses an existing registry unless it is already the same one-connector IRIS binding. Never delete a registry to force setup and never treat a source checkout rollback as a persistent-data rollback.

## Preflight and backup

1. Work from a verified checkout and record the exact Git branch and commit.
2. Resolve the intended IRIS data root and confirm it is outside the source checkout. Do not inspect or mutate another machine's root.
3. Run `node scripts/iris.mjs doctor`, `node scripts/iris.mjs status`, and `node scripts/iris.mjs connectors` while the installation is still observable. Save only redacted status output.
4. Record project and workspace identifiers, connector labels, tunnel IDs, runtime identity, checkpoint location, and the list of IRIS-owned paths. Do not copy secret contents into the evidence.
5. Quiesce through the owner-approved lifecycle procedure. A backup is not consistent while an uncontrolled writer can mutate the data root.
6. Copy only the known IRIS-owned data root, credential directory and managed LaunchAgent metadata to a private backup destination. Preserve file modes and symlinks; exclude source checkouts and registered project repositories.
7. Verify the backup manifest, byte counts and hashes from a separate read-only pass. An incomplete or unverifiable backup is a hard stop.

The current candidate does not provide a production snapshot or writer-fence command. Production backup consistency remains **UNVERIFIED**.

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

Disposable activation and unknown-outcome fixtures pass. Production writer fencing, consistent backup/restore, legacy migration execution, and live rollback remain **UNVERIFIED/BLOCKED** until an owner-authorized acceptance exercise supplies real evidence.
