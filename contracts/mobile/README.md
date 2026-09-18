# Phase 6 mobile execution contract

Status: synthetic contract ready; production implementation and integration deferred.
Primary workload: BBL Android tests using Robot Framework, Appium, ADB, emulators
and explicitly selected physical devices. Host target is macOS; no platform or
real-device compatibility has been verified. No BBL device was accessed.

## Ownership and identity invariants

`contract.ts` defines an adapter-facing acceptance envelope; `fake.ts` is an
in-memory model, not a permission service or executable transport. No runtime
imports these modules. The only runtime helper consumed by the harness is the
existing output redactor. No package manifests or domain exports change.

Each device operation requires exactly one explicit serial or established binding
ID. Even a single connected emulator is never selected implicitly. Bindings are
immutable snapshots of serial plus connection generation and cannot be reassigned.
A future transport owns generation issuance, disconnect event tracking, and
per-device serialization. A reconnect invalidates bindings and sessions even if
the serial is unchanged. Missing, duplicate, unauthorized, offline, or replaced
targets fail closed. Never retry against another serial or physical device.
Discovery returns snapshots and establishes neither bindings nor permission.

Discovery is READ and includes serial, state, transport, model, manufacturer,
Android version, API level, and emulator/physical classification. Unknown metadata
is null; no guessed identity. Production discovery must keep any enrichment
explicitly read-only. Connection IDs are local lifecycle evidence, not adb serials.
Binding establishment is explicit but still does not authorize execution.

## ADB contract

| Operation | Inputs / result contract | Effects |
| --- | --- | --- |
| devices | no target; device snapshots | READ |
| package_info | target, package name; version/install metadata | READ |
| activity inspect | target, component; activity metadata | READ |
| activity start | target, component; launch outcome | READ, WRITE, EXECUTE |
| install | target, authorized APK bytes, expected SHA-256; install outcome + actual hash | READ, WRITE, EXECUTE |
| screenshot | target; restricted PNG artifact | READ |
| logcat | target, 1–1,048,576 byte limit; restricted text artifact | READ |
| bounded shell | target, android-properties-v1 / get_android_version only | READ, EXECUTE |

The acceptance envelope returns evidence/artifact policy only; transport payloads
are deliberately not fabricated. Production adapters must return typed operation
payloads before activation. Every ADB invocation must use explicit `-s serial`,
argument arrays, and no host shell interpolation. Do not expose raw command text,
root, su, remount, adb root, or arbitrary shell. The fixed shell profile maps only
to Android version inspection; additional profiles require separate reviewed
policy and effect derivation. Host shell authorization is insufficient for device
shell. Discovery permission never implies device read or mutation permission.

APK input in this contract is bytes, avoiding a new filesystem authority boundary.
Future integration must resolve authorized workspace/artifact paths, reject escape
and symlink races, freeze the bytes, hash those exact bytes, and install the same
snapshot. A caller-supplied hash alone is not evidence. Hash mismatch rejects
before dispatch; hashes are recorded with operation and device identity.

## Appium adapter decision

Prefer IRIS mobile adapter → local Appium server using its existing WebDriver
semantics and Android driver. Bind only to loopback; do not start or expose a
server as a hidden probe side effect. Appium MCP can be a reviewed alternate
transport only if it preserves explicit serial/udid, session identity, policy,
cancellation, and artifact handling. A generic MCP connection grants no authority.
Do not rebuild Appium locators, waits, drivers, context switching, or Robot libraries.

`status` reads server health without creating a session. `session create` requires
an explicit target and pins Appium `udid` to its serial. Record the actual returned
session ID with binding generation; the fake uses operationId as a synthetic ID.
`session delete`, `source`, `screenshot`, and `contexts` require both target and a
matching live session. A stale, wrong-device, or reconnected session fails; no
implicit new session. Arbitrary desired capabilities are not accepted by this
contract. Future capabilities must prevent udid override, auto device launch,
network endpoint override, and unreviewed installation/reset effects. Session
creation/deletion conservatively derive READ, WRITE, EXECUTE. Context enumeration
is READ; context switching is outside this phase.

## Robot composition and lifecycle

Later compose with existing Phase 3 governed shell/jobs. Use an authorized project
suite path, fixed Robot execution profile, argv rather than inline shell, explicit
Appium endpoint and bound udid, and allowlisted environment. Carry Phase 3 jobId
and unique mobile operationId through requests, sessions, and artifact evidence.
The harness proves field preservation only; it does not launch a Robot job.

Authorize effective effects before dispatch. A production job owns cancellation,
deadline, subprocess group, device lease, and only the Appium sessions it created.
No concurrent mutation on one device; independent devices may execute separately.
Cancel queued work before dispatch. Abort active I/O and bounded cleanup of owned
resources on timeout/cancel. Never report success after deadline, cancellation,
or identity loss. Mutations may already have occurred: report unknown/partial
outcome with original identity; do not automatically retry install/activity.
Default future deadline is explicit per request, bounded at 300 seconds here.
The fake injects elapsed time and an operation-boundary hook deterministically;
it does not prove real transport interruption or disconnect event handling.

## BBL data handling

Screenshots, logcat, page source, Robot output, and install diagnostics are
restricted by default. Artifact evidence includes serial, device kind, connection
generation, operation ID, optional job ID, and APK hash for installs. Serial
metadata itself is restricted; audit records must not include account data or
raw payloads. No automatic upload or unrestricted inline tool output.

This phase's retention is memory-only: no artifact files, persistence, or export.
Destroy operation buffers at completion/cancellation as far as the host runtime
permits; JavaScript does not guarantee secure memory erasure. Integration must
supply an explicitly authorized encrypted local store with an expiry/deletion
policy before persisting anything. No indefinite default retention.

Text uses the existing secret redactor plus supplied sensitive values before
export, but pattern matching cannot certify absence of banking data. Images and
page source require reviewed content-aware redaction; unverified artifacts stay
restricted and cannot be exported. The fake produces policy metadata, not images,
and makes no claim to OCR or complete PII redaction.

## Synthetic acceptance

Run with Node 24 (no installed test dependency needed):

```sh
node --experimental-transform-types --test contracts/mobile/acceptance.test.mjs
```

The transform flag is needed by the existing TypeScript redactor. Node emits
experimental/module-detection warnings; all 22 cases must pass. Cases 01–15 map
in order to the mission's requested scenarios; 16–22 add immutable/reconnected
bindings, discovery non-authority, root/arbitrary-shell denial, APK mismatch,
Appium cross-device rejection, malformed bounds/identity, and pre-cancellation.
These are synthetic acceptance proofs only. Real-device compatibility, Appium
payloads, runtime policy enforcement, lifecycle concurrency, persistence, and
Robot execution remain Phase 6 integration work. No activation is authorized here.
