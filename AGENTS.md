# Agent guidance: DGP Workspace

Read and follow `../AGENTS.md` before working in this repository.

## Role

This repository supplies the reusable editorial session and backend-integration runtime for canonical DGP `ProductDefinition` authoring. Studio consumes it; presentation remains outside it.

## Dependencies

- May depend on sibling `dgp-spec`, `dgp-core`, and `dgp-validation`.
- Must not depend on Ordering, the Form Palette adapter, Form Palette, Studio, React Flow, or a host application.
- Optional React context and hooks may wrap the headless runtime, but visual components must remain outside this package.
- Keep persistence, transport, authorization enforcement, and live collaboration behind host adapters.

## Owned behavior

- Backend ports and structured result/error contracts.
- Boot, hydration, loadable state, editorial sessions, canonical document state, and mutation commands.
- Branches, drafts, commits, snapshots, dirty state, autosave, comments, templates, authors, participants, and publication coordination.
- Branch caching, refresh, live-collaboration contracts, and optional development or memory adapters.
- Invocation and aggregation of `dgp-validation` results without owning validation rules or diagnostic presentation.

## Boundaries

- Orchestrate canonical v1 `ProductDefinition` documents only. Do not load, convert, or preserve legacy definitions, aliases, deprecated fields, or compatibility modes.
- Do not provide visual canvases, React Flow adapters, layer trees, panels, property editors, fallback UI, comments UI, diagnostics consoles, previews, or authorization presentation.
- Do not perform customer ordering, expression execution, advisory utility calculation, pricing, charges, or fulfillment.
- Treat `meta` as opaque host-owned data.
- Accept host authorization decisions through contracts instead of defining Studio-specific permission presentation.

## Authority

Spec controls document contracts, Core controls interpretation primitives, and Validation controls diagnostics. Workspace composes those concerns without redefining them.

## References

- Dependencies: siblings `../dgp-spec`, `../dgp-core`, and `../dgp-validation`.
- Backend evidence: sibling `../dgp-sdk`.
- Legacy headless evidence: `D:\Projects\GitHub\digital-service-ui-builder\src\react\workspace\context`.
- Do not migrate legacy visual components, React Flow adapters, or fallback-editor presentation.
- Studio source evidence: `D:\Projects\GitHub\service-builder`; destination: sibling `../dgp-studio`.
- Ordering siblings are `../dgp-ordering` and `../dgp-ordering-form-palette`, not dependencies.

This repository remains GPL-3.0.
