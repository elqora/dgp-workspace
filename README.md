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

## Usage

`WorkspaceRuntime` consumes a host `WorkspaceBackend`. The bundled memory backend
is intended for development and contract tests.

```ts
const backend = new MemoryWorkspaceBackend({ definition });
const workspace = new WorkspaceRuntime(backend, {
  actor: { id: "editor-1", display_name: "Editor", meta: {} },
  autosave_ms: 9000,
});

await workspace.boot();
workspace.mutate((current) => ({ ...current, name: "Updated product" }));
await workspace.autosave();
await workspace.commit("Describe the change");
```

Publication invokes DGP Validation and returns a structured
`publication_validation_failed` result without calling the backend when the
definition or host policies are not publishable. Workspace stores diagnostics
but owns no diagnostics UI.

Backend adapters own persistence, transport, authentication, authorization
enforcement, merge policy, and publication side effects. Live adapters emit
workspace or branch invalidations; hosts remain responsible for polling,
WebSocket/SSE lifecycles, authentication, and reconnection.

## Toolchain

DGP Workspace supports Node.js 22 or newer and npm with the committed lockfile.

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run check:boundaries
npm run build
npm run check
```

No generated outputs are committed. `npm run check` is the repository
completion command.

## License

GPL-3.0-only.
