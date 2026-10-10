# IRIS installation and recovery guide

IRIS is macOS-first and local by default. It uses one machine-local connector,
one public `/mcp` route and owner-controlled tunnel/ChatGPT steps. Choose the
installation case before running any command.

## A. Truly fresh machine

This path is for a Mac with no existing IRIS installation. It changes the
default local data root and requires owner approval for credentials, startup and
login persistence. Stop if the root already exists; do not treat `status`,
`doctor` or `setup` as harmless probes of an unknown installation.

```sh
fresh_root="$HOME/Library/Application Support/IRIS"
if [ -e "$fresh_root" ]; then
  echo "IRIS data already exists; use the migration or isolated-acceptance path" >&2
  exit 1
fi

git clone https://github.com/thebillx/IRIS-Web.git iris
cd iris
node scripts/node24.mjs --pnpm install --frozen-lockfile --ignore-scripts
node scripts/iris.mjs credentials migrate "$HOME/.config/tunnel-client/<separately-authorized-profile>.yaml"
node scripts/iris.mjs setup --tunnel-id <registered-tunnel-id>
node scripts/iris.mjs status
node scripts/iris.mjs doctor
```

The migration, setup and status commands above intentionally target the fresh
default root only after the absence check. `up` and `launchd install` are
owner-approved mutations and must follow successful local checks. Never put a
credential in a command argument, plist, log or source file.

## B. Isolated acceptance beside an existing installation

Use [the owner acceptance plan](acceptance/OWNER_ACCEPTANCE_PLAN.md) and the
acceptance-only wrapper. Do not scope only `setup`; credential migration,
`up`, `down`, `restart`, `status`, `doctor`, `connectors`, `catalog status`,
`logs` and all cleanup commands must use the wrapper.

```sh
export IRIS_ACCEPTANCE_ROOT="$HOME/Library/Application Support/IRIS-acceptance-<unique>"
export IRIS_LIVE_DATA_ROOT="$HOME/Library/Application Support/IRIS"
export IRIS_LIVE_SOURCE_ROOT="/Users/RARW/iris"
mkdir -m 700 "$IRIS_ACCEPTANCE_ROOT"   # stop first if it already exists

iris_acceptance() {
  node scripts/iris-acceptance.mjs \
    --runtime-data-root "$IRIS_ACCEPTANCE_ROOT" \
    --protected-root "$IRIS_LIVE_DATA_ROOT" \
    --protected-root "$IRIS_LIVE_SOURCE_ROOT" \
    -- "$@"
}

iris_acceptance preflight
iris_acceptance credentials migrate "$IRIS_ACCEPTANCE_PROFILE"
iris_acceptance setup --tunnel-id <non-production-tunnel-id> --json
iris_acceptance status
iris_acceptance doctor
```

The wrapper refuses a missing root export, root switch, source/data overlap,
reused state, protected-root collision, ambiguous process state, occupied
runtime/web ports, protected tunnel claim, production profile, and the global
`com.iris.supervisor` LaunchAgent install/uninstall. It never falls back to
`~/Library/Application Support/IRIS`. Remote startup remains blocked while
tunnel ownership is unverified; a separate owner-authorized implementation must
first provide authoritative non-production tunnel evidence.

## C. Existing installation migration

Fresh setup is not migration. Do not delete a registry, point a fresh command
at an existing root, or reuse another machine's identity. Follow the
[migration and rollback runbook](acceptance/MIGRATION_ROLLBACK_RUNBOOK.md) in a
separately approved window. Its preflight, quiescence, backup, verification,
explicit migration, validation and rollback steps are required.

## D. Data-preserving uninstall

Uninstall is scoped to the installation whose source and data roots have been
verified. For an isolated acceptance, use the same `iris_acceptance` function:

```sh
iris_acceptance down
iris_acceptance launchd status
```

The acceptance wrapper intentionally blocks `launchd uninstall` because the
user-level label is global and may belong to live IRIS. Do not kill processes or
remove plists, locks, registries or data roots to resolve that conflict. A live
installation uninstall requires an owner-approved quiescence window and exact
identity verification.

## E. Full clean reinstall

Full removal is an owner action after a verified backup. Preserve the failed
root as evidence, remove only confirmed IRIS-owned paths, and use a new
checkout and private root. Never remove BBL, Enhance01 or an unknown directory.
Reconnect ChatGPT only after local identity, tunnel identity and authenticated
`/mcp` behavior have been verified.

## Connecting ChatGPT

The authenticated IRIS Owner UI registers the intended connector after local
`status`, `doctor` and tunnel checks pass. A disposable or local test cannot
prove remote routing, ChatGPT selection or two-Mac isolation.

## Recovery decisions

From the verified Git root, inspect task continuity before taking over work:

```sh
node scripts/task-checkpoint.mjs inspect <task-slug>
```

`EXECUTE` permits the recorded action. `ASK` requires missing requirements,
`STOP` means source or owner authority changed, and `VERIFY` means a mutation
outcome is uncertain. For an isolated installation, use the acceptance wrapper
for `status`, `doctor`, `down` and any retry. Never delete unknown state to make
setup pass. Real login/reboot, remote ChatGPT, production backup/restore,
existing-installation migration and live rollback remain separately authorized
acceptance gates.
