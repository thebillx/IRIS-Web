# Phase 6 governed ADB/Appium adapter composition

Status: production-shaped local boundary with injected transports; no live device I/O or MCP registration.

The governed adapter deliberately does not accept raw ADB command text, arbitrary Appium desired
capabilities, arbitrary endpoints, or caller filesystem paths. A production transport must implement
the typed interfaces defined in `governed.ts`.

## ADB boundary

Only typed operations from the Phase 6 contract are dispatchable. Every device operation resolves
one explicit serial or immutable binding to one currently connected device and records its connection
generation. Authorization is checked after identity resolution and before transport dispatch. APK
bytes are hashed locally before install. The adapter never retries a mutation against another device.

## Appium boundary

The Appium transport endpoint is server-owned and loopback-only. Session creation pins `udid` to
the resolved device. The public/logical session ID is the operation ID; the actual Appium session ID
remains inside the adapter. Source/screenshot/contexts/delete requests require the matching logical
session plus the same serial and connection generation.

## Artifact boundary

Screenshot, Appium page source and logcat payloads are delivered to an injected artifact sink.
The sink receives no caller path. Metadata is always restricted, memory-only and requires redaction
before export. Logcat text is redacted before commit. Screenshot/page-source remain restricted because
pattern matching alone cannot certify removal of banking PII.

## Cancellation and identity

Operations carry an explicit bounded timeout and AbortSignal. The adapter propagates cancellation to
the transport, never reports success after timeout/cancellation, and rechecks device identity after
the transport returns. A changed connection generation fails closed. Mutations are not automatically
retried because the first dispatch may already have changed device state.

The acceptance suite uses fake typed transports only and does not access ADB, Appium, BBL, an emulator
or a physical device.
