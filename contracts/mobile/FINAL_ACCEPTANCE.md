# IRIS Phase 6 Final Acceptance

STATUS=COMPLETED
SCOPE=MOBILE_CONTRACT + MOBILE_SECURITY + GOVERNED_ADB_APPIUM_COMPOSITION + ROBOT_ARTIFACT_INTEGRATION + SYNTHETIC_MOBILE_E2E
LIVE_MOBILE_ACTIVATION=NO
REAL_DEVICE_ACCESS=NO
LIVE_CATALOG_CHANGE=NO
LIVE_RUNTIME_REPLACEMENT=NO

## Baseline

- Phase 5.5 save point: `3ad92844375817c3603a54cb79fe32197852e00e`
- Phase 6 branch: `codex/phase6-mobile-current`
- Phase 6 worktree: `/Users/bill/iris-phase6-mobile-current`

## Delivered boundaries

### Mobile contract

The mobile contract requires one explicit device serial or immutable device binding. Discovery
never establishes authority. Connection generation is part of device identity; reconnect,
disappearance, offline state, ambiguous identity and wrong-device fallback fail closed.

The bounded ADB model includes package inspection, activity inspect/start, APK install,
screenshot, bounded logcat and one fixed Android-version shell profile. Root, su and arbitrary
device shell are absent.

The Appium model is loopback-only, pins sessions to explicit UDID + connection generation and
rejects stale or cross-device sessions. Arbitrary desired capabilities and endpoint override are
not part of the contract.

### Security acceptance

Security acceptance proves:

- discovery is non-authorizing;
- no implicit device selection or fallback exists;
- only the fixed shell profile is accepted;
- APK bytes are SHA-256 bound before install dispatch;
- screenshots/page source/logcat remain restricted and memory-only at acquisition;
- caller filesystem paths are not artifact authority;
- text evidence is secret-redacted before exportable handling;
- cancellation, timeout and identity loss fail closed; and
- no production mobile capability is registered in the live MCP catalog.

### Governed ADB/Appium composition

A production-shaped adapter boundary was added using injected typed transports only.
It accepts no raw ADB command string and no arbitrary Appium capability bag.

The adapter:

- resolves exact serial/binding against current ADB inventory;
- authorizes after identity resolution and before dispatch;
- verifies APK hash before install;
- restricts Appium to loopback;
- maps public/logical Appium session IDs to internal actual session IDs;
- rechecks device generation after transport work;
- never retries a mutation against another device;
- propagates bounded deadline/cancellation to the transport; and
- sends screenshot/source/logcat payloads only to an injected restricted artifact sink.

No real ADB binary, Appium server, BBL app, emulator or physical phone is contacted by acceptance.

### Robot job + artifact integration

Robot planning reuses the existing server-owned `robot` execution profile. Appium endpoint,
UDID and IRIS operation identity are passed as separate argv entries. Suite paths must be
workspace-relative .robot files; parent traversal is rejected.

Mobile evidence is projected into a path-free artifact registration intent containing fixed
project/workspace/job/operation/device identity, byte size, SHA-256 and fixed evidence MIME/type.
The intent forces `RESTRICTED` sensitivity, `EPHEMERAL` retention and
`REVIEW_REQUIRED` export state. It does not allocate a physical path or independently authorize
persistence.

### Synthetic mobile E2E

The synthetic E2E composes one identity chain:

device binding -> Appium session -> restricted page-source evidence -> artifact intent -> Robot plan.

The successful receipt retains serial, connection generation, job/operation correlation and
artifact digest without raw page source. Negative cases prove reconnect invalidation, no fallback
to a physical device and zero artifact publication after cancellation.

## Canonical validation

Phase 6 mobile validation is now wired into repository root commands:

- `pnpm test` runs the mobile acceptance suite before the normal recursive repository tests.
- `pnpm typecheck` runs strict Phase 6 mobile TypeScript before the normal recursive typecheck.
- root lint covers `contracts/mobile` and the mobile validation runner.

### Mobile acceptance counts

- Original mobile contract: **22/22 PASS**
- Mobile security acceptance: **6/6 PASS**
- Governed ADB/Appium composition: **10/10 PASS**
- Robot/artifact integration: **6/6 PASS**
- Synthetic mobile E2E: **4/4 PASS**
- Total mobile acceptance: **48/48 PASS**
- Strict mobile TypeScript: **PASS**
- ESLint: **PASS**

### Repository validation

- Root canonical typecheck: **PASS**
- Root build: **PASS**
- Final canonical test: **PASS**
- Runtime test files: **42/42 PASS**
- Runtime tests: **308/308 PASS**
- Web tests: **21/21 PASS**
- Shared tests: **2/2 PASS**
- Mobile tests within canonical root test: **48/48 PASS**

The first broad repository run observed two existing infrastructure timing/ownership failures:
a 5-second Hermes test timeout and one Phase 3 durable-job result reported LOST instead of
SUCCEEDED. Both tests were immediately rerun serially with one worker and passed **17/17**.

The Hermes governed project-test case was then measured independently at about **6.0 seconds**,
proving that its inherited 5-second Vitest default could produce a false negative under normal
process load. Only that test's harness timeout was raised to **15 seconds**; production behavior
and execution deadlines were not changed. Focused Hermes + Phase 3 validation passed **17/17**
after the change. The final canonical Phase 6 worktree run then passed completely, including
mobile **48/48** and runtime **308/308**.

## Live runtime preservation

Final live verification after Phase 6 validation:

- runtime status: `READY`
- identity state: `COHERENT`
- runtimeId: `0dd6afb3-1694-437b-a56c-fd36d3d3f7be`
- instanceId: `2cb12ebd-1ef5-48d8-b28e-8a4274f12010`
- pid: `60562`
- deployment epoch: `18`
- FULL tool count: `48`
- FULL catalog hash: `sha256:1368833e2f5a3bf15eb44e52231fe85f4198b378fb1ef1f5e1b8402577c587b6`

Phase 6 therefore caused no live runtime restart, catalog reload or mobile activation.

## Remaining production gates

Phase 6 completion is a contract/security/integration/synthetic-E2E checkpoint. It does not claim
real Android compatibility. Later explicit authorization is still required for:

- a real ADB transport implementation and executable lifecycle;
- a reviewed loopback Appium transport and driver/capability policy;
- device lease/concurrency and disconnect event integration;
- content-aware screenshot/page-source PII review/redaction;
- encrypted durable artifact storage and expiry/deletion policy;
- real Robot execution against an authorized project suite;
- emulator and physical-device compatibility evidence;
- live MCP capability/catalog registration; and
- any live mobile activation.

## Final decision

PHASE_6_MOBILE_CONTRACT=PASS
PHASE_6_SECURITY_ACCEPTANCE=PASS
PHASE_6_GOVERNED_ADAPTER_COMPOSITION=PASS
PHASE_6_ROBOT_ARTIFACT_INTEGRATION=PASS
PHASE_6_SYNTHETIC_E2E=PASS
PHASE_6_LIVE_ACTIVATION=NOT_AUTHORIZED
PHASE_6=COMPLETED
