// SPDX-License-Identifier: GPL-3.0-only

import type { HandlerService, ProductDefinition } from "@elqora/dgp-spec";

import type { CreateCommitInput, PublishInput, SaveDraftInput, WorkspaceBackend } from "./backend.js";
import type {
  BackendError, BackendResult, CommentThread, FieldTemplate, PublicationReceipt,
  WorkspaceActor, WorkspaceAuthor, WorkspaceBootData, WorkspaceBranch,
  WorkspaceBranchData, WorkspaceCommit, WorkspacePermissions,
} from "./contracts.js";

function ok<T>(value: T): BackendResult<T> { return { ok: true, value: structuredClone(value) }; }
function fail<T>(code: string, message: string): BackendResult<T> {
  const error: BackendError = { code, message, retryable: false, meta: {} };
  return { ok: false, error };
}

const allPermissions: WorkspacePermissions = {
  "document.mutate": true, "draft.save": true, "commit.create": true,
  publish: true, "branch.create": true, "branch.merge": true,
  "branch.delete": true, "template.write": true, "comment.write": true,
};

export interface MemoryWorkspaceSeed {
  workspace_id?: string;
  definition: ProductDefinition;
  branch_name?: string;
  authors?: WorkspaceAuthor[];
  permissions?: WorkspacePermissions;
  services?: HandlerService[];
  now?: () => string;
}

export class MemoryWorkspaceBackend implements WorkspaceBackend {
  readonly #workspaceId: string;
  readonly #authors: WorkspaceAuthor[];
  readonly #permissions: WorkspacePermissions;
  readonly #services: HandlerService[];
  readonly #branches = new Map<string, WorkspaceBranchData>();
  readonly #now: () => string;
  #sequence = 1;

