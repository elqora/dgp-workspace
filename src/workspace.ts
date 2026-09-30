// SPDX-License-Identifier: GPL-3.0-only

import type { ProductDefinition } from "@elqora/dgp-spec";
import { createProductBuilder, type ProductBuilder } from "@elqora/dgp-core";
import { createServicePublicationPolicies, validateForPublication, type PublicationValidationOptions } from "@elqora/dgp-validation";

import type { WorkspaceBackend, WorkspaceLiveAdapter, WorkspaceLiveEvent } from "./backend.js";
import { CanvasAPI } from "./canvas.js";
import type { Editor } from "./editor.js";
import type {
  BackendError, BackendResult, CommentThread, FieldTemplate, PublicationReceipt,
  WorkspaceAction, WorkspaceActor, WorkspaceBranchData, WorkspaceCommit,
  WorkspacePermissions, WorkspaceState,
} from "./contracts.js";
import { WORKSPACE_BOOT_SECTIONS, emptyEditorialState, type WorkspaceBootSection } from "./contracts.js";

const ACTIONS: WorkspaceAction[] = [
  "document.mutate", "draft.save", "commit.create", "publish", "branch.create",
  "branch.set_main", "branch.merge", "branch.delete", "template.write", "comment.write",
];

function emptyPermissions(): WorkspacePermissions {
  return Object.fromEntries(ACTIONS.map((action) => [action, false])) as WorkspacePermissions;
}
function bootSections(status: WorkspaceState["boot_sections"][WorkspaceBootSection]): WorkspaceState["boot_sections"] {
  return Object.fromEntries(WORKSPACE_BOOT_SECTIONS.map((section) => [section, status])) as WorkspaceState["boot_sections"];
}

function error(code: string, message: string, retryable = false, meta: Record<string, unknown> = {}): BackendError {
  return { code, message, retryable, meta };
}

function denied(action: WorkspaceAction): BackendResult<never> {
  return { ok: false, error: error("authorization_denied", `The host denied ${action}.`, false, { action }) };
}

export interface WorkspaceRuntimeOptions {
  actor: WorkspaceActor;
  preferred_branch_id?: string;
  autosave_ms?: number;
  auto_autosave?: boolean;
  validation?: PublicationValidationOptions;
  live?: WorkspaceLiveAdapter;
}

export type WorkspaceListener = (state: Readonly<WorkspaceState>) => void;

export function mergeWorkspaceTemplates(
  current: readonly FieldTemplate[],
  incoming: readonly FieldTemplate[],
  options: { since?: string; reconcile_missing_since?: boolean } = {},
): FieldTemplate[] {
  if (options.since === undefined) return [...structuredClone(incoming)];
  const next = new Map(current.map((template) => [template.id, structuredClone(template)]));
  for (const template of incoming) {
    const existing = next.get(template.id); const existingTime = Date.parse(existing?.updated_at ?? ""); const incomingTime = Date.parse(template.updated_at);
    if (existing === undefined || !Number.isFinite(existingTime) || !Number.isFinite(incomingTime) || incomingTime >= existingTime) next.set(template.id, structuredClone(template));
  }
  if (options.reconcile_missing_since === true) {
    const returned = new Set(incoming.map(({ id }) => id)); const since = Date.parse(options.since);
    if (Number.isFinite(since)) for (const template of current) if (!returned.has(template.id) && Date.parse(template.updated_at) >= since) next.delete(template.id);
  }
  return [...next.values()];
}

export class WorkspaceRuntime {
  readonly #backend: WorkspaceBackend;
  readonly #options: WorkspaceRuntimeOptions;
  readonly #listeners = new Set<WorkspaceListener>();
  readonly #branchCache = new Map<string, WorkspaceBranchData>();
  readonly #branchCanvases = new Map<string, CanvasAPI>();
  readonly #hydratingCanvases = new Set<string>();
  #state: WorkspaceState;
  #autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  #disconnectLive: (() => void) | undefined;
  #bootRequest = 0;
  #branchRequest = 0;
  readonly #autosaveRequests = new Map<string, number>();
  readonly #commitRequests = new Map<string, number>();
  readonly #refreshRequests = new Map<string, number>();

