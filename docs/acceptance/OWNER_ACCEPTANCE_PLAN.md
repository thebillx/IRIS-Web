# IRIS owner acceptance plan

This plan is a guarded handoff for a separately authorized real-machine
acceptance. Do not run the old sequence of direct `scripts/iris.mjs` commands
beside an existing installation. The acceptance wrapper below is mandatory: it
requires one explicit root on every invocation and refuses the default IRIS
root, ambiguous state, occupied ports, protected tunnel claims, and the global
LaunchAgent collision.

## Preconditions

- The owner names the acceptance Mac and records its hostname, macOS version,
  source checkout, branch and expected candidate HEAD.
- Create a new private root with a unique name. Do not reuse a generic
  `IRIS-rarw` directory, an existing IRIS root, or a path under the checkout.
- Identify every protected live source/data root on that Mac and pass each one
  to `--protected-root`. The wrapper also protects the default IRIS data root,
  the default tunnel profile directory and the candidate source checkout.
- Provision a separate non-production tunnel profile and tunnel ID. Never copy
  a production credential or reuse a production tunnel identity.
- Obtain owner-approved, read-only provider evidence for that exact tunnel with
  `tunnel-client admin tunnels get <tunnel-id> --json`. This lookup accepts a
  runtime key from `CONTROL_PLANE_API_KEY` or `OPENAI_API_KEY`, or an explicitly
  approved admin key. Do not paste keys into commands or record the response
  body; retain only the redacted tunnel ID, name, scope and status needed for
  the evidence record.
- Do not proceed if the root, process, port, tunnel, credential or LaunchAgent
  identity cannot be proved. Preserve the evidence and ask the owner.

## Read-only RARW identity baseline

The maintenance registration IDs currently identify the physical root
`/Users/RARW/iris-repository-recovery` and its own Git common directory. Local
metadata and ordinary Git inspection produced this record; no reconciliation
command was run:

| Item | Observed value | Evidence / confidence |
|---|---|---|
| Project | `4ae13c3f-01b8-4cd8-b978-8ed3414c8fee` (`iris-repository-recovery`) | Local `state.json` and `vnext-resources.json`; high |
| Workspace | `ff81df0f-8f89-5894-b9a3-231e23625ecc` | Local `vnext-resources.json`; high |
| Repository | `c933c222-54ba-565b-936f-6555acdc45e6` | Local `vnext-resources.json`; high |
| Registered common Git directory | `/Users/RARW/iris-repository-recovery/.git` | Local repository metadata; high |
| Current branch / HEAD | `iris/repository-identity-recovery` / `6978164715ba0d01144f95de9cd02442ec3d0218` | Read-only Git; high |
| Working tree | One owner handoff file modified | Read-only Git; preserve it |
| Earlier recorded HEAD | `9bbcee97fdb5fb70a57f1d4a5f48e2480ac46052` | This is the current commit's parent and the Enhance01 integration HEAD; it is not interchangeable with `69781647…` |

The local registration record does not store the governed branch and HEAD, so
registration freshness for the new commit remains **UNVERIFIED**. Do not reset
the handoff file, execute `/repositories/reconcile`, or claim original
Enhance01 authorization is restored until governed Git access is independently
verified.

## Guarded session setup

Run from the expected candidate checkout. The root must not already exist; if
it does, stop rather than remove or overwrite it.

```sh
export IRIS_ACCEPTANCE_ROOT="$HOME/Library/Application Support/IRIS-acceptance-<unique>"
export IRIS_ACCEPTANCE_EXPECTED_BRANCH="codex/unified-iris-task-continuity"
export IRIS_ACCEPTANCE_EXPECTED_HEAD="<expected-candidate-head>"
export IRIS_LIVE_DATA_ROOT="$HOME/Library/Application Support/IRIS"
export IRIS_LIVE_SOURCE_ROOT="/Users/RARW/iris"

if [ -e "$IRIS_ACCEPTANCE_ROOT" ]; then
  echo "Acceptance root already exists; preserve it and stop" >&2
  exit 1
fi
mkdir -m 700 "$IRIS_ACCEPTANCE_ROOT"

iris_acceptance() {
  node scripts/iris-acceptance.mjs \
    --runtime-data-root "$IRIS_ACCEPTANCE_ROOT" \
    --protected-root "$IRIS_LIVE_DATA_ROOT" \
    --protected-root "$IRIS_LIVE_SOURCE_ROOT" \
    -- "$@"
}

iris_acceptance preflight
```

The wrapper checks the physical source/data paths, owner and mode, Git branch
and HEAD, protected-root collisions, existing process state, runtime ports
`43110–43113` and web port `5173`, tunnel claims visible in protected local
registries, and the global LaunchAgent risk. Its visible
`.iris-acceptance-identity.json` guard binds the canonical root path, device,
inode, owner and private mode as well as the checkout, branch and HEAD. A
later command with a changed root, checkout, branch or HEAD fails closed.

