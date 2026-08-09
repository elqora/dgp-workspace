// SPDX-License-Identifier: GPL-3.0-only

import type { HandlerService, ProductField, ProductFilter, ServiceId } from "@elqora/dgp-spec";
import type { ProductBuilder } from "@elqora/dgp-core";

export type SelectionEnvironment = "client" | "workspace";

export interface SelectedServiceEvidence {
  id: ServiceId;
  service?: HandlerService;
  source_id: string;
  role: "base" | "utility";
}

export interface VisibleGroup {
  filter_id?: string;
  filter?: ProductFilter;
  fields: ProductField[];
  field_ids: string[];
  options_by_field_id?: Readonly<Record<string, string[]>>;
  forced_field_ids?: string[];
  parent_filters?: ProductFilter[];
  children_filters?: ProductFilter[];
  services?: SelectedServiceEvidence[];
}

export type VisibleGroupResult =
  | { kind: "single"; group: VisibleGroup }
  | { kind: "multi"; groups: string[] };

export interface SelectionChange { ids: string[]; primary?: string; }

export interface SelectionOptions {
  environment?: SelectionEnvironment;
  root_filter_id?: string;
  resolve_service?: (id: ServiceId) => HandlerService | undefined;
}

function bindIds(field: ProductField): string[] {
  return field.bind_id === undefined ? [] : Array.isArray(field.bind_id) ? field.bind_id : [field.bind_id];
}

export class Selection {
  readonly #builder: ProductBuilder;
  readonly #options: SelectionOptions;
  #ids = new Set<string>();
  #primary: string | undefined;
  #currentFilter: string | undefined;
  readonly #listeners = new Set<(change: SelectionChange) => void>();

  constructor(builder: ProductBuilder, options: SelectionOptions = {}) {
    this.#builder = builder;
    this.#options = options;
  }

  replace(id?: string | null): void {
    if (id === undefined || id === null || id === "") { this.clear(); return; }
    this.#ids = new Set([id]); this.#primary = id; this.#updateCurrentFilter(id); this.#emit();
  }

  add(id: string): void {
    this.#ids.delete(id); this.#ids.add(id); this.#primary = id; this.#updateCurrentFilter(id); this.#emit();
  }

