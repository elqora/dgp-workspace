# Workspace migration evidence

## Template correctness follow-up — 2026-09-30

Workspace now owns capture and atomic instantiation of reusable field templates. Fresh recursive field/option/notice IDs and rewritten internal references replace the unsafe single-field `add_field` template-drop path. Optional connected fields, their canonical relationships, node notices, and node fallbacks are editorial template data; Spec's authored product contract is unchanged. The memory backend treats `branch_id: null` as global scope independently of the main branch ID and persists global templates separately. Focused Workspace tests cover repeated insertion, undo/redo, invalid references, global visibility, persistence, cloning, and delayed save results. Service Builder must consume these APIs in its own follow-up; this repository does not contain the UI.

Selective capture now accepts a chosen subset of connected fields and per-field property keys while retaining the root and mandatory canonical properties. Workspace removes references to excluded nodes and rejects invalid requests. A separate optional group label is stored with the template; the host remains responsible for displaying it.

DGP Workspace is the framework-neutral destination for the complete behavior under legacy `src/react/canvas` and the non-React behavior formerly embedded in `src/react/workspace/context`. Historical placement below React barrels is an extraction seam, not presentation ownership.

Canonical v1 deliberately changes contract names and storage shapes: tags become filters, constraints become capabilities, quantity and validation declarations use their ratified snake-case fields, and Workspace snapshots separate canonical `ProductDefinition` data from editorial state. No legacy aliases, adapters, deprecated fields, or persisted-definition compatibility mode are included. The observable authoring, state, synchronization, and failure outcomes remain preserved.

## Complete 34-file canvas inventory

