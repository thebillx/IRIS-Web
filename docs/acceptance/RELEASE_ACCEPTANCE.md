# IRIS release acceptance matrix

This matrix records candidate evidence only. Disposable tests do not establish production or real ChatGPT readiness.

| Gate | Expected behavior | Test method | Result | Evidence / remaining action |
|---|---|---|---|---|
| Fresh setup | A clean data root can be initialized without touching another installation. | `control-setup.test.ts` with clean private roots; missing credential and repeated setup cases | PASS (disposable) | Setup is repeatable and refuses conflicting existing state. Clean Mac prerequisite installation remains unverified. |
| One connector | One machine exposes one `IRIS` connector at `/mcp`. | Unified registry and authenticated `/mcp` tests | PASS (disposable) | Exactly one `IRIS` binding and `/mcp`; external tunnel provisioning remains unverified. |
| One tunnel | A setup binds only its requested machine-local tunnel. | Separate tunnel IDs in two disposable roots | PASS (application-level) | No central lease or real tunnel ownership proof exists in local tests. |
| Authentication | An incorrect credential is rejected and the intended credential reaches only its local `/mcp`. | Unified daemon authentication and two-machine request-isolation tests | PASS (disposable) | Remote tunnel authentication and ChatGPT routing remain UNVERIFIED. |
| Credential safety | Credentials remain private and setup reports only safe presence/status. | Private credential tests and missing-credential setup path | PASS (local) | Secrets are not printed or placed in plist; real provider provisioning remains owner-controlled. |
| Machine isolation | Two disposable roots use independent machine identity, tunnel binding, registry and credential paths. | Two roots receive distinct machine IDs, tunnel IDs, registries and credential paths | PASS (simulated) | Cross-root request/fallback behavior, uninstall independence, two real Macs and ChatGPT connector routing remain UNVERIFIED. |
| Task continuity | A fresh process can resume only when source authority still matches. | Checkpoint tests, including fresh-process inspect, cross-task metadata, ASK/STOP/VERIFY | PASS (disposable) | Preserve the canonical local checkpoint during handoff. |
| Startup and restart | Repeated lifecycle operations preserve one owned stack and recover supported failures. | Disposable supervisor up/idempotent-up/down and failure-injection tests | PASS (disposable) | Real login/reboot and remote tunnel restart remain UNVERIFIED. |
| Backup and recovery | Disposable rollback and unknown outcomes fail closed; production restore is separately proven. | Existing activation/rollback and unknown-outcome fixtures | PASS (disposable) | Production writer fence, consistent backup/restore and live rollback are UNVERIFIED/BLOCKED. |
| Uninstall/reinstall | Owner can stop/remove runtime components while retaining data, then reinstall only after verified backup. | LaunchAgent artifact and data-preserving checklist review | PARTIAL | `launchd uninstall` is supported; full removal/reinstall of an existing installation is not production-verified. |
| LaunchAgent | The owner-managed agent contains only bounded local configuration and no secrets. | `launchd.test.ts` rendering and path checks; no live install | PASS (disposable) | Login/reboot persistence on a designated Mac remains UNVERIFIED. |
| Real ChatGPT connectivity | Authenticated Owner UI reaches the intended registered tunnel and `/mcp`. | Requires authenticated Owner UI and a real registered tunnel | UNVERIFIED | Owner must perform a separately authorized remote acceptance test. |
| macOS login persistence | The owner-managed LaunchAgent starts the intended installation after login/reboot. | LaunchAgent rendering tests only; no install on this host | UNVERIFIED | Verify login/reboot on a disposable or designated acceptance Mac. |
| RARW/bill two-Mac acceptance | RARW and bill each use only their own machine identity, tunnel and connector. | No physical-machine operation authorized in this mission | UNVERIFIED | Owner must perform separately authorized acceptance on both Macs. |
| Existing-installation migration | Existing state is preserved until an explicit migration and rollback plan is approved. | Setup intentionally refuses an existing registry; [migration and rollback runbook](MIGRATION_ROLLBACK_RUNBOOK.md) documents the contract | BLOCKED | Design is documented; separately authorize and execute the migration/rollback procedure before destructive reinstall. |

## Combined candidate

The disposable integration candidate combines PR #30 with the complete PR #29 commit chain without modifying either PR history. It is used only for compilation and focused acceptance. Neither PR is merged into `main`, and no live registry, tunnel, deployment epoch, LaunchAgent, or credential was changed.

## Owner release decision

The candidate is reviewable and disposable-tested. It is not production release-ready until the UNVERIFIED and BLOCKED gates above are completed with owner authorization and evidence from the designated machines.
