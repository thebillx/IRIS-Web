# IRIS M9 Acceptance

Status: ACCEPTED
Branch: `codex/m9-external-knowledge`
Base: fetched `origin/main` containing ADO Knowledge MVP PR #14

## Delivered scope

- M9-A provider-neutral external-document authority boundary.
- M9-B Figma knowledge linking through the existing governed Figma read contract.
- M9-C SharePoint ingestion boundary, governed attachment routing, and local PDF/Excel artifact extraction boundary.
- M9-D external revision history plus same-project ADO/design/bug/test/PR/commit/build evidence correlation.
- M9-E automatic freshness assessment, scheduled Board-sync planning through existing M6 contracts, and explicitly granted cross-project evidence graph.
- M9-F acceptance/security coverage plus optional owner-gated ADO Wiki write-back intent boundary.

## Authority invariants

1. External-document acquisition never promotes content directly to requirement truth.
2. ADO collection works without external connectors.
3. Caller URLs, headers, tokens, raw filesystem paths, and arbitrary HTTP are not accepted as acquisition authority.
4. Project/workspace/connector/source/version identity is explicit and fail-closed.
5. Bug/Test/PR/Commit/Build/cross-project correlations are supporting evidence only.
6. Scheduled sync reuses the existing M6 SyncCoordinator start contract; no second sync engine exists.
7. Optional ADO Wiki write-back is disabled by default, binds exact governed artifact/path/version identity, requires owner approval, and has no enabled transport in M9.

## Validation evidence

- Focused M9/Figma acceptance: 79/79 PASS.
- `pnpm run typecheck`: PASS.
- `pnpm run lint`: PASS.
- `pnpm run build`: PASS.
- Earlier full-suite process-sensitive Phase 4/Phase 8 timing failures passed when rerun serially.
- Final staged-source full suite: PASS (exit 0). The prior untracked-source failure disappeared after staging exactly as expected by activation-source identity policy.

## Release rule

M9 acceptance is satisfied: focused M9 validation, typecheck, lint, build, and the final staged-source full suite all pass. No runtime activation is part of M9 acceptance.
