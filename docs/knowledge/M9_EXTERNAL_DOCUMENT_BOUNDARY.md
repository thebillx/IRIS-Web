# M9 External Document Connector Boundary

Status: IMPLEMENTATION_STARTED

## Current-state assessment

M1-M8 already provide the authority pieces M9 should reuse rather than replace:

- ADO links are collected as opaque supporting-evidence references.
- Knowledge Gate keeps primary knowledge, context, supporting evidence, and rejected content separate.
- Wiki projection only promotes validated ADO-backed claims.
- Figma already has a bounded read contract with connector binding, file/node allowlists, expiry, size/time limits, provenance, and read-only acquisition semantics.
- The artifact bridge already carries sensitivity and provenance across runtime/project/workspace boundaries.
- Connector/runtime identity remains owned by the existing IRIS connector registry and CapabilityService.

The missing primitive is a provider-neutral external-document boundary that lets ADO retain inert supporting-document references even when no document connector is available, while later acquisition remains explicitly bound to one trusted connector grant.

## M9-A first slice

`apps/runtime/src/external-documents/contract.ts` introduces:

- provider identity: Figma, SharePoint, PDF, Excel;
- inert `REFERENCE_ONLY` supporting-document references that require no connector;
- a trusted `ExternalDocumentGrant` bound to project, connector binding, provider, source set, operation set, expiry, output workspace, transport mode, and resource limits;
- a caller request surface that contains no URL, token, headers, filesystem path, or executable;
- fail-closed acquisition binding for project/binding/provider/source/operation mismatch;
- remote-network denial and local-artifact support;
- a provider-agnostic evidence/provenance result contract whose authority is always `SUPPORTING_EVIDENCE`.

This slice intentionally does not expose a new public MCP capability yet. M9-B/C will bind existing Figma and future SharePoint/PDF/Excel adapters into this internal boundary first, then expose only the minimum governed surface required by acceptance tests.

## Non-negotiable invariants

1. External document content does not become an official requirement merely because it was acquired.
2. ADO collection remains independent of external connector availability.
3. Acquisition authority is explicit and non-ambient.
4. No generic HTTP/URL execution surface is introduced.
5. Existing CapabilityService, project/workspace boundaries, connector identity, FULL/PRO behavior, and audit remain authoritative.

## M9-A acceptance

- Provider-neutral contract implemented for Figma, SharePoint, PDF and Excel.
- ADO supporting-document references remain available with no connector/network dependency.
- Wiki/reference projection is non-searchable and `SUPPORTING_EVIDENCE` only.
- Conflicting reference/source-link rebinding fails closed.
- Focused M9-A tests: 9/9 PASS.

## M9-B Figma knowledge linking

- ADO external reference identity is bound to the existing governed Figma `ReadGrant`/`ReadRequest` contract.
- Project, connector binding, connector identity, credential/session authority, output workspace, source file and operation mapping must all match.
- Existing Figma node allowlists remain authoritative; M9 does not introduce a parallel Figma authorization path.
- Acquired Figma results project into the generic external-document evidence model only as `SUPPORTING_EVIDENCE`, retaining acquisition/source-link/version provenance.
- Expected-version mismatch fails before evidence is accepted as current.
- Focused Figma/M9 tests: 33/33 PASS.

## RARW canonical regression qualification

RARW resolves its canonical Node 24 runtime at `/opt/homebrew/opt/node@24/bin/node`; its pnpm executable is installed beside that canonical Node rather than at `/opt/homebrew/bin/pnpm`. The governed execution profile now checks the canonical Node sibling package-manager path first, matching `scripts/node24.mjs` and preserving the server-owned executable boundary.

After that compatibility fix:

- previously failing Hermes/Phase 8/supervisor focused regressions PASS;
- full parallel suite reaches only process-sensitive timeout failures in two Phase 4 Git cases and one legacy Phase 8 validation case;
- exact affected files rerun with `--maxWorkers=1` PASS;
- M9 source-focused tests, typecheck, lint and build remain required at each review slice.

## M9-C SharePoint / PDF / Excel / attachment ingestion

- Added governed acquisition orchestration with connector availability, timeout, bounded streaming bytes, source/version pinning, artifact ownership checks, and SHA-256 content receipts.
- Added typed SharePoint adapter boundary where connector-owned transport receives source identity rather than caller URLs or headers.
- Added local PDF/Excel extraction adapter boundary keyed by governed artifact ID, not filesystem path.
- Added ADO attachment routing that accepts only governed ArtifactReference identity, routes supported PDF/Excel MIME types, and leaves unsupported binaries reference-only.
- Cross-project/workspace artifact substitution, source/version drift, oversize content, unavailable connectors, and timeout fail closed.
- Focused M9 external-document suite: 29/29 PASS.
- typecheck, lint, and build: PASS.

## M9-D revision history and cross-source correlation

- Added external-document revision snapshots and deterministic diffs for unchanged, metadata-only, and content-changing revisions.
- Revision comparison is bound to exact project/provider/source/source-link identity and rejects time reversal or source rebinding.
- Added same-project evidence graph covering ADO Work Item, external document, Bug, Test Case, Pull Request, Commit, and Build identities.
- Every cross-source relation remains `SUPPORTING_EVIDENCE`; implementation/QA evidence never becomes requirement truth by correlation alone.
- Cross-project edges remain denied at this layer and are delegated to the explicit M9-E authority boundary.
- Focused M9-D tests: 6/6 PASS.
