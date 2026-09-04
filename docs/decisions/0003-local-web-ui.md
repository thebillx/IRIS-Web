# ADR 0003: Local web UI

## Context
IRIS needs a primary interface without coupling the product to a desktop shell.

## Decision
Use a React application in the browser, backed by a localhost API.

## Consequences
The UI can evolve independently and requires no Electron runtime. Browser-to-daemon contracts must be explicit.

## Out of scope
Remote hosting and native desktop packaging.