  constructor(backend: WorkspaceBackend, options: WorkspaceRuntimeOptions) {
    this.#backend = backend;
    this.#options = options;
    this.#state = {
      status: "idle", workspace_id: null, actor: options.actor, authors: [],
      permissions: emptyPermissions(), branches: [], current_branch_id: null,
      definition: null, head: null, draft: null, templates: [], participants: [],
      comments: [], services: [], policy_rules: [], snapshot_state: "clean", validation: null,
      commits: [],
      revision: 0, backend_revision: 0, last_saved_at: null, error: null,
      boot_sections: bootSections("idle"), boot_errors: {}, boot_partial_failure: false,
    };
  }

  get state(): Readonly<WorkspaceState> { return structuredClone(this.#state); }
  get canvas(): CanvasAPI | undefined {
    const branchId = this.#state.current_branch_id;
    return branchId === null ? undefined : this.#branchCanvases.get(branchId);
  }
  get builder(): ProductBuilder | undefined { return this.canvas?.builder; }
  get editor(): Editor | undefined { return this.canvas?.editor; }

  subscribe(listener: WorkspaceListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #update(patch: Partial<WorkspaceState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener(structuredClone(this.#state));
  }

  #authorized(action: WorkspaceAction): boolean { return this.#state.permissions[action] === true; }

  #hydrateBranch(data: WorkspaceBranchData): BackendResult<void> {
    try { this.#applyBranch(data); return { ok: true, value: undefined }; }
    catch (caught) {
      const failure = error("workspace_hydration_failed", caught instanceof Error ? caught.message : "Workspace branch hydration failed.", false, { cause: caught instanceof Error ? caught.name : typeof caught });
      this.#update({ error: failure }); return { ok: false, error: failure };
    }
  }

  #applyBranch(data: WorkspaceBranchData): void {
    this.#branchCache.set(data.branch.id, structuredClone(data));
    this.#update({
      current_branch_id: data.branch.id,
      definition: structuredClone(data.draft?.definition ?? data.definition),
      head: data.head,
      draft: data.draft,
      templates: [...data.templates],
      participants: [...data.participants],
      comments: [...data.comments],
      commits: [...data.commits],
      snapshot_state: data.draft === null ? "clean" : "uncommitted",
      validation: null,
      revision: 0,
      backend_revision: data.revision,
      error: null,
    });
    this.#activateCanvas(data);
  }

  #activateCanvas(data: WorkspaceBranchData): void {
    const branchId = data.branch.id;
    const document = data.draft?.definition ?? data.definition;
    let canvas = this.#branchCanvases.get(branchId);
    if (canvas !== undefined && JSON.stringify(canvas.builder.definition) !== JSON.stringify(document)) {
      canvas.dispose(); this.#branchCanvases.delete(branchId); canvas = undefined;
    }
    if (canvas === undefined) {
      const builder = createProductBuilder(document, { services: this.#state.services });
      const rootFilterId = document.filters[0]?.id;
      canvas = new CanvasAPI(builder, {
        ...(rootFilterId === undefined ? {} : { root_filter_id: rootFilterId }),
        services: this.#state.services,
        comments: {
          scope: () => ({ branch_id: branchId, actor_id: this.#state.actor.id }),
          port: {
            load: () => Promise.resolve({ ok: true, value: this.#state.current_branch_id === branchId ? [...this.#state.comments] : [...(this.#branchCache.get(branchId)?.comments ?? [])] }),
            save: (thread, actorId) => this.#authorized("comment.write") ? this.#backend.save_comment(thread, actorId) : Promise.resolve(denied("comment.write")),
            delete: (threadId, actorId) => this.#authorized("comment.write") ? this.#backend.delete_comment(threadId, actorId) : Promise.resolve(denied("comment.write")),
          },
          on_change: () => {
            if (this.#state.current_branch_id !== branchId) return;
            const threads = canvas?.comments.list().map((item) => { const thread = structuredClone(item) as Partial<typeof item>; delete thread.sync_state; delete thread.sync_error; return thread as CommentThread; }) ?? [];
            this.#update({ comments: structuredClone(threads) }); this.#cacheCurrent();
          },
        },
      });
      canvas.on("editor:change", ({ definition }) => {
        if (this.#state.current_branch_id !== branchId) return;
        this.#update({ definition: structuredClone(definition), snapshot_state: "dirty", validation: null, revision: this.#state.revision + 1 });
        this.#cacheCurrent(); this.#scheduleAutosave();
      });
      const markEditorialDirty = (): void => {
        if (this.#state.current_branch_id !== branchId || this.#hydratingCanvases.has(branchId)) return;
        this.#update({ snapshot_state: "dirty", revision: this.#state.revision + 1 }); this.#cacheCurrent(); this.#scheduleAutosave();
      };
      for (const event of ["positions:change", "selection:change", "highlight:change", "hover:change", "viewport:change", "edge:change", "options:visibility", "catalog:change"] as const) canvas.on(event, markEditorialDirty);
      this.#branchCanvases.set(branchId, canvas);
    }
    canvas.update_services(this.#state.services);
    this.#hydratingCanvases.add(branchId);
    try { canvas.restore_editorial_state(data.draft?.editorial_state ?? data.editorial_state); } finally { this.#hydratingCanvases.delete(branchId); }
    canvas.comments.replace(data.comments);
  }

  #cacheCurrent(): void {
    const branchId = this.#state.current_branch_id;
    const definition = this.#state.definition;
    const branch = this.#state.branches.find((item) => item.id === branchId);
    if (branchId === null || definition === null || branch === undefined) return;
    this.#branchCache.set(branchId, structuredClone({
      branch, definition, editorial_state: this.canvas?.editorial_state() ?? emptyEditorialState(), head: this.#state.head, draft: this.#state.draft,
      templates: this.#state.templates, participants: this.#state.participants,
      comments: this.#state.comments,
      commits: this.#state.commits,
      revision: this.#state.backend_revision,
    }));
  }

  async boot(): Promise<BackendResult<void>> {
    const request = ++this.#bootRequest;
    this.#update({ status: "booting", error: null, boot_sections: bootSections("loading"), boot_errors: {}, boot_partial_failure: false });
    const loaded = await this.#backend.load(this.#options.actor, this.#options.preferred_branch_id);
    if (request !== this.#bootRequest) return { ok: true, value: undefined };
    if (!loaded.ok) { this.#update({ status: "error", error: loaded.error, boot_sections: bootSections("error") }); return loaded; }
    const value = loaded.value;
    const sectionErrors = value.section_errors ?? {};
    const sections = Object.fromEntries(WORKSPACE_BOOT_SECTIONS.map((section) => [section, sectionErrors[section] === undefined ? "success" : "error"])) as WorkspaceState["boot_sections"];
    const blocking = Object.entries(sectionErrors).find(([section]) => section !== "comments")?.[1];
    this.#update({
      status: blocking === undefined ? "ready" : "error", workspace_id: value.workspace_id, authors: [...value.authors],
      permissions: { ...value.permissions }, branches: [...value.branches], services: [...value.services], policy_rules: [...value.policy_rules],
      boot_sections: sections, boot_errors: { ...sectionErrors }, boot_partial_failure: Object.keys(sectionErrors).length > 0,
      error: blocking ?? null,
    });
    const hydrated = this.#hydrateBranch(value.current); if (!hydrated.ok) { this.#update({ status: "error" }); return hydrated; }
    this.#update({ error: blocking ?? null });
    if (this.#options.live !== undefined) await this.connect_live();
    return { ok: true, value: undefined };
  }

  async refresh(): Promise<BackendResult<void>> { return this.boot(); }
  async retry_boot_section(section: WorkspaceBootSection): Promise<BackendResult<void>> { void section; return this.boot(); }

  async switch_branch(branchId: string): Promise<BackendResult<void>> {
    const request = ++this.#branchRequest;
    const cached = this.#branchCache.get(branchId);
    if (cached !== undefined) return this.#hydrateBranch(cached);
    const loaded = await this.#backend.load_branch(branchId);
    if (request !== this.#branchRequest) return { ok: true, value: undefined };
    if (!loaded.ok) { this.#update({ error: loaded.error }); return loaded; }
    return this.#hydrateBranch(loaded.value);
  }

  async refresh_branch(branchId = this.#state.current_branch_id): Promise<BackendResult<void>> {
    if (branchId === null) return { ok: false, error: error("branch_missing", "No branch is selected.") };
    const request = (this.#refreshRequests.get(branchId) ?? 0) + 1; this.#refreshRequests.set(branchId, request);
    const localRevision = this.#state.current_branch_id === branchId ? this.#state.revision : undefined;
    const loaded = await this.#backend.load_branch(branchId);
    if (this.#refreshRequests.get(branchId) !== request) return { ok: true, value: undefined };
    if (!loaded.ok) { this.#update({ error: loaded.error }); return loaded; }
    this.#branchCache.set(branchId, structuredClone(loaded.value));
    if (this.#state.current_branch_id === branchId && this.#state.revision === localRevision) return this.#hydrateBranch(loaded.value);
    return { ok: true, value: undefined };
  }

  mutate(mutator: (definition: ProductDefinition) => ProductDefinition): BackendResult<void> {
    if (!this.#authorized("document.mutate")) return denied("document.mutate");
    if (this.#state.definition === null) return { ok: false, error: error("document_missing", "No definition is loaded.") };
    const next = mutator(structuredClone(this.#state.definition));
    if (this.editor !== undefined) this.editor.replace(next, "workspace:mutate");
    else {
      this.#update({ definition: structuredClone(next), snapshot_state: "dirty", validation: null, revision: this.#state.revision + 1 });
      this.#cacheCurrent(); this.#scheduleAutosave();
    }
    return { ok: true, value: undefined };
  }

  replace(definition: ProductDefinition): BackendResult<void> { return this.mutate(() => definition); }

  validate(): ReturnType<typeof validateForPublication> | null {
    if (this.#state.definition === null) return null;
    const result = validateForPublication(this.#state.definition, {
      ...this.#options.validation,
      services: this.#options.validation?.services ?? this.#state.services,
      policies: this.#options.validation?.policies ?? createServicePublicationPolicies(this.#state.policy_rules),
    });
    this.#update({ validation: result });
    return result;
  }

  #scheduleAutosave(): void {
    if (this.#options.auto_autosave === false) return;
    if (this.#autosaveTimer !== undefined) clearTimeout(this.#autosaveTimer);
    this.#autosaveTimer = setTimeout(() => { void this.autosave(); }, this.#options.autosave_ms ?? 9000);
  }

  async autosave(): Promise<BackendResult<import("./contracts.js").WorkspaceDraft>> {
    if (!this.#authorized("draft.save")) return denied("draft.save");
    const { definition, current_branch_id: branchId, revision } = this.#state;
    if (definition === null || branchId === null) return { ok: false, error: error("document_missing", "No branch document is loaded.") };
    const request = (this.#autosaveRequests.get(branchId) ?? 0) + 1;
    this.#autosaveRequests.set(branchId, request);
    this.#update({ snapshot_state: "saving" });
    const saved = await this.#backend.save_draft({
      branch_id: branchId, actor_id: this.#state.actor.id,
      definition: structuredClone(definition), base_commit_id: this.#state.head?.id ?? null,
      editorial_state: this.canvas?.editorial_state() ?? emptyEditorialState(),
      base_revision: this.#state.backend_revision,
    });
    if (this.#autosaveRequests.get(branchId) !== request) return saved;
    if (!saved.ok) { this.#update({ snapshot_state: "dirty", error: saved.error }); return saved; }
    this.#update({
      draft: saved.value,
      backend_revision: saved.value.revision,
      snapshot_state: this.#state.revision === revision ? "uncommitted" : "dirty",
      last_saved_at: Date.now(), error: null,
    });
    this.#cacheCurrent();
    return saved;
  }

  async commit(message = "Save changes"): Promise<BackendResult<WorkspaceCommit>> {
    if (!this.#authorized("commit.create")) return denied("commit.create");
    const { definition, current_branch_id: branchId, revision } = this.#state;
    if (definition === null || branchId === null) return { ok: false, error: error("document_missing", "No branch document is loaded.") };
    const request = (this.#commitRequests.get(branchId) ?? 0) + 1;
    this.#commitRequests.set(branchId, request);
    const committed = await this.#backend.create_commit({
      branch_id: branchId, actor_id: this.#state.actor.id, definition: structuredClone(definition),
      editorial_state: this.canvas?.editorial_state() ?? emptyEditorialState(),
      base_commit_id: this.#state.head?.id ?? null, message,
      base_revision: this.#state.backend_revision,
    });
    if (this.#commitRequests.get(branchId) !== request) return committed;
    if (!committed.ok) { this.#update({ error: committed.error }); return committed; }
    this.#update({
      head: committed.value, draft: null,
      backend_revision: committed.value.revision,
      commits: [...this.#state.commits, committed.value],
      snapshot_state: this.#state.revision === revision ? "clean" : "dirty",
      last_saved_at: Date.now(), error: null,
    });
    this.#cacheCurrent();
    return committed;
  }

  async publish(message = "Publish"): Promise<BackendResult<PublicationReceipt>> {
    if (!this.#authorized("publish")) return denied("publish");
    const validation = this.validate();
    if (validation === null || !validation.publishable) {
      return { ok: false, error: error("publication_validation_failed", "The definition is not publishable.", false, { validation }) };
    }
    const { definition, current_branch_id: branchId, revision } = this.#state;
    if (definition === null || branchId === null) return { ok: false, error: error("document_missing", "No branch document is loaded.") };
    const request = (this.#commitRequests.get(branchId) ?? 0) + 1;
    this.#commitRequests.set(branchId, request);
    const published = await this.#backend.publish({
      branch_id: branchId, actor_id: this.#state.actor.id, definition: structuredClone(definition),
      editorial_state: this.canvas?.editorial_state() ?? emptyEditorialState(),
      base_commit_id: this.#state.head?.id ?? null, message, validation_revision: revision,
      base_revision: this.#state.backend_revision,
    });
    if (this.#commitRequests.get(branchId) !== request) return published;
    if (!published.ok) { this.#update({ error: published.error }); return published; }
    this.#update({
      head: published.value.commit, draft: null,
      backend_revision: published.value.commit.revision,
      commits: [...this.#state.commits, published.value.commit],
      snapshot_state: this.#state.revision === revision ? "clean" : "dirty",
      last_saved_at: Date.now(), error: null,
    });
    this.#cacheCurrent();
    return published;
  }

  async discard_draft(): Promise<BackendResult<void>> {
    if (!this.#authorized("draft.save")) return denied("draft.save");
    const branchId = this.#state.current_branch_id;
    if (branchId === null) return { ok: false, error: error("branch_missing", "No branch is selected.") };
    const discarded = await this.#backend.discard_draft(branchId, this.#state.actor.id);
    if (!discarded.ok) return discarded;
    this.#branchCache.delete(branchId);
    return this.refresh_branch(branchId);
  }

  async create_branch(name: string, fromBranchId = this.#state.current_branch_id ?? undefined): Promise<BackendResult<void>> {
    if (!this.#authorized("branch.create")) return denied("branch.create");
    const created = await this.#backend.create_branch(name, this.#state.actor.id, fromBranchId);
    if (!created.ok) return created;
    this.#update({ branches: [...this.#state.branches, created.value.branch] });
    return this.#hydrateBranch(created.value);
  }

  async set_main(branchId: string): Promise<BackendResult<void>> {
    if (!this.#authorized("branch.set_main")) return denied("branch.set_main");
    const updated = await this.#backend.set_main(branchId, this.#state.actor.id);
    if (!updated.ok) return updated;
    this.#update({ branches: this.#state.branches.map((branch) => ({ ...branch, main: branch.id === branchId })) });
    this.#cacheCurrent();
    return { ok: true, value: undefined };
  }

  async load_snapshot(commitId: string): Promise<BackendResult<WorkspaceCommit>> {
    const branchId = this.#state.current_branch_id;
    if (branchId === null) return { ok: false, error: error("branch_missing", "No branch is selected.") };
    return this.#backend.load_commit(branchId, commitId);
  }

  async restore_snapshot(commitId: string): Promise<BackendResult<void>> {
    const loaded = await this.load_snapshot(commitId);
    if (!loaded.ok) return loaded;
    const replaced = this.replace(structuredClone(loaded.value.definition)); if (!replaced.ok) return replaced;
    const branchId = this.#state.current_branch_id; const canvas = this.canvas;
    if (branchId !== null && canvas !== undefined) {
      this.#hydratingCanvases.add(branchId); try { canvas.restore_editorial_state(loaded.value.editorial_state); } finally { this.#hydratingCanvases.delete(branchId); } this.#cacheCurrent();
    }
    return { ok: true, value: undefined };
  }

  async merge_branch(sourceId: string, targetId: string): Promise<BackendResult<void>> {
    if (!this.#authorized("branch.merge")) return denied("branch.merge");
    const merged = await this.#backend.merge_branch(sourceId, targetId, this.#state.actor.id);
    if (!merged.ok) return merged;
    this.#branchCache.set(targetId, structuredClone(merged.value));
    if (this.#state.current_branch_id === targetId) return this.#hydrateBranch(merged.value);
    return { ok: true, value: undefined };
  }

  async delete_branch(branchId: string): Promise<BackendResult<void>> {
    if (!this.#authorized("branch.delete")) return denied("branch.delete");
    const removed = await this.#backend.delete_branch(branchId, this.#state.actor.id);
    if (!removed.ok) return removed;
    this.#branchCache.delete(branchId);
    const branches = this.#state.branches.filter((branch) => branch.id !== branchId);
    this.#update({ branches });
    if (this.#state.current_branch_id === branchId && branches[0] !== undefined) return this.switch_branch(branches[0].id);
    return { ok: true, value: undefined };
  }

  async save_template(template: FieldTemplate): Promise<BackendResult<FieldTemplate>> {
    if (!this.#authorized("template.write")) return denied("template.write");
    const saved = await this.#backend.save_template(structuredClone(template), this.#state.actor.id);
    if (saved.ok) this.#updateTemplateViews(saved.value.id, saved.value);
    return saved;
  }

  capture_field_template(rootId: string, options: boolean | import("./editor.js").TemplateCaptureOptions = false): BackendResult<Pick<FieldTemplate, "field" | "connected_fields" | "relationships" | "notices" | "fallbacks">> {
    if (!this.#authorized("template.write")) return denied("template.write");
    if (this.editor === undefined) return { ok: false, error: error("document_missing", "No editable document is loaded.") };
    try { return { ok: true, value: this.editor.capture_template(rootId, options) }; }
    catch (caught) { return { ok: false, error: error("template_invalid", caught instanceof Error ? caught.message : "Cannot capture template.") }; }
  }

  instantiate_template(templateId: string, options: { bind_id?: string | string[] } = {}): BackendResult<{ root_id: string; field_ids: string[]; id_map: Record<string, string> }> {
    if (!this.#authorized("document.mutate")) return denied("document.mutate");
    if (this.editor === undefined) return { ok: false, error: error("document_missing", "No editable document is loaded.") };
    const template = this.#state.templates.find((item) => item.id === templateId);
    if (template === undefined) return { ok: false, error: error("template_not_found", `Template ${templateId} was not found.`) };
    try { return { ok: true, value: this.editor.instantiate_template(template, options) }; }
    catch (caught) { return { ok: false, error: error("template_invalid", caught instanceof Error ? caught.message : "Cannot instantiate template.") }; }
  }

  #updateTemplateViews(templateId: string, saved?: FieldTemplate): void {
    const visible = (branchId: string): boolean => saved !== undefined && (saved.branch_id === null || saved.branch_id === branchId);
    for (const [branchId, data] of this.#branchCache) {
      const templates = data.templates.filter((item) => item.id !== templateId);
      if (visible(branchId)) templates.push(structuredClone(saved as FieldTemplate));
      this.#branchCache.set(branchId, { ...data, templates });
    }
    const branchId = this.#state.current_branch_id;
    if (branchId !== null) {
      const templates = this.#state.templates.filter((item) => item.id !== templateId);
      if (visible(branchId)) templates.push(structuredClone(saved as FieldTemplate));
      this.#update({ templates }); this.#cacheCurrent();
    }
  }

  async create_template(input: Omit<FieldTemplate, "id" | "updated_at"> & { id?: string }): Promise<BackendResult<FieldTemplate>> {
    return this.save_template({ ...structuredClone(input), id: input.id ?? "", updated_at: new Date(0).toISOString() });
  }

  async update_template(templateId: string, patch: Partial<Omit<FieldTemplate, "id">>): Promise<BackendResult<FieldTemplate>> {
    const current = this.#state.templates.find((template) => template.id === templateId);
    if (current === undefined) return { ok: false, error: error("template_not_found", `Template ${templateId} was not found.`) };
    return this.save_template({ ...current, ...structuredClone(patch), id: templateId });
  }

  async clone_template(source: { id?: string; key?: string }, options: { key?: string; name?: string; branch_id?: string | null; published?: boolean } = {}): Promise<BackendResult<FieldTemplate>> {
    const current = this.#state.templates.find((template) => source.id !== undefined ? template.id === source.id : template.key === source.key);
    if (current === undefined) return { ok: false, error: error("template_not_found", "The template to clone was not found.") };
    return this.save_template({
      ...structuredClone(current), id: "", key: options.key ?? `${current.key}-copy`, name: options.name ?? `${current.name} copy`,
      branch_id: options.branch_id === undefined ? current.branch_id : options.branch_id, published: options.published ?? false,
    });
  }

  async publish_template(templateId: string): Promise<BackendResult<FieldTemplate>> { return this.update_template(templateId, { published: true }); }
  async unpublish_template(templateId: string): Promise<BackendResult<FieldTemplate>> { return this.update_template(templateId, { published: false }); }

  async delete_template(templateId: string): Promise<BackendResult<void>> {
    if (!this.#authorized("template.write")) return denied("template.write");
    const removed = await this.#backend.delete_template(templateId, this.#state.actor.id);
    if (removed.ok) this.#updateTemplateViews(templateId);
    return removed;
  }

  reconcile_templates(incoming: readonly FieldTemplate[], options: { since?: string; reconcile_missing_since?: boolean } = {}): void {
    const templates = mergeWorkspaceTemplates(this.#state.templates, incoming, options); this.#update({ templates }); this.#cacheCurrent();
  }

  async save_comment(thread: CommentThread): Promise<BackendResult<CommentThread>> {
    if (!this.#authorized("comment.write")) return denied("comment.write");
    const saved = await this.#backend.save_comment(structuredClone(thread), this.#state.actor.id);
    if (saved.ok) { const comments = [...this.#state.comments.filter((item) => item.id !== saved.value.id), saved.value]; this.#update({ comments }); this.canvas?.comments.replace(comments); this.#cacheCurrent(); }
    return saved;
  }

  async delete_comment(threadId: string): Promise<BackendResult<void>> {
    if (!this.#authorized("comment.write")) return denied("comment.write");
    const removed = await this.#backend.delete_comment(threadId, this.#state.actor.id);
    if (removed.ok) { const comments = this.#state.comments.filter((item) => item.id !== threadId); this.#update({ comments }); this.canvas?.comments.replace(comments); this.#cacheCurrent(); }
    return removed;
  }

  async connect_live(): Promise<void> {
    if (this.#options.live === undefined || this.#disconnectLive !== undefined) return;
    this.#disconnectLive = await this.#options.live.connect((event) => { void this.#handleLiveEvent(event); });
  }

  disconnect_live(): void { this.#disconnectLive?.(); this.#disconnectLive = undefined; }

  async #handleLiveEvent(event: WorkspaceLiveEvent): Promise<void> {
    const currentIsAffected = event.type === "workspace.invalidate"
      || event.branch_id === this.#state.current_branch_id;
    if (currentIsAffected && (this.#state.snapshot_state === "dirty" || this.#state.snapshot_state === "saving")) {
      this.#update({
        error: error(
          "live_update_deferred",
          "A live update was deferred because the current document has unsaved changes.",
          true,
          { event },
        ),
      });
      return;
    }
    if (event.type === "workspace.invalidate") { await this.refresh(); return; }
    if (event.type === "branch.invalidate") { this.#branchCache.delete(event.branch_id); await this.refresh_branch(event.branch_id); return; }
    this.#branchCache.delete(event.branch_id);
    if (this.#state.current_branch_id === event.branch_id) await this.refresh();
  }

  dispose(): void {
    if (this.#autosaveTimer !== undefined) clearTimeout(this.#autosaveTimer);
    this.disconnect_live();
    for (const canvas of this.#branchCanvases.values()) canvas.dispose();
    this.#branchCanvases.clear();
    this.#listeners.clear();
  }
}
