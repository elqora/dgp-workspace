// SPDX-License-Identifier: GPL-3.0-only

import { createProductBuilder } from "@elqora/dgp-core";
import type { HandlerService, ProductDefinition } from "@elqora/dgp-spec";
import { describe, expect, it, vi } from "vitest";

import { CanvasAPI, createAuthoringDescriptorRegistry } from "../src/index.js";

function definition(): ProductDefinition {
  return {
    id: "product", name: "Product", schema_version: "1",
    filters: [{ id: "root", label: "Root" }, { id: "child", label: "Child", bind_id: "root" }],
    fields: [
      { id: "name", type: "text", label: "Name", bind_id: "root" },
      { id: "a", type: "toggle", label: "A", bind_id: "root", button: true },
      { id: "b", type: "toggle", label: "B", bind_id: "root", button: true },
      { id: "plan", type: "select", label: "Plan", bind_id: "root", options: [
        { id: "basic", label: "Basic", service_id: "basic-service" },
        { id: "premium", label: "Premium", children: [{ id: "priority", label: "Priority" }] },
      ] },
    ],
    order_for_tags: { root: ["name", "a", "b", "plan"] },
    includes_for_buttons: {}, excludes_for_buttons: {}, option_effects_for_buttons: {}, value_effects_for_triggers: {},
    fallbacks: null, description: null, notices: [], meta: {},
  };
}

function service(id: string, capability = true, rate = 10): HandlerService {
  return {
    id, name: id, description: null, category: null, rate, min: 1, max: 100,
    capabilities: { refill: { id: "refill", enabled: capability, description: null, meta: {} } }, meta: {}, state: "enabled", state_reason: null,
  };
}

function setup(input = definition(), services: HandlerService[] = []) {
  const canvas = new CanvasAPI(createProductBuilder(input), { auto_emit_state: false, services });
  return { canvas, editor: canvas.editor, builder: canvas.builder };
}

