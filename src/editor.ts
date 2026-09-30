// SPDX-License-Identifier: GPL-3.0-only

import type {
  FieldOption,
  FieldValueEffect,
  FieldValidationRule,
  HandlerService,
  JsonValue,
  OptionEffectForButton,
  ProductDefinition,
  ProductField,
  ProductFilter,
  ProductNotice,
  QuantityRule,
  ServiceId,
} from "@elqora/dgp-spec";
import {
  filterHandlerServices,
  resolveCapabilities,
  type ProductBuilder,
  type ServiceFilterOptions,
  type ServiceFilterResult,
} from "@elqora/dgp-core";

import type { AuthoringFieldDescriptor } from "./descriptors.js";
import type { FieldTemplate } from "./contracts.js";

export type WireKind = "bind" | "include" | "exclude" | "service";
export type NodeReference =
  | { kind: "filter"; id: string }
  | { kind: "field"; id: string }
  | { kind: "option"; field_id: string; id: string };

export interface DuplicateOptions {
  with_children?: boolean;
  copy_bindings?: boolean;
  copy_relationships?: boolean;
  copy_effects?: boolean;
  id?: string;
  label?: (old: string) => string;
  name?: (old?: string) => string | undefined;
  option_id?: (old: string) => string;
}

interface CatalogNodeBase {
  id: string;
  label: string;
  parent_id?: string;
  description?: string;
  collapsed?: boolean;
  order?: number;
  color?: string;
  icon?: string;
  meta: Record<string, unknown>;
}

export interface CatalogGroup extends CatalogNodeBase { kind: "group"; service_ids: ServiceId[]; }

export type CatalogSmartRule =
  | { type: "service_field"; field: string; op: string; value?: JsonValue }
  | { type: "policy_family"; key: string; value?: JsonValue }
  | { type: "compatibility"; scope: string; target_id: string; mode?: string }
  | { type: "capability"; capability: string; enabled?: boolean }
  | { type: "state"; state: HandlerService["state"] };

export interface CatalogSmartGroup extends CatalogNodeBase {
  kind: "smart";
  match: "all" | "any";
  rules: CatalogSmartRule[];
  resolved_service_ids: ServiceId[];
  resolved_at?: number;
}

export type CatalogNode = CatalogGroup | CatalogSmartGroup;

export interface ServiceCatalogState {
  version: 1;
  nodes: CatalogNode[];
  active_node_id?: string;
  expanded_ids: string[];
  pinned_node_ids: string[];
  selected_service_id?: ServiceId;
  view_mode: "all" | "grouped" | "assigned";
}

export interface CreateCatalogGroupInput extends Omit<Partial<CatalogGroup>, "kind" | "service_ids"> { label: string; service_ids?: readonly ServiceId[]; }
export interface CreateSmartCatalogGroupInput extends Omit<Partial<CatalogSmartGroup>, "kind" | "rules" | "resolved_service_ids"> { label: string; rules: CatalogSmartRule[]; match?: "all" | "any"; }
export interface CatalogSmartMatchers {
  service_field?: (candidate: ServiceId, rule: Extract<CatalogSmartRule, { type: "service_field" }>) => boolean;
  policy_family?: (candidate: ServiceId, rule: Extract<CatalogSmartRule, { type: "policy_family" }>) => boolean;
  compatibility?: (candidate: ServiceId, rule: Extract<CatalogSmartRule, { type: "compatibility" }>) => boolean;
}

export interface EditorChange {
  command: string;
  definition: ProductDefinition;
  revision: number;
}

export interface EditorError { command: string; error: unknown; }

export interface EditorHost {
  refresh_graph(): void;
  snapshot_positions(): Readonly<Record<string, { x: number; y: number }>>;
  restore_positions(positions: Readonly<Record<string, { x: number; y: number }>>): void;
  emit_editor_change(change: EditorChange): void;
  emit_editor_error(error: EditorError): void;
  emit_catalog_change(catalog: ServiceCatalogState | undefined, reason: string): void;
}

interface EditorSnapshot {
  definition: ProductDefinition;
  positions: Readonly<Record<string, { x: number; y: number }>>;
}

interface HistoryEntry { label: string; before: EditorSnapshot; after: EditorSnapshot; }

export interface EditorOptions {
  history_limit?: number;
  services?: readonly HandlerService[];
}

interface OptionLocation {
  field: ProductField;
  option: FieldOption;
  owner: FieldOption[];
  index: number;
}

function unique(values: Iterable<string>): string[] { return [...new Set(values)]; }
function clone<T>(value: T): T { return structuredClone(value); }
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function slug(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "") || "node";
}

function jsonValue(input: unknown): input is JsonValue {
  if (input === null || typeof input === "string" || typeof input === "boolean") return true;
  if (typeof input === "number") return Number.isFinite(input);
  if (Array.isArray(input)) return input.length === Object.keys(input).length && input.every(jsonValue);
  if (typeof input !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(input); if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(input as Record<string, unknown>).every(jsonValue);
}

function expression(input: unknown): { language: "javascript"; body: string } | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  return value.language === "javascript" && typeof value.body === "string" && value.body.trim() !== ""
    ? { language: "javascript", body: value.body }
    : undefined;
}

export function normalizeQuantityRule(input: unknown): QuantityRule | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  if (value.value_by !== "value" && value.value_by !== "length" && value.value_by !== "eval") return undefined;
  const common: { multiply?: number; fallback?: number; clamp?: { min?: number; max?: number } } = {};
  if (typeof value.multiply === "number" && Number.isFinite(value.multiply)) common.multiply = value.multiply;
  if (typeof value.fallback === "number" && Number.isFinite(value.fallback)) common.fallback = value.fallback;
  if (value.clamp !== null && typeof value.clamp === "object") {
    const candidate = value.clamp as Record<string, unknown>; const clamp: { min?: number; max?: number } = {};
    if (typeof candidate.min === "number" && Number.isFinite(candidate.min)) clamp.min = candidate.min;
    if (typeof candidate.max === "number" && Number.isFinite(candidate.max)) clamp.max = candidate.max;
    if (Object.keys(clamp).length > 0) common.clamp = clamp;
  }
  if (value.value_by !== "eval") return { value_by: value.value_by, ...common };
  const source = expression(value.expression); return source === undefined ? undefined : { value_by: "eval", expression: source, ...common };
}

const VALIDATION_OPERATORS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "nin", "truthy", "falsy", "match"]);

function normalizeValidationRule(input: unknown): FieldValidationRule | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>; if (typeof value.op !== "string" || !VALIDATION_OPERATORS.has(value.op)) return undefined;
  const valueMode = value.value_by === "value" || value.value_by === "length" || value.value_by === "eval" ? value.value_by : undefined;
  const shared: Record<string, unknown> = { op: value.op };
  if (valueMode !== undefined) shared.value_by = valueMode;
  if (Object.hasOwn(value, "value") && jsonValue(value.value)) shared.value = clone(value.value);
  if (typeof value.min === "number" && Number.isFinite(value.min)) shared.min = value.min;
  if (typeof value.max === "number" && Number.isFinite(value.max)) shared.max = value.max;
  if (Array.isArray(value.values) && value.values.every(jsonValue)) shared.values = clone(value.values);
  for (const key of ["pattern", "pattern_flags", "code", "message"] as const) if (typeof value[key] === "string" && value[key].trim() !== "") shared[key] = value[key];
  if (valueMode === "eval") { const source = expression(value.expression); if (source === undefined) return undefined; shared.expression = source; }
  return shared as unknown as FieldValidationRule;
}

export function normalizeFieldValidation(input: unknown): FieldValidationRule[] | undefined {
  const values = Array.isArray(input) ? input : [input]; const rules = values.map(normalizeValidationRule).filter((value): value is FieldValidationRule => value !== undefined);
  return rules.length === 0 ? undefined : rules;
}

function walkOptions(field: ProductField, visit: (option: FieldOption, owner: FieldOption[]) => void): void {
  const walk = (options: FieldOption[]): void => {
    for (const option of options) { visit(option, options); if (option.children !== undefined) walk(option.children); }
  };
  walk(field.options ?? []);
}

function optionLocation(definition: ProductDefinition, id: string): OptionLocation | undefined {
  for (const field of definition.fields) {
    let found: OptionLocation | undefined;
    walkOptions(field, (option, owner) => {
      if (found === undefined && option.id === id) found = { field, option, owner, index: owner.indexOf(option) };
    });
    if (found !== undefined) return found;
  }
  return undefined;
}