| Legacy source or test | Destination and canonical treatment | Status | Replacement evidence |
| --- | --- | --- | --- |
| `src/react/canvas/api.ts` | `src/canvas.ts`; headless graph, positions, viewport, selection mirror, hover, highlights, wire drafts, edge modes, option visibility, services, typed events, lifecycle, and editorial snapshots | **Verified** | `tests/editor-canvas.test.ts` CanvasAPI and persistence cases |
| `src/react/canvas/backend.ts` | `src/backend.ts`, `src/contracts.ts`, and Canvas comments ports; transport and authorization remain host-owned | **Verified** | `tests/comments.test.ts`, `tests/workspace.test.ts` |
| `src/react/canvas/comments.ts` | `src/comments.ts`; canonical comment DTOs, optimistic operations, rollback, server ID replacement, bounded backoff, retry/cancel, stale-response protection, and sync events | **Verified** | `tests/comments.test.ts` |
| `src/react/canvas/editor.ts` | `src/editor.ts`; canonical Editor facade, transactions, history, commands, event/error behavior, and Core Builder integration | **Verified** | `tests/editor-canvas.test.ts` transaction, history, mutation, relationship, effect, and catalog cases |
| `src/react/canvas/editor/editor-catalog.ts` | Workspace-owned snake-case `ServiceCatalogState`; full metadata, groups, smart rules, assignment modes, ordering, view state, resolution, cascade cleanup, and history independence | **Verified** | catalog cases in `tests/editor-canvas.test.ts` |
| `src/react/canvas/editor/editor-constraints.ts` | Canonical filter `capabilities`; Core resolves effective values and origins with ancestor precedence, while Editor preserves local contradictory intent and clear/override outcomes | **Verified** | capability cases in `tests/editor-canvas.test.ts`; Core capability suite at `bb06a70` |
| `src/react/canvas/editor/editor-duplicate.ts` | Canonical filter subtree, field, recursive-option, relationship, option-effect, and value-effect duplication with deterministic IDs and batch de-duplication | **Verified** | duplication and one-step undo cases in `tests/editor-canvas.test.ts` |
| `src/react/canvas/editor/editor-field-rules.ts` | Ratified `default_value`, `multiple`, `quantity`, and `validation`; strict canonical normalization drops malformed declarations without accepting legacy keys | **Verified** | field-rule cases in `tests/editor-canvas.test.ts`; Ordering expression ownership remains outside Workspace |
| `src/react/canvas/editor/editor-ids.ts` | Deterministic collision-safe filter, field, option, notice, and catalog IDs | **Verified** | CRUD, descriptor, duplicate, and multi-field option cases |
| `src/react/canvas/editor/editor-nodes.ts` | Canonical filter/field/recursive-option CRUD, descriptor creation, service and pricing-role changes, demotion cleanup, and batch operations | **Verified** | canonical mutation and descriptor cases |
| `src/react/canvas/editor/editor-notices.ts` | Ratified canonical notices, node targeting, batch type/removal, cleanup, and undo/redo | **Verified** | notice and deletion-cleanup cases |
| `src/react/canvas/editor/editor-option-effects.ts` | Ratified option-effect maps, patching, validation, force visibility, trigger/target cleanup, duplication, and restoration | **Verified** | option-effect and duplication cases |
| `src/react/canvas/editor/editor-placement.ts` | Workspace-owned node positions included in transactions, history, drafts, commits, branches, and snapshots | **Verified** | layout undo/redo and fresh-runtime persistence cases |
| `src/react/canvas/editor/editor-relations.ts` | Canonical bind/include/exclude/service wires, precedence, receiver validation, cycle prevention, disconnect, and incoming/owned cleanup | **Verified** | relationship, wire, cycle, and cleanup cases |
| `src/react/canvas/editor/editor-service-filter.ts` | Delegation to Core's SDK-shaped capability/rate filtering; rejection reasons are returned directly instead of retaining legacy policy objects | **Verified** | service-filter case in `tests/editor-canvas.test.ts`; Core filter suite at `bb06a70` |
| `src/react/canvas/editor/editor-types.ts` | Workspace-owned neutral types in `editor.ts`, `canvas.ts`, and `descriptors.ts`; shared protocol types are imported from Spec | **Verified** | strict type check plus boundary checker |
| `src/react/canvas/editor/editor-utils.ts` | Internal canonical recursive-option lookup, JSON-safe normalization, relationship cleanup, and ID utilities | **Verified** | recursive CRUD, malformed rule, cleanup, and duplicate cases |
| `src/react/canvas/editor/editor-value-effects.ts` | Ratified value effects for filter, button, and option triggers with set/clear, cleanup, duplication, and undo/redo | **Verified** | value-effect cases in `tests/editor-canvas.test.ts` |
| `src/react/canvas/events.ts` | `src/events.ts`; typed subscriptions, once/off/clear, snapshot-safe payloads, and consumer-failure isolation | **Verified** | Canvas event and listener-isolation cases |
| `src/react/canvas/selection.ts` | `src/selection.ts`; ordered selection, first-item primary fallback, current filter context, inherited visibility, trigger grouping, ancestry, children, and ordered base/utility service evidence | **Verified** | Selection cases in `tests/editor-canvas.test.ts`; Core visibility suite at `bb06a70` |
| `editor.batch-actions.spec.ts` | Mixed removal, one-step batch duplication, service/bind/relationship/default/validation/option/notice/pricing actions and cleanup | **Verified** | aggregated batch and cleanup cases in `tests/editor-canvas.test.ts` |
| `editor.catalog.spec.ts` | Complete catalog lifecycle and history independence | **Verified** | catalog cases in `tests/editor-canvas.test.ts` |
| `editor.constraints.spec.ts` | Effective capability inheritance, local intent, origins, clear override/subtree behavior, and undo/redo | **Verified** | capability cases plus Core capability tests |
| `editor.constraints-emitter.spec.ts` | Canonical capability mutation and undo/redo emit one coherent Editor change | **Verified** | transaction/event cases |
| `editor.default-values-and-value-effects.spec.ts` | Defaults, effects, trigger kinds, cleanup, batch relationship clearing, and restoration | **Verified** | default/effect/cleanup cases |
| `editor.history-redo.regression.spec.ts` | Multi-step undo/redo, redo preservation/invalidation, graph/layout restoration, and single history ownership | **Verified** | transaction/history cases |
| `editor.includes.test.ts` | Include/exclude precedence, receiver rules, cycles, option effects, demotion/removal cleanup, and duplication | **Verified** | relationship and effect cases |
| `editor.notices.spec.ts` | Notice IDs, add/update/remove/no-op, batch operations, and history | **Verified** | notice cases |
| `editor.quantity-rule.spec.ts` | Canonical quantity get/set/clear, malformed-shape removal, expression requirements, and history | **Verified** | quantity normalization cases |
| `editor.service-filter.spec.ts` | Core-owned service filtering with inherited capabilities and call-time rate policy inputs | **Verified** | Workspace delegation test and Core service-filter suite |
| `editor.utility-guard.spec.ts` | Utility/service mutual exclusion and undo restoration | **Verified** | utility guard case |
| `selection.inheritance.test.ts` | Context retention/fallback, multi-bind precedence, lineage visibility, trigger depth, and conflict behavior | **Verified** | Workspace Selection cases and Core visibility parity suite |
| `selection.test.ts` | Single/multi groups, ordered fields, forced fields/options, ancestry/children, and service ordering | **Verified** | Workspace Selection cases and Core visibility parity suite |
| `selection-get-selected-options.spec.ts` | Valid trigger selection and grouping by owning field | **Verified** | `selected_triggers` and `triggers_by_field` cases |

