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
`UNVERIFIED`. The wrapper does not accept an owner-provided bypass: obtain
authoritative non-production tunnel ownership evidence through the provider's
read-only lookup and a separately approved implementation before enabling any
remote startup. The lookup proves provider metadata for the requested tunnel;
it does not by itself prove that a local process owns the tunnel or authorize
startup. If a port is occupied, do not kill or adopt the process; stop and
schedule a separately isolated window.
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