function optionIds(field: ProductField): string[] {
  const ids: string[] = []; walkOptions(field, (option) => ids.push(option.id)); return ids;
}

function bindIds(field: ProductField): string[] {
  return field.bind_id === undefined ? [] : Array.isArray(field.bind_id) ? field.bind_id : [field.bind_id];
}

function setBindIds(field: ProductField, ids: readonly string[]): void {
  const values = unique(ids);
  if (values.length === 0) delete field.bind_id;
  else field.bind_id = values.length === 1 ? values[0] as string : values;
}

function triggerMap(definition: ProductDefinition, kind: "include" | "exclude"): Record<string, string[]> {
  return kind === "include" ? definition.includes_for_buttons : definition.excludes_for_buttons;
}

function receiverKind(definition: ProductDefinition, id: string): "filter" | "trigger" | undefined {
  if (definition.filters.some((filter) => filter.id === id)) return "filter";
  const field = definition.fields.find((candidate) => candidate.id === id);
  if (field?.button === true) return "trigger";
  if (optionLocation(definition, id) !== undefined) return "trigger";
  return undefined;
}

function setRelationship(definition: ProductDefinition, receiverId: string, targetId: string, kind: "include" | "exclude"): void {
  if (!definition.fields.some((field) => field.id === targetId)) throw new Error(`Unknown target field ${targetId}.`);
  const receiver = receiverKind(definition, receiverId);
  if (receiver === undefined) throw new Error(`Node ${receiverId} cannot receive ${kind} relationships.`);
  if (receiver === "filter") {
    const filter = definition.filters.find((candidate) => candidate.id === receiverId);
    if (filter === undefined) return;
    const opposite = kind === "include" ? "excludes" : "includes";
    filter[opposite] = (filter[opposite] ?? []).filter((id) => id !== targetId);
    filter[kind === "include" ? "includes" : "excludes"] = unique([
      ...(filter[kind === "include" ? "includes" : "excludes"] ?? []), targetId,
    ]);
    return;
  }
  const target = triggerMap(definition, kind);
  const opposite = triggerMap(definition, kind === "include" ? "exclude" : "include");
  opposite[receiverId] = (opposite[receiverId] ?? []).filter((id) => id !== targetId);
  if (opposite[receiverId]?.length === 0) delete opposite[receiverId];
  target[receiverId] = unique([...(target[receiverId] ?? []), targetId]);
}

