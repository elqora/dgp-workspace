// SPDX-License-Identifier: GPL-3.0-only

import type { ProductDefinition } from "@elqora/dgp-spec";
import { validateForPublication, type PublicationValidationOptions } from "@elqora/dgp-validation";

import type { WorkspaceBackend, WorkspaceLiveAdapter, WorkspaceLiveEvent } from "./backend.js";
import type {
  BackendError, BackendResult, CommentThread, FieldTemplate, PublicationReceipt,
  WorkspaceAction, WorkspaceActor, WorkspaceBranchData, WorkspaceCommit,
  WorkspacePermissions, WorkspaceState,
} from "./contracts.js";

const ACTIONS: WorkspaceAction[] = [
  "document.mutate", "draft.save", "commit.create", "publish", "branch.create",
  "branch.set_main", "branch.merge", "branch.delete", "template.write", "comment.write",
];

function emptyPermissions(): WorkspacePermissions {
  return Object.fromEntries(ACTIONS.map((action) => [action, false])) as WorkspacePermissions;
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

export class WorkspaceRuntime {
  readonly #backend: WorkspaceBackend;
  readonly #options: WorkspaceRuntimeOptions;
  readonly #listeners = new Set<WorkspaceListener>();
  readonly #branchCache = new Map<string, WorkspaceBranchData>();
  #state: WorkspaceState;
  #autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  #disconnectLive: (() => void) | undefined;

  constructor(backend: WorkspaceBackend, options: WorkspaceRuntimeOptions) {
    this.#backend = backend;
    this.#options = options;
    this.#state = {
      status: "idle", workspace_id: null, actor: options.actor, authors: [],
      permissions: emptyPermissions(), branches: [], current_branch_id: null,
      definition: null, head: null, draft: null, templates: [], participants: [],
      comments: [], services: [], snapshot_state: "clean", validation: null,
      commits: [],
      revision: 0, last_saved_at: null, error: null,
    };
  }

  get state(): Readonly<WorkspaceState> { return this.#state; }

  subscribe(listener: WorkspaceListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #update(patch: Partial<WorkspaceState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener(this.#state);
  }

  #authorized(action: WorkspaceAction): boolean { return this.#state.permissions[action] === true; }

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
      error: null,
    });
  }

  #cacheCurrent(): void {
    const branchId = this.#state.current_branch_id;
    const definition = this.#state.definition;
    const branch = this.#state.branches.find((item) => item.id === branchId);
    if (branchId === null || definition === null || branch === undefined) return;
    this.#branchCache.set(branchId, structuredClone({
      branch, definition, head: this.#state.head, draft: this.#state.draft,
      templates: this.#state.templates, participants: this.#state.participants,
      comments: this.#state.comments,
      commits: this.#state.commits,
    }));
  }

  async boot(): Promise<BackendResult<void>> {
    this.#update({ status: "booting", error: null });
    const loaded = await this.#backend.load(this.#options.actor, this.#options.preferred_branch_id);
    if (!loaded.ok) { this.#update({ status: "error", error: loaded.error }); return loaded; }
    const value = loaded.value;
    this.#update({
      status: "ready", workspace_id: value.workspace_id, authors: [...value.authors],
      permissions: { ...value.permissions }, branches: [...value.branches], services: [...value.services],
    });
    this.#applyBranch(value.current);
    if (this.#options.live !== undefined) await this.connect_live();
    return { ok: true, value: undefined };
  }

  async refresh(): Promise<BackendResult<void>> { return this.boot(); }

  async switch_branch(branchId: string): Promise<BackendResult<void>> {
    const cached = this.#branchCache.get(branchId);
    if (cached !== undefined) { this.#applyBranch(cached); return { ok: true, value: undefined }; }
    const loaded = await this.#backend.load_branch(branchId);
    if (!loaded.ok) { this.#update({ error: loaded.error }); return loaded; }
    this.#applyBranch(loaded.value);
    return { ok: true, value: undefined };
  }

  async refresh_branch(branchId = this.#state.current_branch_id): Promise<BackendResult<void>> {
    if (branchId === null) return { ok: false, error: error("branch_missing", "No branch is selected.") };
    const loaded = await this.#backend.load_branch(branchId);
    if (!loaded.ok) { this.#update({ error: loaded.error }); return loaded; }
    this.#branchCache.set(branchId, structuredClone(loaded.value));
    if (this.#state.current_branch_id === branchId) this.#applyBranch(loaded.value);
    return { ok: true, value: undefined };
  }

  mutate(mutator: (definition: ProductDefinition) => ProductDefinition): BackendResult<void> {
    if (!this.#authorized("document.mutate")) return denied("document.mutate");
    if (this.#state.definition === null) return { ok: false, error: error("document_missing", "No definition is loaded.") };
    const next = mutator(structuredClone(this.#state.definition));
    this.#update({ definition: structuredClone(next), snapshot_state: "dirty", validation: null, revision: this.#state.revision + 1 });
    this.#cacheCurrent();
    this.#scheduleAutosave();
    return { ok: true, value: undefined };
  }

  replace(definition: ProductDefinition): BackendResult<void> { return this.mutate(() => definition); }

  validate(): ReturnType<typeof validateForPublication> | null {
    if (this.#state.definition === null) return null;
    const result = validateForPublication(this.#state.definition, {
      ...this.#options.validation,
      services: this.#options.validation?.services ?? this.#state.services,
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
    this.#update({ snapshot_state: "saving" });
    const saved = await this.#backend.save_draft({
      branch_id: branchId, actor_id: this.#state.actor.id,
      definition: structuredClone(definition), base_commit_id: this.#state.head?.id ?? null,
    });
    if (!saved.ok) { this.#update({ snapshot_state: "dirty", error: saved.error }); return saved; }
    this.#update({
      draft: saved.value,
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
    const committed = await this.#backend.create_commit({
      branch_id: branchId, actor_id: this.#state.actor.id, definition: structuredClone(definition),
      base_commit_id: this.#state.head?.id ?? null, message,
    });
    if (!committed.ok) { this.#update({ error: committed.error }); return committed; }
    this.#update({
      head: committed.value, draft: null,
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
    const published = await this.#backend.publish({
      branch_id: branchId, actor_id: this.#state.actor.id, definition: structuredClone(definition),
      base_commit_id: this.#state.head?.id ?? null, message, validation_revision: revision,
    });
    if (!published.ok) { this.#update({ error: published.error }); return published; }
    this.#update({
      head: published.value.commit, draft: null,
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
    this.#applyBranch(created.value);
    return { ok: true, value: undefined };
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
    return this.replace(structuredClone(loaded.value.definition));
  }

  async merge_branch(sourceId: string, targetId: string): Promise<BackendResult<void>> {
    if (!this.#authorized("branch.merge")) return denied("branch.merge");
    const merged = await this.#backend.merge_branch(sourceId, targetId, this.#state.actor.id);
    if (!merged.ok) return merged;
    this.#branchCache.set(targetId, structuredClone(merged.value));
    if (this.#state.current_branch_id === targetId) this.#applyBranch(merged.value);
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
    if (saved.ok) { this.#update({ templates: [...this.#state.templates.filter((item) => item.id !== saved.value.id), saved.value] }); this.#cacheCurrent(); }
    return saved;
  }

  async delete_template(templateId: string): Promise<BackendResult<void>> {
    if (!this.#authorized("template.write")) return denied("template.write");
    const removed = await this.#backend.delete_template(templateId, this.#state.actor.id);
    if (removed.ok) { this.#update({ templates: this.#state.templates.filter((item) => item.id !== templateId) }); this.#cacheCurrent(); }
    return removed;
  }

  async save_comment(thread: CommentThread): Promise<BackendResult<CommentThread>> {
    if (!this.#authorized("comment.write")) return denied("comment.write");
    const saved = await this.#backend.save_comment(structuredClone(thread), this.#state.actor.id);
    if (saved.ok) { this.#update({ comments: [...this.#state.comments.filter((item) => item.id !== saved.value.id), saved.value] }); this.#cacheCurrent(); }
    return saved;
  }

  async delete_comment(threadId: string): Promise<BackendResult<void>> {
    if (!this.#authorized("comment.write")) return denied("comment.write");
    const removed = await this.#backend.delete_comment(threadId, this.#state.actor.id);
    if (removed.ok) { this.#update({ comments: this.#state.comments.filter((item) => item.id !== threadId) }); this.#cacheCurrent(); }
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
    this.#listeners.clear();
  }
}
