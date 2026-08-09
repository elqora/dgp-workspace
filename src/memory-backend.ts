// SPDX-License-Identifier: GPL-3.0-only

import type { HandlerService, ProductDefinition } from "@elqora/dgp-spec";
import type { ServicePublicationPolicyRule } from "@elqora/dgp-validation";

import type { CreateCommitInput, PublishInput, SaveDraftInput, WorkspaceBackend } from "./backend.js";
import type {
  BackendError, BackendResult, CommentThread, FieldTemplate, PublicationReceipt,
  WorkspaceAction, WorkspaceActor, WorkspaceAuthor, WorkspaceBootData, WorkspaceBranch,
  WorkspaceBranchData, WorkspaceCommit, WorkspacePermissions,
} from "./contracts.js";
import { emptyEditorialState } from "./contracts.js";

function ok<T>(value: T): BackendResult<T> { return { ok: true, value: structuredClone(value) }; }
function fail<T>(code: string, message: string): BackendResult<T> {
  const error: BackendError = { code, message, retryable: false, meta: {} };
  return { ok: false, error };
}

const allPermissions: WorkspacePermissions = {
  "document.mutate": true, "draft.save": true, "commit.create": true,
  publish: true, "branch.create": true, "branch.merge": true,
  "branch.set_main": true, "branch.delete": true, "template.write": true, "comment.write": true,
};

export interface MemoryWorkspaceSeed {
  workspace_id?: string;
  definition: ProductDefinition;
  branch_name?: string;
  authors?: WorkspaceAuthor[];
  permissions?: WorkspacePermissions;
  services?: HandlerService[];
  policy_rules?: ServicePublicationPolicyRule[];
  now?: () => string;
  persistence?: MemoryWorkspacePersistence;
  on_persistence_error?: (error: unknown) => void;
}

export interface MemoryWorkspaceSnapshot {
  workspace_id: string;
  authors: WorkspaceAuthor[];
  permissions: WorkspacePermissions;
  services: HandlerService[];
  policy_rules: ServicePublicationPolicyRule[];
  branches: WorkspaceBranchData[];
  sequence: number;
}

export interface MemoryWorkspacePersistence {
  load(workspace_id: string): Promise<MemoryWorkspaceSnapshot | undefined>;
  save(snapshot: MemoryWorkspaceSnapshot): Promise<void>;
}

export class MemoryWorkspaceBackend implements WorkspaceBackend {
  readonly #workspaceId: string;
  readonly #authors: WorkspaceAuthor[];
  readonly #permissions: WorkspacePermissions;
  readonly #services: HandlerService[];
  readonly #policyRules: ServicePublicationPolicyRule[];
  readonly #branches = new Map<string, WorkspaceBranchData>();
  readonly #now: () => string;
  readonly #persistence: MemoryWorkspacePersistence | undefined;
  readonly #onPersistenceError: ((error: unknown) => void) | undefined;
  readonly #ready: Promise<void>;
  #sequence = 1;