  constructor(seed: MemoryWorkspaceSeed) {
    this.#workspaceId = seed.workspace_id ?? "memory-workspace";
    this.#authors = structuredClone(seed.authors ?? []);
    this.#permissions = { ...(seed.permissions ?? allPermissions) };
    this.#services = structuredClone(seed.services ?? []);
    this.#now = seed.now ?? (() => new Date().toISOString());
    const branch: WorkspaceBranch = {
      id: "main", name: seed.branch_name ?? "Main", main: true,
      created_at: this.#now(), created_by: "system", meta: {},
    };
    this.#branches.set(branch.id, {
      branch, definition: structuredClone(seed.definition), head: null, draft: null,
      templates: [], participants: [], comments: [],
      commits: [],
    });
  }

  #id(prefix: string): string { return `${prefix}-${this.#sequence++}`; }
  #branch(id: string): WorkspaceBranchData | undefined { return this.#branches.get(id); }

  async load(actor: WorkspaceActor, preferredBranchId?: string): Promise<BackendResult<WorkspaceBootData>> {
    void actor;
    const current = this.#branch(preferredBranchId ?? "main") ?? this.#branches.values().next().value;
    if (current === undefined) return fail("workspace_empty", "The workspace has no branches.");
    return ok({
      workspace_id: this.#workspaceId, authors: this.#authors,
      permissions: this.#permissions, branches: [...this.#branches.values()].map((item) => item.branch),
      current_branch_id: current.branch.id, services: this.#services, current,
    });
  }

  async load_branch(branchId: string): Promise<BackendResult<WorkspaceBranchData>> {
    const branch = this.#branch(branchId);
    return branch === undefined ? fail("branch_not_found", `Branch ${branchId} was not found.`) : ok(branch);
  }

  async load_commit(branchId: string, commitId: string): Promise<BackendResult<WorkspaceCommit>> {
    const branch = this.#branch(branchId);
    const commit = branch?.commits.find((item) => item.id === commitId);
    return commit === undefined ? fail("commit_not_found", `Commit ${commitId} was not found.`) : ok(commit);
  }

  async save_draft(input: SaveDraftInput): Promise<BackendResult<import("./contracts.js").WorkspaceDraft>> {
    const branch = this.#branch(input.branch_id);
    if (branch === undefined) return fail("branch_not_found", `Branch ${input.branch_id} was not found.`);
    const draft = {
      id: branch.draft?.id ?? this.#id("draft"), branch_id: input.branch_id,
      author_id: input.actor_id, updated_at: this.#now(), definition: structuredClone(input.definition),
      base_commit_id: input.base_commit_id, meta: {},
    };
    branch.draft = draft;
    return ok(draft);
  }

  async create_commit(input: CreateCommitInput): Promise<BackendResult<WorkspaceCommit>> {
    const branch = this.#branch(input.branch_id);
    if (branch === undefined) return fail("branch_not_found", `Branch ${input.branch_id} was not found.`);
    const commit: WorkspaceCommit = {
      id: this.#id("commit"), branch_id: input.branch_id, message: input.message,
      author_id: input.actor_id, created_at: this.#now(), definition: structuredClone(input.definition), meta: {},
    };
    branch.definition = structuredClone(input.definition);
    branch.head = commit;
    branch.commits.push(commit);
    branch.draft = null;
    return ok(commit);
  }

  async publish(input: PublishInput): Promise<BackendResult<PublicationReceipt>> {
    const committed = await this.create_commit(input);
    if (!committed.ok) return committed;
    return ok({
      commit: committed.value, published_at: this.#now(),
      publication_id: this.#id("publication"), meta: { validation_revision: input.validation_revision },
    });
  }

  async discard_draft(branchId: string): Promise<BackendResult<void>> {
    const branch = this.#branch(branchId);
    if (branch === undefined) return fail("branch_not_found", `Branch ${branchId} was not found.`);
    branch.draft = null;
    return ok(undefined);
  }

  async create_branch(name: string, actorId: string, fromBranchId = "main"): Promise<BackendResult<WorkspaceBranchData>> {
    const source = this.#branch(fromBranchId);
    if (source === undefined) return fail("branch_not_found", `Branch ${fromBranchId} was not found.`);
    const id = this.#id("branch");
    const data: WorkspaceBranchData = {
      branch: { id, name, main: false, created_at: this.#now(), created_by: actorId, meta: {} },
      definition: structuredClone(source.definition), head: source.head === null ? null : { ...structuredClone(source.head), branch_id: id },
      draft: null, templates: structuredClone(source.templates), participants: [], comments: [],
      commits: structuredClone(source.commits),
    };
    this.#branches.set(id, data);
    return ok(data);
  }

  async set_main(branchId: string): Promise<BackendResult<WorkspaceBranch>> {
    const selected = this.#branch(branchId);
    if (selected === undefined) return fail("branch_not_found", `Branch ${branchId} was not found.`);
    for (const branch of this.#branches.values()) branch.branch.main = branch.branch.id === branchId;
    return ok(selected.branch);
  }

  async merge_branch(sourceId: string, targetId: string, actorId: string): Promise<BackendResult<WorkspaceBranchData>> {
    const source = this.#branch(sourceId);
    const target = this.#branch(targetId);
    if (source === undefined || target === undefined) return fail("branch_not_found", "The source or target branch was not found.");
    target.definition = structuredClone(source.draft?.definition ?? source.definition);
    const commit = await this.create_commit({
      branch_id: targetId, actor_id: actorId, definition: target.definition,
      base_commit_id: target.head?.id ?? null, message: `Merge ${source.branch.name}`,
    });
    return commit.ok ? ok(target) : commit;
  }

  async delete_branch(branchId: string): Promise<BackendResult<void>> {
    const branch = this.#branch(branchId);
    if (branch === undefined) return fail("branch_not_found", `Branch ${branchId} was not found.`);
    if (branch.branch.main) return fail("main_branch_required", "The main branch cannot be deleted.");
    this.#branches.delete(branchId);
    return ok(undefined);
  }

  async save_template(template: FieldTemplate): Promise<BackendResult<FieldTemplate>> {
    const branchId = template.branch_id ?? "main";
    const branch = this.#branch(branchId);
    if (branch === undefined) return fail("branch_not_found", `Branch ${branchId} was not found.`);
    const saved = { ...structuredClone(template), id: template.id || this.#id("template"), updated_at: this.#now() };
    branch.templates = [...branch.templates.filter((item) => item.id !== saved.id), saved];
    return ok(saved);
  }

  async delete_template(templateId: string): Promise<BackendResult<void>> {
    for (const branch of this.#branches.values()) branch.templates = branch.templates.filter((item) => item.id !== templateId);
    return ok(undefined);
  }

  async save_comment(thread: CommentThread): Promise<BackendResult<CommentThread>> {
    const branch = this.#branch(thread.branch_id);
    if (branch === undefined) return fail("branch_not_found", `Branch ${thread.branch_id} was not found.`);
    const saved = { ...structuredClone(thread), id: thread.id || this.#id("comment") };
    branch.comments = [...branch.comments.filter((item) => item.id !== saved.id), saved];
    return ok(saved);
  }

  async delete_comment(threadId: string): Promise<BackendResult<void>> {
    for (const branch of this.#branches.values()) branch.comments = branch.comments.filter((item) => item.id !== threadId);
    return ok(undefined);
  }
}