## Session, backend, and collaboration evidence

| Legacy concern | Canonical v1 result | Status | Replacement evidence |
| --- | --- | --- | --- |
| Provider boot and hydration | Actor-scoped boot, per-section status/errors, non-blocking comment failure, blocking dependency failure, safe structured hydration failure, and retry | **Verified** | boot and partial-failure cases in `tests/workspace.test.ts` |
| Canvas/provider lifecycle | Stable branch-owned Canvas/Builder/Editor instances, state hydration before consumption, service-context refresh, and disposal | **Verified** | branch/cache, service update, fresh-runtime, and disposal cases |
| Editorial document transitions | Immutable external state, dirty/saving/uncommitted/clean states, Validation invalidation, and newer-edit protection | **Verified** | state protection and autosave race cases |
| Drafts, commits, publication, and snapshots | Optimistic base revisions, full editorial snapshots, commit history, restore, Validation gating, receipts, and stale-response protection | **Verified** | autosave, commit, publication, policy, revision, and editorial persistence cases |
| Branches and cache | Create, switch, main selection, merge, delete protection, branch-local cache, stale refresh rejection, and snapshot restoration | **Verified** | branch lifecycle and refresh race cases |
| Templates | Create/update/clone/publish/unpublish/delete, key conflicts, full refresh replacement, timestamp-aware delta merge, and explicit missing-item reconciliation | **Verified** | template lifecycle and delta cases |
| Authors, participants, and permissions | Hydrated identities and participants, immutable state, distinct action gates, and Canvas comment authorization | **Verified** | authorization and boot cases |
| Backend publication policies | JSON policy rules hydrate and persist through Workspace, then compile into Validation-owned host policies | **Verified** | backend policy publication case |
| Live collaboration | Manual and bounded polling adapters, transport-neutral host port, branch/workspace invalidation, dirty-state deferral, cache invalidation, and cancellation | **Verified** | live invalidation and polling cases |
| Development persistence | Memory backend conflicts and lifecycle plus optional host persistence with seed bootstrap, stored-state precedence, sequence preservation, and in-memory fallback on persistence failure | **Verified** | persistence-port and runtime lifecycle cases |
| React providers, hooks, rendered canvas, panels, fallback UI, comments UI, and diagnostic presentation | DGP Studio; Workspace provides the stable headless APIs those bindings consume | **Assigned to Studio** | Explicit repository boundary; Studio remains outside this goal |

## Verification and boundary evidence

- Workspace replacement suite: 61 tests across `tests/editor-canvas.test.ts`, `tests/comments.test.ts`, and `tests/workspace.test.ts`.
- Lower-boundary parity: ratified Spec `de710c0`, completed Core `bb06a70`, and completed Validation `33073d8`.
- Mechanical enforcement rejects reverse dependencies, React/React Flow/Form Palette/Ordering/Studio imports, independently authored shared protocol types, forbidden legacy fields and aliases, and missing GPL-3.0-only source headers.
- `npm run check` covers lint, strict type checking, tests, boundary enforcement, and build. `npm pack --dry-run` verifies the distributable package, and `prepare` builds Git installations.
- No legacy repository was modified. No redesign or retirement was inferred; canonical contract/name changes follow the approved DGP v1 clean break while behavioral outcomes remain preserved.
