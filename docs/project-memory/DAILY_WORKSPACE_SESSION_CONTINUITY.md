# Daily workspace + session continuity

Baseline: `b7ed2e5106422a4f043442658fa6928031a44da1` (`feat(permissions): establish local owner trust boundary`).

## Product slice

The localhost Web App now treats the daemon's existing project/session model as a persistent daily workspace rather than presenting the runtime as the primary product surface.

Canonical behavior:

- Active Project is the selected runtime session's `currentProjectId`; no implicit project switch occurs when selecting a session.
- The Web session list comes from the authoritative daemon and is filtered by the browser client's existing `clientId`.
- Creating a session still executes through `session.create` in `CapabilityService`.
- Selecting/resuming a session is a Web preference only; runtime session identity remains authoritative.
- Browser refresh and reconnect to the same daemon reload existing sessions without duplication and restore the selected session only if it still exists.
- Session/client state and pending approvals remain intentionally transient across daemon restart.
- Project registry/default project remain persisted across daemon restart.
- Browser `sessionStorage` stores only the Web client identity, owner access credential, and selected-session pointer; it is not a second session store.
- Pending approvals are shown only in the current session/browser-client context; switching sessions closes an approval review from the prior session.
- Runtime/MCP/permission authority, one-daemon ownership, and existing trust-hardening contracts are unchanged.

Out of scope: conversation persistence, cloud synchronization, Electron, Windows runtime, new MCP capabilities, daemon model replacement, or changes to the legacy reference repository.
