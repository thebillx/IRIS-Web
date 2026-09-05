# ADR 0003: Local web UI

Status: retained for the local control surface; superseded as the primary conversational-UX decision by the V1.3 ChatGPT-primary workflow.

## Context
IRIS needs a local control and inspection interface without coupling the product to a desktop shell. The primary conversational UX is now ChatGPT through the IRIS connector/plugin bridge.

## Decision
Use a React application in the browser, backed by a localhost API, for local workspace/session visibility, runtime health, permissions, approvals, diagnostics, and optional standalone interaction.

## Consequences
The UI can evolve independently and requires no Electron runtime. Browser-to-daemon contracts must be explicit. V1.3 success does not depend on the localhost conversation composer or the optional production-model executor.

## Out of scope
Remote hosting and native desktop packaging.
