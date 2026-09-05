# Agent interaction + conversation execution

Baseline: `b4a239a9faa50190b81d8e30e608b921ca6607b5` (`feat(web): add persistent workspace session experience`).

## Product slice

The localhost Web App can now submit an instruction to the currently selected authoritative runtime session and render that session's provider-neutral interaction history and execution state.

Canonical behavior:

- `session.instruction.submit` is an implemented LOW/MACHINE capability and passes through the existing `CapabilityService` and permission policy.
- A submit request requires live client/session ownership and carries a unique submission ID.
- Reusing the same submission ID is idempotent only when the normalized instruction matches the original binding. Reusing that ID with different content fails closed with `INVALID_REQUEST`; a different submission ID while the same session is executing fails with `SESSION_BUSY`.
- Session execution state is runtime-owned: `READY`, `WORKING`, or `FAILED`. `APPROVAL_REQUIRED` is derived from the existing daemon-owned pending-approval queue for the selected session.
- Session history contains bounded provider-neutral `user`, `assistant`, and `error` events. Executor failures are reduced to a product-safe error event; raw provider/implementation exception text is not stored in authoritative history or returned by the normal product API. History lives in the same authoritative `RuntimeState` as the session and is not duplicated in Web storage.
- Browser refresh and reconnect to the same daemon reload authoritative history without replay or duplication.
- Sessions, interaction history, execution state, and pending approvals remain intentionally transient across daemon restart. A restart never reconstructs or replays completed execution; project registry/default project persistence remains unchanged.
- Multiple sessions may execute independently. Switching Web selection does not redirect an in-flight execution or its output.
- Instruction approval remains in the existing Approval Center and is bound to the originating client/session. Exact-action review records byte count and SHA-256 instead of instruction text.
- The current executor is `local-development-executor`. It is deterministic, local, and explicitly reports `productionModelConnected=false`; it is not presented as a production AI model.

Out of scope: production model/provider integration, cloud runtime, model routing, autonomous orchestration, new MCP capabilities, durable session persistence, daemon replacement, Electron, Windows runtime, or changes to the legacy reference repository.
