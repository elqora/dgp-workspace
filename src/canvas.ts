// SPDX-License-Identifier: GPL-3.0-only

import type { HandlerService } from "@elqora/dgp-spec";
import type { ProductBuilder, ProductGraphSnapshot } from "@elqora/dgp-core";

import { CommentsAPI, type CommentSyncEvent, type CommentsDependencies } from "./comments.js";
import { Editor, type EditorChange, type EditorError, type ServiceCatalogState, type WireKind } from "./editor.js";
import { EventBus } from "./events.js";
import { Selection } from "./selection.js";
import type { WorkspaceEditorialState } from "./contracts.js";

export interface CanvasViewport { x: number; y: number; zoom: number; }
export type NodePositions = Record<string, { x: number; y: number }>;
export interface DraftWire { from: string; to?: string; kind: WireKind; }
export type CanvasEdgeMode = WireKind;

export interface CanvasState {
  graph: ProductGraphSnapshot;
  positions: NodePositions;
  selection: ReadonlySet<string>;
  highlighted: ReadonlySet<string>;
  hover_id?: string;
  viewport: CanvasViewport;
  draft_wire?: DraftWire;
  edge_mode: CanvasEdgeMode;
  shown_option_fields: ReadonlySet<string>;
  version: number;
}

export interface CanvasEvents {
  "state:change": CanvasState;
  "graph:update": ProductGraphSnapshot;
  "positions:change": NodePositions;
  "selection:change": { ids: string[]; primary?: string };
  "highlight:change": { ids: string[] };
  "hover:change": { id?: string };
  "viewport:change": CanvasViewport;
  "wire:preview": DraftWire;
  "wire:commit": Required<Pick<DraftWire, "from" | "to" | "kind">>;
  "wire:cancel": { from: string };
  "edge:change": CanvasEdgeMode;
  "options:visibility": { field_id: string; shown: boolean };
  "editor:change": EditorChange;
  "editor:error": EditorError;
  "catalog:change": { catalog?: ServiceCatalogState; reason: string };
  "catalog:active-change": { active_node_id?: string };
  "comment:select": { thread_id?: string };
  "comments:change": { thread_ids: string[] };
  "comments:error": { operation: string; error: unknown };
  "comment:sync": CommentSyncEvent;
}

export interface CanvasOptions {
  auto_emit_state?: boolean;
  initial_viewport?: Partial<CanvasViewport>;
  root_filter_id?: string;
  services?: readonly HandlerService[];
  comments?: CommentsDependencies;
}

function cloneGraph(graph: ProductGraphSnapshot): ProductGraphSnapshot {
  return { nodes: graph.nodes.map((node) => ({ ...node })), edges: graph.edges.map((edge) => ({ ...edge })) };
}

export class CanvasAPI {
  readonly builder: ProductBuilder;
  readonly editor: Editor;
  readonly selection: Selection;
  readonly comments: CommentsAPI;
  readonly #events = new EventBus<CanvasEvents>();
  readonly #autoEmit: boolean;
  #services: readonly HandlerService[];
  #state: CanvasState;
  #disposed = false;

