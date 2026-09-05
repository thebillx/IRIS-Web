# Web UI

The primary interface is a small React/Vite application in a standard browser. It is a client of the authoritative local daemon, never a runtime or permission authority itself.

## Daily workspace

The main surface is product-oriented rather than a runtime console. It shows:

- the Active Project for the selected session, with a deliberate empty state when none is selected;
- the current browser client's existing daemon sessions;
- which session is selected, with create/resume/switch actions;
- authoritative current-session conversation history, execution state, and a session-bound instruction composer;
- recent session-bound runtime activity as secondary detail;
- the registered local project list and project registration controls;
- compact product status (`Ready`, `Approval required`, or disconnected), with detailed runtime identity/endpoints secondary.

The Web client keeps a stable per-tab `clientId` and a selected-session ID in `sessionStorage`. On refresh or reconnect it reloads the client-scoped session list from the daemon and resumes the saved selection only when that session still exists. Conversation events and execution state always come from the daemon; browser state never reconstructs a missing session, output, or working state.

Instruction submission targets the exact selected session and uses a unique submission ID. The Web prevents repeated clicks for the same in-flight session request, while runtime-side idempotency and `SESSION_BUSY` enforcement remain authoritative. Another session can continue independently while one session is working.

Sessions remain intentionally daemon-memory state, including their bounded interaction history and execution state. After a daemon restart the Web client observes an empty session list for that client and clears a stale selection, while the persisted project registry and machine default project remain available. Completed work is never replayed automatically. This preserves the existing storage contract instead of introducing a second Web session or conversation database.

Approval Center remains the only permission surface. Pending approvals are filtered to the selected session plus machine/browser-client decisions not tied to another session, and switching sessions closes any open approval from the previous context before it can be resolved accidentally. When an instruction itself is owner-required, the originating session shows an approval-required state but the exact decision is still made in Approval Center.

The current executor is explicitly reported by runtime metadata as `local-development-executor` with no production model connected. The Web labels that development seam instead of presenting it as a production AI provider.

During `pnpm dev`, the root dev coordinator starts or attaches to the authoritative runtime first, reads its actual loopback URL, and then starts Vite with a same-origin proxy to that runtime. No developer-specific absolute path is required.

Electron, remote hosting, cloud state, and a second session authority are outside this slice.