The wrapper is the only acceptance command entrypoint. Its allowlist is:
`preflight`; `setup --tunnel-id <id> [--json]`; `status`, `doctor`,
`connectors`, `catalog status`, `logs`, `down`, `launchd status`, and the
diagnostic/recovery commands documented below; and
`credentials migrate <private-profile>`. Nested root or protected-reference
flags, unknown options, positional arguments, `connectors init`,
`connectors admin-bind`, credential rotation, catalog reload, runtime adoption,
and supervisor mutation commands are rejected before a child process starts.
`up`, `restart`, and `supervisor` are recognized only so the wrapper can apply
the tunnel-ownership and port gates; they do not reach a child process while
ownership is `UNVERIFIED`.
The wrapper also rejects unreadable protected registries as unavailable
evidence; only a missing registry is treated as no local claim.

If `IRIS_ACCEPTANCE_ROOT` is missing, a command root differs from it, or the
root identity changes, the wrapper refuses to run. Forgetting an export in a
fresh terminal therefore cannot fall back to `~/Library/Application Support/IRIS`.

## Local acceptance sequence

Every command, including credential migration and diagnostics, goes through the
same function:

```sh
export IRIS_ACCEPTANCE_PROFILE="$HOME/Library/Application Support/IRIS-acceptance-profile-<unique>/tunnel.yaml"
iris_acceptance credentials migrate "$IRIS_ACCEPTANCE_PROFILE"
iris_acceptance setup --tunnel-id <non-production-tunnel-id> --json
iris_acceptance status
iris_acceptance doctor
iris_acceptance connectors
iris_acceptance catalog status
iris_acceptance logs
```

The profile must be an existing private file owned by the current user and must
be outside every protected production path. The wrapper never prints its
contents. Setup is local and may create the registry, but it does not prove
remote tunnel ownership.

Starting or restarting a remote tunnel is blocked while ownership is
`UNVERIFIED`. The supported positive path requires a private JSON evidence file
whose `schemaVersion` is `1`, `environment` is `non-production`, and whose
provider, machine, source checkout, tunnel ID, executable path, PID, process-start marker and binding
profile are recorded. The wrapper checks the current-user process identity with
`ps`, verifies that the live command exposes the evidenced tunnel binding, and
matches the process-start marker from `ps -p <pid> -o lstart=` to prevent PID reuse,
requires the acceptance root's `connector-registry.json` to contain the exact tunnel
binding, and requires `IRIS_ACCEPTANCE_TUNNEL_EVIDENCE` to point to that file. Provider
metadata alone is insufficient. Do not invent evidence, reuse production
profiles, kill or adopt an occupied process, or add a `--force` switch.

The owner procedure is to obtain the provider's read-only non-production
record, start the separately provisioned local provider process, capture its
PID, executable path and managed profile path, and write a mode-`0600` evidence
file with this shape (all values are owner-supplied):

```json
{
  "schemaVersion": 1,
  "environment": "non-production",
  "provider": "<documented-provider>",
  "machineId": "<hostname>",
  "sourceRoot": "<candidate-checkout>",
  "tunnelId": "<non-production-tunnel-id>",
  "pid": 12345,
  "executablePath": "/absolute/path/to/provider",
  "processStartMarker": "<exact ps lstart output>",
  "binding": { "tunnelId": "<non-production-tunnel-id>", "profilePath": "/absolute/path/to/profile" }
}
```

Export `IRIS_ACCEPTANCE_TUNNEL_EVIDENCE` to that file before invoking
`iris_acceptance up` or `iris_acceptance restart`. The wrapper independently
checks file mode/owner, current-user PID, executable identity and the provider
command's profile/tunnel binding. Any missing, stale or contradictory field
remains **BLOCKED**.
Use `iris_acceptance down` only for the acceptance root whose identity was
verified by the wrapper.

If a command is blocked, preserve the root and error output. A fresh terminal
must re-export `IRIS_ACCEPTANCE_ROOT` and rerun `iris_acceptance preflight`; an
existing guard with a replaced directory, symlink, owner or mode is not repaired
in place. Passing local preflight proves only disposable local identity and
storage checks; it does not prove production safety or remote tunnel ownership.

On a host where the live stack already owns ports `43110–43113` or `5173`, or
where `com.iris.supervisor` is loaded, use the controlled acceptance window
procedure. The owner must quiesce and fence the intended installation, record
the process and LaunchAgent identities, run a fresh wrapper preflight, and
restore the same installation after the evidence is captured. This plan does
not authorize that window.

## Controlled acceptance window — prepare only

The current RARW observation selects **Option B**. At the latest read-only
check, the live source was `/Users/RARW/iris`, the data root was
`/Users/RARW/Library/Application Support/IRIS`, the machine identity was
`e4da24b5-7560-4be1-a294-275b401c97b8`, and the runtime identity was
`bf524159-5912-4cb5-9453-c8d247b07960`. Ports `43110`, `43111`, `43112`, and
`5173` were occupied; no listener was present on `43113`, although the live
tunnel client processes remained. `com.iris.supervisor` was loaded and running
from `/Users/RARW/iris`. The data files showed 20 `RUNNING` mission records;
supported quiescence of jobs, sessions and writers was not established.

