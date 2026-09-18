# Phase 6 Robot job and artifact integration

Status: isolated integration contract; no real Robot job, Appium server or mobile artifact is launched or persisted.

## Robot plan

The planner emits only the existing server-owned robot execution profile. Appium endpoint, UDID and
IRIS operation identity are passed as separate Robot argv entries. No inline shell, command string or
environment interpolation is introduced. The suite must be a bounded workspace-relative .robot path
and any parent traversal segment is rejected.

The plan preserves the governed Phase 3 job ID, unique mobile operation ID, explicit serial and
connection generation. Effective effects remain conservative because Robot/Appium flows may mutate
device state.

## Artifact registration intent

Mobile screenshot, page-source and logcat evidence is projected into an authority-neutral registration
intent. The intent contains no physical path or destination path. It fixes project/workspace/job/
operation/device identity, payload size and SHA-256, maps the evidence type to a fixed MIME/type pair,
and forces RESTRICTED sensitivity, EPHEMERAL retention and REVIEW_REQUIRED export state.

A future Phase 2 artifact authority may consume this intent only after allocating its own artifact ID
and protected physical location. This contract does not authorize persistence by itself.
