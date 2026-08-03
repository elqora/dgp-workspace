# DGP Workspace

DGP Workspace provides the reusable editorial session and backend-integration runtime for authoring applications such as DGP Studio. It owns headless state and orchestration, not the visual editor.

## Responsibilities

- Backend ports, boot, hydration, and workspace session orchestration
- Headless document state and mutation commands
- Templates, comments, authors, participants, and host authorization decisions
- Branches, drafts, commits, snapshots, dirty state, autosave, and publication coordination
- Branch caching, refresh, persistence, and live-collaboration adapter contracts
- Invocation and aggregation of DGP Validation results without owning diagnostic rules or presentation

Visual canvases, React Flow adapters, panels, property editors, fallback UI, comments UI, diagnostics consoles, preview, and publication presentation belong to DGP Studio. Customer ordering belongs to DGP Ordering, runtime interpretation belongs to DGP Core, and backend fulfillment belongs to the DGP SDK.

## Ecosystem

- [DGP Spec](https://github.com/elqora/dgp-spec) owns canonical contracts.
- [DGP Core](https://github.com/elqora/dgp-core) interprets definitions.
- [DGP Validation](https://github.com/elqora/dgp-validation) supplies reusable diagnostics.
- [DGP Ordering](https://github.com/elqora/dgp-ordering) renders customer ordering experiences.
- [DGP Ordering Form Palette](https://github.com/elqora/dgp-ordering-form-palette) provides the optional Form Palette ordering integration.
- [DGP Studio](https://github.com/elqora/dgp-studio) provides visual authoring, testing, preview, and publication UX.
- [DGP SDK](https://github.com/elqora/dgp-sdk) defines backend execution.
- [Digital Service Engine](https://github.com/timeax/digital-service-engine) is the legacy migration source and behavioral reference.

## Status

Repository scaffold only. Workspace extraction and migration will be planned separately.

## License

GPL-3.0.
