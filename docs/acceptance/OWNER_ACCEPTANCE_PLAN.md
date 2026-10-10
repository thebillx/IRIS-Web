# IRIS owner acceptance plan

This plan is the controlled handoff for the first real-machine acceptance. It is
not an authorization to change the live IRIS, BBL, Enhance01, tunnel, registry,
LaunchAgent, or ChatGPT configuration.

## Preconditions

- The owner names the acceptance Mac and records its hostname and macOS version.
- The owner verifies the checkout, branch, commit, and private data root before
  any setup command.
- The owner has a separately authorized registered tunnel ID and private tunnel
  profile. Credentials stay in the private profile and local credential store.
- The owner has a verified backup before touching an existing installation.

## RARW machine sequence

1. From the candidate checkout, run frozen install and inspect the Git identity:

   ```sh
   node scripts/node24.mjs --pnpm install --frozen-lockfile --ignore-scripts
   git status --short
   git branch --show-current
   git rev-parse HEAD
   ```

2. Use a new private data root for the acceptance, migrate the selected private
   tunnel profile, and run guided setup:

   ```sh
   node scripts/iris.mjs credentials migrate "$HOME/.config/tunnel-client/<profile>.yaml"
   IRIS_RUNTIME_DATA_ROOT="$HOME/Library/Application Support/IRIS-rarw" \
     node scripts/iris.mjs setup --tunnel-id <registered-tunnel-id>
   node scripts/iris.mjs up
   node scripts/iris.mjs status
   node scripts/iris.mjs doctor
   ```

3. Confirm the local authenticated `/mcp` response and the single `IRIS`
   connector through the owner-approved local checks. Record only redacted
   status, project/workspace IDs, process ownership, and commit evidence.

4. If local checks pass, the owner performs the authenticated Owner UI
   registration/connection for this machine and verifies one intended `IRIS`
   connector. ChatGPT connectivity is accepted only after an authenticated
   tool call reaches this machine's `/mcp` route.

5. With the owner observing, repeat `status`, `doctor`, and the authenticated
   tool call after a supported stop/start. Do not install login persistence yet.

## bill machine sequence

Repeat the same sequence on bill's Mac with a distinct private data root, tunnel
ID, credential store, and owner-approved connector. Do not copy RARW's data root,
registry, credential, LaunchAgent, or project files. Cross-machine requests
must fail authentication and must not fall back to the other machine.

## Login persistence and recovery

Only after both machines pass the observed local and Owner UI checks, separately
authorize:

```sh
node scripts/iris.mjs launchd install
node scripts/iris.mjs launchd status
```

Verify one owned process tree after login/reboot, then exercise the documented
stop/start recovery. Capture the redacted `doctor` result and the authenticated
tool-call result. A failed ownership, identity, or authentication check is an
abort condition; stop and preserve the data root for review.

## Acceptance record

Record for each Mac: hostname, macOS version, checkout commit, branch, private
data-root label (not its contents), tunnel ID suffix, Project/Workspace IDs,
LaunchAgent status, authenticated `/mcp` result, Owner UI connector result, and
recovery result. Never include credential values, full secret paths, or raw
logs. Mark the release matrix `PASS` only when the owner has attached this
evidence for both Macs. Until then, the real ChatGPT, login persistence, and
RARW/bill rows remain `UNVERIFIED`.