describe("CanvasAPI headless state", () => {
  it("snapshots graph, positions, selection, highlights, viewport, and versions immutably", () => {
    const { canvas } = setup();
    const before = canvas.snapshot();
    canvas.set_position("name", 4, 9);
    canvas.select(["name"]);
    canvas.set_highlighted(["a"]);
    canvas.set_hover("b");
    canvas.set_viewport({ x: 20, zoom: 2 });
    const after = canvas.snapshot();
    expect(after).toMatchObject({ positions: { name: { x: 4, y: 9 } }, viewport: { x: 20, y: 0, zoom: 2 }, hover_id: "b" });
    expect([...after.selection]).toEqual(["name"]);
    expect([...after.highlighted]).toEqual(["a"]);
    expect(after.version).toBeGreaterThan(before.version);
    (after.positions["name"] as { x: number }).x = 99;
    expect(canvas.snapshot_positions()["name"]?.x).toBe(4);
  });

  it("emits typed state, selection, hover, viewport, edge, and comment-selection events", () => {
    const { canvas } = setup();
    const state = vi.fn(); const selection = vi.fn(); const hover = vi.fn(); const viewport = vi.fn(); const edge = vi.fn(); const comment = vi.fn();
    canvas.on("state:change", state); canvas.on("selection:change", selection); canvas.on("hover:change", hover);
    canvas.on("viewport:change", viewport); canvas.on("edge:change", edge); canvas.on("comment:select", comment);
    canvas.select(["name"], "name"); canvas.set_hover("a"); canvas.set_viewport({ y: 8 }); canvas.set_edge_mode("exclude"); canvas.select_comment("thread");
    expect(selection).toHaveBeenCalledWith({ ids: ["name"], primary: "name" });
    expect(hover).toHaveBeenCalledWith({ id: "a" }); expect(viewport).toHaveBeenCalled(); expect(edge).toHaveBeenCalledWith("exclude");
    expect(comment).toHaveBeenCalledWith({ thread_id: "thread" }); expect(state).not.toHaveBeenCalled();
  });

  it("isolates consumer event failures from editorial state transitions", () => {
    const { canvas } = setup(); const reached = vi.fn(); canvas.on("viewport:change", () => { throw new Error("consumer"); }); canvas.on("viewport:change", reached);
    expect(() => canvas.set_viewport({ x: 2 })).not.toThrow(); expect(reached).toHaveBeenCalled(); expect(canvas.get_viewport().x).toBe(2);
  });

  it("updates Builder, Editor, and Selection service context without recreating the Canvas", () => {
    const { canvas } = setup(); const updated = service("updated"); canvas.update_services([updated]);
    expect(canvas.get_service("updated")).toEqual(updated); expect(canvas.builder.services()).toEqual([updated]);
  });

  it("supports add/toggle/clear selection and preserves primary recency", () => {
    const { canvas } = setup();
    canvas.select(["name"]); canvas.add_to_selection(["a", "b"]);
    expect(canvas.get_selection()).toEqual(["name", "a", "b"]); expect(canvas.selection.primary()).toBe("b");
    canvas.toggle_selection("a"); expect(canvas.get_selection()).toEqual(["name", "b"]);
    canvas.clear_selection(); expect(canvas.get_selection()).toEqual([]);
  });

  it("uses the first selected item as the default primary and fallback after removal", () => {
    const { canvas } = setup(); canvas.select(["name", "a", "b"]); expect(canvas.selection.primary()).toBe("name");
    canvas.selection.remove("name"); expect(canvas.selection.primary()).toBe("a");
  });

  it("hides option graph nodes by default and restores ancestor option nodes per field", () => {
    const { canvas } = setup();
    expect(canvas.get_graph().nodes.some((node) => node.kind === "option")).toBe(false);
    expect(canvas.toggle_options("plan")).toBe(true);
    expect(canvas.get_graph().nodes.filter((node) => node.kind === "option").map((node) => node.id)).toEqual(["basic", "premium", "priority"]);
    canvas.set_shown_option_fields([]); expect(canvas.options_shown("plan")).toBe(false);
  });

  it("previews, commits through Editor, cancels wires, and changes edge mode", () => {
    const { canvas, builder } = setup();
    const preview = vi.fn(); const commit = vi.fn(); const cancel = vi.fn();
    canvas.on("wire:preview", preview); canvas.on("wire:commit", commit); canvas.on("wire:cancel", cancel);
    canvas.start_wire("a", "include"); canvas.preview_wire("name"); canvas.commit_wire("name");
    expect(builder.definition.includes_for_buttons).toEqual({ a: ["name"] }); expect(commit).toHaveBeenCalled();
    canvas.start_wire("a", "exclude"); canvas.cancel_wire(); expect(cancel).toHaveBeenCalledWith({ from: "a" });
  });
});

describe("Editor transactions and history", () => {
  it("commits nested transactions as one history entry and emits one change", () => {
    const { canvas, editor, builder } = setup(); const changes = vi.fn(); canvas.on("editor:change", changes);
    editor.transact("batch", () => { editor.relabel("name", "Full name"); editor.set_field_name("name", "customer_name"); });
    expect(builder.definition.fields[0]).toMatchObject({ label: "Full name", name: "customer_name" });
    expect(changes).toHaveBeenCalledTimes(1); expect(editor.undo()).toBe(true); expect(editor.undo()).toBe(false);
    expect(builder.definition.fields[0]).toMatchObject({ label: "Name" });
  });

  it("rolls back a failed transaction and emits an error without history", () => {
    const { canvas, editor, builder } = setup(); const errors = vi.fn(); canvas.on("editor:error", errors);
    expect(() => editor.transact("bad", () => { editor.relabel("name", "Broken"); throw new Error("stop"); })).toThrow("stop");
    expect(builder.definition.fields[0]?.label).toBe("Name"); expect(editor.can_undo()).toBe(false); expect(errors).toHaveBeenCalledTimes(1);
  });

  it("restores structural, property, rule, and layout changes through undo/redo", () => {
    const { canvas, editor, builder } = setup();
    const id = editor.add_filter({ label: "Extra" }); editor.relabel(id, "Renamed"); editor.set_capability(id, "refill", true); editor.place_node(id, 5, 7);
    expect(canvas.snapshot_positions()[id]).toEqual({ x: 5, y: 7 });
    for (let count = 0; count < 4; count += 1) expect(editor.undo()).toBe(true);
    expect(builder.definition.filters.some((filter) => filter.id === id)).toBe(false);
    for (let count = 0; count < 4; count += 1) expect(editor.redo()).toBe(true);
    expect(builder.definition.filters.find((filter) => filter.id === id)).toMatchObject({ label: "Renamed", capabilities: { refill: true } });
  });

  it("preserves redo after pure undo and invalidates it after a new mutation", () => {
    const { editor } = setup(); editor.relabel("name", "One"); editor.relabel("name", "Two");
    editor.undo(); expect(editor.can_redo()).toBe(true); editor.redo(); editor.undo(); expect(editor.can_redo()).toBe(true);
    editor.relabel("name", "Branch"); expect(editor.can_redo()).toBe(false);
  });
});

