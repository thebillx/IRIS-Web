# Phase 6 synthetic mobile E2E

Status: bounded synthetic acceptance only. No BBL app, emulator, physical device, ADB or Appium server is contacted.

The happy path composes the Phase 6 boundaries in one identity chain:

1. resolve one immutable device binding;
2. create a loopback Appium session pinned to serial + connection generation;
3. acquire restricted page-source evidence through the governed adapter;
4. project the committed bytes into a RESTRICTED / EPHEMERAL / REVIEW_REQUIRED artifact intent;
5. create a Robot execution plan using the same device identity and explicit loopback endpoint; and
6. produce a metadata-only receipt containing no raw page source or sensitive values.

Negative E2E cases prove that reconnect invalidates the binding/session, disappearance never falls
back to a physical device, and cancellation produces no artifact evidence.

This checkpoint proves composition semantics, not real Android/Appium compatibility.