  constructor(seed: MemoryWorkspaceSeed) {
    this.#workspaceId = seed.workspace_id ?? "memory-workspace";
    this.#authors = structuredClone(seed.authors ?? []);
    this.#permissions = { ...(seed.permissions ?? allPermissions) };
    this.#services = structuredClone(seed.services ?? []);
    this.#policyRules = structuredClone(seed.policy_rules ?? []);
    this.#now = seed.now ?? (() => new Date().toISOString());
    this.#persistence = seed.persistence;
    this.#onPersistenceError = seed.on_persistence_error;
    const branch: WorkspaceBranch = {
      id: "main", name: seed.branch_name ?? "Main", main: true,
      created_at: this.#now(), created_by: "system", meta: {},
    };
    this.#branches.set(branch.id, {
      branch, definition: structuredClone(seed.definition), editorial_state: emptyEditorialState(), head: null, draft: null,
      templates: [], participants: [], comments: [],
      commits: [],
      revision: 0,
    });
    this.#ready = this.#hydrate();
  }

  async #hydrate(): Promise<void> {
    if (this.#persistence === undefined) return;
    try {
      const stored = await this.#persistence.load(this.#workspaceId);
      if (stored === undefined) { await this.#persistence.save(this.snapshot()); return; }
      this.#authors.splice(0, this.#authors.length, ...structuredClone(stored.authors));
      for (const key of Object.keys(this.#permissions) as WorkspaceAction[]) delete this.#permissions[key];
      Object.assign(this.#permissions, structuredClone(stored.permissions));
      this.#services.splice(0, this.#services.length, ...structuredClone(stored.services));
      this.#policyRules.splice(0, this.#policyRules.length, ...structuredClone(stored.policy_rules));
      this.#branches.clear(); for (const branch of stored.branches) this.#branches.set(branch.branch.id, structuredClone(branch));
      this.#sequence = stored.sequence;
    } catch (caught) { this.#onPersistenceError?.(caught); }
  }

  snapshot(): MemoryWorkspaceSnapshot {
    return structuredClone({ workspace_id: this.#workspaceId, authors: this.#authors, permissions: this.#permissions, services: this.#services, policy_rules: this.#policyRules, branches: [...this.#branches.values()], sequence: this.#sequence });
  }
  async #persist(): Promise<void> { if (this.#persistence !== undefined) try { await this.#persistence.save(this.snapshot()); } catch (caught) { this.#onPersistenceError?.(caught); } }

  #id(prefix: string): string { return `${prefix}-${this.#sequence++}`; }
  #branch(id: string): WorkspaceBranchData | undefined { return this.#branches.get(id); }

  async load(actor: WorkspaceActor, preferredBranchId?: string): Promise<BackendResult<WorkspaceBootData>> {
    await this.#ready;
    void actor;
    const current = this.#branch(preferredBranchId ?? "main") ?? this.#branches.values().next().value;
    if (current === undefined) return fail("workspace_empty", "The workspace has no branches.");
    return ok({
      workspace_id: this.#workspaceId, authors: this.#authors,
      permissions: this.#permissions, branches: [...this.#branches.values()].map((item) => item.branch),
      current_branch_id: current.branch.id, services: this.#services, policy_rules: this.#policyRules, current,
    });
  }

  async load_branch(branchId: string): Promise<BackendResult<WorkspaceBranchData>> {
    await this.#ready;
    const branch = this.#branch(branchId);
    return branch === undefined ? fail("branch_not_found", `Branch ${branchId} was not found.`) : ok(branch);
  }

  async load_commit(branchId: string, commitId: string): Promise<BackendResult<WorkspaceCommit>> {
    await this.#ready;
    const branch = this.#branch(branchId);
    const commit = branch?.commits.find((item) => item.id === commitId);
    return commit === undefined ? fail("commit_not_found", `Commit ${commitId} was not found.`) : ok(commit);
  }

  async save_draft(input: SaveDraftInput): Promise<BackendResult<import("./contracts.js").WorkspaceDraft>> {
    await this.#ready;
    const branch = this.#branch(input.branch_id);
    if (branch === undefined) return fail("branch_not_found", `Branch ${input.branch_id} was not found.`);
    if (input.base_revision !== branch.revision) return fail("revision_conflict", `Branch ${input.branch_id} changed from revision ${input.base_revision} to ${branch.revision}.`);
    branch.revision += 1;
    const draft = {
      id: branch.draft?.id ?? this.#id("draft"), branch_id: input.branch_id,
      author_id: input.actor_id, updated_at: this.#now(), definition: structuredClone(input.definition),
      editorial_state: structuredClone(input.editorial_state),
      base_commit_id: input.base_commit_id, revision: branch.revision, meta: {},
    };
    branch.draft = draft;
    await this.#persist();
    return ok(draft);
  }

  async create_commit(input: CreateCommitInput): Promise<BackendResult<WorkspaceCommit>> {
    await this.#ready;
    const branch = this.#branch(input.branch_id);
    if (branch === undefined) return fail("branch_not_found", `Branch ${input.branch_id} was not found.`);
    if (input.base_revision !== branch.revision) return fail("revision_conflict", `Branch ${input.branch_id} changed from revision ${input.base_revision} to ${branch.revision}.`);
    branch.revision += 1;
    const commit: WorkspaceCommit = {
      id: this.#id("commit"), branch_id: input.branch_id, message: input.message,
      author_id: input.actor_id, created_at: this.#now(), definition: structuredClone(input.definition), revision: branch.revision, meta: {},
      editorial_state: structuredClone(input.editorial_state),
    };
    branch.definition = structuredClone(input.definition);
    branch.editorial_state = structuredClone(input.editorial_state);
    branch.head = commit;
    branch.commits.push(commit);
    branch.draft = null;
    await this.#persist();
    return ok(commit);
  }

  async publish(input: PublishInput): Promise<BackendResult<PublicationReceipt>> {
    await this.#ready;
    const committed = await this.create_commit(input);
    if (!committed.ok) return committed;
    return ok({
      commit: committed.value, published_at: this.#now(),
      publication_id: this.#id("publication"), meta: { validation_revision: input.validation_revision },
    });
  }

  async discard_draft(branchId: string): Promise<BackendResult<void>> {
    await this.#ready;
    const branch = this.#branch(branchId);
    if (branch === undefined) return fail("branch_not_found", `Branch ${branchId} was not found.`);
    branch.draft = null;
    branch.revision += 1; await this.#persist();
    return ok(undefined);
  }

  async create_branch(name: string, actorId: string, fromBranchId = "main"): Promise<BackendResult<WorkspaceBranchData>> {
    await this.#ready;
    const source = this.#branch(fromBranchId);
    if (source === undefined) return fail("branch_not_found", `Branch ${fromBranchId} was not found.`);
    const id = this.#id("branch");
    const data: WorkspaceBranchData = {
      branch: { id, name, main: false, created_at: this.#now(), created_by: actorId, meta: {} },
      definition: structuredClone(source.definition), editorial_state: structuredClone(source.editorial_state), head: source.head === null ? null : { ...structuredClone(source.head), branch_id: id },
      draft: null, templates: structuredClone(source.templates), participants: [], comments: [],
      commits: structuredClone(source.commits),
      revision: source.revision,
    };
    this.#branches.set(id, data);
    await this.#persist();
    return ok(data);
  }

  async set_main(branchId: string): Promise<BackendResult<WorkspaceBranch>> {
    await this.#ready;
    const selected = this.#branch(branchId);
    if (selected === undefined) return fail("branch_not_found", `Branch ${branchId} was not found.`);
    for (const branch of this.#branches.values()) branch.branch.main = branch.branch.id === branchId;
    await this.#persist();
    return ok(selected.branch);
  }

  async merge_branch(sourceId: string, targetId: string, actorId: string): Promise<BackendResult<WorkspaceBranchData>> {
    await this.#ready;
    const source = this.#branch(sourceId);
    const target = this.#branch(targetId);
    if (source === undefined || target === undefined) return fail("branch_not_found", "The source or target branch was not found.");
    target.definition = structuredClone(source.draft?.definition ?? source.definition);
    const commit = await this.create_commit({
      branch_id: targetId, actor_id: actorId, definition: target.definition,
      editorial_state: target.editorial_state,
      base_commit_id: target.head?.id ?? null, base_revision: target.revision, message: `Merge ${source.branch.name}`,
    });
    return commit.ok ? ok(target) : commit;
  }

  async delete_branch(branchId: string): Promise<BackendResult<void>> {
    await this.#ready;
    const branch = this.#branch(branchId);
    if (branch === undefined) return fail("branch_not_found", `Branch ${branchId} was not found.`);
    if (branch.branch.main) return fail("main_branch_required", "The main branch cannot be deleted.");
    this.#branches.delete(branchId);
    await this.#persist();
    return ok(undefined);
  }

  async save_template(template: FieldTemplate): Promise<BackendResult<FieldTemplate>> {
    await this.#ready;
    const branchId = template.branch_id ?? "main";
    const branch = this.#branch(branchId);
    if (branch === undefined) return fail("branch_not_found", `Branch ${branchId} was not found.`);
    const duplicate = branch.templates.find((item) => item.key === template.key && item.id !== template.id);
    if (duplicate !== undefined) return fail("template_key_conflict", `Template key ${template.key} is already in use.`);
    const saved = { ...structuredClone(template), id: template.id || this.#id("template"), updated_at: this.#now() };
    branch.templates = [...branch.templates.filter((item) => item.id !== saved.id), saved];
    await this.#persist();
    return ok(saved);
  }

  async delete_template(templateId: string): Promise<BackendResult<void>> {
    await this.#ready;
    for (const branch of this.#branches.values()) branch.templates = branch.templates.filter((item) => item.id !== templateId);
    await this.#persist();
    return ok(undefined);
  }

  async save_comment(thread: CommentThread): Promise<BackendResult<CommentThread>> {
    await this.#ready;
    const branch = this.#branch(thread.branch_id);
    if (branch === undefined) return fail("branch_not_found", `Branch ${thread.branch_id} was not found.`);
    const saved = { ...structuredClone(thread), id: thread.id || this.#id("comment") };
    branch.comments = [...branch.comments.filter((item) => item.id !== saved.id), saved];
    await this.#persist();
    return ok(saved);
  }

  async delete_comment(threadId: string): Promise<BackendResult<void>> {
    await this.#ready;
    for (const branch of this.#branches.values()) branch.comments = branch.comments.filter((item) => item.id !== threadId);
    await this.#persist();
    return ok(undefined);
  }
}
