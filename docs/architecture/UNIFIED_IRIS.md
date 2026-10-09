# Unified IRIS and native task continuity

The candidate supports a fresh macOS installation with one user-facing IRIS connector, one public tunnel and one authenticated `/mcp` route. The existing tool and project permissions still apply. Local Supervisor/ADMIN recovery remains available to the owner without an external ADMIN tunnel. Existing multi-connector installations are preserved; no registry is silently migrated.

## Fresh setup (future owner operation)

The complete owner-facing checklist is [the installation guide](../INSTALLATION.md). Run from the reviewed installed source root with Node 24 and frozen dependencies ready. The owner must first provision the existing private tunnel credential configuration using the supported credential setup workflow and obtain one registered tunnel ID. Never put secrets in command arguments or source control. No setup command below was executed against the live installation during development.

```sh
node scripts/iris.mjs setup --tunnel-id <registered-tunnel-id>
node scripts/iris.mjs up
node scripts/iris.mjs doctor
node scripts/iris.mjs launchd install
node scripts/iris.mjs status
```

Setup refuses an existing registry unless it is the same unified binding. LaunchAgent installation uses the existing macOS login-start mechanism and starts the stack; it therefore requires explicit installation authority. Production migration, backup/fencing and a real login/remote connector acceptance test remain separate operational gates. Do not run these commands on an existing installation to approximate migration.

Setup prints a human-readable readiness summary by default; append `--json` for automation. The summary keeps local readiness separate from the unverified ChatGPT round trip.

Unified CLI and Web status use Online / Offline / Needs Attention. Online describes the observed local service/stack, not a claim that a ChatGPT round trip passed. Detailed owner-local diagnostics remain available through `doctor` and `catalog status`. Routine tasks retain the existing permission policy; lifecycle, credentials and filesystem boundaries are not broadened.

## One checkpoint per task

Use the repository-native helper from the verified Git root. It writes only `.agents/handoffs/<task-slug>.json`. Git supplies the actual branch, HEAD, physical root/common-directory identities and a fingerprint of tracked and untracked owner work. It does not use a running IRIS connector, create a session, launch a job or grant authorization. The supplied project label and physical workspace describe the task; they are not registry bindings.

```sh
node scripts/task-checkpoint.mjs inspect <task-slug>
node scripts/task-checkpoint.mjs save <task-slug> < /private/path/to/checkpoint-input.json
```

The input object requires these fields (example uses placeholders, not inferred requirements):

```json
{
  "expectedRevision": 0,
  "requestId": "stable-checkpoint-request-1",
  "objective": "The owner-approved objective",
  "project": "The selected project",
  "workspace": "/absolute/physical/git/root",
  "currentState": "Current verified state",
  "completed": ["Completed work"],
  "changedFiles": ["project-relative-file.ts"],
  "tests": [{"command": "exact command", "exitCode": 0, "result": "Observed result"}],
  "remaining": ["Remaining work"],
  "blockers": [],
  "questions": [],
  "nextAction": "One exact next action",
  "pendingMutation": null
}
```

Use an empty tests array when nothing was run; put unverified behavior in remaining work or blockers. A non-null `pendingMutation` identifies a submitted operation whose result must be checked before retry. Request IDs are bound to exact content. Repeating the same request after a lost acknowledgement returns its existing record; a different request must use the latest revision. Concurrent writers fail closed rather than overwriting each other.

Takeover decisions are `EXECUTE` when source and next action agree, `ASK` for missing checkpoints or recorded questions/blockers, `STOP` for changed source/owner work, and `VERIFY` for unknown mutation outcomes. Inspect first and execute only within the task's existing authorization. No recommendation runs a command automatically. Update the checkpoint after verifying a resolved outcome or making progress; never invent a missing objective. Preserve owner-held files and ambiguous interrupted writer locks.

Checkpoints can contain local paths and task evidence. Keep actual machine checkpoints local unless the owner explicitly approves publication after reviewing their contents. Publish code/test evidence through the Draft PR description instead. The helper excludes its own checkpoint and writer staging paths from the source fingerprint, so recording progress does not invalidate itself.
