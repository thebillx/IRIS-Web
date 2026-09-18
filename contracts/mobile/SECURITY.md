# Phase 6 mobile security acceptance

Status: **PASS candidate — synthetic contract scope only**.

This gate reviews the Phase 6 mobile contract before any ADB/Appium production adapter or
runtime catalog registration exists.

Accepted boundaries:

- every operation requires an explicit serial or immutable binding; discovery is not authority;
- reconnect changes the connection generation and invalidates bindings/sessions;
- there is no device fallback, including from emulator to physical device;
- raw/root/arbitrary Android shell is absent; only the fixed android-properties-v1 version read is modeled;
- APK installation binds exact bytes to an expected SHA-256 before dispatch;
- Appium sessions remain pinned to one serial + connection generation;
- screenshot, page-source and log evidence stays restricted, memory-only and requires redaction before export;
- caller paths are not accepted as artifact authority;
- cancellation, deadline and identity loss fail closed;
- log text passes the existing IRIS secret redactor plus explicit sensitive values;
- no production ADB/Appium capability is registered into the live MCP catalog by this checkpoint.

The adjacent security acceptance adds focused composition tests on top of the original 22 mobile
contract cases. Real device compatibility, live ADB/Appium I/O, image/source PII redaction,
durable artifact storage and device concurrency remain downstream integration obligations.