function createsRelationshipCycle(definition: ProductDefinition): boolean {
  const edges = new Map<string, string[]>();
  for (const map of [definition.includes_for_buttons, definition.excludes_for_buttons]) {
    for (const [from, targets] of Object.entries(map)) {
      const receiverTargets = targets.filter((target) => receiverKind(definition, target) === "trigger");
      edges.set(from, [...(edges.get(from) ?? []), ...receiverTargets]);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of edges.get(id) ?? []) if (cycle(target)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  return [...edges.keys()].some(cycle);
}

function removeIdsFromDefinition(definition: ProductDefinition, removed: ReadonlySet<string>): void {
  for (const filter of definition.filters) {
    if (filter.bind_id !== undefined && removed.has(filter.bind_id)) delete filter.bind_id;
    if (filter.includes !== undefined) filter.includes = filter.includes.filter((id) => !removed.has(id));
    if (filter.excludes !== undefined) filter.excludes = filter.excludes.filter((id) => !removed.has(id));
  }
  for (const field of definition.fields) {
    setBindIds(field, bindIds(field).filter((id) => !removed.has(id)));
    if (typeof field.default_value === "string" && removed.has(field.default_value)) delete field.default_value;
    else if (Array.isArray(field.default_value)) {
      const values = field.default_value.filter((value) => typeof value !== "string" || !removed.has(value));
      if (values.length === 0) delete field.default_value; else field.default_value = values;
    }
  }
  for (const map of [definition.includes_for_buttons, definition.excludes_for_buttons]) {
    for (const key of Object.keys(map)) {
      if (removed.has(key)) { delete map[key]; continue; }
      map[key] = (map[key] ?? []).filter((id) => !removed.has(id));
      if (map[key]?.length === 0) delete map[key];
    }
  }
  for (const [triggerId, targets] of Object.entries(definition.option_effects_for_buttons)) {
    if (removed.has(triggerId)) { delete definition.option_effects_for_buttons[triggerId]; continue; }
    for (const [fieldId, effect] of Object.entries(targets)) {
      if (removed.has(fieldId)) { delete targets[fieldId]; continue; }
      if (effect.include !== undefined) effect.include = effect.include.filter((id) => !removed.has(id));
      if (effect.exclude !== undefined) effect.exclude = effect.exclude.filter((id) => !removed.has(id));
    }
    if (Object.keys(targets).length === 0) delete definition.option_effects_for_buttons[triggerId];
  }
  for (const [triggerId, targets] of Object.entries(definition.value_effects_for_triggers)) {
    if (removed.has(triggerId)) { delete definition.value_effects_for_triggers[triggerId]; continue; }
    for (const fieldId of Object.keys(targets)) if (removed.has(fieldId)) delete targets[fieldId];
    if (Object.keys(targets).length === 0) delete definition.value_effects_for_triggers[triggerId];
  }
  for (const key of Object.keys(definition.order_for_tags)) {
    if (removed.has(key)) delete definition.order_for_tags[key];
    else definition.order_for_tags[key] = (definition.order_for_tags[key] ?? []).filter((id) => !removed.has(id));
  }
  definition.notices = definition.notices.filter((notice) => notice.target.scope !== "node" || !removed.has(notice.target.node_id));
  if (definition.fallbacks !== null) {
    for (const key of Object.keys(definition.fallbacks.nodes ?? {})) if (removed.has(key)) delete definition.fallbacks.nodes?.[key];
  }
}

function clearRelationshipsForIds(definition: ProductDefinition, ids: ReadonlySet<string>): void {
  for (const filter of definition.filters) {
    if (ids.has(filter.id)) { delete filter.bind_id; delete filter.includes; delete filter.excludes; }
    else if (filter.bind_id !== undefined && ids.has(filter.bind_id)) delete filter.bind_id;
    if (filter.includes !== undefined) filter.includes = filter.includes.filter((id) => !ids.has(id));
    if (filter.excludes !== undefined) filter.excludes = filter.excludes.filter((id) => !ids.has(id));
  }
  for (const field of definition.fields) {
    if (ids.has(field.id)) delete field.bind_id;
    else setBindIds(field, bindIds(field).filter((id) => !ids.has(id)));
  }
  for (const map of [definition.includes_for_buttons, definition.excludes_for_buttons]) {
    for (const key of Object.keys(map)) {
      if (ids.has(key)) delete map[key];
      else {
        map[key] = (map[key] ?? []).filter((id) => !ids.has(id));
        if (map[key]?.length === 0) delete map[key];
      }
    }
  }
  for (const map of [definition.option_effects_for_buttons, definition.value_effects_for_triggers]) {
    for (const key of Object.keys(map)) {
      if (ids.has(key)) delete map[key];
      else {
        const targets = map[key];
        if (targets !== undefined) for (const target of Object.keys(targets)) if (ids.has(target)) delete targets[target];
        if (Object.keys(targets ?? {}).length === 0) delete map[key];
      }
    }
  }
  for (const targets of Object.values(definition.option_effects_for_buttons)) {
    for (const effect of Object.values(targets)) {
      if (effect.include !== undefined) effect.include = effect.include.filter((id) => !ids.has(id));
      if (effect.exclude !== undefined) effect.exclude = effect.exclude.filter((id) => !ids.has(id));
    }
  }
}

export class Editor {
  readonly #builder: ProductBuilder;
  readonly #host: EditorHost;
  readonly #options: Required<EditorOptions>;
  readonly #undo: HistoryEntry[] = [];
  readonly #redo: HistoryEntry[] = [];
  #transactionDepth = 0;
  #outerBefore: EditorSnapshot | undefined;
  #outerLabel = "mutation";
  #revision = 0;
  #catalog: ServiceCatalogState | undefined;

  constructor(builder: ProductBuilder, host: EditorHost, options: EditorOptions = {}) {
    this.#builder = builder;
    this.#host = host;
    this.#options = { history_limit: options.history_limit ?? 100, services: options.services ?? [] };
  }

  get definition(): ProductDefinition { return this.#builder.definition; }
  get revision(): number { return this.#revision; }
  get_node(id: string): ReturnType<ProductBuilder["index"]["getNode"]> { return this.#builder.index.getNode(id); }
  is_filter_id(id: string): boolean { return this.#builder.isFilterId(id); }
  is_field_id(id: string): boolean { return this.#builder.isFieldId(id); }
  is_option_id(id: string): boolean { return this.#builder.isOptionId(id); }
  can_undo(): boolean { return this.#undo.length > 0; }
  can_redo(): boolean { return this.#redo.length > 0; }

  transact(label: string, operation: () => void): void {
    const outer = this.#transactionDepth === 0;
    if (outer) { this.#outerBefore = this.#snapshot(); this.#outerLabel = label; }
    this.#transactionDepth += 1;
    try { operation(); }
    catch (caught) {
      this.#transactionDepth -= 1;
      if (outer) {
        if (this.#outerBefore !== undefined) this.#restore(this.#outerBefore, false);
        this.#outerBefore = undefined;
        this.#host.emit_editor_error({ command: label, error: caught });
      }
      throw caught;
    }
    this.#transactionDepth -= 1;
    if (!outer || this.#outerBefore === undefined) return;
    const before = this.#outerBefore;
    this.#outerBefore = undefined;
    const after = this.#snapshot();
    if (equal(before.definition, after.definition) && equal(before.positions, after.positions)) return;
    this.#undo.push({ label: this.#outerLabel, before, after });
    if (this.#undo.length > this.#options.history_limit) this.#undo.shift();
    this.#redo.length = 0;
    this.#changed(label);
  }

  undo(): boolean {
    const entry = this.#undo.pop(); if (entry === undefined) return false;
    this.#redo.push(entry); this.#restore(entry.before, true); this.#changed(`undo:${entry.label}`); return true;
  }

  redo(): boolean {
    const entry = this.#redo.pop(); if (entry === undefined) return false;
    this.#undo.push(entry); this.#restore(entry.after, true); this.#changed(`redo:${entry.label}`); return true;
  }

  replace(definition: ProductDefinition, label = "replace"): void {
    this.transact(label, () => this.#builder.load(definition));
  }

  add_filter(input: Partial<ProductFilter> & Pick<ProductFilter, "label">): string {
    const id = input.id ?? this.#uniqueId(`filter:${slug(input.label)}`);
    this.transact("filter:add", () => this.#mutate((definition) => {
      definition.filters.push({ id, label: input.label, ...(input.bind_id === undefined ? {} : { bind_id: input.bind_id }),
        ...(input.service_id === undefined ? {} : { service_id: input.service_id }), ...(input.includes === undefined ? {} : { includes: input.includes }),
        ...(input.excludes === undefined ? {} : { excludes: input.excludes }), ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
        ...(input.quantity_default === undefined ? {} : { quantity_default: input.quantity_default }), ...(input.meta === undefined ? {} : { meta: input.meta }) });
    }));
    return id;
  }

  update_filter(id: string, patch: Partial<ProductFilter>): void {
    this.transact("filter:update", () => this.#mutate((definition) => {
      const index = definition.filters.findIndex((filter) => filter.id === id); if (index < 0) return;
      definition.filters[index] = { ...definition.filters[index], ...clone(patch), id } as ProductFilter;
    }));
  }

  place_node(id: string, x: number, y: number): void {
    this.transact("node:place", () => this.#host.restore_positions({ ...this.#host.snapshot_positions(), [id]: { x, y } }));
  }

  relabel(id: string, label: string): void {
    this.transact("node:relabel", () => this.#mutate((definition) => {
      const node = definition.filters.find((item) => item.id === id) ?? definition.fields.find((item) => item.id === id) ?? optionLocation(definition, id)?.option;
      if (node !== undefined) node.label = label;
    }));
  }

  set_field_name(id: string, name?: string): void {
    this.transact("field:name", () => this.#mutate((definition) => {
      const field = definition.fields.find((candidate) => candidate.id === id); if (field === undefined) return;
      if (name === undefined || name.trim() === "") delete field.name; else field.name = name;
    }));
  }

  add_field(input: Partial<ProductField> & Pick<ProductField, "type" | "label">): string {
    const id = input.id ?? this.#uniqueId(`field:${slug(input.label)}`);
    this.transact("field:add", () => this.#mutate((definition) => {
      definition.fields.push({ ...clone(input), id, type: input.type, label: input.label, button: input.button === true });
    }));
    return id;
  }

  capture_template(rootId: string, includeConnected = false): Pick<FieldTemplate, "field" | "connected_fields" | "relationships" | "notices" | "fallbacks"> {
    const definition = this.#builder.definition;
    const root = definition.fields.find((field) => field.id === rootId);
    if (root === undefined) throw new Error(`Unknown template root field ${rootId}.`);
    const owner = new Map<string, string>();
    for (const field of definition.fields) {
      owner.set(field.id, field.id);
      const visit = (options: readonly FieldOption[]): void => { for (const option of options) { owner.set(option.id, field.id); visit(option.children ?? []); } };
      visit(field.options ?? []);
    }
    const selected = new Set([rootId]);
    if (includeConnected) {
      const link = (left: string, right: string): void => {
        const a = owner.get(left); const b = owner.get(right);
        if (a === undefined || b === undefined || a === b) return;
        edges.get(a)?.add(b); edges.get(b)?.add(a);
      };
      const edges = new Map(definition.fields.map((field) => [field.id, new Set<string>()]));
      for (const field of definition.fields) for (const target of [field.bind_id].flat().filter((id): id is string => typeof id === "string")) link(field.id, target);
      for (const map of [definition.includes_for_buttons, definition.excludes_for_buttons]) for (const [source, targets] of Object.entries(map)) for (const target of targets) link(source, target);
      for (const [source, targets] of Object.entries(definition.option_effects_for_buttons)) for (const target of Object.keys(targets)) link(source, target);
      for (const [source, targets] of Object.entries(definition.value_effects_for_triggers)) for (const target of Object.keys(targets)) link(source, target);
      for (const [source, targets] of Object.entries(definition.option_effects_for_buttons)) for (const effect of Object.values(targets)) for (const target of [...(effect.include ?? []), ...(effect.exclude ?? [])]) link(source, target);
      const queue = [rootId];
      for (let i = 0; i < queue.length; i++) for (const next of edges.get(queue[i] as string) ?? []) if (!selected.has(next)) { selected.add(next); queue.push(next); }
    }
    const fields = definition.fields.filter((field) => selected.has(field.id));
    const selectedIds = new Set([...owner].filter(([, fieldId]) => selected.has(fieldId)).map(([id]) => id));
    const retain = (input: Record<string, string[]>): Record<string, string[]> => {
      const output: Record<string, string[]> = {};
      for (const [id, targets] of Object.entries(input)) {
        if (!selectedIds.has(id)) continue;
        const kept = targets.filter((target) => selectedIds.has(target));
        if (kept.length > 0) output[id] = kept;
      }
      return output;
    };
    const optionEffects: Record<string, Record<string, OptionEffectForButton>> = {};
    for (const [source, targets] of Object.entries(definition.option_effects_for_buttons)) {
      if (!selectedIds.has(source)) continue;
      const kept: Record<string, OptionEffectForButton> = {};
      for (const [target, effect] of Object.entries(targets)) if (selectedIds.has(target)) kept[target] = {
        ...clone(effect),
        ...(effect.include === undefined ? {} : { include: effect.include.filter((id) => selectedIds.has(id)) }),
        ...(effect.exclude === undefined ? {} : { exclude: effect.exclude.filter((id) => selectedIds.has(id)) }),
      };
      if (Object.keys(kept).length > 0) optionEffects[source] = kept;
    }
    const valueEffects: Record<string, Record<string, FieldValueEffect>> = {};
    for (const [source, targets] of Object.entries(definition.value_effects_for_triggers)) {
      if (!selectedIds.has(source)) continue;
      const kept: Record<string, FieldValueEffect> = {};
      for (const [target, effect] of Object.entries(targets)) if (selectedIds.has(target)) kept[target] = clone(effect);
      if (Object.keys(kept).length > 0) valueEffects[source] = kept;
    }
    const notices = definition.notices.filter((notice) => notice.target.scope === "node" && selectedIds.has(notice.target.node_id));
    const nodes = Object.fromEntries(Object.entries(definition.fallbacks?.nodes ?? {}).filter(([id]) => selectedIds.has(id)));
    return {
      field: clone(root),
      ...(fields.length > 1 ? { connected_fields: clone(fields.filter((field) => field.id !== rootId)) } : {}),
      relationships: { includes_for_buttons: retain(definition.includes_for_buttons), excludes_for_buttons: retain(definition.excludes_for_buttons), option_effects_for_buttons: optionEffects, value_effects_for_triggers: valueEffects },
      ...(notices.length > 0 ? { notices: clone(notices) } : {}),
      ...(Object.keys(nodes).length > 0 ? { fallbacks: { nodes: clone(nodes) } } : {}),
    };
  }

  instantiate_template(template: Pick<FieldTemplate, "field" | "connected_fields" | "relationships" | "notices" | "fallbacks">, options: { bind_id?: string | string[] } = {}): { root_id: string; field_ids: string[]; id_map: Record<string, string> } {
    const source = [template.field, ...(template.connected_fields ?? [])];
    if (source.length === 0 || !source[0]?.id) throw new Error("Template root field is missing.");
    const oldIds = new Set<string>();
    const fieldOptionIds = new Map<string, Set<string>>();
    const map = new Map<string, string>();
    const used = new Set([...this.#builder.index.nodeIds(), ...this.#builder.definition.notices.map((notice) => notice.id)]);
    const add = (id: string): void => {
      if (!id || oldIds.has(id)) throw new Error(`Duplicate or empty template node ID ${id}.`);
      oldIds.add(id);
      let candidate = `${id}-copy`; let sequence = 2;
      while (used.has(candidate)) candidate = `${id}-copy-${sequence++}`;
      used.add(candidate); map.set(id, candidate);
    };
    const visit = (options: readonly FieldOption[], ids: Set<string>): void => { for (const option of options) { add(option.id); ids.add(option.id); visit(option.children ?? [], ids); } };
    for (const field of source) { add(field.id); const ids = new Set<string>(); visit(field.options ?? [], ids); fieldOptionIds.set(field.id, ids); }
    for (const notice of template.notices ?? []) add(notice.id);
    const mapped = (id: string): string => { const result = map.get(id); if (result === undefined) throw new Error(`Template references external node ${id}.`); return result; };
    const value = (input: unknown, ids: ReadonlySet<string>): unknown => typeof input === "string" && ids.has(input) ? mapped(input) : Array.isArray(input) ? input.map((item: unknown) => value(item, ids)) : input;
    const copyOptions = (options: readonly FieldOption[]): FieldOption[] => options.map((option) => ({ ...clone(option), id: mapped(option.id), ...(option.children === undefined ? {} : { children: copyOptions(option.children) }) }));
    const fields = source.map((field, index) => {
      const copy = clone(field);
      copy.id = mapped(field.id);
      if (field.options !== undefined) copy.options = copyOptions(field.options);
      if (index === 0 && options.bind_id !== undefined) copy.bind_id = clone(options.bind_id);
      else if (field.bind_id !== undefined) {
        const ids = Array.isArray(field.bind_id) ? field.bind_id : [field.bind_id];
        const internal = ids.filter((id) => map.has(id)).map(mapped);
        if (internal.length === 0) delete copy.bind_id;
        else copy.bind_id = Array.isArray(field.bind_id) ? internal : internal[0] as string;
      }
      if (field.default_value !== undefined) copy.default_value = value(field.default_value, fieldOptionIds.get(field.id) ?? new Set()) as typeof field.default_value;
      return copy;
    });
    const relationships = template.relationships;
    for (const lists of [relationships?.includes_for_buttons, relationships?.excludes_for_buttons]) {
      for (const [sourceId, targets] of Object.entries(lists ?? {})) { mapped(sourceId); for (const target of targets) mapped(target); }
    }
    for (const [sourceId, targets] of Object.entries(relationships?.option_effects_for_buttons ?? {})) { mapped(sourceId); for (const target of Object.keys(targets)) mapped(target); }
    for (const [sourceId, targets] of Object.entries(relationships?.value_effects_for_triggers ?? {})) { mapped(sourceId); for (const target of Object.keys(targets)) mapped(target); }
    for (const targets of Object.values(relationships?.option_effects_for_buttons ?? {})) for (const effect of Object.values(targets)) {
      for (const id of [...(effect.include ?? []), ...(effect.exclude ?? [])]) mapped(id);
    }
    const remapList = (input: Record<string, string[]> = {}): Record<string, string[]> => Object.fromEntries(Object.entries(input).filter(([id]) => map.has(id)).map(([id, targets]) => [mapped(id), targets.filter((target) => map.has(target)).map(mapped)]));
    const remapEffects = <T>(input: Record<string, Record<string, T>> = {}, change: (effect: T) => T): Record<string, Record<string, T>> => Object.fromEntries(Object.entries(input).filter(([id]) => map.has(id)).map(([id, targets]) => [mapped(id), Object.fromEntries(Object.entries(targets).filter(([target]) => map.has(target)).map(([target, effect]) => [mapped(target), change(effect)]))]));
    const optionEffects = remapEffects(relationships?.option_effects_for_buttons, (effect) => ({ ...clone(effect), ...(effect.include === undefined ? {} : { include: effect.include.filter((id) => map.has(id)).map(mapped) }), ...(effect.exclude === undefined ? {} : { exclude: effect.exclude.filter((id) => map.has(id)).map(mapped) }) }));
    const valueEffects: ProductDefinition["value_effects_for_triggers"] = {};
    for (const [sourceId, targets] of Object.entries(relationships?.value_effects_for_triggers ?? {})) {
      const copied: Record<string, FieldValueEffect> = {};
      for (const [targetId, effect] of Object.entries(targets)) {
        copied[mapped(targetId)] = { ...clone(effect), value: value(effect.value, fieldOptionIds.get(targetId) ?? new Set()) as typeof effect.value };
      }
      valueEffects[mapped(sourceId)] = copied;
    }
    const notices = (template.notices ?? []).map((notice) => {
      if (notice.target.scope !== "node") throw new Error("Global notices cannot be instantiated with a field template.");
      return { ...clone(notice), id: mapped(notice.id), target: { ...notice.target, node_id: mapped(notice.target.node_id) } };
    });
    const fallbacks = Object.fromEntries(Object.entries(template.fallbacks?.nodes ?? {}).map(([id, services]) => [mapped(id), clone(services)]));
    this.transact("template:instantiate", () => this.#mutate((definition) => {
      definition.fields.push(...fields);
      Object.assign(definition.includes_for_buttons, remapList(relationships?.includes_for_buttons));
      Object.assign(definition.excludes_for_buttons, remapList(relationships?.excludes_for_buttons));
      Object.assign(definition.option_effects_for_buttons, optionEffects);
      Object.assign(definition.value_effects_for_triggers, valueEffects);
      definition.notices.push(...notices);
      if (Object.keys(fallbacks).length > 0) (definition.fallbacks ??= {}).nodes = { ...definition.fallbacks?.nodes, ...fallbacks };
    }));
    return { root_id: mapped(source[0].id), field_ids: fields.map((field) => field.id), id_map: Object.fromEntries(map) };
  }

  add_field_from_descriptor(
    descriptor: AuthoringFieldDescriptor,
    input: { label: string; bind_id?: string | string[]; id?: string } = { label: descriptor.type },
  ): string {
    const starterOptionId = this.#uniqueId(`option:${slug(descriptor.options?.default_label ?? "option")}`);
    return this.add_field({
      ...(input.id === undefined ? {} : { id: input.id }),
      type: descriptor.type,
      ...(descriptor.variant === undefined ? {} : { variant: descriptor.variant }),
      label: input.label,
      ...(input.bind_id === undefined ? {} : { bind_id: input.bind_id }),
      ...(descriptor.defaults === undefined ? {} : { defaults: clone(descriptor.defaults) }),
      ...(descriptor.meta === undefined ? {} : { meta: clone(descriptor.meta) }),
      ...(descriptor.multi?.auto_enable === true ? { multiple: true } : {}),
      ...(descriptor.options?.auto_create === true ? { options: [{
        id: starterOptionId,
        label: descriptor.options.default_label ?? "Option label",
        ...(descriptor.options.default_value === undefined ? {} : { value: descriptor.options.default_value }),
      }] } : {}),
    });
  }

  update_field(id: string, patch: Partial<ProductField>): void {
    this.transact("field:update", () => this.#mutate((definition) => {
      const index = definition.fields.findIndex((field) => field.id === id); if (index < 0) return;
      const before = definition.fields[index];
      const next = { ...before, ...clone(patch), id } as ProductField;
      definition.fields[index] = next;
      if (before?.button === true && next.button !== true) {
        delete definition.includes_for_buttons[id];
        delete definition.excludes_for_buttons[id];
        delete definition.option_effects_for_buttons[id];
        delete definition.value_effects_for_triggers[id];
      }
    }));
  }

  add_option(fieldId: string, input: Partial<FieldOption> & Pick<FieldOption, "label">, parentOptionId?: string): string {
    const id = input.id ?? this.#uniqueId(`option:${slug(input.label)}`);
    this.transact("option:add", () => this.#mutate((definition) => {
      const field = definition.fields.find((candidate) => candidate.id === fieldId);
      if (field === undefined) throw new Error(`Unknown field ${fieldId}.`);
      let owner: FieldOption[];
      if (parentOptionId === undefined) owner = (field.options ??= []);
      else {
        const parent = optionLocation(definition, parentOptionId)?.option;
        if (parent === undefined) throw new Error(`Unknown parent option ${parentOptionId}.`);
        owner = (parent.children ??= []);
      }
      owner.push({ ...clone(input), id, label: input.label });
    }));
    return id;
  }

  update_option(id: string, patch: Partial<FieldOption>): void {
    this.transact("option:update", () => this.#mutate((definition) => {
      const location = optionLocation(definition, id); if (location === undefined) return;
      const next = { ...location.option, ...clone(patch), id };
      if (next.utility !== undefined) delete next.service_id;
      if (location.option.utility !== undefined && patch.service_id !== undefined) throw new Error("Utility options cannot bind a service.");
      location.owner[location.index] = next;
    }));
  }

  remove(id: string): void { this.remove_many([id]); }

  remove_many(ids: readonly string[]): void {
    this.transact("nodes:remove", () => this.#mutate((definition) => {
      const requested = new Set(ids);
      const removed = new Set<string>();
      for (const field of definition.fields) {
        if (requested.has(field.id)) for (const optionId of optionIds(field)) removed.add(optionId);
      }
      for (const id of requested) {
        removed.add(id);
        const location = optionLocation(definition, id);
        if (location !== undefined) {
          const collect = (option: FieldOption): void => { removed.add(option.id); for (const child of option.children ?? []) collect(child); };
          collect(location.option); location.owner.splice(location.index, 1);
        }
      }
      definition.filters = definition.filters.filter((filter) => !requested.has(filter.id));
      definition.fields = definition.fields.filter((field) => !requested.has(field.id));
      removeIdsFromDefinition(definition, removed);
    }));
  }

  duplicate(reference: NodeReference, options: DuplicateOptions = {}): string {
    let created = "";
    this.transact("node:duplicate", () => this.#mutate((definition) => {
      const map = new Map<string, string>();
      const copyOption = (option: FieldOption): FieldOption => {
        const id = this.#uniqueId(options.option_id?.(option.id) ?? `${option.id}-copy`, map);
        map.set(option.id, id);
        const copied: FieldOption = { ...clone(option), id, label: options.label?.(option.label) ?? `${option.label} copy` };
        if (option.children !== undefined) copied.children = option.children.map(copyOption);
        return copied;
      };
      if (reference.kind === "filter") {
        const source = definition.filters.find((filter) => filter.id === reference.id); if (source === undefined) throw new Error("Unknown filter.");
        created = options.id ?? this.#uniqueId(`${source.id}-copy`);
        map.set(source.id, created);
        const subtree = [source];
        if (options.with_children === true) for (let cursor = 0; cursor < subtree.length; cursor += 1) for (const child of definition.filters.filter((filter) => filter.bind_id === subtree[cursor]?.id)) { subtree.push(child); map.set(child.id, this.#uniqueId(`${child.id}-copy`, map)); }
        const copied = subtree.map((filter, index) => {
          const next: ProductFilter = { ...clone(filter), id: map.get(filter.id) as string, label: options.label?.(filter.label) ?? `${filter.label} copy` };
          if (index === 0 && options.copy_bindings === false) delete next.bind_id;
          else if (next.bind_id !== undefined && map.has(next.bind_id)) next.bind_id = map.get(next.bind_id) as string;
          return next;
        });
        const sourceIndex = definition.filters.indexOf(source); definition.filters.splice(sourceIndex + 1, 0, ...copied);
      } else if (reference.kind === "field") {
        const source = definition.fields.find((field) => field.id === reference.id); if (source === undefined) throw new Error("Unknown field.");
        created = options.id ?? this.#uniqueId(`${source.id}-copy`);
        map.set(source.id, created);
        const copied: ProductField = { ...clone(source), id: created, label: options.label?.(source.label) ?? `${source.label} copy` };
        if (options.name !== undefined) {
          const name = options.name(source.name); if (name === undefined) delete copied.name; else copied.name = name;
        }
        if (options.copy_bindings === false) delete copied.bind_id;
        if (source.options !== undefined) copied.options = source.options.map(copyOption);
        const sourceIndex = definition.fields.indexOf(source); definition.fields.splice(sourceIndex + 1, 0, copied);
        if (options.copy_relationships === true) for (const filter of definition.filters) {
          if (filter.includes?.includes(source.id)) filter.includes = unique([...filter.includes, created]);
          if (filter.excludes?.includes(source.id)) filter.excludes = unique([...filter.excludes, created]);
        }
      } else {
        const source = optionLocation(definition, reference.id); if (source === undefined) throw new Error("Unknown option.");
        const copy = copyOption(source.option); created = copy.id; source.owner.splice(source.index + 1, 0, copy);
      }
      if (options.copy_relationships === true) {
        for (const relationshipMap of [definition.includes_for_buttons, definition.excludes_for_buttons]) for (const [oldId, newId] of map) {
          const targets = relationshipMap[oldId]; if (targets !== undefined) relationshipMap[newId] = targets.map((target) => map.get(target) ?? target);
        }
      }
      if (options.copy_effects === true) {
        for (const [oldId, newId] of map) {
          const optionEffects = definition.option_effects_for_buttons[oldId];
          if (optionEffects !== undefined) definition.option_effects_for_buttons[newId] = Object.fromEntries(Object.entries(optionEffects).map(([target, effect]) => [map.get(target) ?? target, {
            ...clone(effect),
            ...(effect.include === undefined ? {} : { include: effect.include.map((id) => map.get(id) ?? id) }),
            ...(effect.exclude === undefined ? {} : { exclude: effect.exclude.map((id) => map.get(id) ?? id) }),
          }]));
          const valueEffects = definition.value_effects_for_triggers[oldId];
          if (valueEffects !== undefined) definition.value_effects_for_triggers[newId] = Object.fromEntries(Object.entries(valueEffects).map(([target, effect]) => [map.get(target) ?? target, clone(effect)]));
        }
      }
    }));
    return created;
  }

  duplicate_many(references: readonly NodeReference[], options: Omit<DuplicateOptions, "id"> = {}): string[] {
    const selectedFields = new Set(references.filter((ref) => ref.kind === "field").map((ref) => ref.id));
    const filtered = references.filter((ref) => ref.kind !== "option" || !selectedFields.has(ref.field_id));
    const created: string[] = [];
    this.transact("nodes:duplicate", () => { for (const reference of filtered) created.push(this.duplicate(reference, options)); });
    return created;
  }

  set_service(id: string, serviceId?: ServiceId): void {
    this.transact("service:set", () => this.#mutate((definition) => {
      const filter = definition.filters.find((candidate) => candidate.id === id);
      if (filter !== undefined) { if (serviceId === undefined) delete filter.service_id; else filter.service_id = serviceId; return; }
      const field = definition.fields.find((candidate) => candidate.id === id);
      if (field !== undefined && field.button === true) { if (serviceId === undefined) delete field.service_id; else field.service_id = serviceId; return; }
      const option = optionLocation(definition, id)?.option;
      if (option !== undefined) {
        if (serviceId !== undefined && option.utility !== undefined) throw new Error("Utility options cannot bind a service.");
        if (serviceId === undefined) delete option.service_id; else option.service_id = serviceId;
      }
    }));
  }

  clear_services(ids: readonly string[]): void { this.transact("service:clear-many", () => { for (const id of ids) this.set_service(id); }); }

  bind_many(ids: readonly string[], filterId?: string): void {
    this.transact("bind:many", () => this.#mutate((definition) => {
      if (filterId !== undefined && !definition.filters.some((filter) => filter.id === filterId)) throw new Error(`Unknown filter ${filterId}.`);
      for (const id of ids) {
        const field = definition.fields.find((candidate) => candidate.id === id);
        if (field !== undefined) { if (filterId === undefined) delete field.bind_id; else field.bind_id = filterId; continue; }
        const filter = definition.filters.find((candidate) => candidate.id === id);
        if (filter !== undefined) { if (filterId === undefined) delete filter.bind_id; else filter.bind_id = filterId; }
      }
    }));
  }

  include(receiverId: string, ids: string | readonly string[]): void { this.#relate(receiverId, ids, "include"); }
  exclude(receiverId: string, ids: string | readonly string[]): void { this.#relate(receiverId, ids, "exclude"); }

  #relate(receiverId: string, ids: string | readonly string[], kind: "include" | "exclude"): void {
    this.transact(`relationship:${kind}`, () => this.#mutate((definition) => {
      const before = clone(definition);
      for (const id of typeof ids === "string" ? [ids] : ids) setRelationship(definition, receiverId, id, kind);
      if (createsRelationshipCycle(definition)) { Object.assign(definition, before); throw new Error("Relationship would create a cycle."); }
    }));
  }

  connect(kind: WireKind, fromId: string, toId: string): void {
    if (kind === "bind") {
      this.transact("relationship:bind", () => this.#mutate((definition) => {
        if (!definition.filters.some((filter) => filter.id === fromId)) throw new Error(`Unknown filter ${fromId}.`);
        const field = definition.fields.find((candidate) => candidate.id === toId); if (field === undefined) throw new Error(`Unknown field ${toId}.`);
        setBindIds(field, [...bindIds(field), fromId]);
      }));
    } else if (kind === "include" || kind === "exclude") this.#relate(fromId, toId, kind);
    else {
      const raw = toId.startsWith("service:") ? toId.slice("service:".length) : toId;
      this.set_service(fromId, /^-?\d+$/.test(raw) ? Number(raw) : raw);
    }
  }

  disconnect(kind: WireKind, fromId: string, toId: string): void {
    this.transact(`relationship:${kind}:disconnect`, () => this.#mutate((definition) => {
      if (kind === "bind") {
        const field = definition.fields.find((candidate) => candidate.id === toId);
        if (field !== undefined) setBindIds(field, bindIds(field).filter((id) => id !== fromId));
      } else if (kind === "include" || kind === "exclude") {
        const receiver = receiverKind(definition, fromId);
        if (receiver === "filter") {
          const filter = definition.filters.find((candidate) => candidate.id === fromId);
          if (filter !== undefined) filter[kind === "include" ? "includes" : "excludes"] = (filter[kind === "include" ? "includes" : "excludes"] ?? []).filter((id) => id !== toId);
        } else {
          const map = triggerMap(definition, kind); map[fromId] = (map[fromId] ?? []).filter((id) => id !== toId);
          if (map[fromId]?.length === 0) delete map[fromId];
        }
      } else this.set_service(fromId);
    }));
  }

  clear_relationships(ids: readonly string[]): void {
    this.transact("relationship:clear-many", () => this.#mutate((definition) => clearRelationshipsForIds(definition, new Set(ids))));
  }

  rename_labels(ids: readonly string[], prefix = "", suffix = ""): void {
    this.transact("label:many", () => this.#mutate((definition) => {
      for (const id of ids) {
        const node = definition.filters.find((item) => item.id === id) ?? definition.fields.find((item) => item.id === id) ?? optionLocation(definition, id)?.option;
        if (node !== undefined) node.label = `${prefix}${node.label}${suffix}`;
      }
    }));
  }

  set_pricing_role(ids: readonly string[], role?: "base" | "utility"): void {
    this.transact("pricing-role:many", () => this.#mutate((definition) => {
      for (const id of ids) {
        const node = definition.fields.find((field) => field.id === id) ?? optionLocation(definition, id)?.option;
        if (node === undefined) continue;
        if (role === undefined) delete node.pricing_role; else node.pricing_role = role;
        if (role === "utility" && "service_id" in node) delete node.service_id;
      }
    }));
  }

  set_field_default(id: string, value: JsonValue | undefined): void {
    this.transact("field:default", () => this.#mutate((definition) => {
      const field = definition.fields.find((candidate) => candidate.id === id); if (field === undefined) return;
      if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) delete field.default_value;
      else if (field.options !== undefined) {
        const allowed = new Set(optionIds(field));
        const values = (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string" && allowed.has(item));
        if (values.length === 0) delete field.default_value;
        else field.default_value = field.multiple === true ? values : values.at(-1) ?? null;
      } else field.default_value = clone(value);
    }));
  }

  clear_field_defaults(ids: readonly string[]): void { this.transact("field:defaults:clear", () => { for (const id of ids) this.set_field_default(id, undefined); }); }
  set_field_multiple(id: string, enabled: boolean): void {
    this.transact("field:multiple", () => this.#mutate((definition) => {
      const field = definition.fields.find((candidate) => candidate.id === id); if (field === undefined) return;
      if (enabled) field.multiple = true; else delete field.multiple;
    }));
  }

  clear_options(fieldIds: readonly string[]): void {
    this.transact("options:clear-many", () => this.#mutate((definition) => {
      const removed = new Set<string>();
      for (const field of definition.fields) if (fieldIds.includes(field.id)) { for (const id of optionIds(field)) removed.add(id); delete field.options; }
      removeIdsFromDefinition(definition, removed);
    }));
  }

  auto_create_options(fieldIds: readonly string[], label = "Option label", value: JsonValue = "option"): void {
    this.transact("options:auto-create", () => this.#mutate((definition) => {
      const allocated = new Map<string, string>();
      for (const field of definition.fields) if (fieldIds.includes(field.id) && (field.options?.length ?? 0) === 0) {
        const id = this.#uniqueId(`option:${slug(label)}`, allocated); allocated.set(field.id, id);
        field.options = [{ id, label, ...(value === null || typeof value === "object" ? {} : { value }) }];
      }
    }));
  }
  get_field_quantity(id: string): QuantityRule | undefined { const value = this.#builder.index.getField(id)?.quantity; return value === undefined ? undefined : clone(value); }
  set_field_quantity(id: string, quantity?: unknown): void {
    this.transact("field:quantity", () => this.#mutate((definition) => {
      const field = definition.fields.find((candidate) => candidate.id === id); if (field === undefined) return;
      const normalized = normalizeQuantityRule(quantity); if (normalized === undefined) delete field.quantity; else field.quantity = normalized;
    }));
  }
  get_field_validation(id: string): FieldValidationRule[] | undefined { const value = this.#builder.index.getField(id)?.validation; return value === undefined ? undefined : clone(value); }
  set_field_validation(id: string, validation?: unknown): void {
    this.transact("field:validation", () => this.#mutate((definition) => {
      const field = definition.fields.find((candidate) => candidate.id === id); if (field === undefined) return;
      const normalized = normalizeFieldValidation(validation); if (normalized === undefined) delete field.validation; else field.validation = normalized;
    }));
  }
  clear_field_validations(ids: readonly string[]): void { this.transact("field:validation:clear-many", () => { for (const id of ids) this.set_field_validation(id); }); }

  set_option_effect(triggerId: string, targetFieldId: string, effect?: OptionEffectForButton): void {
    this.transact("option-effect:set", () => this.#mutate((definition) => {
      if (receiverKind(definition, triggerId) !== "trigger") throw new Error(`Invalid trigger ${triggerId}.`);
      const target = definition.fields.find((field) => field.id === targetFieldId); if (target === undefined) throw new Error(`Invalid target ${targetFieldId}.`);
      const allowed = new Set(optionIds(target));
      for (const id of [...effect?.include ?? [], ...effect?.exclude ?? []]) if (!allowed.has(id)) throw new Error(`Invalid target option ${id}.`);
      if (effect === undefined) {
        delete definition.option_effects_for_buttons[triggerId]?.[targetFieldId];
      } else (definition.option_effects_for_buttons[triggerId] ??= {})[targetFieldId] = clone(effect);
      if (Object.keys(definition.option_effects_for_buttons[triggerId] ?? {}).length === 0) delete definition.option_effects_for_buttons[triggerId];
    }));
  }

  patch_option_effect(triggerId: string, targetFieldId: string, patch: Partial<OptionEffectForButton>): void {
    const current = this.definition.option_effects_for_buttons[triggerId]?.[targetFieldId] ?? {};
    this.set_option_effect(triggerId, targetFieldId, { ...current, ...clone(patch) });
  }

  clear_option_effects_for_trigger(triggerId: string): void {
    this.transact("option-effect:clear-trigger", () => this.#mutate((definition) => { delete definition.option_effects_for_buttons[triggerId]; }));
  }

  clear_option_effects_for_target(targetFieldId: string): void {
    this.transact("option-effect:clear-target", () => this.#mutate((definition) => {
      for (const [triggerId, targets] of Object.entries(definition.option_effects_for_buttons)) {
        delete targets[targetFieldId]; if (Object.keys(targets).length === 0) delete definition.option_effects_for_buttons[triggerId];
      }
    }));
  }

  set_value_effect(triggerId: string, targetFieldId: string, value?: ProductDefinition["value_effects_for_triggers"][string][string]): void {
    this.transact("value-effect:set", () => this.#mutate((definition) => {
      if (receiverKind(definition, triggerId) !== "trigger" && !definition.filters.some((filter) => filter.id === triggerId)) throw new Error(`Invalid trigger ${triggerId}.`);
      if (!definition.fields.some((field) => field.id === targetFieldId)) throw new Error(`Invalid target ${targetFieldId}.`);
      if (value === undefined) delete definition.value_effects_for_triggers[triggerId]?.[targetFieldId];
      else (definition.value_effects_for_triggers[triggerId] ??= {})[targetFieldId] = clone(value);
      if (Object.keys(definition.value_effects_for_triggers[triggerId] ?? {}).length === 0) delete definition.value_effects_for_triggers[triggerId];
    }));
  }

  clear_value_effects_for_trigger(triggerId: string): void {
    this.transact("value-effect:clear-trigger", () => this.#mutate((definition) => { delete definition.value_effects_for_triggers[triggerId]; }));
  }

  clear_value_effects_for_target(targetFieldId: string): void {
    this.transact("value-effect:clear-target", () => this.#mutate((definition) => {
      for (const [triggerId, targets] of Object.entries(definition.value_effects_for_triggers)) {
        delete targets[targetFieldId]; if (Object.keys(targets).length === 0) delete definition.value_effects_for_triggers[triggerId];
      }
    }));
  }

  set_capability(filterId: string, capability: string, required?: boolean): void {
    this.transact("capability:set", () => this.#mutate((definition) => {
      const filter = definition.filters.find((candidate) => candidate.id === filterId); if (filter === undefined) throw new Error(`Unknown filter ${filterId}.`);
      if (required === undefined) delete filter.capabilities?.[capability];
      else (filter.capabilities ??= {})[capability] = required;
      if (Object.keys(filter.capabilities ?? {}).length === 0) delete filter.capabilities;
    }));
  }

  clear_capability_override(filterId: string, capability: string): void { this.set_capability(filterId, capability); }

  clear_capability(filterId: string, capability: string): void {
    const inherited = this.resolved_capabilities(filterId).values[capability];
    const ids = [filterId, ...this.#builder.index.filterDescendants(filterId).map((filter) => filter.id)];
    this.transact("capability:clear", () => this.#mutate((definition) => {
      for (const id of ids) {
        const filter = definition.filters.find((candidate) => candidate.id === id); if (filter === undefined) continue;
        const local = filter.capabilities?.[capability];
        if (id === filterId || local === inherited) delete filter.capabilities?.[capability];
        if (Object.keys(filter.capabilities ?? {}).length === 0) delete filter.capabilities;
      }
    }));
  }

  resolved_capabilities(filterId: string): ReturnType<typeof resolveCapabilities> { return resolveCapabilities(this.#builder.index, filterId); }

  add_notice(input: Omit<ProductNotice, "id"> & { id?: string }): string {
    const id = input.id ?? this.#uniqueId("notice");
    this.transact("notice:add", () => this.#mutate((definition) => definition.notices.push({ ...clone(input), id })));
    return id;
  }

  update_notice(id: string, patch: Partial<ProductNotice>): void {
    this.transact("notice:update", () => this.#mutate((definition) => {
      const index = definition.notices.findIndex((notice) => notice.id === id); if (index >= 0) definition.notices[index] = { ...definition.notices[index], ...clone(patch), id } as ProductNotice;
    }));
  }

  remove_notice(id: string): void { this.transact("notice:remove", () => this.#mutate((definition) => { definition.notices = definition.notices.filter((notice) => notice.id !== id); })); }

  remove_notices_for_nodes(ids: readonly string[]): void {
    const selected = new Set(ids);
    this.transact("notice:remove-nodes", () => this.#mutate((definition) => {
      definition.notices = definition.notices.filter((notice) => notice.target.scope !== "node" || !selected.has(notice.target.node_id));
    }));
  }

  set_notices_type_for_nodes(ids: readonly string[], type: ProductNotice["type"]): void {
    const selected = new Set(ids);
    this.transact("notice:type-nodes", () => this.#mutate((definition) => {
      for (const notice of definition.notices) if (notice.target.scope === "node" && selected.has(notice.target.node_id)) notice.type = type;
    }));
  }

  filter_services(filterId: string, options: Omit<ServiceFilterOptions, "capabilities"> = {}): ServiceFilterResult {
    const capabilities = this.resolved_capabilities(filterId).values;
    return filterHandlerServices(this.#options.services, { ...options, capabilities });
  }
  services(): readonly HandlerService[] { return clone(this.#options.services); }
  set_services(services: readonly HandlerService[]): void { this.#options.services = clone(services); }

  get_catalog(): ServiceCatalogState | undefined { return this.#catalog === undefined ? undefined : clone(this.#catalog); }

  ensure_catalog(): ServiceCatalogState {
    if (this.#catalog === undefined) this.#setCatalog({ version: 1, nodes: [], expanded_ids: [], pinned_node_ids: [], view_mode: "all" }, "ensure");
    return clone(this.#catalog as ServiceCatalogState);
  }

  set_catalog(catalog?: ServiceCatalogState): void { this.#setCatalog(catalog === undefined ? undefined : clone(catalog), catalog === undefined ? "clear" : "set"); }

  create_catalog_group(input: string | CreateCatalogGroupInput, parentId?: string): string {
    const value: CreateCatalogGroupInput = typeof input === "string" ? { label: input, ...(parentId === undefined ? {} : { parent_id: parentId }) } : input;
    const catalog = this.ensure_catalog(); const id = value.id ?? this.#uniqueCatalogId("cg");
    catalog.nodes.push({ ...clone(value), id, kind: "group", label: value.label, service_ids: this.#serviceIds(value.service_ids ?? []), meta: clone(value.meta ?? {}) });
    catalog.active_node_id = id;
    this.#setCatalog(catalog, "group:create"); return id;
  }

  create_smart_catalog_group(input: string | CreateSmartCatalogGroupInput, rules: CatalogSmartRule[] = [], match: "all" | "any" = "all", parentId?: string): string {
    const value: CreateSmartCatalogGroupInput = typeof input === "string" ? { label: input, rules, match, ...(parentId === undefined ? {} : { parent_id: parentId }) } : input;
    const catalog = this.ensure_catalog(); const id = value.id ?? this.#uniqueCatalogId("csg");
    catalog.nodes.push({ ...clone(value), id, kind: "smart", label: value.label, rules: clone(value.rules), match: value.match ?? "all", resolved_service_ids: [], meta: clone(value.meta ?? {}) });
    catalog.active_node_id = id;
    this.#setCatalog(catalog, "smart:create"); return id;
  }

  update_catalog_node(id: string, patch: Partial<CatalogNode>): void {
    const catalog = this.ensure_catalog(); const index = catalog.nodes.findIndex((node) => node.id === id); if (index < 0) return;
    catalog.nodes[index] = { ...catalog.nodes[index], ...clone(patch), id } as CatalogNode;
    const node = catalog.nodes[index]; if (node?.kind === "group") node.service_ids = this.#serviceIds(node.service_ids);
    this.#setCatalog(catalog, "node:update");
  }

  remove_catalog_node(id: string, cascade = false): void {
    const catalog = this.ensure_catalog(); const removed = new Set([id]);
    if (cascade) {
      let changed = true; while (changed) { changed = false; for (const node of catalog.nodes) if (node.parent_id !== undefined && removed.has(node.parent_id) && !removed.has(node.id)) { removed.add(node.id); changed = true; } }
    }
    catalog.nodes = catalog.nodes.filter((node) => !removed.has(node.id));
    catalog.expanded_ids = catalog.expanded_ids.filter((nodeId) => !removed.has(nodeId));
    catalog.pinned_node_ids = catalog.pinned_node_ids.filter((nodeId) => !removed.has(nodeId));
    if (catalog.active_node_id !== undefined && removed.has(catalog.active_node_id)) delete catalog.active_node_id;
    this.#setCatalog(catalog, "node:remove");
  }

  move_catalog_node(id: string, options: { parent_id?: string; before_id?: string; after_id?: string; index?: number } | string | undefined = undefined, oldIndex?: number): void {
    const catalog = this.ensure_catalog(); const current = catalog.nodes.findIndex((node) => node.id === id); if (current < 0) return;
    const [node] = catalog.nodes.splice(current, 1); if (node === undefined) return;
    const move: { parent_id?: string; before_id?: string; after_id?: string; index?: number } = typeof options === "string"
      ? { parent_id: options, ...(oldIndex === undefined ? {} : { index: oldIndex }) }
      : options ?? {};
    if (move.parent_id === undefined) delete node.parent_id; else node.parent_id = move.parent_id;
    const siblings = catalog.nodes.filter((candidate) => candidate.parent_id === move.parent_id).sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
    let destination = move.index ?? siblings.length;
    if (move.before_id !== undefined) { const found = siblings.findIndex((candidate) => candidate.id === move.before_id); if (found >= 0) destination = found; }
    if (move.after_id !== undefined) { const found = siblings.findIndex((candidate) => candidate.id === move.after_id); if (found >= 0) destination = found + 1; }
    siblings.splice(Math.max(0, Math.min(destination, siblings.length)), 0, node); siblings.forEach((candidate, position) => { candidate.order = position; });
    const siblingIds = new Set(siblings.map((candidate) => candidate.id));
    catalog.nodes = [...catalog.nodes.filter((candidate) => !siblingIds.has(candidate.id)), ...siblings];
    this.#setCatalog(catalog, "node:move");
  }

  assign_catalog_services(id: string, serviceIds: readonly ServiceId[], mode: "append" | "replace" | "remove" = "replace"): void {
    const catalog = this.ensure_catalog(); const node = catalog.nodes.find((candidate) => candidate.id === id);
    if (node?.kind === "group") {
      const incoming = this.#serviceIds(serviceIds); const current = this.#serviceIds(node.service_ids);
      if (mode === "replace") node.service_ids = incoming;
      else if (mode === "append") node.service_ids = this.#serviceIds([...current, ...incoming]);
      else node.service_ids = current.filter((value) => !incoming.some((candidate) => String(candidate) === String(value)));
    }
    this.#setCatalog(catalog, "services:assign");
  }

  resolve_smart_catalog_group(id: string, candidates: readonly HandlerService[] | readonly ServiceId[] = this.#options.services, matchers: CatalogSmartMatchers = {}): ServiceId[] {
    const catalog = this.ensure_catalog(); const node = catalog.nodes.find((candidate) => candidate.id === id);
    if (node?.kind !== "smart") return [];
    const services = candidates.length > 0 && typeof candidates[0] === "object" ? candidates as readonly HandlerService[] : undefined;
    const ids = services?.map((service) => service.id) ?? candidates as readonly ServiceId[];
    const byId = new Map(services?.map((service) => [String(service.id), service]) ?? []);
    const matches = (candidate: ServiceId, rule: CatalogSmartRule): boolean => {
      if (rule.type === "service_field") return matchers.service_field?.(candidate, rule) ?? false;
      if (rule.type === "policy_family") return matchers.policy_family?.(candidate, rule) ?? false;
      if (rule.type === "compatibility") return matchers.compatibility?.(candidate, rule) ?? false;
      const service = byId.get(String(candidate)); if (service === undefined) return false;
      if (rule.type === "state") return service.state === rule.state;
      return service.capabilities[rule.capability]?.enabled === (rule.enabled ?? true);
    };
    node.resolved_service_ids = this.#serviceIds(ids.filter((candidate) => node.match === "all" ? node.rules.every((rule) => matches(candidate, rule)) : node.rules.some((rule) => matches(candidate, rule))));
    node.resolved_at = Date.now();
    this.#setCatalog(catalog, "smart:resolve"); return [...node.resolved_service_ids];
  }

  set_catalog_view(patch: Pick<Partial<ServiceCatalogState>, "active_node_id" | "expanded_ids" | "pinned_node_ids" | "selected_service_id" | "view_mode">): void {
    const catalog = { ...this.ensure_catalog(), ...clone(patch) };
    this.#setCatalog(catalog, "view:update");
  }

  set_active_catalog_node(id?: string): void { const catalog = this.ensure_catalog(); if (id === undefined) delete catalog.active_node_id; else catalog.active_node_id = id; this.#setCatalog(catalog, "view:active"); }
  set_catalog_view_mode(mode: ServiceCatalogState["view_mode"]): void { this.set_catalog_view({ view_mode: mode }); }
  set_selected_catalog_service(id?: ServiceId): void { const catalog = this.ensure_catalog(); if (id === undefined) delete catalog.selected_service_id; else catalog.selected_service_id = id; this.#setCatalog(catalog, "view:selected-service"); }
  set_catalog_expanded(id: string, expanded: boolean): void { const values = new Set(this.ensure_catalog().expanded_ids); if (expanded) values.add(id); else values.delete(id); this.set_catalog_view({ expanded_ids: [...values] }); }
  toggle_catalog_expanded(id: string): void { const catalog = this.ensure_catalog(); this.set_catalog_expanded(id, !catalog.expanded_ids.includes(id)); }
  toggle_catalog_pinned(id: string): void { const values = new Set(this.ensure_catalog().pinned_node_ids); if (values.has(id)) values.delete(id); else values.add(id); this.set_catalog_view({ pinned_node_ids: [...values] }); }

  #setCatalog(catalog: ServiceCatalogState | undefined, reason: string): void {
    this.#catalog = catalog === undefined ? undefined : clone(catalog);
    this.#host.emit_catalog_change(this.get_catalog(), reason);
  }

  #mutate(operation: (definition: ProductDefinition) => void): void {
    const definition = clone(this.#builder.definition); operation(definition); this.#builder.load(definition);
  }

  #snapshot(): EditorSnapshot { return { definition: clone(this.#builder.definition), positions: clone(this.#host.snapshot_positions()) }; }

  #restore(snapshot: EditorSnapshot, restorePositions: boolean): void {
    this.#builder.load(snapshot.definition); if (restorePositions) this.#host.restore_positions(snapshot.positions); this.#host.refresh_graph();
  }

  #changed(command: string): void {
    this.#revision += 1; this.#host.refresh_graph(); this.#host.emit_editor_change({ command, definition: clone(this.#builder.definition), revision: this.#revision });
  }

  #uniqueId(base: string, additional = new Map<string, string>()): string {
    const used = new Set([...this.#builder.index.nodeIds(), ...additional.values()]);
    if (!used.has(base)) return base;
    let sequence = 2; while (used.has(`${base}-${sequence}`)) sequence += 1; return `${base}-${sequence}`;
  }

  #uniqueCatalogId(base: string): string {
    const used = new Set(this.#catalog?.nodes.map((node) => node.id) ?? []);
    let sequence = 1; while (used.has(`${base}:${sequence}`)) sequence += 1; return `${base}:${sequence}`;
  }

  #serviceIds(values: readonly ServiceId[]): ServiceId[] { return [...new Map(values.map((value) => [String(value), value])).values()]; }
}
