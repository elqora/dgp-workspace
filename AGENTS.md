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

Spec owns shared representation, SDK owns backend domain semantics, Core owns interpretation primitives, and Validation owns diagnostics. Legacy editorial behavior is evidence to retain or improve. Workspace composes those concerns without redefining them.

Ratified means the versioned plain TypeScript contract, required JSON fixtures, rationale, and stable status are merged into `dgp-spec/main`; generated JSON Schemas must also be current once tooling exists. Released means that ratified Spec version is tagged and published. Workspace may implement ratified unreleased contracts, but stable releases require released versions of its protocol dependencies.

## Change workflow and operations

- Update Workspace after affected Spec, Core/SDK, and Validation changes; do not make it establish contracts needed by lower-level packages.
- Commit and release this repository independently.
- This repository has no implementation manifest or operational commands yet. Do not invent install, test, lint, type-check, build, or generation commands.
- When its toolchain is introduced, document all real commands, supported runtimes, generated-output policy, completion criteria, and checks preventing Ordering, Form Palette, Studio, React Flow, visual-component, legacy-field, and generated-binding drift.

## References

- Dependencies: siblings `../dgp-spec`, `../dgp-core`, and `../dgp-validation`.
- Shared-contract guide: sibling `../dgp-spec/CONTRACTS.md`.
- Backend evidence: sibling `../dgp-sdk`.
- Legacy headless evidence: `D:\Projects\GitHub\digital-service-ui-builder\src\react\workspace\context`.
- Do not migrate legacy visual components, React Flow adapters, or fallback-editor presentation.
- Studio source evidence: `D:\Projects\GitHub\service-builder`; destination: sibling `../dgp-studio`.
- Ordering siblings are `../dgp-ordering` and `../dgp-ordering-form-palette`, not dependencies.

This repository remains GPL-3.0-only. Future manifests and source headers must use that exact SPDX identifier.
