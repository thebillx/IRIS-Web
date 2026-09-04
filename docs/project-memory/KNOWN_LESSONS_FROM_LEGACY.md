# Known lessons from the legacy project

Derived from observed project history and behavior, independently rewritten.

- A stop result is trustworthy only after the process is confirmed gone and its exclusive authority has been relinquished.
- Exclusive ownership must deny operation whenever the owner cannot be determined safely.
- Abandoned ownership records need a deliberate recovery path rather than permanent lockout or unsafe takeover.
- Runtime ownership must carry an unambiguous identity that can distinguish a current process from an earlier one.
- Local services should listen on loopback unless a separately reviewed feature explicitly expands exposure.
- Product screens must be driven by real platform capability data and must not suggest unavailable functions.
- Persistent state needs named owners and visible mutation boundaries; diagnostics should remain read-only.
- Project and workspace paths are untrusted inputs and require structural and boundary validation.
- Machine-wide security relaxation is not an acceptable installation or recovery technique.
- Timing races require synchronization or observable state transitions, not fixed delays.
- Checking authority must not acquire, release, repair, or otherwise change it.
- Runtime contracts and UI affordances must agree about the capabilities of the current platform.
- Hands-on acceptance on the physical target can reveal packaging, permission, lifecycle, and interaction defects that automated checks do not cover.
