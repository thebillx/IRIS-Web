# IRIS installation and recovery guide

This is the supported fresh-install path for macOS. It uses one machine-local IRIS connector and one public `/mcp` route. It does not provision a remote tunnel or select a ChatGPT connector for you; those are owner-controlled steps.

## Before installation

Use a clean checkout, Node 24, Git, and a private data directory outside the checkout. Do not reuse an existing IRIS data directory for a fresh install. Keep the tunnel credential in the existing private tunnel profile; never put a credential in a command argument, plist, log, or source file.

```sh
git clone https://github.com/thebillx/IRIS-Web.git iris
cd iris
node scripts/node24.mjs --pnpm install --frozen-lockfile --ignore-scripts
```

The owner must already have a registered tunnel ID and the existing private tunnel profile. If the profile uses a legacy control-plane credential, migrate that selected profile explicitly:

```sh
node scripts/iris.mjs credentials migrate "$HOME/.config/tunnel-client/<profile>.yaml"
```

The migration writes only private local credential files and does not print the credential.

## Guided setup

Run setup with the registered tunnel ID. The command validates the Node/macOS boundary, checks credentials without exposing them, creates a fresh unified registry, creates the local tunnel-service secret, and prints the next owner actions.

```sh
node scripts/iris.mjs setup --tunnel-id tunnel_<32-lowercase-hex-digits>
```

For an isolated machine or disposable test, set a different private data root:

```sh
IRIS_RUNTIME_DATA_ROOT="$HOME/Library/Application Support/IRIS-rarw" \
  node scripts/iris.mjs setup --tunnel-id tunnel_<32-lowercase-hex-digits>
```

Setup refuses an existing registry unless it is already the same one-connector IRIS binding. A different tunnel ID or a legacy two-connector registry requires an owner-reviewed migration; setup never overwrites it.

The default output is a human-readable readiness summary. Automation can request the same result as JSON by adding `--json`; neither form prints credential values. `ChatGPT Not Verified` remains explicit until the owner completes the authenticated Owner UI connection.

Start and diagnose the local stack explicitly:

```sh
node scripts/iris.mjs up
node scripts/iris.mjs doctor
node scripts/iris.mjs status
```

After local readiness is verified, install login startup with explicit owner consent:

```sh
node scripts/iris.mjs launchd install
node scripts/iris.mjs launchd status
```

The LaunchAgent contains paths and runtime configuration only. It does not contain tunnel or API credentials. `doctor` is the first troubleshooting command; `logs` provides redacted owner-local diagnostics.

## Connecting ChatGPT

Use the authenticated IRIS Owner UI to register the connector for this machine after the owner has verified the local `status` and tunnel acceptance. The connector is the single `IRIS` binding at `/mcp`. A local disposable test cannot prove ChatGPT routing, remote tunnel reachability, or connector selection across two Macs.

## Updating

Keep a checkpoint, inspect `doctor`, stop the candidate through its supported lifecycle command, update the checkout, install frozen dependencies, and repeat the owner-reviewed setup or migration step required by the release. Do not replace an existing registry by deleting it.

## Uninstalling

The supported data-preserving operation is:

```sh
node scripts/iris.mjs launchd uninstall
node scripts/iris.mjs down
```

This removes the IRIS LaunchAgent and stops owner-managed candidate processes while retaining runtime data, credentials, projects, workspaces, sessions, jobs, and checkpoints. A full removal is a separate owner action: back up and verify the data first, then remove only the IRIS-owned data root, credential directory, logs, managed profiles, and source checkout. Never remove BBL, Enhance01, or an unknown directory. Full removal/reinstall of an existing installation is not yet production-verified.

## Reinstalling

After the owner has approved a full removal and verified the backup, use a new checkout and private data root:

```sh
git clone https://github.com/thebillx/IRIS-Web.git iris
cd iris
node scripts/node24.mjs --pnpm install --frozen-lockfile --ignore-scripts
node scripts/iris.mjs credentials migrate "$HOME/.config/tunnel-client/<profile>.yaml"
node scripts/iris.mjs setup --tunnel-id <registered-tunnel-id>
node scripts/iris.mjs up
node scripts/iris.mjs doctor
```

Reinstalling an existing installation is an owner-reviewed migration and rollback exercise. Do not delete a registry to force setup, reuse another machine's data root, or reconnect ChatGPT until the local identity and tunnel have been verified.

The detailed later-operation contract is [the migration and rollback runbook](acceptance/MIGRATION_ROLLBACK_RUNBOOK.md). It is a design and checklist for a separately authorized exercise, not a command to run during a fresh install.

## Recovery decisions

Run the checkpoint helper from the verified Git root before taking over a task:

```sh
node scripts/task-checkpoint.mjs inspect <task-slug>
```

`EXECUTE` permits the recorded next action within existing authorization. `ASK` requires the owner to supply missing requirements. `STOP` means source or authority changed. `VERIFY` means a mutation result is uncertain; inspect the real result before retrying. None of these recommendations executes a command automatically.

If startup fails, run `doctor` and inspect `status` before retrying. Do not kill an unknown process or delete an unknown lock. Production writer fencing, consistent backup/restore, existing-installation migration, real login/reboot behavior, and live rollback require a separately authorized acceptance exercise.