  constructor(builder: ProductBuilder, options: CanvasOptions = {}) {
    this.builder = builder;
    this.#services = clone(options.services ?? []);
    this.#autoEmit = options.auto_emit_state ?? true;
    const rootFilterId = options.root_filter_id ?? builder.definition.filters[0]?.id;
    this.selection = new Selection(builder, {
      environment: "workspace",
      ...(rootFilterId === undefined ? {} : { root_filter_id: rootFilterId }),
      resolve_service: (id) => this.#services.find((service) => String(service.id) === String(id)),
    });
    const initialGraph = builder.tree();
    const initialOptionNodes = new Set(initialGraph.nodes.filter((node) => node.kind === "option").map((node) => node.id));
    initialGraph.nodes = initialGraph.nodes.filter((node) => !initialOptionNodes.has(node.id));
    initialGraph.edges = initialGraph.edges.filter((edge) => !initialOptionNodes.has(edge.from) && !initialOptionNodes.has(edge.to));
    this.#state = {
      graph: cloneGraph(initialGraph), positions: {}, selection: new Set(), highlighted: new Set(),
      viewport: { x: 0, y: 0, zoom: 1, ...options.initial_viewport }, edge_mode: "bind",
      shown_option_fields: new Set(), version: 1,
    };
    this.editor = new Editor(builder, {
      refresh_graph: () => this.refresh_graph(),
      snapshot_positions: () => this.#state.positions,
      restore_positions: (positions) => { this.#state.positions = clone(positions); this.#bump(); },
      emit_editor_change: (change) => this.#events.emit("editor:change", change),
      emit_editor_error: (failure) => this.#events.emit("editor:error", failure),
      emit_catalog_change: (catalog, reason) => {
        this.#events.emit("catalog:change", { ...(catalog === undefined ? {} : { catalog }), reason });
        if (reason === "view:active") this.#events.emit("catalog:active-change", { ...(catalog?.active_node_id === undefined ? {} : { active_node_id: catalog.active_node_id }) });
      },
    }, options.services === undefined ? {} : { services: options.services });
    this.comments = new CommentsAPI({
      ...options.comments,
      on_change: (threadIds) => { options.comments?.on_change?.(threadIds); this.#events.emit("comments:change", { thread_ids: threadIds }); },
      on_error: (operation, error) => { options.comments?.on_error?.(operation, error); this.#events.emit("comments:error", { operation, error }); },
      on_sync: (event) => { options.comments?.on_sync?.(event); this.#events.emit("comment:sync", event); },
    });
    this.selection.on_change((change) => {
      this.#state.selection = new Set(change.ids); this.#bump(); this.#events.emit("selection:change", change);
    });
    if (this.#autoEmit) this.#events.emit("state:change", this.snapshot());
  }

  on<Key extends keyof CanvasEvents>(event: Key, listener: (payload: CanvasEvents[Key]) => void): () => void { return this.#events.on(event, listener); }
  once<Key extends keyof CanvasEvents>(event: Key, listener: (payload: CanvasEvents[Key]) => void): () => void { return this.#events.once(event, listener); }
  emit<Key extends keyof CanvasEvents>(event: Key, payload: CanvasEvents[Key]): void { this.#events.emit(event, payload); }

  snapshot(): CanvasState {
    return {
      ...this.#state,
      graph: cloneGraph(this.#state.graph),
      positions: clone(this.#state.positions),
      selection: new Set(this.#state.selection),
      highlighted: new Set(this.#state.highlighted),
      shown_option_fields: new Set(this.#state.shown_option_fields),
      viewport: { ...this.#state.viewport },
      ...(this.#state.draft_wire === undefined ? {} : { draft_wire: { ...this.#state.draft_wire } }),
    };
  }

  get_graph(): ProductGraphSnapshot { return cloneGraph(this.#state.graph); }
  get_selection(): string[] { return [...this.#state.selection]; }
  get_viewport(): CanvasViewport { return { ...this.#state.viewport }; }
  get_capabilities(filterId: string): ReturnType<Editor["resolved_capabilities"]> { return this.editor.resolved_capabilities(filterId); }
  get_service(serviceId: string | number): HandlerService | undefined { return this.editor.services().find((service) => String(service.id) === String(serviceId)); }
  update_services(services: readonly HandlerService[]): void { this.#services = clone(services); this.editor.set_services(services); this.builder.setOptions({ services }); }
  editorial_state(): WorkspaceEditorialState {
    const catalog = this.editor.get_catalog();
    return {
      positions: clone(this.#state.positions), viewport: { ...this.#state.viewport }, selection_ids: [...this.#state.selection],
      highlighted_ids: [...this.#state.highlighted], ...(this.#state.hover_id === undefined ? {} : { hover_id: this.#state.hover_id }),
      edge_mode: this.#state.edge_mode, shown_option_fields: [...this.#state.shown_option_fields],
      ...(catalog === undefined ? {} : { catalog }),
    };
  }
  restore_editorial_state(state: WorkspaceEditorialState): void {
    this.#state.positions = clone(state.positions); this.#state.viewport = { ...state.viewport };
    this.#state.highlighted = new Set(state.highlighted_ids); this.#state.edge_mode = state.edge_mode;
    this.#state.shown_option_fields = new Set(state.shown_option_fields);
    if (state.hover_id === undefined) delete this.#state.hover_id; else this.#state.hover_id = state.hover_id;
    this.editor.set_catalog(state.catalog); this.selection.many(state.selection_ids); this.refresh_graph();
  }

  refresh_graph(): void {
    const graph = this.builder.tree();
    const shown = this.#state.shown_option_fields;
    if (shown.size === 0) {
      const optionNodes = new Set(graph.nodes.filter((node) => node.kind === "option").map((node) => node.id));
      graph.nodes = graph.nodes.filter((node) => !optionNodes.has(node.id));
      graph.edges = graph.edges.filter((edge) => !optionNodes.has(edge.from) && !optionNodes.has(edge.to));
    } else {
      const hiddenOptions = new Set(graph.nodes.filter((node) => node.kind === "option" && (node.field_id === undefined || !shown.has(node.field_id))).map((node) => node.id));
      graph.nodes = graph.nodes.filter((node) => !hiddenOptions.has(node.id));
      graph.edges = graph.edges.filter((edge) => !hiddenOptions.has(edge.from) && !hiddenOptions.has(edge.to));
    }
    this.#state.graph = graph; this.#bump(); this.#events.emit("graph:update", cloneGraph(graph));
  }

  set_positions(positions: NodePositions): void { this.#state.positions = { ...this.#state.positions, ...clone(positions) }; this.#bump(); this.#events.emit("positions:change", this.snapshot_positions()); }
  set_position(id: string, x: number, y: number): void { this.#state.positions = { ...this.#state.positions, [id]: { x, y } }; this.#bump(); this.#events.emit("positions:change", this.snapshot_positions()); }
  snapshot_positions(): NodePositions { return clone(this.#state.positions); }
  restore_positions(positions: Readonly<Record<string, { x: number; y: number }>>): void { this.#state.positions = clone(positions); this.#bump(); }

  select(ids: Iterable<string>, primary?: string): void { this.selection.many(ids, primary); }
  add_to_selection(ids: Iterable<string>): void {
    const next = new Set(this.selection.all()); let primary: string | undefined;
    for (const id of ids) { next.add(id); primary = id; }
    this.selection.many(next, primary);
  }
  toggle_selection(id: string): void { this.selection.toggle(id); }
  clear_selection(): void { this.selection.clear(); }
  select_comment(threadId?: string): void { this.#events.emit("comment:select", { ...(threadId === undefined ? {} : { thread_id: threadId }) }); }

  set_highlighted(ids: Iterable<string>): void { this.#state.highlighted = new Set(ids); this.#bump(); this.#events.emit("highlight:change", { ids: [...this.#state.highlighted] }); }
  set_hover(id?: string): void {
    if (id === undefined) delete this.#state.hover_id; else this.#state.hover_id = id;
    this.#bump(); this.#events.emit("hover:change", { ...(id === undefined ? {} : { id }) });
  }
  set_viewport(viewport: Partial<CanvasViewport>): void {
    this.#state.viewport = { ...this.#state.viewport, ...viewport }; this.#bump(); this.#events.emit("viewport:change", this.get_viewport());
  }

  start_wire(from: string, kind: WireKind): void {
    this.#state.draft_wire = { from, kind }; this.#bump(); this.#events.emit("wire:preview", { from, kind });
  }
  preview_wire(to?: string): void {
    const wire = this.#state.draft_wire; if (wire === undefined) return;
    this.#events.emit("wire:preview", { ...wire, ...(to === undefined ? {} : { to }) });
  }
  commit_wire(to: string): void {
    const wire = this.#state.draft_wire; if (wire === undefined) return;
    this.editor.connect(wire.kind, wire.from, to);
    this.#events.emit("wire:commit", { from: wire.from, to, kind: wire.kind });
    delete this.#state.draft_wire; this.#bump();
  }
  cancel_wire(): void {
    const wire = this.#state.draft_wire; if (wire === undefined) return;
    delete this.#state.draft_wire; this.#bump(); this.#events.emit("wire:cancel", { from: wire.from });
  }

  get_edge_mode(): CanvasEdgeMode { return this.#state.edge_mode; }
  set_edge_mode(mode: CanvasEdgeMode): void {
    if (this.#state.edge_mode === mode) return; this.#state.edge_mode = mode; this.#bump(); this.#events.emit("edge:change", mode);
  }

  shown_option_fields(): string[] { return [...this.#state.shown_option_fields]; }
  options_shown(fieldId: string): boolean { return this.#state.shown_option_fields.has(fieldId); }
  set_options_shown(fieldId: string, shown: boolean): void {
    const next = new Set(this.#state.shown_option_fields);
    if (shown) next.add(fieldId); else next.delete(fieldId);
    if (equalSets(next, this.#state.shown_option_fields)) return;
    this.#state.shown_option_fields = next; this.refresh_graph(); this.#events.emit("options:visibility", { field_id: fieldId, shown });
  }
  toggle_options(fieldId: string): boolean { const shown = !this.options_shown(fieldId); this.set_options_shown(fieldId, shown); return shown; }
  set_shown_option_fields(ids: Iterable<string>): void {
    const next = new Set(ids); if (equalSets(next, this.#state.shown_option_fields)) return;
    const affected = new Set([...next, ...this.#state.shown_option_fields]);
    this.#state.shown_option_fields = next; this.refresh_graph();
    for (const fieldId of affected) this.#events.emit("options:visibility", { field_id: fieldId, shown: next.has(fieldId) });
  }

  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.comments.dispose(); this.#events.clear(); }

  #bump(): void { this.#state.version += 1; if (this.#autoEmit) this.#events.emit("state:change", this.snapshot()); }
}

function clone<T>(value: T): T { return structuredClone(value); }
function equalSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
