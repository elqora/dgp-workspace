# Agent guidance: DGP Workspace

Read and follow `../AGENTS.md` before working in this repository.

## Role

This repository supplies the reusable editorial session and backend-integration runtime for DGP authoring applications. Sibling `dgp-studio` consumes this role; application-specific presentation does not belong here.

## Dependencies

- May depend on sibling `dgp-spec`, `dgp-core`, and `dgp-validation`.
- Must not depend on `dgp-ordering`, `dgp-ordering-form-palette`, Form Palette, Studio, React Flow, or a host application.
- Optional React context and hooks may wrap the headless runtime, but visual components must remain outside this package.
- Keep host persistence, transport, authorization enforcement, and live collaboration behind adapters.

## Owned behavior

- Backend ports and result/error contracts.
- Boot, hydration, loadable state, and workspace session orchestration.
- Headless document state and mutation commands.
- Branches, drafts, commits, snapshots, dirty state, autosave, comments, templates, authors, participants, and publication coordination.
- Branch caching, refresh orchestration, live collaboration contracts, and optional development or memory adapters.
- Invocation and aggregation of `dgp-validation` results without owning validation rules or diagnostic presentation.

## Excluded behavior

- Visual canvases, React Flow adapters or nodes, layer trees, panels, toolbars, context-menu rendering, and property editors.
- Fallback-editor UI, comments UI, diagnostic consoles, boot-status surfaces, preview UI, and host-facing authorization messages.
- Customer ordering, customer-field expression execution, and backend fulfillment.
- Canonical protocol schemas, validation algorithms, service pricing, and charge behavior.
- Studio-specific permission vocabulary; accept host authorization decisions through contracts instead.

## References

- Legacy headless editorial sources: `D:\Projects\GitHub\digital-service-ui-builder\src\react\workspace\context`, including provider, backend, memory, boot, cache, refresh, autosave, and live-adapter behavior.
- Legacy canvas mutation behavior may be extracted where it is headless; do not migrate `src\react\workspace\components`, React Flow adapters, or fallback-editor presentation.
- Studio destination: sibling `../dgp-studio`; code and history migration source: `D:\Projects\GitHub\service-builder`.
- Backend reference: sibling `../dgp-sdk` at `D:\Projects\GitHub\elqora\digital-goods-protocol\dgp-sdk`.
- Sibling repositories: `../dgp-spec`, `../dgp-core`, `../dgp-validation`, `../dgp-ordering`, `../dgp-ordering-form-palette`, and `../dgp-studio`.