describe("Editor canonical mutations", () => {
  it("adds, updates, removes filters, fields, and recursive options with deterministic ids", () => {
    const { editor, builder } = setup();
    const filter = editor.add_filter({ label: "Group" }); const field = editor.add_field({ type: "select", label: "Choice", bind_id: filter });
    const parent = editor.add_option(field, { label: "Parent" }); const child = editor.add_option(field, { label: "Child" }, parent);
    editor.update_option(child, { label: "Nested" }); editor.update_filter(filter, { label: "Updated group" });
    expect(builder.index.getOption(child)).toMatchObject({ label: "Nested" });
    editor.remove(parent); expect(builder.index.getOption(parent)).toBeUndefined(); expect(builder.index.getOption(child)).toBeUndefined();
    editor.remove_many([filter, field, "missing"]); expect(builder.index.getFilter(filter)).toBeUndefined(); expect(builder.index.getField(field)).toBeUndefined();
  });

  it("cleans incoming and owned maps, effects, ordering, fallbacks, and notices on deletion", () => {
    const product = definition();
    product.includes_for_buttons.a = ["name"]; product.excludes_for_buttons.b = ["name"];
    product.option_effects_for_buttons.basic = { plan: { include: ["premium"] } };
    product.value_effects_for_triggers.a = { name: { value: "x" } };
    product.fallbacks = { nodes: { name: ["fallback"] } };
    product.notices.push({ id: "notice", type: "public", kind: "label", severity: "info", target: { scope: "node", node_kind: "field", node_id: "name" }, title: "Name" });
    const { editor, builder } = setup(product); editor.remove("name");
    expect(builder.definition.includes_for_buttons.a).toBeUndefined(); expect(builder.definition.excludes_for_buttons.b).toBeUndefined();
    expect(builder.definition.value_effects_for_triggers.a).toBeUndefined(); expect(builder.definition.order_for_tags.root).not.toContain("name");
    expect(builder.definition.fallbacks?.nodes?.name).toBeUndefined(); expect(builder.definition.notices).toEqual([]);
  });

  it("cleans selectable defaults when referenced options are removed", () => {
    const product = definition(); const plan = product.fields.find((field) => field.id === "plan"); if (plan === undefined) throw new Error("missing plan"); plan.multiple = true; plan.default_value = ["basic", "premium"];
    const { editor, builder } = setup(product); editor.remove("basic"); expect(builder.index.getField("plan")?.default_value).toEqual(["premium"]); editor.remove("premium"); expect(builder.index.getField("plan")?.default_value).toBeUndefined();
  });

  it("duplicates nodes in input order, avoids double option copies, and uses one undo step", () => {
    const { editor, builder } = setup();
    const created = editor.duplicate_many([{ kind: "field", id: "plan" }, { kind: "option", field_id: "plan", id: "basic" }, { kind: "field", id: "name" }]);
    expect(created).toHaveLength(2); expect(builder.definition.fields[1]?.label).toBe("Name copy"); expect(builder.definition.fields.at(-1)?.label).toBe("Plan copy");
    editor.undo(); expect(builder.definition.fields).toHaveLength(4);
  });

  it("duplicates filter subtrees and remaps copied relationships and effects", () => {
    const { editor, builder } = setup();
    const subtree = editor.duplicate({ kind: "filter", id: "root" }, { with_children: true, copy_bindings: false });
    expect(builder.definition.filters.find((filter) => filter.bind_id === subtree)).toBeDefined();
    editor.set_option_effect("basic", "plan", { include: ["premium"] }); editor.set_value_effect("basic", "name", { value: "copied" });
    const copiedField = editor.duplicate({ kind: "field", id: "plan" }, { copy_relationships: true, copy_effects: true, option_id: (id) => `${id}-copy` });
    const copiedBasic = builder.index.getField(copiedField)?.options?.[0]?.id; expect(copiedBasic).toBe("basic-copy");
    expect(builder.definition.option_effects_for_buttons[copiedBasic as string]?.[copiedField]).toEqual({ include: ["premium-copy"] });
    expect(builder.definition.value_effects_for_triggers[copiedBasic as string]?.name).toEqual({ value: "copied" });
  });

  it("guards utility options from service assignments and restores with undo", () => {
    const { editor, builder } = setup(); editor.update_option("basic", { utility: { rate: 2, mode: "flat" } });
    expect(builder.index.getOption("basic")?.service_id).toBeUndefined(); expect(() => editor.set_service("basic", "x")).toThrow("Utility");
    editor.undo(); expect(builder.index.getOption("basic")?.service_id).toBe("basic-service");
  });

  it("supports descriptor defaults, option auto-creation, variants, and multi auto-enable", () => {
    const registry = createAuthoringDescriptorRegistry([{ type: "choice", variant: "cards", defaults: { columns: 3 }, options: { supported: true, auto_create: true, default_label: "First", default_value: "first" }, multi: { supported: true, auto_enable: true } }]);
    const descriptor = registry.resolve("choice", "cards"); if (descriptor === undefined) throw new Error("missing descriptor");
    const { editor, builder } = setup(); const id = editor.add_field_from_descriptor(descriptor, { label: "Choice", bind_id: "root" });
    expect(builder.index.getField(id)).toMatchObject({ variant: "cards", multiple: true, defaults: { columns: 3 }, options: [{ label: "First", value: "first" }] });
    const plain = editor.add_field_from_descriptor({ type: "text" }, { label: "Plain", bind_id: "root" }); expect(builder.index.getField(plain)?.multiple).toBeUndefined();
  });

  it("normalizes selectable defaults and clears invalid or empty defaults", () => {
    const { editor, builder } = setup(); editor.set_field_default("plan", ["missing", "basic"]);
    expect(builder.index.getField("plan")?.default_value).toBe("basic"); editor.set_field_default("plan", []); expect(builder.index.getField("plan")?.default_value).toBeUndefined();
  });

  it("preserves host defaults while clearing canonical default values for many fields", () => {
    const product = definition(); const field = product.fields[0]; if (field === undefined) throw new Error("missing field");
    product.fields[0] = { ...field, default_value: "Ada", defaults: { placeholder: "Name" } };
    const { editor, builder } = setup(product); editor.clear_field_defaults(["name", "plan"]);
    expect(builder.index.getField("name")).toMatchObject({ defaults: { placeholder: "Name" } }); expect(builder.index.getField("name")?.default_value).toBeUndefined();
  });

  it("sets canonical multiple, quantity, and validation declarations and clears them", () => {
    const { editor, builder } = setup();
    editor.set_field_multiple("plan", true); editor.set_field_quantity("name", { value_by: "length", multiply: 2 });
    editor.set_field_validation("name", [{ value_by: "length", op: "gte", value: 2 }]);
    expect(builder.index.getField("plan")?.multiple).toBe(true); expect(builder.index.getField("name")).toMatchObject({ quantity: { value_by: "length" }, validation: [{ op: "gte" }] });
    editor.set_field_quantity("name"); editor.set_field_validation("name"); expect(builder.index.getField("name")?.quantity).toBeUndefined();
  });

  it("normalizes canonical quantity and validation authoring inputs", () => {
    const { editor, builder } = setup();
    editor.set_field_quantity("name", { value_by: "weird", multiply: 2 }); expect(editor.get_field_quantity("name")).toBeUndefined();
    editor.set_field_quantity("name", { value_by: "length", multiply: 2, expression: { language: "javascript", body: "ignored" }, clamp: { min: 1, max: Number.NaN } });
    expect(editor.get_field_quantity("name")).toEqual({ value_by: "length", multiply: 2, clamp: { min: 1 } });
    editor.set_field_quantity("name", { value_by: "eval", expression: { language: "javascript", body: " " } }); expect(editor.get_field_quantity("name")).toBeUndefined();
    editor.set_field_quantity("name", { value_by: "eval", expression: { language: "javascript", body: "return values.length" }, fallback: 1 });
    expect(editor.get_field_quantity("name")).toMatchObject({ value_by: "eval", expression: { body: "return values.length" }, fallback: 1 });

    editor.set_field_validation("name", [{ op: "bogus" }, { op: "gte", value_by: "length", value: 2, unknown: true }, { op: "eq", value: Number.NaN }]);
    expect(editor.get_field_validation("name")).toEqual([{ op: "gte", value_by: "length", value: 2 }, { op: "eq" }]);
    editor.set_field_validation("name", { op: "truthy" }); expect(builder.index.getField("name")?.validation).toEqual([{ op: "truthy" }]);
    editor.set_field_validation("name", { op: "eq", value_by: "eval", expression: { language: "javascript", body: "" } }); expect(editor.get_field_validation("name")).toBeUndefined();
  });

  it("auto-creates only missing options and clears option references in one transaction", () => {
    const { editor, builder } = setup(); const second = editor.add_field({ type: "text", label: "Second", bind_id: "root" }); editor.auto_create_options(["name", second, "plan"]); expect(builder.index.getField("name")?.options).toHaveLength(1); expect(builder.index.getField("plan")?.options).toHaveLength(2);
    expect(builder.index.getField("name")?.options?.[0]?.id).not.toBe(builder.index.getField(second)?.options?.[0]?.id);
    editor.set_option_effect("basic", "plan", { include: ["premium"] }); editor.clear_options(["plan"]);
    expect(builder.index.getField("plan")?.options).toBeUndefined(); expect(builder.definition.option_effects_for_buttons).toEqual({});
  });
});

