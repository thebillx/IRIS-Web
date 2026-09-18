# Phase 5.5 Figma → Wiki synthetic E2E

Status: executable bounded synthetic acceptance; **no production Wiki write and no live Figma network adapter**.

## Flow

1. A trusted Figma grant binds the exact project/binding/file/node read request.
2. Synthetic acquisition produces bounded metadata and screenshot evidence for one source version.
3. Each evidence artifact is transferred through the artifact bridge with fixed size, SHA-256,
   sensitivity, destination project/workspace/artifact identity and source/acquisition provenance.
4. The bridge publishes only after full verification.
5. A synthetic Wiki sink accepts only completed artifacts for the exact Wiki project and requires
   matching provenance across metadata and screenshot evidence.
6. The Wiki result retains source version, evidence artifact IDs and provenance while excluding
   credential/session references.

## Acceptance cases

- Happy path: metadata + screenshot evidence reaches a deterministic Wiki topic with retained provenance.
- Source revision drift: resume/acquisition rejects before transfer.
- Destination substitution: a foreign Wiki project is denied.
- Tampered screenshot bytes: checksum mismatch fails before publication.
- Secret boundary: credential/session refs and bearer material never appear in Wiki output.

This E2E is intentionally synthetic. It validates the Phase 5.5 contract composition without
pulling the ADO Knowledge/Wiki implementation into this phase or granting any external write authority.
Production transport, durable artifact persistence and real Wiki publication remain separate later gates.