  remove(id: string): void {
    if (!this.#ids.delete(id)) return;
    if (this.#primary === id) {
      this.#primary = this.#ids.values().next().value;
      if (this.#primary !== undefined) this.#updateCurrentFilter(this.#primary);
    }
    this.#emit();
  }

  toggle(id: string): void { if (this.#ids.has(id)) this.remove(id); else this.add(id); }

  many(ids: Iterable<string>, primary?: string): void {
    this.#ids = new Set(ids);
    this.#primary = primary ?? this.#ids.values().next().value;
    if (this.#primary !== undefined) this.#updateCurrentFilter(this.#primary);
    this.#emit();
  }

  clear(): void {
    if (this.#ids.size === 0 && this.#primary === undefined) return;
    this.#ids.clear(); this.#primary = undefined; this.#emit();
  }

  all(): ReadonlySet<string> { return new Set(this.#ids); }
  has(id: string): boolean { return this.#ids.has(id); }
  primary(): string | undefined { return this.#primary; }
  current_filter(): string | undefined { return this.#currentFilter; }

  on_change(listener: (change: SelectionChange) => void): () => void {
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  }

  selected_triggers(): string[] {
    const triggers: string[] = [];
    for (const id of this.#ids) {
      const node = this.#builder.index.getNode(id);
      if (node.kind === "option" || (node.kind === "field" && node.field.button === true)) triggers.push(id);
    }
    return triggers;
  }

  triggers_by_field(): Record<string, string[]> {
    const grouped: Record<string, string[]> = {};
    for (const id of this.selected_triggers()) {
      const node = this.#builder.index.getNode(id);
      const fieldId = node.kind === "option" ? node.field.id : id;
      const values = grouped[fieldId] ?? [];
      if (!values.includes(id)) values.push(id);
      grouped[fieldId] = values;
    }
    return grouped;
  }

  visible_group(): VisibleGroupResult {
    if ((this.#options.environment ?? "client") === "workspace") {
      const selectedFilters = [...this.#ids].filter((id) => this.#builder.isFilterId(id));
      if (selectedFilters.length > 1) return { kind: "multi", groups: [...this.#ids] };
    }
    const filterId = this.#resolveFilterContext();
    if (filterId === undefined) return { kind: "single", group: { fields: [], field_ids: [] } };
    const definition = this.#builder.definition;
    const visibility = this.#builder.resolveVisibility(filterId, this.selected_triggers());
    const fieldById = new Map(definition.fields.map((field) => [field.id, field]));
    const fields = visibility.fieldIds.flatMap((id) => {
      const field = fieldById.get(id); return field === undefined ? [] : [field];
    });
    const filter = this.#builder.index.getFilter(filterId);
    const lineage = this.#builder.index.filterLineage(filterId);
    const services = this.#selectedServices(filter, fieldById, visibility.fieldIds, visibility.optionsByFieldId);
    return {
      kind: "single",
      group: {
        filter_id: filterId,
        ...(filter === undefined ? {} : { filter }),
        fields,
        field_ids: visibility.fieldIds,
        options_by_field_id: visibility.optionsByFieldId,
        forced_field_ids: visibility.forcedFieldIds,
        parent_filters: lineage.slice(0, -1).reverse(),
        children_filters: definition.filters.filter((candidate) => candidate.bind_id === filterId),
        services,
      },
    };
  }

  #selectedServices(
    filter: ProductFilter | undefined,
    fieldById: ReadonlyMap<string, ProductField>,
    visibleFieldIds: readonly string[],
    optionsByFieldId: Readonly<Record<string, string[]>>,
  ): SelectedServiceEvidence[] {
    const services: SelectedServiceEvidence[] = [];
    if (filter?.service_id !== undefined) {
      services.push({ id: filter.service_id, source_id: filter.id, role: "base", ...(this.#service(filter.service_id)) });
    }
    let baseOverridden = false;
    const visible = new Set(visibleFieldIds);
    for (const id of this.#ids) {
      const node = this.#builder.index.getNode(id);
      let serviceId: ServiceId | undefined;
      let role: "base" | "utility" = "base";
      if (node.kind === "option") {
        const allowed = optionsByFieldId[node.field.id];
        if (!visible.has(node.field.id) || (allowed !== undefined && !allowed.includes(id))) continue;
        serviceId = node.option.service_id;
        role = node.option.pricing_role ?? "base";
      } else if (node.kind === "field" && node.field.button === true && fieldById.has(id)) {
        serviceId = node.field.service_id;
        role = node.field.pricing_role ?? "base";
      }
      if (serviceId === undefined) continue;
      const evidence = { id: serviceId, source_id: id, role, ...this.#service(serviceId) } satisfies SelectedServiceEvidence;
      if (role === "base" && !baseOverridden) {
        if (services[0]?.role === "base") services[0] = evidence;
        else services.unshift(evidence);
        baseOverridden = true;
      } else services.push(evidence);
    }
    return services;
  }

  #service(id: ServiceId): { service?: HandlerService } {
    const service = this.#options.resolve_service?.(id);
    return service === undefined ? {} : { service };
  }

  #resolveFilterContext(): string | undefined {
    if (this.#currentFilter !== undefined) return this.#currentFilter;
    for (const id of this.#ids) if (this.#builder.isFilterId(id)) return id;
    for (const id of this.#ids) {
      const node = this.#builder.index.getNode(id);
      if (node.kind === "field") return bindIds(node.field)[0];
      if (node.kind === "option") return bindIds(node.field)[0];
    }
    return this.#options.root_filter_id ?? this.#builder.definition.filters[0]?.id;
  }

  #updateCurrentFilter(id: string): void {
    const node = this.#builder.index.getNode(id);
    if (node.kind === "filter") { this.#currentFilter = id; return; }
    const field = node.kind === "field" ? node.field : node.kind === "option" ? node.field : undefined;
    if (field === undefined) return;
    if (this.#currentFilter !== undefined
      && this.#builder.visibleFields(this.#currentFilter, this.selected_triggers()).includes(field.id)) return;
    this.#currentFilter = bindIds(field)[0];
  }

  #emit(): void {
    const change: SelectionChange = { ids: [...this.#ids], ...(this.#primary === undefined ? {} : { primary: this.#primary }) };
    for (const listener of this.#listeners) listener(change);
  }
}