describe("Editor relationships, effects, capabilities, notices, and catalog", () => {
  it("applies include/exclude precedence to filters, buttons, and options", () => {
    const { editor, builder } = setup(); editor.include("root", "name"); editor.exclude("root", "name");
    editor.include("a", "name"); editor.exclude("a", "name"); editor.include("basic", "name");
    expect(builder.index.getFilter("root")).toMatchObject({ excludes: ["name"] });
    expect(builder.index.getFilter("root")?.includes).toBeUndefined();
    expect(builder.definition.excludes_for_buttons.a).toEqual(["name"]); expect(builder.definition.includes_for_buttons.basic).toEqual(["name"]);
  });

  it("rejects invalid receivers and relationship cycles with rollback", () => {
    const { editor, builder } = setup(); expect(() => editor.include("name", "plan")).toThrow("cannot receive");
    editor.include("a", "b"); expect(() => editor.exclude("b", "a")).toThrow("cycle"); expect(builder.definition.excludes_for_buttons.b).toBeUndefined();
  });

  it("connects/disconnects bind, include, exclude, and service relationships", () => {
    const { editor, builder } = setup(); editor.connect("bind", "child", "name"); editor.connect("include", "a", "name"); editor.connect("service", "a", "service:42");
    expect(builder.index.getField("name")?.bind_id).toEqual(["root", "child"]); const button = builder.index.getField("a"); expect(button?.button === true ? button.service_id : undefined).toBe(42);
    editor.disconnect("bind", "child", "name"); editor.disconnect("include", "a", "name"); editor.disconnect("service", "a", "service:42");
    expect(builder.index.getField("name")?.bind_id).toBe("root"); expect(builder.definition.includes_for_buttons.a).toBeUndefined();
  });

  it("clears relationships without deleting nodes, notices, or unrelated properties", () => {
    const product = definition(); product.includes_for_buttons.a = ["name"]; product.notices.push({ id: "n", type: "public", kind: "label", severity: "info", target: { scope: "node", node_kind: "field", node_id: "a" }, title: "A" });
    const { editor, builder } = setup(product); editor.clear_relationships(["a"]);
    expect(builder.index.getField("a")).toBeDefined(); expect(builder.definition.notices).toHaveLength(1); expect(builder.definition.includes_for_buttons.a).toBeUndefined();
  });

  it("sets, patches, validates, clears, cleans, and restores option effects", () => {
    const { editor, builder } = setup(); editor.set_option_effect("basic", "plan", { include: ["premium"], force_visible: true });
    editor.patch_option_effect("basic", "plan", { exclude: ["priority"] });
    expect(builder.definition.option_effects_for_buttons.basic?.plan).toMatchObject({ include: ["premium"], exclude: ["priority"], force_visible: true });
    expect(() => editor.set_option_effect("missing", "plan", {})).toThrow(); expect(() => editor.set_option_effect("basic", "plan", { include: ["missing"] })).toThrow();
    editor.clear_option_effects_for_target("plan"); expect(builder.definition.option_effects_for_buttons).toEqual({}); editor.undo(); expect(builder.definition.option_effects_for_buttons.basic).toBeDefined();
  });

  it("sets and clears value effects for filter, button, and option triggers with cleanup", () => {
    const { editor, builder } = setup(); editor.set_value_effect("root", "name", { value: "root" }); editor.set_value_effect("a", "name", { value: "button" }); editor.set_value_effect("basic", "name", { value: "option", clear_on_deactivate: true });
    expect(builder.definition.value_effects_for_triggers).toMatchObject({ root: { name: {} }, a: { name: {} }, basic: { name: {} } });
    editor.clear_value_effects_for_trigger("a"); editor.clear_value_effects_for_target("name"); expect(builder.definition.value_effects_for_triggers).toEqual({});
  });

  it("stores local canonical capabilities while preserving ancestor precedence", () => {
    const { editor } = setup(); editor.set_capability("root", "refill", true); editor.set_capability("child", "refill", false);
    expect(editor.resolved_capabilities("child")).toEqual({ values: { refill: true }, origins: { refill: "root" } });
    editor.set_capability("child", "refill"); expect(editor.resolved_capabilities("child")).toEqual({ values: { refill: true }, origins: { refill: "root" } });
  });

  it("clears inherited capability declarations while preserving contradictory local intent", () => {
    const product = definition(); product.filters.push({ id: "grandchild", label: "Grandchild", bind_id: "child", capabilities: { refill: true } });
    const { editor, builder } = setup(product); editor.set_capability("root", "refill", true); editor.set_capability("child", "refill", false); editor.clear_capability("root", "refill");
    expect(builder.index.getFilter("root")?.capabilities).toBeUndefined(); expect(builder.index.getFilter("child")?.capabilities).toEqual({ refill: false });
    expect(builder.index.getFilter("grandchild")?.capabilities).toBeUndefined(); expect(editor.resolved_capabilities("grandchild")).toEqual({ values: { refill: false }, origins: { refill: "child" } });
    editor.undo(); expect(editor.resolved_capabilities("grandchild")).toEqual({ values: { refill: true }, origins: { refill: "root" } });
  });

  it("delegates service filtering to Core with inherited capabilities and call overrides", () => {
    const { editor } = setup(definition(), [service("yes", true, 10), service("no", false, 12), { ...service("off", true), state: "disabled" }]);
    editor.set_capability("root", "refill", true); const result = editor.filter_services("child", { primary_rate: 10, rate_policy: { kind: "eq_primary" } });
    expect(result.accepted.map((item) => item.id)).toEqual(["yes"]); expect(result.rejected).toHaveLength(2);
  });

  it("adds, patches, removes, batch-types, and restores canonical notices", () => {
    const { editor, builder } = setup(); const id = editor.add_notice({ type: "public", kind: "label", severity: "info", target: { scope: "node", node_kind: "field", node_id: "name" }, title: "Name" });
    editor.update_notice(id, { title: "Updated" }); editor.set_notices_type_for_nodes(["name"], "private"); expect(builder.definition.notices[0]).toMatchObject({ title: "Updated", type: "private" });
    editor.remove_notices_for_nodes(["name"]); expect(builder.definition.notices).toEqual([]); editor.undo(); expect(builder.definition.notices).toHaveLength(1);
  });

  it("keeps catalog state cloned, evented, and independent from editor history", () => {
    const { canvas, editor } = setup(); const changes = vi.fn(); const editorChanges = vi.fn(); canvas.on("catalog:change", changes); canvas.on("editor:change", editorChanges);
    const group = editor.create_catalog_group("Marketing"); editor.assign_catalog_services(group, [1, 1, 2]); editor.set_catalog_view({ active_node_id: group, expanded_ids: [group], view_mode: "grouped" });
    const snapshot = editor.get_catalog(); snapshot?.nodes.push({ id: "mutated", kind: "group", label: "Bad", service_ids: [], meta: {} });
    expect(editor.get_catalog()?.nodes).toHaveLength(1); expect(editorChanges).not.toHaveBeenCalled(); expect(changes).toHaveBeenCalled(); expect(editor.undo()).toBe(false);
  });

  it("creates, moves, cascades, and resolves smart catalog groups", () => {
    const { editor } = setup(definition(), [service("yes", true), service("no", false)]);
    const parent = editor.create_catalog_group("Parent"); const child = editor.create_catalog_group("Child", parent);
    const smart = editor.create_smart_catalog_group("Refill", [{ type: "capability", capability: "refill", enabled: true }], "all", child);
    expect(editor.resolve_smart_catalog_group(smart)).toEqual(["yes"]); editor.move_catalog_node(smart, parent, 0);
    editor.remove_catalog_node(parent, true); expect(editor.get_catalog()?.nodes).toEqual([]);
  });

  it("preserves full catalog metadata, assignment modes, ordering, view state, and custom smart rules", () => {
    const { editor } = setup();
    const parent = editor.create_catalog_group({ label: "Parent", description: "Curated", service_ids: [1, 1, "1", 2], color: "blue", icon: "folder", collapsed: true });
    const a = editor.create_catalog_group({ label: "A", parent_id: parent, order: 0 });
    const b = editor.create_catalog_group({ label: "B", parent_id: parent, order: 1 });
    const c = editor.create_catalog_group({ label: "C", parent_id: parent, order: 2 });
    editor.assign_catalog_services(parent, [2, 3], "append"); editor.assign_catalog_services(parent, [1], "remove");
    expect(editor.get_catalog()?.nodes.find((node) => node.id === parent)).toMatchObject({ description: "Curated", service_ids: [2, 3], color: "blue", icon: "folder", collapsed: true });
    editor.move_catalog_node(c, { parent_id: parent, before_id: a }); editor.move_catalog_node(a, { parent_id: parent, after_id: b });
    expect(editor.get_catalog()?.nodes.filter((node) => node.parent_id === parent).sort((left, right) => (left.order ?? 0) - (right.order ?? 0)).map((node) => node.id)).toEqual([c, b, a]);

    editor.set_catalog_view_mode("assigned"); editor.set_selected_catalog_service(3); editor.toggle_catalog_expanded(parent); editor.toggle_catalog_pinned(parent); editor.set_active_catalog_node(parent);
    expect(editor.get_catalog()).toMatchObject({ view_mode: "assigned", selected_service_id: 3, active_node_id: parent, expanded_ids: [parent], pinned_node_ids: [parent] });
    const smart = editor.create_smart_catalog_group({ label: "Policy", match: "any", rules: [{ type: "service_field", field: "tier", op: "eq", value: "gold" }, { type: "policy_family", key: "family", value: "core" }] });
    const resolved = editor.resolve_smart_catalog_group(smart, [1, 2, 3], { service_field: (id) => id === 2, policy_family: (id) => id === 3 });
    expect(resolved).toEqual([2, 3]); const smartNode = editor.get_catalog()?.nodes.find((node) => node.id === smart);
    expect(smartNode).toMatchObject({ resolved_service_ids: [2, 3] }); expect(typeof (smartNode?.kind === "smart" ? smartNode.resolved_at : undefined)).toBe("number");
  });
});
