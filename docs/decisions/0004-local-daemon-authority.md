# ADR 0004: Local daemon authority

## Context
Local capabilities require one auditable owner and safe concurrency behavior.

## Decision
The local daemon will own runtime authority and will fail closed when ownership is ambiguous.

## Consequences
Identity, acquisition, recovery, and release need verified lifecycle semantics in the next mission.

## Out of scope
Implementing authority or process lifecycle in this bootstrap.
