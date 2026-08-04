# Agent guidance: DGP Workspace

Read and follow `../AGENTS.md` before working in this repository.

## Role

This repository supplies the complete reusable, framework-neutral editorial system for canonical DGP `ProductDefinition` authoring. It integrates Core's canonical Builder with the Editor, `CanvasAPI`, Selection, Comments, backend/session facilities, collaboration, Validation, and publication. Studio consumes these APIs and owns their React bindings and visual presentation.

## Dependencies

- May depend on sibling `dgp-spec`, `dgp-core`, and `dgp-validation`.
- Must not depend on Ordering, the Form Palette adapter, Form Palette, Studio, React, React Flow, or a host application.
- All React providers, hooks, and components belong to Studio. Workspace APIs must remain usable by any framework or third-party Studio.
- Keep persistence, transport, authorization enforcement, and live collaboration behind host adapters.

## Owned behavior

- Integration of Core's canonical Builder, `ProductIndex`, graph projection, authoring normalization, and deterministic save preparation.
- Framework-neutral Canvas state and API: graph snapshots, positions, viewport, selection, hover and highlights, wiring drafts, edge modes, option-node visibility, typed events, and lifecycle.
- Editor transactions, commands, history, undo/redo, node CRUD, placement, duplication, batch actions, reference cleanup, and change/error events.
- Stateful Selection behavior: current context, inherited visibility, trigger grouping, visible groups, and ordered service evidence.
- Relationships and cycle prevention, constraints, defaults, quantity and validation declarations, notices, option/value effects, catalogs, and policy-aware service filtering.
- Comments API lifecycle, optimistic synchronization, replies, edits, movement, resolution, deletion, retry/cancellation, and backend failures.
- Backend ports and structured result/error contracts.
- Boot, hydration, loadable state, editorial sessions, canonical document state, and mutation commands.
- Branches, drafts, commits, snapshots, dirty state, autosave, comments, templates, authors, participants, and publication coordination.
- Branch caching, refresh, live-collaboration contracts, and optional development or memory adapters.
- Invocation and aggregation of `dgp-validation` results without owning validation rules or diagnostic presentation.

## Boundaries

- Orchestrate canonical v1 `ProductDefinition` documents only. Do not load, convert, or preserve legacy definitions, aliases, deprecated fields, or compatibility modes. Use Core's canonical authoring normalization without silently repairing external published definitions.
- Do not provide React providers or hooks, rendered canvases, React Flow adapters, layer trees, panels, property editors, fallback UI, comments UI, diagnostics consoles, previews, or authorization presentation. `CanvasAPI` and canvas state are framework-neutral Workspace behavior and are not excluded by this rule.
- Preserve descriptor-based field creation through a neutral Workspace-owned authoring descriptor contract. Studio adapts React and input registries to that contract; Workspace must not import them.
- Do not perform customer ordering, expression execution, advisory utility calculation, pricing, charges, or fulfillment.
- Treat `meta` as opaque host-owned data.
- Accept host authorization decisions through contracts instead of defining Studio-specific permission presentation.

## Authority

Spec owns shared representation, SDK owns backend domain semantics, Core owns interpretation primitives, and Validation owns diagnostics. Proven legacy editorial behavior must be preserved by default. Workspace composes those concerns without redefining them.

Ratified means the versioned plain TypeScript contract, required JSON fixtures, rationale, and stable status are merged into `dgp-spec/main`; generated JSON Schemas must also be current once tooling exists. Released means that ratified Spec version is tagged and published. Workspace may implement ratified unreleased contracts, but stable releases require released versions of its protocol dependencies.

## Migration completeness

- Treat all 34 files and tests under legacy `src/react/canvas` as binding Workspace evidence despite the historical directory name. The tree contains framework-neutral behavior; dependency imports through React barrels are extraction seams, not ownership evidence.
- Preserve full Editor, Canvas API, Selection, Comments, graph state, mutation, history, relationship, effect, constraint, rule, catalog, service-filtering, descriptor, boot, hydration, document-transition, draft, autosave, commit, snapshot, branch, cache, template, author, participant, permission, publication, live-update, and development-adapter behavior.
- Preserve concurrency safety: stale and out-of-order responses, optimistic base revisions, branch changes, live invalidations, and external mutation must not silently corrupt or overwrite editorial state.
- Moving visual presentation to Studio does not permit dropping its underlying headless state or orchestration behavior.
- Port or replace the complete legacy canvas/editor test suite plus applicable provider, slice, cache, persistence, authorization, and live-adapter tests. Real host ports remain replaceable, but the contracts and failure behavior must be proven.
- Mark missing behavior as **pending migration**. Redesign or retirement requires explicit recorded user approval; a session/backend-only slice is not a complete Workspace and must not support another stable release.

## Change workflow and operations

- Update Workspace after affected Spec, Core/SDK, and Validation changes; do not make it establish contracts needed by lower-level packages.
- Commit and release this repository independently.
- The package supports Node.js 22 or newer. Use `npm install`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run check:boundaries`; `npm run check` is the completion command.
- No generated outputs are committed. Boundary checks must prevent Ordering, Form Palette, Studio, React, React Flow, visual-component, legacy-field, independently authored contract, and dependency-direction drift; they do not establish migration completeness.

## References

- Dependencies: siblings `../dgp-spec`, `../dgp-core`, and `../dgp-validation`.
- Shared-contract guide: sibling `../dgp-spec/CONTRACTS.md`.
- Backend evidence: sibling `../dgp-sdk`.
- Legacy Workspace evidence: the complete `D:\Projects\GitHub\digital-service-ui-builder\src\react\canvas` tree plus `src\react\workspace\context` for session/backend behavior.
- Migrate every framework-neutral behavior under the legacy canvas path. Do not migrate React providers/hooks, rendered components, React Flow adapters, or fallback-editor presentation into Workspace.
- Studio source evidence: `D:\Projects\GitHub\service-builder`; destination: sibling `../dgp-studio`.
- Ordering siblings are `../dgp-ordering` and `../dgp-ordering-form-palette`, not dependencies.

This repository remains GPL-3.0-only. Future manifests and source headers must use that exact SPDX identifier.