`LIVE_QUIESCENCE = BLOCKED` until the owner supplies a supported fence and
observes the resulting idle state. The candidate owner-local safety CLI now
provides that fence and a consistent disposable backup/restore drill. It must
be run with `IRIS_OWNER_ACCESS_TOKEN` set in the environment and an explicit
data root; it never prints the token or exposes a public MCP tool. A normal
recursive copy, PID removal, or LaunchAgent removal is not a backup or
quiescence procedure.

| Window step | Expected observation | Abort condition | Recovery / evidence | Approval boundary |
|---|---|---|---|---|
| Before window | Owner names the Mac, candidate checkout/HEAD, maintenance period, backup destination, tunnel identity, live source/data roots, ports, LaunchAgent and active jobs/sessions | Any identity, backup, provider or active-work ambiguity | Leave live IRIS untouched; retain redacted inventory and ask the owner | Owner authorizes downtime and the exact candidate |
| Reconfirm baseline | Read-only identity and process/port/LaunchAgent records match the recorded baseline | Source, runtime, machine, port or LaunchAgent identity differs unexpectedly | Stop before mutation; record the difference | Owner reviews the discrepancy |
| Quiesce and fence | `pnpm --filter @iris/runtime safety quiesce --data-root "$IRIS_RUNTIME_DATA_ROOT"` returns `QUIESCED` only when every inventoried writer has an instance-bound, independently verifiable idle record | Any `BLOCKED`, unknown writer, unexplained `RUNNING` work, or active session | Keep the live stack running; do not substitute CLI labels for writer evidence | Owner supplies the token and approves the controlled window |
| Backup and verify | `safety backup ... --checkpoint-file "$IRIS_CHECKPOINT_FILE"` returns a manifest and `safety verify ...` passes; then run disposable `restore ... --checkpoint-file "$IRIS_RESTORE_CHECKPOINT_FILE" --disposable true` | No consistency guarantee, incomplete manifest, failed restore drill, missing checkpoint evidence, or secret exposure | Do not start the candidate; preserve live state | Owner approves the backup evidence |
| Candidate preflight/start | Fresh wrapper preflight passes; all required ports are free; provider ownership and local process ownership are proven | Any occupied port, global LaunchAgent collision, stale tunnel, or wrapper block | Do not adopt or kill the owner; preserve the candidate root and diagnostics | Separate approval is required for real startup |
| Validate | Owner UI selects the intended connector; one read-only `/mcp` identity/status call returns the expected machine/runtime/tunnel; wrong credential is rejected | Connector ambiguity, identity mismatch, mutation, or unknown result | Stop only the owned candidate through its supported lifecycle; inspect before retrying | Owner observes and records the result |
| Restore live IRIS | Original source/data/LaunchAgent identities, catalog and durable state are verified after supported restart | Any failed or ambiguous restoration | Stop; do not replay mutations or restore state blindly | Owner confirms the maintenance window is closed |

The current wrapper intentionally blocks real remote startup while tunnel
ownership is `UNVERIFIED`; no bypass is permitted. Source rollback and data
restoration remain separate operations. If any step lacks the stated supported
operation, mark it **BLOCKED** rather than substituting a guessed command.

After the owner window, release the candidate fence only with the owner-local
command `pnpm --filter @iris/runtime safety unfence --data-root
"$IRIS_RUNTIME_DATA_ROOT"`. If a fence is `BLOCKED` or
`RECOVERY_REQUIRED`, use `safety recover` only after fresh, instance-bound
writer evidence is available; never supply unverified CLI labels, force the
state, or edit the safety file.

## LaunchAgent and two-machine isolation

The user LaunchAgent label is `com.iris.supervisor`, which is global to the
user and cannot safely coexist with the live installation. The wrapper blocks
both `launchd install` and `launchd uninstall` during parallel acceptance.
`iris_acceptance launchd status` is read-only; inspect rendered artifacts and
the existing owner state only. Install login persistence only in a separately
authorized window after the live label is quiesced and ownership is proven.

Repeat the guarded session independently on bill's Mac with a distinct private
root, source checkout, machine identity, credential profile and tunnel ID. Do
not copy RARW's registry, data root, credential, LaunchAgent or project files.
Cross-machine authentication and connector routing remain unverified until an
owner-observed authenticated tool call proves them.

## Recovery and cleanup

Before taking over work, inspect the checkpoint from the verified source root:

```sh
node scripts/task-checkpoint.mjs inspect <task-slug>
```

`EXECUTE` permits the recorded action; `ASK`, `STOP`, and `VERIFY` require
owner review. For the acceptance installation, use `iris_acceptance status`,
`iris_acceptance doctor`, and then the supported `iris_acceptance down` before
retrying. Never delete PID files, locks, plists, registries, runtime data or
unknown processes to resolve a conflict. Preserve the guarded data root for
backup and review; full removal, migration and rollback follow the separate
[migration and rollback runbook](MIGRATION_ROLLBACK_RUNBOOK.md).

Record only redacted status, Project/Workspace IDs, source commit, root label,
process ownership, port checks, tunnel ID suffix, LaunchAgent result and
authenticated `/mcp` evidence. Mark real ChatGPT, login persistence and
RARW/bill rows `PASS` only after both owner-authorized machines supply evidence.
