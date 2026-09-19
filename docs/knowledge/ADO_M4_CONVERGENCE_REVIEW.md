# ADO M4 convergence review

Date: 2026-09-19
Legacy source: `codex/ado-m4-graph-provenance` / `c392f585ba15c9472b6787970656cb21ccf07023`

This review was performed while C2 validation jobs were running. It is planning evidence for C3 and is intentionally separate from the C2 package port.

## Reusable parts

- Fact bodies are plain text and content-hashed.
- Provenance binds source work item, revision, source locator, changed date and content hash.
- Comment identity is pseudonymized before it enters knowledge-facing objects.
- Comment pages have independent bounded cursor chaining and do not imply completeness until a terminal page is observed.
- Comment-derived interpretations remain `CANDIDATE` with `DERIVED_COMMENT` authority; they are not promoted to official requirements.
- Hierarchy building reports orphan/self-link/multiple-parent/cycle issues instead of inventing nodes or silently repairing source data.
- Relation cycles outside parent/child hierarchy do not invalidate hierarchy.
- Supporting links are metadata-only and strip query/fragment credentials.

## Convergence issues to fix in C3

1. **Changed-date format mismatch.** M3 accepts ADO UTC timestamps with zero or 1–7 fractional digits and preserves the source string. Legacy M4 requires exactly three fractional digits and exact `Date.toISOString()` equality. A valid M3 record can therefore be rejected by M4. C3 must normalize provenance time at the boundary or widen-and-canonicalize M4 validation without weakening source revision checks.

2. **Work-item identity mismatch.** M3 canonical work-item IDs are positive numbers; M4 uses string IDs plus a `scopeId`. C3 needs one deterministic adapter. `scopeId` must be derived from the authorized board/scope identity, not a display name, and numeric work-item IDs must not be reinterpreted as arbitrary caller strings.

3. **M1/M2 scope must remain authoritative.** M4 graph edges/comments must be accepted only for the already-bound board/scope. Cross-scope work-item relations remain external/unresolved evidence unless separately authorized; they must not widen the collection grant.

4. **External-document boundary.** Legacy link kinds include DESIGN and SHAREPOINT references. In M1–M8 these may remain sanitized metadata pointers only. They do not authorize Figma/SharePoint acquisition and do not make an external document authoritative knowledge. External document acquisition/authority remains M9/post-MVP.

5. **Comment pagination is independent.** The M1/M2 work-item/backlog cursors must not be reused as comment cursors. Provider comment pagination needs its own provenance/continuation binding.

6. **Revision evidence.** M4 revision diffs should be driven by an explicit revision stream or durable M6 snapshots. A Changed Date alone is not sufficient evidence of a version transition.

## C3 acceptance target

C3 should expose a deterministic bridge from validated M3 canonical records plus separately acquired relation/comment evidence into provenance facts/graph inputs, with no network, credential, or promotion authority in the bridge itself.
