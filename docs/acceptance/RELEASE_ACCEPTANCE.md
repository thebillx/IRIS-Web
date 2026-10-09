# IRIS release acceptance matrix

This matrix records candidate evidence only. Disposable tests do not establish production or real ChatGPT readiness.

| Gate | Test method | Result | Evidence / remaining action |
|---|---|---|---|
| Fresh setup | `control-setup.test.ts` with clean private roots; missing credential and repeated setup cases | PASS (disposable) | Setup is repeatable and refuses conflicting existing state. Clean Mac prerequisite installation remains unverified. |
| One connector | Unified registry and authenticated `/mcp` tests | PASS (disposable) | Exactly one `IRIS` binding and `/mcp`; external tunnel provisioning remains unverified. |
| One tunnel | Separate tunnel IDs in two disposable roots | PASS (application-level) | No central lease or real tunnel ownership proof exists in local tests. |
| Credential safety | Private credential tests and missing-credential setup path | PASS (local) | Secrets are not printed or placed in plist; real provider provisioning remains owner-controlled. |
| Machine isolation | Two roots receive distinct machine IDs, tunnel IDs, registries and credential paths | PASS (simulated) | Two real Macs and ChatGPT connector routing remain UNVERIFIED. |
| Task continuity | Checkpoint tests, including fresh-process inspect, cross-task metadata, ASK/STOP/VERIFY | PASS (disposable) | Preserve the canonical local checkpoint during handoff. |
| Startup and restart | Disposable supervisor up/idempotent-up/down and failure-injection tests | PASS (disposable) | Real login/reboot and remote tunnel restart remain UNVERIFIED. |
| Backup and recovery | Existing activation/rollback and unknown-outcome fixtures | PASS (disposable) | Production writer fence, consistent backup/restore and live rollback are UNVERIFIED/BLOCKED. |
| Uninstall/reinstall | LaunchAgent artifact and data-preserving checklist review | PARTIAL | `launchd uninstall` is supported; full removal/reinstall of an existing installation is not production-verified. |
| Real ChatGPT connectivity | Requires authenticated Owner UI and a real registered tunnel | UNVERIFIED | Owner must perform a separately authorized remote acceptance test. |
| macOS login persistence | LaunchAgent rendering tests only; no install on this host | UNVERIFIED | Verify login/reboot on a disposable or designated acceptance Mac. |
| Existing-installation migration | Setup intentionally refuses an existing registry | BLOCKED | Design and separately authorize a migration/rollback procedure before destructive reinstall. |

## Combined candidate

The disposable integration candidate combines PR #30 with the complete PR #29 commit chain without modifying either PR history. It is used only for compilation and focused acceptance. Neither PR is merged into `main`, and no live registry, tunnel, deployment epoch, LaunchAgent, or credential was changed.

## Owner release decision

The candidate is reviewable and disposable-tested. It is not production release-ready until the UNVERIFIED and BLOCKED gates above are completed with owner authorization and evidence from the designated machines.
