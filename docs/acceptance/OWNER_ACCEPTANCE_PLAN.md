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
- Do not proceed if the root, process, port, tunnel, credential or LaunchAgent
  identity cannot be proved. Preserve the evidence and ask the owner.

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
registries, and the global LaunchAgent risk. It writes one visible
`.iris-acceptance-identity.json` guard file in the empty acceptance root. A
later command with a changed root, checkout, branch or HEAD fails closed.

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
`UNVERIFIED`. After a separate owner authorization proves that the tunnel and
credential are non-production, the owner may use the explicit authorization
form below; the same root, process and port checks still apply:

```sh
node scripts/iris-acceptance.mjs \
  --runtime-data-root "$IRIS_ACCEPTANCE_ROOT" \
  --protected-root "$IRIS_LIVE_DATA_ROOT" \
  --protected-root "$IRIS_LIVE_SOURCE_ROOT" \
  --owner-authorized-tunnel -- up
```

Use the same form for `restart` or `setup --start`. If a port is occupied, do
not kill or adopt the process; stop and schedule a separately isolated window.
Use `iris_acceptance down` only for the acceptance root whose identity was
verified by the wrapper.

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
