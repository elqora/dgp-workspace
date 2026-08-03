// SPDX-License-Identifier: GPL-3.0-only

import type { HandlerService, ProductDefinition, ProductField } from "@elqora/dgp-spec";
import type { PublicationValidationResult } from "@elqora/dgp-validation";

export interface BackendError {
  code: string;
  message: string;
  retryable: boolean;
  meta: Record<string, unknown>;
}

export type BackendResult<T> = { ok: true; value: T } | { ok: false; error: BackendError };

export interface WorkspaceActor { id: string; display_name: string; meta: Record<string, unknown>; }
export interface WorkspaceAuthor { id: string; display_name: string; avatar_url: string | null; meta: Record<string, unknown>; }
export interface BranchParticipant { actor_id: string; role: string; joined_at: string; meta: Record<string, unknown>; }

export type WorkspaceAction =
  | "document.mutate" | "draft.save" | "commit.create" | "publish"
  | "branch.create" | "branch.merge" | "branch.delete"
  | "template.write" | "comment.write";
export type WorkspacePermissions = Record<WorkspaceAction, boolean>;

export interface WorkspaceBranch {
  id: string;
  name: string;
  main: boolean;
  created_at: string;
  created_by: string;
  meta: Record<string, unknown>;
}

export interface WorkspaceCommit {
  id: string;
  branch_id: string;
  message: string;
  author_id: string;
  created_at: string;
  definition: ProductDefinition;
  meta: Record<string, unknown>;
}

export interface WorkspaceDraft {
  id: string;
  branch_id: string;
  author_id: string;
  updated_at: string;
  definition: ProductDefinition;
  base_commit_id: string | null;
  meta: Record<string, unknown>;
}

export interface FieldTemplate {
  id: string;
  key: string;
  name: string;
  field: ProductField;
  branch_id: string | null;
  published: boolean;
  updated_at: string;
  meta: Record<string, unknown>;
}

export interface CommentMessage {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  meta: Record<string, unknown>;
}

export interface CommentThread {
  id: string;
  branch_id: string;
  target_path: string;
  resolved: boolean;
  messages: CommentMessage[];
  created_at: string;
  meta: Record<string, unknown>;
}

export interface WorkspaceBranchData {
  branch: WorkspaceBranch;
  definition: ProductDefinition;
  head: WorkspaceCommit | null;
  draft: WorkspaceDraft | null;
  templates: FieldTemplate[];
  participants: BranchParticipant[];
  comments: CommentThread[];
  commits: WorkspaceCommit[];
}

export interface WorkspaceBootData {
  workspace_id: string;
  authors: WorkspaceAuthor[];
  permissions: WorkspacePermissions;
  branches: WorkspaceBranch[];
  current_branch_id: string;
  services: HandlerService[];
  current: WorkspaceBranchData;
}

export type WorkspaceSnapshotState = "clean" | "dirty" | "saving" | "uncommitted";
export type WorkspaceStatus = "idle" | "booting" | "ready" | "error";

export interface WorkspaceState {
  status: WorkspaceStatus;
  workspace_id: string | null;
  actor: WorkspaceActor;
  authors: WorkspaceAuthor[];
  permissions: WorkspacePermissions;
  branches: WorkspaceBranch[];
  current_branch_id: string | null;
  definition: ProductDefinition | null;
  head: WorkspaceCommit | null;
  draft: WorkspaceDraft | null;
  templates: FieldTemplate[];
  participants: BranchParticipant[];
  comments: CommentThread[];
  commits: WorkspaceCommit[];
  services: HandlerService[];
  snapshot_state: WorkspaceSnapshotState;
  validation: PublicationValidationResult | null;
  revision: number;
  last_saved_at: number | null;
  error: BackendError | null;
}

export interface PublicationReceipt {
  commit: WorkspaceCommit;
  published_at: string;
  publication_id: string;
  meta: Record<string, unknown>;
}
