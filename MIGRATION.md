# Workspace migration evidence

| Concern | Legacy evidence | DGP v1 disposition |
| --- | --- | --- |
| Boot and hydration | provider boot composition and backend runtime | Retain actor-scoped boot, canonical hydration, explicit ready/error state, refresh, and branch context loading behind one host port. |
| Editorial document | snapshot slice | Retain immutable mutation commands, dirty/saving/uncommitted/clean state, drafts, commits, and restoreable commit snapshots over `ProductDefinition`. |
| Autosave | snapshot autosave hook | Retain configurable autosave; add revision checks so stale responses cannot mark newer edits clean. |
| Branches | branch slice and cache hook | Retain create, switch, cache, merge, delete, and main-branch operations without React state ownership. |
| Publication | snapshot publication flow | Delegate diagnostics to DGP Validation and block the backend publication call unless protocol and host-policy validation are publishable. |
| Templates/comments | template and comment slices | Retain headless branch-scoped CRUD through backend ports. Presentation remains in Studio. |
| Authors/participants/permissions | provider slices | Retain hydrated collaboration identity and host authorization decisions. Workspace reports denials but defines no permission UI. |
| Live collaboration | polling/SSE/WS adapters | Redesign as a transport-neutral invalidation adapter. Hosts own polling, SSE, WebSocket, authentication, and reconnection policy. |
| Development backend | legacy memory backend | Retain a deterministic in-memory adapter for development and contract tests using canonical v1 documents only. |

Retired: editor snapshots containing canvas/UI state, React Flow, panels,
fallback-editor presentation, compatibility definitions, Ordering previews,
frontend pricing, and Studio-specific authorization presentation.
