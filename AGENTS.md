# IRIS repository instructions

This repository is an independent, clean-sheet implementation. Do not copy source, tests, comments, build scripts, manifests, documentation, generated artifacts, or commit history from the legacy repository.

`LEGACY_REFERENCE_ROOT=/Users/bill/iris-native-runtime` is `READ_ONLY_REFERENCE`. It may be consulted for behavior, architecture, failure modes, test ideas, operations, UX, naming, release lessons, and project memory only. If material may be implementation rather than knowledge, do not reuse it.

## Product boundaries

- Build for macOS first. Do not claim support for platforms that have not been implemented and verified.
- Keep the runtime, persistence, permissions, MCP, and native capabilities local by default.
- Bind network services to localhost only unless a later, explicit security design authorizes more.
- Treat authority as fail-closed. Never add a global security or Gatekeeper bypass.
- Keep dependencies minimal and justified. Do not introduce Electron, Docker, a cloud control plane, or Windows-first architecture.

## Engineering rules

- Make ownership and persistence boundaries explicit. Never mutate persistent state as a hidden side effect, including during probes.
- Resolve concurrency with lifecycle and synchronization design, not blind sleeps.
- Validate paths and other trust-boundary inputs before use.
- Run focused validation first, followed by the appropriate broad checks.
- Preserve owner work. Never perform destructive cleanup of changes or files you do not own.
- Do not push, merge, create remotes, or publish automatically unless the current mission explicitly authorizes the exact action.
