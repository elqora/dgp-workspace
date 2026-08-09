# DGP Workspace

DGP Workspace is the complete framework-neutral editorial runtime for canonical DGP v1 product definitions. It composes DGP Core's stateful Builder with editing, Canvas state, Selection, Comments, Validation, persistence ports, branches, drafts, commits, snapshots, templates, collaboration invalidation, and publication orchestration.

It contains no React, React Flow, Form Palette, Ordering, Studio, rendering, preview, pricing, charge, fulfillment, or authorization-presentation code. DGP Studio owns those presentation bindings and consumes this package.

## Headless authoring

`CanvasAPI` owns the non-visual canvas state and exposes its `editor`, `selection`, and `comments` collaborators.

```ts
import { CanvasAPI, createAuthoringDescriptorRegistry } from "@elqora/dgp-workspace";
import { createProductBuilder } from "@elqora/dgp-core";

const canvas = new CanvasAPI(createProductBuilder(definition), {
  services,
  auto_emit_state: false,
});

canvas.editor.add_field({
  type: "text",
  label: "Account name",
  bind_id: "root",
});
canvas.set_position("field:account-name", 120, 80);
canvas.select(["field:account-name"]);

const registry = createAuthoringDescriptorRegistry([
  { type: "select", options: { supported: true, auto_create: true } },
]);
```

Editor mutations are transactional and undoable. The API covers canonical filter, field, and recursive-option CRUD; duplication and batch operations; relationships; capabilities; defaults; quantity and validation declarations; option and value effects; notices; service filtering; and service catalogs. Canvas snapshots cover graph projection, positions, viewport, selection, highlights, hover, edge mode, and per-field option-node visibility.

## Editorial sessions

`WorkspaceRuntime` binds headless authoring to a host `WorkspaceBackend`.

```ts
import { MemoryWorkspaceBackend, WorkspaceRuntime } from "@elqora/dgp-workspace";

const backend = new MemoryWorkspaceBackend({ definition, services });
const workspace = new WorkspaceRuntime(backend, {
  actor: { id: "editor-1", display_name: "Editor", meta: {} },
  autosave_ms: 9_000,
});

await workspace.boot();
workspace.editor?.relabel("field:account-name", "Customer account");
await workspace.autosave();
await workspace.commit("Clarify account field");
```

Drafts and commits persist both the canonical `ProductDefinition` and Workspace-owned editorial state. Branch switching and snapshot restoration therefore preserve layout, viewport, selection, option visibility, edge mode, and catalog state rather than saving only the protocol document.

Publication invokes DGP Validation with hydrated SDK-shaped services and backend-owned JSON policy rules. A non-publishable document returns `publication_validation_failed` without invoking backend publication. Optimistic revisions prevent stale writes, and stale autosave, refresh, comment, and branch responses do not overwrite newer local state.

## Collaboration and development adapters

Comments support load, create, reply, edit, message deletion, movement, resolution, thread deletion, optimistic rollback, server-assigned IDs, bounded automatic retry, manual retry, cancellation, and synchronization events. Live collaboration remains transport-neutral: the package includes manual and polling adapters, while hosts may implement the same port with SSE, WebSocket, or another transport.

`MemoryWorkspaceBackend` is a realistic development backend with branch revisions, conflicts, templates, comments, publication receipts, and an optional `MemoryWorkspacePersistence` port. The persistence port can be backed by IndexedDB, a filesystem, or another host store; persistence failures fall back to the live in-memory state and can be reported through `on_persistence_error`.

## Toolchain

DGP Workspace supports Node.js 22 or newer and npm with the committed lockfile.

```bash
npm install
npm run check
npm pack --dry-run
```

`npm run check` runs lint, strict type checking, the behavioral suite, dependency/source boundary enforcement, and the distributable build. Generated build output is not committed. Installation from the Git source runs `prepare`, so consumers receive `dist` artifacts.

## License

GPL-3.0-only.
