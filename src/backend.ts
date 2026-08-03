// SPDX-License-Identifier: GPL-3.0-only

import type { ProductDefinition } from "@elqora/dgp-spec";

import type {
  BackendResult, CommentThread, FieldTemplate, PublicationReceipt,
  WorkspaceActor, WorkspaceBootData, WorkspaceBranch, WorkspaceBranchData,
  WorkspaceCommit, WorkspaceDraft,
} from "./contracts.js";

export interface SaveDraftInput { branch_id: string; actor_id: string; definition: ProductDefinition; base_commit_id: string | null; }
export interface CreateCommitInput extends SaveDraftInput { message: string; }
export interface PublishInput extends CreateCommitInput { validation_revision: number; }

export interface WorkspaceBackend {
  load(actor: WorkspaceActor, preferred_branch_id?: string): Promise<BackendResult<WorkspaceBootData>>;
  load_branch(branch_id: string): Promise<BackendResult<WorkspaceBranchData>>;
  load_commit(branch_id: string, commit_id: string): Promise<BackendResult<WorkspaceCommit>>;
  save_draft(input: SaveDraftInput): Promise<BackendResult<WorkspaceDraft>>;
  create_commit(input: CreateCommitInput): Promise<BackendResult<WorkspaceCommit>>;
  publish(input: PublishInput): Promise<BackendResult<PublicationReceipt>>;
  discard_draft(branch_id: string, actor_id: string): Promise<BackendResult<void>>;
  create_branch(name: string, actor_id: string, from_branch_id?: string): Promise<BackendResult<WorkspaceBranchData>>;
  set_main(branch_id: string, actor_id: string): Promise<BackendResult<WorkspaceBranch>>;
  merge_branch(source_id: string, target_id: string, actor_id: string): Promise<BackendResult<WorkspaceBranchData>>;
  delete_branch(branch_id: string, actor_id: string): Promise<BackendResult<void>>;
  save_template(template: FieldTemplate, actor_id: string): Promise<BackendResult<FieldTemplate>>;
  delete_template(template_id: string, actor_id: string): Promise<BackendResult<void>>;
  save_comment(thread: CommentThread, actor_id: string): Promise<BackendResult<CommentThread>>;
  delete_comment(thread_id: string, actor_id: string): Promise<BackendResult<void>>;
}

export type WorkspaceLiveEvent =
  | { type: "workspace.invalidate" }
  | { type: "branch.invalidate"; branch_id: string }
  | { type: "branch.deleted"; branch_id: string };

export interface WorkspaceLiveAdapter {
  connect(listener: (event: WorkspaceLiveEvent) => void): Promise<() => void>;
}
